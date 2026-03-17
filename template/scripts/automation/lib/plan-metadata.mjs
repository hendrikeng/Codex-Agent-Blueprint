import fs from 'node:fs/promises';
import path from 'node:path';

export const FUTURE_STATUSES = new Set(['draft', 'ready-for-promotion']);
export const ACTIVE_STATUSES = new Set(['queued', 'in-progress', 'in-review', 'budget-exhausted', 'blocked', 'validation']);
export const COMPLETED_STATUSES = new Set(['completed']);
export const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
export const RISK_TIERS = new Set(['low', 'medium', 'high']);
export const SECURITY_APPROVAL_VALUES = new Set(['not-required', 'pending', 'approved']);
export const DELIVERY_CLASSES = new Set(['product', 'docs', 'ops', 'reconciliation']);
export const VALIDATION_LANES = new Set(['always', 'host-required']);
export const LEGACY_METADATA_FIELDS = new Set([
  'Authoring-Intent',
  'Autonomy-Allowed',
  'Execution-Scope',
  'Parent-Plan-ID',
  'Validation-Ready'
]);
export const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const REQUIRED_METADATA_FIELDS = {
  future: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Dependencies',
    'Spec-Targets',
    'Implementation-Targets',
    'Risk-Tier',
    'Validation-Lanes',
    'Security-Approval',
    'Done-Evidence'
  ],
  active: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Dependencies',
    'Spec-Targets',
    'Implementation-Targets',
    'Risk-Tier',
    'Validation-Lanes',
    'Security-Approval',
    'Done-Evidence'
  ],
  completed: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Delivery-Class',
    'Dependencies',
    'Spec-Targets',
    'Implementation-Targets',
    'Risk-Tier',
    'Validation-Lanes',
    'Security-Approval',
    'Done-Evidence'
  ]
};

function normalizeKey(key) {
  return String(key ?? '').trim().toLowerCase();
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
  return isValidPlanId(normalized) ? normalized : fallback;
}

function parseMetadataSectionRange(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+Metadata\s*$/i.test(lines[index])) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) {
      end = index;
      break;
    }
  }

  return { lines, start, end };
}

export function parseMetadata(content) {
  const range = parseMetadataSectionRange(content);
  const fields = new Map();
  if (!range) {
    return fields;
  }

  for (const line of range.lines.slice(range.start + 1, range.end)) {
    const match = line.match(/^\s*-\s*([A-Za-z][A-Za-z0-9- ]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim();
    const normalizedKey = normalizeKey(key);
    if (fields.has(normalizedKey)) {
      continue;
    }
    fields.set(normalizedKey, {
      key,
      value: match[2].trim()
    });
  }

  return fields;
}

export function metadataValue(metadata, key, fallback = '') {
  if (!(metadata instanceof Map)) {
    return fallback;
  }
  const entry = metadata.get(normalizeKey(key));
  return entry ? entry.value : fallback;
}

function metadataKeysInOrder(content) {
  const range = parseMetadataSectionRange(content);
  if (!range) {
    return [];
  }
  const keys = [];
  for (const line of range.lines.slice(range.start + 1, range.end)) {
    const match = line.match(/^\s*-\s*([A-Za-z][A-Za-z0-9- ]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    keys.push(match[1].trim());
  }
  return keys;
}

export function setMetadataFields(content, fields = {}) {
  const metadata = parseMetadata(content);
  const orderedKeys = metadataKeysInOrder(content);
  const nextEntries = new Map();

  for (const key of orderedKeys) {
    nextEntries.set(key, metadataValue(metadata, key));
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) {
      continue;
    }
    if (!nextEntries.has(key)) {
      orderedKeys.push(key);
    }
    nextEntries.set(key, String(value));
  }

  const renderedSection = [
    '## Metadata',
    '',
    ...orderedKeys.map((key) => `- ${key}: ${nextEntries.get(key)}`),
    ''
  ].join('\n');

  const range = parseMetadataSectionRange(content);
  if (!range) {
    const trimmed = String(content ?? '').trimEnd();
    return trimmed ? `${trimmed}\n\n${renderedSection}\n` : `${renderedSection}\n`;
  }

  const before = range.lines.slice(0, range.start).join('\n').trimEnd();
  const after = range.lines.slice(range.end).join('\n').trimStart();
  if (!before && !after) {
    return `${renderedSection}\n`;
  }
  if (!after) {
    return `${before}\n\n${renderedSection}\n`;
  }
  if (!before) {
    return `${renderedSection}\n${after}\n`;
  }
  return `${before}\n\n${renderedSection}\n${after}\n`.replace(/\n{3,}/g, '\n\n');
}

export function sectionBounds(content, sectionTitle) {
  const escaped = String(sectionTitle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^##\\s+${escaped}\\s*$`, 'm');
  const match = regex.exec(String(content ?? ''));
  if (!match || match.index == null) {
    return null;
  }

  const start = match.index;
  const bodyStart = start + match[0].length;
  const remainder = String(content).slice(bodyStart);
  const nextSectionMatch = /^##\s+/m.exec(remainder);
  const end = nextSectionMatch && nextSectionMatch.index != null
    ? bodyStart + nextSectionMatch.index
    : String(content).length;
  return { start, bodyStart, end };
}

export function sectionBody(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return '';
  }
  return String(content).slice(bounds.bodyStart, bounds.end).trim();
}

export function parseListField(rawValue) {
  const normalized = String(rawValue ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'none' || normalized.toLowerCase() === 'pending') {
    return [];
  }
  return [...new Set(
    normalized
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  )];
}

export function parsePriority(value, fallback = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return PRIORITIES.has(normalized) ? normalized : fallback;
}

export function parseDeliveryClass(value, fallback = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return DELIVERY_CLASSES.has(normalized) ? normalized : fallback;
}

export function parseRiskTier(value, fallback = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return RISK_TIERS.has(normalized) ? normalized : fallback;
}

export function parseSecurityApproval(value, fallback = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SECURITY_APPROVAL_VALUES.has(normalized) ? normalized : fallback;
}

export function parseValidationLanes(rawValue, fallback = []) {
  const normalized = parseListField(rawValue)
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => VALIDATION_LANES.has(entry));
  if (normalized.length === 0) {
    return fallback;
  }
  return [...new Set(normalized)];
}

export function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function parseMustLandChecklist(content) {
  const body = sectionBody(content, 'Must-Land Checklist');
  if (!body) {
    return [];
  }

  return body
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
      if (!match) {
        return null;
      }
      const checked = String(match[1]).toLowerCase() === 'x';
      const rawText = String(match[2] ?? '').trim();
      const idMatch = rawText.match(/^`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+(.*)$/);
      return {
        checked,
        text: idMatch ? idMatch[2].trim() : rawText,
        rawText,
        id: idMatch ? idMatch[1] : null
      };
    })
    .filter(Boolean);
}

export function inferPlanId(content, filePath) {
  const metadata = parseMetadata(content);
  const explicit = parsePlanId(metadataValue(metadata, 'Plan-ID'), null);
  if (explicit) {
    return explicit;
  }
  const stem = path.basename(String(filePath ?? ''), path.extname(String(filePath ?? '')));
  return parsePlanId(stem.replace(/^\d{4}-\d{2}-\d{2}-/, ''), null);
}

export async function listMarkdownFiles(directoryPath) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listMarkdownFiles(fullPath));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
