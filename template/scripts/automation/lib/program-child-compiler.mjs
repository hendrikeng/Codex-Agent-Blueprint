import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  VALIDATION_CONTRACT_SECTION,
  inferPlanId,
  listMarkdownFiles,
  metadataValue,
  parseMustLandChecklist,
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
import {
  evaluateProgramParentAuthoring,
  parseStructuredProgramChildDefinitions
} from './program-parent-authoring.mjs';
export { parseStructuredProgramChildDefinitions } from './program-parent-authoring.mjs';

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

function datePrefixFromPlanPath(planPath) {
  const match = path.basename(String(planPath ?? '')).match(/^(\d{4}-\d{2}-\d{2})-/);
  return match?.[1] ?? '1970-01-01';
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
  const topLevelStatus = String(content ?? '').match(/^Status:\s*(.+)$/m)?.[1] ?? '';
  const topLevelValidationReady = String(content ?? '').match(/^Validation-Ready:\s*(.+)$/m)?.[1] ?? '';
  const status =
    String(metadataValue(metadata, 'Status') ?? '').trim().toLowerCase() ||
    String(topLevelStatus).trim().toLowerCase() ||
    String(fallbackStatus ?? '').trim();
  const validationReady =
    String(metadataValue(metadata, 'Validation-Ready') ?? '').trim().toLowerCase() ||
    String(topLevelValidationReady).trim().toLowerCase() ||
    'no';
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
    completedMustLandIds: new Set(
      parseMustLandChecklist(content ?? '')
        .filter((entry) => entry.checked && entry.id)
        .map((entry) => entry.id)
    ),
    completedMustLandTexts: new Set(
      parseMustLandChecklist(content ?? '')
        .filter((entry) => entry.checked && !entry.id)
        .map((entry) => String(entry.text ?? '').trim().toLowerCase())
        .filter(Boolean)
    ),
    tail: tail || `## Planner Overlay\n\n${DEFAULT_PLANNER_OVERLAY}`
  };
}

function alignPreservedStateForPhase(parent, existing, preserved) {
  const aligned = {
    status: preserved.status,
    validationReady: preserved.validationReady,
    doneEvidence: [...(preserved.doneEvidence ?? [])],
    completedMustLandIds: new Set(preserved.completedMustLandIds ?? []),
    completedMustLandTexts: new Set(preserved.completedMustLandTexts ?? []),
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

function applyPreservedChecklistProgress(body, preserved) {
  if (!body) {
    return body;
  }
  const completedMustLandIds = preserved?.completedMustLandIds instanceof Set
    ? preserved.completedMustLandIds
    : new Set();
  const completedMustLandTexts = preserved?.completedMustLandTexts instanceof Set
    ? preserved.completedMustLandTexts
    : new Set();

  return String(body)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*-\s+\[)([ xX])(\]\s+)(.*)$/);
      if (!match) {
        return line;
      }
      const remainder = String(match[4] ?? '').trim();
      const idMatch = remainder.match(/^`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+(.*)$/);
      const mustLandId = idMatch ? idMatch[1] : '';
      const mustLandText = String(idMatch ? idMatch[2] : remainder).trim().toLowerCase();
      const shouldPreserveChecked =
        (mustLandId && completedMustLandIds.has(mustLandId)) ||
        (!mustLandId && mustLandText && completedMustLandTexts.has(mustLandText));
      if (!shouldPreserveChecked) {
        return line;
      }
      return `${match[1]}x${match[3]}${match[4]}`;
    })
    .join('\n');
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
    applyPreservedChecklistProgress(
      definition.mustLandBody || '- [ ] Define generated must-land items in the parent child definition.',
      preserved
    ),
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

function relativeTargetPath(directoryPath, planId, sourcePlanPath) {
  const targetName = datedPlanFileName(datePrefixFromPlanPath(sourcePlanPath), planId);
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
    compiledParents: [],
    parentOutcomes: []
  };

  for (const parent of plans) {
    if (parent.executionScope !== 'program' || (parent.phase !== 'future' && parent.phase !== 'active')) {
      continue;
    }
    if (selectedParentIds.size > 0 && !selectedParentIds.has(parent.planId)) {
      continue;
    }

    const parentState = evaluateProgramParentAuthoring(parent);
    const parsed = parseStructuredProgramChildDefinitions(parent.content);
    const definitions = parsed.definitions;
    const seenChildIds = new Set();
    const desiredPhase = expectedPhaseForParent(parent);
    const parentOutcome = {
      planId: parent.planId,
      filePath: parent.rel,
      phase: parent.phase,
      authoringIntent: parentState?.authoringIntent ?? '',
      childDefinitionCount: parentState?.childDefinitionCount ?? definitions.length,
      status: parentState?.statusCode ?? 'ready-for-compilation',
      reason: parentState?.reason ?? 'Program parent is ready for child compilation.'
    };

    if (parentState && parentState.issues.length > 0) {
      results.issues.push(...parentState.issues);
      results.parentOutcomes.push(parentOutcome);
      continue;
    }

    if (parentState?.authoringIntent === 'blueprint-only') {
      results.parentOutcomes.push(parentOutcome);
      continue;
    }

    const issueCountBeforeParent = results.issues.length;
    const writeCountBeforeParent = results.writes.length;
    const moveCountBeforeParent = results.moves.length;

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
        const nextPath = relativeTargetPath(targetDirectoryForPhase(rootDir, 'active'), definition.planId, parent.rel);
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
        : existing?.filePath ?? relativeTargetPath(
          targetDirectoryForPhase(rootDir, desiredPhase),
          definition.planId,
          parent.rel
        );
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

    const parentIssueCount = results.issues.length - issueCountBeforeParent;
    const parentWriteCount = (results.writes.length - writeCountBeforeParent) + (results.moves.length - moveCountBeforeParent);
    if (parentIssueCount > 0) {
      const hasGeneratedStateIssue = results.issues
        .slice(issueCountBeforeParent)
        .some((issue) => issue.code === 'MISSING_COMPILED_CHILD_PLAN' || issue.code === 'STALE_COMPILED_CHILD_PLAN');
      parentOutcome.status = hasGeneratedStateIssue ? 'blocked-generated-child-drift' : 'blocked-invalid-definitions';
      parentOutcome.reason = hasGeneratedStateIssue
        ? 'Compiled child plans are missing or stale.'
        : 'Structured child definitions are invalid or inconsistent.';
    } else if (parentWriteCount > 0) {
      parentOutcome.status = 'compiled-written';
      parentOutcome.reason = 'Compiled child plans were created or updated.';
    } else {
      parentOutcome.status = 'compiled-current';
      parentOutcome.reason = 'Compiled child plans are current.';
    }
    results.parentOutcomes.push(parentOutcome);
  }

  return results;
}
