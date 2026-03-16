import {
  CAPABILITY_PROOF_MAP_SECTION,
  CHILD_SLICE_DEFINITIONS_SECTION,
  COVERAGE_SECTION_TITLES,
  extractProgramChildUnitDeclarations,
  metadataValue,
  parseAuthoringIntent,
  parseDeliveryClass,
  parseListField,
  parseMetadata,
  parseMustLandChecklist,
  parsePlanId,
  parseRiskTier,
  parseSecurityApproval,
  parseValidationLanes,
  sectionBody,
  slugify
} from './plan-metadata.mjs';
import { setPlanDocumentFields } from './plan-document-state.mjs';

export const AUTHORING_INTENT_EXECUTABLE_DEFAULT = 'executable-default';
export const AUTHORING_INTENT_BLUEPRINT_ONLY = 'blueprint-only';
export const DRAFT_CHILD_DEFINITION_MARKER = 'ORCH-DRAFT-CHILD-DEFINITION';
export const REVIEW_REQUIRED_TOKEN = 'REVIEW-REQUIRED';

const EXPLICIT_ORDERED_SECTION_PATTERNS = [
  /^Remaining Execution Slices$/i,
  /Portfolio Units$/i,
  /^Implementation Order$/i,
  /^Workstreams$/i
];

const ADMIN_SECTION_TITLES = new Set([
  'Metadata',
  'Already-True Baseline',
  'Must-Land Checklist',
  'Deferred Follow-Ons',
  'Master Plan Coverage',
  'Capability Coverage Matrix',
  'Prior Completed Plan Reconciliation',
  'Promotion Blockers',
  'Child Slice Definitions',
  'Validation Contract',
  'Planner Overlay',
  'Validation Evidence',
  'Host Validation',
  'Closure',
  'Automated Delivery Log'
]);

function normalizePathEntry(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function normalizeListValue(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((entry) => normalizePathEntry(entry))
      .filter(Boolean)
  )];
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
  const section = sectionBody(content, CHILD_SLICE_DEFINITIONS_SECTION);
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
      proofMapBody: subsections.get('capability proof map') ?? '',
      isDraft: current.lines.some((line) => String(line ?? '').includes(DRAFT_CHILD_DEFINITION_MARKER))
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

function buildIssue(code, message, filePath) {
  return { code, message, filePath };
}

export function evaluateProgramParentAuthoring(plan) {
  if (String(plan?.executionScope ?? '').trim().toLowerCase() !== 'program') {
    return null;
  }

  const content = String(plan?.content ?? '');
  const metadata = plan?.metadata instanceof Map ? plan.metadata : parseMetadata(content);
  const filePath = String(plan?.rel ?? plan?.filePath ?? '').trim() || '.';
  const phase = String(plan?.phase ?? '').trim().toLowerCase();
  const status = String(plan?.status ?? '').trim().toLowerCase();
  const authoringIntentRaw = metadataValue(metadata, 'Authoring-Intent');
  const authoringIntent = parseAuthoringIntent(authoringIntentRaw, '');
  const parsed = parseStructuredProgramChildDefinitions(content);
  const legacyUnits = parsed.legacyUnits;
  const hasChildDefinitionsSection = Boolean(sectionBody(content, CHILD_SLICE_DEFINITIONS_SECTION));
  const draftScaffoldPresent = parsed.definitions.some((definition) => definition.isDraft);
  const issues = [];

  if (phase !== 'completed') {
    if (!authoringIntentRaw) {
      issues.push(buildIssue(
        'MISSING_AUTHORING_INTENT',
        "Future and active program parents must declare 'Authoring-Intent: executable-default' or 'Authoring-Intent: blueprint-only'.",
        filePath
      ));
    } else if (!authoringIntent) {
      issues.push(buildIssue(
        'INVALID_AUTHORING_INTENT',
        `Invalid Authoring-Intent '${authoringIntentRaw}' (expected: executable-default|blueprint-only).`,
        filePath
      ));
    }

    if (authoringIntent === AUTHORING_INTENT_BLUEPRINT_ONLY) {
      if (phase !== 'future') {
        issues.push(buildIssue(
          'BLUEPRINT_ONLY_PROGRAM_NOT_FUTURE',
          "Blueprint-only program parents are allowed only in 'docs/future/'.",
          filePath
        ));
      }
      if (status && status !== 'draft') {
        issues.push(buildIssue(
          'BLUEPRINT_ONLY_PROGRAM_NOT_DRAFT',
          "Blueprint-only program parents must stay at 'Status: draft'.",
          filePath
        ));
      }
      if (hasChildDefinitionsSection || parsed.definitions.length > 0) {
        issues.push(buildIssue(
          'BLUEPRINT_ONLY_PROGRAM_WITH_CHILD_DEFINITIONS',
          "Blueprint-only program parents must not declare '## Child Slice Definitions'. Switch to 'Authoring-Intent: executable-default' first.",
          filePath
        ));
      }
    }

    if (authoringIntent === AUTHORING_INTENT_EXECUTABLE_DEFAULT) {
      if (legacyUnits.length > 0) {
        issues.push(buildIssue(
          'LEGACY_PROGRAM_CHILD_SCHEMA',
          `Program plan '${plan.planId}' still uses legacy child-unit headings. Replace them with '## ${CHILD_SLICE_DEFINITIONS_SECTION}'.`,
          filePath
        ));
      }
      if (!hasChildDefinitionsSection) {
        issues.push(buildIssue(
          'PROGRAM_PARENT_MISSING_CHILD_DEFINITIONS',
          `Program plan '${plan.planId}' cannot execute because it has no '## ${CHILD_SLICE_DEFINITIONS_SECTION}'.`,
          filePath
        ));
      } else if (parsed.definitions.length === 0 && parsed.errors.length === 0) {
        issues.push(buildIssue(
          'PROGRAM_PARENT_EMPTY_CHILD_DEFINITIONS',
          `Program plan '${plan.planId}' declares '## ${CHILD_SLICE_DEFINITIONS_SECTION}' but no child definitions.`,
          filePath
        ));
      }
      if (draftScaffoldPresent) {
        issues.push(buildIssue(
          'PROGRAM_PARENT_DRAFT_CHILD_DEFINITIONS',
          `Program plan '${plan.planId}' still contains draft child scaffold markers. Review and remove '${DRAFT_CHILD_DEFINITION_MARKER}' before compilation.`,
          filePath
        ));
      }
      for (const error of parsed.errors) {
        issues.push(buildIssue(
          'INVALID_CHILD_SLICE_DEFINITION',
          error,
          filePath
        ));
      }
    }
  }

  let statusCode = 'ready-for-compilation';
  let reason = 'Program parent is ready for child compilation.';
  if (!authoringIntentRaw) {
    statusCode = 'blocked-missing-authoring-intent';
    reason = "Program parent is missing 'Authoring-Intent'.";
  } else if (!authoringIntent) {
    statusCode = 'blocked-invalid-authoring-intent';
    reason = 'Program parent uses an invalid authoring intent.';
  } else if (authoringIntent === AUTHORING_INTENT_BLUEPRINT_ONLY) {
    statusCode = issues.length > 0 ? 'blocked-blueprint-only-invalid' : 'skipped-blueprint-only';
    reason = issues.length > 0
      ? 'Blueprint-only program parent violates blueprint-only constraints.'
      : 'Program parent is intentionally blueprint-only.';
  } else if (legacyUnits.length > 0) {
    statusCode = 'blocked-legacy-headings';
    reason = 'Legacy headings block structured child compilation.';
  } else if (!hasChildDefinitionsSection || (parsed.definitions.length === 0 && parsed.errors.length === 0)) {
    statusCode = 'blocked-missing-child-definitions';
    reason = 'No child definitions exist.';
  } else if (draftScaffoldPresent) {
    statusCode = 'blocked-draft-scaffold';
    reason = 'Draft child scaffold markers still require review.';
  } else if (parsed.errors.length > 0) {
    statusCode = 'blocked-invalid-definitions';
    reason = 'Structured child definitions are invalid.';
  }

  return {
    planId: plan.planId,
    phase,
    rel: filePath,
    status,
    authoringIntent,
    authoringIntentRaw: authoringIntentRaw ? String(authoringIntentRaw).trim() : '',
    childDefinitionCount: parsed.definitions.length,
    hasChildDefinitionsSection,
    usesLegacyHeadings: legacyUnits.length > 0,
    legacyUnits,
    draftScaffoldPresent,
    readyForCompilation: statusCode === 'ready-for-compilation',
    statusCode,
    reason,
    issues,
    parsedDefinitions: parsed.definitions,
    parseErrors: parsed.errors
  };
}

function uniquePlanId(baseId, usedPlanIds) {
  let candidate = baseId;
  let suffix = 2;
  while (usedPlanIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedPlanIds.add(candidate);
  return candidate;
}

function deriveImplementationTargets(specTargets, planId) {
  const derived = specTargets.filter((entry) => {
    if (!entry || entry.startsWith('docs/') || entry.endsWith('.md') || entry.endsWith('.mdx')) {
      return false;
    }
    return true;
  });
  if (derived.length > 0) {
    return derived;
  }
  return [`${REVIEW_REQUIRED_TOKEN}-implementation-targets-${planId}`];
}

function headingSections(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) {
        sections.push(current);
      }
      current = {
        title: headingMatch[1].trim(),
        lines: []
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }
  return sections;
}

function extractExplicitOrderedItems(content) {
  const items = [];
  const usedTitles = new Set();

  for (const declaration of extractProgramChildUnitDeclarations(content)) {
    const title = String(declaration.title ?? '').trim();
    if (!title || usedTitles.has(title.toLowerCase())) {
      continue;
    }
    usedTitles.add(title.toLowerCase());
    items.push({
      title,
      ordered: true,
      source: declaration.sectionTitle
    });
  }

  for (const section of headingSections(content)) {
    if (!EXPLICIT_ORDERED_SECTION_PATTERNS.some((pattern) => pattern.test(section.title))) {
      continue;
    }
    for (const line of section.lines) {
      const numbered = String(line ?? '').trim().match(/^\d+\.\s+(.+)$/);
      if (!numbered) {
        continue;
      }
      const title = numbered[1].trim();
      if (!title || usedTitles.has(title.toLowerCase())) {
        continue;
      }
      usedTitles.add(title.toLowerCase());
      items.push({
        title,
        ordered: true,
        source: section.title
      });
    }
  }

  return items;
}

function parseMarkdownTableRow(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('|') || trimmed.split('|').length < 3) {
    return [];
  }
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function extractCoverageItems(content) {
  const body = COVERAGE_SECTION_TITLES
    .map((title) => sectionBody(content, title))
    .find(Boolean);
  if (!body) {
    return [];
  }

  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseMarkdownTableRow(lines[index]);
    const separatorCells = parseMarkdownTableRow(lines[index + 1]);
    if (headerCells.length === 0 || !isMarkdownTableSeparator(separatorCells)) {
      continue;
    }
    const thisPlanColumnIndex = headerCells.findIndex((cell) => /\bthis (?:plan|phase)\b/i.test(cell));
    if (thisPlanColumnIndex <= 0) {
      continue;
    }

    const items = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseMarkdownTableRow(lines[rowIndex]);
      if (rowCells.length === 0) {
        if (String(lines[rowIndex] ?? '').trim()) {
          break;
        }
        continue;
      }
      if (isMarkdownTableSeparator(rowCells)) {
        continue;
      }
      const title = String(rowCells[0] ?? '').replace(/`/g, '').trim();
      const selected = /\byes\b/i.test(String(rowCells[thisPlanColumnIndex] ?? ''));
      if (!title || !selected) {
        continue;
      }
      items.push({
        title,
        ordered: false,
        source: 'coverage-matrix'
      });
    }
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function extractNumberedSectionItems(content) {
  return headingSections(content)
    .filter((section) => !ADMIN_SECTION_TITLES.has(section.title))
    .filter((section) => /^\d+\.\s+/.test(section.title) || /^Phase\s+\d+\b/i.test(section.title))
    .map((section) => ({
      title: section.title.replace(/^\d+\.\s*/, '').trim(),
      ordered: true,
      source: 'numbered-section'
    }))
    .filter((entry) => entry.title);
}

function extractMustLandItems(content) {
  return parseMustLandChecklist(content).map((entry) => ({
    title: entry.text,
    ordered: false,
    source: 'must-land'
  }));
}

function scaffoldSeeds(content) {
  const sources = [
    extractExplicitOrderedItems(content),
    extractCoverageItems(content),
    extractNumberedSectionItems(content),
    extractMustLandItems(content)
  ];
  return sources.find((entries) => entries.length > 0) ?? [];
}

function renderDraftDefinition(definition) {
  const proofValidationRef = definition.validationIds.always[0] ?? REVIEW_REQUIRED_TOKEN;
  const lines = [
    `### ${definition.planId}`,
    `<!-- ${DRAFT_CHILD_DEFINITION_MARKER} source=${definition.source} review-required=true -->`,
    `- Title: ${definition.title}`,
    `- Dependencies: ${definition.dependencies.length > 0 ? definition.dependencies.join(', ') : 'none'}`,
    `- Spec-Targets: ${definition.specTargets.join(', ')}`,
    `- Validation-Lanes: ${definition.validationLanes.join(', ')}`,
    `- Implementation-Targets: ${definition.implementationTargets.length > 0 ? definition.implementationTargets.join(', ') : 'none'}`,
    '',
    '#### Must-Land Checklist',
    `- [ ] \`ml-${definition.planId}\` ${REVIEW_REQUIRED_TOKEN}: refine this child into one executable slice for ${definition.title}.`,
    '',
    '#### Already-True Baseline',
    `- ${REVIEW_REQUIRED_TOKEN}: capture the baseline facts for ${definition.title}.`,
    '',
    '#### Deferred Follow-Ons',
    `- ${REVIEW_REQUIRED_TOKEN}: record the remaining scope that stays outside ${definition.title}.`,
    '',
    `#### ${CAPABILITY_PROOF_MAP_SECTION}`,
    '| Capability ID | Must-Land IDs | Claim | Required Strength |',
    '| --- | --- | --- | --- |',
    `| cap-${definition.planId} | ml-${definition.planId} | ${REVIEW_REQUIRED_TOKEN}: replace this claim for ${definition.title}. | strong |`,
    '',
    '| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |',
    '| --- | --- | --- | --- | --- | --- |',
    `| proof-${definition.planId} | cap-${definition.planId} | integration | always | ${proofValidationRef} | same-run |`,
    ''
  ];
  return lines.join('\n');
}

function renderChildDefinitions(definitions) {
  return `## ${CHILD_SLICE_DEFINITIONS_SECTION}\n\n${definitions.map((definition) => renderDraftDefinition(definition)).join('\n\n')}\n`;
}

function insertSectionAfter(content, sectionTitle, renderedSection) {
  const bounds = (() => {
    const body = sectionBody(content, sectionTitle);
    if (!body) {
      return null;
    }
    const fullMatch = new RegExp(`^##\\s+${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(content);
    if (!fullMatch || fullMatch.index == null) {
      return null;
    }
    const start = fullMatch.index;
    const remainder = content.slice(start + fullMatch[0].length);
    const nextHeadingMatch = /^##\s+/m.exec(remainder);
    const end = nextHeadingMatch && nextHeadingMatch.index != null
      ? start + fullMatch[0].length + nextHeadingMatch.index
      : content.length;
    return { end };
  })();

  if (!bounds) {
    return `${String(content ?? '').trimEnd()}\n\n${renderedSection.trimEnd()}\n`;
  }

  const before = String(content ?? '').slice(0, bounds.end).trimEnd();
  const after = String(content ?? '').slice(bounds.end).trimStart();
  if (!after) {
    return `${before}\n\n${renderedSection.trimEnd()}\n`;
  }
  return `${before}\n\n${renderedSection.trimEnd()}\n\n${after}`.replace(/\n{3,}/g, '\n\n');
}

export function scaffoldProgramChildDefinitions(content, options = {}) {
  const metadata = parseMetadata(content);
  const planId = parsePlanId(metadataValue(metadata, 'Plan-ID'), null) || 'program-parent';
  const deliveryClass = parseDeliveryClass(metadataValue(metadata, 'Delivery-Class'), '');
  const authoringIntentRaw = String(metadataValue(metadata, 'Authoring-Intent') ?? '').trim();
  const authoringIntent = parseAuthoringIntent(authoringIntentRaw, '');
  const existing = parseStructuredProgramChildDefinitions(content);
  const legacyUnits = extractProgramChildUnitDeclarations(content);
  if (existing.definitions.length > 0 || sectionBody(content, CHILD_SLICE_DEFINITIONS_SECTION)) {
    throw new Error(`Plan '${planId}' already declares '## ${CHILD_SLICE_DEFINITIONS_SECTION}'.`);
  }
  if (legacyUnits.length > 0) {
    throw new Error(
      `Plan '${planId}' still uses legacy child-unit headings. Run 'plans:migrate' before scaffolding structured children.`
    );
  }
  if (authoringIntentRaw && !authoringIntent) {
    throw new Error(
      `Plan '${planId}' uses invalid 'Authoring-Intent: ${authoringIntentRaw}'. Fix the metadata before scaffolding executable children.`
    );
  }
  if (authoringIntent === AUTHORING_INTENT_BLUEPRINT_ONLY) {
    throw new Error(`Plan '${planId}' is marked 'Authoring-Intent: blueprint-only'. Change intent before scaffolding executable children.`);
  }

  const seeds = scaffoldSeeds(content);
  if (seeds.length === 0) {
    throw new Error(`Plan '${planId}' does not expose any deterministic child scaffold source.`);
  }

  const specTargets = normalizeListValue(parseListField(metadataValue(metadata, 'Spec-Targets')));
  const validationIds = {
    always: normalizeListValue(options.validationIds?.always ?? []),
    'host-required': normalizeListValue(options.validationIds?.['host-required'] ?? [])
  };
  const usedPlanIds = new Set();
  let previousPlanId = null;
  const definitions = seeds.map((seed) => {
    const planIdBase = slugify(seed.title) || 'child-slice';
    const childPlanId = uniquePlanId(planIdBase, usedPlanIds);
    const ordered = seed.ordered === true;
    const dependencies = ordered && previousPlanId ? [previousPlanId] : [];
    if (ordered) {
      previousPlanId = childPlanId;
    }
    return {
      planId: childPlanId,
      title: seed.title,
      source: seed.source,
      dependencies,
      specTargets: specTargets.length > 0 ? specTargets : [`${REVIEW_REQUIRED_TOKEN}-spec-targets`],
      implementationTargets: deliveryClass === 'product'
        ? deriveImplementationTargets(specTargets, childPlanId)
        : [],
      validationLanes: ['always'],
      validationIds
    };
  });

  const renderedSection = renderChildDefinitions(definitions);
  let updatedContent = insertSectionAfter(content, 'Promotion Blockers', renderedSection);
  if (!authoringIntentRaw) {
    updatedContent = setPlanDocumentFields(updatedContent, {
      'Authoring-Intent': AUTHORING_INTENT_EXECUTABLE_DEFAULT
    });
  }

  return {
    definitions,
    renderedSection,
    updatedContent
  };
}
