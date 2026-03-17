#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  ACTIVE_STATUSES,
  COMPLETED_STATUSES,
  FUTURE_STATUSES,
  inferPlanId,
  listMarkdownFiles,
  metadataValue,
  parseDeliveryClass,
  parseListField,
  parseMetadata,
  parseMustLandChecklist,
  parsePriority,
  parseRiskTier,
  parseSecurityApproval,
  parseValidationLanes
} from './lib/plan-metadata.mjs';
import {
  appendToDeliveryLog,
  sectionBody,
  setPlanDocumentFields,
  upsertSection
} from './lib/plan-document-state.mjs';
import {
  appendJsonLine,
  asBoolean,
  asInteger,
  formatDuration,
  nowIso,
  resolveRepoOrAbsolutePath,
  runShellCapture,
  toPosix,
  trimmedString,
  writeJson,
  writeTextFileAtomic
} from './lib/orchestrator-shared.mjs';
import { resolveExecutorPromptTemplate } from './lib/executor-policy.mjs';

const ROLE_WORKER = 'worker';
const ROLE_REVIEWER = 'reviewer';
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
const DEFAULT_MAX_RISK = 'low';
const DEFAULT_MAX_PLANS = 0;
const DEFAULT_MAX_SESSIONS_PER_PLAN = 6;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_OUTPUT = 'pretty';
const DEFAULT_HEARTBEAT_SECONDS = 12;
const DEFAULT_STALL_WARN_SECONDS = 120;
const DEFAULT_FAILURE_TAIL_LINES = 60;
const DEFAULT_CONTEXT_THRESHOLD_TOKENS = 12000;
const DEFAULT_CONTEXT_THRESHOLD_PERCENT = 0.15;
const PRETTY_SPINNER_FRAMES = ['|', '/', '-', '\\'];
const PRETTY_LIVE_DOT_FRAMES = ['...', '.. ', '.  ', ' ..'];
const FUTURE_DIR = path.join('docs', 'future');
const ACTIVE_DIR = path.join('docs', 'exec-plans', 'active');
const ACTIVE_EVIDENCE_DIR = path.join(ACTIVE_DIR, 'evidence');
const COMPLETED_DIR = path.join('docs', 'exec-plans', 'completed');
const EVIDENCE_INDEX_DIR = path.join('docs', 'exec-plans', 'evidence-index');
const OPS_DIR = path.join('docs', 'ops', 'automation');
const RUN_STATE_PATH = path.join(OPS_DIR, 'run-state.json');
const RUN_EVENTS_PATH = path.join(OPS_DIR, 'run-events.jsonl');
const TRANSIENT_AUTOMATION_FILES = new Set([RUN_STATE_PATH, RUN_EVENTS_PATH]);
const TRANSIENT_AUTOMATION_DIR_PREFIXES = [
  `${toPosix(path.join(OPS_DIR, 'runtime'))}/`,
  `${toPosix(path.join(OPS_DIR, 'handoffs'))}/`
];
let prettySpinnerIndex = 0;
let prettyLiveDotIndex = 0;
let liveStatusLineLength = 0;

function parseArgs(argv) {
  const [command = 'run', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command: String(command).trim().toLowerCase(), options };
}

function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function renderShellEscaped(template, values) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (match, rawKey) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) {
      return match;
    }
    return shellEscape(values[key]);
  });
}

function normalizeMaxRisk(value, fallback = DEFAULT_MAX_RISK) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RISK_ORDER, normalized) ? normalized : fallback;
}

function planPriorityWeight(priority) {
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  return Object.prototype.hasOwnProperty.call(order, priority) ? order[priority] : 99;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadConfig(rootDir) {
  const filePath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function executorTimeoutMs(config) {
  return Math.max(
    1,
    asInteger(config?.executor?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS)
  ) * 1000;
}

function maxSessionsPerPlan(config, options) {
  return Math.max(
    1,
    asInteger(options['max-sessions-per-plan'] ?? options.maxSessionsPerPlan, asInteger(config?.executor?.maxSessionsPerPlan, DEFAULT_MAX_SESSIONS_PER_PLAN))
  );
}

function asFiniteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function contextBudgetPolicy(config) {
  const source = config?.executor?.contextBudget ?? {};
  const minRemaining = asFiniteNumber(source.minRemaining, DEFAULT_CONTEXT_THRESHOLD_TOKENS);
  const minRemainingPercent = asFiniteNumber(source.minRemainingPercent, DEFAULT_CONTEXT_THRESHOLD_PERCENT);
  return {
    minRemaining: minRemaining >= 0 ? minRemaining : DEFAULT_CONTEXT_THRESHOLD_TOKENS,
    minRemainingPercent: minRemainingPercent >= 0 && minRemainingPercent <= 1
      ? minRemainingPercent
      : DEFAULT_CONTEXT_THRESHOLD_PERCENT
  };
}

function contextThresholdPercentLabel(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.round(value * 100)}%`;
}

function outputMode(options, config = null) {
  const normalized = String(options.output ?? config?.logging?.output ?? DEFAULT_OUTPUT).trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'ticker' || normalized === 'pretty' || normalized === 'verbose') {
    return normalized;
  }
  return DEFAULT_OUTPUT;
}

function heartbeatSeconds(config, options) {
  return Math.max(3, asInteger(options['heartbeat-seconds'] ?? options.heartbeatSeconds, asInteger(config?.logging?.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS)));
}

function stallWarnSeconds(config, options, heartbeat) {
  return Math.max(heartbeat, asInteger(options['stall-warn-seconds'] ?? options.stallWarnSeconds, asInteger(config?.logging?.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS)));
}

function failureTailLines(config, options) {
  return Math.max(10, asInteger(options['failure-tail-lines'] ?? options.failureTailLines, asInteger(config?.logging?.failureTailLines, DEFAULT_FAILURE_TAIL_LINES)));
}

function resolveLogging(config, options) {
  const heartbeat = heartbeatSeconds(config, options);
  return {
    mode: outputMode(options, config),
    heartbeatSeconds: heartbeat,
    stallWarnSeconds: stallWarnSeconds(config, options, heartbeat),
    failureTailLines: failureTailLines(config, options)
  };
}

function canUseColor(logging) {
  if (logging.mode !== 'pretty') {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  if (String(process.env.NO_COLOR ?? '').trim() !== '') {
    return false;
  }
  return String(process.env.TERM ?? '').trim().toLowerCase() !== 'dumb';
}

function colorize(logging, code, text) {
  if (!canUseColor(logging)) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

function nextPrettySpinner(logging) {
  if (!process.stdout.isTTY) {
    return '.';
  }
  const frame = PRETTY_SPINNER_FRAMES[prettySpinnerIndex % PRETTY_SPINNER_FRAMES.length];
  prettySpinnerIndex += 1;
  return colorize(logging, '36', frame);
}

function nextPrettyLiveDots(logging) {
  if (!process.stdout.isTTY) {
    return '...';
  }
  const frame = PRETTY_LIVE_DOT_FRAMES[prettyLiveDotIndex % PRETTY_LIVE_DOT_FRAMES.length];
  prettyLiveDotIndex += 1;
  return colorize(logging, '36', frame);
}

function prettyLevelTag(logging, level = 'run') {
  if (level === 'ok') {
    return colorize(logging, '32', 'OK  ');
  }
  if (level === 'warn') {
    return colorize(logging, '33', 'WARN');
  }
  if (level === 'err' || level === 'error') {
    return colorize(logging, '31', 'ERR ');
  }
  return colorize(logging, '36', 'RUN ');
}

function supportsLiveStatusLine(logging) {
  return logging.mode === 'pretty' && process.stdout.isTTY;
}

function stripAnsiControl(value) {
  return String(value ?? '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function visibleTextLength(value) {
  return stripAnsiControl(value).length;
}

function wrapTextForConsole(text, maxWidth) {
  const rendered = String(text ?? '').trim();
  if (!rendered) {
    return [''];
  }
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return [rendered];
  }

  const words = rendered.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  const splitLongToken = (token) => {
    let remaining = token;
    while (remaining.length > maxWidth) {
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    return remaining;
  };

  for (const word of words) {
    if (!current) {
      current = word.length <= maxWidth ? word : splitLongToken(word);
      continue;
    }
    if (current.length + 1 + word.length <= maxWidth) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word.length <= maxWidth ? word : splitLongToken(word);
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [rendered];
}

function printIndentedPrettyMessage(prefix, message) {
  const renderedPrefix = String(prefix ?? '');
  const renderedMessage = String(message ?? '').trim();
  if (!renderedMessage) {
    console.log(renderedPrefix.trimEnd());
    return;
  }

  const visiblePrefixLength = visibleTextLength(renderedPrefix);
  const consoleWidth =
    process.stdout.isTTY && Number.isFinite(process.stdout.columns) ? Number(process.stdout.columns) : 0;
  const maxWidth = consoleWidth > visiblePrefixLength + 12 ? consoleWidth - visiblePrefixLength : 0;
  const visibleMessage = stripAnsiControl(renderedMessage);
  if (!Number.isFinite(maxWidth) || maxWidth <= 0 || visibleMessage.length <= maxWidth) {
    console.log(`${renderedPrefix}${renderedMessage}`);
    return;
  }
  const lines = wrapTextForConsole(visibleMessage, maxWidth);

  console.log(`${renderedPrefix}${lines[0] ?? ''}`);
  if (lines.length <= 1) {
    return;
  }

  const continuationPrefix = ' '.repeat(Math.max(0, visiblePrefixLength));
  for (const line of lines.slice(1)) {
    console.log(`${continuationPrefix}${line}`);
  }
}

function parseStructuredLogMessage(message) {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { headline: '', details: [] };
  }
  if (normalized.includes(' | ')) {
    return { headline: normalized, details: [] };
  }
  const firstDetailIndex = normalized.search(/\b[A-Za-z][A-Za-z0-9_-]*=[^\s]+/);
  if (firstDetailIndex < 0) {
    return { headline: normalized, details: [] };
  }
  const headline = normalized.slice(0, firstDetailIndex).trim();
  const detailText = normalized.slice(firstDetailIndex).trim();
  const details = [];
  const keyTokenPattern = /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/;
  let currentKey = null;
  let currentValue = '';
  for (const token of detailText.split(/\s+/)) {
    const keyMatch = token.match(keyTokenPattern);
    if (keyMatch) {
      if (currentKey && currentValue.trim()) {
        details.push({ key: currentKey, value: currentValue.trim() });
      }
      currentKey = keyMatch[1];
      currentValue = keyMatch[2] ?? '';
      continue;
    }
    if (!currentKey) {
      continue;
    }
    currentValue = currentValue ? `${currentValue} ${token}` : token;
  }
  if (currentKey && currentValue.trim()) {
    details.push({ key: currentKey, value: currentValue.trim() });
  }
  if (details.length === 0) {
    return { headline: normalized, details: [] };
  }
  return { headline: headline || normalized, details };
}

function prettyColorLevel(level) {
  if (level === 'err' || level === 'error') {
    return 'error';
  }
  if (level === 'warn') {
    return 'warn';
  }
  if (level === 'ok') {
    return 'ok';
  }
  return 'run';
}

function colorizeStructuredHeadline(logging, headline, level = 'run') {
  const value = String(headline ?? '').trim();
  const lower = value.toLowerCase();
  if (!value) {
    return value;
  }
  if (lower.startsWith('heartbeat') || lower.startsWith('file activity')) {
    return colorize(logging, '32', value);
  }
  if (lower.startsWith('queue ') || lower.startsWith('plan start') || lower.startsWith('session start')) {
    return colorize(logging, '36', value);
  }
  if (
    lower.startsWith('session end') ||
    lower.startsWith('session artifacts') ||
    lower.startsWith('plan continuation') ||
    lower.startsWith('role transition') ||
    lower.startsWith('working')
  ) {
    return colorize(logging, '37', value);
  }
  if (lower.startsWith('run resumed') || lower.startsWith('run start') || lower.startsWith('grind ') || lower.startsWith('run ')) {
    return colorize(logging, '36', value);
  }
  if (level === 'warn') {
    return colorize(logging, '33', value);
  }
  if (level === 'error') {
    return colorize(logging, '31', value);
  }
  if (level === 'ok') {
    return colorize(logging, '32', value);
  }
  return value;
}

function colorizeStructuredValue(logging, key, value, level = 'run') {
  const keyLower = String(key ?? '').trim().toLowerCase();
  const valueText = String(value ?? '').trim();
  const valueLower = valueText.toLowerCase();
  if (!valueText) {
    return valueText;
  }

  if (keyLower === 'runid') return colorize(logging, '96', valueText);
  if (keyLower === 'plan') return colorize(logging, '36', valueText);
  if (keyLower === 'role') return colorize(logging, '35', valueText);
  if (keyLower === 'nextrole' || keyLower === 'roles') return colorize(logging, '36', valueText);
  if (keyLower === 'phase' || keyLower === 'activity') return colorize(logging, '32', valueText);
  if (keyLower === 'elapsed' || keyLower === 'idle') return colorize(logging, '32', valueText);
  if (keyLower === 'model') return colorize(logging, '96', valueText);
  if (keyLower === 'reasoning' || keyLower === 'priority') return colorize(logging, '35', valueText);
  if (keyLower === 'checkpoint' || keyLower === 'handoff' || keyLower === 'log') return colorize(logging, '90', valueText);
  if (keyLower === 'message' || keyLower === 'reason' || keyLower === 'summary' || keyLower === 'nextaction') {
    return colorize(logging, '37', valueText);
  }

  if (['risk', 'status', 'commit'].includes(keyLower)) {
    if (valueLower === 'low' || valueLower === 'completed' || valueLower === 'passed' || valueLower === 'atomic') {
      return colorize(logging, '32', valueText);
    }
    if (valueLower === 'medium' || valueLower === 'pending' || valueLower === 'blocked' || valueLower === 'off') {
      return colorize(logging, '33', valueText);
    }
    if (valueLower === 'high' || valueLower === 'failed' || valueLower === 'error') {
      return colorize(logging, '31', valueText);
    }
  }

  if (level === 'warn') return colorize(logging, '33', valueText);
  if (level === 'error') return colorize(logging, '31', valueText);
  return colorize(logging, '37', valueText);
}

function printPrettyRunMessage(logging, prefix, message, level = 'run') {
  const parsed = parseStructuredLogMessage(message);
  if (parsed.details.length === 0) {
    const headlineText = String(parsed.headline ?? '').trim();
    if (!headlineText) {
      printIndentedPrettyMessage(prefix, message);
      return;
    }
    printIndentedPrettyMessage(prefix, colorizeStructuredHeadline(logging, headlineText, level));
    return;
  }

  const headlineText = String(parsed.headline ?? '').trim();
  printIndentedPrettyMessage(prefix, colorizeStructuredHeadline(logging, headlineText, level));
  const continuationPrefix = ' '.repeat(Math.max(0, visibleTextLength(prefix)));
  const keyWidth = 16;
  for (const entry of parsed.details) {
    const keyLabel = colorize(logging, '90', `${entry.key.padEnd(keyWidth, ' ')}`);
    const separator = colorize(logging, '90', ' = ');
    const valueLabel = colorizeStructuredValue(logging, entry.key, entry.value, level);
    printIndentedPrettyMessage(`${continuationPrefix}${keyLabel}${separator}`, valueLabel);
  }
}

function clearLiveStatusLine() {
  if (!process.stdout.isTTY) {
    return;
  }
  if (typeof process.stdout.clearLine === 'function' && typeof process.stdout.cursorTo === 'function') {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    liveStatusLineLength = 0;
    return;
  }
  if (liveStatusLineLength <= 0) {
    return;
  }
  process.stdout.write(`\r${' '.repeat(liveStatusLineLength)}\r`);
  liveStatusLineLength = 0;
}

function renderLiveStatusLine(logging, message) {
  if (!supportsLiveStatusLine(logging)) {
    return;
  }
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return;
  }

  const width = Number.isFinite(process.stdout.columns) ? Number(process.stdout.columns) : 0;
  const visible = stripAnsiControl(normalized);
  let rendered = normalized;
  let visibleLength = visible.length;
  if (width > 3 && visibleLength >= width) {
    const clipped = visible.slice(0, Math.max(1, width - 2)).trimEnd();
    rendered = `${clipped}…`;
    visibleLength = stripAnsiControl(rendered).length;
  }

  if (typeof process.stdout.clearLine === 'function' && typeof process.stdout.cursorTo === 'function') {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(rendered);
    liveStatusLineLength = visibleLength;
    return;
  }

  const padded = rendered.padEnd(Math.max(liveStatusLineLength, visibleLength), ' ');
  process.stdout.write(`\r${padded}`);
  liveStatusLineLength = Math.max(visibleLength, stripAnsiControl(padded).length);
}

function logLine(logging, message, level = 'run') {
  clearLiveStatusLine();
  if (logging.mode === 'minimal') {
    console.log(message);
    return;
  }
  if (logging.mode === 'ticker') {
    console.log(`[ticker] ${nowIso().slice(11, 19)} ${message}`);
    return;
  }
  if (logging.mode === 'pretty') {
    const stamp = colorize(logging, '90', nowIso().slice(11, 19));
    const prefix = `${stamp} ${nextPrettySpinner(logging)} ${prettyLevelTag(logging, level)} `;
    const prettyLevel = prettyColorLevel(level);
    const renderedMessage = String(message ?? '').trim();
    if (!renderedMessage) {
      console.log(prefix.trimEnd());
      return;
    }
    const segments = renderedMessage
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (segments.length <= 1) {
      if (parseStructuredLogMessage(renderedMessage).details.length > 0) {
        printPrettyRunMessage(logging, prefix, renderedMessage, prettyLevel);
      } else {
        printIndentedPrettyMessage(prefix, colorizeStructuredHeadline(logging, renderedMessage, prettyLevel));
      }
      return;
    }
    printIndentedPrettyMessage(prefix, colorizeStructuredHeadline(logging, segments[0], prettyLevel));
    const continuationPrefix = ' '.repeat(Math.max(0, visibleTextLength(prefix)));
    const detailPrefix = `${continuationPrefix}${colorize(logging, '90', '│ ')}`;
    for (const line of segments.slice(1)) {
      printIndentedPrettyMessage(detailPrefix, colorizeStructuredValue(logging, 'detail', line, prettyLevel));
    }
    return;
  }
  console.log(`[orchestrator] ${message}`);
}

function sanitizeLiveActivityLine(line, maxChars = 160) {
  let rendered = stripAnsiControl(line).replace(/\s+/g, ' ').trim();
  if (!rendered || !/[A-Za-z]/.test(rendered)) {
    return null;
  }
  const lower = rendered.toLowerCase();
  if (['ok', 'done', 'completed', 'complete', 'pending', 'running', 'started', 'in_progress'].includes(lower)) {
    return null;
  }
  if (Number.isFinite(maxChars) && maxChars > 0 && rendered.length > maxChars) {
    rendered = `${rendered.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  }
  return rendered || null;
}

function extractLiveActivityText(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    return sanitizeLiveActivityLine(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = extractLiveActivityText(entry);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }
  if (typeof value !== 'object') {
    return null;
  }

  for (const key of ['message', 'summary', 'text', 'content', 'activity', 'reasoning', 'description']) {
    const candidate = extractLiveActivityText(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  for (const key of ['delta', 'details', 'result', 'event', 'data']) {
    const candidate = extractLiveActivityText(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function tailLines(value, maxLines) {
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return '';
  }
  const start = Math.max(0, lines.length - Math.max(1, maxLines));
  return lines.slice(start).join('\n');
}

function executionOutput(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (stdout && stderr) {
    return `${stdout}\n${stderr}`;
  }
  return stdout || stderr || '';
}

function normalizeRepoRelativePath(value) {
  return toPosix(String(value ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
}

function isTransientAutomationPath(relPath) {
  const normalized = normalizeRepoRelativePath(relPath);
  if (!normalized) {
    return false;
  }
  if (TRANSIENT_AUTOMATION_FILES.has(normalized)) {
    return true;
  }
  return TRANSIENT_AUTOMATION_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parseGitPorcelainPaths(stdout) {
  const raw = String(stdout ?? '');
  if (!raw) {
    return [];
  }
  const tokens = raw.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) {
      continue;
    }
    const status = token.slice(0, 2);
    const primaryPath = normalizeRepoRelativePath(token.slice(3));
    if (primaryPath) {
      paths.push(primaryPath);
    }
    if ((status.includes('R') || status.includes('C')) && index + 1 < tokens.length) {
      const secondaryPath = normalizeRepoRelativePath(tokens[index + 1]);
      if (secondaryPath) {
        paths.push(secondaryPath);
      }
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function gitAvailable(rootDir) {
  const result = runShellCapture('git rev-parse --is-inside-work-tree', rootDir);
  return result.status === 0;
}

function dirtyRepoPaths(rootDir, { includeTransient = false } = {}) {
  const result = runShellCapture('git status --porcelain=v1 -z', rootDir);
  if (result.status !== 0) {
    return [];
  }
  const paths = parseGitPorcelainPaths(result.stdout);
  return includeTransient ? paths : paths.filter((entry) => !isTransientAutomationPath(entry));
}

function pathMatchesRootPrefix(filePath, root) {
  const normalizedFile = normalizeRepoRelativePath(filePath);
  const normalizedRoot = normalizeRepoRelativePath(root);
  if (!normalizedFile || !normalizedRoot) {
    return false;
  }
  return (
    normalizedFile === normalizedRoot ||
    normalizedFile.startsWith(`${normalizedRoot}/`) ||
    normalizedRoot.startsWith(`${normalizedFile}/`)
  );
}

function commitEnabled(config, options) {
  return asBoolean(options.commit, asBoolean(config?.git?.atomicCommits, true));
}

function activeEvidencePathForPlan(planId) {
  return path.join(ACTIVE_EVIDENCE_DIR, `${planId}.md`);
}

function atomicCommitRootsForPlan(plan, config) {
  const runtimeContextFile = trimmedString(config?.runtime?.contextPath, 'docs/generated/AGENT-RUNTIME-CONTEXT.md');
  const planFileName = path.basename(plan.filePath);
  return [
    ...plan.implementationTargets,
    ...plan.specTargets,
    ...parseListField(metadataValue(plan.metadata, 'Atomic-Roots')),
    path.join(FUTURE_DIR, planFileName),
    path.join(ACTIVE_DIR, planFileName),
    activeEvidencePathForPlan(plan.planId),
    path.join(COMPLETED_DIR, planFileName),
    path.join(EVIDENCE_INDEX_DIR, `${plan.planId}.md`),
    runtimeContextFile
  ]
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index);
}

function shellJoinArgs(args) {
  return args.map((entry) => shellEscape(entry)).join(' ');
}

function createAtomicCommit(rootDir, plan, config) {
  const changedPaths = dirtyRepoPaths(rootDir, { includeTransient: false });
  if (changedPaths.length === 0) {
    return { ok: true, committed: false, reason: 'no changes' };
  }

  const allowedRoots = atomicCommitRootsForPlan(plan, config);
  const outsideScope = changedPaths.filter((entry) => !allowedRoots.some((root) => pathMatchesRootPrefix(entry, root)));
  if (outsideScope.length > 0) {
    return {
      ok: false,
      committed: false,
      reason: `Atomic root policy violation for ${plan.planId}; unrelated dirty paths: ${outsideScope.slice(0, 8).join(', ')}`
    };
  }

  const addResult = runShellCapture(`git add -- ${shellJoinArgs(changedPaths)}`, rootDir);
  if (addResult.status !== 0) {
    return {
      ok: false,
      committed: false,
      reason: `Failed to stage atomic commit for ${plan.planId}: ${tailLines(executionOutput(addResult), 10)}`
    };
  }

  const stagedResult = runShellCapture('git diff --cached --name-only -z', rootDir);
  const stagedPaths = stagedResult.status === 0
    ? String(stagedResult.stdout ?? '').split('\0').map((entry) => normalizeRepoRelativePath(entry)).filter(Boolean)
    : [];
  if (stagedPaths.length === 0) {
    return { ok: true, committed: false, reason: 'no staged changes' };
  }

  const commitMessage = `chore(automation): complete ${plan.planId}`;
  const commitResult = runShellCapture(`git commit -m ${shellEscape(commitMessage)}`, rootDir);
  if (commitResult.status !== 0) {
    return {
      ok: false,
      committed: false,
      reason: `Atomic commit failed for ${plan.planId}: ${tailLines(executionOutput(commitResult), 10)}`
    };
  }

  const hashResult = runShellCapture('git rev-parse HEAD', rootDir);
  const commitHash = hashResult.status === 0 ? String(hashResult.stdout ?? '').trim() : null;
  return {
    ok: true,
    committed: true,
    commitHash
  };
}

function safeDisplayToken(value, fallback = 'n/a') {
  const rendered = String(value ?? '').trim();
  return rendered.length > 0 ? rendered : fallback;
}

function sanitizeLogNarrative(value, fallback = 'none', maxLength = 160) {
  let rendered = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/=/g, ':')
    .trim();
  if (!rendered) {
    return fallback;
  }
  if (Number.isFinite(maxLength) && maxLength > 0 && rendered.length > maxLength) {
    rendered = `${rendered.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }
  return rendered;
}

function compactDisplayToken(value, fallback, maxLength) {
  const rendered = safeDisplayToken(value, fallback);
  if (!Number.isFinite(maxLength) || maxLength <= 1 || rendered.length <= maxLength) {
    return rendered;
  }
  return `${rendered.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function formatDurationClock(totalSeconds) {
  const normalized = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function previewPlanIds(values, maxItems = 3) {
  const items = [...new Set((Array.isArray(values) ? values : []).map((entry) => safeDisplayToken(entry, '')).filter(Boolean))];
  if (items.length === 0) {
    return 'none';
  }
  const visible = items.slice(0, Math.max(1, maxItems));
  const remainder = items.length - visible.length;
  return remainder > 0 ? `${visible.join(', ')} +${remainder} more` : visible.join(', ');
}

function classifyTouchedPath(filePath) {
  const normalized = normalizeRepoRelativePath(filePath);
  if (!normalized) {
    return 'repo';
  }
  if (normalized.startsWith('docs/exec-plans/')) return 'plan-docs';
  if (normalized.startsWith('docs/')) return 'docs';
  if (normalized.startsWith('scripts/')) return 'scripts';
  if (normalized.startsWith('test/') || normalized.startsWith('tests/') || normalized.includes('.test.')) return 'tests';
  if (
    normalized.startsWith('src/') ||
    normalized.startsWith('app/') ||
    normalized.startsWith('apps/') ||
    normalized.startsWith('packages/') ||
    normalized.startsWith('lib/')
  ) {
    return 'code';
  }
  return normalized.split('/')[0] || 'repo';
}

function summarizeTouchedPaths(paths, sampleSize = 3) {
  const normalized = [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((entry) => normalizeRepoRelativePath(entry))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
  if (normalized.length === 0) {
    return {
      count: 0,
      categories: [],
      samples: [],
      fingerprint: 'none',
      touched: []
    };
  }

  const categoryCounts = new Map();
  for (const filePath of normalized) {
    const category = classifyTouchedPath(filePath);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  return {
    count: normalized.length,
    categories: [...categoryCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([category, count]) => ({ category, count })),
    samples: normalized.slice(0, Math.max(1, sampleSize)),
    fingerprint: createHash('sha1').update(normalized.join('\n')).digest('hex').slice(0, 10),
    touched: normalized
  };
}

function formatTouchSummaryInline(summary) {
  if (!summary || summary.count <= 0) {
    return 'touch=none';
  }
  const categories = summary.categories
    .slice(0, 2)
    .map((entry) => `${entry.category}:${entry.count}`)
    .join(',');
  return `touch=${summary.count}(${categories || 'n/a'})`;
}

function formatTouchSummaryDetails(summary) {
  if (!summary || summary.count <= 0) {
    return 'touched=0';
  }
  const categories = summary.categories
    .slice(0, 4)
    .map((entry) => `${entry.category}:${entry.count}`)
    .join(', ');
  const samples = summary.samples.length > 0 ? summary.samples.join(', ') : 'none';
  return `touched=${summary.count} categories=[${categories}] sample=[${samples}]`;
}

function createTouchBaseline(rootDir) {
  return {
    initialDirtyPathSet: new Set(dirtyRepoPaths(rootDir, { includeTransient: true })),
    touchedPathSet: new Set()
  };
}

function monitorTouchedPaths(rootDir, baseline, sampleSize = 3) {
  if (!baseline || !(baseline.initialDirtyPathSet instanceof Set)) {
    return null;
  }
  const current = dirtyRepoPaths(rootDir, { includeTransient: true });
  for (const entry of current) {
    if (isTransientAutomationPath(entry)) {
      continue;
    }
    if (!baseline.initialDirtyPathSet.has(entry)) {
      baseline.touchedPathSet.add(entry);
    }
  }
  return summarizeTouchedPaths([...baseline.touchedPathSet], sampleSize);
}

function buildQueueOverview(plans, completedPlanIds, queue, maxRisk) {
  const futureDraft = plans.filter((plan) => plan.phase === 'future' && plan.status === 'draft').map((plan) => plan.planId);
  const futureReady = plans.filter((plan) => plan.phase === 'future' && plan.status === 'ready-for-promotion').map((plan) => plan.planId);
  const activeQueued = plans.filter((plan) => plan.phase === 'active' && plan.status === 'queued').map((plan) => plan.planId);
  const activeInProgress = plans.filter((plan) => plan.phase === 'active' && plan.status === 'in-progress').map((plan) => plan.planId);
  const activeInReview = plans.filter((plan) => plan.phase === 'active' && plan.status === 'in-review').map((plan) => plan.planId);
  const activeValidation = plans.filter((plan) => plan.phase === 'active' && plan.status === 'validation').map((plan) => plan.planId);
  const activeBlocked = plans.filter((plan) => plan.phase === 'active' && plan.status === 'blocked').map((plan) => plan.planId);
  return {
    maxRisk,
    nextPlanId: queue[0]?.planId ?? 'none',
    queueCount: queue.length,
    queuePreview: previewPlanIds(queue.map((plan) => plan.planId)),
    futureDraftCount: futureDraft.length,
    futureDraftPreview: previewPlanIds(futureDraft),
    futureReadyCount: futureReady.length,
    futureReadyPreview: previewPlanIds(futureReady),
    activeQueuedCount: activeQueued.length,
    activeQueuedPreview: previewPlanIds(activeQueued),
    activeInProgressCount: activeInProgress.length,
    activeInProgressPreview: previewPlanIds(activeInProgress),
    activeInReviewCount: activeInReview.length,
    activeInReviewPreview: previewPlanIds(activeInReview),
    activeValidationCount: activeValidation.length,
    activeValidationPreview: previewPlanIds(activeValidation),
    activeBlockedCount: activeBlocked.length,
    activeBlockedPreview: previewPlanIds(activeBlocked),
    completedCount: completedPlanIds.size
  };
}

function printSummaryBlock(logging, title, rows) {
  clearLiveStatusLine();
  const border = colorize(logging, '90', '------------------------------------------------------------');
  const renderedTitle = colorize(logging, '1;36', title);
  console.log(border);
  console.log(renderedTitle);
  for (const [label, value] of rows) {
    const key = colorize(logging, '90', `${label}:`.padEnd(18, ' '));
    console.log(`${key} ${String(value ?? 'n/a')}`);
  }
  console.log(border);
}

function logQueueOverview(logging, state, overview, label = 'queue overview', level = 'run') {
  const message =
    `${label} runId=${state.runId} maxRisk=${overview.maxRisk} next=${overview.nextPlanId} queue=${overview.queueCount} ` +
    `queuePreview=${overview.queuePreview} futureReady=${overview.futureReadyCount} activeQueued=${overview.activeQueuedCount} activeInProgress=${overview.activeInProgressCount} ` +
    `activeInReview=${overview.activeInReviewCount} activeValidation=${overview.activeValidationCount} activeBlocked=${overview.activeBlockedCount} completed=${overview.completedCount}`;
  logLine(logging, message, level);
}

function printRunSummary(logging, label, state, processed, durationSeconds, overview) {
  if (logging.mode === 'pretty') {
    printSummaryBlock(logging, `${label.toUpperCase()} SUMMARY`, [
      ['runId', state.runId],
      ['processed', processed],
      ['duration', `${formatDuration(durationSeconds)} (${Math.max(0, Math.floor(durationSeconds || 0))}s)`],
      ['next', overview.nextPlanId],
      ['queue', overview.queueCount],
      ['future ready', `${overview.futureReadyCount} (${overview.futureReadyPreview})`],
      ['active queued', `${overview.activeQueuedCount} (${overview.activeQueuedPreview})`],
      ['active in-progress', `${overview.activeInProgressCount} (${overview.activeInProgressPreview})`],
      ['active in-review', `${overview.activeInReviewCount} (${overview.activeInReviewPreview})`],
      ['active validation', `${overview.activeValidationCount} (${overview.activeValidationPreview})`],
      ['active blocked', `${overview.activeBlockedCount} (${overview.activeBlockedPreview})`],
      ['completed', overview.completedCount],
      ['promotions', state.stats.promotions],
      ['sessions', state.stats.sessions],
      ['validations', state.stats.validations],
      ['commits', state.stats.commits]
    ]);
    return;
  }
  logLine(
    logging,
    `${label} summary runId=${state.runId} processed=${processed} duration=${formatDuration(durationSeconds)} queue=${overview.queueCount} completed=${overview.completedCount} blocked=${overview.activeBlockedCount} commits=${state.stats.commits}`,
    'ok'
  );
}

function formatCommandHeartbeatLine(logging, context, elapsedSeconds, idleSeconds, touchSummary = null) {
  const stamp = colorize(logging, '90', nowIso().slice(11, 19));
  const dots = nextPrettyLiveDots(logging);
  const tag = prettyLevelTag(logging, idleSeconds >= logging.stallWarnSeconds ? 'warn' : 'run');
  const phase = compactDisplayToken(context.phase, 'session', 10);
  const planId = compactDisplayToken(context.planId, 'run', 26);
  const role = compactDisplayToken(context.role, 'n/a', 10);
  const activity = compactDisplayToken(context.activity, phase, 16);
  return (
    `${stamp} ${dots} ${tag} phase=${phase} plan=${planId} role=${role} activity=${activity} ` +
    `elapsed=${formatDurationClock(elapsedSeconds)} idle=${formatDurationClock(idleSeconds)} ${formatTouchSummaryInline(touchSummary)}`
  );
}

async function runShellMonitored(command, cwd, env = process.env, timeoutMs = undefined, logging, context = {}) {
  const startedAtMs = Date.now();
  let lastOutputAtMs = startedAtMs;
  let lastVisibleStatusAtMs = startedAtMs;
  let lastLiveActivityAtMs = 0;
  let lastTouchChangeAtMs = startedAtMs;
  let stdout = '';
  let stderr = '';
  let stdoutRemainder = '';
  let stderrRemainder = '';
  let timedOut = false;
  let processError = null;
  let settled = false;
  let warnEmitted = false;
  const touchBaseline = gitAvailable(cwd) ? createTouchBaseline(cwd) : null;
  let touchSummary = null;
  let lastTouchFingerprint = null;

  const child = spawn(command, {
    shell: true,
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  function maybeEmitLiveActivity(line, nowMs = Date.now()) {
    if (logging.mode !== 'pretty' && logging.mode !== 'ticker') {
      return;
    }
    if (nowMs - lastLiveActivityAtMs < 5000) {
      return;
    }
    const trimmed = String(line ?? '').trim();
    if (!trimmed) {
      return;
    }
    let message = null;
    try {
      message = extractLiveActivityText(JSON.parse(trimmed));
    } catch {
      message = sanitizeLiveActivityLine(trimmed);
    }
    if (!message) {
      return;
    }
    const activityMessage = sanitizeLogNarrative(message, 'working');
    if (logging.mode === 'ticker') {
      logLine(
        logging,
        `working plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} phase=${safeDisplayToken(context.phase, 'session')} activity=${safeDisplayToken(context.activity, 'working')} message=${activityMessage}`
      );
      lastLiveActivityAtMs = nowMs;
      lastVisibleStatusAtMs = nowMs;
      return;
    }
    const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
    const stamp = colorize(logging, '90', nowIso().slice(11, 19));
    const spinner = nextPrettySpinner(logging);
    const workingLabel = colorize(
      logging,
      '36',
      `WORKING ${safeDisplayToken(context.planId, 'run')}/${safeDisplayToken(context.role, 'n/a')} (${formatDurationClock(elapsedSeconds)})`
    );
    const workingMessage = colorize(logging, '37', activityMessage);
    clearLiveStatusLine();
    printIndentedPrettyMessage(`${stamp} ${spinner} ${workingLabel} `, workingMessage);
    lastLiveActivityAtMs = nowMs;
    lastVisibleStatusAtMs = nowMs;
  }

  function processLiveChunks(source, text, nowMs = Date.now()) {
    const previousRemainder = source === 'stdout' ? stdoutRemainder : stderrRemainder;
    const combined = `${previousRemainder}${text}`;
    const parts = combined.split(/\r?\n|\r/g);
    const remainder = parts.pop() ?? '';
    if (source === 'stdout') {
      stdoutRemainder = remainder;
    } else {
      stderrRemainder = remainder;
    }
    for (const line of parts) {
      maybeEmitLiveActivity(line, nowMs);
    }
  }

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    const nowMs = Date.now();
    stdout += text;
    lastOutputAtMs = nowMs;
    processLiveChunks('stdout', text, nowMs);
    if (logging.mode === 'verbose') {
      clearLiveStatusLine();
      process.stdout.write(text);
    }
  });

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    const nowMs = Date.now();
    stderr += text;
    lastOutputAtMs = nowMs;
    processLiveChunks('stderr', text, nowMs);
    if (logging.mode === 'verbose') {
      clearLiveStatusLine();
      process.stderr.write(text);
    }
  });

  const heartbeatMs = Math.max(3000, logging.heartbeatSeconds * 1000);
  const stallWarnMs = Math.max(heartbeatMs, logging.stallWarnSeconds * 1000);
  const heartbeatEnabled = logging.mode === 'pretty' || logging.mode === 'ticker';
  let heartbeatTimer = null;

  function maybeRefreshTouchSummary(nowMs = Date.now()) {
    if (!touchBaseline) {
      return null;
    }
    const latest = monitorTouchedPaths(cwd, touchBaseline, 3);
    if (!latest) {
      return null;
    }
    touchSummary = latest;
    if (latest.fingerprint !== lastTouchFingerprint) {
      lastTouchFingerprint = latest.fingerprint;
      if (latest.count > 0) {
        lastTouchChangeAtMs = nowMs;
        logLine(
          logging,
          `file activity phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} ${formatTouchSummaryDetails(latest)}`,
          'run'
        );
        lastVisibleStatusAtMs = nowMs;
      }
    }
    return latest;
  }

  const emitHeartbeat = () => {
    const nowMs = Date.now();
    maybeRefreshTouchSummary(nowMs);
    const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
    const idleSeconds = Math.floor((nowMs - Math.max(lastOutputAtMs, lastTouchChangeAtMs)) / 1000);
    if (nowMs - lastVisibleStatusAtMs >= heartbeatMs && supportsLiveStatusLine(logging)) {
      renderLiveStatusLine(logging, formatCommandHeartbeatLine(logging, context, elapsedSeconds, idleSeconds, touchSummary));
      lastVisibleStatusAtMs = nowMs;
    } else if (nowMs - lastVisibleStatusAtMs >= heartbeatMs) {
      logLine(
        logging,
        `heartbeat phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} activity=${safeDisplayToken(context.activity, safeDisplayToken(context.phase, 'session'))} elapsed=${formatDuration(elapsedSeconds)} idle=${formatDuration(idleSeconds)} ${formatTouchSummaryInline(touchSummary)}`,
        idleSeconds >= logging.stallWarnSeconds ? 'warn' : 'run'
      );
      lastVisibleStatusAtMs = nowMs;
    }
    if (idleSeconds * 1000 >= stallWarnMs && !warnEmitted) {
      warnEmitted = true;
      logLine(
        logging,
        `stall warning phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} idle=${formatDuration(idleSeconds)} ${formatTouchSummaryInline(touchSummary)}`,
        'warn'
      );
    }
  };

  if (heartbeatEnabled) {
    emitHeartbeat();
    heartbeatTimer = setInterval(emitHeartbeat, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  let timeoutTimer = null;
  let forceKillTimer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  function cleanupTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    clearLiveStatusLine();
  }

  return new Promise((resolve) => {
    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      maybeRefreshTouchSummary(Date.now());
      cleanupTimers();
      resolve({
        status,
        signal,
        error: timedOut ? { code: 'ETIMEDOUT' } : processError,
        stdout,
        stderr
      });
    };

    child.on('error', (error) => {
      processError = error;
      finish(null, null);
    });

    child.on('close', (status, signal) => {
      finish(status, signal);
    });
  });
}

function planPhaseDir(rootDir, phase) {
  if (phase === 'future') {
    return path.join(rootDir, FUTURE_DIR);
  }
  if (phase === 'active') {
    return path.join(rootDir, ACTIVE_DIR);
  }
  return path.join(rootDir, COMPLETED_DIR);
}

async function readPlan(filePath, phase, rootDir) {
  const content = await fs.readFile(filePath, 'utf8');
  const metadata = parseMetadata(content);
  return {
    phase,
    filePath,
    rel: toPosix(path.relative(rootDir, filePath)),
    content,
    metadata,
    planId: inferPlanId(content, filePath),
    title: trimmedString(content.match(/^#\s+(.+)$/m)?.[1]),
    status: String(metadataValue(metadata, 'Status')).trim().toLowerCase(),
    priority: parsePriority(metadataValue(metadata, 'Priority'), 'p3'),
    owner: trimmedString(metadataValue(metadata, 'Owner')),
    acceptanceCriteria: trimmedString(metadataValue(metadata, 'Acceptance-Criteria')),
    deliveryClass: parseDeliveryClass(metadataValue(metadata, 'Delivery-Class'), 'docs'),
    dependencies: parseListField(metadataValue(metadata, 'Dependencies')),
    specTargets: parseListField(metadataValue(metadata, 'Spec-Targets')),
    implementationTargets: parseListField(metadataValue(metadata, 'Implementation-Targets')),
    riskTier: parseRiskTier(metadataValue(metadata, 'Risk-Tier'), 'low'),
    securityApproval: parseSecurityApproval(metadataValue(metadata, 'Security-Approval'), 'not-required'),
    validationLanes: parseValidationLanes(metadataValue(metadata, 'Validation-Lanes'), ['always']),
    doneEvidence: trimmedString(metadataValue(metadata, 'Done-Evidence'), 'pending')
  };
}

async function collectPlans(rootDir) {
  const phases = ['future', 'active', 'completed'];
  const plans = [];
  for (const phase of phases) {
    const files = await listMarkdownFiles(planPhaseDir(rootDir, phase));
    for (const filePath of files) {
      const relative = toPosix(path.relative(rootDir, filePath));
      if (path.basename(filePath) === 'README.md' || relative.includes('/evidence/')) {
        continue;
      }
      plans.push(await readPlan(filePath, phase, rootDir));
    }
  }
  return plans;
}

function orderPlans(plans) {
  return [...plans].sort((left, right) => {
    const priorityDelta = planPriorityWeight(left.priority) - planPriorityWeight(right.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.rel.localeCompare(right.rel);
  });
}

function riskAllowed(plan, maxRisk) {
  return (RISK_ORDER[plan.riskTier] ?? 0) <= (RISK_ORDER[maxRisk] ?? RISK_ORDER.low);
}

function dependenciesComplete(plan, completedPlanIds) {
  const deps = plan.dependencies.filter((entry) => entry.toLowerCase() !== 'none');
  return deps.every((dependency) => completedPlanIds.has(dependency));
}

function mustLandComplete(planContent) {
  const checklist = parseMustLandChecklist(planContent);
  return checklist.length > 0 && checklist.every((entry) => entry.checked);
}

function rolesForPlan(plan, config) {
  const reviewRequired = new Set(Array.isArray(config?.risk?.reviewRequired) ? config.risk.reviewRequired : ['medium', 'high']);
  return reviewRequired.has(plan.riskTier) ? [ROLE_WORKER, ROLE_REVIEWER] : [ROLE_WORKER];
}

function securityApprovalRequired(plan, config) {
  const required = new Set(Array.isArray(config?.risk?.securityApprovalRequired) ? config.risk.securityApprovalRequired : ['high']);
  return required.has(plan.riskTier);
}

function nextRunId() {
  const timestamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run-${timestamp}`;
}

function createRunState(runId, maxRisk) {
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    runId,
    maxRisk,
    startedAt: timestamp,
    lastUpdatedAt: timestamp,
    queue: [],
    activePlanId: null,
    completedPlanIds: [],
    blockedPlanIds: [],
    failedPlanIds: [],
    planSessions: {},
    stats: {
      promotions: 0,
      sessions: 0,
      validations: 0,
      completed: 0,
      blocked: 0,
      commits: 0
    }
  };
}

async function loadRunState(rootDir, maxRisk, command) {
  const runStatePath = path.join(rootDir, RUN_STATE_PATH);
  const existing = await readJson(runStatePath, null);
  if (!existing || command === 'run' || command === 'grind') {
    return createRunState(nextRunId(), maxRisk);
  }
  return {
    ...existing,
    maxRisk,
    lastUpdatedAt: nowIso()
  };
}

async function saveRunState(rootDir, state) {
  state.lastUpdatedAt = nowIso();
  await writeJson(path.join(rootDir, RUN_STATE_PATH), state, false);
}

async function appendRunEvent(rootDir, state, type, planId = null, details = {}) {
  const event = {
    schemaVersion: 1,
    sequence: asInteger(state.eventSequence, 0) + 1,
    timestamp: nowIso(),
    runId: state.runId,
    taskId: planId,
    type,
    model: 'n/a',
    mode: 'flat-queue',
    details
  };
  state.eventSequence = event.sequence;
  await appendJsonLine(path.join(rootDir, RUN_EVENTS_PATH), event, false);
}

function runtimePaths(rootDir, runId, planId) {
  const runDir = path.join(rootDir, OPS_DIR, 'runtime', runId, planId);
  const stateDir = path.join(rootDir, OPS_DIR, 'runtime', 'state', planId);
  return {
    runDir,
    logsDir: path.join(runDir, 'logs'),
    resultDir: path.join(runDir, 'results'),
    checkpointPath: path.join(stateDir, 'latest.json'),
    handoffPath: path.join(rootDir, OPS_DIR, 'handoffs', `${planId}.md`)
  };
}

async function writeCheckpoint(rootDir, runId, plan, role, sessionNumber, result) {
  const paths = runtimePaths(rootDir, runId, plan.planId);
  const checkpoint = {
    schemaVersion: 1,
    planId: plan.planId,
    runId,
    role,
    session: sessionNumber,
    updatedAt: nowIso(),
    status: result.status,
    summary: result.summary,
    reason: result.reason,
    contextRemaining: result.contextRemaining,
    contextWindow: result.contextWindow,
    contextRemainingPercent: result.contextRemainingPercent,
    currentSubtask: result.currentSubtask,
    nextAction: result.nextAction,
    stateDelta: result.stateDelta
  };
  await fs.mkdir(path.dirname(paths.checkpointPath), { recursive: true });
  await writeTextFileAtomic(paths.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');

  const note = [
    `# Handoff: ${plan.planId}`,
    '',
    `- Run-ID: ${runId}`,
    `- Role: ${role}`,
    `- Session: ${sessionNumber}`,
    `- Status: ${result.status}`,
    `- Summary: ${result.summary || 'none'}`,
    `- Reason: ${result.reason || 'none'}`,
    `- Context Remaining: ${Number.isFinite(result.contextRemaining) ? String(result.contextRemaining) : 'unknown'}`,
    `- Context Window: ${Number.isFinite(result.contextWindow) ? String(result.contextWindow) : 'unknown'}`,
    `- Context Remaining Percent: ${Number.isFinite(result.contextRemainingPercent) ? `${Math.round(result.contextRemainingPercent * 100)}%` : 'unknown'}`,
    `- Current Subtask: ${result.currentSubtask || 'none'}`,
    `- Next Action: ${result.nextAction || 'none'}`
  ].join('\n');
  await fs.mkdir(path.dirname(paths.handoffPath), { recursive: true });
  await fs.writeFile(paths.handoffPath, `${note}\n`, 'utf8');

  return {
    checkpointRel: toPosix(path.relative(rootDir, paths.checkpointPath)),
    handoffRel: toPosix(path.relative(rootDir, paths.handoffPath))
  };
}

function normalizeResult(raw, fallbackReason = '') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const status = String(source.status ?? '').trim().toLowerCase();
  const stateDelta = source.stateDelta && typeof source.stateDelta === 'object' ? source.stateDelta : {};
  const contextRemaining = Number.isFinite(source.contextRemaining) ? source.contextRemaining : null;
  const contextWindow = Number.isFinite(source.contextWindow) ? source.contextWindow : null;
  const explicitPercent = Number.isFinite(source.contextRemainingPercent) ? source.contextRemainingPercent : null;
  const derivedPercent = Number.isFinite(contextRemaining) && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextRemaining / contextWindow
    : null;
  return {
    status: ['completed', 'blocked', 'handoff_required', 'pending'].includes(status) ? status : 'blocked',
    summary: trimmedString(source.summary, 'No summary provided.'),
    reason: trimmedString(source.reason, fallbackReason) || null,
    contextRemaining,
    contextWindow,
    contextRemainingPercent: explicitPercent ?? derivedPercent,
    currentSubtask: trimmedString(source.currentSubtask),
    nextAction: trimmedString(source.nextAction),
    stateDelta: {
      completedWork: Array.isArray(stateDelta.completedWork) ? stateDelta.completedWork : [],
      acceptedFacts: Array.isArray(stateDelta.acceptedFacts) ? stateDelta.acceptedFacts : [],
      decisions: Array.isArray(stateDelta.decisions) ? stateDelta.decisions : [],
      openQuestions: Array.isArray(stateDelta.openQuestions) ? stateDelta.openQuestions : [],
      pendingActions: Array.isArray(stateDelta.pendingActions) ? stateDelta.pendingActions : [],
      recentResults: Array.isArray(stateDelta.recentResults) ? stateDelta.recentResults : [],
      artifacts: Array.isArray(stateDelta.artifacts) ? stateDelta.artifacts : [],
      risks: Array.isArray(stateDelta.risks) ? stateDelta.risks : [],
      reasoning: Array.isArray(stateDelta.reasoning) ? stateDelta.reasoning : [],
      evidence: Array.isArray(stateDelta.evidence) ? stateDelta.evidence : []
    }
  };
}

function replaceTokens(template, values) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (match, rawKey) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) {
      return match;
    }
    return String(values[key] ?? '');
  });
}

async function buildPrompt(rootDir, config, plan, role, runId, sessionNumber) {
  const template = resolveExecutorPromptTemplate(config?.executor?.promptTemplate);
  const runtimeContextFile = trimmedString(config?.runtime?.contextPath, 'docs/generated/AGENT-RUNTIME-CONTEXT.md');
  const paths = runtimePaths(rootDir, runId, plan.planId);
  const checkpointExists = await readJson(paths.checkpointPath, null);
  const handoffExists = await fs.access(paths.handoffPath).then(() => true).catch(() => false);
  const roleConfig = config?.executor?.roles?.[role] ?? {};
  const budget = contextBudgetPolicy(config);
  return replaceTokens(template, {
    runtime_context_file: runtimeContextFile,
    plan_file: plan.rel,
    checkpoint_file: checkpointExists ? toPosix(path.relative(rootDir, paths.checkpointPath)) : 'none',
    handoff_file: handoffExists ? toPosix(path.relative(rootDir, paths.handoffPath)) : 'none',
    role,
    role_instructions: roleConfig.instructions ?? '',
    plan_id: plan.planId,
    risk_tier: plan.riskTier,
    session: String(sessionNumber),
    context_threshold_tokens: String(budget.minRemaining),
    context_threshold_percent: contextThresholdPercentLabel(budget.minRemainingPercent)
  });
}

function analyzeContextBudget(result, config) {
  const budget = contextBudgetPolicy(config);
  const remaining = Number.isFinite(result?.contextRemaining) ? result.contextRemaining : null;
  const percent = Number.isFinite(result?.contextRemainingPercent) ? result.contextRemainingPercent : null;
  const triggers = [];
  if (remaining != null && remaining <= budget.minRemaining) {
    triggers.push(`remaining ${remaining} <= ${budget.minRemaining}`);
  }
  if (percent != null && percent <= budget.minRemainingPercent) {
    triggers.push(`remainingPercent ${Math.round(percent * 100)}% <= ${Math.round(budget.minRemainingPercent * 100)}%`);
  }
  return {
    triggered: triggers.length > 0,
    remaining,
    percent,
    minRemaining: budget.minRemaining,
    minRemainingPercent: budget.minRemainingPercent,
    reason: triggers.length > 0
      ? `Context budget threshold reached (${triggers.join('; ')}).`
      : null
  };
}

function roleBoundaryComplete(plan, role) {
  if (role === ROLE_REVIEWER) {
    return plan.status === 'validation' || mustLandComplete(plan.content);
  }
  return mustLandComplete(plan.content);
}

async function writeCommandLog(rootDir, runId, planId, role, sessionNumber, execution) {
  const paths = runtimePaths(rootDir, runId, planId);
  await fs.mkdir(paths.logsDir, { recursive: true });
  const logPath = path.join(paths.logsDir, `${String(sessionNumber).padStart(2, '0')}-${role}.log`);
  const content = [
    `exitCode=${execution.status ?? 1}`,
    '',
    String(execution.stdout ?? ''),
    String(execution.stderr ?? '')
  ].join('\n');
  await fs.writeFile(logPath, content, 'utf8');
  return toPosix(path.relative(rootDir, logPath));
}

async function executeRole(rootDir, config, state, plan, role, logging) {
  const sessionNumber = (state.planSessions[plan.planId] ?? 0) + 1;
  state.planSessions[plan.planId] = sessionNumber;
  state.stats.sessions += 1;

  const roleConfig = config?.executor?.roles?.[role] ?? {};
  const commandTemplate = trimmedString(config?.executor?.command);
  if (!commandTemplate) {
    throw new Error('Missing executor.command in docs/ops/automation/orchestrator.config.json.');
  }

  const prompt = await buildPrompt(rootDir, config, plan, role, state.runId, sessionNumber);
  const paths = runtimePaths(rootDir, state.runId, plan.planId);
  await fs.mkdir(paths.resultDir, { recursive: true });
  const resultPath = path.join(paths.resultDir, `${String(sessionNumber).padStart(2, '0')}-${role}.json`);
  const resultRel = toPosix(path.relative(rootDir, resultPath));
  const command = renderShellEscaped(commandTemplate, {
    prompt,
    model: roleConfig.model ?? '',
    reasoning_effort: roleConfig.reasoningEffort ?? 'high',
    role,
    plan_id: plan.planId,
    plan_file: plan.rel,
    result_path: resultRel,
    session: String(sessionNumber)
  });
  const env = {
    ...process.env,
    ORCH_PLAN_ID: plan.planId,
    ORCH_PLAN_FILE: plan.rel,
    ORCH_ROLE: role,
    ORCH_RESULT_PATH: resultRel,
    ORCH_RUN_ID: state.runId,
    ORCH_SESSION: String(sessionNumber),
    ORCH_RISK_TIER: plan.riskTier
  };
  const execution = await runShellMonitored(
    command,
    rootDir,
    env,
    executorTimeoutMs(config),
    logging,
    {
      phase: 'session',
      planId: plan.planId,
      role,
      activity: role === ROLE_REVIEWER ? 'reviewing' : 'implementing'
    }
  );
  const logRel = await writeCommandLog(rootDir, state.runId, plan.planId, role, sessionNumber, execution);
  const rawResult = await readJson(resultPath, null);
  const normalized = normalizeResult(
    rawResult,
    execution.status === 0
      ? ''
      : `Executor exited ${execution.status ?? 1}. See ${logRel}.`
  );
  const checkpointRefs = await writeCheckpoint(rootDir, state.runId, plan, role, sessionNumber, normalized);
  await appendRunEvent(rootDir, state, 'session_finished', plan.planId, {
    role,
    session: sessionNumber,
    status: normalized.status,
    reason: normalized.reason,
    contextRemaining: normalized.contextRemaining,
    contextWindow: normalized.contextWindow,
    contextRemainingPercent: normalized.contextRemainingPercent,
    checkpoint: checkpointRefs.checkpointRel,
    handoff: checkpointRefs.handoffRel,
    log: logRel
  });
  return {
    execution,
    result: normalized,
    sessionNumber,
    logRel,
    checkpointRefs
  };
}

async function writePlan(rootDir, plan, content) {
  await fs.writeFile(plan.filePath, content, 'utf8');
  return readPlan(plan.filePath, plan.phase, rootDir);
}

async function updatePlanStatus(rootDir, plan, status, deliveryMessage = '') {
  let content = setPlanDocumentFields(plan.content, { Status: status });
  if (deliveryMessage) {
    content = appendToDeliveryLog(content, deliveryMessage);
  }
  return writePlan(rootDir, plan, content);
}

async function markPlanBlocked(rootDir, plan, reason, logLineText = '') {
  let content = setPlanDocumentFields(plan.content, { Status: 'blocked' });
  content = upsertSection(content, 'Blockers', [`- ${reason}`]);
  if (logLineText) {
    content = appendToDeliveryLog(content, logLineText);
  }
  return writePlan(rootDir, plan, content);
}

async function promoteFuturePlan(rootDir, state, plan, logging) {
  const targetPath = path.join(rootDir, ACTIVE_DIR, path.basename(plan.filePath));
  let content = setPlanDocumentFields(plan.content, { Status: 'queued', 'Done-Evidence': 'pending' });
  content = appendToDeliveryLog(content, `Promoted from docs/future in ${state.runId}.`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
  await fs.unlink(plan.filePath);
  state.stats.promotions += 1;
  await appendRunEvent(rootDir, state, 'future_promoted', plan.planId, {
    from: plan.rel,
    to: toPosix(path.relative(rootDir, targetPath))
  });
  logLine(logging, `promoted ${plan.planId}`, 'ok');
}

function validationCommandsForPlan(plan, config) {
  const commands = [];
  for (const lane of plan.validationLanes) {
    const source = lane === 'host-required' ? config?.validation?.hostRequired : config?.validation?.always;
    for (const entry of Array.isArray(source) ? source : []) {
      if (entry && typeof entry === 'object' && String(entry.command ?? '').trim()) {
        commands.push({
          lane,
          id: String(entry.id ?? `${lane}:${commands.length + 1}`).trim(),
          type: String(entry.type ?? lane).trim(),
          command: String(entry.command).trim()
        });
      }
    }
  }
  return commands;
}

async function writeValidationEvidence(rootDir, state, plan, results) {
  const evidenceLines = [];
  for (const result of results) {
    const summary = result.payload?.summary ? `: ${result.payload.summary}` : '';
    evidenceLines.push(`- ${result.id} (${result.lane})${summary}`);
    evidenceLines.push(`  log: ${result.logRel}`);
    if (result.resultRel) {
      evidenceLines.push(`  result: ${result.resultRel}`);
    }
  }
  let content = upsertSection(plan.content, 'Validation Evidence', evidenceLines);
  content = appendToDeliveryLog(content, `Validation updated in ${state.runId}.`);
  return writePlan(rootDir, plan, content);
}

async function rewritePerPlanActiveEvidence(rootDir, plan, targetRel) {
  const evidenceRel = activeEvidencePathForPlan(plan.planId);
  const evidenceAbs = path.join(rootDir, evidenceRel);
  let content;
  try {
    content = await fs.readFile(evidenceAbs, 'utf8');
  } catch {
    return;
  }

  const fromRel = toPosix(path.relative(rootDir, plan.filePath));
  const toRel = toPosix(targetRel);
  if (!fromRel || !toRel || !content.includes(fromRel)) {
    return;
  }

  await fs.writeFile(evidenceAbs, content.replaceAll(fromRel, toRel), 'utf8');
}

async function runValidation(rootDir, config, state, plan, logging) {
  const commands = validationCommandsForPlan(plan, config);
  if (commands.length === 0) {
    throw new Error(`Plan ${plan.planId} has no configured validation commands.`);
  }

  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const commandSpec = commands[index];
    state.stats.validations += 1;
    const paths = runtimePaths(rootDir, state.runId, plan.planId);
    await fs.mkdir(paths.resultDir, { recursive: true });
    const resultPath = path.join(paths.resultDir, `validation-${String(index + 1).padStart(2, '0')}.json`);
    const resultRel = toPosix(path.relative(rootDir, resultPath));
    const env = {
      ...process.env,
      ORCH_PLAN_ID: plan.planId,
      ORCH_VALIDATION_ID: commandSpec.id,
      ORCH_VALIDATION_TYPE: commandSpec.type,
      ORCH_VALIDATION_COMMAND: commandSpec.command,
      ORCH_VALIDATION_LANE: commandSpec.lane,
      ORCH_VALIDATION_RESULT_PATH: resultRel
    };
    logLine(logging, `validate ${plan.planId} ${commandSpec.id}`);
    const execution = await runShellMonitored(
      commandSpec.command,
      rootDir,
      env,
      executorTimeoutMs(config),
      logging,
      {
        phase: 'validation',
        planId: plan.planId,
        role: 'validation',
        activity: commandSpec.id
      }
    );
    const logRel = await writeCommandLog(rootDir, state.runId, plan.planId, `validation-${index + 1}`, index + 1, execution);
    const payload = await readJson(resultPath, null);
    results.push({ ...commandSpec, payload, resultRel, logRel, status: execution.status ?? 1 });
    if ((execution.status ?? 1) !== 0 || String(payload?.status ?? '').trim().toLowerCase() === 'failed') {
      const failureTail = tailLines(executionOutput(execution), logging.failureTailLines);
      logLine(logging, `validation failed ${plan.planId} ${commandSpec.id}`, 'err');
      if (failureTail) {
        logLine(logging, `validation failure tail:\n${failureTail}`, 'warn');
      }
      const blockedPlan = await markPlanBlocked(
        rootDir,
        plan,
        payload?.summary || payload?.reason || `Validation failed: ${commandSpec.id}`,
        `Validation failed for ${commandSpec.id} in ${state.runId}.`
      );
      await writeValidationEvidence(rootDir, state, blockedPlan, results);
      await appendRunEvent(rootDir, state, 'plan_blocked', plan.planId, {
        reason: payload?.summary || payload?.reason || `Validation failed: ${commandSpec.id}`,
        validationId: commandSpec.id
      });
      state.blockedPlanIds = [...new Set([...state.blockedPlanIds, plan.planId])];
      state.stats.blocked += 1;
      return { outcome: 'blocked', plan: blockedPlan };
    }
  }

  const withEvidence = await writeValidationEvidence(rootDir, state, plan, results);
  return { outcome: 'passed', plan: withEvidence, results };
}

async function finalizeCompletedPlan(rootDir, state, plan, validationResults) {
  const evidenceIndexPath = path.join(rootDir, EVIDENCE_INDEX_DIR, `${plan.planId}.md`);
  await fs.mkdir(path.dirname(evidenceIndexPath), { recursive: true });
  const evidenceIndexRel = toPosix(path.relative(rootDir, evidenceIndexPath));
  const evidenceIndexContent = [
    `# Evidence Index: ${plan.planId}`,
    '',
    `- Run-ID: ${state.runId}`,
    `- Completed At: ${nowIso()}`,
    `- Plan File: ${plan.rel}`,
    '',
    '## Validation Results',
    ...validationResults.flatMap((result) => ([
      `- ${result.id} (${result.lane})`,
      `  - log: ${result.logRel}`,
      `  - result: ${result.resultRel}`
    ]))
  ].join('\n');
  await fs.writeFile(evidenceIndexPath, `${evidenceIndexContent}\n`, 'utf8');

  let content = setPlanDocumentFields(plan.content, {
    Status: 'completed',
    'Done-Evidence': evidenceIndexRel
  });
  content = upsertSection(content, 'Closure', [
    `- Completed At: ${nowIso()}`,
    `- Run-ID: ${state.runId}`,
    '- Outcome: completed'
  ]);
  content = appendToDeliveryLog(content, `Completed in ${state.runId}.`);

  const targetPath = path.join(rootDir, COMPLETED_DIR, path.basename(plan.filePath));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
  await rewritePerPlanActiveEvidence(rootDir, plan, path.relative(rootDir, targetPath));
  await fs.unlink(plan.filePath);
  state.completedPlanIds = [...new Set([...state.completedPlanIds, plan.planId])];
  state.blockedPlanIds = state.blockedPlanIds.filter((entry) => entry !== plan.planId);
  state.failedPlanIds = state.failedPlanIds.filter((entry) => entry !== plan.planId);
  state.stats.completed += 1;
  await appendRunEvent(rootDir, state, 'plan_completed', plan.planId, {
    target: toPosix(path.relative(rootDir, targetPath)),
    evidenceIndex: evidenceIndexRel
  });
  return {
    ...plan,
    phase: 'completed',
    filePath: targetPath,
    rel: toPosix(path.relative(rootDir, targetPath)),
    content,
    status: 'completed',
    doneEvidence: evidenceIndexRel
  };
}

async function refreshPlan(rootDir, plan) {
  return readPlan(plan.filePath, plan.phase, rootDir);
}

async function readLatestCheckpoint(rootDir, runId, planId) {
  return readJson(runtimePaths(rootDir, runId, planId).checkpointPath, null);
}

function checkpointRequestsWorkerContinuation(checkpoint) {
  const role = String(checkpoint?.role ?? '').trim().toLowerCase();
  const status = String(checkpoint?.status ?? '').trim().toLowerCase();
  return role === ROLE_REVIEWER && (status === 'pending' || status === 'handoff_required');
}

async function executePlan(rootDir, config, state, initialPlan, logging, sessionLimit, options) {
  let plan = initialPlan;
  const planRoles = rolesForPlan(plan, config);
  const reviewerEnabled = planRoles.includes(ROLE_REVIEWER);

  while ((state.planSessions[plan.planId] ?? 0) < sessionLimit) {
    plan = await refreshPlan(rootDir, plan);
    const mustLandSatisfied = mustLandComplete(plan.content);
    const latestCheckpoint = await readLatestCheckpoint(rootDir, state.runId, plan.planId);
    const reviewerRequestedWorkerContinuation =
      plan.status === 'in-progress' &&
      mustLandSatisfied &&
      checkpointRequestsWorkerContinuation(latestCheckpoint);

    if (securityApprovalRequired(plan, config) && plan.securityApproval !== 'approved') {
      plan = await markPlanBlocked(
        rootDir,
        plan,
        `Security-Approval must be approved before executing ${plan.planId}.`,
        `Blocked ${plan.planId} pending security approval in ${state.runId}.`
      );
      state.blockedPlanIds = [...new Set([...state.blockedPlanIds, plan.planId])];
      state.stats.blocked += 1;
      await appendRunEvent(rootDir, state, 'plan_blocked', plan.planId, {
        reason: 'missing security approval'
      });
      logLine(
        logging,
        `plan blocked plan=${plan.planId} reason=${sanitizeLogNarrative(`Security approval required before executing ${plan.planId}.`)}`,
        'err'
      );
      return 'blocked';
    }

    if (plan.status === 'blocked') {
      state.blockedPlanIds = [...new Set([...state.blockedPlanIds, plan.planId])];
      logLine(logging, `plan blocked plan=${plan.planId} reason=plan already marked blocked`, 'err');
      return 'blocked';
    }

    if (plan.status === 'validation') {
      const validation = await runValidation(rootDir, config, state, plan, logging);
      if (validation.outcome === 'blocked') {
        return 'blocked';
      }
      const completedPlan = await finalizeCompletedPlan(rootDir, state, validation.plan, validation.results);
      if (commitEnabled(config, options)) {
        const commitResult = createAtomicCommit(rootDir, completedPlan, config);
        if (!commitResult.ok) {
          await appendRunEvent(rootDir, state, 'plan_commit_failed', completedPlan.planId, {
            reason: commitResult.reason ?? 'atomic commit failed'
          });
          throw new Error(commitResult.reason ?? `Atomic commit failed for ${completedPlan.planId}.`);
        }
        if (commitResult.committed) {
          state.stats.commits += 1;
          await appendRunEvent(rootDir, state, 'plan_committed', completedPlan.planId, {
            commitHash: commitResult.commitHash
          });
          logLine(logging, `committed ${completedPlan.planId}${commitResult.commitHash ? ` ${commitResult.commitHash.slice(0, 7)}` : ''}`, 'ok');
        }
      }
      logLine(logging, `plan completed plan=${completedPlan.planId} status=completed`, 'ok');
      return 'completed';
    }

    if (mustLandSatisfied && plan.status !== 'in-review' && !reviewerRequestedWorkerContinuation) {
      if (planRoles.includes(ROLE_REVIEWER)) {
        plan = await updatePlanStatus(rootDir, plan, 'in-review', `Queued review for ${plan.planId} in ${state.runId}.`);
        continue;
      }
      if (plan.status !== 'validation') {
        plan = await updatePlanStatus(rootDir, plan, 'validation', `Queued validation in ${state.runId}.`);
      }
      const validation = await runValidation(rootDir, config, state, plan, logging);
      if (validation.outcome === 'blocked') {
        return 'blocked';
      }
      const completedPlan = await finalizeCompletedPlan(rootDir, state, validation.plan, validation.results);
      if (commitEnabled(config, options)) {
        const commitResult = createAtomicCommit(rootDir, completedPlan, config);
        if (!commitResult.ok) {
          await appendRunEvent(rootDir, state, 'plan_commit_failed', completedPlan.planId, {
            reason: commitResult.reason ?? 'atomic commit failed'
          });
          throw new Error(commitResult.reason ?? `Atomic commit failed for ${completedPlan.planId}.`);
        }
        if (commitResult.committed) {
          state.stats.commits += 1;
          await appendRunEvent(rootDir, state, 'plan_committed', completedPlan.planId, {
            commitHash: commitResult.commitHash
          });
          logLine(logging, `committed ${completedPlan.planId}${commitResult.commitHash ? ` ${commitResult.commitHash.slice(0, 7)}` : ''}`, 'ok');
        }
      }
      logLine(logging, `plan completed plan=${completedPlan.planId} status=completed`, 'ok');
      return 'completed';
    }

    const role = plan.status === 'in-review' ? ROLE_REVIEWER : ROLE_WORKER;
    if (role === ROLE_REVIEWER && !planRoles.includes(ROLE_REVIEWER)) {
      plan = await updatePlanStatus(rootDir, plan, 'validation', `Queued validation in ${state.runId}.`);
      logLine(logging, `role transition plan=${plan.planId} from=reviewer to=validation reason=review lane not configured`, 'warn');
      continue;
    }
    if (role === ROLE_WORKER && plan.status === 'queued') {
      plan = await updatePlanStatus(rootDir, plan, 'in-progress', `Worker started in ${state.runId}.`);
    }

    const nextSessionNumber = (state.planSessions[plan.planId] ?? 0) + 1;
    await appendRunEvent(rootDir, state, 'session_started', plan.planId, { role });
    logLine(
      logging,
      `session start plan=${plan.planId} role=${role} session=${nextSessionNumber} status=${plan.status} risk=${plan.riskTier} model=${safeDisplayToken(config?.executor?.roles?.[role]?.model, 'n/a')} reasoning=${safeDisplayToken(config?.executor?.roles?.[role]?.reasoningEffort, 'n/a')}`
    );
    const session = await executeRole(rootDir, config, state, plan, role, logging);
    plan = await refreshPlan(rootDir, plan);
    logLine(
      logging,
      `session end plan=${plan.planId} role=${role} session=${session.sessionNumber} status=${session.result.status} contextRemaining=${Number.isFinite(session.result.contextRemaining) ? session.result.contextRemaining : 'unknown'} nextAction=${session.result.nextAction || 'none'}`,
      session.result.status === 'blocked' ? 'err' : session.result.status === 'handoff_required' || session.result.status === 'pending' ? 'warn' : 'ok'
    );
    logLine(
      logging,
      `session artifacts plan=${plan.planId} role=${role} session=${session.sessionNumber} checkpoint=${session.checkpointRefs.checkpointRel} handoff=${session.checkpointRefs.handoffRel} log=${session.logRel}`
    );
    const contextBudget = analyzeContextBudget(session.result, config);
    if (contextBudget.triggered && !roleBoundaryComplete(plan, role) && session.result.status !== 'blocked') {
      session.result.status = 'handoff_required';
      session.result.reason = session.result.reason || contextBudget.reason;
      session.checkpointRefs = await writeCheckpoint(
        rootDir,
        state.runId,
        plan,
        role,
        session.sessionNumber,
        session.result
      );
      await appendRunEvent(rootDir, state, 'context_budget_low', plan.planId, {
        role,
        session: session.sessionNumber,
        contextRemaining: contextBudget.remaining,
        contextRemainingPercent: contextBudget.percent,
        minRemaining: contextBudget.minRemaining,
        minRemainingPercent: contextBudget.minRemainingPercent
      });
      await appendRunEvent(rootDir, state, 'session_handoff_forced', plan.planId, {
        role,
        session: session.sessionNumber,
        status: session.result.status,
        reason: session.result.reason,
        checkpoint: session.checkpointRefs.checkpointRel,
        handoff: session.checkpointRefs.handoffRel
      });
      logLine(
        logging,
        `session handoff plan=${plan.planId} role=${role} session=${session.sessionNumber} reason=${sanitizeLogNarrative(session.result.reason, 'context threshold reached')} checkpoint=${session.checkpointRefs.checkpointRel} handoff=${session.checkpointRefs.handoffRel}`,
        'warn'
      );
    }

    if (plan.status === 'blocked' || session.result.status === 'blocked') {
      const failureTail = tailLines(executionOutput(session.execution), logging.failureTailLines);
      logLine(logging, `${role} blocked ${plan.planId}`, 'err');
      if (failureTail) {
        logLine(logging, `session failure tail:\n${failureTail}`, 'warn');
      }
      plan = await markPlanBlocked(
        rootDir,
        plan,
        session.result.reason || session.result.summary || 'Blocked during execution.',
        `${role} blocked ${plan.planId} in ${state.runId}.`
      );
      state.blockedPlanIds = [...new Set([...state.blockedPlanIds, plan.planId])];
      state.stats.blocked += 1;
      await appendRunEvent(rootDir, state, 'plan_blocked', plan.planId, {
        role,
        reason: session.result.reason || session.result.summary || 'Blocked during execution.'
      });
      logLine(logging, `plan blocked plan=${plan.planId} reason=${session.result.reason || session.result.summary || 'blocked during execution'}`, 'err');
      return 'blocked';
    }

    if (session.result.status === 'pending' || session.result.status === 'handoff_required') {
      const nextRole = ROLE_WORKER;
      logLine(
        logging,
        `session pending plan=${plan.planId} role=${role} session=${session.sessionNumber} nextRole=${nextRole} reason=${sanitizeLogNarrative(session.result.reason || session.result.summary, 'executor requested continuation')} checkpoint=${session.checkpointRefs.checkpointRel} handoff=${session.checkpointRefs.handoffRel}`,
        'warn'
      );
      if (role === ROLE_REVIEWER) {
        plan = await updatePlanStatus(rootDir, plan, 'in-progress', `Reviewer handed ${plan.planId} back to worker in ${state.runId}.`);
      } else {
        plan = await updatePlanStatus(rootDir, plan, 'in-progress', `Worker checkpointed ${plan.planId} in ${state.runId}.`);
      }
      logLine(logging, `plan continuation plan=${plan.planId} status=in-progress nextRole=${nextRole}`, 'warn');
      return 'requeued';
    }

    if (role === ROLE_WORKER) {
      if (mustLandComplete(plan.content) && reviewerEnabled) {
        plan = await updatePlanStatus(rootDir, plan, 'in-review', `Worker completed must-land scope for ${plan.planId} in ${state.runId}.`);
        logLine(logging, `role transition plan=${plan.planId} from=worker to=reviewer reason=must-land scope complete`, 'ok');
        continue;
      }
      if (mustLandComplete(plan.content)) {
        plan = await updatePlanStatus(rootDir, plan, 'validation', `Worker completed must-land scope for ${plan.planId} in ${state.runId}.`);
        logLine(logging, `role transition plan=${plan.planId} from=worker to=validation reason=must-land scope complete`, 'ok');
        continue;
      }
      plan = await updatePlanStatus(rootDir, plan, 'in-progress', `Worker session completed for ${plan.planId} in ${state.runId}.`);
      logLine(
        logging,
        `plan continuation plan=${plan.planId} status=in-progress nextRole=worker reason=${sanitizeLogNarrative(session.result.nextAction || session.result.summary, 'implementation slice still open')}`
      );
      return 'requeued';
    }

    if (role === ROLE_REVIEWER) {
      if (mustLandComplete(plan.content)) {
        plan = await updatePlanStatus(rootDir, plan, 'validation', `Reviewer approved ${plan.planId} in ${state.runId}.`);
        logLine(logging, `role transition plan=${plan.planId} from=reviewer to=validation reason=review approved`, 'ok');
        continue;
      }
      plan = await updatePlanStatus(rootDir, plan, 'in-progress', `Reviewer requested more work for ${plan.planId} in ${state.runId}.`);
      logLine(
        logging,
        `role transition plan=${plan.planId} from=reviewer to=worker reason=${sanitizeLogNarrative(session.result.reason || session.result.summary, 'review requested more work')}`,
        'warn'
      );
      return 'requeued';
    }
  }

  plan = await markPlanBlocked(
    rootDir,
    plan,
    `Session budget exhausted after ${sessionLimit} sessions.`,
    `Budget exhausted for ${plan.planId} in ${state.runId}.`
  );
  state.blockedPlanIds = [...new Set([...state.blockedPlanIds, plan.planId])];
  state.stats.blocked += 1;
  logLine(logging, `plan blocked plan=${plan.planId} reason=${sanitizeLogNarrative(`Session budget exhausted after ${sessionLimit} sessions.`)}`, 'err');
  return 'blocked';
}

async function promoteNextReadyFuture(rootDir, state, plans, maxRisk, logging) {
  const completedPlanIds = new Set(plans.filter((plan) => plan.phase === 'completed').map((plan) => plan.planId));
  const futurePlans = orderPlans(plans.filter((plan) => plan.phase === 'future' && plan.status === 'ready-for-promotion'));
  for (const plan of futurePlans) {
    if (!riskAllowed(plan, maxRisk)) {
      continue;
    }
    if (!dependenciesComplete(plan, completedPlanIds)) {
      continue;
    }
    await promoteFuturePlan(rootDir, state, plan, logging);
    return true;
  }
  return false;
}

function actionableActivePlans(plans, completedPlanIds, maxRisk, config) {
  return orderPlans(
    plans.filter((plan) => (
      plan.phase === 'active' &&
      ACTIVE_STATUSES.has(plan.status) &&
      plan.status !== 'blocked' &&
      riskAllowed(plan, maxRisk) &&
      dependenciesComplete(plan, completedPlanIds) &&
      !(securityApprovalRequired(plan, config) && plan.securityApproval !== 'approved')
    ))
  );
}

function emptyQueueSummary(plans, completedPlanIds, maxRisk, config) {
  const futureDraftCount = plans.filter((plan) => plan.phase === 'future' && plan.status === 'draft').length;
  const futureReady = plans.filter((plan) => plan.phase === 'future' && plan.status === 'ready-for-promotion');
  const futureReadyExcludedByRisk = futureReady.filter((plan) => !riskAllowed(plan, maxRisk)).length;
  const futureReadyWaitingOnDependencies = futureReady.filter((plan) => (
    riskAllowed(plan, maxRisk) &&
    !dependenciesComplete(plan, completedPlanIds)
  )).length;
  const activeCandidates = plans.filter((plan) => (
    plan.phase === 'active' &&
    ACTIVE_STATUSES.has(plan.status) &&
    plan.status !== 'blocked'
  ));
  const activeExcludedByRisk = activeCandidates.filter((plan) => !riskAllowed(plan, maxRisk)).length;
  const activeWaitingOnDependencies = activeCandidates.filter((plan) => (
    riskAllowed(plan, maxRisk) &&
    !dependenciesComplete(plan, completedPlanIds)
  )).length;
  const activeWaitingOnSecurityApproval = activeCandidates.filter((plan) => (
    riskAllowed(plan, maxRisk) &&
    dependenciesComplete(plan, completedPlanIds) &&
    securityApprovalRequired(plan, config) &&
    plan.securityApproval !== 'approved'
  )).length;
  const parts = [`no eligible plans for maxRisk=${maxRisk}`];

  if (futureDraftCount > 0) {
    parts.push(`future draft=${futureDraftCount}`);
  }
  if (futureReadyExcludedByRisk > 0) {
    parts.push(`future excluded by risk=${futureReadyExcludedByRisk}`);
  }
  if (futureReadyWaitingOnDependencies > 0) {
    parts.push(`future waiting on deps=${futureReadyWaitingOnDependencies}`);
  }
  if (activeExcludedByRisk > 0) {
    parts.push(`active excluded by risk=${activeExcludedByRisk}`);
  }
  if (activeWaitingOnDependencies > 0) {
    parts.push(`active waiting on deps=${activeWaitingOnDependencies}`);
  }
  if (activeWaitingOnSecurityApproval > 0) {
    parts.push(`active waiting on security approval=${activeWaitingOnSecurityApproval}`);
  }
  if ((futureReadyExcludedByRisk > 0 || activeExcludedByRisk > 0) && maxRisk !== 'high') {
    parts.push('rerun with -- --max-risk high if that is intentional');
  }

  return parts.join(' | ');
}

async function processQueue(rootDir, config, state, options) {
  const maxRisk = normalizeMaxRisk(options['max-risk'] ?? options.maxRisk ?? state.maxRisk ?? config?.risk?.defaultMaxRisk ?? DEFAULT_MAX_RISK);
  state.maxRisk = maxRisk;
  const maxPlans = Math.max(0, asInteger(options['max-plans'] ?? options.maxPlans, DEFAULT_MAX_PLANS));
  const sessionLimit = maxSessionsPerPlan(config, options);
  const logging = resolveLogging(config, options);
  let processedPlans = 0;

  while (maxPlans === 0 || processedPlans < maxPlans) {
    let refreshedPlans = await collectPlans(rootDir);
    let completedPlanIds = new Set(refreshedPlans.filter((plan) => plan.phase === 'completed').map((plan) => plan.planId));
    let queue = actionableActivePlans(refreshedPlans, completedPlanIds, maxRisk, config);
    if (queue.length === 0) {
      const promoted = await promoteNextReadyFuture(rootDir, state, refreshedPlans, maxRisk, logging);
      if (promoted) {
        refreshedPlans = await collectPlans(rootDir);
        completedPlanIds = new Set(refreshedPlans.filter((plan) => plan.phase === 'completed').map((plan) => plan.planId));
        queue = actionableActivePlans(refreshedPlans, completedPlanIds, maxRisk, config);
      }
    }

    state.completedPlanIds = [...completedPlanIds];
    state.blockedPlanIds = refreshedPlans
      .filter((plan) => plan.phase === 'active' && plan.status === 'blocked')
      .map((plan) => plan.planId);
    state.queue = queue.map((plan) => plan.planId);
    await saveRunState(rootDir, state);

    const overview = buildQueueOverview(refreshedPlans, completedPlanIds, queue, maxRisk);
    logQueueOverview(logging, state, overview, queue.length === 0 ? 'queue overview' : 'queue focus');

    if (queue.length === 0) {
      logLine(logging, emptyQueueSummary(refreshedPlans, completedPlanIds, maxRisk, config), 'warn');
      break;
    }

      const plan = queue[0];
      const planRoles = rolesForPlan(plan, config);
      const nextSessionNumber = (state.planSessions[plan.planId] ?? 0) + 1;
      const displaySessionNumber = Math.min(nextSessionNumber, sessionLimit);
      logLine(
        logging,
        `plan start plan=${plan.planId} status=${plan.status} priority=${plan.priority} risk=${plan.riskTier} queueDepth=${queue.length} session=${displaySessionNumber}/${sessionLimit} roles=${planRoles.join('->')} validation=${plan.validationLanes.join(',') || 'none'}`
      );
      state.activePlanId = plan.planId;
      await saveRunState(rootDir, state);
      const outcome = await executePlan(rootDir, config, state, plan, logging, sessionLimit, options);
      processedPlans += 1;
      state.activePlanId = null;
      await saveRunState(rootDir, state);
      if (outcome === 'blocked') {
        break;
      }
    }
  return processedPlans;
}

async function audit(rootDir, options) {
  const plans = await collectPlans(rootDir);
  const runState = await readJson(path.join(rootDir, RUN_STATE_PATH), null);
  const summary = {
    future: {
      draft: plans.filter((plan) => plan.phase === 'future' && plan.status === 'draft').map((plan) => plan.planId),
      ready: plans.filter((plan) => plan.phase === 'future' && plan.status === 'ready-for-promotion').map((plan) => plan.planId)
    },
    active: {
      queued: plans.filter((plan) => plan.phase === 'active' && plan.status === 'queued').map((plan) => plan.planId),
      inProgress: plans.filter((plan) => plan.phase === 'active' && plan.status === 'in-progress').map((plan) => plan.planId),
      inReview: plans.filter((plan) => plan.phase === 'active' && plan.status === 'in-review').map((plan) => plan.planId),
      blocked: plans.filter((plan) => plan.phase === 'active' && plan.status === 'blocked').map((plan) => ({
        planId: plan.planId,
        blocker: sectionBody(plan.content, 'Blockers').split('\n').find((line) => line.trim().startsWith('- '))?.replace(/^- /, '') ?? 'none'
      })),
      validation: plans.filter((plan) => plan.phase === 'active' && plan.status === 'validation').map((plan) => plan.planId)
    },
    completed: plans.filter((plan) => plan.phase === 'completed').map((plan) => plan.planId),
    runState
  };

  if (asBoolean(options.json, false)) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`future draft: ${summary.future.draft.join(', ') || 'none'}`);
  console.log(`future ready: ${summary.future.ready.join(', ') || 'none'}`);
  console.log(`active queued: ${summary.active.queued.join(', ') || 'none'}`);
  console.log(`active in-progress: ${summary.active.inProgress.join(', ') || 'none'}`);
  console.log(`active in-review: ${summary.active.inReview.join(', ') || 'none'}`);
  console.log(`active validation: ${summary.active.validation.join(', ') || 'none'}`);
  console.log(`active blocked: ${summary.active.blocked.map((entry) => `${entry.planId} (${entry.blocker})`).join(', ') || 'none'}`);
  console.log(`completed: ${summary.completed.join(', ') || 'none'}`);
}

async function main() {
  const rootDir = process.cwd();
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === 'audit') {
    await audit(rootDir, options);
    return;
  }

  if (!['run', 'resume', 'grind'].includes(command)) {
    throw new Error(`Unsupported command '${command}'. Use run, resume, grind, or audit.`);
  }

  const config = await loadConfig(rootDir);
  if (commitEnabled(config, options) && !gitAvailable(rootDir)) {
    throw new Error('Atomic commits are enabled, but this repository is not inside a git work tree. Run with --commit false or initialize git first.');
  }
  if ((command === 'run' || command === 'grind') && dirtyRepoPaths(rootDir, { includeTransient: false }).length > 0) {
    throw new Error('Refusing to start ' + command + ' with a dirty worktree. Commit, stash, or discard unrelated changes first, or use resume if you intend to continue the existing run.');
  }
  const maxRisk = normalizeMaxRisk(options['max-risk'] ?? options.maxRisk ?? config?.risk?.defaultMaxRisk ?? DEFAULT_MAX_RISK);
  const state = await loadRunState(rootDir, maxRisk, command);
  const logging = resolveLogging(config, options);
  await appendRunEvent(rootDir, state, command === 'resume' ? 'run_resumed' : 'run_started', null, { maxRisk });
  logLine(
    logging,
    `${command} runId=${state.runId} maxRisk=${maxRisk} output=${logging.mode} heartbeat=${logging.heartbeatSeconds}s stallWarn=${logging.stallWarnSeconds}s sessionLimit=${maxSessionsPerPlan(config, options)} commit=${commitEnabled(config, options) ? 'atomic' : 'off'}`
  );
  const startingPlans = await collectPlans(rootDir);
  const startingCompleted = new Set(startingPlans.filter((plan) => plan.phase === 'completed').map((plan) => plan.planId));
  const startingQueue = actionableActivePlans(startingPlans, startingCompleted, maxRisk, config);
  const startingOverview = buildQueueOverview(startingPlans, startingCompleted, startingQueue, maxRisk);
  if (logging.mode === 'pretty') {
    printSummaryBlock(logging, `${command.toUpperCase()} OVERVIEW`, [
      ['runId', state.runId],
      ['max risk', maxRisk],
      ['next', startingOverview.nextPlanId],
      ['queue', startingOverview.queueCount],
      ['future ready', `${startingOverview.futureReadyCount} (${startingOverview.futureReadyPreview})`],
      ['future draft', `${startingOverview.futureDraftCount} (${startingOverview.futureDraftPreview})`],
      ['active queued', `${startingOverview.activeQueuedCount} (${startingOverview.activeQueuedPreview})`],
      ['active in-progress', `${startingOverview.activeInProgressCount} (${startingOverview.activeInProgressPreview})`],
      ['active in-review', `${startingOverview.activeInReviewCount} (${startingOverview.activeInReviewPreview})`],
      ['active validation', `${startingOverview.activeValidationCount} (${startingOverview.activeValidationPreview})`],
      ['active blocked', `${startingOverview.activeBlockedCount} (${startingOverview.activeBlockedPreview})`],
      ['completed', startingOverview.completedCount]
    ]);
  } else {
    logQueueOverview(logging, state, startingOverview, `${command} overview`);
  }
  const startedAtMs = Date.parse(state.startedAt) || Date.now();
  const processedPlans = await processQueue(rootDir, config, state, options);
  await saveRunState(rootDir, state);
  await appendRunEvent(rootDir, state, 'run_finished', null, {
    completed: state.completedPlanIds.length,
    blocked: state.blockedPlanIds.length,
    queue: state.queue.length,
    commits: state.stats.commits
  });
  const endingPlans = await collectPlans(rootDir);
  const endingCompleted = new Set(endingPlans.filter((plan) => plan.phase === 'completed').map((plan) => plan.planId));
  const endingQueue = actionableActivePlans(endingPlans, endingCompleted, maxRisk, config);
  const endingOverview = buildQueueOverview(endingPlans, endingCompleted, endingQueue, maxRisk);
  printRunSummary(
    logging,
    command,
    state,
    processedPlans,
    Math.max(0, (Date.now() - startedAtMs) / 1000),
    endingOverview
  );
  logLine(
    logging,
    `finished runId=${state.runId} queue=${state.queue.length} completed=${state.completedPlanIds.length} blocked=${state.blockedPlanIds.length} commits=${state.stats.commits}`,
    'ok'
  );
}

main().catch((error) => {
  console.error('[orchestrator] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
