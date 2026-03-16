import {
  CHILD_SLICE_DEFINITIONS_SECTION,
  extractProgramChildUnitDeclarations,
  parseAuthoringIntent,
  metadataValue,
  parseDeliveryClass,
  parseListField,
  parseMetadata,
  parsePlanId,
  parseRiskTier,
  parseSecurityApproval,
  slugify
} from './plan-metadata.mjs';
import { setPlanDocumentFields } from './plan-document-state.mjs';

const LEGACY_PROGRAM_CHILD_SECTION_PATTERNS = [
  /^Remaining Execution Slices$/i,
  /Portfolio Units$/i
];
const AUTHORING_INTENT_EXECUTABLE_DEFAULT = 'executable-default';
const SOURCE_LIKE_ROOT_PATTERN = /^(?:src|app|apps|packages|services|server|client|web|ui|api|lib|libs|tests?|test-utils|config)\b/i;

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

function normalizeBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function humanizePlanId(planId) {
  return String(planId ?? '')
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function uniquePlanId(baseId, used) {
  let planId = baseId;
  let suffix = 2;
  while (used.has(planId)) {
    planId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  used.add(planId);
  return planId;
}

function isLegacyProgramChildSectionTitle(value) {
  const rendered = String(value ?? '').trim();
  return LEGACY_PROGRAM_CHILD_SECTION_PATTERNS.some((pattern) => pattern.test(rendered));
}

function derivePlanId(declaration, usedPlanIds) {
  const hinted = parsePlanId(declaration?.planIdHint, null);
  if (hinted) {
    return uniquePlanId(hinted, usedPlanIds);
  }
  const slug = slugify(String(declaration?.title ?? 'child-slice')) || 'child-slice';
  return uniquePlanId(slug, usedPlanIds);
}

function deriveTitle(declaration, planId) {
  const rawTitle = String(declaration?.title ?? '').trim();
  if (!rawTitle) {
    return humanizePlanId(planId);
  }
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawTitle)) {
    return humanizePlanId(rawTitle);
  }
  return rawTitle;
}

function defaultValidationLanes(parent, validationIds) {
  const lanes = ['always'];
  if (
    parent.deliveryClass === 'product' &&
    Array.isArray(validationIds?.['host-required']) &&
    validationIds['host-required'].length > 0
  ) {
    lanes.push('host-required');
  }
  return lanes;
}

function defaultSpecTargets(parent) {
  if (parent.specTargets.length > 0) {
    return parent.specTargets;
  }
  return ['TODO-review-spec-targets'];
}

function deriveImplementationTargets(parent, planId) {
  const derived = parent.specTargets.filter((entry) => {
    if (!entry) {
      return false;
    }
    if (entry.startsWith('docs/')) {
      return false;
    }
    if (entry.endsWith('.md')) {
      return false;
    }
    return SOURCE_LIKE_ROOT_PATTERN.test(entry);
  });
  if (derived.length > 0) {
    return derived;
  }
  return [`TODO-review-implementation-targets-${planId}`];
}

function proofRows(planId, lanes, validationIds) {
  const rows = [];
  const alwaysId = validationIds?.always?.[0] ?? 'always:1';
  rows.push(`| proof-${planId}-always | cap-${planId} | integration | always | ${alwaysId} | same-run |`);
  if (lanes.includes('host-required')) {
    const hostId = validationIds?.['host-required']?.[0] ?? 'host-required:1';
    rows.push(`| proof-${planId}-host | cap-${planId} | host-required | host-required | ${hostId} | same-run |`);
  }
  return rows;
}

function renderChildDefinition(definition) {
  const lines = [
    `### ${definition.planId}`,
    `- Title: ${definition.title}`,
    `- Dependencies: ${definition.dependencies.length > 0 ? definition.dependencies.join(', ') : 'none'}`,
    `- Spec-Targets: ${definition.specTargets.join(', ')}`,
    `- Validation-Lanes: ${definition.validationLanes.join(', ')}`
  ];

  if (definition.implementationTargets.length > 0) {
    lines.splice(4, 0, `- Implementation-Targets: ${definition.implementationTargets.join(', ')}`);
  }
  if (definition.autonomyAllowed) {
    lines.push(`- Autonomy-Allowed: ${definition.autonomyAllowed}`);
  }
  if (definition.riskTier) {
    lines.push(`- Risk-Tier: ${definition.riskTier}`);
  }
  if (definition.securityApproval) {
    lines.push(`- Security-Approval: ${definition.securityApproval}`);
  }
  if (definition.tags.length > 0) {
    lines.push(`- Tags: ${definition.tags.join(', ')}`);
  }

  lines.push(
    '',
    '#### Must-Land Checklist',
    `- [ ] \`ml-${definition.planId}\` Complete the executable child slice scope for ${definition.title}.`,
    '',
    '#### Already-True Baseline',
    `- Legacy parent '${definition.parentPlanId}' previously tracked this slice only as a heading-level unit.`,
    '',
    '#### Deferred Follow-Ons',
    '- Carry forward any remaining scope that should stay outside this first executable child slice.',
    ''
  );

  if (definition.deliveryClass === 'product') {
    lines.push(
      '#### Capability Proof Map',
      '| Capability ID | Must-Land IDs | Claim | Required Strength |',
      '| --- | --- | --- | --- |',
      `| cap-${definition.planId} | ml-${definition.planId} | Deliver ${definition.title}. | strong |`,
      '',
      '| Proof ID | Capability ID | Type | Lane | Validation ID / Artifact | Freshness |',
      '| --- | --- | --- | --- | --- | --- |',
      ...proofRows(definition.planId, definition.validationLanes, definition.validationIds),
      ''
    );
  }

  return lines.join('\n');
}

function renderChildSliceDefinitionsSection(definitions) {
  const blocks = definitions.map((definition) => renderChildDefinition(definition)).join('\n\n');
  return `## ${CHILD_SLICE_DEFINITIONS_SECTION}\n\n${blocks}\n`;
}

function findLegacySectionRanges(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const ranges = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].match(/^##\s+(.+?)\s*$/);
    if (!headingMatch || !isLegacyProgramChildSectionTitle(headingMatch[1])) {
      continue;
    }
    const start = lineOffsets[index];
    let end = offset;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+/.test(lines[cursor])) {
        end = lineOffsets[cursor];
        break;
      }
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function replaceLegacySections(content, renderedSection, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return String(content ?? '');
  }
  const first = ranges[0];
  const before = content.slice(0, first.start).trimEnd();
  const after = content.slice(ranges[ranges.length - 1].end).trimStart();
  if (!before && !after) {
    return `${renderedSection.trimEnd()}\n`;
  }
  if (!before) {
    return `${renderedSection.trimEnd()}\n\n${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  if (!after) {
    return `${before}\n\n${renderedSection.trimEnd()}\n`.replace(/\n{3,}/g, '\n\n');
  }
  return `${before}\n\n${renderedSection.trimEnd()}\n\n${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function migrateLegacyProgramChildDefinitions(content, options = {}) {
  const metadata = parseMetadata(content);
  const parentPlanId = parsePlanId(metadataValue(metadata, 'Plan-ID'), null) || 'parent-program';
  const deliveryClass = parseDeliveryClass(metadataValue(metadata, 'Delivery-Class'), '');
  const authoringIntentRaw = String(metadataValue(metadata, 'Authoring-Intent') ?? '').trim();
  const authoringIntent = parseAuthoringIntent(authoringIntentRaw, '');
  const parent = {
    planId: parentPlanId,
    deliveryClass,
    autonomyAllowed: String(metadataValue(metadata, 'Autonomy-Allowed') ?? '').trim(),
    riskTier: parseRiskTier(metadataValue(metadata, 'Risk-Tier'), ''),
    securityApproval: parseSecurityApproval(metadataValue(metadata, 'Security-Approval'), ''),
    specTargets: normalizeListValue(parseListField(metadataValue(metadata, 'Spec-Targets'))),
    tags: parseListField(metadataValue(metadata, 'Tags'))
  };
  const validationIds = {
    always: normalizeListValue(options.validationIds?.always ?? []),
    'host-required': normalizeListValue(options.validationIds?.['host-required'] ?? [])
  };
  const legacyUnits = extractProgramChildUnitDeclarations(content);
  const ranges = findLegacySectionRanges(content);

  if (authoringIntentRaw && !authoringIntent) {
    throw new Error(
      `Plan '${parentPlanId}' uses invalid 'Authoring-Intent: ${authoringIntentRaw}'. Fix the metadata before migrating legacy child headings.`
    );
  }
  if (authoringIntent === 'blueprint-only') {
    throw new Error(
      `Plan '${parentPlanId}' is marked 'Authoring-Intent: blueprint-only'. Change intent before migrating executable children.`
    );
  }

  if (legacyUnits.length === 0 || ranges.length === 0) {
    return {
      changed: false,
      legacyUnits: [],
      definitions: [],
      renderedSection: '',
      updatedContent: String(content ?? '')
    };
  }

  const usedPlanIds = new Set();
  const definitions = legacyUnits.map((declaration) => {
    const planId = derivePlanId(declaration, usedPlanIds);
    return {
      parentPlanId,
      planId,
      title: deriveTitle(declaration, planId),
      deliveryClass,
      dependencies: [],
      specTargets: defaultSpecTargets(parent),
      implementationTargets: deliveryClass === 'product' ? deriveImplementationTargets(parent, planId) : [],
      validationLanes: defaultValidationLanes(parent, validationIds),
      autonomyAllowed: parent.autonomyAllowed,
      riskTier: parent.riskTier,
      securityApproval: parent.securityApproval,
      tags: parent.tags,
      validationIds
    };
  });

  const renderedSection = renderChildSliceDefinitionsSection(definitions);
  let updatedContent = replaceLegacySections(content, renderedSection, ranges);
  if (!authoringIntentRaw) {
    updatedContent = setPlanDocumentFields(updatedContent, {
      'Authoring-Intent': AUTHORING_INTENT_EXECUTABLE_DEFAULT
    });
  }
  return {
    changed: updatedContent !== String(content ?? ''),
    legacyUnits,
    definitions,
    renderedSection,
    updatedContent
  };
}

export async function readValidationIdsFromConfig(rootDir, fsModule) {
  try {
    const raw = await fsModule.readFile(
      `${rootDir}/docs/ops/automation/orchestrator.config.json`,
      'utf8'
    );
    const config = JSON.parse(raw);
    return {
      always: normalizeListValue(
        (Array.isArray(config?.validation?.always) ? config.validation.always : [])
          .map((entry, index) => {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
              return String(entry.id ?? '').trim() || `always:${index + 1}`;
            }
            return `always:${index + 1}`;
          })
      ),
      'host-required': normalizeListValue(
        (Array.isArray(config?.validation?.hostRequired) ? config.validation.hostRequired : [])
          .map((entry, index) => {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
              return String(entry.id ?? '').trim() || `host-required:${index + 1}`;
            }
            return `host-required:${index + 1}`;
          })
      )
    };
  } catch {
    return {
      always: [],
      'host-required': []
    };
  }
}

export function parseWriteMode(value, fallback = false) {
  return normalizeBoolean(value, fallback);
}
