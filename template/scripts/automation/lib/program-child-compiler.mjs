import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CHILD_SLICE_DEFINITIONS_SECTION,
  VALIDATION_CONTRACT_SECTION,
  extractProgramChildUnitDeclarations,
  inferPlanId,
  listMarkdownFiles,
  metadataValue,
  parseDeliveryClass,
  parseExecutionScope,
  parseListField,
  parseMetadata,
  parsePlanId,
  parsePriority,
  parseRiskTier,
  parseSecurityApproval,
  parseValidationLanes,
  sectionBody
} from './plan-metadata.mjs';

const GENERATED_START = '<!-- ORCH-GENERATED-START';
const GENERATED_END = '<!-- ORCH-GENERATED-END -->';
const DEFAULT_ACCEPTANCE_CRITERIA = 'Complete the generated must-land checklist and validation contract for this child slice.';
const DEFAULT_PLANNER_OVERLAY = '- Add planner-local notes here when the child needs context beyond the parent contract.';
const FUTURE_DIR = path.join('docs', 'future');
const ACTIVE_DIR = path.join('docs', 'exec-plans', 'active');
const COMPLETED_DIR = path.join('docs', 'exec-plans', 'completed');

function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function normalizePathEntry(value) {
  return toPosix(String(value ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
}

function normalizeListValue(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((entry) => normalizePathEntry(entry))
      .filter(Boolean)
  )];
}

function readSimpleSection(content, title) {
  const body = sectionBody(content, title);
  return body ? body.trim() : '';
}

function parseBulletFields(lines) {
  const fields = new Map();
  for (const line of lines) {
    const match = String(line ?? '').trim().match(/^-\s*([A-Za-z][A-Za-z0-9- ]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    if (!fields.has(match[1].trim().toLowerCase())) {
      fields.set(match[1].trim().toLowerCase(), match[2].trim());
    }
  }
  return fields;
}

function parseChildDefinitionSubsections(lines) {
  const sections = new Map();
  let current = '';
  let currentLines = [];

  const flush = () => {
    if (!current) {
      return;
    }
    sections.set(current.toLowerCase(), currentLines.join('\n').trim());
  };

  for (const rawLine of lines) {
    const line = String(rawLine ?? '');
    const match = line.match(/^####\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = match[1].trim();
      currentLines = [];
      continue;
    }
    if (current) {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

export function parseStructuredProgramChildDefinitions(content) {
  const section = readSimpleSection(content, CHILD_SLICE_DEFINITIONS_SECTION);
  if (!section) {
    return { definitions: [], errors: [], legacyUnits: extractProgramChildUnitDeclarations(content) };
  }

  const lines = section.split(/\r?\n/);
  const definitions = [];
  const errors = [];
  let current = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const planId = parsePlanId(current.heading, null);
    if (!planId) {
      errors.push(`Child definition heading '${current.heading}' must be a lowercase kebab-case Plan-ID.`);
      current = null;
      return;
    }
    const fields = parseBulletFields(current.lines.filter((line) => !/^####\s+/.test(line)));
    const subsections = parseChildDefinitionSubsections(current.lines);
    const validationLanes = parseValidationLanes(fields.get('validation-lanes'), []);
    definitions.push({
      planId,
      title: fields.get('title') ?? '',
      dependencies: parseListField(fields.get('dependencies')),
      specTargets: normalizeListValue(parseListField(fields.get('spec-targets'))),
      implementationTargets: normalizeListValue(parseListField(fields.get('implementation-targets'))),
      validationLanes,
      autonomyAllowed: String(fields.get('autonomy-allowed') ?? '').trim(),
      riskTier: parseRiskTier(fields.get('risk-tier'), ''),
      securityApproval: parseSecurityApproval(fields.get('security-approval'), ''),
      tags: parseListField(fields.get('tags')),
      mustLandBody: subsections.get('must-land checklist') ?? '',
      baselineBody: subsections.get('already-true baseline') ?? '',
      deferredBody: subsections.get('deferred follow-ons') ?? '',
      proofMapBody: subsections.get('capability proof map') ?? ''
    });
    current = null;
  };

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      current = {
        heading: headingMatch[1].trim(),
        lines: []
      };
      continue;
    }
    if (current) {
      current.lines.push(rawLine);
    }
  }
  flush();

  return {
    definitions,
    errors,
    legacyUnits: extractProgramChildUnitDeclarations(content)
  };
}

async function readAutomationConfig(rootDir) {
  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeValidationSpecs(entries, lane) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const id = String(entry.id ?? '').trim();
        const command = String(entry.command ?? '').trim();
        if (!id || !command) {
          return null;
        }
        return { id, lane };
      }
      const command = String(entry ?? '').trim();
      if (!command) {
        return null;
      }
      return { id: `${lane}:${index + 1}`, lane };
    })
    .filter(Boolean);
}

function validationIdsByLane(config) {
  return {
    always: normalizeValidationSpecs(config?.validation?.always, 'always').map((entry) => entry.id),
    'host-required': normalizeValidationSpecs(config?.validation?.hostRequired, 'host-required').map((entry) => entry.id)
  };
}

async function readPlanRecord(rootDir, filePath, phase) {
  const content = await fs.readFile(filePath, 'utf8');
  const metadata = parseMetadata(content);
  const rel = toPosix(path.relative(rootDir, filePath));
  return {
    filePath,
    rel,
    phase,
    content,
    metadata,
    planId: inferPlanId(content, filePath),
    title: (content.match(/^#\s+(.+)$/m)?.[1] ?? '').trim(),
    status: String(metadataValue(metadata, 'Status') ?? '').trim().toLowerCase(),
    priority: parsePriority(metadataValue(metadata, 'Priority')),
    owner: String(metadataValue(metadata, 'Owner') ?? '').trim(),
    acceptanceCriteria: String(metadataValue(metadata, 'Acceptance-Criteria') ?? '').trim(),
    deliveryClass: parseDeliveryClass(metadataValue(metadata, 'Delivery-Class'), ''),
    executionScope: parseExecutionScope(metadataValue(metadata, 'Execution-Scope'), ''),
    parentPlanId: parsePlanId(metadataValue(metadata, 'Parent-Plan-ID'), null),
    dependencies: parseListField(metadataValue(metadata, 'Dependencies')),
    specTargets: normalizeListValue(parseListField(metadataValue(metadata, 'Spec-Targets'))),
    implementationTargets: normalizeListValue(parseListField(metadataValue(metadata, 'Implementation-Targets'))),
    validationLanes: parseValidationLanes(metadataValue(metadata, 'Validation-Lanes')),
    doneEvidence: parseListField(metadataValue(metadata, 'Done-Evidence')),
    autonomyAllowed: String(metadataValue(metadata, 'Autonomy-Allowed') ?? '').trim(),
    riskTier: parseRiskTier(metadataValue(metadata, 'Risk-Tier'), ''),
    securityApproval: parseSecurityApproval(metadataValue(metadata, 'Security-Approval'), ''),
    tags: parseListField(metadataValue(metadata, 'Tags'))
  };
}

async function loadAllPlans(rootDir) {
  const directories = {
    future: path.join(rootDir, FUTURE_DIR),
    active: path.join(rootDir, ACTIVE_DIR),
    completed: path.join(rootDir, COMPLETED_DIR)
  };
  const plans = [];
  for (const [phase, directoryPath] of Object.entries(directories)) {
    const files = await listMarkdownFiles(directoryPath);
    for (const filePath of files) {
      plans.push(await readPlanRecord(rootDir, filePath, phase));
    }
  }
  return plans;
}

function determineParentPlanIds(plans, planIdFilter = null) {
  if (!planIdFilter) {
    return new Set(
      plans
        .filter((plan) => plan.executionScope === 'program' && (plan.phase === 'future' || plan.phase === 'active'))
        .map((plan) => plan.planId)
        .filter(Boolean)
    );
  }

  const wanted = new Set();
  const direct = plans.find((plan) => plan.planId === planIdFilter);
  if (direct?.executionScope === 'program') {
    wanted.add(direct.planId);
  }
  for (const plan of plans) {
    if (plan.parentPlanId === planIdFilter) {
      wanted.add(planIdFilter);
    }
    if (plan.planId === planIdFilter && plan.parentPlanId) {
      wanted.add(plan.parentPlanId);
    }
  }
  return wanted;
}

function targetDirectoryForPhase(rootDir, phase) {
  if (phase === 'future') {
    return path.join(rootDir, FUTURE_DIR);
  }
  if (phase === 'active') {
    return path.join(rootDir, ACTIVE_DIR);
  }
  return path.join(rootDir, COMPLETED_DIR);
}

function datedPlanFileName(datePrefix, stem) {
  return `${datePrefix}-${stem}.md`;
}

function expectedPhaseForParent(parent) {
  return parent.phase === 'future' ? 'future' : 'active';
}

function initialStatusForParent(parent) {
  if (parent.phase === 'future') {
    return parent.status === 'ready-for-promotion' ? 'ready-for-promotion' : 'draft';
  }
  return 'queued';
}

function childAcceptanceCriteria(definition) {
  return definition.mustLandBody ? DEFAULT_ACCEPTANCE_CRITERIA : 'Define the generated must-land checklist before execution.';
}

function validationContractLines(lanes, validationIds) {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return ['- Lanes: none'];
  }

  const lines = [`- Lanes: ${lanes.join(', ')}`];
  if (lanes.includes('always')) {
    lines.push(`- Always Validation IDs: ${(validationIds.always.length > 0 ? validationIds.always : ['none']).join(', ')}`);
  }
  if (lanes.includes('host-required')) {
    lines.push(`- Host-Required Validation IDs: ${(validationIds['host-required'].length > 0 ? validationIds['host-required'] : ['none']).join(', ')}`);
  }
  return lines;
}

function preserveExistingState(content, fallbackStatus) {
  const metadata = parseMetadata(content ?? '');
  const status = String(metadataValue(metadata, 'Status') ?? '').trim().toLowerCase() || String(fallbackStatus ?? '').trim();
  const validationReady = String(metadataValue(metadata, 'Validation-Ready') ?? '').trim().toLowerCase() || 'no';
  const doneEvidence = parseListField(metadataValue(metadata, 'Done-Evidence'));
  const start = content.indexOf(GENERATED_START);
  const end = start === -1 ? -1 : content.indexOf(GENERATED_END, start);
  let tail = '';
  if (start !== -1 && end !== -1) {
    tail = content.slice(end + GENERATED_END.length).trimStart();
  } else {
    const overlay = readSimpleSection(content, 'Planner Overlay');
    const validationEvidence = readSimpleSection(content, 'Validation Evidence');
    const hostValidation = readSimpleSection(content, 'Host Validation');
    const closure = readSimpleSection(content, 'Closure');
    const sections = [];
    sections.push(`## Planner Overlay\n\n${overlay || DEFAULT_PLANNER_OVERLAY}`);
    if (validationEvidence) {
      sections.push(`## Validation Evidence\n\n${validationEvidence}`);
    }
    if (hostValidation) {
      sections.push(`## Host Validation\n\n${hostValidation}`);
    }
    if (closure) {
      sections.push(`## Closure\n\n${closure}`);
    }
    tail = sections.join('\n\n').trim();
  }

  return {
    status: status || fallbackStatus,
    validationReady: validationReady === 'yes' || validationReady === 'host-required-only' ? validationReady : 'no',
    doneEvidence,
    tail: tail || `## Planner Overlay\n\n${DEFAULT_PLANNER_OVERLAY}`
  };
}

function alignPreservedStateForPhase(parent, existing, preserved) {
  const aligned = {
    status: preserved.status,
    validationReady: preserved.validationReady,
    doneEvidence: [...(preserved.doneEvidence ?? [])],
    tail: preserved.tail
  };

  if (!existing || existing.phase === 'future') {
    aligned.status = initialStatusForParent(parent);
    aligned.validationReady = 'no';
    if (aligned.doneEvidence.length === 0) {
      aligned.doneEvidence = ['pending'];
    }
  }

  return aligned;
}

function blockForHash(parent, definition, validationIds) {
  return JSON.stringify({
    parentPlanId: parent.planId,
    parentPhase: parent.phase,
    parentStatus: parent.status,
    parentDefaults: {
      priority: parent.priority,
      owner: parent.owner,
      deliveryClass: parent.deliveryClass,
      autonomyAllowed: parent.autonomyAllowed || 'both',
      riskTier: parent.riskTier || 'low',
      securityApproval: parent.securityApproval || 'not-required'
    },
    definition,
    validationIds
  });
}

function renderChildDocument(parent, definition, preserved, validationIds) {
  const specHash = createHash('sha1').update(blockForHash(parent, definition, validationIds)).digest('hex');
  const status = preserved.status || initialStatusForParent(parent);
  const validationReady = preserved.validationReady || 'no';
  const doneEvidence = preserved.doneEvidence.length > 0 ? preserved.doneEvidence : ['pending'];
  const metadataLines = [
    `- Plan-ID: ${definition.planId}`,
    `- Status: ${status}`,
    `- Priority: ${parent.priority}`,
    `- Owner: ${parent.owner || 'unassigned'}`,
    `- Acceptance-Criteria: ${childAcceptanceCriteria(definition)}`,
    `- Delivery-Class: ${parent.deliveryClass}`,
    '- Execution-Scope: slice',
    `- Parent-Plan-ID: ${parent.planId}`,
    `- Dependencies: ${definition.dependencies.length > 0 ? definition.dependencies.join(', ') : 'none'}`,
    `- Autonomy-Allowed: ${definition.autonomyAllowed || parent.autonomyAllowed || 'both'}`,
    `- Risk-Tier: ${definition.riskTier || parent.riskTier || 'low'}`,
    `- Security-Approval: ${definition.securityApproval || parent.securityApproval || 'not-required'}`,
    `- Spec-Targets: ${definition.specTargets.length > 0 ? definition.specTargets.join(', ') : 'none'}`,
    `- Implementation-Targets: ${definition.implementationTargets.length > 0 ? definition.implementationTargets.join(', ') : 'none'}`,
    `- Validation-Lanes: ${definition.validationLanes.length > 0 ? definition.validationLanes.join(', ') : 'always'}`,
    `- Done-Evidence: ${doneEvidence.join(', ')}`
  ];
  if (definition.tags.length > 0 || parent.tags.length > 0) {
    metadataLines.splice(metadataLines.length - 1, 0, `- Tags: ${(definition.tags.length > 0 ? definition.tags : parent.tags).join(', ')}`);
  }

  const generatedSections = [
    '## Metadata',
    '',
    ...metadataLines,
    '',
    `## ${VALIDATION_CONTRACT_SECTION}`,
    '',
    ...validationContractLines(definition.validationLanes.length > 0 ? definition.validationLanes : ['always'], validationIds),
    '',
    '## Already-True Baseline',
    '',
    definition.baselineBody || '- Capture baseline facts in the parent child definition.',
    '',
    '## Must-Land Checklist',
    '',
    definition.mustLandBody || '- [ ] Define generated must-land items in the parent child definition.',
    '',
    '## Deferred Follow-Ons',
    '',
    definition.deferredBody || '- None.',
    ''
  ];
  if (definition.proofMapBody) {
    generatedSections.push(`## ${'Capability Proof Map'}`, '', definition.proofMapBody, '');
  }

  return [
    `# ${definition.title}`,
    '',
    `Status: ${status}`,
    `Validation-Ready: ${validationReady}`,
    '',
    `${GENERATED_START} parent=${parent.planId} child=${definition.planId} hash=${specHash} -->`,
    ...generatedSections,
    GENERATED_END,
    '',
    preserved.tail.trim(),
    ''
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function relativeTargetPath(rootDir, directoryPath, planId) {
  const targetName = datedPlanFileName(new Date().toISOString().slice(0, 10), planId);
  return path.join(directoryPath, targetName);
}

async function ensureDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function compileProgramChildren(rootDir, options = {}) {
  const write = options.write === true;
  const dryRun = options.dryRun === true;
  const plans = await loadAllPlans(rootDir);
  const validationIds = validationIdsByLane(await readAutomationConfig(rootDir));
  const selectedParentIds = determineParentPlanIds(plans, options.planId ?? null);
  const byId = new Map(plans.filter((plan) => plan.planId).map((plan) => [plan.planId, plan]));
  const results = {
    issues: [],
    advisories: [],
    writes: [],
    moves: [],
    compiledParents: []
  };

  for (const parent of plans) {
    if (parent.executionScope !== 'program' || (parent.phase !== 'future' && parent.phase !== 'active')) {
      continue;
    }
    if (selectedParentIds.size > 0 && !selectedParentIds.has(parent.planId)) {
      continue;
    }

    const parsed = parseStructuredProgramChildDefinitions(parent.content);
    const definitions = parsed.definitions;
    const legacyUnits = parsed.legacyUnits;
    const seenChildIds = new Set();
    const desiredPhase = expectedPhaseForParent(parent);

    if (definitions.length === 0 && legacyUnits.length > 0) {
      results.advisories.push({
        code: 'LEGACY_PROGRAM_CHILD_SCHEMA',
        message: `Program plan '${parent.planId}' still uses legacy child-unit headings without '## ${CHILD_SLICE_DEFINITIONS_SECTION}'. Automatic child compilation is disabled until the parent migrates.`,
        filePath: parent.rel
      });
      continue;
    }

    for (const error of parsed.errors) {
      results.issues.push({
        code: 'INVALID_CHILD_SLICE_DEFINITION',
        message: error,
        filePath: parent.rel
      });
    }

    for (const definition of definitions) {
      let definitionValid = true;
      if (seenChildIds.has(definition.planId)) {
        results.issues.push({
          code: 'DUPLICATE_CHILD_SLICE_DEFINITION',
          message: `Program plan '${parent.planId}' repeats child Plan-ID '${definition.planId}' in '## ${CHILD_SLICE_DEFINITIONS_SECTION}'.`,
          filePath: parent.rel
        });
        continue;
      }
      seenChildIds.add(definition.planId);

      if (!definition.title) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_TITLE',
          message: `Child definition '${definition.planId}' must declare '- Title: ...'.`,
          filePath: parent.rel
        });
      }
      if (definition.specTargets.length === 0) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_SPEC_TARGETS',
          message: `Child definition '${definition.planId}' must declare '- Spec-Targets: ...'.`,
          filePath: parent.rel
        });
      }
      if (parent.deliveryClass === 'product' && definition.implementationTargets.length === 0) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_IMPLEMENTATION_TARGETS',
          message: `Product child definition '${definition.planId}' must declare '- Implementation-Targets: ...'.`,
          filePath: parent.rel
        });
      }
      if (definition.validationLanes.length === 0) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_VALIDATION_LANES',
          message: `Child definition '${definition.planId}' must declare '- Validation-Lanes: always' or '- Validation-Lanes: always, host-required'.`,
          filePath: parent.rel
        });
      }
      if (!definition.mustLandBody) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_MUST_LAND',
          message: `Child definition '${definition.planId}' must include '#### Must-Land Checklist'.`,
          filePath: parent.rel
        });
      }
      if (!definition.baselineBody) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_BASELINE',
          message: `Child definition '${definition.planId}' must include '#### Already-True Baseline'.`,
          filePath: parent.rel
        });
      }
      if (!definition.deferredBody) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_DEFERRED',
          message: `Child definition '${definition.planId}' must include '#### Deferred Follow-Ons'.`,
          filePath: parent.rel
        });
      }
      if (parent.deliveryClass === 'product' && !definition.proofMapBody) {
        definitionValid = false;
        results.issues.push({
          code: 'CHILD_DEFINITION_MISSING_PROOF_MAP',
          message: `Product child definition '${definition.planId}' must include '#### Capability Proof Map'.`,
          filePath: parent.rel
        });
      }

      if (!definitionValid) {
        continue;
      }

      const existing = byId.get(definition.planId) ?? null;
      if (existing && existing.parentPlanId && existing.parentPlanId !== parent.planId) {
        results.issues.push({
          code: 'CHILD_PLAN_PARENT_MISMATCH',
          message: `Child plan '${definition.planId}' already points to parent '${existing.parentPlanId}', not '${parent.planId}'.`,
          filePath: existing.rel
        });
        continue;
      }

      if (existing && existing.executionScope && existing.executionScope !== 'slice') {
        results.issues.push({
          code: 'CHILD_PLAN_SCOPE_MISMATCH',
          message: `Child plan '${definition.planId}' must use 'Execution-Scope: slice'.`,
          filePath: existing.rel
        });
        continue;
      }

      if (existing && existing.phase === 'future' && desiredPhase === 'active' && write && !dryRun) {
        const preserved = alignPreservedStateForPhase(
          parent,
          existing,
          preserveExistingState(existing.content, initialStatusForParent(parent))
        );
        const nextPath = relativeTargetPath(rootDir, targetDirectoryForPhase(rootDir, 'active'), definition.planId);
        await ensureDirectory(nextPath);
        await fs.writeFile(nextPath, renderChildDocument(parent, definition, preserved, validationIds), 'utf8');
        await fs.unlink(existing.filePath);
        results.moves.push({
          planId: definition.planId,
          source: existing.rel,
          target: toPosix(path.relative(rootDir, nextPath))
        });
        continue;
      }

      if (existing && existing.phase !== desiredPhase && existing.phase !== 'completed') {
        results.issues.push({
          code: 'CHILD_PLAN_PHASE_DRIFT',
          message: `Child plan '${definition.planId}' is in phase '${existing.phase}' but parent '${parent.planId}' expects phase '${desiredPhase}'.`,
          filePath: existing.rel
        });
        continue;
      }

      const targetPath = existing?.phase === 'completed'
        ? existing.filePath
        : existing?.filePath ?? relativeTargetPath(rootDir, targetDirectoryForPhase(rootDir, desiredPhase), definition.planId);
      const preserved = alignPreservedStateForPhase(
        parent,
        existing,
        preserveExistingState(existing?.content ?? '', initialStatusForParent(parent))
      );
      const expected = renderChildDocument(parent, definition, preserved, validationIds);
      const actual = existing?.content ? `${existing.content.trimEnd()}\n` : '';

      if (!actual) {
        if (write && !dryRun && existing?.phase !== 'completed') {
          await ensureDirectory(targetPath);
          await fs.writeFile(targetPath, expected, 'utf8');
          results.writes.push({
            planId: definition.planId,
            action: 'created',
            filePath: toPosix(path.relative(rootDir, targetPath))
          });
        } else {
          results.issues.push({
            code: 'MISSING_COMPILED_CHILD_PLAN',
            message: `Program plan '${parent.planId}' is missing compiled child plan '${definition.planId}'.`,
            filePath: parent.rel
          });
        }
        continue;
      }

      if (existing?.phase === 'completed') {
        continue;
      }

      if (`${expected.trimEnd()}\n` !== actual) {
        if (write && !dryRun) {
          await fs.writeFile(targetPath, expected, 'utf8');
          results.writes.push({
            planId: definition.planId,
            action: 'updated',
            filePath: toPosix(path.relative(rootDir, targetPath))
          });
        } else {
          results.issues.push({
            code: 'STALE_COMPILED_CHILD_PLAN',
            message: `Compiled child plan '${definition.planId}' is stale relative to parent '${parent.planId}'. Run plans:compile or orchestration preflight to regenerate it.`,
            filePath: existing.rel
          });
        }
      }
    }

    if (definitions.length > 0) {
      results.compiledParents.push(parent.planId);
    }
  }

  return results;
}
