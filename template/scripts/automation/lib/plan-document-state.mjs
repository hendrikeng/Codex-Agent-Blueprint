import fs from 'node:fs/promises';

import {
  metadataValue,
  normalizeStatus,
  parseMetadata,
  setMetadataFields
} from './plan-metadata.mjs';
import { escapeRegex, resolveSafeRepoPath } from './orchestrator-shared.mjs';

export const MUST_LAND_SECTION = 'Must-Land Checklist';

export function sectionBounds(content, sectionTitle) {
  const headingRegex = new RegExp(`^##\\s+${escapeRegex(sectionTitle)}\\s*$`, 'm');
  const match = headingRegex.exec(String(content ?? ''));
  if (!match || match.index == null) {
    return null;
  }

  const start = match.index;
  const headingEnd = String(content).indexOf('\n', start);
  const bodyStart = headingEnd === -1 ? String(content).length : headingEnd + 1;
  const remaining = String(content).slice(bodyStart);
  const nextHeading = /^##\s+/m.exec(remaining);
  const end = nextHeading ? bodyStart + nextHeading.index : String(content).length;
  return { start, bodyStart, end };
}

export function sectionBody(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return '';
  }
  return String(content).slice(bounds.bodyStart, bounds.end).trim();
}

export function upsertSection(content, sectionTitle, bodyLines) {
  const body = Array.isArray(bodyLines) ? bodyLines.join('\n') : String(bodyLines ?? '');
  const rendered = `## ${sectionTitle}\n\n${body.trim()}\n`;
  const bounds = sectionBounds(content, sectionTitle);

  if (!bounds) {
    return `${String(content ?? '').trimEnd()}\n\n${rendered}\n`;
  }

  const before = String(content).slice(0, bounds.start).trimEnd();
  const after = String(content).slice(bounds.end).trimStart();
  if (!after) {
    return `${before}\n\n${rendered}\n`;
  }
  return `${before}\n\n${rendered}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

export function removeSection(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return String(content ?? '');
  }

  const before = String(content).slice(0, bounds.start).trimEnd();
  const after = String(content).slice(bounds.end).trimStart();
  if (!before) {
    return after ? `${after}\n` : '';
  }
  if (!after) {
    return `${before}\n`;
  }
  return `${before}\n\n${after}`.replace(/\n{3,}/g, '\n\n');
}

export function appendToDeliveryLog(content, entryLine) {
  const sectionTitle = 'Automated Delivery Log';
  const body = sectionBody(content, sectionTitle);
  const lines = body ? body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  lines.push(`- ${entryLine}`);
  return upsertSection(content, sectionTitle, lines);
}

export function updateSimpleMetadataField(content, field, value) {
  const regex = new RegExp(`^${escapeRegex(field)}:\\s*.*$`, 'm');
  if (regex.test(String(content ?? ''))) {
    return String(content).replace(regex, `${field}: ${value}`);
  }
  return `${String(content ?? '').trimEnd()}\n${field}: ${value}\n`;
}

function removeSimpleTopLevelField(content, field) {
  return String(content ?? '')
    .replace(new RegExp(`^${escapeRegex(field)}:\\s*.*(?:\\r?\\n)?`, 'm'), '')
    .replace(/\n{3,}/g, '\n\n');
}

export function setPlanDocumentFields(content, fields = {}) {
  let updated = setMetadataFields(content, fields);
  if (Object.prototype.hasOwnProperty.call(fields, 'Status')) {
    updated = removeSimpleTopLevelField(updated, 'Status');
  }
  return updated;
}

export function documentStatusValue(content) {
  const metadata = parseMetadata(content);
  const metadataStatus = normalizeStatus(metadataValue(metadata, 'Status'));
  if (metadataStatus) {
    return metadataStatus;
  }
  const match = String(content ?? '').match(/^Status:\s*(.+)$/m);
  return normalizeStatus(match?.[1] ?? '');
}

export function setPlanStatusInContent(content, status) {
  return setPlanDocumentFields(content, { Status: status });
}

export async function setPlanStatus(planPath, status, dryRun = false) {
  const resolved = resolveSafeRepoPath(process.cwd(), planPath, 'Plan path');
  const current = await fs.readFile(resolved.abs, 'utf8');
  const updated = setPlanStatusInContent(current, status);
  if (!dryRun) {
    await fs.writeFile(resolved.abs, updated, 'utf8');
  }
  return updated;
}
