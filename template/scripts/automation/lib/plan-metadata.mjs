import fs from 'node:fs/promises';
import path from 'node:path';

export const FUTURE_STATUSES = new Set(['draft', 'ready-for-promotion']);
export const ACTIVE_STATUSES = new Set(['queued', 'in-progress', 'blocked', 'validation', 'completed', 'failed']);
export const COMPLETED_STATUSES = new Set(['completed']);
export const RISK_TIERS = new Set(['low', 'medium', 'high']);
export const SECURITY_APPROVAL_VALUES = new Set(['not-required', 'pending', 'approved']);
export const DELIVERY_CLASSES = new Set(['product', 'docs', 'ops', 'reconciliation']);
export const EXECUTION_SCOPES = new Set(['slice', 'program']);
export const CAPABILITY_PROOF_MAP_SECTION = 'Capability Proof Map';
export const PROOF_TYPES = new Set([
  'unit',
  'integration',
  'contract',
  'end-to-end',
  'host-required',
  'manual',
  'approved-exception'
]);
export const PROOF_LANES = new Set(['always', 'host-required', 'manual']);
export const PROOF_FRESHNESS_VALUES = new Set(['same-run', 'same-head', 'manual']);
export const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COVERAGE_SECTION_TITLES = ['Master Plan Coverage', 'Capability Coverage Matrix'];
export const UNFINISHED_COVERAGE_STATUS_PATTERNS = [
  /\bnot shipped\b/i,
  /\bfoundation only\b/i,
  /\bpartially implemented\b/i,
  /\bpartially shipped\b/i,
  /\bin progress\b/i,
  /\bqueued\b/i,
  /\bblocked\b/i,
  /\bplanned\b/i,
  /\bdraft\b/i
];
const PROGRAM_CHILD_SECTION_PATTERNS = [
  /^Remaining Execution Slices$/i,
  /Portfolio Units$/i
];

export const REQUIRED_METADATA_FIELDS = {
  future: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Execution-Scope',
    'Dependencies',
    'Spec-Targets',
    'Done-Evidence'
  ],
  active: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Execution-Scope',
    'Dependencies',
    'Spec-Targets',
    'Done-Evidence'
  ],
  completed: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Execution-Scope',
    'Dependencies',
    'Spec-Targets',
    'Done-Evidence'
  ]
};

function normalizeKey(key) {
  return key.trim().toLowerCase();
}

export function normalizePlanId(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidPlanId(value) {
  const normalized = normalizePlanId(value);
  return normalized.length > 0 && PLAN_ID_REGEX.test(normalized);
}

export function parsePlanId(value, fallback = null) {
  const normalized = normalizePlanId(value);
  if (!isValidPlanId(normalized)) {
    return fallback;
  }
  return normalized;
}

function metadataSectionRange(content) {
  const lines = content.split(/\r?\n/);
  let start = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+Metadata\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      end = i;
      break;
    }

    if (!line.trim()) {
      continue;
    }

    // Metadata fields must be bullets. Stop before normal body content.
    if (!/^\s*-\s*[A-Za-z][A-Za-z0-9- ]+:\s*(.*)$/.test(line)) {
      end = i;
      break;
    }
  }

  return { lines, start, end };
}

export function sectionBounds(content, sectionTitle) {
  const regex = new RegExp(`^##\\s+${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = regex.exec(content);
  if (!match || match.index == null) {
    return null;
  }

  const start = match.index;
  const bodyStart = start + match[0].length;
  const remainder = content.slice(bodyStart);
  const nextSectionMatch = /^##\s+/m.exec(remainder);
  const end = nextSectionMatch && nextSectionMatch.index != null
    ? bodyStart + nextSectionMatch.index
    : content.length;
  return { start, bodyStart, end };
}

export function sectionBody(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return '';
  }
  return content.slice(bounds.bodyStart, bounds.end).trim();
}

export function firstSectionBody(content, sectionTitles) {
  for (const title of sectionTitles) {
    const body = sectionBody(content, title);
    if (body) {
      return { title, body };
    }
  }
  return { title: null, body: '' };
}

function isProgramChildSectionTitle(value) {
  const rendered = String(value ?? '').trim();
  return PROGRAM_CHILD_SECTION_PATTERNS.some((pattern) => pattern.test(rendered));
}

function normalizeProgramChildHeading(rawHeading) {
  const rendered = String(rawHeading ?? '').trim();
  if (!rendered) {
    return null;
  }
  const planIdHintMatch = rendered.match(/:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/);
  const planIdHint = planIdHintMatch ? parsePlanId(planIdHintMatch[1], null) : null;
  const title = rendered
    .replace(/^\d+\.\s*/, '')
    .replace(/^Stage\s+\d+\.\s*/i, '')
    .replace(/^Slice\s+\d+\s*:\s*/i, '')
    .replace(/^PU-\d+\s*(?:\([^)]*\))?\s*:\s*/i, '')
    .trim();
  return {
    rawHeading: rendered,
    title: title || rendered,
    planIdHint
  };
}

export function extractProgramChildUnitDeclarations(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const declarations = [];
  let currentSection = '';

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+?)\s*$/);
    if (h2Match) {
      currentSection = h2Match[1].trim();
      continue;
    }

    const h3Match = line.match(/^###\s+(.+?)\s*$/);
    if (!h3Match || !isProgramChildSectionTitle(currentSection)) {
      continue;
    }

    const declaration = normalizeProgramChildHeading(h3Match[1]);
    if (declaration) {
      declarations.push({
        ...declaration,
        sectionTitle: currentSection
      });
    }
  }

  return declarations;
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

function normalizeProofHeader(cell) {
  return String(cell ?? '')
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function splitCommaList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function checklistItemMatch(line) {
  return String(line ?? '').trim().match(/^-\s+\[([ xX])\]\s+(.*)$/);
}

function parseChecklistItemLine(line) {
  const match = checklistItemMatch(line);
  if (!match) {
    return null;
  }
  const remainder = match[2].trim();
  const idMatch = remainder.match(/^`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+(.*)$/);
  return {
    line: String(line ?? '').trim(),
    checked: match[1].toLowerCase() === 'x',
    id: idMatch ? idMatch[1] : null,
    text: (idMatch ? idMatch[2] : remainder).trim()
  };
}

function parseMarkdownTables(sectionContent) {
  if (!sectionContent) {
    return [];
  }

  const lines = String(sectionContent).split(/\r?\n/);
  const tables = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseMarkdownTableRow(lines[index]);
    const separatorCells = parseMarkdownTableRow(lines[index + 1]);
    if (headerCells.length === 0 || !isMarkdownTableSeparator(separatorCells)) {
      continue;
    }

    const rows = [];
    let rowIndex = index + 2;
    for (; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseMarkdownTableRow(lines[rowIndex]);
      if (rowCells.length === 0) {
        if (String(lines[rowIndex] ?? '').trim()) {
          break;
        }
        break;
      }
      if (isMarkdownTableSeparator(rowCells)) {
        continue;
      }
      rows.push(rowCells);
    }

    tables.push({
      headers: headerCells,
      rows
    });
    index = rowIndex;
  }

  return tables;
}

function tableRowsToObjects(table) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
    return [];
  }
  const normalizedHeaders = table.headers.map((header) => normalizeProofHeader(header));
  return table.rows.map((cells) => {
    const row = {};
    normalizedHeaders.forEach((header, index) => {
      row[header] = String(cells[index] ?? '').trim();
    });
    return row;
  });
}

export function collectUnfinishedCoverageRows(content, sectionTitles = COVERAGE_SECTION_TITLES) {
  const coverageSection = firstSectionBody(content, sectionTitles);
  if (!coverageSection.body) {
    return [];
  }

  const lines = coverageSection.body.split(/\r?\n/);
  const findings = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseMarkdownTableRow(lines[index]);
    const separatorCells = parseMarkdownTableRow(lines[index + 1]);
    if (headerCells.length === 0 || !isMarkdownTableSeparator(separatorCells)) {
      continue;
    }

    const statusColumnIndex = headerCells.findIndex((cell) => /\b(?:repo\s+status\s+now|current\s+status|status)\b/i.test(cell));
    if (statusColumnIndex === -1) {
      continue;
    }

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

      const capability = rowCells[0] ?? '';
      const status = rowCells[statusColumnIndex] ?? '';
      if (!status) {
        continue;
      }
      if (!UNFINISHED_COVERAGE_STATUS_PATTERNS.some((pattern) => pattern.test(status))) {
        continue;
      }

      findings.push({
        sectionTitle: coverageSection.title,
        capability: capability.replace(/`/g, '').trim(),
        status: status.replace(/`/g, '').trim()
      });
    }

    if (findings.length > 0) {
      break;
    }
  }

  return findings;
}

export function parseChecklistItems(sectionContent) {
  if (!sectionContent) {
    return [];
  }
  return String(sectionContent)
    .split(/\r?\n/)
    .map((line) => parseChecklistItemLine(line))
    .filter(Boolean);
}

export function parseMustLandChecklist(content) {
  return parseChecklistItems(sectionBody(content, 'Must-Land Checklist'));
}

export function parseCapabilityProofMap(content) {
  const body = sectionBody(content, CAPABILITY_PROOF_MAP_SECTION);
  if (!body) {
    return {
      capabilities: [],
      proofs: [],
      errors: []
    };
  }

  const tables = parseMarkdownTables(body);
  if (tables.length < 2) {
    return {
      capabilities: [],
      proofs: [],
      errors: ['Capability Proof Map must contain a capability table followed by a proof table.']
    };
  }

  const capabilityRows = tableRowsToObjects(tables[0]).map((row) => ({
    capabilityId: row.capabilityid ?? '',
    mustLandIds: splitCommaList(row.mustlandids ?? ''),
    claim: row.claim ?? '',
    requiredStrength: (row.requiredstrength ?? '').trim().toLowerCase()
  }));
  const proofRows = tableRowsToObjects(tables[1]).map((row) => ({
    proofId: row.proofid ?? '',
    capabilityId: row.capabilityid ?? '',
    type: (row.type ?? '').trim().toLowerCase(),
    lane: (row.lane ?? '').trim().toLowerCase(),
    validationRef: row.validationidartifact ?? '',
    freshness: (row.freshness ?? '').trim().toLowerCase()
  }));

  const errors = [];
  const capabilityHeaders = new Set((tables[0]?.headers ?? []).map((header) => normalizeProofHeader(header)));
  const proofHeaders = new Set((tables[1]?.headers ?? []).map((header) => normalizeProofHeader(header)));
  for (const header of ['capabilityid', 'mustlandids', 'claim', 'requiredstrength']) {
    if (!capabilityHeaders.has(header)) {
      errors.push(`Capability Proof Map capability table is missing '${header}'.`);
    }
  }
  for (const header of ['proofid', 'capabilityid', 'type', 'lane', 'validationidartifact', 'freshness']) {
    if (!proofHeaders.has(header)) {
      errors.push(`Capability Proof Map proof table is missing '${header}'.`);
    }
  }

  return {
    capabilities: capabilityRows,
    proofs: proofRows,
    errors
  };
}

function compareMetadataKeys(a, b) {
  const order = [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Execution-Scope',
    'Parent-Plan-ID',
    'Dependencies',
    'Autonomy-Allowed',
    'Risk-Tier',
    'Security-Approval',
    'Spec-Targets',
    'Implementation-Targets',
    'Done-Evidence'
  ];
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);

  if (aIndex === -1 && bIndex === -1) {
    return a.localeCompare(b);
  }
  if (aIndex === -1) {
    return 1;
  }
  if (bIndex === -1) {
    return -1;
  }
  return aIndex - bIndex;
}

export async function listMarkdownFiles(dirPath, excludeFiles = ['README.md', '.gitkeep']) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const excluded = new Set(excludeFiles);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !excluded.has(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function parseMetadata(content) {
  const metadata = new Map();
  const range = metadataSectionRange(content);
  if (!range) {
    return metadata;
  }

  for (const rawLine of range.lines.slice(range.start + 1, range.end)) {
    const line = rawLine.trimEnd();

    const bullet = line.match(/^\s*-\s*([A-Za-z][A-Za-z0-9- ]+):\s*(.*)$/);
    if (bullet) {
      const key = bullet[1].trim();
      if (!metadata.has(normalizeKey(key))) {
        metadata.set(normalizeKey(key), {
          key,
          value: bullet[2].trim()
        });
      }
      continue;
    }

    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9- ]+):\s*(.*)$/);
    if (topLevel) {
      const key = topLevel[1].trim();
      if (!metadata.has(normalizeKey(key))) {
        metadata.set(normalizeKey(key), {
          key,
          value: topLevel[2].trim()
        });
      }
    }
  }

  return metadata;
}

export function metadataValue(metadataMap, fieldName) {
  return metadataMap.get(normalizeKey(fieldName))?.value ?? null;
}

export function parseListField(rawValue) {
  if (!rawValue) {
    return [];
  }

  const normalized = rawValue.trim();
  if (!normalized || normalized.toLowerCase() === 'none' || normalized.toLowerCase() === 'n/a') {
    return [];
  }

  return normalized
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function firstHeading(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function inferPlanId(content, filePath) {
  const metadata = parseMetadata(content);
  const explicit = metadataValue(metadata, 'Plan-ID');
  if (explicit) {
    return parsePlanId(explicit, null);
  }

  const heading = firstHeading(content);
  if (heading) {
    return parsePlanId(slugify(heading), null);
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  return parsePlanId(slugify(baseName), null);
}

export function ensureMetadataSection(content, metadataFields) {
  const keys = Object.keys(metadataFields).sort(compareMetadataKeys);
  const sectionLines = ['## Metadata', ''];
  for (const key of keys) {
    const value = String(metadataFields[key] ?? '').trim();
    sectionLines.push(`- ${key}: ${value}`);
  }
  sectionLines.push('');
  const section = `${sectionLines.join('\n')}\n`;

  const range = metadataSectionRange(content);
  if (range) {
    const updatedLines = [
      ...range.lines.slice(0, range.start),
      ...sectionLines,
      ...range.lines.slice(range.end)
    ];
    return `${updatedLines.join('\n').trimEnd()}\n`;
  }

  const headingMatch = content.match(/^#\s+.+$/m);
  if (!headingMatch || headingMatch.index == null) {
    return `${section}\n${content}`.trimEnd() + '\n';
  }

  const insertIndex = content.indexOf('\n', headingMatch.index);
  if (insertIndex === -1) {
    return `${content}\n\n${section}`.trimEnd() + '\n';
  }

  const before = content.slice(0, insertIndex + 1);
  const after = content.slice(insertIndex + 1).replace(/^\n*/, '\n');
  return `${before}\n${section}${after}`.trimEnd() + '\n';
}

export function setMetadataFields(content, updates) {
  const current = parseMetadata(content);
  const merged = {};

  for (const entry of current.values()) {
    merged[entry.key] = entry.value;
  }

  for (const [key, value] of Object.entries(updates)) {
    merged[key] = String(value ?? '').trim();
  }

  return ensureMetadataSection(content, merged);
}

export function normalizeStatus(value) {
  return (value ?? '').trim().toLowerCase();
}

export function parsePriority(value) {
  const raw = (value ?? 'p2').trim().toLowerCase();
  if (raw === 'high') return 'p1';
  if (raw === 'medium') return 'p2';
  if (raw === 'low') return 'p3';
  if (raw === 'p0' || raw === 'p1' || raw === 'p2' || raw === 'p3') return raw;
  return 'p2';
}

export function parseRiskTier(value, fallback = 'low') {
  const raw = (value ?? '').trim().toLowerCase();
  if (RISK_TIERS.has(raw)) {
    return raw;
  }
  return fallback;
}

export function parseSecurityApproval(value, fallback = 'not-required') {
  const raw = (value ?? '').trim().toLowerCase();
  if (SECURITY_APPROVAL_VALUES.has(raw)) {
    return raw;
  }
  return fallback;
}

export function parseDeliveryClass(value, fallback = '') {
  const raw = (value ?? '').trim().toLowerCase();
  if (DELIVERY_CLASSES.has(raw)) {
    return raw;
  }
  return fallback;
}

export function parseExecutionScope(value, fallback = '') {
  const raw = (value ?? '').trim().toLowerCase();
  if (EXECUTION_SCOPES.has(raw)) {
    return raw;
  }
  return fallback;
}

export function priorityOrder(value) {
  const priority = parsePriority(value);
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  return order[priority] ?? 2;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
