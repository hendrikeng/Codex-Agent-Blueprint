import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SAFE_PLAN_RELATIVE_PATH_REGEX = /^[A-Za-z0-9._/-]+$/;

export function asBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

export function asInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asRatio(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

export function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

export function nowIso() {
  return new Date().toISOString();
}

export function isoDate(value) {
  return String(value ?? '').slice(0, 10);
}

export function durationSeconds(startIso, endIso = nowIso()) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds == null) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0 && remainingSeconds === 0) {
    return `${hours}h`;
  }
  if (remainingSeconds === 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function trimmedString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function stringList(value, maxItems = 8) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => trimmedString(entry)).filter(Boolean))].slice(0, Math.max(0, maxItems));
}

export function renderSummaryBullet(label, values) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
  return `- ${label}: ${items.length > 0 ? items.join(' ; ') : 'none'}`;
}

export function normalizedRelativePrefix(value) {
  const normalized = toPosix(String(value ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
  return normalized || '';
}

export function normalizeRelativePrefixList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((entry) => normalizedRelativePrefix(entry))
      .filter(Boolean)
  )];
}

export function assertSafeRelativePlanPath(relPath) {
  const normalized = toPosix(String(relPath ?? '').trim()).replace(/^\.?\//, '');
  if (!normalized || !SAFE_PLAN_RELATIVE_PATH_REGEX.test(normalized)) {
    throw new Error(`Unsafe repository path '${relPath}'.`);
  }
  if (normalized.includes('../')) {
    throw new Error(`Repository path '${relPath}' escapes repository root.`);
  }
  return normalized;
}

export function isWithinRoot(rootDir, absPath) {
  const relative = path.relative(rootDir, absPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveSafeRepoPath(rootDir, relPath, label = 'Repository path') {
  const normalized = assertSafeRelativePlanPath(relPath);
  const abs = path.resolve(rootDir, normalized);
  if (!isWithinRoot(rootDir, abs)) {
    throw new Error(`${label} escapes repository root: '${normalized}'.`);
  }
  return {
    rel: toPosix(path.relative(rootDir, abs)),
    abs
  };
}

export function resolveRepoOrAbsolutePath(rootDir, filePath) {
  const rendered = String(filePath ?? '').trim();
  if (!rendered) {
    return null;
  }
  const abs = path.resolve(rootDir, rendered);
  return {
    abs,
    rel: isWithinRoot(rootDir, abs) ? toPosix(path.relative(rootDir, abs)) : null
  };
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, payload, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function appendJsonLine(filePath, payload, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export function timeoutMsFromSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.floor(seconds * 1000);
}

export function runShell(command, cwd, env = process.env, timeoutMs = undefined, stdioMode = 'inherit') {
  const capture = stdioMode === 'pipe';
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    timeout: timeoutMs,
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: capture ? 1024 * 1024 * 25 : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
}

export function runShellCapture(command, cwd, env = process.env, timeoutMs = undefined) {
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function didTimeout(result) {
  return result?.error?.code === 'ETIMEDOUT';
}

export function didFirstTouchDeadlineTimeout(result) {
  return result?.error?.code === 'ENO_TOUCH_DEADLINE';
}

export function didWorkerStallTimeout(result) {
  return result?.error?.code === 'EWORKER_STALL';
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export async function snapshotFileState(filePath) {
  try {
    return {
      exists: true,
      content: await fs.readFile(filePath, 'utf8')
    };
  } catch {
    return { exists: false, content: null };
  }
}

export async function restoreFileState(filePath, snapshot) {
  if (!snapshot?.exists) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, snapshot.content ?? '', 'utf8');
}
