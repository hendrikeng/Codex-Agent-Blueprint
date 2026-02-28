import fs from 'node:fs/promises';
import path from 'node:path';

export const FUTURE_STATUSES = new Set(['draft', 'ready-for-promotion']);
export const ACTIVE_STATUSES = new Set(['queued', 'in-progress', 'blocked', 'validation', 'completed', 'failed']);
export const COMPLETED_STATUSES = new Set(['completed']);

export const REQUIRED_METADATA_FIELDS = {
  future: [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
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
    'Dependencies',
    'Spec-Targets',
    'Done-Evidence'
  ]
};

function normalizeKey(key) {
  return key.trim().toLowerCase();
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

function compareMetadataKeys(a, b) {
  const order = [
    'Plan-ID',
    'Status',
    'Priority',
    'Owner',
    'Acceptance-Criteria',
    'Dependencies',
    'Autonomy-Allowed',
    'Risk-Tier',
    'Spec-Targets',
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
    return explicit;
  }

  const heading = firstHeading(content);
  if (heading) {
    return slugify(heading);
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  return slugify(baseName);
}

export function ensureMetadataSection(content, metadataFields) {
  const keys = Object.keys(metadataFields).sort(compareMetadataKeys);
  const sectionLines = ['## Metadata', ''];
  for (const key of keys) {
    const value = String(metadataFields[key] ?? '').trim();
    sectionLines.push(`- ${key}: ${value}`);
  }
  sectionLines.push('');

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

export function priorityOrder(value) {
  const priority = parsePriority(value);
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  return order[priority] ?? 2;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
