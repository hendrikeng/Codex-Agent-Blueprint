#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { compileTaskContactPack } from './compile-task-contact-pack.mjs';
import {
  ACTIVE_STATUSES,
  isValidPlanId,
  listMarkdownFiles,
  metadataValue,
  normalizeStatus,
  parsePlanId,
  parseRiskTier,
  parseSecurityApproval,
  parseListField,
  parseMetadata,
  parsePriority,
  priorityOrder,
  setMetadataFields,
  todayIsoDate,
  inferPlanId
} from './lib/plan-metadata.mjs';

const DEFAULT_CONTEXT_THRESHOLD = 10000;
const DEFAULT_HANDOFF_TOKEN_BUDGET = 1500;
const DEFAULT_MAX_ROLLOVERS = 20;
const DEFAULT_MAX_SESSIONS_PER_PLAN = 12;
const DEFAULT_HANDOFF_EXIT_CODE = 75;
const DEFAULT_REQUIRE_RESULT_PAYLOAD = true;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 1800;
const DEFAULT_RUNTIME_CONTEXT_PATH = 'docs/generated/agent-runtime-context.md';
const DEFAULT_HOST_VALIDATION_MODE = 'hybrid';
const DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS = 1800;
const DEFAULT_HOST_VALIDATION_POLL_SECONDS = 15;
const DEFAULT_OUTPUT_MODE = 'pretty';
const DEFAULT_FAILURE_TAIL_LINES = 60;
const PRETTY_SPINNER_FRAMES = ['|', '/', '-', '\\'];
const PRETTY_LIVE_DOT_FRAMES = ['...', '.. ', '.  ', ' ..'];
const DEFAULT_HEARTBEAT_SECONDS = 12;
const DEFAULT_STALL_WARN_SECONDS = 120;
const DEFAULT_TOUCH_SUMMARY = true;
const DEFAULT_TOUCH_SAMPLE_SIZE = 3;
const DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS = 180;
const DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT = 1;
const DEFAULT_CONTACT_PACKS_ENABLED = true;
const DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS = 10;
const DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE = true;
const DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS = 6;
const DEFAULT_RETRY_FAILED_PLANS = true;
const DEFAULT_AUTO_UNBLOCK_PLANS = true;
const DEFAULT_MAX_FAILED_RETRIES = 3;
const DEFAULT_PARALLEL_PLANS = 1;
const DEFAULT_PARALLEL_WORKTREE_ROOT = 'docs/ops/automation/runtime/worktrees';
const DEFAULT_PARALLEL_BRANCH_PREFIX = 'orch';
const DEFAULT_PARALLEL_BASE_REF = 'HEAD';
const DEFAULT_PARALLEL_GIT_REMOTE = 'origin';
const DEFAULT_PARALLEL_WORKER_OUTPUT = 'minimal';
const DEFAULT_PARALLEL_KEEP_WORKTREES = false;
const DEFAULT_PARALLEL_PUSH_BRANCHES = false;
const DEFAULT_PARALLEL_OPEN_PULL_REQUESTS = false;
const DEFAULT_PARALLEL_ASSUME_DEPENDENCY_COMPLETION = false;
let prettySpinnerIndex = 0;
let prettyLiveDotIndex = 0;
let liveStatusLineLength = 0;
const DEFAULT_EVIDENCE_MAX_REFERENCES = 25;
const DEFAULT_EVIDENCE_TRACK_MODE = 'curated';
const DEFAULT_EVIDENCE_DEDUP_MODE = 'strict-upsert';
const DEFAULT_EVIDENCE_PRUNE_ON_COMPLETE = true;
const DEFAULT_EVIDENCE_KEEP_MAX_PER_BLOCKER = 1;
const DEFAULT_ROLE_ORCHESTRATION_ENABLED = true;
const DEFAULT_RISK_THRESHOLD_MEDIUM = 3;
const DEFAULT_RISK_THRESHOLD_HIGH = 6;
const DEFAULT_RISK_WEIGHT_DECLARED_MEDIUM = 2;
const DEFAULT_RISK_WEIGHT_DECLARED_HIGH = 4;
const DEFAULT_RISK_WEIGHT_DEPENDENCY = 1;
const DEFAULT_RISK_WEIGHT_SENSITIVE_TAG = 2;
const DEFAULT_RISK_WEIGHT_SENSITIVE_PATH = 2;
const DEFAULT_RISK_WEIGHT_AUTONOMY_FULL = 1;
const DEFAULT_RISK_WEIGHT_VALIDATION_FAILURE = 2;
const DEFAULT_STAGE_REUSE_ENABLED = true;
const DEFAULT_STAGE_REUSE_SAME_RUN_ONLY = false;
const DEFAULT_STAGE_REUSE_REQUIRES_STABLE_PLAN_HASH = true;
const DEFAULT_STAGE_REUSE_REQUIRES_NO_SCOPE_CHANGE = true;
const DEFAULT_STAGE_REUSE_MAX_AGE_MINUTES = 60;
const DEFAULT_STAGE_BUDGET_PLANNER_SECONDS = 300;
const DEFAULT_STAGE_BUDGET_EXPLORER_SECONDS = 300;
const DEFAULT_STAGE_BUDGET_REVIEWER_SECONDS = 420;
const ROLE_PLANNER = 'planner';
const ROLE_EXPLORER = 'explorer';
const ROLE_WORKER = 'worker';
const ROLE_REVIEWER = 'reviewer';
const ROLE_NAMES = new Set([ROLE_PLANNER, ROLE_EXPLORER, ROLE_WORKER, ROLE_REVIEWER]);
const SECURITY_APPROVAL_NOT_REQUIRED = 'not-required';
const SECURITY_APPROVAL_PENDING = 'pending';
const SECURITY_APPROVAL_APPROVED = 'approved';
const RISK_TIER_ORDER = {
  low: 0,
  medium: 1,
  high: 2
};
const EVIDENCE_NOISE_TOKENS = new Set([
  'after',
  'additional',
  'attempt',
  'continuation',
  'current',
  'follow',
  'following',
  'final',
  'further',
  'latest',
  'next',
  'post',
  'progress',
  'refresh',
  'rerun',
  'retry',
  'step',
  'up'
]);
const TRANSIENT_AUTOMATION_FILES = new Set([
  'docs/ops/automation/run-state.json',
  'docs/ops/automation/run-events.jsonl'
]);
const TRANSIENT_AUTOMATION_DIR_PREFIXES = [
  'docs/ops/automation/runtime/',
  'docs/ops/automation/handoffs/'
];
const SAFE_PLAN_RELATIVE_PATH_REGEX = /^[A-Za-z0-9._/-]+$/;
const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_REGEX = /(token|secret|password|passphrase|api[-_]?key|authorization|cookie|session)/i;

function usage() {
  console.log(`Usage:
  node ./scripts/automation/orchestrator.mjs run [options]
  node ./scripts/automation/orchestrator.mjs run-parallel [options]
  node ./scripts/automation/orchestrator.mjs resume-parallel [options]
  node ./scripts/automation/orchestrator.mjs resume [options]
  node ./scripts/automation/orchestrator.mjs audit [options]
  node ./scripts/automation/orchestrator.mjs curate-evidence [options]

Options:
  --mode guarded|full                Autonomy mode (default: guarded)
  --max-plans <n>                    Maximum plans to process in this run
  --parallel-plans <n>               Number of plans to execute in parallel (default: 1)
  --context-threshold <n>            Trigger rollover when contextRemaining < n
  --require-result-payload true|false Require ORCH_RESULT_PATH payload with contextRemaining (default: true)
  --handoff-token-budget <n>         Metadata field for handoff budget reporting
  --max-rollovers <n>                Maximum rollovers per plan (default: 20)
  --max-sessions-per-plan <n>        Maximum executor sessions per plan in one run (default: 12)
  --validation "cmd1;;cmd2"          Validation commands separated by ';;'
  --commit true|false                Create atomic git commit per completed plan
  --skip-promotion true|false        Skip future->active promotion stage
  --allow-dirty true|false           Allow starting with dirty git worktree
  --run-id <id>                      Resume or audit a specific run id
  --plan-id <id>                     Filter curation scope to paths containing this value
  --scope active|completed|all       Curation scope for curate-evidence (default: all)
  --dry-run true|false               Do not write changes or run git commits
  --json true|false                  JSON output for audit
  --output minimal|ticker|pretty|verbose Console output mode (default: pretty)
  --failure-tail-lines <n>           Lines of command output to print on failures (default: 60)
  --heartbeat-seconds <n>            Live status heartbeat cadence in seconds (default: 12)
  --stall-warn-seconds <n>           Warn when no command output for this many seconds (default: 120)
  --touch-summary true|false         Show live touched-file summary in heartbeats (default: true)
  --touch-sample-size <n>            Number of touched-file examples in heartbeat details (default: 3)
  --worker-first-touch-deadline-seconds <n> Fail-fast worker sessions that make no edits after n seconds (default: 180, 0 disables)
  --worker-no-touch-retry-limit <n> Retry worker pending-without-edits sessions automatically up to n times (default: 1)
  --retry-failed true|false          Retry failed plans automatically when policy gates allow (default: true)
  --auto-unblock true|false          Auto-unblock blocked plans when policy gates are now satisfied (default: true)
  --max-failed-retries <n>           Maximum automatic retries per failed plan (default: 3)
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return { command, options };
}

function asBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function asInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOutputMode(value, fallback = DEFAULT_OUTPUT_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'ticker') {
    return 'ticker';
  }
  if (normalized === 'pretty') {
    return 'pretty';
  }
  if (normalized === 'verbose') {
    return 'verbose';
  }
  return 'minimal';
}

function shouldCaptureCommandOutput(options) {
  return normalizeOutputMode(options?.outputMode, DEFAULT_OUTPUT_MODE) !== 'verbose';
}

function isTickerOutput(options) {
  return normalizeOutputMode(options?.outputMode, DEFAULT_OUTPUT_MODE) === 'ticker';
}

function isPrettyOutput(options) {
  return normalizeOutputMode(options?.outputMode, DEFAULT_OUTPUT_MODE) === 'pretty';
}

function canUseColor(options) {
  if (!isPrettyOutput(options)) {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  if (String(process.env.NO_COLOR ?? '').trim() !== '') {
    return false;
  }
  if (String(process.env.CI ?? '').trim() !== '') {
    return false;
  }
  return String(process.env.TERM ?? '').trim().toLowerCase() !== 'dumb';
}

function colorize(options, code, text) {
  if (!canUseColor(options)) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

function nextPrettySpinner(options) {
  if (!process.stdout.isTTY) {
    return '.';
  }
  const frame = PRETTY_SPINNER_FRAMES[prettySpinnerIndex % PRETTY_SPINNER_FRAMES.length];
  prettySpinnerIndex += 1;
  return colorize(options, '36', frame);
}

function nextPrettyLiveDots(options) {
  if (!process.stdout.isTTY) {
    return '...';
  }
  const frame = PRETTY_LIVE_DOT_FRAMES[prettyLiveDotIndex % PRETTY_LIVE_DOT_FRAMES.length];
  prettyLiveDotIndex += 1;
  return colorize(options, '36', frame);
}

function supportsLiveStatusLine(options) {
  return isPrettyOutput(options) && process.stdout.isTTY;
}

function clearLiveStatusLine() {
  if (!process.stdout.isTTY || liveStatusLineLength <= 0) {
    return;
  }
  process.stdout.write(`\r${' '.repeat(liveStatusLineLength)}\r`);
  liveStatusLineLength = 0;
}

function renderLiveStatusLine(options, message) {
  if (!supportsLiveStatusLine(options)) {
    return;
  }
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return;
  }
  const padded = normalized.padEnd(liveStatusLineLength, ' ');
  process.stdout.write(`\r${padded}`);
  liveStatusLineLength = normalized.length;
}

function classifyPrettyLevel(message) {
  const value = String(message ?? '').toLowerCase();
  if (value.includes('failed') || value.includes('error')) return 'error';
  if (value.includes('blocked') || value.includes('pending') || value.includes('downgraded')) return 'warn';
  if (value.includes('passed') || value.includes('complete') || value.includes('promoted')) return 'ok';
  if (value.includes('start') || value.includes('resume') || value.includes('session') || value.includes('transition')) {
    return 'run';
  }
  return 'info';
}

function prettyLevelTag(options, level) {
  if (level === 'error') return colorize(options, '31', 'ERROR');
  if (level === 'warn') return colorize(options, '33', 'WARN ');
  if (level === 'ok') return colorize(options, '32', 'OK   ');
  if (level === 'run') return colorize(options, '36', 'RUN  ');
  return colorize(options, '35', 'INFO ');
}

function progressLog(options, message) {
  clearLiveStatusLine();
  if (isTickerOutput(options)) {
    console.log(`[ticker] ${nowIso()} ${message}`);
    return;
  }
  if (isPrettyOutput(options)) {
    const stamp = colorize(options, '90', nowIso().slice(11, 19));
    const level = classifyPrettyLevel(message);
    const spinner = nextPrettySpinner(options);
    const tag = prettyLevelTag(options, level);
    console.log(`${stamp} ${spinner} ${tag} ${message}`);
    return;
  }
  console.log(`[orchestrator] ${message}`);
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

function printRunSummary(options, label, state, processed, runDurationSeconds) {
  if (isTickerOutput(options)) {
    progressLog(
      options,
      `${label} complete processed=${processed} runId=${state.runId} completed=${state.completedPlanIds.length} blocked=${state.blockedPlanIds.length} failed=${state.failedPlanIds.length} duration=${formatDuration(runDurationSeconds)}`
    );
    return;
  }
  if (isPrettyOutput(options)) {
    const border = colorize(options, '90', '------------------------------------------------------------');
    const title = colorize(options, '1;36', `${label.toUpperCase()} SUMMARY`);
    console.log(border);
    console.log(title);
    console.log(`runId: ${state.runId}`);
    console.log(`processed: ${processed}`);
    console.log(`completed: ${state.completedPlanIds.length}`);
    console.log(`blocked: ${state.blockedPlanIds.length}`);
    console.log(`failed: ${state.failedPlanIds.length}`);
    console.log(`duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
    console.log(border);
    return;
  }

  progressLog(options, `${label} complete (${processed} processed).`);
  console.log(`- runId: ${state.runId}`);
  console.log(`- completed (cumulative for runId): ${state.completedPlanIds.length}`);
  console.log(`- blocked (cumulative for runId): ${state.blockedPlanIds.length}`);
  console.log(`- failed (cumulative for runId): ${state.failedPlanIds.length}`);
  console.log(`- duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
  console.log('- note: processed count is for this invocation; completed/blocked/failed are cumulative for the runId.');
}

function printParallelRunSummary(options, state, processed, runDurationSeconds, summary) {
  if (isTickerOutput(options)) {
    progressLog(
      options,
      `run-parallel complete processed=${processed} runId=${state.runId} branchCompleted=${summary.completed} branchBlocked=${summary.blocked} branchFailed=${summary.failed} branchPending=${summary.pending} duration=${formatDuration(runDurationSeconds)}`
    );
    return;
  }
  if (isPrettyOutput(options)) {
    const border = colorize(options, '90', '------------------------------------------------------------');
    const title = colorize(options, '1;36', 'RUN-PARALLEL SUMMARY');
    console.log(border);
    console.log(title);
    console.log(`runId: ${state.runId}`);
    console.log(`processed workers: ${processed}`);
    console.log(`branch completed: ${summary.completed}`);
    console.log(`branch blocked: ${summary.blocked}`);
    console.log(`branch failed: ${summary.failed}`);
    console.log(`branch pending: ${summary.pending}`);
    console.log(`duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
    console.log(border);
    return;
  }

  progressLog(options, `run-parallel complete (${processed} workers processed).`);
  console.log(`- runId: ${state.runId}`);
  console.log(`- branch completed: ${summary.completed}`);
  console.log(`- branch blocked: ${summary.blocked}`);
  console.log(`- branch failed: ${summary.failed}`);
  console.log(`- branch pending: ${summary.pending}`);
  console.log(`- duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
}

function normalizeRoleProfile(profile = {}, defaults = {}) {
  const merged = {
    ...defaults,
    ...(profile && typeof profile === 'object' ? profile : {})
  };
  return {
    model: String(merged.model ?? '').trim(),
    reasoningEffort: String(merged.reasoningEffort ?? 'medium').trim().toLowerCase(),
    sandboxMode: String(merged.sandboxMode ?? 'read-only').trim().toLowerCase(),
    instructions: String(merged.instructions ?? '').trim()
  };
}

function resolveExecutorProvider(config) {
  return String(process.env.ORCH_EXECUTOR_PROVIDER ?? config?.executor?.provider ?? 'codex').trim().toLowerCase();
}

function resolveRoleExecutionProfile(config, role) {
  const normalizedRole = normalizeRoleName(role, ROLE_WORKER);
  const provider = resolveExecutorProvider(config);
  const roleProfiles = config?.roleOrchestration?.roleProfiles ?? {};
  const providerRoleProfiles = config?.roleOrchestration?.providers?.[provider]?.roleProfiles ?? {};
  const baseProfile = normalizeRoleProfile(roleProfiles[normalizedRole], {
    model: '',
    reasoningEffort: normalizedRole === ROLE_EXPLORER ? 'medium' : 'high',
    sandboxMode: normalizedRole === ROLE_WORKER ? 'full-access' : 'read-only',
    instructions: ''
  });
  return {
    provider,
    ...normalizeRoleProfile(providerRoleProfiles[normalizedRole], baseProfile)
  };
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function nowIso() {
  return new Date().toISOString();
}

function isoDate(value) {
  return String(value).slice(0, 10);
}

function parseIsoMillis(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function computePlanShapeHash(plan) {
  const payload = {
    planId: plan.planId,
    rel: plan.rel,
    dependencies: [...(plan.dependencies ?? [])].sort(),
    specTargets: [...(plan.specTargets ?? [])].sort(),
    tags: [...(plan.tags ?? [])].sort(),
    riskTier: parseRiskTier(plan.riskTier, 'low'),
    acceptanceCriteria: String(plan.acceptanceCriteria ?? '').trim()
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function durationSeconds(startIso, endIso = nowIso()) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  return Math.floor((endMs - startMs) / 1000);
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds == null) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function randomRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${random}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDatePrefix(value) {
  return String(value).replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function datedPlanFileName(datePrefix, stem, ext = '.md') {
  const baseStem = stripDatePrefix(stem).trim();
  return `${datePrefix}-${baseStem}${ext}`;
}

function assertSafeRelativePlanPath(relPath) {
  const normalized = toPosix(String(relPath ?? '').trim());
  if (!normalized) {
    throw new Error('Plan file path is empty.');
  }
  if (path.posix.isAbsolute(normalized) || path.isAbsolute(normalized) || normalized.includes('..')) {
    throw new Error(`Unsafe plan file path '${normalized}'.`);
  }
  if (!SAFE_PLAN_RELATIVE_PATH_REGEX.test(normalized)) {
    throw new Error(`Plan file path contains unsafe characters: '${normalized}'.`);
  }
  return normalized;
}

function isWithinRoot(rootDir, absPath) {
  const relative = path.relative(rootDir, absPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveSafeRepoPath(rootDir, relPath, label = 'Repository path') {
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

function assertValidPlanId(planId, relPath) {
  if (!isValidPlanId(planId)) {
    throw new Error(
      `Invalid Plan-ID '${planId}' in ${relPath}. Use lowercase kebab-case (e.g. 'fix-auth-timeout').`
    );
  }
  return String(planId);
}

function buildPaths(rootDir) {
  const docsDir = path.join(rootDir, 'docs');
  const opsAutomationDir = path.join(docsDir, 'ops', 'automation');
  return {
    rootDir,
    docsDir,
    futureDir: path.join(docsDir, 'future'),
    activeDir: path.join(docsDir, 'exec-plans', 'active'),
    completedDir: path.join(docsDir, 'exec-plans', 'completed'),
    evidenceIndexDir: path.join(docsDir, 'exec-plans', 'evidence-index'),
    productStatePath: path.join(docsDir, 'product-specs', 'current-state.md'),
    opsAutomationDir,
    handoffDir: path.join(opsAutomationDir, 'handoffs'),
    runtimeDir: path.join(opsAutomationDir, 'runtime'),
    contactPackDir: path.join(opsAutomationDir, 'runtime', 'contacts'),
    parallelWorktreesDir: path.join(opsAutomationDir, 'runtime', 'worktrees'),
    runLockPath: path.join(opsAutomationDir, 'runtime', 'orchestrator.lock.json'),
    runStatePath: path.join(opsAutomationDir, 'run-state.json'),
    runEventsPath: path.join(opsAutomationDir, 'run-events.jsonl'),
    orchestratorConfigPath: path.join(opsAutomationDir, 'orchestrator.config.json')
  };
}

async function ensureDirectories(paths, dryRun) {
  if (dryRun) {
    return;
  }

  await fs.mkdir(paths.opsAutomationDir, { recursive: true });
  await fs.mkdir(paths.handoffDir, { recursive: true });
  await fs.mkdir(paths.runtimeDir, { recursive: true });
  await fs.mkdir(paths.contactPackDir, { recursive: true });
  await fs.mkdir(paths.parallelWorktreesDir, { recursive: true });
  await fs.mkdir(paths.evidenceIndexDir, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readJsonStrict(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${toPosix(path.relative(process.cwd(), filePath))}: ${message}`);
  }
}

async function writeJson(filePath, payload, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function appendJsonLine(filePath, payload, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function timeoutMsFromSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.floor(seconds * 1000);
}

function runShell(command, cwd, env = process.env, timeoutMs = undefined, stdioMode = 'inherit') {
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

function runShellCapture(command, cwd, env = process.env, timeoutMs = undefined) {
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function didTimeout(result) {
  return result?.error?.code === 'ETIMEDOUT';
}

function didFirstTouchDeadlineTimeout(result) {
  return result?.error?.code === 'ENO_TOUCH_DEADLINE';
}

function roleActivity(role) {
  const normalized = normalizeRoleName(role, ROLE_WORKER);
  if (normalized === ROLE_PLANNER) return 'planning';
  if (normalized === ROLE_EXPLORER) return 'exploring';
  if (normalized === ROLE_REVIEWER) return 'reviewing';
  return 'implementing';
}

function safeDisplayToken(value, fallback = 'n/a') {
  const rendered = String(value ?? '').trim();
  return rendered.length > 0 ? rendered : fallback;
}

function formatCommandHeartbeatLine(options, context, elapsedSeconds, idleSeconds) {
  const stamp = colorize(options, '90', nowIso().slice(11, 19));
  const dots = nextPrettyLiveDots(options);
  const tag = prettyLevelTag(options, idleSeconds >= options.stallWarnSeconds ? 'warn' : 'run');
  const phase = safeDisplayToken(context.phase, 'session');
  const planId = safeDisplayToken(context.planId, 'run');
  const role = safeDisplayToken(context.role, 'n/a');
  const activity = safeDisplayToken(context.activity, phase);
  const touchSummary = formatTouchSummaryInline(context.touchSummary);
  return (
    `${stamp} ${dots} ${tag} phase=${phase} plan=${planId} role=${role} activity=${activity} ` +
    `elapsed=${formatDuration(elapsedSeconds)} idle=${formatDuration(idleSeconds)} ${touchSummary}`
  );
}

function summarizeTouchedPaths(paths, sampleSize = DEFAULT_TOUCH_SAMPLE_SIZE) {
  const normalized = [...new Set((Array.isArray(paths) ? paths : []).map((entry) => toPosix(String(entry ?? '').trim())).filter(Boolean))];
  if (normalized.length === 0) {
    return {
      count: 0,
      categories: [],
      samples: [],
      fingerprint: 'none'
    };
  }

  const categoryCounts = new Map();
  for (const filePath of normalized) {
    const category = classifyTouchedPath(filePath);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  const categories = [...categoryCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category, count]) => ({ category, count }));
  const samples = normalized.slice(0, Math.max(1, sampleSize));
  const fingerprint = createHash('sha1')
    .update(normalized.join('\n'))
    .digest('hex')
    .slice(0, 10);

  return {
    count: normalized.length,
    categories,
    samples,
    fingerprint
  };
}

function classifyTouchedPath(filePath) {
  const value = toPosix(String(filePath ?? '').trim()).replace(/^\.?\//, '');
  const baseName = path.posix.basename(value).toLowerCase();

  if (value.startsWith('docs/exec-plans/')) {
    return 'plan-docs';
  }
  if (value.startsWith('docs/ops/automation/')) {
    return 'automation';
  }
  if (value.startsWith('docs/')) {
    return 'docs';
  }
  if (
    baseName.endsWith('.spec.ts') ||
    baseName.endsWith('.spec.tsx') ||
    baseName.endsWith('.spec.js') ||
    baseName.endsWith('.spec.jsx') ||
    baseName.endsWith('.test.ts') ||
    baseName.endsWith('.test.tsx') ||
    baseName.endsWith('.test.js') ||
    baseName.endsWith('.test.jsx') ||
    value.includes('/__tests__/') ||
    value.includes('/tests/') ||
    value.includes('/test/') ||
    value.includes('/e2e/')
  ) {
    return 'tests';
  }
  if (
    baseName === 'package-lock.json' ||
    baseName === 'pnpm-lock.yaml' ||
    baseName === 'yarn.lock' ||
    baseName === 'bun.lockb'
  ) {
    return 'lockfiles';
  }
  if (
    value.startsWith('apps/') ||
    value.startsWith('libs/') ||
    value.startsWith('packages/') ||
    value.startsWith('src/')
  ) {
    return 'source';
  }
  if (value.startsWith('scripts/')) {
    return 'scripts';
  }
  return 'other';
}

function formatTouchSummaryInline(summary) {
  const payload = summary && typeof summary === 'object' ? summary : null;
  if (!payload || payload.count <= 0) {
    return 'touch=none';
  }
  const categories = payload.categories
    .slice(0, 2)
    .map((entry) => `${entry.category}:${entry.count}`)
    .join(',');
  return `touch=${payload.count}(${categories || 'n/a'})`;
}

function formatTouchSummaryDetails(summary) {
  const payload = summary && typeof summary === 'object' ? summary : null;
  if (!payload || payload.count <= 0) {
    return 'touched=0';
  }
  const categories = payload.categories
    .slice(0, 4)
    .map((entry) => `${entry.category}:${entry.count}`)
    .join(', ');
  const samples = payload.samples.length > 0 ? payload.samples.join(', ') : 'none';
  return `touched=${payload.count} categories=[${categories}] sample=[${samples}]`;
}

function monitorTouchedPaths(cwd, baselineSet, options = {}) {
  if (!(baselineSet instanceof Set)) {
    return null;
  }

  const current = dirtyRepoPaths(cwd, { includeTransient: true })
    .filter((entry) => !isTransientAutomationPath(entry));
  const touched = current.filter((entry) => !baselineSet.has(entry));
  const summary = summarizeTouchedPaths(touched, options.touchSampleSize);
  return {
    ...summary,
    touched
  };
}

function disallowedTouchedPathsForRole(role, touchedPaths = []) {
  const normalizedRole = normalizeRoleName(role, ROLE_WORKER);
  if (normalizedRole === ROLE_WORKER) {
    return [];
  }
  const normalized = [...new Set(
    (Array.isArray(touchedPaths) ? touchedPaths : [])
      .map((entry) => toPosix(String(entry ?? '').trim()).replace(/^\.?\//, ''))
      .filter(Boolean)
  )];
  return normalized.filter((filePath) => !filePath.startsWith('docs/exec-plans/'));
}

async function runShellMonitored(
  command,
  cwd,
  env = process.env,
  timeoutMs = undefined,
  stdioMode = 'inherit',
  options = {},
  context = {}
) {
  const capture = stdioMode === 'pipe';
  const startedAtMs = Date.now();
  let lastOutputAtMs = startedAtMs;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let firstTouchDeadlineTimedOut = false;
  let processError = null;
  let settled = false;
  let warnEmitted = false;
  const touchSummaryEnabled = asBoolean(options.touchSummary, DEFAULT_TOUCH_SUMMARY);
  const touchSampleSize = Math.max(1, asInteger(options.touchSampleSize, DEFAULT_TOUCH_SAMPLE_SIZE));
  const touchBaseline = touchSummaryEnabled && gitAvailable(cwd)
    ? new Set(dirtyRepoPaths(cwd, { includeTransient: true }).filter((entry) => !isTransientAutomationPath(entry)))
    : null;
  let touchSummary = null;
  let lastTouchChangeAtMs = startedAtMs;
  let lastTouchFingerprint = null;
  const firstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(options.workerFirstTouchDeadlineSeconds, DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS)
  );
  const enforceFirstTouchDeadline =
    touchBaseline != null &&
    String(context.phase ?? '').trim().toLowerCase() === 'session' &&
    normalizeRoleName(context.role, ROLE_WORKER) === ROLE_WORKER &&
    firstTouchDeadlineSeconds > 0;
  const firstTouchDeadlineMs = enforceFirstTouchDeadline ? firstTouchDeadlineSeconds * 1000 : 0;

  const child = spawn(command, {
    shell: true,
    cwd,
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });

  if (capture) {
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      lastOutputAtMs = Date.now();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      lastOutputAtMs = Date.now();
    });
  }

  const heartbeatMs = Math.max(3000, asInteger(options.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS) * 1000);
  const stallWarnMs = Math.max(
    heartbeatMs,
    asInteger(options.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS) * 1000
  );
  const heartbeatEnabled = isPrettyOutput(options) || isTickerOutput(options);
  let heartbeatTimer = null;
  const emitHeartbeat = () => {
    if (touchBaseline) {
      const latestTouchSummary = monitorTouchedPaths(cwd, touchBaseline, { touchSampleSize });
      if (latestTouchSummary) {
        touchSummary = latestTouchSummary;
        if (latestTouchSummary.fingerprint !== lastTouchFingerprint) {
          lastTouchFingerprint = latestTouchSummary.fingerprint;
          lastTouchChangeAtMs = Date.now();
          if (latestTouchSummary.count > 0) {
            progressLog(
              options,
              `file activity phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} ${formatTouchSummaryDetails(latestTouchSummary)}`
            );
          }
        }
      }
    }

    const nowMs = Date.now();
    const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
    const effectiveProgressAtMs = Math.max(lastOutputAtMs, lastTouchChangeAtMs);
    const idleSeconds = Math.floor((nowMs - effectiveProgressAtMs) / 1000);

    if (supportsLiveStatusLine(options)) {
      renderLiveStatusLine(
        options,
        formatCommandHeartbeatLine(options, { ...context, touchSummary }, elapsedSeconds, idleSeconds)
      );
    } else {
      progressLog(
        options,
        `heartbeat phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} activity=${safeDisplayToken(context.activity, safeDisplayToken(context.phase, 'session'))} elapsed=${formatDuration(elapsedSeconds)} idle=${formatDuration(idleSeconds)} ${formatTouchSummaryInline(touchSummary)}`
      );
    }

    if (idleSeconds * 1000 >= stallWarnMs && !warnEmitted) {
      warnEmitted = true;
      progressLog(
        options,
        `stall warning phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} idle=${formatDuration(idleSeconds)} ${formatTouchSummaryInline(touchSummary)}`
      );
    }

    if (enforceFirstTouchDeadline && !firstTouchDeadlineTimedOut) {
      const touchedCount =
        typeof touchSummary?.count === 'number' && Number.isFinite(touchSummary.count)
          ? touchSummary.count
          : 0;
      if (touchedCount <= 0 && nowMs - startedAtMs >= firstTouchDeadlineMs) {
        firstTouchDeadlineTimedOut = true;
        progressLog(
          options,
          `first-touch deadline exceeded phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} deadline=${firstTouchDeadlineSeconds}s`
        );
        child.kill('SIGTERM');
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (pidIsAlive(child.pid)) {
              child.kill('SIGKILL');
            }
          }, 5000);
          forceKillTimer.unref?.();
        }
      }
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
        if (pidIsAlive(child.pid)) {
          child.kill('SIGKILL');
        }
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
      cleanupTimers();
      const finalTouchSummary = touchBaseline
        ? (monitorTouchedPaths(cwd, touchBaseline, { touchSampleSize }) ?? touchSummary)
        : touchSummary;
      resolve({
        status,
        signal,
        error: firstTouchDeadlineTimedOut ? { code: 'ENO_TOUCH_DEADLINE' } : timedOut ? { code: 'ETIMEDOUT' } : processError,
        stdout,
        stderr,
        touchSummary: finalTouchSummary ?? null
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

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(paths) {
  const defaultConfig = {
    executor: {
      command: '',
      handoffExitCode: DEFAULT_HANDOFF_EXIT_CODE,
      timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS
    },
    context: {
      runtimeContextPath: DEFAULT_RUNTIME_CONTEXT_PATH,
      maxTokens: 1400,
      contactPacks: {
        enabled: DEFAULT_CONTACT_PACKS_ENABLED,
        maxPolicyBullets: DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS,
        includeRecentEvidence: DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE,
        maxRecentEvidenceItems: DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS
      }
    },
    validationCommands: [],
    validation: {
      always: [],
      requireAlwaysCommands: true,
      hostRequired: [],
      requireHostRequiredCommands: true,
      timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
      host: {
        mode: DEFAULT_HOST_VALIDATION_MODE,
        ci: {
          command: '',
          timeoutSeconds: DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS,
          pollSeconds: DEFAULT_HOST_VALIDATION_POLL_SECONDS
        },
        local: {
          command: ''
        }
      }
    },
    evidence: {
      compaction: {
        mode: 'compact-index',
        maxReferences: DEFAULT_EVIDENCE_MAX_REFERENCES
      },
      lifecycle: {
        trackMode: DEFAULT_EVIDENCE_TRACK_MODE,
        dedupMode: DEFAULT_EVIDENCE_DEDUP_MODE,
        pruneOnComplete: DEFAULT_EVIDENCE_PRUNE_ON_COMPLETE,
        keepMaxPerBlocker: DEFAULT_EVIDENCE_KEEP_MAX_PER_BLOCKER
      }
    },
    roleOrchestration: {
      enabled: DEFAULT_ROLE_ORCHESTRATION_ENABLED,
      mode: 'risk-adaptive',
      roleProfiles: {
        explorer: {
          model: 'gpt-5.3-codex-spark',
          reasoningEffort: 'medium',
          sandboxMode: 'read-only',
          instructions:
            'You are a fast codebase explorer. Search files, read code, trace dependencies, and answer scoped questions. You may update active plan/evidence docs for this stage, but do not modify product/source code. Record concrete implementation-ready findings in plan/evidence docs before finishing.'
        },
        reviewer: {
          model: 'gpt-5.3-codex',
          reasoningEffort: 'high',
          sandboxMode: 'read-only',
          instructions:
            'Focus on high-priority issues: security vulnerabilities, correctness bugs, race conditions, test flakiness, and performance problems.'
        },
        worker: {
          model: 'gpt-5.3-codex',
          reasoningEffort: 'high',
          sandboxMode: 'full-access',
          instructions:
            'You are an execution-focused agent. Implement features, fix bugs, and refactor precisely while following existing patterns. Start with a concrete repository edit as soon as feasible, then continue iteratively. Do not defer implementation work back to planner/explorer when a concrete edit can be made now.'
        },
        planner: {
          model: 'gpt-5.3-codex',
          reasoningEffort: 'high',
          sandboxMode: 'read-only',
          instructions:
            'You are an architect agent. Break down tasks into implementation steps, identify dependencies/risks, and output a structured execution plan. Update plan/evidence docs with concrete next-step checklists, and avoid modifying product/source code.'
        }
      },
      pipelines: {
        low: [ROLE_WORKER],
        medium: [ROLE_PLANNER, ROLE_WORKER, ROLE_REVIEWER],
        high: [ROLE_PLANNER, ROLE_EXPLORER, ROLE_WORKER, ROLE_REVIEWER]
      },
      stageBudgetsSeconds: {
        planner: DEFAULT_STAGE_BUDGET_PLANNER_SECONDS,
        explorer: DEFAULT_STAGE_BUDGET_EXPLORER_SECONDS,
        reviewer: DEFAULT_STAGE_BUDGET_REVIEWER_SECONDS
      },
      riskModel: {
        thresholds: {
          medium: DEFAULT_RISK_THRESHOLD_MEDIUM,
          high: DEFAULT_RISK_THRESHOLD_HIGH
        },
        weights: {
          declaredMedium: DEFAULT_RISK_WEIGHT_DECLARED_MEDIUM,
          declaredHigh: DEFAULT_RISK_WEIGHT_DECLARED_HIGH,
          dependency: DEFAULT_RISK_WEIGHT_DEPENDENCY,
          sensitiveTag: DEFAULT_RISK_WEIGHT_SENSITIVE_TAG,
          sensitivePath: DEFAULT_RISK_WEIGHT_SENSITIVE_PATH,
          autonomyFull: DEFAULT_RISK_WEIGHT_AUTONOMY_FULL,
          validationFailure: DEFAULT_RISK_WEIGHT_VALIDATION_FAILURE
        },
        sensitiveTags: ['security', 'auth', 'authentication', 'payments', 'pii', 'migration', 'infra'],
        sensitivePaths: ['payments', 'billing', 'auth', 'security', 'migrations', 'db', 'compliance']
      },
      approvalGates: {
        requireSecurityOpsForHigh: true,
        requireSecurityOpsForMediumIfSensitive: true,
        securityApprovalMetadataField: 'Security-Approval'
      },
      providers: {}
    },
    logging: {
      output: DEFAULT_OUTPUT_MODE,
      failureTailLines: DEFAULT_FAILURE_TAIL_LINES,
      heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
      stallWarnSeconds: DEFAULT_STALL_WARN_SECONDS,
      touchSummary: DEFAULT_TOUCH_SUMMARY,
      touchSampleSize: DEFAULT_TOUCH_SAMPLE_SIZE,
      workerFirstTouchDeadlineSeconds: DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS,
      workerNoTouchRetryLimit: DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT
    },
    parallel: {
      maxPlans: DEFAULT_PARALLEL_PLANS,
      worktreeRoot: DEFAULT_PARALLEL_WORKTREE_ROOT,
      branchPrefix: DEFAULT_PARALLEL_BRANCH_PREFIX,
      baseRef: DEFAULT_PARALLEL_BASE_REF,
      gitRemote: DEFAULT_PARALLEL_GIT_REMOTE,
      workerOutputMode: DEFAULT_PARALLEL_WORKER_OUTPUT,
      keepWorktrees: DEFAULT_PARALLEL_KEEP_WORKTREES,
      pushBranches: DEFAULT_PARALLEL_PUSH_BRANCHES,
      openPullRequests: DEFAULT_PARALLEL_OPEN_PULL_REQUESTS,
      assumeDependencyCompletion: DEFAULT_PARALLEL_ASSUME_DEPENDENCY_COMPLETION,
      pullRequest: {
        createCommand: '',
        mergeCommand: ''
      }
    },
    git: {
      atomicCommits: true,
      atomicCommitRoots: {
        defaults: [],
        shared: [],
        allowPlanMetadata: true,
        enforce: true
      }
    }
  };

  const configured = await readJsonIfExists(paths.orchestratorConfigPath, {});
  return {
    ...defaultConfig,
    ...configured,
    executor: {
      ...defaultConfig.executor,
      ...(configured.executor ?? {})
    },
    context: {
      ...defaultConfig.context,
      ...(configured.context ?? {}),
      contactPacks: {
        ...defaultConfig.context.contactPacks,
        ...(configured.context?.contactPacks ?? {})
      }
    },
    validation: {
      ...defaultConfig.validation,
      ...(configured.validation ?? {}),
      host: {
        ...defaultConfig.validation.host,
        ...(configured.validation?.host ?? {}),
        ci: {
          ...defaultConfig.validation.host.ci,
          ...(configured.validation?.host?.ci ?? {})
        },
        local: {
          ...defaultConfig.validation.host.local,
          ...(configured.validation?.host?.local ?? {})
        }
      }
    },
    evidence: {
      ...defaultConfig.evidence,
      ...(configured.evidence ?? {}),
      compaction: {
        ...defaultConfig.evidence.compaction,
        ...(configured.evidence?.compaction ?? {})
      },
      lifecycle: {
        ...defaultConfig.evidence.lifecycle,
        ...(configured.evidence?.lifecycle ?? {})
      }
    },
    roleOrchestration: {
      ...defaultConfig.roleOrchestration,
      ...(configured.roleOrchestration ?? {}),
      roleProfiles: {
        ...defaultConfig.roleOrchestration.roleProfiles,
        ...(configured.roleOrchestration?.roleProfiles ?? {})
      },
      pipelines: {
        ...defaultConfig.roleOrchestration.pipelines,
        ...(configured.roleOrchestration?.pipelines ?? {})
      },
      stageBudgetsSeconds: {
        ...defaultConfig.roleOrchestration.stageBudgetsSeconds,
        ...(configured.roleOrchestration?.stageBudgetsSeconds ?? {})
      },
      riskModel: {
        ...defaultConfig.roleOrchestration.riskModel,
        ...(configured.roleOrchestration?.riskModel ?? {}),
        thresholds: {
          ...defaultConfig.roleOrchestration.riskModel.thresholds,
          ...(configured.roleOrchestration?.riskModel?.thresholds ?? {})
        },
        weights: {
          ...defaultConfig.roleOrchestration.riskModel.weights,
          ...(configured.roleOrchestration?.riskModel?.weights ?? {})
        }
      },
      approvalGates: {
        ...defaultConfig.roleOrchestration.approvalGates,
        ...(configured.roleOrchestration?.approvalGates ?? {})
      },
      providers: {
        ...(defaultConfig.roleOrchestration.providers ?? {}),
        ...(configured.roleOrchestration?.providers ?? {})
      }
    },
    logging: {
      ...defaultConfig.logging,
      ...(configured.logging ?? {})
    },
    parallel: {
      ...defaultConfig.parallel,
      ...(configured.parallel ?? {}),
      pullRequest: {
        ...defaultConfig.parallel.pullRequest,
        ...(configured.parallel?.pullRequest ?? {})
      }
    },
    git: {
      ...defaultConfig.git,
      ...(configured.git ?? {}),
      atomicCommitRoots: {
        ...defaultConfig.git.atomicCommitRoots,
        ...(configured.git?.atomicCommitRoots ?? {})
      }
    }
  };
}

async function acquireRunLock(paths, state, options) {
  if (options.dryRun) {
    return;
  }

  const payload = {
    pid: process.pid,
    runId: state.runId,
    mode: state.effectiveMode,
    acquiredAt: nowIso(),
    cwd: paths.rootDir
  };

  async function tryCreateLock() {
    const handle = await fs.open(paths.runLockPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await tryCreateLock();
      return;
    } catch (error) {
      const code = error?.code;
      if (code !== 'EEXIST') {
        throw error;
      }

      const existing = await readJsonStrict(paths.runLockPath);
      const existingPid = Number.isInteger(existing?.pid) ? existing.pid : null;
      if (existingPid && existingPid !== process.pid && pidIsAlive(existingPid)) {
        throw new Error(
          `Another orchestrator run appears active (pid ${existingPid}, runId ${existing?.runId ?? 'unknown'}).`
        );
      }

      await fs.unlink(paths.runLockPath);
    }
  }

  throw new Error('Unable to acquire orchestrator run lock after stale-lock cleanup.');
}

async function releaseRunLock(paths, options) {
  if (options.dryRun) {
    return;
  }

  const existing = await readJsonIfExists(paths.runLockPath, null);
  if (!existing || existing.pid !== process.pid) {
    return;
  }

  try {
    await fs.unlink(paths.runLockPath);
  } catch {
    // Best-effort cleanup.
  }
}

function configuredExecutorCommand(options, config) {
  return String(config.executor.command || '').trim();
}

function assertExecutorConfigured(options, config) {
  if (options.dryRun) {
    return;
  }

  if (!configuredExecutorCommand(options, config)) {
    throw new Error(
      'No executor command configured. Set docs/ops/automation/orchestrator.config.json executor.command.'
    );
  }
}

function assertValidationConfigured(options, config, paths) {
  if (options.dryRun) {
    return;
  }

  const alwaysValidation = resolveAlwaysValidationCommands(paths.rootDir, options, config);
  if (options.requireAlwaysValidationCommands && alwaysValidation.length === 0) {
    throw new Error(
      'No validation.always commands configured. Set docs/ops/automation/orchestrator.config.json validation.always.'
    );
  }

  const hostValidation = resolveHostRequiredValidationCommands(config);
  if (options.requireHostValidationCommands && hostValidation.length === 0) {
    throw new Error(
      'No validation.hostRequired commands configured. Set docs/ops/automation/orchestrator.config.json validation.hostRequired.'
    );
  }
}

function resolveRuntimeExecutorOptions(options, config) {
  const configContextThreshold = asInteger(config.executor?.contextThreshold, DEFAULT_CONTEXT_THRESHOLD);
  const contextThreshold = asInteger(options.contextThreshold, configContextThreshold);
  const configRequireResultPayload = asBoolean(
    config.executor?.requireResultPayload,
    DEFAULT_REQUIRE_RESULT_PAYLOAD
  );
  const requireResultPayload = asBoolean(options.requireResultPayload, configRequireResultPayload);
  const executorTimeoutSeconds = asInteger(
    config.executor?.timeoutSeconds,
    DEFAULT_COMMAND_TIMEOUT_SECONDS
  );
  const validationTimeoutSeconds = asInteger(
    config.validation?.timeoutSeconds,
    DEFAULT_COMMAND_TIMEOUT_SECONDS
  );
  const hostValidationTimeoutSeconds = asInteger(
    config.validation?.host?.ci?.timeoutSeconds ?? config.validation?.host?.timeoutSeconds,
    DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS
  );
  const requireAlwaysValidationCommands = asBoolean(
    config.validation?.requireAlwaysCommands,
    true
  );
  const requireHostValidationCommands = asBoolean(
    config.validation?.requireHostRequiredCommands,
    true
  );
  const outputMode = normalizeOutputMode(
    options.outputMode ?? options.output ?? config.logging?.output,
    DEFAULT_OUTPUT_MODE
  );
  const failureTailLines = asInteger(
    options.failureTailLines ?? config.logging?.failureTailLines,
    DEFAULT_FAILURE_TAIL_LINES
  );
  const heartbeatSeconds = Math.max(
    3,
    asInteger(options.heartbeatSeconds ?? config.logging?.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS)
  );
  const stallWarnSeconds = Math.max(
    heartbeatSeconds,
    asInteger(options.stallWarnSeconds ?? config.logging?.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS)
  );
  const touchSummary = asBoolean(
    options.touchSummary ?? options['touch-summary'] ?? config.logging?.touchSummary,
    DEFAULT_TOUCH_SUMMARY
  );
  const touchSampleSize = Math.max(
    1,
    asInteger(options.touchSampleSize ?? options['touch-sample-size'] ?? config.logging?.touchSampleSize, DEFAULT_TOUCH_SAMPLE_SIZE)
  );
  const workerFirstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(
      options.workerFirstTouchDeadlineSeconds ??
        options['worker-first-touch-deadline-seconds'] ??
        config.logging?.workerFirstTouchDeadlineSeconds,
      DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS
    )
  );
  const workerNoTouchRetryLimit = Math.max(
    0,
    asInteger(
      options.workerNoTouchRetryLimit ??
        options['worker-no-touch-retry-limit'] ??
        config.logging?.workerNoTouchRetryLimit,
      DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT
    )
  );
  const contactPacks = config.context?.contactPacks ?? {};
  const contactPackEnabled = asBoolean(
    contactPacks.enabled,
    DEFAULT_CONTACT_PACKS_ENABLED
  );
  const contactPackMaxPolicyBullets = Math.max(
    1,
    asInteger(contactPacks.maxPolicyBullets, DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS)
  );
  const contactPackIncludeRecentEvidence = asBoolean(
    contactPacks.includeRecentEvidence,
    DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE
  );
  const contactPackMaxRecentEvidenceItems = Math.max(
    0,
    asInteger(contactPacks.maxRecentEvidenceItems, DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS)
  );
  const retryFailedPlans = asBoolean(
    options.retryFailed ?? options['retry-failed'] ?? config.recovery?.retryFailed,
    DEFAULT_RETRY_FAILED_PLANS
  );
  const autoUnblockPlans = asBoolean(
    options.autoUnblock ?? options['auto-unblock'] ?? config.recovery?.autoUnblock,
    DEFAULT_AUTO_UNBLOCK_PLANS
  );
  const maxFailedRetries = Math.max(
    1,
    asInteger(
      options.maxFailedRetries ?? options['max-failed-retries'] ?? config.recovery?.maxFailedRetries,
      DEFAULT_MAX_FAILED_RETRIES
    )
  );

  return {
    ...options,
    contextThreshold,
    requireResultPayload,
    executorTimeoutMs: timeoutMsFromSeconds(executorTimeoutSeconds),
    validationTimeoutMs: timeoutMsFromSeconds(validationTimeoutSeconds),
    hostValidationTimeoutMs: timeoutMsFromSeconds(hostValidationTimeoutSeconds),
    requireAlwaysValidationCommands,
    requireHostValidationCommands,
    outputMode,
    failureTailLines,
    heartbeatSeconds,
    stallWarnSeconds,
    touchSummary,
    touchSampleSize,
    workerFirstTouchDeadlineSeconds,
    workerNoTouchRetryLimit,
    contactPackEnabled,
    contactPackMaxPolicyBullets,
    contactPackIncludeRecentEvidence,
    contactPackMaxRecentEvidenceItems,
    retryFailedPlans,
    autoUnblockPlans,
    maxFailedRetries
  };
}

function normalizedRelativePrefix(value) {
  const normalized = toPosix(String(value ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!normalized) {
    return null;
  }
  assertSafeRelativePlanPath(normalized);
  return normalized;
}

function normalizeRelativePrefixList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const set = new Set();
  for (const value of values) {
    const normalized = normalizedRelativePrefix(value);
    if (normalized) {
      set.add(normalized);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function resolveParallelExecutionOptions(options, config) {
  const configParallel = config?.parallel ?? {};
  const parallelPlans = Math.max(
    1,
    asInteger(options.parallelPlans ?? options['parallel-plans'] ?? configParallel.maxPlans, DEFAULT_PARALLEL_PLANS)
  );
  const worktreeRoot = normalizedRelativePrefix(configParallel.worktreeRoot ?? DEFAULT_PARALLEL_WORKTREE_ROOT);
  const branchPrefix = String(configParallel.branchPrefix ?? DEFAULT_PARALLEL_BRANCH_PREFIX).trim() || DEFAULT_PARALLEL_BRANCH_PREFIX;
  const baseRef = String(configParallel.baseRef ?? DEFAULT_PARALLEL_BASE_REF).trim() || DEFAULT_PARALLEL_BASE_REF;
  const gitRemote = String(configParallel.gitRemote ?? DEFAULT_PARALLEL_GIT_REMOTE).trim() || DEFAULT_PARALLEL_GIT_REMOTE;
  const parentOutputMode = normalizeOutputMode(options.outputMode, DEFAULT_OUTPUT_MODE);
  const workerOutputMode = normalizeOutputMode(
    configParallel.workerOutputMode ?? parentOutputMode,
    parentOutputMode
  );
  return {
    parallelPlans,
    worktreeRoot: worktreeRoot ?? DEFAULT_PARALLEL_WORKTREE_ROOT,
    branchPrefix,
    baseRef,
    gitRemote,
    workerOutputMode,
    keepWorktrees: asBoolean(configParallel.keepWorktrees, DEFAULT_PARALLEL_KEEP_WORKTREES),
    pushBranches: asBoolean(configParallel.pushBranches, DEFAULT_PARALLEL_PUSH_BRANCHES),
    openPullRequests: asBoolean(configParallel.openPullRequests, DEFAULT_PARALLEL_OPEN_PULL_REQUESTS),
    assumeDependencyCompletion: asBoolean(
      configParallel.assumeDependencyCompletion,
      DEFAULT_PARALLEL_ASSUME_DEPENDENCY_COMPLETION
    ),
    pullRequest: {
      createCommand: String(configParallel.pullRequest?.createCommand ?? '').trim(),
      mergeCommand: String(configParallel.pullRequest?.mergeCommand ?? '').trim()
    }
  };
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function sanitizeBranchToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '');
}

function normalizeRoleName(value, fallback = ROLE_WORKER) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ROLE_NAMES.has(normalized) ? normalized : fallback;
}

function normalizeRolePipeline(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }
  const normalized = value
    .map((entry) => normalizeRoleName(entry, ''))
    .filter((entry) => ROLE_NAMES.has(entry));
  return normalized.length > 0 ? normalized : fallback;
}

function resolveRoleOrchestration(config) {
  const source = config?.roleOrchestration ?? {};
  const riskModel = source.riskModel ?? {};
  const thresholds = riskModel.thresholds ?? {};
  const weights = riskModel.weights ?? {};
  const stageReuseSource = source.stageReuse ?? {};
  const stageBudgetsSource = source.stageBudgetsSeconds ?? {};
  const stageReuseRoles = Array.isArray(stageReuseSource.roles)
    ? stageReuseSource.roles
      .map((entry) => normalizeRoleName(entry, ''))
      .filter((entry) => ROLE_NAMES.has(entry))
    : [ROLE_PLANNER, ROLE_EXPLORER];
  return {
    enabled: asBoolean(source.enabled, DEFAULT_ROLE_ORCHESTRATION_ENABLED),
    mode: String(source.mode ?? 'risk-adaptive').trim().toLowerCase(),
    pipelines: {
      low: normalizeRolePipeline(source.pipelines?.low, [ROLE_WORKER]),
      medium: normalizeRolePipeline(source.pipelines?.medium, [ROLE_PLANNER, ROLE_WORKER, ROLE_REVIEWER]),
      high: normalizeRolePipeline(source.pipelines?.high, [ROLE_PLANNER, ROLE_EXPLORER, ROLE_WORKER, ROLE_REVIEWER])
    },
    stageBudgetsSeconds: {
      planner: Math.max(0, asInteger(stageBudgetsSource.planner, DEFAULT_STAGE_BUDGET_PLANNER_SECONDS)),
      explorer: Math.max(0, asInteger(stageBudgetsSource.explorer, DEFAULT_STAGE_BUDGET_EXPLORER_SECONDS)),
      reviewer: Math.max(0, asInteger(stageBudgetsSource.reviewer, DEFAULT_STAGE_BUDGET_REVIEWER_SECONDS))
    },
    stageReuse: {
      enabled: asBoolean(stageReuseSource.enabled, DEFAULT_STAGE_REUSE_ENABLED),
      roles: stageReuseRoles.length > 0 ? [...new Set(stageReuseRoles)] : [ROLE_PLANNER, ROLE_EXPLORER],
      sameRunOnly: asBoolean(stageReuseSource.sameRunOnly, DEFAULT_STAGE_REUSE_SAME_RUN_ONLY),
      maxAgeMinutes: Math.max(0, asInteger(stageReuseSource.maxAgeMinutes, DEFAULT_STAGE_REUSE_MAX_AGE_MINUTES)),
      requiresStablePlanHash: asBoolean(
        stageReuseSource.requiresStablePlanHash,
        DEFAULT_STAGE_REUSE_REQUIRES_STABLE_PLAN_HASH
      ),
      requiresNoScopeChange: asBoolean(
        stageReuseSource.requiresNoScopeChange,
        DEFAULT_STAGE_REUSE_REQUIRES_NO_SCOPE_CHANGE
      )
    },
    riskModel: {
      thresholds: {
        medium: asInteger(thresholds.medium, DEFAULT_RISK_THRESHOLD_MEDIUM),
        high: asInteger(thresholds.high, DEFAULT_RISK_THRESHOLD_HIGH)
      },
      weights: {
        declaredMedium: asInteger(weights.declaredMedium, DEFAULT_RISK_WEIGHT_DECLARED_MEDIUM),
        declaredHigh: asInteger(weights.declaredHigh, DEFAULT_RISK_WEIGHT_DECLARED_HIGH),
        dependency: asInteger(weights.dependency, DEFAULT_RISK_WEIGHT_DEPENDENCY),
        sensitiveTag: asInteger(weights.sensitiveTag, DEFAULT_RISK_WEIGHT_SENSITIVE_TAG),
        sensitivePath: asInteger(weights.sensitivePath, DEFAULT_RISK_WEIGHT_SENSITIVE_PATH),
        autonomyFull: asInteger(weights.autonomyFull, DEFAULT_RISK_WEIGHT_AUTONOMY_FULL),
        validationFailure: asInteger(weights.validationFailure, DEFAULT_RISK_WEIGHT_VALIDATION_FAILURE)
      },
      sensitiveTags: Array.isArray(riskModel.sensitiveTags)
        ? riskModel.sensitiveTags.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : ['security', 'auth', 'authentication', 'payments', 'pii', 'migration', 'infra'],
      sensitivePaths: Array.isArray(riskModel.sensitivePaths)
        ? riskModel.sensitivePaths.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : ['payments', 'billing', 'auth', 'security', 'migrations', 'db', 'compliance']
    },
    approvalGates: {
      requireSecurityOpsForHigh: asBoolean(source.approvalGates?.requireSecurityOpsForHigh, true),
      requireSecurityOpsForMediumIfSensitive: asBoolean(
        source.approvalGates?.requireSecurityOpsForMediumIfSensitive,
        true
      ),
      securityApprovalMetadataField: String(
        source.approvalGates?.securityApprovalMetadataField ?? 'Security-Approval'
      )
    }
  };
}

function riskTierOrder(value) {
  return RISK_TIER_ORDER[String(value ?? 'low').trim().toLowerCase()] ?? RISK_TIER_ORDER.low;
}

function maxRiskTier(a, b) {
  return riskTierOrder(a) >= riskTierOrder(b) ? a : b;
}

function sensitivityMatches(values, needles) {
  const hits = [];
  const normalizedValues = values.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean);
  for (const needle of needles) {
    for (const value of normalizedValues) {
      if (value.includes(needle)) {
        hits.push({ needle, value });
        break;
      }
    }
  }
  return hits;
}

function computedRiskTierFromScore(score, thresholds) {
  if (score >= thresholds.high) {
    return 'high';
  }
  if (score >= thresholds.medium) {
    return 'medium';
  }
  return 'low';
}

function computeRiskAssessment(plan, state, config) {
  const roleConfig = resolveRoleOrchestration(config);
  const weights = roleConfig.riskModel.weights;
  const thresholds = roleConfig.riskModel.thresholds;
  let score = 0;
  const reasons = [];
  const declaredRiskTier = parseRiskTier(plan.riskTier, 'low');

  if (declaredRiskTier === 'medium') {
    score += weights.declaredMedium;
    reasons.push(`declared risk tier medium (+${weights.declaredMedium})`);
  } else if (declaredRiskTier === 'high') {
    score += weights.declaredHigh;
    reasons.push(`declared risk tier high (+${weights.declaredHigh})`);
  }

  if (plan.dependencies.length > 0) {
    const dependencyScore = Math.min(3, plan.dependencies.length) * weights.dependency;
    score += dependencyScore;
    reasons.push(`dependencies (${plan.dependencies.length}) (+${dependencyScore})`);
  }

  const tagMatches = sensitivityMatches(plan.tags, roleConfig.riskModel.sensitiveTags);
  if (tagMatches.length > 0) {
    const tagScore = Math.min(2, tagMatches.length) * weights.sensitiveTag;
    score += tagScore;
    reasons.push(`sensitive tags (${tagMatches.map((hit) => hit.value).join(', ')}) (+${tagScore})`);
  }

  const scopeMatches = sensitivityMatches(plan.specTargets, roleConfig.riskModel.sensitivePaths);
  if (scopeMatches.length > 0) {
    const scopeScore = Math.min(2, scopeMatches.length) * weights.sensitivePath;
    score += scopeScore;
    reasons.push(`sensitive paths (${scopeMatches.map((hit) => hit.value).join(', ')}) (+${scopeScore})`);
  }

  if (String(plan.autonomyAllowed ?? '').trim().toLowerCase() === 'full') {
    score += weights.autonomyFull;
    reasons.push(`autonomy full (+${weights.autonomyFull})`);
  }

  const validationState = state.validationState?.[plan.planId] ?? {};
  if (validationState.always === 'failed' || validationState.host === 'failed') {
    score += weights.validationFailure;
    reasons.push(`previous validation failure (+${weights.validationFailure})`);
  }

  const computedRiskTier = computedRiskTierFromScore(score, thresholds);
  const effectiveRiskTier = maxRiskTier(computedRiskTier, declaredRiskTier);
  const sensitive = tagMatches.length > 0 || scopeMatches.length > 0;

  return {
    declaredRiskTier,
    computedRiskTier,
    effectiveRiskTier,
    score,
    reasons,
    sensitive,
    sensitiveTagHits: tagMatches.map((hit) => hit.value),
    sensitivePathHits: scopeMatches.map((hit) => hit.value)
  };
}

function resolvePipelineStages(assessment, config) {
  const roleConfig = resolveRoleOrchestration(config);
  if (!roleConfig.enabled) {
    return [ROLE_WORKER];
  }
  const tier = parseRiskTier(assessment.effectiveRiskTier, 'low');
  const stages = roleConfig.pipelines[tier] ?? roleConfig.pipelines.low;
  return normalizeRolePipeline(stages, [ROLE_WORKER]);
}

function ensureRoleState(state, plan, assessment, stages, config) {
  if (!state.roleState || typeof state.roleState !== 'object') {
    state.roleState = {};
  }

  const planId = plan.planId;
  const roleConfig = resolveRoleOrchestration(config);
  const stageReuse = roleConfig.stageReuse;
  const stageKey = stages.join('>');
  const planShapeHash = computePlanShapeHash(plan);
  const scopeSignature = [...(plan.specTargets ?? [])].sort().join('|');
  const existing = state.roleState[planId];
  if (
    existing &&
    existing.stageKey === stageKey &&
    existing.effectiveRiskTier === assessment.effectiveRiskTier
  ) {
    return existing;
  }

  const existingUpdatedAtMs = parseIsoMillis(existing?.updatedAt);
  const maxAgeMs = Math.max(0, stageReuse.maxAgeMinutes) * 60 * 1000;
  const ageEligible =
    existingUpdatedAtMs != null &&
    (maxAgeMs <= 0 || Date.now() - existingUpdatedAtMs <= maxAgeMs);
  const shapeEligible = !stageReuse.requiresStablePlanHash || existing?.planShapeHash === planShapeHash;
  const scopeEligible = !stageReuse.requiresNoScopeChange || existing?.scopeSignature === scopeSignature;
  const runEligible = !stageReuse.sameRunOnly || existing?.runId === state.runId;

  const completedExisting = new Set(
    Array.isArray(existing?.completedStages)
      ? existing.completedStages.map((entry) => normalizeRoleName(entry, ''))
      : []
  );
  const reusableRoles = new Set(stageReuse.roles ?? []);
  const reusablePrefixStages = [];
  if (stageReuse.enabled && existing && ageEligible && shapeEligible && scopeEligible && runEligible) {
    for (const role of stages) {
      const normalizedRole = normalizeRoleName(role, '');
      if (!normalizedRole || !completedExisting.has(normalizedRole) || !reusableRoles.has(normalizedRole)) {
        break;
      }
      reusablePrefixStages.push(normalizedRole);
    }
  }

  const currentIndex = Math.min(reusablePrefixStages.length, Math.max(0, stages.length - 1));
  const next = {
    stages: [...stages],
    stageKey,
    currentIndex,
    completedStages: [...new Set(reusablePrefixStages)],
    declaredRiskTier: assessment.declaredRiskTier,
    computedRiskTier: assessment.computedRiskTier,
    effectiveRiskTier: assessment.effectiveRiskTier,
    score: assessment.score,
    sensitive: assessment.sensitive,
    sensitiveTagHits: assessment.sensitiveTagHits ?? [],
    sensitivePathHits: assessment.sensitivePathHits ?? [],
    reasons: assessment.reasons ?? [],
    runId: state.runId,
    planShapeHash,
    scopeSignature,
    reusedPrefixStages: [...new Set(reusablePrefixStages)],
    updatedAt: nowIso()
  };
  state.roleState[planId] = next;
  return next;
}

function advanceRoleState(roleState, role) {
  const completed = new Set(Array.isArray(roleState.completedStages) ? roleState.completedStages : []);
  completed.add(role);
  roleState.completedStages = [...completed];
  if (roleState.currentIndex < roleState.stages.length - 1) {
    roleState.currentIndex += 1;
  }
  roleState.updatedAt = nowIso();
}

function resetRoleStateToImplementation(roleState) {
  const workerIndex = roleState.stages.indexOf(ROLE_WORKER);
  if (workerIndex >= 0) {
    roleState.currentIndex = workerIndex;
  } else {
    roleState.currentIndex = Math.max(0, roleState.stages.length - 1);
  }
  roleState.updatedAt = nowIso();
}

function setRoleStateToRole(roleState, role) {
  const targetRole = normalizeRoleName(role, ROLE_WORKER);
  const targetIndex = roleState.stages.indexOf(targetRole);
  if (targetIndex >= 0) {
    roleState.currentIndex = targetIndex;
  } else {
    resetRoleStateToImplementation(roleState);
  }
  roleState.updatedAt = nowIso();
}

function pendingReasonSuggestsImplementationHandoff(reason) {
  const text = String(reason ?? '').trim().toLowerCase();
  if (!text) {
    return false;
  }

  return (
    text.includes('implementation') ||
    text.includes('worker') ||
    text.includes('read-only') ||
    text.includes('read only') ||
    text.includes('cannot apply plan doc edits')
  );
}

function resolvePendingNextRole(currentRole, roleState, roleIndex, pendingReason) {
  if (currentRole === ROLE_REVIEWER) {
    return ROLE_WORKER;
  }

  if (currentRole !== ROLE_PLANNER && currentRole !== ROLE_EXPLORER) {
    return currentRole;
  }

  if (!pendingReasonSuggestsImplementationHandoff(pendingReason)) {
    return currentRole;
  }

  const nextRoleIndex = Math.min(roleIndex + 1, Math.max(0, roleState.stages.length - 1));
  const nextRoleCandidate = roleState.stages[nextRoleIndex] ?? currentRole;
  return normalizeRoleName(nextRoleCandidate, currentRole);
}

function pendingSignalSignature(role, nextRole, reason) {
  const normalizedRole = normalizeRoleName(role, ROLE_WORKER);
  const normalizedNextRole = normalizeRoleName(nextRole, normalizedRole);
  const normalizedReason = String(reason ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return `${normalizedRole}->${normalizedNextRole}|${normalizedReason}`;
}

function approvalEnvPrefixForRiskTier(riskTier) {
  const normalized = parseRiskTier(riskTier, 'low');
  if (normalized === 'high') {
    return 'ORCH_APPROVED_MEDIUM=1 ORCH_APPROVED_HIGH=1 ';
  }
  if (normalized === 'medium') {
    return 'ORCH_APPROVED_MEDIUM=1 ';
  }
  return '';
}

function suggestedResumeCommand(state, riskTier) {
  const mode = String(state?.effectiveMode ?? 'guarded').trim() || 'guarded';
  return `${approvalEnvPrefixForRiskTier(riskTier)}npm run automation:resume -- --mode ${mode} --retry-failed true --auto-unblock true --max-plans 1 --allow-dirty true`;
}

function deriveOutcomeNextSteps(plan, outcome, state, config, riskTier) {
  const status = String(outcome?.outcome ?? '').trim().toLowerCase();
  const reason = String(outcome?.reason ?? '').trim();
  const reasonLower = reason.toLowerCase();
  const steps = [];
  const resumeCommand = suggestedResumeCommand(state, riskTier);
  const securityApprovalField =
    resolveRoleOrchestration(config).approvalGates.securityApprovalMetadataField || 'Security-Approval';

  if (status === 'blocked') {
    if (reasonLower.includes('security approval required')) {
      steps.push(`Set '${securityApprovalField}: approved' in the active plan metadata.`);
      steps.push(`Resume: ${resumeCommand}`);
      return steps;
    }
    if (reasonLower.includes('dependency')) {
      steps.push('Complete missing dependency plans first, then resume.');
      steps.push(`Resume: ${resumeCommand}`);
      return steps;
    }
    steps.push('Run `npm run automation:audit -- --json true` to inspect blocker details.');
    steps.push(`Resume: ${resumeCommand}`);
    return steps;
  }

  if (status === 'failed') {
    if (reasonLower.includes('executor exited with status') || reasonLower.includes('executor failed')) {
      steps.push(`Inspect latest session logs in docs/ops/automation/runtime/${state.runId}/.`);
    }
    if (reasonLower.includes('atomic root policy violation')) {
      steps.push('Stage only plan-scoped files (or run with `--commit false`) while unrelated workspace changes exist.');
    }
    steps.push(`Retry: ${resumeCommand}`);
    return steps;
  }

  if (status === 'pending') {
    if (reasonLower.includes('repeated pending signal without progress')) {
      steps.push('Update the active plan with one concrete worker action (or mark current role stage complete) before retry.');
    } else if (reasonLower.includes('maximum sessions reached without completion')) {
      steps.push('Narrow to one implementation slice, then resume.');
    } else if (reasonLower.includes('host validation pending')) {
      steps.push('Run required host validations (for example `npm run verify:full`) and resume.');
    }
    steps.push(`Continue: ${resumeCommand}`);
    return steps;
  }

  return steps;
}

function requiresSecurityApproval(plan, assessment, config) {
  const roleConfig = resolveRoleOrchestration(config);
  if (!roleConfig.enabled) {
    return false;
  }
  if (assessment.effectiveRiskTier === 'high' && roleConfig.approvalGates.requireSecurityOpsForHigh) {
    return true;
  }
  if (
    assessment.effectiveRiskTier === 'medium' &&
    assessment.sensitive &&
    roleConfig.approvalGates.requireSecurityOpsForMediumIfSensitive
  ) {
    return true;
  }
  return false;
}

function createInitialState(runId, requestedMode, effectiveMode) {
  return {
    version: 2,
    runId,
    requestedMode,
    effectiveMode,
    startedAt: nowIso(),
    lastUpdated: nowIso(),
    queue: [],
    completedPlanIds: [],
    blockedPlanIds: [],
    failedPlanIds: [],
    capabilities: {
      dockerSocket: false,
      dockerSocketPath: null,
      localhostBind: false,
      browserRuntime: false,
      checkedAt: null
    },
    validationState: {},
    recoveryState: {},
    evidenceState: {},
    roleState: {},
    parallelState: {
      activeWorkers: {},
      lastResults: {}
    },
    inProgress: null,
    stats: {
      promotions: 0,
      handoffs: 0,
      validationFailures: 0,
      commits: 0
    }
  };
}

function normalizePersistedState(state) {
  const normalized = { ...(state ?? {}) };
  normalized.queue = Array.isArray(normalized.queue) ? normalized.queue : [];
  normalized.completedPlanIds = Array.isArray(normalized.completedPlanIds) ? normalized.completedPlanIds : [];
  normalized.blockedPlanIds = Array.isArray(normalized.blockedPlanIds) ? normalized.blockedPlanIds : [];
  normalized.failedPlanIds = Array.isArray(normalized.failedPlanIds) ? normalized.failedPlanIds : [];
  normalized.validationState =
    normalized.validationState && typeof normalized.validationState === 'object' ? normalized.validationState : {};
  normalized.recoveryState =
    normalized.recoveryState && typeof normalized.recoveryState === 'object' ? normalized.recoveryState : {};
  normalized.evidenceState =
    normalized.evidenceState && typeof normalized.evidenceState === 'object' ? normalized.evidenceState : {};
  normalized.roleState =
    normalized.roleState && typeof normalized.roleState === 'object' ? normalized.roleState : {};
  normalized.parallelState =
    normalized.parallelState && typeof normalized.parallelState === 'object'
      ? normalized.parallelState
      : { activeWorkers: {}, lastResults: {} };
  normalized.parallelState.activeWorkers =
    normalized.parallelState.activeWorkers && typeof normalized.parallelState.activeWorkers === 'object'
      ? normalized.parallelState.activeWorkers
      : {};
  normalized.parallelState.lastResults =
    normalized.parallelState.lastResults && typeof normalized.parallelState.lastResults === 'object'
      ? normalized.parallelState.lastResults
      : {};
  normalized.capabilities =
    normalized.capabilities && typeof normalized.capabilities === 'object'
      ? normalized.capabilities
      : {
          dockerSocket: false,
          dockerSocketPath: null,
          localhostBind: false,
          browserRuntime: false,
          checkedAt: null
        };
  normalized.stats =
    normalized.stats && typeof normalized.stats === 'object'
      ? {
          promotions: asInteger(normalized.stats.promotions, 0),
          handoffs: asInteger(normalized.stats.handoffs, 0),
          validationFailures: asInteger(normalized.stats.validationFailures, 0),
          commits: asInteger(normalized.stats.commits, 0)
        }
      : {
          promotions: 0,
          handoffs: 0,
          validationFailures: 0,
          commits: 0
        };
  return normalized;
}

function dockerSocketCandidates() {
  const candidates = [];
  const dockerHost = String(process.env.DOCKER_HOST || '').trim();
  if (dockerHost.startsWith('unix://')) {
    candidates.push(dockerHost.replace(/^unix:\/\//, ''));
  }
  candidates.push(path.join(os.homedir(), '.docker', 'run', 'docker.sock'));
  candidates.push('/var/run/docker.sock');
  return [...new Set(candidates)];
}

async function detectLocalhostBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function detectCapabilities() {
  let dockerSocketPath = null;
  for (const candidate of dockerSocketCandidates()) {
    try {
      await fs.access(candidate, fsSync.constants.R_OK | fsSync.constants.W_OK);
      dockerSocketPath = candidate;
      break;
    } catch {
      // Continue candidate scan.
    }
  }

  const localhostBind = await detectLocalhostBind();

  return {
    dockerSocket: Boolean(dockerSocketPath),
    dockerSocketPath,
    localhostBind,
    browserRuntime: localhostBind,
    checkedAt: nowIso()
  };
}

function ensurePlanValidationState(state, planId) {
  if (!state.validationState || typeof state.validationState !== 'object') {
    state.validationState = {};
  }
  if (!state.validationState[planId] || typeof state.validationState[planId] !== 'object') {
    state.validationState[planId] = {
      always: 'pending',
      host: 'pending',
      provider: null,
      reason: null,
      updatedAt: null
    };
  }
  return state.validationState[planId];
}

function updatePlanValidationState(state, planId, patch) {
  const current = ensurePlanValidationState(state, planId);
  state.validationState[planId] = {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
}

function ensurePlanRecoveryState(state, planId) {
  if (!state.recoveryState || typeof state.recoveryState !== 'object') {
    state.recoveryState = {};
  }
  if (!state.recoveryState[planId] || typeof state.recoveryState[planId] !== 'object') {
    state.recoveryState[planId] = {
      failedAttempts: 0,
      lastFailureReason: null,
      lastFailedAt: null,
      lastRetriedAt: null,
      updatedAt: null
    };
  }
  return state.recoveryState[planId];
}

function failedAttemptCount(state, planId) {
  const current = state?.recoveryState?.[planId];
  return Math.max(0, asInteger(current?.failedAttempts, 0));
}

function registerPlanFailureAttempt(state, planId, reason) {
  const current = ensurePlanRecoveryState(state, planId);
  state.recoveryState[planId] = {
    ...current,
    failedAttempts: Math.max(0, asInteger(current.failedAttempts, 0)) + 1,
    lastFailureReason: reason ?? null,
    lastFailedAt: nowIso(),
    updatedAt: nowIso()
  };
}

function registerPlanRetryAttempt(state, planId) {
  const current = ensurePlanRecoveryState(state, planId);
  state.recoveryState[planId] = {
    ...current,
    lastRetriedAt: nowIso(),
    updatedAt: nowIso()
  };
}

function clearPlanRecoveryState(state, planId) {
  if (!state.recoveryState || typeof state.recoveryState !== 'object') {
    return;
  }
  delete state.recoveryState[planId];
}

function ensureEvidenceState(state, planId) {
  if (!state.evidenceState || typeof state.evidenceState !== 'object') {
    state.evidenceState = {};
  }
  if (!state.evidenceState[planId] || typeof state.evidenceState[planId] !== 'object') {
    state.evidenceState[planId] = {
      indexPath: null,
      referenceCount: 0,
      signature: '',
      updatedAt: null
    };
  }
  return state.evidenceState[planId];
}

async function saveState(paths, state, dryRun) {
  state.lastUpdated = nowIso();
  await writeJson(paths.runStatePath, state, dryRun);
}

function redactString(value) {
  let redacted = String(value);
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  redacted = redacted.replace(/(token|secret|password|passphrase|api[-_]?key)\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, '$1=[REDACTED]');
  return redacted;
}

function sanitizeEventDetails(value, parentKey = '') {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEventDetails(entry, parentKey));
  }

  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        next[key] = REDACTED_VALUE;
        continue;
      }
      next[key] = sanitizeEventDetails(entry, key);
    }
    return next;
  }

  if (typeof value === 'string') {
    if (SENSITIVE_KEY_REGEX.test(parentKey)) {
      return REDACTED_VALUE;
    }
    return redactString(value);
  }

  return value;
}

async function logEvent(paths, state, type, details, dryRun) {
  const sanitizedDetails = sanitizeEventDetails(details ?? {});
  const event = {
    timestamp: nowIso(),
    runId: state.runId,
    taskId: sanitizedDetails.planId ?? null,
    type,
    model: sanitizedDetails.model ?? process.env.ORCH_MODEL_ID ?? 'n/a',
    mode: state.effectiveMode,
    details: sanitizedDetails
  };
  await appendJsonLine(paths.runEventsPath, event, dryRun);
}

function resolveEffectiveMode(requestedMode) {
  const normalized = (requestedMode ?? 'guarded').toLowerCase() === 'full' ? 'full' : 'guarded';

  if (normalized === 'full' && process.env.ORCH_ALLOW_FULL_AUTONOMY !== '1') {
    return {
      requestedMode: 'full',
      effectiveMode: 'guarded',
      downgraded: true,
      reason: 'ORCH_ALLOW_FULL_AUTONOMY is not set to 1'
    };
  }

  return {
    requestedMode: normalized,
    effectiveMode: normalized,
    downgraded: false,
    reason: null
  };
}

function evaluatePolicyGate(plan, effectiveMode) {
  const autonomyAllowed = (plan.autonomyAllowed || 'both').toLowerCase();
  const riskTier = (plan.riskTier || 'low').toLowerCase();

  if (autonomyAllowed === 'guarded' && effectiveMode === 'full') {
    return { allowed: false, reason: 'Plan is restricted to guarded mode.' };
  }

  if (autonomyAllowed === 'full' && effectiveMode !== 'full') {
    return { allowed: false, reason: 'Plan requires full mode but run is guarded.' };
  }

  if (riskTier === 'medium' && process.env.ORCH_APPROVED_MEDIUM !== '1') {
    return {
      allowed: false,
      reason: `Missing ORCH_APPROVED_MEDIUM=1 for medium risk execution in ${effectiveMode} mode.`
    };
  }

  if (riskTier === 'high' && process.env.ORCH_APPROVED_HIGH !== '1') {
    return {
      allowed: false,
      reason: `Missing ORCH_APPROVED_HIGH=1 for high risk execution in ${effectiveMode} mode.`
    };
  }

  return { allowed: true, reason: null };
}

async function readPlanRecord(rootDir, filePath, phase) {
  const content = await fs.readFile(filePath, 'utf8');
  const metadata = parseMetadata(content);
  const rel = assertSafeRelativePlanPath(toPosix(path.relative(rootDir, filePath)));
  const explicitPlanId = metadataValue(metadata, 'Plan-ID');
  const parsedExplicitPlanId = explicitPlanId ? parsePlanId(explicitPlanId, null) : null;
  if (explicitPlanId && !parsedExplicitPlanId) {
    throw new Error(
      `Invalid Plan-ID '${explicitPlanId}' in ${rel}. Use lowercase kebab-case (e.g. 'fix-auth-timeout').`
    );
  }
  const inferredPlanId = inferPlanId(content, filePath);
  const planId = parsedExplicitPlanId ?? inferredPlanId;
  if (!planId) {
    throw new Error(`Could not parse or infer Plan-ID for ${rel}.`);
  }
  assertValidPlanId(planId, rel);

  const status = normalizeStatus(metadataValue(metadata, 'Status'));
  const priority = parsePriority(metadataValue(metadata, 'Priority'));
  const owner = metadataValue(metadata, 'Owner') ?? 'unassigned';
  const dependencies = parseListField(metadataValue(metadata, 'Dependencies')).map((dependency) => {
    const parsedDependency = parsePlanId(dependency, null);
    if (!parsedDependency) {
      throw new Error(
        `Invalid dependency '${dependency}' in ${rel}. Dependencies must be lowercase kebab-case Plan-ID values.`
      );
    }
    return parsedDependency;
  });
  const tags = parseListField(metadataValue(metadata, 'Tags'));
  const specTargets = parseListField(metadataValue(metadata, 'Spec-Targets')).map((target) => (
    resolveSafeRepoPath(rootDir, target, `Spec-Targets entry in ${rel}`).rel
  ));
  const doneEvidence = parseListField(metadataValue(metadata, 'Done-Evidence'));
  const atomicRoots = parseListField(metadataValue(metadata, 'Atomic-Roots')).map((entry) => (
    resolveSafeRepoPath(rootDir, entry, `Atomic-Roots entry in ${rel}`).rel
  ));
  const concurrencyLocks = parseListField(metadataValue(metadata, 'Concurrency-Locks')).map((entry) => (
    String(entry).trim().toLowerCase()
  )).filter(Boolean);

  return {
    planId,
    phase,
    filePath,
    rel,
    title: (content.match(/^#\s+(.+)$/m)?.[1] ?? planId).trim(),
    content,
    metadata,
    status,
    priority,
    owner,
    dependencies,
    tags,
    specTargets,
    doneEvidence,
    atomicRoots,
    concurrencyLocks,
    autonomyAllowed: metadataValue(metadata, 'Autonomy-Allowed') ?? 'both',
    riskTier: parseRiskTier(metadataValue(metadata, 'Risk-Tier'), 'low'),
    securityApproval: parseSecurityApproval(metadataValue(metadata, 'Security-Approval'), SECURITY_APPROVAL_NOT_REQUIRED),
    acceptanceCriteria: metadataValue(metadata, 'Acceptance-Criteria') ?? ''
  };
}

async function loadPlanRecords(rootDir, directoryPath, phase) {
  const files = await listMarkdownFiles(directoryPath);
  const records = [];
  for (const filePath of files) {
    records.push(await readPlanRecord(rootDir, filePath, phase));
  }
  return records;
}

function uniqueByPlanId(records) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.planId)) {
      map.set(record.planId, record);
    }
  }
  return map;
}

async function promoteFuturePlans(paths, state, options) {
  const futures = await loadPlanRecords(paths.rootDir, paths.futureDir, 'future');
  const active = await loadPlanRecords(paths.rootDir, paths.activeDir, 'active');
  const completed = await loadPlanRecords(paths.rootDir, paths.completedDir, 'completed');

  const takenPlanIds = new Set([...active, ...completed].map((plan) => plan.planId));
  let promoted = 0;

  for (const future of futures) {
    if (future.status !== 'ready-for-promotion') {
      continue;
    }

    if (takenPlanIds.has(future.planId)) {
      await logEvent(paths, state, 'promotion_skipped', {
        planId: future.planId,
        reason: 'Plan-ID already present in active/completed plans'
      }, options.dryRun);
      continue;
    }

    const targetDate = todayIsoDate();
    const targetName = datedPlanFileName(targetDate, future.planId);
    let targetPath = path.join(paths.activeDir, targetName);

    if (await exists(targetPath)) {
      const parsed = path.parse(targetName);
      targetPath = path.join(paths.activeDir, `${parsed.name}-${Date.now()}${parsed.ext || '.md'}`);
    }

    const promotedMetadata = {
      'Plan-ID': future.planId,
      Status: 'queued',
      Priority: future.priority,
      Owner: future.owner,
      'Acceptance-Criteria': future.acceptanceCriteria || 'Define acceptance criteria before execution.',
      Dependencies: future.dependencies.length > 0 ? future.dependencies.join(', ') : 'none',
      'Autonomy-Allowed': metadataValue(future.metadata, 'Autonomy-Allowed') ?? 'both',
      'Risk-Tier': parseRiskTier(metadataValue(future.metadata, 'Risk-Tier'), 'low'),
      'Security-Approval':
        parseSecurityApproval(
          metadataValue(future.metadata, 'Security-Approval'),
          SECURITY_APPROVAL_NOT_REQUIRED
        ),
      'Spec-Targets': future.specTargets.length > 0 ? future.specTargets.join(', ') : 'docs/product-specs/current-state.md',
      'Done-Evidence': future.doneEvidence.length > 0 ? future.doneEvidence.join(', ') : 'pending'
    };

    const promotedContent = setMetadataFields(future.content, promotedMetadata);
    if (!options.dryRun) {
      await fs.writeFile(targetPath, promotedContent, 'utf8');
      await fs.unlink(future.filePath);
    }

    promoted += 1;
    state.stats.promotions += 1;
    takenPlanIds.add(future.planId);

    await logEvent(paths, state, 'promoted_future', {
      planId: future.planId,
      source: future.rel,
      target: toPosix(path.relative(paths.rootDir, targetPath))
    }, options.dryRun);
  }

  return promoted;
}

function executablePlans(activePlans, completedPlanIds, excludedPlanIds = new Set(), recoveredPlanIds = new Set()) {
  return activePlans
    .filter((plan) => ACTIVE_STATUSES.has(plan.status))
    .filter((plan) => plan.status !== 'completed')
    .filter((plan) =>
      plan.status !== 'failed' && plan.status !== 'blocked'
        ? true
        : recoveredPlanIds.has(plan.planId)
    )
    .filter((plan) => !excludedPlanIds.has(plan.planId))
    .filter((plan) => plan.dependencies.every((dependency) => completedPlanIds.has(dependency)))
    .sort((a, b) => {
      const priorityDelta = priorityOrder(a.priority) - priorityOrder(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return a.rel.localeCompare(b.rel);
    });
}

function blockedPlans(activePlans, completedPlanIds, excludedPlanIds = new Set()) {
  return activePlans
    .filter((plan) => ACTIVE_STATUSES.has(plan.status))
    .filter((plan) => !excludedPlanIds.has(plan.planId))
    .filter((plan) => plan.dependencies.some((dependency) => !completedPlanIds.has(dependency)));
}

function securityApprovalSatisfied(plan, assessment, config) {
  const securityApprovalField =
    resolveRoleOrchestration(config).approvalGates.securityApprovalMetadataField || 'Security-Approval';
  const securityApprovalValue = parseSecurityApproval(
    metadataValue(plan.metadata, securityApprovalField),
    plan.securityApproval
  );
  if (!requiresSecurityApproval(plan, assessment, config)) {
    return { ok: true, securityApprovalField, securityApprovalValue };
  }
  return {
    ok: securityApprovalValue === SECURITY_APPROVAL_APPROVED,
    securityApprovalField,
    securityApprovalValue
  };
}

function classifyRecoverablePlans(activePlans, completedPlanIds, state, options, config) {
  const retryableFailed = new Map();
  const unblockable = new Map();

  for (const plan of activePlans) {
    if (!ACTIVE_STATUSES.has(plan.status)) {
      continue;
    }
    if (!planDependenciesReady(plan, completedPlanIds)) {
      continue;
    }

    const assessment = computeRiskAssessment(plan, state, config);
    const policyGate = evaluatePolicyGate(
      {
        ...plan,
        riskTier: assessment.effectiveRiskTier
      },
      state.effectiveMode
    );
    const approval = securityApprovalSatisfied(plan, assessment, config);

    if (plan.status === 'failed' && options.retryFailedPlans) {
      const attempts = failedAttemptCount(state, plan.planId);
      if (attempts < asInteger(options.maxFailedRetries, DEFAULT_MAX_FAILED_RETRIES) && policyGate.allowed && approval.ok) {
        retryableFailed.set(plan.planId, {
          attempts,
          maxAttempts: asInteger(options.maxFailedRetries, DEFAULT_MAX_FAILED_RETRIES)
        });
      }
    }

    if (plan.status === 'blocked' && options.autoUnblockPlans) {
      if (policyGate.allowed && approval.ok) {
        unblockable.set(plan.planId, {
          reason: 'Policy/approval gates now satisfied.'
        });
      }
    }
  }

  return {
    retryableFailed,
    unblockable
  };
}

async function setPlanStatus(planPath, status, dryRun) {
  if (dryRun) return;

  const content = await fs.readFile(planPath, 'utf8');
  const updated = setMetadataFields(content, { Status: status });
  await fs.writeFile(planPath, updated, 'utf8');
}

async function snapshotFileState(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { exists: true, content };
  } catch {
    return { exists: false, content: null };
  }
}

async function restoreFileState(filePath, snapshot) {
  if (!snapshot?.exists) {
    if (await exists(filePath)) {
      await fs.unlink(filePath);
    }
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, snapshot.content ?? '', 'utf8');
}

function replaceExecutorTokens(command, plan, sessionContext) {
  const {
    session,
    runId,
    mode,
    resultPath,
    contactPackFile = DEFAULT_RUNTIME_CONTEXT_PATH,
    role = ROLE_WORKER,
    effectiveRiskTier = 'low',
    declaredRiskTier = 'low',
    stageIndex = 1,
    stageTotal = 1
  } = sessionContext;
  return command
    .replaceAll('{plan_id}', plan.planId)
    .replaceAll('{plan_file}', plan.rel)
    .replaceAll('{run_id}', runId)
    .replaceAll('{mode}', mode)
    .replaceAll('{session}', String(session))
    .replaceAll('{role}', role)
    .replaceAll('{effective_risk_tier}', effectiveRiskTier)
    .replaceAll('{declared_risk_tier}', declaredRiskTier)
    .replaceAll('{stage_index}', String(stageIndex))
    .replaceAll('{stage_total}', String(stageTotal))
    .replaceAll('{result_path}', resultPath)
    .replaceAll('{contact_pack_file}', contactPackFile);
}

async function prepareTaskContactPack(plan, paths, state, options, config, sessionContext) {
  const runtimeContextPath =
    String(config?.context?.runtimeContextPath ?? DEFAULT_RUNTIME_CONTEXT_PATH).trim() ||
    DEFAULT_RUNTIME_CONTEXT_PATH;
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const contactPackEnabled = asBoolean(options.contactPackEnabled, DEFAULT_CONTACT_PACKS_ENABLED);
  if (!contactPackEnabled) {
    return {
      enabled: false,
      contactPackFile: toPosix(runtimeContextPath),
      generated: false,
      reason: 'contact packs disabled by configuration'
    };
  }

  const contactPackRel = toPosix(
    path.join('docs', 'ops', 'automation', 'runtime', 'contacts', state.runId, plan.planId, `${role}.md`)
  );

  if (options.dryRun) {
    return {
      enabled: true,
      contactPackFile: contactPackRel,
      generated: false,
      reason: 'dry-run'
    };
  }

  const result = await compileTaskContactPack({
    rootDir: paths.rootDir,
    planId: plan.planId,
    planFile: plan.rel,
    role,
    declaredRiskTier: sessionContext.declaredRiskTier,
    effectiveRiskTier: sessionContext.effectiveRiskTier,
    stageIndex: sessionContext.stageIndex,
    stageTotal: sessionContext.stageTotal,
    outputPath: contactPackRel,
    configPath: toPosix(path.relative(paths.rootDir, paths.orchestratorConfigPath)),
    maxPolicyBullets: options.contactPackMaxPolicyBullets,
    includeRecentEvidence: options.contactPackIncludeRecentEvidence,
    maxRecentEvidenceItems: options.contactPackMaxRecentEvidenceItems
  });

  return {
    enabled: true,
    contactPackFile: result.outputPath,
    generated: true,
    bytes: result.bytes,
    lineCount: result.lineCount,
    policyRuleCount: result.policyRuleCount,
    evidenceCount: result.evidenceCount
  };
}

async function writeSessionExecutorLog(logPathAbs, metadataLines, outputText, dryRun) {
  if (dryRun) {
    return;
  }
  const parts = [...metadataLines, '', '## Output', '', String(outputText ?? '').trim()];
  const rendered = `${parts.join('\n').trimEnd()}\n`;
  await fs.writeFile(logPathAbs, rendered, 'utf8');
}

async function executePlanSession(plan, paths, state, options, config, sessionNumber, sessionContext = {}) {
  assertValidPlanId(plan.planId, plan.rel);
  assertSafeRelativePlanPath(plan.rel);
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const roleProfile = resolveRoleExecutionProfile(config, role);
  const effectiveRiskTier = parseRiskTier(sessionContext.effectiveRiskTier, 'low');
  const declaredRiskTier = parseRiskTier(sessionContext.declaredRiskTier, 'low');
  const stageIndex = asInteger(sessionContext.stageIndex, 1);
  const stageTotal = asInteger(sessionContext.stageTotal, 1);
  const workerNoTouchRetryCount = Math.max(0, asInteger(sessionContext.workerNoTouchRetryCount, 0));
  const workerNoTouchRetryLimit = Math.max(
    0,
    asInteger(
      sessionContext.workerNoTouchRetryLimit,
      asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)
    )
  );
  const runSessionDir = path.join(paths.runtimeDir, state.runId);
  const resultPathAbs = path.join(runSessionDir, `${plan.planId}-${role}-session-${sessionNumber}.result.json`);
  const resultPathRel = toPosix(path.relative(paths.rootDir, resultPathAbs));
  const sessionLogPathAbs = path.join(runSessionDir, `${plan.planId}-${role}-session-${sessionNumber}.executor.log`);
  const sessionLogPathRel = toPosix(path.relative(paths.rootDir, sessionLogPathAbs));

  if (!options.dryRun) {
    await fs.mkdir(runSessionDir, { recursive: true });
  }

  const configuredExecutor = configuredExecutorCommand(options, config);
  if (!configuredExecutor) {
    return {
      status: 'failed',
      reason: 'No executor command configured (set docs/ops/automation/orchestrator.config.json executor.command).'
    };
  }

  let contactPack = null;
  try {
    contactPack = await prepareTaskContactPack(plan, paths, state, options, config, {
      role,
      declaredRiskTier,
      effectiveRiskTier,
      stageIndex,
      stageTotal
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `Failed to prepare task contact pack: ${reason}`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null
    };
  }
  const contactPackFile = String(contactPack?.contactPackFile ?? DEFAULT_RUNTIME_CONTEXT_PATH).trim() || DEFAULT_RUNTIME_CONTEXT_PATH;

  const renderedCommand = replaceExecutorTokens(
    configuredExecutor,
    plan,
    {
      session: sessionNumber,
      runId: state.runId,
      mode: state.effectiveMode,
      resultPath: resultPathRel,
      role,
      effectiveRiskTier,
      declaredRiskTier,
      stageIndex,
      stageTotal,
      contactPackFile
    }
  );
  const captureOutput = shouldCaptureCommandOutput(options);
  const sessionLogPath = captureOutput ? sessionLogPathRel : null;

  await logEvent(paths, state, 'session_started', {
    planId: plan.planId,
    session: sessionNumber,
    role,
    provider: roleProfile.provider,
    model: roleProfile.model || null,
    reasoningEffort: roleProfile.reasoningEffort,
    sandboxMode: roleProfile.sandboxMode,
    effectiveRiskTier,
    declaredRiskTier,
    stageIndex,
    stageTotal,
    contactPackFile,
    contactPackEnabled: contactPack?.enabled ?? false,
    contactPackGenerated: contactPack?.generated ?? false,
    contactPackPolicyRuleCount: contactPack?.policyRuleCount ?? 0,
    contactPackEvidenceCount: contactPack?.evidenceCount ?? 0,
    executorCommandConfigured: true,
    commandLogPath: sessionLogPath
  }, options.dryRun);

  if (options.dryRun) {
    return {
      status: 'completed',
      summary: 'Dry-run: executor skipped.',
      resultPayloadFound: true,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      contactPackFile,
      durationSeconds: 0
    };
  }

  const env = {
    ...process.env,
    ORCH_RUN_ID: state.runId,
    ORCH_PLAN_ID: plan.planId,
    ORCH_PLAN_FILE: plan.rel,
    ORCH_SESSION: String(sessionNumber),
    ORCH_ROLE: role,
    ORCH_EFFECTIVE_RISK_TIER: effectiveRiskTier,
    ORCH_DECLARED_RISK_TIER: declaredRiskTier,
    ORCH_STAGE_INDEX: String(stageIndex),
    ORCH_STAGE_TOTAL: String(stageTotal),
    ORCH_MODE: state.effectiveMode,
    ORCH_RESULT_PATH: resultPathRel,
    ORCH_CONTACT_PACK_FILE: contactPackFile,
    ORCH_CONTEXT_THRESHOLD: String(options.contextThreshold),
    ORCH_HANDOFF_TOKEN_BUDGET: String(options.handoffTokenBudget),
    ORCH_WORKER_NO_TOUCH_RETRY_COUNT: String(workerNoTouchRetryCount),
    ORCH_WORKER_NO_TOUCH_RETRY_LIMIT: String(workerNoTouchRetryLimit)
  };

  const executionStartedAtMs = Date.now();
  const execution = await runShellMonitored(
    renderedCommand,
    paths.rootDir,
    env,
    options.executorTimeoutMs,
    captureOutput ? 'pipe' : 'inherit',
    options,
    {
      phase: 'session',
      planId: plan.planId,
      role,
      activity: roleActivity(role)
    }
  );
  const commandOutput = captureOutput ? executionOutput(execution) : '';
  const durationSeconds = Math.max(0, (Date.now() - executionStartedAtMs) / 1000);
  const sessionTouchSummary = execution.touchSummary ?? null;
  const withSessionTouchSummary = (result) => ({
    ...result,
    touchSummary: sessionTouchSummary,
    contactPackFile,
    durationSeconds
  });
  if (captureOutput) {
    await writeSessionExecutorLog(
      sessionLogPathAbs,
      [
        '# Executor Session Log',
        '',
        `- Run-ID: ${state.runId}`,
        `- Plan-ID: ${plan.planId}`,
        `- Plan-File: ${plan.rel}`,
        `- Session: ${sessionNumber}`,
        `- Stage: ${stageIndex}/${stageTotal}`,
        `- Role: ${role}`,
        `- Provider: ${roleProfile.provider}`,
        `- Model: ${roleProfile.model || 'n/a'}`,
        `- Reasoning-Effort: ${roleProfile.reasoningEffort}`,
        `- Sandbox-Mode: ${roleProfile.sandboxMode}`,
        `- Effective-Risk-Tier: ${effectiveRiskTier}`,
        `- Declared-Risk-Tier: ${declaredRiskTier}`,
        `- Contact-Pack: ${contactPackFile}`
      ],
      commandOutput,
      options.dryRun
    );
  }
  const handoffExitCode = asInteger(options.handoffExitCode, asInteger(config.executor.handoffExitCode, DEFAULT_HANDOFF_EXIT_CODE));

  if (didTimeout(execution)) {
    const reason = `Executor command timed out after ${Math.floor((options.executorTimeoutMs ?? 0) / 1000)}s`;
    return withSessionTouchSummary({
      status: 'failed',
      reason,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  if (didFirstTouchDeadlineTimeout(execution)) {
    const deadlineSeconds = Math.max(
      0,
      asInteger(options.workerFirstTouchDeadlineSeconds, DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS)
    );
    return withSessionTouchSummary({
      status: 'pending',
      reason: `Worker first-touch deadline exceeded (${deadlineSeconds}s) without repository edits.`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  if (execution.signal) {
    const reason = `Executor terminated by signal ${execution.signal}`;
    return withSessionTouchSummary({
      status: 'failed',
      reason,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  if (execution.status === handoffExitCode) {
    return withSessionTouchSummary({
      status: 'handoff_required',
      reason: `Executor exited with handoff code ${handoffExitCode}`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  if (execution.status !== 0) {
    const reason = `Executor exited with status ${execution.status}`;
    return withSessionTouchSummary({
      status: 'failed',
      reason,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  const resultPayload = await readJsonIfExists(resultPathAbs, null);
  if (!resultPayload) {
    if (options.requireResultPayload) {
      return withSessionTouchSummary({
        status: 'handoff_required',
        reason:
          'Executor exited 0 without writing ORCH_RESULT_PATH payload. Rolling over immediately to preserve context safety.',
        role,
        provider: roleProfile.provider,
        model: roleProfile.model || null,
        sessionLogPath,
        failureTail: tailLines(commandOutput, options.failureTailLines)
      });
    }

    return withSessionTouchSummary({
      status: 'completed',
      summary: 'Executor completed without result payload.',
      resultPayloadFound: false,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  const reportedStatus = String(resultPayload.status ?? 'completed').trim().toLowerCase();
  const normalizedStatus =
    reportedStatus === 'handoff_required' || reportedStatus === 'blocked' || reportedStatus === 'failed' || reportedStatus === 'pending'
      ? reportedStatus
      : 'completed';
  const rawContextRemaining = resultPayload.contextRemaining;
  const hasContextRemaining =
    typeof rawContextRemaining === 'number' && Number.isFinite(rawContextRemaining);
  const contextRemaining = hasContextRemaining ? rawContextRemaining : null;

  if (normalizedStatus === 'completed' && options.requireResultPayload && !hasContextRemaining) {
    return withSessionTouchSummary({
      status: 'handoff_required',
      reason:
        'Executor payload is missing numeric contextRemaining. Rolling over immediately to avoid low-context execution.',
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  if (
    normalizedStatus === 'completed' &&
    hasContextRemaining &&
    contextRemaining <= options.contextThreshold
  ) {
    return withSessionTouchSummary({
      status: 'handoff_required',
      reason: `contextRemaining (${contextRemaining}) at/below threshold (${options.contextThreshold})`,
      summary: resultPayload.summary ?? '',
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  return withSessionTouchSummary({
    status: normalizedStatus,
    reason: resultPayload.reason ?? null,
    summary: resultPayload.summary ?? null,
    contextRemaining,
    resultPayloadFound: true,
    role,
    provider: roleProfile.provider,
    model: roleProfile.model || null,
    sessionLogPath
  });
}

function sectionBounds(content, sectionTitle) {
  const headingRegex = new RegExp(`^##\\s+${escapeRegex(sectionTitle)}\\s*$`, 'm');
  const match = headingRegex.exec(content);
  if (!match) {
    return null;
  }

  const start = match.index;
  const headingEnd = content.indexOf('\n', start);
  const bodyStart = headingEnd === -1 ? content.length : headingEnd + 1;
  const remaining = content.slice(bodyStart);
  const nextHeading = /^##\s+/m.exec(remaining);
  const end = nextHeading ? bodyStart + nextHeading.index : content.length;
  return { start, bodyStart, end };
}

function upsertSection(content, sectionTitle, bodyLines) {
  const body = Array.isArray(bodyLines) ? bodyLines.join('\n') : String(bodyLines ?? '');
  const rendered = `## ${sectionTitle}\n\n${body.trim()}\n`;
  const bounds = sectionBounds(content, sectionTitle);

  if (!bounds) {
    return `${content.trimEnd()}\n\n${rendered}\n`;
  }

  const before = content.slice(0, bounds.start).trimEnd();
  const after = content.slice(bounds.end).trimStart();
  if (!after) {
    return `${before}\n\n${rendered}\n`;
  }
  return `${before}\n\n${rendered}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

function removeSection(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return content;
  }

  const before = content.slice(0, bounds.start).trimEnd();
  const after = content.slice(bounds.end).trimStart();
  if (!before && !after) {
    return '';
  }
  if (!before) {
    return `${after}\n`;
  }
  if (!after) {
    return `${before}\n`;
  }
  return `${before}\n\n${after}`.replace(/\n{3,}/g, '\n\n');
}

function sectionBody(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return '';
  }
  return content.slice(bounds.bodyStart, bounds.end).trim();
}

function sectionlessPreamble(content) {
  const firstSectionIndex = content.search(/^##\s+/m);
  if (firstSectionIndex === -1) {
    return content.trimEnd();
  }
  return content.slice(0, firstSectionIndex).trimEnd();
}

function appendToDeliveryLog(content, entryLine) {
  const sectionTitle = 'Automated Delivery Log';
  const body = sectionBody(content, sectionTitle);
  const lines = body ? body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  lines.push(`- ${entryLine}`);
  return upsertSection(content, sectionTitle, lines);
}

function normalizeBulletSection(content, sectionTitle) {
  const body = sectionBody(content, sectionTitle);
  if (!body) {
    return content;
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    unique.push(line);
  }

  if (unique.length === 0) {
    return content;
  }
  return upsertSection(content, sectionTitle, unique);
}

function removeDuplicateSections(content, sectionTitle) {
  let updated = content;
  while (true) {
    const first = sectionBounds(updated, sectionTitle);
    if (!first) {
      return updated;
    }
    const rest = updated.slice(first.end);
    const second = sectionBounds(rest, sectionTitle);
    if (!second) {
      return updated;
    }

    const secondStart = first.end + second.start;
    const secondEnd = first.end + second.end;
    const before = updated.slice(0, secondStart).trimEnd();
    const after = updated.slice(secondEnd).trimStart();
    updated = after ? `${before}\n\n${after}` : `${before}\n`;
  }
}

function normalizeClosureSection(content) {
  const body = sectionBody(content, 'Closure');
  if (!body) {
    return content;
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

  const seenKeys = new Set();
  const seenLines = new Set();
  const kept = [];
  for (const line of lines) {
    const keyMatch = line.match(/^- ([^:]+):/);
    if (keyMatch) {
      const key = keyMatch[1].trim().toLowerCase();
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      let normalizedLine = line;
      if (key === 'completed at') {
        const rawValue = line.replace(/^- Completed At:\s*/, '').trim();
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(rawValue)) {
          normalizedLine = `- Completed At: ${rawValue}Z`;
        }
      }
      kept.push(normalizedLine);
      continue;
    }

    if (seenLines.has(line)) {
      continue;
    }
    seenLines.add(line);
    kept.push(line);
  }

  if (kept.length === 0) {
    return content;
  }
  return upsertSection(content, 'Closure', kept);
}

function updateSimpleMetadataField(content, field, value) {
  const regex = new RegExp(`^${escapeRegex(field)}:\\s*.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${field}: ${value}`);
  }
  return `${content.trimEnd()}\n${field}: ${value}\n`;
}

function documentStatusValue(content) {
  const match = content.match(/^Status:\s*(.+)$/m);
  return normalizeStatus(match?.[1] ?? '');
}

async function evaluateCompletionGate(planPath) {
  const content = await fs.readFile(planPath, 'utf8');
  const documentStatus = documentStatusValue(content);

  if (documentStatus === 'completed') {
    return { ready: true, reason: null };
  }

  return {
    ready: false,
    reason: 'Plan is not marked complete. Set top-level `Status: completed` in the plan document when ready.'
  };
}
async function findPlanRecordById(paths, planId) {
  const [activePlans, completedPlans] = await Promise.all([
    loadPlanRecords(paths.rootDir, paths.activeDir, 'active'),
    loadPlanRecords(paths.rootDir, paths.completedDir, 'completed')
  ]);

  return (
    activePlans.find((candidate) => candidate.planId === planId) ??
    completedPlans.find((candidate) => candidate.planId === planId) ??
    null
  );
}

function syncPlanRecord(plan, nextRecord) {
  if (!nextRecord) {
    return;
  }

  plan.filePath = nextRecord.filePath;
  plan.rel = nextRecord.rel;
  plan.phase = nextRecord.phase;
  plan.status = nextRecord.status;
  plan.metadata = nextRecord.metadata;
  plan.content = nextRecord.content;
  plan.tags = nextRecord.tags;
  plan.specTargets = nextRecord.specTargets;
  plan.dependencies = nextRecord.dependencies;
  plan.riskTier = nextRecord.riskTier;
  plan.securityApproval = nextRecord.securityApproval;
  plan.autonomyAllowed = nextRecord.autonomyAllowed;
}


function resolveDefaultValidationCommands(rootDir, configuredCommands) {
  if (Array.isArray(configuredCommands) && configuredCommands.length > 0) {
    return configuredCommands;
  }

  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fsSync.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
    const scripts = parsed.scripts ?? {};
    const preferred = ['docs:verify', 'conformance:verify', 'architecture:verify', 'agent:verify', 'plans:verify'];
    return preferred.filter((name) => typeof scripts[name] === 'string').map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

function parseValidationCommandList(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value
    .split(';;')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveAlwaysValidationCommands(rootDir, options, config) {
  const explicit = parseValidationCommandList(options.validationCommands);
  if (explicit.length > 0) {
    return explicit;
  }

  if (Array.isArray(config.validation?.always) && config.validation.always.length > 0) {
    return config.validation.always;
  }

  return resolveDefaultValidationCommands(rootDir, config.validationCommands);
}

function resolveHostRequiredValidationCommands(config) {
  if (!Array.isArray(config.validation?.hostRequired)) {
    return [];
  }
  return config.validation.hostRequired.map((entry) => String(entry ?? '').trim()).filter(Boolean);
}

function resolveHostValidationMode(config) {
  const mode = String(config.validation?.host?.mode ?? DEFAULT_HOST_VALIDATION_MODE).trim().toLowerCase();
  if (mode === 'ci' || mode === 'local' || mode === 'hybrid') {
    return mode;
  }
  return DEFAULT_HOST_VALIDATION_MODE;
}

async function runValidationCommands(paths, commands, options, label, state = null, plan = null) {
  if (commands.length === 0) {
    return {
      ok: false,
      failedCommand: '(none configured)',
      reason: `No ${label} commands configured.`,
      evidence: []
    };
  }

  const evidence = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (options.dryRun) {
      evidence.push(`Dry-run: ${label} command skipped: ${command}`);
      continue;
    }

    const captureOutput = shouldCaptureCommandOutput(options);
    const result = await runShellMonitored(
      command,
      paths.rootDir,
      process.env,
      options.validationTimeoutMs,
      captureOutput ? 'pipe' : 'inherit',
      options,
      {
        phase: 'validation',
        planId: plan?.planId ?? 'run',
        role: 'validator',
        activity: label.toLowerCase() === 'validation' ? 'validation-always' : label.toLowerCase()
      }
    );
    const output = captureOutput ? executionOutput(result) : '';
    let logPathRel = null;
    if (captureOutput && state?.runId) {
      const runSessionDir = path.join(paths.runtimeDir, state.runId);
      const planToken = (plan?.planId ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-');
      const labelToken = label.toLowerCase().replace(/[^A-Za-z0-9._-]/g, '-');
      const logPathAbs = path.join(runSessionDir, `${planToken}-${labelToken}-${index + 1}.log`);
      logPathRel = toPosix(path.relative(paths.rootDir, logPathAbs));
      await fs.mkdir(runSessionDir, { recursive: true });
      await writeSessionExecutorLog(
        logPathAbs,
        [
          `# ${label} Command Log`,
          '',
          `- Run-ID: ${state.runId}`,
          `- Plan-ID: ${plan?.planId ?? 'n/a'}`,
          `- Command-Index: ${index + 1}/${commands.length}`,
          `- Command: ${command}`
        ],
        output,
        options.dryRun
      );
    }

    if (didTimeout(result)) {
      return {
        ok: false,
        failedCommand: command,
        reason: `${label} command timed out after ${Math.floor((options.validationTimeoutMs ?? 0) / 1000)}s`,
        evidence,
        outputLogPath: logPathRel,
        failureTail: tailLines(output, options.failureTailLines)
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        failedCommand: command,
        reason: `${label} failed: ${command}`,
        evidence,
        outputLogPath: logPathRel,
        failureTail: tailLines(output, options.failureTailLines)
      };
    }
    if (logPathRel) {
      evidence.push(`${label} output log: ${logPathRel}`);
    }
    evidence.push(`${label} passed: ${command}`);
  }

  return {
    ok: true,
    evidence
  };
}

async function runAlwaysValidation(paths, options, config, state = null, plan = null) {
  const commands = resolveAlwaysValidationCommands(paths.rootDir, options, config);
  if (commands.length === 0 && !options.requireAlwaysValidationCommands) {
    return {
      ok: true,
      evidence: ['Validation lane skipped: no validation.always commands configured.']
    };
  }
  return runValidationCommands(paths, commands, options, 'Validation', state, plan);
}

function hostProviderResultPath(paths, state, planId, provider, attemptId) {
  const baseDir = path.join(paths.runtimeDir, state.runId, 'host-validation');
  const attemptToken = String(attemptId ?? 'attempt').replace(/[^A-Za-z0-9_-]/g, '-');
  const fileName = `${planId}-${provider}-${attemptToken}.result.json`;
  return {
    abs: path.join(baseDir, fileName),
    rel: toPosix(path.relative(paths.rootDir, path.join(baseDir, fileName)))
  };
}

async function executeHostProviderCommand(provider, command, commands, paths, state, plan, options) {
  const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resultPaths = hostProviderResultPath(paths, state, plan.planId, provider, attemptId);
  const logPathAbs = resultPaths.abs.replace(/\.result\.json$/, '.log');
  const logPathRel = toPosix(path.relative(paths.rootDir, logPathAbs));
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(resultPaths.abs), { recursive: true });
  }

  if (options.dryRun) {
    return {
      status: 'passed',
      evidence: [`Dry-run: host validation (${provider}) command skipped: ${command}`],
      provider
    };
  }

  const env = {
    ...process.env,
    ORCH_RUN_ID: state.runId,
    ORCH_PLAN_ID: plan.planId,
    ORCH_PLAN_FILE: plan.rel,
    ORCH_HOST_PROVIDER: provider,
    ORCH_HOST_VALIDATION_COMMANDS: JSON.stringify(commands),
    ORCH_HOST_VALIDATION_RESULT_PATH: resultPaths.rel
  };

  const captureOutput = shouldCaptureCommandOutput(options);
  const outputLogPath = captureOutput ? logPathRel : null;
  const executionResult = await runShellMonitored(
    command,
    paths.rootDir,
    env,
    options.hostValidationTimeoutMs,
    captureOutput ? 'pipe' : 'inherit',
    options,
    {
      phase: 'host-validation',
      planId: plan.planId,
      role: provider,
      activity: 'validation-host'
    }
  );
  const output = captureOutput ? executionOutput(executionResult) : '';
  if (captureOutput) {
    await writeSessionExecutorLog(
      logPathAbs,
      [
        '# Host Validation Command Log',
        '',
        `- Run-ID: ${state.runId}`,
        `- Plan-ID: ${plan.planId}`,
        `- Provider: ${provider}`,
        `- Command: ${command}`
      ],
      output,
      options.dryRun
    );
  }

  if (didTimeout(executionResult)) {
    return {
      status: 'unavailable',
      provider,
      reason: `Host validation provider '${provider}' timed out after ${Math.floor((options.hostValidationTimeoutMs ?? 0) / 1000)}s`,
      outputLogPath,
      failureTail: tailLines(output, options.failureTailLines)
    };
  }

  if (executionResult.signal) {
    return {
      status: 'unavailable',
      provider,
      reason: `Host validation provider '${provider}' terminated by signal ${executionResult.signal}`,
      outputLogPath,
      failureTail: tailLines(output, options.failureTailLines)
    };
  }

  const payload = await readJsonIfExists(resultPaths.abs, null);
  if (payload && typeof payload === 'object') {
    const reported = String(payload.status ?? '').trim().toLowerCase();
    if (reported === 'passed' || reported === 'failed' || reported === 'pending') {
      if (executionResult.status !== 0 && reported === 'passed') {
        return {
          status: 'unavailable',
          provider,
          reason:
            `Host validation provider '${provider}' reported 'passed' but command exited with status ${executionResult.status}`,
          outputLogPath,
          failureTail: tailLines(output, options.failureTailLines)
        };
      }
      return {
        status: reported,
        provider,
        reason: payload.reason ?? null,
        evidence: Array.isArray(payload.evidence)
          ? payload.evidence.map((entry) => String(entry))
          : [`Host validation (${provider}) result payload loaded from ${resultPaths.rel}`],
        outputLogPath
      };
    }
  }

  if (executionResult.status === 0) {
    return {
      status: 'passed',
      provider,
      evidence: [
        `Host validation passed via ${provider} command: ${command}`,
        outputLogPath ? `Host validation output log: ${outputLogPath}` : null
      ].filter(Boolean)
    };
  }

  return {
    status: 'unavailable',
    provider,
    reason: `Host validation provider '${provider}' command exited with status ${executionResult.status}`,
    outputLogPath,
    failureTail: tailLines(output, options.failureTailLines)
  };
}

async function runHostValidation(paths, state, plan, options, config) {
  const commands = resolveHostRequiredValidationCommands(config);
  if (commands.length === 0) {
    if (options.requireHostValidationCommands) {
      return {
        status: 'failed',
        provider: 'none',
        reason:
          'Host validation lane is required but validation.hostRequired is empty. Configure host-required validation commands.',
        evidence: []
      };
    }
    return {
      status: 'passed',
      provider: 'none',
      reason: null,
      evidence: ['No host-required validation commands configured.']
    };
  }

  const mode = resolveHostValidationMode(config);
  const ciCommand = String(config.validation?.host?.ci?.command ?? '').trim();
  const localCommand = String(config.validation?.host?.local?.command ?? '').trim();
  const capability = state.capabilities ?? {};
  const localCapable = Boolean(capability.dockerSocket) && Boolean(capability.localhostBind);

  const tryCi = async () => {
    if (!ciCommand) {
      return {
        status: 'unavailable',
        provider: 'ci',
        reason: 'No CI host-validation command configured.'
      };
    }
    await logEvent(paths, state, 'host_validation_started', {
      planId: plan.planId,
      provider: 'ci',
      mode
    }, options.dryRun);
    return executeHostProviderCommand('ci', ciCommand, commands, paths, state, plan, options);
  };

  const tryLocal = async () => {
    if (localCommand) {
      await logEvent(paths, state, 'host_validation_started', {
        planId: plan.planId,
        provider: 'local',
        mode
      }, options.dryRun);
      return executeHostProviderCommand('local', localCommand, commands, paths, state, plan, options);
    }

    if (!localCapable) {
      return {
        status: 'unavailable',
        provider: 'local',
        reason: [
          'Local host validation unavailable.',
          capability.dockerSocket ? '' : 'Docker socket not reachable.',
          capability.localhostBind ? '' : 'localhost bind is not permitted.'
        ].filter(Boolean).join(' ')
      };
    }

    const result = await runValidationCommands(
      paths,
      commands,
      {
        ...options,
        validationTimeoutMs: options.hostValidationTimeoutMs ?? options.validationTimeoutMs
      },
      'Host validation',
      state,
      plan
    );
    if (!result.ok) {
      return {
        status: 'failed',
        provider: 'local',
        reason: `Host validation failed: ${result.failedCommand}`,
        evidence: result.evidence,
        outputLogPath: result.outputLogPath ?? null,
        failureTail: result.failureTail ?? ''
      };
    }

    return {
      status: 'passed',
      provider: 'local',
      reason: null,
      evidence: result.evidence
    };
  };

  if (mode === 'ci') {
    const ciResult = await tryCi();
    if (ciResult.status === 'passed' || ciResult.status === 'failed') {
      return ciResult;
    }
    return {
      status: 'pending',
      provider: 'ci',
      reason: ciResult.reason ?? 'CI host validation unavailable.',
      evidence: ciResult.evidence ?? [],
      outputLogPath: ciResult.outputLogPath ?? null,
      failureTail: ciResult.failureTail ?? ''
    };
  }

  if (mode === 'local') {
    const localResult = await tryLocal();
    if (localResult.status === 'passed' || localResult.status === 'failed') {
      return localResult;
    }
    return {
      status: 'pending',
      provider: 'local',
      reason: localResult.reason ?? 'Local host validation unavailable.',
      evidence: localResult.evidence ?? [],
      outputLogPath: localResult.outputLogPath ?? null,
      failureTail: localResult.failureTail ?? ''
    };
  }

  const ciResult = await tryCi();
  if (ciResult.status === 'passed' || ciResult.status === 'failed') {
    return ciResult;
  }

  const localResult = await tryLocal();
  if (localResult.status === 'passed' || localResult.status === 'failed') {
    return localResult;
  }

  return {
    status: 'pending',
    provider: 'hybrid',
    reason: [ciResult.reason, localResult.reason].filter(Boolean).join(' | ') || 'Host validation unavailable.',
    evidence: [...(ciResult.evidence ?? []), ...(localResult.evidence ?? [])],
    outputLogPath: ciResult.outputLogPath ?? localResult.outputLogPath ?? null,
    failureTail: ciResult.failureTail || localResult.failureTail || ''
  };
}

function normalizeEvidenceReference(reference, planRel) {
  if (!reference) return null;
  const clean = String(reference).trim().split('#')[0];
  if (!clean || clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('mailto:')) {
    return null;
  }

  const planDir = toPosix(path.posix.dirname(planRel));
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return toPosix(path.posix.normalize(path.posix.join(planDir, clean)));
  }
  if (clean.startsWith('docs/')) {
    return toPosix(path.posix.normalize(clean));
  }
  return null;
}

function extractEvidenceReferencesFromContent(content, planRel) {
  const found = new Set();
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  const inlineCodeRegex = /`([^`]+)`/g;

  let linkMatch;
  while ((linkMatch = linkRegex.exec(content)) != null) {
    const normalized = normalizeEvidenceReference(linkMatch[1], planRel);
    if (normalized && normalized.includes('/evidence/')) {
      found.add(normalized);
    }
  }

  let codeMatch;
  while ((codeMatch = inlineCodeRegex.exec(content)) != null) {
    const normalized = normalizeEvidenceReference(codeMatch[1], planRel);
    if (normalized && normalized.includes('/evidence/')) {
      found.add(normalized);
    }
  }

  return [...found];
}

async function collectEvidenceReferences(paths, planRel, content, maxReferences) {
  const candidates = extractEvidenceReferencesFromContent(content, planRel);
  const enriched = [];

  for (const relPath of candidates) {
    const absPath = path.join(paths.rootDir, relPath);
    try {
      const stats = await fs.stat(absPath);
      enriched.push({
        relPath,
        absPath,
        mtimeMs: stats.mtimeMs
      });
    } catch {
      // Skip missing references to keep index deterministic and valid.
    }
  }

  enriched.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath));
  const selected = enriched.slice(0, maxReferences);
  return {
    selected,
    totalFound: enriched.length
  };
}

function resolveEvidenceLifecycleConfig(config) {
  const lifecycle = config?.evidence?.lifecycle ?? {};
  return {
    trackMode: String(lifecycle.trackMode ?? DEFAULT_EVIDENCE_TRACK_MODE).trim().toLowerCase(),
    dedupMode: String(lifecycle.dedupMode ?? DEFAULT_EVIDENCE_DEDUP_MODE).trim().toLowerCase(),
    pruneOnComplete: asBoolean(lifecycle.pruneOnComplete, DEFAULT_EVIDENCE_PRUNE_ON_COMPLETE),
    keepMaxPerBlocker: Math.max(1, asInteger(lifecycle.keepMaxPerBlocker, DEFAULT_EVIDENCE_KEEP_MAX_PER_BLOCKER))
  };
}

function evidenceStemInfo(fileName) {
  const stem = path.parse(fileName).name.toLowerCase();
  const hasNumericPrefix = /^\d+-/.test(stem);
  const withoutPrefix = stem.replace(/^\d+-/, '');
  let tokens = withoutPrefix.split('-').filter(Boolean);
  const hasNoise = tokens.some((token) => EVIDENCE_NOISE_TOKENS.has(token));

  if (hasNoise) {
    const afterIndex = tokens.findIndex((token) => token === 'after');
    const postIndex = tokens.findIndex((token, index) => token === 'post' && index > 1);
    const boundaryIndex =
      afterIndex > 1 && postIndex > 1 ? Math.min(afterIndex, postIndex) : afterIndex > 1 ? afterIndex : postIndex;
    if (boundaryIndex > 1) {
      tokens = tokens.slice(0, boundaryIndex);
    }

    while (tokens.length > 2) {
      const last = tokens[tokens.length - 1];
      if (EVIDENCE_NOISE_TOKENS.has(last) || /^\d+$/.test(last)) {
        tokens = tokens.slice(0, -1);
        continue;
      }
      break;
    }
  }

  const key = (tokens.join('-') || withoutPrefix || stem).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return {
    key,
    noisy: hasNoise,
    hasNumericPrefix
  };
}

async function collectEvidenceMarkdownFiles(directoryAbs, directoryRel, rootDir) {
  const entries = await fs.readdir(directoryAbs, { withFileTypes: true });
  const markdownFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'readme.md') {
      continue;
    }
    const absPath = path.join(directoryAbs, entry.name);
    const relPath = toPosix(path.relative(rootDir, absPath));
    const stats = await fs.stat(absPath);
    const info = evidenceStemInfo(entry.name);
    markdownFiles.push({
      fileName: entry.name,
      absPath,
      relPath,
      mtimeMs: stats.mtimeMs,
      key: info.key,
      noisy: info.noisy,
      hasNumericPrefix: info.hasNumericPrefix
    });
  }

  return markdownFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName));
}

function titleCaseFromSlug(value) {
  return String(value)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function defaultEvidenceReadmePreamble(directoryRel) {
  const folderName = path.posix.basename(directoryRel);
  const title = titleCaseFromSlug(folderName || 'evidence');
  return [
    `# ${title} Evidence`,
    '',
    `Path: \`${directoryRel}\``,
    'Purpose: Canonical evidence artifacts for this execution area.'
  ].join('\n');
}

function renderEvidenceDirectoryReadme(rawReadme, directoryRel, keptFiles) {
  const artifactLines =
    keptFiles.length > 0
      ? keptFiles
          .sort((a, b) => a.fileName.localeCompare(b.fileName))
          .map((entry) => `- [\`${entry.fileName}\`](./${entry.fileName})`)
      : ['- none'];
  const curationLines = [
    '- Dedup Mode: strict-upsert',
    `- Files Currently Kept: ${keptFiles.length}`,
    '- Canonicalized: true'
  ];

  const preamble = sectionlessPreamble(rawReadme) || defaultEvidenceReadmePreamble(directoryRel);
  const resultSummary = sectionBody(rawReadme, 'Result Summary');
  const rebuilt = [
    preamble,
    '',
    '## Evidence Artifacts',
    '',
    ...artifactLines,
    ''
  ];
  if (resultSummary) {
    rebuilt.push('## Result Summary', '', resultSummary, '');
  }
  rebuilt.push('## Curation', '', ...curationLines, '');
  return `${rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

async function writeEvidenceIndexReadme(paths, options) {
  if (options.dryRun) {
    return;
  }

  await fs.mkdir(paths.evidenceIndexDir, { recursive: true });
  const indexFiles = await listMarkdownFiles(paths.evidenceIndexDir, ['README.md', '.gitkeep']);
  const readmeAbs = path.join(paths.evidenceIndexDir, 'README.md');
  const lines = [
    '# Evidence Index',
    '',
    'Purpose: Canonical, plan-scoped evidence references after curation/completion.',
    '',
    '## Usage',
    '',
    '- Each completed plan should point `Done-Evidence` to `docs/exec-plans/evidence-index/<plan-id>.md`.',
    '- Each index file is the compact source for retained evidence links.',
    '',
    '## Indexed Plans',
    ''
  ];

  if (indexFiles.length === 0) {
    lines.push('- none');
  } else {
    for (const indexFile of indexFiles) {
      const rel = toPosix(path.relative(paths.evidenceIndexDir, indexFile));
      lines.push(`- [\`${rel}\`](./${rel})`);
    }
  }

  lines.push('', '## Policy', '');
  lines.push('- Evidence is curated to keep useful, non-redundant information.');
  lines.push('- Repeated unchanged blocker reruns are collapsed by strict-upsert policy.');
  lines.push('');

  const rendered = `${lines.join('\n')}\n`;
  let existing = null;
  try {
    existing = await fs.readFile(readmeAbs, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== rendered) {
    await fs.writeFile(readmeAbs, rendered, 'utf8');
  }
}

async function curateEvidenceDirectory(paths, directoryRel, options, keepMaxPerBlocker) {
  const directoryAbs = path.join(paths.rootDir, directoryRel);
  const files = await collectEvidenceMarkdownFiles(directoryAbs, directoryRel, paths.rootDir);
  if (files.length === 0) {
    return {
      directoryRel,
      keptCount: 0,
      prunedCount: 0,
      replacements: []
    };
  }

  const byKey = new Map();
  for (const file of files) {
    if (!byKey.has(file.key)) {
      byKey.set(file.key, []);
    }
    byKey.get(file.key).push(file);
  }

  const keep = new Set();
  const prune = [];
  const replacements = [];

  for (const groupFiles of byKey.values()) {
    groupFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName));
    const shouldDeduplicate =
      groupFiles.length > keepMaxPerBlocker &&
      (groupFiles.some((entry) => entry.noisy) || groupFiles.every((entry) => entry.hasNumericPrefix));

    if (!shouldDeduplicate) {
      for (const entry of groupFiles) {
        keep.add(entry.relPath);
      }
      continue;
    }

    const keepEntries = groupFiles.slice(0, keepMaxPerBlocker);
    for (const entry of keepEntries) {
      keep.add(entry.relPath);
    }

    const replacementTarget = keepEntries[0]?.relPath ?? groupFiles[0].relPath;
    for (const entry of groupFiles.slice(keepMaxPerBlocker)) {
      prune.push(entry);
      replacements.push({
        fromRel: entry.relPath,
        fallbackToRel: replacementTarget
      });
    }
  }

  const readmeAbs = path.join(directoryAbs, 'README.md');
  const readmeExists = await exists(readmeAbs);
  const readmeRel = toPosix(path.relative(paths.rootDir, readmeAbs));
  const keptFiles = files.filter((entry) => !prune.some((removed) => removed.relPath === entry.relPath));

  const finalizedReplacements = replacements.map((entry) => ({
    fromRel: entry.fromRel,
    toRel: readmeRel || entry.fallbackToRel
  }));

  if (!options.dryRun) {
    for (const removed of prune) {
      await fs.unlink(removed.absPath);
    }

    let rawReadme = '';
    if (readmeExists) {
      rawReadme = await fs.readFile(readmeAbs, 'utf8');
    }
    const nextReadme = renderEvidenceDirectoryReadme(rawReadme, directoryRel, keptFiles);
    if (nextReadme !== rawReadme) {
      await fs.writeFile(readmeAbs, nextReadme, 'utf8');
    }
  }

  return {
    directoryRel,
    keptCount: keptFiles.length,
    prunedCount: prune.length,
    replacements: finalizedReplacements
  };
}

function replacePathEverywhere(content, fromValue, toValue) {
  if (!fromValue || fromValue === toValue || !content.includes(fromValue)) {
    return { content, replaced: 0 };
  }
  const parts = content.split(fromValue);
  const replaced = Math.max(0, parts.length - 1);
  return {
    content: parts.join(toValue),
    replaced
  };
}

async function rewriteEvidenceReferencesInPlanDocs(paths, replacements, options) {
  if (replacements.length === 0) {
    return { filesUpdated: 0, replacementsApplied: 0 };
  }

  const [activeFiles, completedFiles] = await Promise.all([
    listMarkdownFiles(paths.activeDir),
    listMarkdownFiles(paths.completedDir)
  ]);
  const files = [...activeFiles, ...completedFiles];

  let filesUpdated = 0;
  let replacementsApplied = 0;

  for (const filePath of files) {
    const fileRel = toPosix(path.relative(paths.rootDir, filePath));
    const fileDir = path.posix.dirname(fileRel);
    const original = await fs.readFile(filePath, 'utf8');
    let updated = original;

    for (const replacement of replacements) {
      const direct = replacePathEverywhere(updated, replacement.fromRel, replacement.toRel);
      updated = direct.content;
      replacementsApplied += direct.replaced;

      const relativeFrom = toPosix(path.posix.relative(fileDir, replacement.fromRel));
      const relativeTo = toPosix(path.posix.relative(fileDir, replacement.toRel));
      const relative = replacePathEverywhere(updated, relativeFrom, relativeTo);
      updated = relative.content;
      replacementsApplied += relative.replaced;

      const dotRelativeFrom = relativeFrom.startsWith('.') ? relativeFrom : `./${relativeFrom}`;
      const dotRelativeTo = relativeTo.startsWith('.') ? relativeTo : `./${relativeTo}`;
      const dotRelative = replacePathEverywhere(updated, dotRelativeFrom, dotRelativeTo);
      updated = dotRelative.content;
      replacementsApplied += dotRelative.replaced;
    }

    if (updated !== original) {
      filesUpdated += 1;
      if (!options.dryRun) {
        await fs.writeFile(filePath, updated, 'utf8');
      }
    }
  }

  return {
    filesUpdated,
    replacementsApplied
  };
}

function evidenceDirectoriesFromContent(content, planRel) {
  const references = extractEvidenceReferencesFromContent(content, planRel);
  const directories = new Set();
  for (const ref of references) {
    if (!ref.startsWith('docs/exec-plans/') || !ref.includes('/evidence/')) {
      continue;
    }
    directories.add(toPosix(path.posix.dirname(ref)));
  }
  return [...directories].sort();
}

function matchesPlanIdFilter(plan, planIdFilter) {
  if (!planIdFilter) {
    return true;
  }
  const needle = String(planIdFilter).trim().toLowerCase();
  return plan.planId.toLowerCase().includes(needle) || plan.rel.toLowerCase().includes(needle);
}

async function curateEvidenceDirectories(paths, directories, options, config) {
  const lifecycle = resolveEvidenceLifecycleConfig(config);
  if (lifecycle.trackMode !== 'curated' || lifecycle.dedupMode !== 'strict-upsert') {
    return {
      directoriesVisited: 0,
      filesPruned: 0,
      filesKept: 0,
      filesUpdated: 0,
      replacementsApplied: 0
    };
  }

  const uniqueDirectories = [...new Set(directories)].sort();
  const allReplacements = [];
  let filesPruned = 0;
  let filesKept = 0;

  for (const directoryRel of uniqueDirectories) {
    const directoryAbs = path.join(paths.rootDir, directoryRel);
    if (!(await exists(directoryAbs))) {
      continue;
    }
    const result = await curateEvidenceDirectory(paths, directoryRel, options, lifecycle.keepMaxPerBlocker);
    filesPruned += result.prunedCount;
    filesKept += result.keptCount;
    allReplacements.push(...result.replacements);
  }

  const replacementBySource = new Map();
  for (const replacement of allReplacements) {
    replacementBySource.set(replacement.fromRel, replacement.toRel);
  }
  const replacements = [...replacementBySource.entries()].map(([fromRel, toRel]) => ({ fromRel, toRel }));
  const rewriteSummary = await rewriteEvidenceReferencesInPlanDocs(paths, replacements, options);

  return {
    directoriesVisited: uniqueDirectories.length,
    filesPruned,
    filesKept,
    filesUpdated: rewriteSummary.filesUpdated,
    replacementsApplied: rewriteSummary.replacementsApplied
  };
}

async function curateEvidenceForPlan(plan, paths, options, config) {
  if (!(await exists(plan.filePath))) {
    return {
      directoriesVisited: 0,
      filesPruned: 0,
      filesKept: 0,
      filesUpdated: 0,
      replacementsApplied: 0
    };
  }

  const content = await fs.readFile(plan.filePath, 'utf8');
  const directories = evidenceDirectoriesFromContent(content, plan.rel);
  return curateEvidenceDirectories(paths, directories, options, config);
}

async function collectAllActiveEvidenceDirectories(paths, planIdFilter = null) {
  const root = path.join(paths.activeDir, 'evidence');
  if (!(await exists(root))) {
    return [];
  }

  const normalizedFilter = planIdFilter ? String(planIdFilter).trim().toLowerCase() : null;
  const directories = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    let hasMarkdownArtifact = false;

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
        hasMarkdownArtifact = true;
      }
    }

    if (!hasMarkdownArtifact) {
      continue;
    }

    const rel = toPosix(path.relative(paths.rootDir, current));
    if (normalizedFilter && !rel.toLowerCase().includes(normalizedFilter)) {
      continue;
    }
    directories.push(rel);
  }

  return directories.sort();
}

async function collectAllCompletedEvidenceDirectories(paths, planIdFilter = null) {
  const completedPlans = await loadPlanRecords(paths.rootDir, paths.completedDir, 'completed');
  const directories = new Set();

  for (const plan of completedPlans) {
    if (!matchesPlanIdFilter(plan, planIdFilter)) {
      continue;
    }
    const refs = evidenceDirectoriesFromContent(plan.content, plan.rel);
    for (const dir of refs) {
      directories.add(dir);
    }
  }

  return [...directories].sort();
}

function normalizeCurationScope(scopeValue) {
  const normalized = String(scopeValue ?? 'all').trim().toLowerCase();
  if (normalized === 'active' || normalized === 'completed' || normalized === 'all') {
    return normalized;
  }
  throw new Error(`Invalid scope '${scopeValue}'. Expected one of: active, completed, all.`);
}

async function writeEvidenceIndex(paths, plan, content, options, config, overrides = {}) {
  const mode = String(config.evidence?.compaction?.mode ?? 'compact-index').trim().toLowerCase();
  if (mode !== 'compact-index') {
    return null;
  }

  const maxReferences = asInteger(config.evidence?.compaction?.maxReferences, DEFAULT_EVIDENCE_MAX_REFERENCES);
  const { selected, totalFound } = await collectEvidenceReferences(paths, plan.rel, content, maxReferences);
  const sourcePlanRel = toPosix(String(overrides.sourcePlanRel ?? plan.rel));
  const indexRel = toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, `${plan.planId}.md`)));
  const indexAbs = path.join(paths.rootDir, indexRel);

  const lines = [
    `# Evidence Index: ${plan.planId}`,
    '',
    `- Plan-ID: ${plan.planId}`,
    `- Last Updated: ${todayIsoDate()}`,
    `- Source Plan: \`${sourcePlanRel}\``,
    `- Total Evidence References Found: ${totalFound}`,
    `- References Included: ${selected.length}`,
    ''
  ];

  lines.push('## Canonical References', '');
  if (selected.length === 0) {
    lines.push('- No evidence references detected in the plan content yet.');
  } else {
    for (const ref of selected) {
      const relativeLink = toPosix(path.relative(path.dirname(indexAbs), ref.absPath));
      lines.push(`- [${ref.relPath}](${relativeLink})`);
    }
  }

  lines.push('', '## Notes', '');
  lines.push('- This index is the canonical compact view for plan evidence.');
  lines.push('- Superseded rerun artifacts are curated according to evidence.lifecycle policy.');
  lines.push('');

  if (!options.dryRun) {
    const rendered = `${lines.join('\n')}\n`;
    await fs.mkdir(path.dirname(indexAbs), { recursive: true });
    let existingText = null;
    try {
      existingText = await fs.readFile(indexAbs, 'utf8');
    } catch {
      existingText = null;
    }
    if (existingText !== rendered) {
      await fs.writeFile(indexAbs, rendered, 'utf8');
    }
    await writeEvidenceIndexReadme(paths, options);
  }

  return {
    indexPath: indexRel,
    referenceCount: selected.length,
    totalFound
  };
}

async function refreshEvidenceIndex(plan, paths, state, options, config) {
  if (!(await exists(plan.filePath))) {
    return null;
  }

  const content = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, content, options, config);
  if (!indexResult) {
    return null;
  }

  const previous = ensureEvidenceState(state, plan.planId);
  const signature = `${indexResult.indexPath}|${indexResult.referenceCount}|${indexResult.totalFound}`;
  state.evidenceState[plan.planId] = {
    indexPath: indexResult.indexPath,
    referenceCount: indexResult.referenceCount,
    signature,
    updatedAt: nowIso()
  };

  if (previous.signature !== signature) {
    await logEvent(paths, state, 'evidence_compacted', {
      planId: plan.planId,
      indexPath: indexResult.indexPath,
      referenceCount: indexResult.referenceCount,
      totalFound: indexResult.totalFound
    }, options.dryRun);
  }

  return indexResult;
}

async function canonicalizeCompletedPlanEvidence(plan, paths, options, config) {
  if (!(await exists(plan.filePath))) {
    return { updated: false, indexPath: null };
  }

  const raw = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, raw, options, config);
  if (!indexResult) {
    return { updated: false, indexPath: null };
  }

  let updated = setMetadataFields(raw, {
    Status: 'completed',
    'Done-Evidence': indexResult.indexPath
  });
  updated = upsertSection(updated, 'Evidence Index', [
    `- Canonical Index: \`${indexResult.indexPath}\``,
    `- Included References: ${indexResult.referenceCount}`,
    `- Total References Found: ${indexResult.totalFound}`
  ]);
  updated = removeDuplicateSections(updated, 'Evidence Index');
  updated = normalizeBulletSection(updated, 'Evidence Index');
  updated = removeDuplicateSections(updated, 'Closure');
  updated = normalizeClosureSection(updated);
  updated = normalizeBulletSection(updated, 'Closure');

  const changed = updated !== raw;
  if (changed && !options.dryRun) {
    await fs.writeFile(plan.filePath, updated, 'utf8');
  }

  return {
    updated: changed,
    indexPath: indexResult.indexPath
  };
}

async function canonicalizeCompletedPlansEvidence(paths, options, config, planIdFilter = null) {
  const completedPlans = await loadPlanRecords(paths.rootDir, paths.completedDir, 'completed');
  let visited = 0;
  let updated = 0;
  let indexed = 0;

  for (const plan of completedPlans) {
    if (!matchesPlanIdFilter(plan, planIdFilter)) {
      continue;
    }
    visited += 1;
    const result = await canonicalizeCompletedPlanEvidence(plan, paths, options, config);
    if (result.updated) {
      updated += 1;
    }
    if (result.indexPath) {
      indexed += 1;
    }
  }

  return {
    plansVisited: visited,
    plansUpdated: updated,
    plansIndexed: indexed
  };
}

async function setHostValidationSection(planPath, status, provider, reason, dryRun) {
  if (dryRun) {
    return;
  }

  const content = await fs.readFile(planPath, 'utf8');
  const lines = [
    `- Status: ${status}`,
    `- Updated At: ${nowIso()}`,
    `- Provider: ${provider || 'n/a'}`,
    `- Reason: ${reason || 'none'}`
  ];
  let updated = upsertSection(content, 'Host Validation', lines);
  if (normalizeStatus(status) === 'passed') {
    updated = removeSection(updated, 'Remaining Validation Work (Host Required)');
  }
  await fs.writeFile(planPath, updated, 'utf8');
}

function gitAvailable(rootDir) {
  const result = runShellCapture('git rev-parse --is-inside-work-tree', rootDir);
  return result.status === 0;
}

function parseGitPorcelainZPaths(stdout) {
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
    const primaryPath = toPosix(token.slice(3));
    if (primaryPath) {
      paths.push(primaryPath);
    }
    const isRenameOrCopy = status.includes('R') || status.includes('C');
    if (isRenameOrCopy && index + 1 < tokens.length) {
      const secondaryPath = toPosix(tokens[index + 1]);
      if (secondaryPath) {
        paths.push(secondaryPath);
      }
      index += 1;
    }
  }

  return paths;
}

function isTransientAutomationPath(pathValue) {
  if (TRANSIENT_AUTOMATION_FILES.has(pathValue)) {
    return true;
  }
  return TRANSIENT_AUTOMATION_DIR_PREFIXES.some((prefix) => pathValue.startsWith(prefix));
}

function pathMatchesRootPrefix(filePath, rootPrefix) {
  const normalizedFile = toPosix(String(filePath ?? '').trim()).replace(/^\.?\//, '');
  const normalizedRoot = toPosix(String(rootPrefix ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!normalizedFile || !normalizedRoot) {
    return false;
  }
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

function resolveAtomicCommitRoots(plan, config, paths, completionContext = {}) {
  const policy = config?.git?.atomicCommitRoots ?? {};
  const includePlanMetadata = asBoolean(policy.allowPlanMetadata, true);
  const defaults = normalizeRelativePrefixList(policy.defaults);
  const shared = normalizeRelativePrefixList(policy.shared);
  const roots = new Set([...defaults, ...shared]);

  if (includePlanMetadata) {
    for (const root of normalizeRelativePrefixList(plan.atomicRoots ?? [])) {
      roots.add(root);
    }
  }

  if (plan.rel) {
    const planRel = assertSafeRelativePlanPath(plan.rel);
    roots.add(planRel);
  }

  const planSpecTargets =
    Array.isArray(plan.specTargets) && plan.specTargets.length > 0
      ? plan.specTargets
      : ['docs/product-specs/current-state.md'];
  for (const target of normalizeRelativePrefixList(planSpecTargets)) {
    roots.add(target);
  }

  const completedRelCandidate = completionContext.completedRel
    ? assertSafeRelativePlanPath(completionContext.completedRel)
    : null;
  if (completedRelCandidate) {
    roots.add(completedRelCandidate);
  }

  const evidenceIndexRel = assertSafeRelativePlanPath(
    toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, `${plan.planId}.md`)))
  );
  roots.add(evidenceIndexRel);
  roots.add(assertSafeRelativePlanPath(toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, 'README.md')))));

  // Plan-scoped evidence artifacts are updated by curation and should be included in atomic roots.
  const activeEvidenceFile = `docs/exec-plans/active/evidence/${plan.planId}.md`;
  roots.add(assertSafeRelativePlanPath(activeEvidenceFile));
  roots.add(assertSafeRelativePlanPath('docs/exec-plans/active/evidence/README.md'));

  // Runtime context compilation may run during continuation sessions and mutate this generated file.
  const runtimeContextPath = normalizedRelativePrefix(
    config?.context?.runtimeContextPath ?? 'docs/generated/agent-runtime-context.md'
  );
  if (runtimeContextPath) {
    roots.add(assertSafeRelativePlanPath(runtimeContextPath));
  }

  return [...roots]
    .map((entry) => normalizedRelativePrefix(entry))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function dirtyRepoPaths(rootDir, options = {}) {
  const includeTransient = asBoolean(options.includeTransient, false);
  const result = runShellCapture('git status --porcelain=v1 -z', rootDir);
  if (result.status !== 0) {
    return [];
  }
  const paths = parseGitPorcelainZPaths(result.stdout);
  if (includeTransient) {
    return paths;
  }
  return paths.filter((entry) => !isTransientAutomationPath(entry));
}

function stagedRepoPaths(rootDir, options = {}) {
  const includeTransient = asBoolean(options.includeTransient, false);
  const result = runShellCapture('git diff --cached --name-only -z', rootDir);
  if (result.status !== 0) {
    return [];
  }
  const paths = String(result.stdout ?? '')
    .split('\0')
    .map((entry) => toPosix(String(entry ?? '').trim()))
    .filter(Boolean);
  if (includeTransient) {
    return paths;
  }
  return paths.filter((entry) => !isTransientAutomationPath(entry));
}

function gitDirty(rootDir, options = {}) {
  const ignoreTransientAutomationArtifacts = asBoolean(options.ignoreTransientAutomationArtifacts, false);
  const result = runShellCapture('git status --porcelain=v1 -z', rootDir);
  if (result.status !== 0) {
    return false;
  }
  const dirtyPaths = parseGitPorcelainZPaths(result.stdout);
  if (!ignoreTransientAutomationArtifacts) {
    return dirtyPaths.length > 0;
  }
  return dirtyPaths.some((pathValue) => !isTransientAutomationPath(pathValue));
}

function evaluateAtomicCommitReadiness(rootDir, planId, allowDirty, commitPolicy = {}, options = {}) {
  const requireDirty = asBoolean(options.requireDirty, true);
  if (allowDirty) {
    return {
      ok: false,
      committed: false,
      commitHash: null,
      reason: 'Refusing atomic commit with --allow-dirty true. Re-run with --allow-dirty false or --commit false.'
    };
  }

  if (!gitAvailable(rootDir)) {
    return { ok: true, committed: false, commitHash: null, reason: 'git-unavailable' };
  }

  const hasDirtyChanges = gitDirty(rootDir, { ignoreTransientAutomationArtifacts: true });
  if (requireDirty && !hasDirtyChanges) {
    return { ok: true, committed: false, commitHash: null, reason: 'no-changes' };
  }

  const enforceRoots = asBoolean(commitPolicy.enforceRoots, true);
  const allowedRoots = normalizeRelativePrefixList(commitPolicy.allowedRoots);
  if (enforceRoots && allowedRoots.length > 0) {
    const dirtyPaths = dirtyRepoPaths(rootDir);
    const outsideRoots = dirtyPaths.filter((entry) => !allowedRoots.some((root) => pathMatchesRootPrefix(entry, root)));
    if (outsideRoots.length > 0) {
      return {
        ok: false,
        committed: false,
        commitHash: null,
        reason: `Atomic root policy violation for ${planId}. Paths outside allowed roots: ${outsideRoots.join(', ')}`
      };
    }
  }

  const preStagedPaths = stagedRepoPaths(rootDir, { includeTransient: true });
  const stagedTransient = preStagedPaths.filter((entry) => isTransientAutomationPath(entry));
  if (stagedTransient.length > 0) {
    return {
      ok: false,
      committed: false,
      commitHash: null,
      reason: `Atomic commit refused because transient runtime files are already staged: ${stagedTransient.join(', ')}`
    };
  }
  if (enforceRoots && allowedRoots.length > 0) {
    const stagedOutsideRoots = preStagedPaths.filter(
      (entry) => !allowedRoots.some((root) => pathMatchesRootPrefix(entry, root))
    );
    if (stagedOutsideRoots.length > 0) {
      return {
        ok: false,
        committed: false,
        commitHash: null,
        reason: `Atomic root policy violation for ${planId}. Staged paths outside allowed roots: ${stagedOutsideRoots.join(', ')}`
      };
    }
  }

  return { ok: true, committed: false, commitHash: null, reason: null };
}

function createAtomicCommit(rootDir, planId, dryRun, allowDirty, commitPolicy = {}) {
  if (dryRun) {
    return { ok: true, committed: false, commitHash: null, reason: 'dry-run' };
  }

  const preflight = evaluateAtomicCommitReadiness(rootDir, planId, allowDirty, commitPolicy, { requireDirty: true });
  if (!preflight.ok || preflight.reason === 'git-unavailable' || preflight.reason === 'no-changes') {
    return preflight;
  }

  const allowedRoots = normalizeRelativePrefixList(commitPolicy.allowedRoots);
  const addTargets = allowedRoots.length > 0 ? allowedRoots.map((entry) => shellQuote(entry)).join(' ') : '.';
  const add = runShellCapture(`git add --all -- ${addTargets}`, rootDir);
  if (add.status !== 0) {
    return { ok: false, committed: false, commitHash: null, reason: 'git add failed' };
  }

  const commitMessage = `exec-plan(${planId}): complete`;
  const commit = runShellCapture(`git commit -m ${JSON.stringify(commitMessage)}`, rootDir);
  if (commit.status !== 0) {
    return { ok: false, committed: false, commitHash: null, reason: 'git commit failed' };
  }

  const hash = runShellCapture('git rev-parse HEAD', rootDir);
  const commitHash = hash.status === 0 ? String(hash.stdout ?? '').trim() : null;
  return { ok: true, committed: true, commitHash, reason: null };
}

async function resolveCompletedPlanTargetPath(planFilePath, completedDir) {
  const completedDate = isoDate(nowIso());
  const currentBase = path.parse(path.basename(planFilePath));
  const completedName = datedPlanFileName(completedDate, currentBase.name, currentBase.ext || '.md');
  let targetPath = path.join(completedDir, completedName);
  if (await exists(targetPath)) {
    const parsed = path.parse(completedName);
    targetPath = path.join(completedDir, `${parsed.name}-${Date.now()}${parsed.ext || '.md'}`);
  }
  return targetPath;
}

async function finalizeCompletedPlan(plan, paths, state, validationEvidence, options, config, completionInfo = {}) {
  const now = nowIso();
  const targetPath = completionInfo.targetPath
    ? path.resolve(completionInfo.targetPath)
    : await resolveCompletedPlanTargetPath(plan.filePath, paths.completedDir);
  const completedRel = toPosix(path.relative(paths.rootDir, targetPath));
  const raw = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, raw, options, config, { sourcePlanRel: completedRel });
  const doneEvidenceValue = indexResult?.indexPath ?? (validationEvidence.length > 0 ? validationEvidence.join(', ') : 'none');
  const updatedMetadata = setMetadataFields(raw, {
    Status: 'completed',
    'Done-Evidence': doneEvidenceValue
  });

  const validationLines = validationEvidence.length > 0
    ? validationEvidence.map((line) => `- ${line}`)
    : ['- No validation commands configured.'];

  const closureLines = [
    `- Completed At: ${now}`,
    `- Run-ID: ${state.runId}`,
    `- Mode: ${state.effectiveMode}`,
    '- Commit: recorded in run events after atomic commit.',
    `- Termination Reason: completed`
  ];
  const planDurationSeconds = durationSeconds(completionInfo.planStartedAt, now);
  const runDurationSeconds = durationSeconds(state.startedAt, now);
  const snapshotLines = [
    `- Plan-ID: ${plan.planId}`,
    `- Sessions Executed: ${completionInfo.sessionsExecuted ?? 'unknown'}`,
    `- Rollovers: ${completionInfo.rollovers ?? 0}`,
    `- Host Validation Provider: ${completionInfo.hostValidationProvider ?? 'none'}`,
    `- Risk Tier (Declared): ${completionInfo.declaredRiskTier ?? plan.riskTier ?? 'low'}`,
    `- Risk Tier (Effective): ${completionInfo.effectiveRiskTier ?? plan.riskTier ?? 'low'}`,
    `- Role Pipeline: ${completionInfo.rolePipeline ?? ROLE_WORKER}`,
    `- Plan Duration: ${formatDuration(planDurationSeconds)} (${planDurationSeconds ?? 'unknown'}s)`,
    `- Run Duration At Completion: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`
  ];

  let finalContent = upsertSection(updatedMetadata, 'Validation Evidence', validationLines);
  finalContent = upsertSection(finalContent, 'Completion Snapshot', snapshotLines);
  if (indexResult?.indexPath) {
    finalContent = upsertSection(finalContent, 'Evidence Index', [
      `- Canonical Index: \`${indexResult.indexPath}\``,
      `- Included References: ${indexResult.referenceCount}`,
      `- Total References Found: ${indexResult.totalFound}`
    ]);
  }
  finalContent = upsertSection(finalContent, 'Closure', closureLines);

  if (!options.dryRun) {
    await fs.writeFile(targetPath, finalContent, 'utf8');
    await fs.unlink(plan.filePath);
  }

  return targetPath;
}

async function updateProductSpecs(plan, completedPath, paths, state, options) {
  const targets = plan.specTargets.length > 0 ? plan.specTargets : ['docs/product-specs/current-state.md'];
  const dateStamp = todayIsoDate();
  const relativeCompleted = toPosix(path.relative(paths.rootDir, completedPath));

  for (const target of targets) {
    let targetPath;
    let targetRel;
    try {
      const resolved = resolveSafeRepoPath(paths.rootDir, target, `Spec target for plan '${plan.planId}'`);
      targetPath = resolved.abs;
      targetRel = resolved.rel;
    } catch (error) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target,
        reason: error instanceof Error ? error.message : String(error)
      }, options.dryRun);
      continue;
    }

    if (!(await exists(targetPath))) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target: targetRel,
        reason: 'Spec target does not exist'
      }, options.dryRun);
      continue;
    }

    if (options.dryRun) {
      continue;
    }

    let content = await fs.readFile(targetPath, 'utf8');
    const entry = `${dateStamp}: completed \`${plan.planId}\` via \`${relativeCompleted}\``;
    content = appendToDeliveryLog(content, entry);

    if (targetRel === 'docs/product-specs/current-state.md') {
      content = updateSimpleMetadataField(content, 'Last Updated', dateStamp);
      content = updateSimpleMetadataField(content, 'Current State Date', dateStamp);
    }

    await fs.writeFile(targetPath, content, 'utf8');
  }
}

async function writeHandoff(paths, state, plan, sessionNumber, reason, summary, options, sessionContext = {}) {
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const stageIndex = asInteger(sessionContext.stageIndex, 1);
  const stageTotal = asInteger(sessionContext.stageTotal, 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${stamp}-session-${sessionNumber}.md`;
  const targetPath = path.join(paths.handoffDir, plan.planId, fileName);

  if (options.dryRun) {
    return targetPath;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const content = [
    `# Handoff ${plan.planId}`,
    '',
    '## Metadata',
    '',
    `- Plan-ID: ${plan.planId}`,
    `- Run-ID: ${state.runId}`,
    `- Session: ${sessionNumber}`,
    `- Role: ${role}`,
    `- Stage: ${stageIndex}/${stageTotal}`,
    `- Mode: ${state.effectiveMode}`,
    `- Created At: ${nowIso()}`,
    `- Reason: ${reason || 'unspecified'}`,
    '',
    '## Summary',
    '',
    summary || 'Executor requested rollover without additional summary.',
    '',
    '## Next Session Checklist',
    '',
    '- Load latest handoff and active plan file.',
    '- Continue current role stage before advancing pipeline.',
    '- Continue remaining acceptance criteria steps.',
    '- Re-run required validations before completion.',
    ''
  ].join('\n');

  await fs.writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function announceStageReuse(paths, state, plan, roleState, options) {
  if (!Array.isArray(roleState?.reusedPrefixStages) || roleState.reusedPrefixStages.length === 0) {
    return;
  }
  if (roleState.reuseAnnouncedAtRunId === state.runId) {
    return;
  }
  roleState.reuseAnnouncedAtRunId = state.runId;
  state.roleState[plan.planId] = roleState;
  await logEvent(paths, state, 'role_stage_reused', {
    planId: plan.planId,
    reusedStages: roleState.reusedPrefixStages,
    nextRole: roleState.stages[Math.min(roleState.currentIndex, roleState.stages.length - 1)] ?? ROLE_WORKER
  }, options.dryRun);
  progressLog(options, `role stage reuse ${plan.planId}: skipped ${roleState.reusedPrefixStages.join(' -> ')}`);
}

async function processPlan(plan, paths, state, options, config) {
  let lastAssessment = computeRiskAssessment(plan, state, config);
  const gate = evaluatePolicyGate(
    {
      ...plan,
      riskTier: lastAssessment.effectiveRiskTier
    },
    state.effectiveMode
  );
  if (!gate.allowed) {
    await setPlanStatus(plan.filePath, 'blocked', options.dryRun);

    return {
      outcome: 'blocked',
      reason: gate.reason
    };
  }

  await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);

  const maxRollovers = asInteger(options.maxRollovers, DEFAULT_MAX_ROLLOVERS);
  const maxSessionsPerPlan = asInteger(options.maxSessionsPerPlan, DEFAULT_MAX_SESSIONS_PER_PLAN);
  const roleConfig = resolveRoleOrchestration(config);
  const planStartedAt = nowIso();
  const planStartedAtMs = Date.now();
  let firstWorkerEditSeconds = null;
  let rollovers = 0;
  let lastPendingSignal = null;
  let workerNoTouchRetryCount = 0;
  let roleState = ensureRoleState(state, plan, lastAssessment, resolvePipelineStages(lastAssessment, config), config);
  await announceStageReuse(paths, state, plan, roleState, options);

  for (let session = 1; session <= maxSessionsPerPlan; session += 1) {
    lastAssessment = computeRiskAssessment(plan, state, config);
    const dynamicGate = evaluatePolicyGate(
      {
        ...plan,
        riskTier: lastAssessment.effectiveRiskTier
      },
      state.effectiveMode
    );
    if (!dynamicGate.allowed) {
      await setPlanStatus(plan.filePath, 'blocked', options.dryRun);
      return {
        outcome: 'blocked',
        reason: dynamicGate.reason,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }
    roleState = ensureRoleState(state, plan, lastAssessment, resolvePipelineStages(lastAssessment, config), config);
    await announceStageReuse(paths, state, plan, roleState, options);
    const stageTotal = roleState.stages.length;
    const roleIndex = Math.min(roleState.currentIndex, Math.max(0, stageTotal - 1));
    const stageIndex = roleIndex + 1;
    const currentRole = normalizeRoleName(roleState.stages[roleIndex], ROLE_WORKER);
    const currentRoleProfile = resolveRoleExecutionProfile(config, currentRole);

    state.inProgress = {
      planId: plan.planId,
      session,
      planFile: plan.rel,
      role: currentRole,
      stageIndex,
      stageTotal,
      declaredRiskTier: lastAssessment.declaredRiskTier,
      computedRiskTier: lastAssessment.computedRiskTier,
      effectiveRiskTier: lastAssessment.effectiveRiskTier,
      startedAt: nowIso()
    };

    await saveState(paths, state, options.dryRun);
    progressLog(
      options,
      `session ${session} start ${plan.planId} role=${currentRole} stage=${stageIndex}/${stageTotal} provider=${currentRoleProfile.provider} model=${currentRoleProfile.model || 'n/a'} risk=${lastAssessment.effectiveRiskTier}`
    );

    const sessionResult = await executePlanSession(plan, paths, state, options, config, session, {
      role: currentRole,
      effectiveRiskTier: lastAssessment.effectiveRiskTier,
      declaredRiskTier: lastAssessment.declaredRiskTier,
      stageIndex,
      stageTotal,
      workerNoTouchRetryCount: currentRole === ROLE_WORKER ? workerNoTouchRetryCount : 0,
      workerNoTouchRetryLimit: asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)
    });
    await logEvent(paths, state, 'session_finished', {
      planId: plan.planId,
      session,
      role: currentRole,
      stageIndex,
      stageTotal,
      declaredRiskTier: lastAssessment.declaredRiskTier,
      computedRiskTier: lastAssessment.computedRiskTier,
      effectiveRiskTier: lastAssessment.effectiveRiskTier,
      riskScore: lastAssessment.score,
      status: sessionResult.status,
      reason: sessionResult.reason ?? null,
      summary: sessionResult.summary ?? null,
      provider: sessionResult.provider ?? currentRoleProfile.provider,
      model: sessionResult.model ?? currentRoleProfile.model ?? null,
      commandLogPath: sessionResult.sessionLogPath ?? null,
      contactPackFile: sessionResult.contactPackFile ?? null,
      durationSeconds:
        typeof sessionResult.durationSeconds === 'number' && Number.isFinite(sessionResult.durationSeconds)
          ? Math.round(sessionResult.durationSeconds * 100) / 100
          : null,
      touchCount: sessionResult.touchSummary?.count ?? 0,
      touchCategories: sessionResult.touchSummary?.categories ?? [],
      touchSamples: sessionResult.touchSummary?.samples ?? []
    }, options.dryRun);
    const workerTouchCount =
      typeof sessionResult.touchSummary?.count === 'number' && Number.isFinite(sessionResult.touchSummary.count)
        ? sessionResult.touchSummary.count
        : 0;
    if (currentRole === ROLE_WORKER && workerTouchCount > 0 && firstWorkerEditSeconds == null) {
      firstWorkerEditSeconds = Math.max(0, (Date.now() - planStartedAtMs) / 1000);
      await logEvent(paths, state, 'worker_first_edit', {
        planId: plan.planId,
        session,
        role: currentRole,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        secondsFromPlanStart: Math.round(firstWorkerEditSeconds * 100) / 100,
        touchCount: workerTouchCount
      }, options.dryRun);
    }
    const contextSuffix =
      typeof sessionResult.contextRemaining === 'number' && Number.isFinite(sessionResult.contextRemaining)
        ? ` contextRemaining=${sessionResult.contextRemaining}`
        : '';
    progressLog(
      options,
      `session ${session} end ${plan.planId} role=${currentRole} status=${sessionResult.status}${contextSuffix}`
    );
    if (sessionResult.sessionLogPath && (sessionResult.status === 'failed' || sessionResult.status === 'handoff_required')) {
      progressLog(options, `session log: ${sessionResult.sessionLogPath}`);
    }
    if (sessionResult.failureTail && !isTickerOutput(options)) {
      progressLog(options, `session failure tail:\n${sessionResult.failureTail}`);
    }
    await refreshEvidenceIndex(plan, paths, state, options, config);
    const sessionCuration = await curateEvidenceForPlan(plan, paths, options, config);
    if (sessionCuration.filesPruned > 0 || sessionCuration.filesUpdated > 0) {
      await logEvent(paths, state, 'evidence_curated', {
        planId: plan.planId,
        stage: 'session',
        session,
        directoriesVisited: sessionCuration.directoriesVisited,
        filesPruned: sessionCuration.filesPruned,
        filesKept: sessionCuration.filesKept,
        filesUpdated: sessionCuration.filesUpdated,
        replacementsApplied: sessionCuration.replacementsApplied
      }, options.dryRun);
      await refreshEvidenceIndex(plan, paths, state, options, config);
    }

    if (sessionResult.status === 'handoff_required') {
      const handoffPath = await writeHandoff(
        paths,
        state,
        plan,
        session,
        sessionResult.reason,
        sessionResult.summary,
        options,
        { role: currentRole, stageIndex, stageTotal }
      );
      state.stats.handoffs += 1;
      await logEvent(paths, state, 'handoff_created', {
        planId: plan.planId,
        session,
        role: currentRole,
        stageIndex,
        stageTotal,
        handoffPath: toPosix(path.relative(paths.rootDir, handoffPath)),
        reason: sessionResult.reason ?? 'executor-requested'
      }, options.dryRun);
      progressLog(options, `handoff created for ${plan.planId}: ${toPosix(path.relative(paths.rootDir, handoffPath))}`);

      rollovers += 1;
      if (rollovers > maxRollovers) {
        await setPlanStatus(plan.filePath, 'failed', options.dryRun);
        return {
          outcome: 'failed',
          reason: `Maximum rollovers exceeded (${maxRollovers})`
        };
      }

      continue;
    }

    if (sessionResult.status === 'blocked') {
      await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);
      await logEvent(paths, state, 'session_blocked_deferred', {
        planId: plan.planId,
        session,
        role: currentRole,
        stageIndex,
        stageTotal,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        reason: sessionResult.reason ?? 'executor blocked'
      }, options.dryRun);
      progressLog(options, `session blocked for ${plan.planId}: ${sessionResult.reason ?? 'executor blocked'}`);
      return {
        outcome: 'pending',
        reason: sessionResult.reason ?? 'executor blocked',
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (sessionResult.status === 'failed') {
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      progressLog(options, `session failed for ${plan.planId}: ${sessionResult.reason ?? 'executor failed'}`);
      return {
        outcome: 'failed',
        reason: sessionResult.reason ?? 'executor failed',
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (!(await exists(plan.filePath))) {
      const relocatedPlan = await findPlanRecordById(paths, plan.planId);
      if (relocatedPlan?.phase === 'completed') {
        const completionGateForRelocatedPlan = await evaluateCompletionGate(relocatedPlan.filePath);
        if (!completionGateForRelocatedPlan.ready) {
          return {
            outcome: 'failed',
            reason: `Plan was moved to completed without completion status. ${completionGateForRelocatedPlan.reason}`
          };
        }

        await canonicalizeCompletedPlanEvidence(relocatedPlan, paths, options, config);
        await updateProductSpecs(plan, relocatedPlan.filePath, paths, state, options);

        let commitResult = { ok: true, committed: false, commitHash: null };
        if (asBoolean(options.commit, config.git.atomicCommits !== false)) {
          commitResult = createAtomicCommit(
            paths.rootDir,
            plan.planId,
            options.dryRun,
            options.allowDirty,
            {
              enforceRoots: asBoolean(config.git?.atomicCommitRoots?.enforce, true),
              allowedRoots: resolveAtomicCommitRoots(plan, config, paths, { completedRel: relocatedPlan.rel })
            }
          );
          if (!commitResult.ok) {
            return {
              outcome: 'failed',
              reason: commitResult.reason ?? 'atomic commit failed'
            };
          }
          if (commitResult.committed) {
            state.stats.commits += 1;
          }
        }

        return {
          outcome: 'completed',
          reason: 'completed',
          completedPath: relocatedPlan.rel,
          commitHash: commitResult.commitHash,
          validationEvidence: [],
          riskTier: lastAssessment.effectiveRiskTier
        };
      }

      if (relocatedPlan) {
        syncPlanRecord(plan, relocatedPlan);
      }
    }

    if (!(await exists(plan.filePath))) {
      return {
        outcome: 'failed',
        reason: `Plan file is missing after executor session: ${plan.rel}`,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    const refreshedPlan = await readPlanRecord(paths.rootDir, plan.filePath, 'active');
    syncPlanRecord(plan, refreshedPlan);
    const disallowedWrites = disallowedTouchedPathsForRole(currentRole, sessionResult.touchSummary?.touched ?? []);
    if (disallowedWrites.length > 0) {
      const violationSample = disallowedWrites.slice(0, 3).join(', ');
      const violationReason =
        `Role '${currentRole}' touched files outside docs/exec-plans. ` +
        `Allowed scope is execution plan/evidence docs only. Sample: ${violationSample}`;
      await logEvent(paths, state, 'session_policy_violation', {
        planId: plan.planId,
        session,
        role: currentRole,
        stageIndex,
        stageTotal,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        disallowedTouchedCount: disallowedWrites.length,
        disallowedTouchedSample: disallowedWrites.slice(0, 10),
        reason: violationReason
      }, options.dryRun);
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      progressLog(options, `session policy violation ${plan.planId}: ${violationReason}`);
      return {
        outcome: 'failed',
        reason: violationReason,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (sessionResult.status === 'pending') {
      const pendingReason = sessionResult.reason ?? 'Executor reported pending implementation work.';
      const nextRole = resolvePendingNextRole(currentRole, roleState, roleIndex, pendingReason);
      const pendingTouchCount =
        typeof sessionResult.touchSummary?.count === 'number' && Number.isFinite(sessionResult.touchSummary.count)
          ? sessionResult.touchSummary.count
          : 0;
      const stageBudgetSeconds = Math.max(
        0,
        asInteger(roleConfig.stageBudgetsSeconds?.[currentRole], 0)
      );
      const sessionDurationSeconds =
        typeof sessionResult.durationSeconds === 'number' && Number.isFinite(sessionResult.durationSeconds)
          ? sessionResult.durationSeconds
          : 0;
      if (
        currentRole !== ROLE_WORKER &&
        nextRole === currentRole &&
        stageBudgetSeconds > 0 &&
        pendingTouchCount <= 0 &&
        sessionDurationSeconds > stageBudgetSeconds
      ) {
        const budgetReason =
          `Role '${currentRole}' exceeded stage budget (${Math.round(sessionDurationSeconds)}s > ${stageBudgetSeconds}s) ` +
          `without meaningful progress. ${pendingReason}`;
        await logEvent(paths, state, 'session_stage_budget_exceeded', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          durationSeconds: Math.round(sessionDurationSeconds * 100) / 100,
          stageBudgetSeconds,
          touchCount: pendingTouchCount,
          reason: budgetReason
        }, options.dryRun);
        progressLog(options, `session stage-budget fail-fast ${plan.planId}: ${budgetReason}`);
        return {
          outcome: 'pending',
          reason: budgetReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      const workerNoTouchRetryLimit = Math.max(
        0,
        asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)
      );
      if (
        currentRole === ROLE_WORKER &&
        nextRole === currentRole &&
        pendingTouchCount <= 0 &&
        workerNoTouchRetryCount < workerNoTouchRetryLimit &&
        session < maxSessionsPerPlan
      ) {
        workerNoTouchRetryCount += 1;
        const retryReason =
          `Worker returned pending without touching files; retrying worker with edit-first directive ` +
          `(${workerNoTouchRetryCount}/${workerNoTouchRetryLimit}). ${pendingReason}`;
        await logEvent(paths, state, 'session_pending_no_touch_retry', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          touchCount: pendingTouchCount,
          retryAttempt: workerNoTouchRetryCount,
          retryLimit: workerNoTouchRetryLimit,
          reason: retryReason
        }, options.dryRun);
        progressLog(options, `session retry ${plan.planId}: ${retryReason}`);
        lastPendingSignal = null;
        continue;
      }
      if (currentRole === ROLE_WORKER && nextRole === currentRole && pendingTouchCount <= 0) {
        const retrySummary =
          workerNoTouchRetryLimit > 0
            ? `after ${workerNoTouchRetryCount}/${workerNoTouchRetryLimit} no-touch retries`
            : 'with no-touch retries disabled';
        const failFastReason =
          `Worker returned pending without touching files ${retrySummary}. ${pendingReason} ` +
          'Apply at least one concrete repository edit before returning pending.';
        await logEvent(paths, state, 'session_pending_fail_fast', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          touchCount: pendingTouchCount,
          reason: failFastReason
        }, options.dryRun);
        progressLog(options, `session fail-fast ${plan.planId}: ${failFastReason}`);
        return {
          outcome: 'pending',
          reason: failFastReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      if (currentRole === ROLE_WORKER && pendingTouchCount > 0) {
        workerNoTouchRetryCount = 0;
      } else if (currentRole !== ROLE_WORKER) {
        workerNoTouchRetryCount = 0;
      }
      const signal = pendingSignalSignature(currentRole, nextRole, pendingReason);
      if (nextRole === currentRole && signal === lastPendingSignal) {
        const failFastReason = `Repeated pending signal without progress for role '${currentRole}'. ${pendingReason}`;
        await logEvent(paths, state, 'session_pending_fail_fast', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          reason: failFastReason
        }, options.dryRun);
        progressLog(options, `session fail-fast ${plan.planId}: ${failFastReason}`);
        return {
          outcome: 'pending',
          reason: failFastReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      lastPendingSignal = nextRole === currentRole ? signal : null;
      setRoleStateToRole(roleState, nextRole);
      state.roleState[plan.planId] = roleState;
      await saveState(paths, state, options.dryRun);
      if (session >= maxSessionsPerPlan) {
        return {
          outcome: 'pending',
          reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}). ${pendingReason}`,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      await logEvent(paths, state, 'session_continued', {
        planId: plan.planId,
        session,
        role: currentRole,
        nextRole,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        nextSession: session + 1,
        reason: pendingReason
      }, options.dryRun);
      progressLog(
        options,
        `session pending ${plan.planId}: nextRole=${nextRole} reason=${pendingReason}`
      );
      continue;
    }

    lastPendingSignal = null;
    workerNoTouchRetryCount = 0;

    advanceRoleState(roleState, currentRole);
    state.roleState[plan.planId] = roleState;
    await saveState(paths, state, options.dryRun);

    if (roleIndex < roleState.stages.length - 1) {
      const nextRole = roleState.stages[Math.min(roleIndex + 1, roleState.stages.length - 1)];
      await logEvent(paths, state, 'role_stage_advanced', {
        planId: plan.planId,
        session,
        completedRole: currentRole,
        nextRole,
        stageIndexCompleted: stageIndex,
        stageTotal,
        effectiveRiskTier: lastAssessment.effectiveRiskTier
      }, options.dryRun);
      progressLog(options, `role transition ${plan.planId}: ${currentRole} -> ${nextRole}`);
      continue;
    }

    const completionGate = await evaluateCompletionGate(plan.filePath);
    if (!completionGate.ready) {
      await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);
      updatePlanValidationState(state, plan.planId, {
        always: 'pending',
        host: 'pending',
        provider: null,
        reason: completionGate.reason
      });

      if (sessionResult.resultPayloadFound === false) {
        return {
          outcome: 'pending',
          reason: 'Executor produced no structured result payload. Deferring to next run to prevent repeated no-signal loops.',
          riskTier: lastAssessment.effectiveRiskTier
        };
      }

      if (session >= maxSessionsPerPlan) {
        return {
          outcome: 'pending',
          reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}). ${completionGate.reason}`,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }

      resetRoleStateToImplementation(roleState);
      state.roleState[plan.planId] = roleState;

      await logEvent(paths, state, 'session_continued', {
        planId: plan.planId,
        session,
        role: currentRole,
        nextRole: roleState.stages[roleState.currentIndex],
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        nextSession: session + 1,
        reason: completionGate.reason
      }, options.dryRun);
      progressLog(
        options,
        `session continuation ${plan.planId}: nextRole=${roleState.stages[roleState.currentIndex]} reason=${completionGate.reason}`
      );

      continue;
    }

    const approvalRequired = requiresSecurityApproval(plan, lastAssessment, config);
    const securityApprovalField =
      resolveRoleOrchestration(config).approvalGates.securityApprovalMetadataField || 'Security-Approval';
    const securityApprovalValue = parseSecurityApproval(
      metadataValue(plan.metadata, securityApprovalField),
      plan.securityApproval
    );
    plan.securityApproval = securityApprovalValue;

    if (approvalRequired && securityApprovalValue !== SECURITY_APPROVAL_APPROVED) {
      await setPlanStatus(plan.filePath, 'blocked', options.dryRun);
      if (!options.dryRun && securityApprovalValue === SECURITY_APPROVAL_NOT_REQUIRED) {
        const rawPlan = await fs.readFile(plan.filePath, 'utf8');
        const updatedPlan = setMetadataFields(rawPlan, {
          [securityApprovalField]: SECURITY_APPROVAL_PENDING
        });
        await fs.writeFile(plan.filePath, updatedPlan, 'utf8');
      }
      const reason = `Security approval required: set '${securityApprovalField}' to '${SECURITY_APPROVAL_APPROVED}' for ${lastAssessment.effectiveRiskTier}-risk completion.`;
      await logEvent(paths, state, 'security_approval_pending', {
        planId: plan.planId,
        riskTier: lastAssessment.effectiveRiskTier,
        securityApprovalField,
        securityApproval: securityApprovalValue,
        sensitive: lastAssessment.sensitive,
        reason
      }, options.dryRun);
      progressLog(options, `security approval pending for ${plan.planId}: ${reason}`);
      return {
        outcome: 'blocked',
        reason,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    await setPlanStatus(plan.filePath, 'validation', options.dryRun);
    progressLog(options, `validation start ${plan.planId} lane=always`);
    const alwaysValidation = await runAlwaysValidation(paths, options, config, state, plan);
    if (!alwaysValidation.ok) {
      state.stats.validationFailures += 1;
      updatePlanValidationState(state, plan.planId, {
        always: 'failed',
        reason: alwaysValidation.reason ?? `Validation failed: ${alwaysValidation.failedCommand}`
      });
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      await logEvent(paths, state, 'validation_failed', {
        planId: plan.planId,
        command: alwaysValidation.failedCommand,
        reason: alwaysValidation.reason ?? null,
        outputLogPath: alwaysValidation.outputLogPath ?? null
      }, options.dryRun);
      progressLog(options, `validation failed ${plan.planId}: ${alwaysValidation.reason ?? alwaysValidation.failedCommand}`);
      if (alwaysValidation.outputLogPath) {
        progressLog(options, `validation log: ${alwaysValidation.outputLogPath}`);
      }
      if (alwaysValidation.failureTail && !isTickerOutput(options)) {
        progressLog(options, `validation failure tail:\n${alwaysValidation.failureTail}`);
      }

      return {
        outcome: 'failed',
        reason: alwaysValidation.reason ?? `Validation failed: ${alwaysValidation.failedCommand}`,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    updatePlanValidationState(state, plan.planId, {
      always: 'passed',
      reason: null
    });
    progressLog(options, `validation passed ${plan.planId} lane=always`);

    await logEvent(paths, state, 'host_validation_requested', {
      planId: plan.planId,
      mode: resolveHostValidationMode(config),
      commands: resolveHostRequiredValidationCommands(config)
    }, options.dryRun);
    progressLog(options, `validation start ${plan.planId} lane=host mode=${resolveHostValidationMode(config)}`);

    const hostValidation = await runHostValidation(paths, state, plan, options, config);
    if (hostValidation.status === 'failed') {
      state.stats.validationFailures += 1;
      updatePlanValidationState(state, plan.planId, {
        host: 'failed',
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation failed.'
      });
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      await logEvent(paths, state, 'host_validation_failed', {
        planId: plan.planId,
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation failed.',
        outputLogPath: hostValidation.outputLogPath ?? null
      }, options.dryRun);
      progressLog(options, `host validation failed ${plan.planId}: ${hostValidation.reason ?? 'Host validation failed.'}`);
      if (hostValidation.outputLogPath) {
        progressLog(options, `host validation log: ${hostValidation.outputLogPath}`);
      }
      if (hostValidation.failureTail && !isTickerOutput(options)) {
        progressLog(options, `host validation failure tail:\n${hostValidation.failureTail}`);
      }

      return {
        outcome: 'failed',
        reason: hostValidation.reason ?? 'Host validation failed.',
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (hostValidation.status === 'pending') {
      updatePlanValidationState(state, plan.planId, {
        host: 'pending',
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation pending.'
      });
      await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);
      await setHostValidationSection(
        plan.filePath,
        'pending',
        hostValidation.provider ?? 'unknown',
        hostValidation.reason ?? 'Host validation pending.',
        options.dryRun
      );
      await logEvent(paths, state, 'host_validation_blocked', {
        planId: plan.planId,
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation pending.',
        outputLogPath: hostValidation.outputLogPath ?? null
      }, options.dryRun);
      progressLog(options, `host validation pending ${plan.planId}: ${hostValidation.reason ?? 'Host validation pending.'}`);
      if (hostValidation.outputLogPath) {
        progressLog(options, `host validation log: ${hostValidation.outputLogPath}`);
      }
      if (hostValidation.failureTail && !isTickerOutput(options)) {
        progressLog(options, `host validation tail:\n${hostValidation.failureTail}`);
      }

      return {
        outcome: 'pending',
        reason: hostValidation.reason ?? 'Host validation pending.',
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    updatePlanValidationState(state, plan.planId, {
      host: 'passed',
      provider: hostValidation.provider ?? null,
      reason: null
    });
    await setHostValidationSection(
      plan.filePath,
      'passed',
      hostValidation.provider ?? 'unknown',
      'Host-required validations passed.',
      options.dryRun
    );
    await logEvent(paths, state, 'host_validation_passed', {
      planId: plan.planId,
      provider: hostValidation.provider ?? null
    }, options.dryRun);
    progressLog(options, `host validation passed ${plan.planId} provider=${hostValidation.provider ?? 'n/a'}`);

    const mergedValidationEvidence = [
      ...alwaysValidation.evidence,
      ...(Array.isArray(hostValidation.evidence) ? hostValidation.evidence : [])
    ];
    const shouldCreateAtomicCommit = asBoolean(options.commit, config.git.atomicCommits !== false);
    const completedTargetPath = await resolveCompletedPlanTargetPath(plan.filePath, paths.completedDir);
    const completedTargetRel = toPosix(path.relative(paths.rootDir, completedTargetPath));
    const commitPolicy = {
      enforceRoots: asBoolean(config.git?.atomicCommitRoots?.enforce, true),
      allowedRoots: resolveAtomicCommitRoots(
        plan,
        config,
        paths,
        { completedRel: completedTargetRel }
      )
    };

    if (shouldCreateAtomicCommit && !options.dryRun) {
      const preflight = evaluateAtomicCommitReadiness(
        paths.rootDir,
        plan.planId,
        options.allowDirty,
        commitPolicy,
        { requireDirty: false }
      );
      if (!preflight.ok) {
        return {
          outcome: 'failed',
          reason: preflight.reason ?? 'atomic commit preflight failed'
        };
      }
    }

    const lifecycle = resolveEvidenceLifecycleConfig(config);
    if (lifecycle.pruneOnComplete) {
      const completionCuration = await curateEvidenceForPlan(plan, paths, options, config);
      if (completionCuration.filesPruned > 0 || completionCuration.filesUpdated > 0) {
        await logEvent(paths, state, 'evidence_curated', {
          planId: plan.planId,
          stage: 'completion',
          session,
          directoriesVisited: completionCuration.directoriesVisited,
          filesPruned: completionCuration.filesPruned,
          filesKept: completionCuration.filesKept,
          filesUpdated: completionCuration.filesUpdated,
          replacementsApplied: completionCuration.replacementsApplied
        }, options.dryRun);
        await refreshEvidenceIndex(plan, paths, state, options, config);
      }
    }

    if (shouldCreateAtomicCommit && !options.dryRun) {
      const preflight = evaluateAtomicCommitReadiness(
        paths.rootDir,
        plan.planId,
        options.allowDirty,
        commitPolicy,
        { requireDirty: false }
      );
      if (!preflight.ok) {
        return {
          outcome: 'failed',
          reason: preflight.reason ?? 'atomic commit preflight failed'
        };
      }
    }

    const rollbackSnapshots = new Map();
    const captureRollbackSnapshot = async (targetPath) => {
      const key = path.resolve(targetPath);
      if (rollbackSnapshots.has(key)) {
        return;
      }
      rollbackSnapshots.set(key, await snapshotFileState(key));
    };
    const rollbackCompletionMutation = async () => {
      const restoreTargets = [...rollbackSnapshots.keys()].reverse();
      for (const target of restoreTargets) {
        await restoreFileState(target, rollbackSnapshots.get(target));
      }
    };

    if (shouldCreateAtomicCommit && !options.dryRun) {
      await captureRollbackSnapshot(plan.filePath);
      await captureRollbackSnapshot(completedTargetPath);
      await captureRollbackSnapshot(path.join(paths.evidenceIndexDir, `${plan.planId}.md`));
      await captureRollbackSnapshot(path.join(paths.evidenceIndexDir, 'README.md'));
      const specTargets = plan.specTargets.length > 0 ? plan.specTargets : ['docs/product-specs/current-state.md'];
      for (const target of specTargets) {
        try {
          const resolved = resolveSafeRepoPath(paths.rootDir, target, `Spec target for plan '${plan.planId}'`);
          await captureRollbackSnapshot(resolved.abs);
        } catch {
          // Skip invalid spec targets here; updateProductSpecs already emits explicit skip events.
        }
      }
    }

    const completedPath = await finalizeCompletedPlan(
      plan,
      paths,
      state,
      mergedValidationEvidence,
      options,
      config,
      {
        planStartedAt,
        sessionsExecuted: session,
        rollovers,
        hostValidationProvider: hostValidation.provider ?? 'none',
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        declaredRiskTier: lastAssessment.declaredRiskTier,
        rolePipeline: roleState.stages.join(' -> '),
        targetPath: completedTargetPath
      }
    );

    await updateProductSpecs(plan, completedPath, paths, state, options);

    let commitResult = { ok: true, committed: false, commitHash: null };
    if (shouldCreateAtomicCommit) {
      commitResult = createAtomicCommit(
        paths.rootDir,
        plan.planId,
        options.dryRun,
        options.allowDirty,
        commitPolicy
      );
      if (!commitResult.ok) {
        if (!options.dryRun) {
          await rollbackCompletionMutation();
        }
        return {
          outcome: 'failed',
          reason: commitResult.reason ?? 'atomic commit failed; completion mutation rolled back'
        };
      }
      if (commitResult.committed) {
        state.stats.commits += 1;
      }
    }

    return {
      outcome: 'completed',
      reason: 'completed',
      completedPath: toPosix(path.relative(paths.rootDir, completedPath)),
      commitHash: commitResult.commitHash,
      validationEvidence: mergedValidationEvidence,
      riskTier: lastAssessment.effectiveRiskTier
    };
  }

  return {
    outcome: 'pending',
    reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}).`,
    riskTier: lastAssessment.effectiveRiskTier
  };
}

async function collectPlanCatalog(paths) {
  const [future, active, completed] = await Promise.all([
    loadPlanRecords(paths.rootDir, paths.futureDir, 'future'),
    loadPlanRecords(paths.rootDir, paths.activeDir, 'active'),
    loadPlanRecords(paths.rootDir, paths.completedDir, 'completed')
  ]);

  return {
    future,
    active,
    completed,
    byId: uniqueByPlanId([...future, ...active, ...completed])
  };
}

function reconcileOutcomeTracking(state, catalog) {
  const completedIds = new Set([
    ...state.completedPlanIds,
    ...catalog.completed.map((plan) => plan.planId)
  ]);
  const blockedIds = new Set(
    catalog.active.filter((plan) => plan.status === 'blocked').map((plan) => plan.planId)
  );
  const failedIds = new Set(
    catalog.active.filter((plan) => plan.status === 'failed').map((plan) => plan.planId)
  );

  state.completedPlanIds = [...completedIds];
  state.blockedPlanIds = [...blockedIds].filter((planId) => !completedIds.has(planId));
  state.failedPlanIds = [...failedIds].filter((planId) => !completedIds.has(planId));
}

async function runLoop(paths, state, options, config, runMode) {
  let processed = 0;
  const maxPlans = asInteger(options.maxPlans, Number.MAX_SAFE_INTEGER);
  const deferredPlanIds = new Set();
  const dependencyWaitCache = new Map();
  const recoveryAnnounced = new Set();

  while (processed < maxPlans) {
    const catalog = await collectPlanCatalog(paths);
    reconcileOutcomeTracking(state, catalog);
    const completedIds = new Set(state.completedPlanIds);
    const recoverable = classifyRecoverablePlans(catalog.active, completedIds, state, options, config);
    const recoverablePlanIds = new Set([
      ...recoverable.retryableFailed.keys(),
      ...recoverable.unblockable.keys()
    ]);

    for (const [planId, details] of recoverable.retryableFailed.entries()) {
      if (recoveryAnnounced.has(`retry:${planId}`)) {
        continue;
      }
      recoveryAnnounced.add(`retry:${planId}`);
      await logEvent(paths, state, 'plan_retry_armed', {
        planId,
        attempts: details.attempts,
        maxAttempts: details.maxAttempts
      }, options.dryRun);
      progressLog(options, `retry armed ${planId}: attempt ${details.attempts + 1}/${details.maxAttempts}`);
    }
    for (const [planId, details] of recoverable.unblockable.entries()) {
      if (recoveryAnnounced.has(`unblock:${planId}`)) {
        continue;
      }
      recoveryAnnounced.add(`unblock:${planId}`);
      await logEvent(paths, state, 'plan_unblock_armed', {
        planId,
        reason: details.reason
      }, options.dryRun);
      progressLog(options, `auto-unblock armed ${planId}: ${details.reason}`);
    }

    const failedOrBlockedIds = new Set([...deferredPlanIds]);
    for (const planId of state.failedPlanIds) {
      if (!recoverablePlanIds.has(planId)) {
        failedOrBlockedIds.add(planId);
      }
    }
    for (const planId of state.blockedPlanIds) {
      if (!recoverablePlanIds.has(planId)) {
        failedOrBlockedIds.add(planId);
      }
    }

    state.failedPlanIds = state.failedPlanIds.filter((planId) => !recoverablePlanIds.has(planId));
    state.blockedPlanIds = state.blockedPlanIds.filter((planId) => !recoverablePlanIds.has(planId));

    let executable = executablePlans(catalog.active, completedIds, failedOrBlockedIds, recoverablePlanIds);
    let blockedByDependency = blockedPlans(catalog.active, completedIds, failedOrBlockedIds);
    if (options.planId) {
      executable = executable.filter((plan) => matchesPlanIdFilter(plan, options.planId));
      blockedByDependency = blockedByDependency.filter((plan) => matchesPlanIdFilter(plan, options.planId));
    }

    state.queue = executable.map((plan) => plan.planId);
    await saveState(paths, state, options.dryRun);

    for (const blocked of blockedByDependency) {
      const missingDependencies = blocked.dependencies.filter((dependency) => !completedIds.has(dependency));
      const cacheValue = missingDependencies.slice().sort().join(',');
      if (dependencyWaitCache.get(blocked.planId) === cacheValue) {
        continue;
      }

      dependencyWaitCache.set(blocked.planId, cacheValue);
      await logEvent(paths, state, 'plan_waiting_dependency', {
        planId: blocked.planId,
        missingDependencies
      }, options.dryRun);
    }

    if (executable.length === 0) {
      if (state.blockedPlanIds.length > 0) {
        progressLog(
          options,
          `no executable plans; ${state.blockedPlanIds.length} plan(s) are blocked in this run. Run audit for details.`
        );
      }
      break;
    }

    const nextPlan = executable[0];
    if (nextPlan.status === 'failed' && recoverable.retryableFailed.has(nextPlan.planId)) {
      registerPlanRetryAttempt(state, nextPlan.planId);
    }
    const nextPlanRisk = computeRiskAssessment(nextPlan, state, config);
    await logEvent(paths, state, 'plan_started', {
      planId: nextPlan.planId,
      planFile: nextPlan.rel,
      runMode,
      declaredRiskTier: nextPlanRisk.declaredRiskTier,
      computedRiskTier: nextPlanRisk.computedRiskTier,
      effectiveRiskTier: nextPlanRisk.effectiveRiskTier,
      riskScore: nextPlanRisk.score,
      sensitive: nextPlanRisk.sensitive
    }, options.dryRun);
    progressLog(
      options,
      `plan start ${nextPlan.planId} declared=${nextPlanRisk.declaredRiskTier} effective=${nextPlanRisk.effectiveRiskTier} score=${nextPlanRisk.score}`
    );

    const outcome = await processPlan(nextPlan, paths, state, options, config);
    state.inProgress = null;

    if (outcome.outcome === 'completed') {
      delete state.roleState[nextPlan.planId];
      clearPlanRecoveryState(state, nextPlan.planId);
      if (!state.completedPlanIds.includes(nextPlan.planId)) {
        state.completedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_completed', {
        planId: nextPlan.planId,
        completedPath: outcome.completedPath,
        commitHash: outcome.commitHash ?? null,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      }, options.dryRun);
      progressLog(options, `plan completed ${nextPlan.planId}`);
    } else if (outcome.outcome === 'blocked') {
      const nextSteps = deriveOutcomeNextSteps(
        nextPlan,
        outcome,
        state,
        config,
        outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      );
      if (!state.blockedPlanIds.includes(nextPlan.planId)) {
        state.blockedPlanIds.push(nextPlan.planId);
      }
      progressLog(options, `blocked ${nextPlan.planId}: ${outcome.reason}`);
      if (nextSteps.length > 0) {
        progressLog(options, `next steps ${nextPlan.planId}: ${nextSteps.join(' | ')}`);
      }
      await logEvent(paths, state, 'plan_blocked', {
        planId: nextPlan.planId,
        reason: outcome.reason,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier,
        nextSteps
      }, options.dryRun);
    } else if (outcome.outcome === 'pending') {
      const nextSteps = deriveOutcomeNextSteps(
        nextPlan,
        outcome,
        state,
        config,
        outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      );
      deferredPlanIds.add(nextPlan.planId);
      await logEvent(paths, state, 'plan_pending', {
        planId: nextPlan.planId,
        reason: outcome.reason,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier,
        nextSteps
      }, options.dryRun);
      progressLog(options, `plan pending ${nextPlan.planId}: ${outcome.reason}`);
      if (nextSteps.length > 0) {
        progressLog(options, `next steps ${nextPlan.planId}: ${nextSteps.join(' | ')}`);
      }
    } else {
      const nextSteps = deriveOutcomeNextSteps(
        nextPlan,
        outcome,
        state,
        config,
        outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      );
      delete state.roleState[nextPlan.planId];
      registerPlanFailureAttempt(state, nextPlan.planId, outcome.reason ?? 'unknown failure');
      if (!state.failedPlanIds.includes(nextPlan.planId)) {
        state.failedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_failed', {
        planId: nextPlan.planId,
        reason: outcome.reason,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier,
        nextSteps
      }, options.dryRun);
      progressLog(options, `plan failed ${nextPlan.planId}: ${outcome.reason}`);
      if (nextSteps.length > 0) {
        progressLog(options, `next steps ${nextPlan.planId}: ${nextSteps.join(' | ')}`);
      }
    }

    await saveState(paths, state, options.dryRun);
    processed += 1;
  }

  return processed;
}

function planDependenciesReady(plan, completedPlanIds) {
  return (plan.dependencies ?? []).every((dependency) => completedPlanIds.has(dependency));
}

function schedulerLocksForPlan(plan) {
  const locks = new Set();
  for (const lock of Array.isArray(plan.concurrencyLocks) ? plan.concurrencyLocks : []) {
    locks.add(`custom:${String(lock).trim().toLowerCase()}`);
  }
  const targets =
    Array.isArray(plan.specTargets) && plan.specTargets.length > 0
      ? plan.specTargets
      : ['docs/product-specs/current-state.md'];
  for (const target of targets) {
    locks.add(`spec:${target}`);
  }
  if (targets.includes('docs/product-specs/current-state.md')) {
    locks.add('shared:product-spec-current-state');
  }
  return [...locks].sort((a, b) => a.localeCompare(b));
}

function selectParallelDispatchBatch(candidates, activeLocks, maxToSelect) {
  const selected = [];
  const localLocks = new Set(activeLocks);
  for (const plan of candidates) {
    if (selected.length >= maxToSelect) {
      break;
    }
    const planLocks = schedulerLocksForPlan(plan);
    const conflicts = planLocks.some((entry) => localLocks.has(entry));
    if (conflicts) {
      continue;
    }
    selected.push(plan);
    for (const lock of planLocks) {
      localLocks.add(lock);
    }
  }
  return selected;
}

function parallelWorkerRunId(runId, planId) {
  return `${runId}-${planId}`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function replaceParallelCommandTokens(template, details) {
  return String(template)
    .replaceAll('{plan_id}', details.planId)
    .replaceAll('{branch}', details.branchName)
    .replaceAll('{base_ref}', details.baseRef)
    .replaceAll('{git_remote}', details.gitRemote)
    .replaceAll('{run_id}', details.runId)
    .replaceAll('{head_sha}', details.headSha ?? '')
    .replaceAll('{worktree}', details.worktreeDir);
}

function buildParallelWorkerCommand(plan, state, options, parallelOptions) {
  const args = [
    'node',
    './scripts/automation/orchestrator.mjs',
    'run',
    '--mode',
    state.effectiveMode,
    '--max-plans',
    '1',
    '--skip-promotion',
    'true',
    '--plan-id',
    plan.planId,
    '--run-id',
    parallelWorkerRunId(state.runId, plan.planId),
    '--parallel-plans',
    '1',
    '--max-rollovers',
    String(asInteger(options.maxRollovers, DEFAULT_MAX_ROLLOVERS)),
    '--max-sessions-per-plan',
    String(asInteger(options.maxSessionsPerPlan, DEFAULT_MAX_SESSIONS_PER_PLAN)),
    '--context-threshold',
    String(asInteger(options.contextThreshold, DEFAULT_CONTEXT_THRESHOLD)),
    '--require-result-payload',
    String(asBoolean(options.requireResultPayload, DEFAULT_REQUIRE_RESULT_PAYLOAD)),
    '--output',
    parallelOptions.workerOutputMode,
    '--failure-tail-lines',
    String(asInteger(options.failureTailLines, DEFAULT_FAILURE_TAIL_LINES)),
    '--heartbeat-seconds',
    String(asInteger(options.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS)),
    '--stall-warn-seconds',
    String(asInteger(options.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS)),
    '--touch-summary',
    String(asBoolean(options.touchSummary, DEFAULT_TOUCH_SUMMARY)),
    '--touch-sample-size',
    String(asInteger(options.touchSampleSize, DEFAULT_TOUCH_SAMPLE_SIZE)),
    '--worker-first-touch-deadline-seconds',
    String(asInteger(options.workerFirstTouchDeadlineSeconds, DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS)),
    '--worker-no-touch-retry-limit',
    String(asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)),
    '--retry-failed',
    String(asBoolean(options.retryFailedPlans, DEFAULT_RETRY_FAILED_PLANS)),
    '--auto-unblock',
    String(asBoolean(options.autoUnblockPlans, DEFAULT_AUTO_UNBLOCK_PLANS)),
    '--max-failed-retries',
    String(asInteger(options.maxFailedRetries, DEFAULT_MAX_FAILED_RETRIES)),
    '--commit',
    String(asBoolean(options.commit, true)),
    '--allow-dirty',
    'false'
  ];
  if (options.dryRun) {
    args.push('--dry-run', 'true');
  }
  return args.map((entry) => shellQuote(entry)).join(' ');
}

async function prepareParallelWorktree(paths, parallelOptions, plan, state, options) {
  const runToken = sanitizeBranchToken(state.runId) || `run-${Date.now()}`;
  const planToken = sanitizeBranchToken(plan.planId) || `plan-${Date.now()}`;
  const branchName = `${parallelOptions.branchPrefix}/${runToken}/${planToken}`;
  const worktreeDir = path.join(paths.rootDir, parallelOptions.worktreeRoot, `${runToken}-${planToken}`);

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
    if (await exists(worktreeDir)) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
    try {
      const add = runShellCapture(
        `git worktree add --detach ${shellQuote(worktreeDir)} ${shellQuote(parallelOptions.baseRef)}`,
        paths.rootDir
      );
      if (add.status !== 0) {
        throw new Error(`Failed to create worktree for ${plan.planId}. ${tailLines(executionOutput(add), 5)}`);
      }
      const checkout = runShellCapture(
        `git -C ${shellQuote(worktreeDir)} checkout -B ${shellQuote(branchName)}`,
        paths.rootDir
      );
      if (checkout.status !== 0) {
        throw new Error(`Failed to create branch ${branchName} for ${plan.planId}. ${tailLines(executionOutput(checkout), 5)}`);
      }
    } catch (error) {
      runShellCapture(`git worktree remove --force ${shellQuote(worktreeDir)}`, paths.rootDir);
      throw error;
    }
  }

  return {
    branchName,
    worktreeDir
  };
}

async function cleanupParallelWorktree(paths, worktreeDir, options) {
  if (options.dryRun) {
    return { ok: true, reason: null };
  }
  const remove = runShellCapture(`git worktree remove --force ${shellQuote(worktreeDir)}`, paths.rootDir);
  if (remove.status !== 0) {
    const prune = runShellCapture('git worktree prune', paths.rootDir);
    if (prune.status === 0) {
      return {
        ok: false,
        reason: `worktree cleanup failed but prune succeeded for ${worktreeDir}: ${tailLines(executionOutput(remove), 5)}`
      };
    }
    return {
      ok: false,
      reason:
        `worktree cleanup failed for ${worktreeDir}: ${tailLines(executionOutput(remove), 5)}; ` +
        `prune failed: ${tailLines(executionOutput(prune), 5)}`
    };
  }
  return { ok: true, reason: null };
}

async function seedParallelWorkerPlanFile(plan, paths, worktreeDir, options) {
  if (options.dryRun) {
    return { ok: true, seeded: false, planRel: null };
  }
  if (!(await exists(plan.filePath))) {
    return {
      ok: false,
      seeded: false,
      planRel: null,
      reason: `Parallel worker source plan file missing for ${plan.planId}: ${plan.rel}`
    };
  }

  const planRel = assertSafeRelativePlanPath(toPosix(path.relative(paths.rootDir, plan.filePath)));
  const targetPath = path.join(worktreeDir, planRel);
  if (await exists(targetPath)) {
    return { ok: true, seeded: false, planRel };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(plan.filePath, targetPath);

  const add = runShellCapture(
    `git -C ${shellQuote(worktreeDir)} add ${shellQuote(planRel)}`,
    paths.rootDir
  );
  if (add.status !== 0) {
    return {
      ok: false,
      seeded: false,
      planRel,
      reason: `Failed to seed ${plan.planId} into worker worktree: ${tailLines(executionOutput(add), 5)}`
    };
  }

  const commit = runShellCapture(
    `git -C ${shellQuote(worktreeDir)} commit -m ${shellQuote(`chore(automation): seed active plan ${plan.planId}`)} -- ${shellQuote(planRel)}`,
    paths.rootDir
  );
  if (commit.status !== 0) {
    return {
      ok: false,
      seeded: false,
      planRel,
      reason: `Failed to commit seeded active plan ${plan.planId} in worker worktree: ${tailLines(executionOutput(commit), 5)}`
    };
  }

  return { ok: true, seeded: true, planRel };
}

async function runParallelWorkerPlan(plan, paths, state, options, config, parallelOptions) {
  let prepared = null;
  let execution = { status: 0, error: null, stdout: '', stderr: '' };
  let result = null;
  try {
    prepared = await prepareParallelWorktree(paths, parallelOptions, plan, state, options);
    const seededPlan = await seedParallelWorkerPlanFile(plan, paths, prepared.worktreeDir, options);
    if (!seededPlan.ok) {
      throw new Error(seededPlan.reason || `Failed to seed worker plan file for ${plan.planId}.`);
    }
    const workerRunId = parallelWorkerRunId(state.runId, plan.planId);
    const workerCommand = buildParallelWorkerCommand(plan, state, options, parallelOptions);
    const baseShaResult = options.dryRun
      ? { status: 0, stdout: '' }
      : runShellCapture(`git -C ${shellQuote(prepared.worktreeDir)} rev-parse HEAD`, paths.rootDir);
    const baseSha = baseShaResult.status === 0 ? String(baseShaResult.stdout ?? '').trim() : null;

    if (!options.dryRun) {
      execution = await runShellMonitored(
        workerCommand,
        prepared.worktreeDir,
        process.env,
        undefined,
        'pipe',
        options,
        { phase: 'parallel-worker', planId: plan.planId, role: 'worker', activity: 'branch-execution' }
      );
    }

    let workerState = null;
    const workerStatePath = path.join(prepared.worktreeDir, 'docs', 'ops', 'automation', 'run-state.json');
    if (!options.dryRun && execution.status === 0) {
      if (!(await exists(workerStatePath))) {
        throw new Error(`Worker run-state missing for ${plan.planId}: ${toPosix(path.relative(paths.rootDir, workerStatePath))}`);
      }
      workerState = await readJsonStrict(workerStatePath);
    } else {
      workerState = await readJsonIfExists(workerStatePath, null);
    }
    const completed = new Set(Array.isArray(workerState?.completedPlanIds) ? workerState.completedPlanIds : []);
    const failed = new Set(Array.isArray(workerState?.failedPlanIds) ? workerState.failedPlanIds : []);
    const blocked = new Set(Array.isArray(workerState?.blockedPlanIds) ? workerState.blockedPlanIds : []);

    const headShaResult = options.dryRun
      ? { status: 0, stdout: '' }
      : runShellCapture(`git -C ${shellQuote(prepared.worktreeDir)} rev-parse HEAD`, paths.rootDir);
    const headSha = headShaResult.status === 0 ? String(headShaResult.stdout ?? '').trim() : null;
    const committed = Boolean(baseSha && headSha && baseSha !== headSha);

    let outcome = 'pending';
    let reason = 'branch worker pending';
    if (completed.has(plan.planId)) {
      outcome = 'completed';
      reason = 'completed in branch worker';
    } else if (failed.has(plan.planId) || execution.status !== 0) {
      outcome = 'failed';
      reason = execution.status !== 0
        ? `branch worker failed (exit ${execution.status ?? 'n/a'}): ${tailLines(executionOutput(execution), 8)}`
        : 'branch worker marked failed';
    } else if (blocked.has(plan.planId)) {
      outcome = 'blocked';
      reason = 'blocked in branch worker';
    } else if (execution.status === 0 && !options.dryRun) {
      const outputTail = tailLines(executionOutput(execution), 8);
      outcome = 'pending';
      reason = outputTail
        ? `branch worker exited 0 without terminal plan outcome; treated as pending. output: ${outputTail}`
        : 'branch worker exited 0 without terminal plan outcome; treated as pending';
    }

    if (!options.dryRun && committed && parallelOptions.pushBranches) {
      const push = runShellCapture(
        `git push -u ${shellQuote(parallelOptions.gitRemote)} ${shellQuote(prepared.branchName)}`,
        prepared.worktreeDir
      );
      if (push.status !== 0) {
        outcome = 'failed';
        reason = `branch push failed: ${tailLines(executionOutput(push), 8)}`;
      }
    }

    if (
      !options.dryRun &&
      committed &&
      parallelOptions.openPullRequests &&
      parallelOptions.pullRequest.createCommand
    ) {
      const prCommand = replaceParallelCommandTokens(parallelOptions.pullRequest.createCommand, {
        planId: plan.planId,
        branchName: prepared.branchName,
        baseRef: parallelOptions.baseRef,
        gitRemote: parallelOptions.gitRemote,
        runId: workerRunId,
        headSha,
        worktreeDir: prepared.worktreeDir
      });
      const pr = runShellCapture(prCommand, prepared.worktreeDir);
      if (pr.status !== 0) {
        outcome = 'failed';
        reason = `PR creation failed: ${tailLines(executionOutput(pr), 8)}`;
      }
      if (pr.status === 0 && parallelOptions.pullRequest.mergeCommand) {
        const mergeCommand = replaceParallelCommandTokens(parallelOptions.pullRequest.mergeCommand, {
          planId: plan.planId,
          branchName: prepared.branchName,
          baseRef: parallelOptions.baseRef,
          gitRemote: parallelOptions.gitRemote,
          runId: workerRunId,
          headSha,
          worktreeDir: prepared.worktreeDir
        });
        const merge = runShellCapture(mergeCommand, prepared.worktreeDir);
        if (merge.status !== 0) {
          outcome = 'failed';
          reason = `PR merge/queue command failed: ${tailLines(executionOutput(merge), 8)}`;
        }
      }
    }

    result = {
      planId: plan.planId,
      planFile: plan.rel,
      outcome,
      branchName: prepared.branchName,
      worktreeDir: prepared.worktreeDir,
      runId: workerRunId,
      committed,
      baseSha,
      headSha,
      reason,
      exitCode: execution.status
    };
    return result;
  } finally {
    const shouldKeepForDiagnostics = Boolean(
      prepared && !options.dryRun && (!result || result.outcome !== 'completed')
    );
    if (shouldKeepForDiagnostics && result) {
      result.cleanupWarning = result.cleanupWarning ?? `worker worktree preserved for diagnostics: ${prepared.worktreeDir}`;
    }
    if (prepared && !parallelOptions.keepWorktrees && !shouldKeepForDiagnostics) {
      const cleanup = await cleanupParallelWorktree(paths, prepared.worktreeDir, options);
      if (!cleanup.ok) {
        if (result) {
          result.cleanupWarning = cleanup.reason;
        } else if (!execution || execution.status === 0) {
          throw new Error(cleanup.reason || `worktree cleanup failed for ${prepared.worktreeDir}`);
        }
      }
    }
  }
}

async function runParallelCommand(paths, options) {
  const config = await loadConfig(paths);
  Object.assign(options, resolveRuntimeExecutorOptions(options, config));
  const parallelOptions = resolveParallelExecutionOptions(options, config);
  const resumeParallel = asBoolean(options.resumeParallel, false);
  if (parallelOptions.parallelPlans <= 1) {
    return resumeParallel ? resumeCommand(paths, options) : runCommand(paths, options);
  }

  if (!gitAvailable(paths.rootDir)) {
    throw new Error('Parallel execution requires git (worktree/branch mode).');
  }
  if (asBoolean(options.allowDirty, false) && asBoolean(options.commit, config.git.atomicCommits !== false)) {
    throw new Error('Refusing --allow-dirty true with --commit true. Disable commits or start from a clean worktree.');
  }
  let modeResolution = null;
  let state = null;
  if (resumeParallel) {
    const persisted = await readJsonIfExists(paths.runStatePath, null);
    if (!persisted || !persisted.runId) {
      throw new Error('No existing run-state found. Start with `run` first.');
    }
    if (options.runId && options.runId !== persisted.runId) {
      throw new Error(`Requested run-id '${options.runId}' does not match persisted run '${persisted.runId}'.`);
    }
    state = normalizePersistedState(persisted);
    state.capabilities = await detectCapabilities();
  } else {
    modeResolution = resolveEffectiveMode(options.mode);
    const runId = options.runId || randomRunId();
    state = createInitialState(runId, modeResolution.requestedMode, modeResolution.effectiveMode);
    state.capabilities = await detectCapabilities();
  }
  if (
    !asBoolean(options.allowDirty, false) &&
    gitDirty(paths.rootDir, { ignoreTransientAutomationArtifacts: true })
  ) {
    throw new Error(
      resumeParallel
        ? 'Refusing parallel resume with dirty git worktree.'
        : 'Refusing parallel execution with dirty git worktree.'
    );
  }

  assertExecutorConfigured(options, config);
  assertValidationConfigured(options, config, paths);

  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);
  await saveState(paths, state, options.dryRun);

  try {
    if (resumeParallel) {
      await logEvent(paths, state, 'run_resumed_parallel', {
        requestedMode: options.mode ?? state.requestedMode,
        effectiveMode: state.effectiveMode,
        parallelPlans: parallelOptions.parallelPlans,
        branchPrefix: parallelOptions.branchPrefix,
        baseRef: parallelOptions.baseRef,
        worktreeRoot: parallelOptions.worktreeRoot,
        capabilities: state.capabilities
      }, options.dryRun);
    } else {
      await logEvent(paths, state, 'run_started_parallel', {
        requestedMode: modeResolution.requestedMode,
        effectiveMode: modeResolution.effectiveMode,
        parallelPlans: parallelOptions.parallelPlans,
        branchPrefix: parallelOptions.branchPrefix,
        baseRef: parallelOptions.baseRef,
        worktreeRoot: parallelOptions.worktreeRoot
      }, options.dryRun);
    }

    if (!resumeParallel && !asBoolean(options.skipPromotion, false)) {
      const promoted = await promoteFuturePlans(paths, state, options);
      if (promoted > 0) {
        progressLog(options, `promoted ${promoted} future plan(s) into docs/exec-plans/active.`);
      }
    }

    const catalog = await collectPlanCatalog(paths);
    reconcileOutcomeTracking(state, catalog);

    let candidates = catalog.active
      .filter((plan) => ACTIVE_STATUSES.has(plan.status))
      .filter((plan) => plan.status !== 'completed')
      .sort((a, b) => {
        const priorityDelta = priorityOrder(a.priority) - priorityOrder(b.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return a.rel.localeCompare(b.rel);
      });
    if (options.planId) {
      candidates = candidates.filter((plan) => matchesPlanIdFilter(plan, options.planId));
    }
    const maxPlans = asInteger(options.maxPlans, Number.MAX_SAFE_INTEGER);
    if (Number.isFinite(maxPlans)) {
      candidates = candidates.slice(0, maxPlans);
    }

    const completedForScheduling = new Set([...state.completedPlanIds, ...catalog.completed.map((plan) => plan.planId)]);
    const recoverable = classifyRecoverablePlans(catalog.active, completedForScheduling, state, options, config);
    const recoverablePlanIds = new Set([
      ...recoverable.retryableFailed.keys(),
      ...recoverable.unblockable.keys()
    ]);
    candidates = candidates.filter((plan) => (
      plan.status !== 'failed' && plan.status !== 'blocked'
        ? true
        : recoverablePlanIds.has(plan.planId)
    ));
    const pending = new Map(candidates.map((plan) => [plan.planId, plan]));
    const launched = new Set();
    const active = new Map();
    const activeLocks = new Map();
    const dependencyWaitCache = new Map();
    const outcomeSummary = {
      completed: 0,
      blocked: 0,
      failed: 0,
      pending: 0
    };
    let processed = 0;
    state.parallelState.activeWorkers = {};

    while ((launched.size < pending.size || active.size > 0) && processed < maxPlans) {
      const waiting = [...pending.values()]
        .filter((plan) => !launched.has(plan.planId))
        .filter((plan) => !planDependenciesReady(plan, completedForScheduling));
      for (const blocked of waiting) {
        const missingDependencies = blocked.dependencies.filter((dependency) => !completedForScheduling.has(dependency));
        const cacheValue = missingDependencies.slice().sort().join(',');
        if (dependencyWaitCache.get(blocked.planId) === cacheValue) {
          continue;
        }
        dependencyWaitCache.set(blocked.planId, cacheValue);
        await logEvent(paths, state, 'plan_waiting_dependency_parallel', {
          planId: blocked.planId,
          missingDependencies
        }, options.dryRun);
      }

      const ready = [...pending.values()]
        .filter((plan) => !launched.has(plan.planId))
        .filter((plan) => planDependenciesReady(plan, completedForScheduling));
      const remainingBudget = Math.max(0, maxPlans - launched.size);
      const freeSlots = Math.max(0, Math.min(parallelOptions.parallelPlans - active.size, remainingBudget));
      state.queue = ready.map((plan) => plan.planId);
      await saveState(paths, state, options.dryRun);
      if (freeSlots > 0 && ready.length > 0) {
        const reservedLocks = new Set([...activeLocks.values()].flat());
        const batch = selectParallelDispatchBatch(ready, reservedLocks, freeSlots);
        for (const plan of batch) {
          launched.add(plan.planId);
          const locks = schedulerLocksForPlan(plan);
          activeLocks.set(plan.planId, locks);
          progressLog(options, `parallel worker start ${plan.planId}`);
          await logEvent(paths, state, 'parallel_worker_started', {
            planId: plan.planId,
            planFile: plan.rel,
            branchPrefix: parallelOptions.branchPrefix,
            locks
          }, options.dryRun);
          state.parallelState.activeWorkers[plan.planId] = {
            planId: plan.planId,
            planFile: plan.rel,
            branchPrefix: parallelOptions.branchPrefix,
            startedAt: nowIso(),
            locks
          };
          const workerPromise = runParallelWorkerPlan(plan, paths, state, options, config, parallelOptions)
            .then((result) => ({ ...result }))
            .catch((error) => ({
              planId: plan.planId,
              planFile: plan.rel,
              outcome: 'failed',
              reason: error instanceof Error ? error.message : String(error),
              committed: false,
              branchName: null,
              worktreeDir: null,
              runId: parallelWorkerRunId(state.runId, plan.planId),
              baseSha: null,
              headSha: null,
              exitCode: 1
            }));
          active.set(plan.planId, workerPromise);
        }
        await saveState(paths, state, options.dryRun);
      }

      if (active.size === 0) {
        const unresolved = [...pending.values()].filter((plan) => !launched.has(plan.planId));
        for (const unresolvedPlan of unresolved) {
          const missingDependencies = unresolvedPlan.dependencies.filter(
            (dependency) => !completedForScheduling.has(dependency)
          );
          await logEvent(paths, state, 'plan_unscheduled_parallel', {
            planId: unresolvedPlan.planId,
            reason:
              missingDependencies.length > 0
                ? 'dependencies-not-integrated'
                : 'conflict-locks-or-budget',
            missingDependencies
          }, options.dryRun);
        }
        break;
      }

      const nextFinished = await Promise.race(
        [...active.entries()].map(([planId, promise]) => promise.then((result) => ({ planId, result })))
      );
      active.delete(nextFinished.planId);
      activeLocks.delete(nextFinished.planId);
      delete state.parallelState.activeWorkers[nextFinished.planId];
      processed += 1;

      const result = nextFinished.result;
      const plan = pending.get(result.planId);
      if (!plan) {
        continue;
      }

      if (result.outcome === 'completed') {
        outcomeSummary.completed += 1;
        if (parallelOptions.assumeDependencyCompletion) {
          completedForScheduling.add(plan.planId);
        }
        await logEvent(paths, state, 'plan_completed_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          committed: result.committed,
          headSha: result.headSha,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      } else if (result.outcome === 'blocked') {
        outcomeSummary.blocked += 1;
        await logEvent(paths, state, 'plan_blocked_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          reason: result.reason,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      } else if (result.outcome === 'failed') {
        outcomeSummary.failed += 1;
        await logEvent(paths, state, 'plan_failed_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          reason: result.reason,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      } else {
        outcomeSummary.pending += 1;
        await logEvent(paths, state, 'plan_pending_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          reason: result.reason,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      }
      state.parallelState.lastResults[plan.planId] = {
        outcome: result.outcome,
        reason: result.reason ?? null,
        branch: result.branchName ?? null,
        headSha: result.headSha ?? null,
        cleanupWarning: result.cleanupWarning ?? null,
        finishedAt: nowIso()
      };
      progressLog(options, `parallel worker end ${plan.planId} outcome=${result.outcome}`);
      await saveState(paths, state, options.dryRun);
    }

    const unresolvedNotLaunched = [...pending.values()].filter((plan) => !launched.has(plan.planId)).length;
    state.queue = [...pending.values()].filter((plan) => !launched.has(plan.planId)).map((plan) => plan.planId);
    state.parallelState.activeWorkers = {};
    if (unresolvedNotLaunched > 0) {
      outcomeSummary.pending += unresolvedNotLaunched;
    }

    const runDurationSeconds = durationSeconds(state.startedAt);
    await logEvent(paths, state, 'run_finished_parallel', {
      processedPlans: processed,
      branchCompletedPlans: outcomeSummary.completed,
      branchBlockedPlans: outcomeSummary.blocked,
      branchFailedPlans: outcomeSummary.failed,
      branchPendingPlans: outcomeSummary.pending,
      unlaunchedPlans: unresolvedNotLaunched,
      durationSeconds: runDurationSeconds,
      parallelPlans: parallelOptions.parallelPlans
    }, options.dryRun);
    await saveState(paths, state, options.dryRun);
    printParallelRunSummary(options, state, processed, runDurationSeconds, outcomeSummary);
  } finally {
    await releaseRunLock(paths, options);
  }
}

async function runCommand(paths, options) {
  const config = await loadConfig(paths);
  Object.assign(options, resolveRuntimeExecutorOptions(options, config));
  if (asBoolean(options.allowDirty, false) && asBoolean(options.commit, config.git.atomicCommits !== false)) {
    throw new Error('Refusing --allow-dirty true with --commit true. Disable commits or start from a clean worktree.');
  }
  const modeResolution = resolveEffectiveMode(options.mode);
  const runId = options.runId || randomRunId();

  const state = createInitialState(runId, modeResolution.requestedMode, modeResolution.effectiveMode);
  state.capabilities = await detectCapabilities();

  if (
    !asBoolean(options.allowDirty, false) &&
    gitAvailable(paths.rootDir) &&
    gitDirty(paths.rootDir, { ignoreTransientAutomationArtifacts: true })
  ) {
    throw new Error('Refusing to start with a dirty git worktree. Use --allow-dirty true to override.');
  }

  assertExecutorConfigured(options, config);
  assertValidationConfigured(options, config, paths);

  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);
  await saveState(paths, state, options.dryRun);

  try {
    const roleConfig = resolveRoleOrchestration(config);
    await logEvent(paths, state, 'run_started', {
      requestedMode: modeResolution.requestedMode,
      effectiveMode: modeResolution.effectiveMode,
      downgraded: modeResolution.downgraded,
      downgradeReason: modeResolution.reason,
      capabilities: state.capabilities,
      sessionPolicy: {
        contextThreshold: options.contextThreshold,
        requireResultPayload: options.requireResultPayload,
        contactPacks: {
          enabled: options.contactPackEnabled,
          maxPolicyBullets: options.contactPackMaxPolicyBullets,
          includeRecentEvidence: options.contactPackIncludeRecentEvidence,
          maxRecentEvidenceItems: options.contactPackMaxRecentEvidenceItems
        }
      },
      roleOrchestration: {
        enabled: roleConfig.enabled,
        mode: roleConfig.mode,
        pipelines: roleConfig.pipelines,
        stageBudgetsSeconds: roleConfig.stageBudgetsSeconds,
        stageReuse: roleConfig.stageReuse
      }
    }, options.dryRun);

    if (modeResolution.downgraded) {
      progressLog(options, `full mode downgraded to guarded: ${modeResolution.reason}`);
    }
    progressLog(
      options,
      `run started runId=${state.runId} mode=${state.effectiveMode} output=${options.outputMode} failureTailLines=${options.failureTailLines}`
    );

    let processed = await runLoop(paths, state, options, config, 'run');

    if (!asBoolean(options.skipPromotion, false)) {
      const promoted = await promoteFuturePlans(paths, state, options);
      if (promoted > 0) {
        progressLog(options, `promoted ${promoted} future plan(s) into docs/exec-plans/active.`);
        const processedAfterPromotion = await runLoop(paths, state, options, config, 'run');
        processed += processedAfterPromotion;
      }
    }

    const runDurationSeconds = durationSeconds(state.startedAt);
    await logEvent(paths, state, 'run_finished', {
      processedPlans: processed,
      completedPlans: state.completedPlanIds.length,
      blockedPlans: state.blockedPlanIds.length,
      failedPlans: state.failedPlanIds.length,
      promotions: state.stats.promotions,
      handoffs: state.stats.handoffs,
      commits: state.stats.commits,
      validationFailures: state.stats.validationFailures,
      durationSeconds: runDurationSeconds
    }, options.dryRun);

    await saveState(paths, state, options.dryRun);

    printRunSummary(options, 'run', state, processed, runDurationSeconds);
  } finally {
    await releaseRunLock(paths, options);
  }
}

async function resumeCommand(paths, options) {
  const config = await loadConfig(paths);
  Object.assign(options, resolveRuntimeExecutorOptions(options, config));
  if (asBoolean(options.allowDirty, false) && asBoolean(options.commit, config.git.atomicCommits !== false)) {
    throw new Error('Refusing --allow-dirty true with --commit true. Disable commits or start from a clean worktree.');
  }
  const persisted = await readJsonIfExists(paths.runStatePath, null);

  if (!persisted || !persisted.runId) {
    throw new Error('No existing run-state found. Start with `run` first.');
  }

  if (options.runId && options.runId !== persisted.runId) {
    throw new Error(`Requested run-id '${options.runId}' does not match persisted run '${persisted.runId}'.`);
  }

  const state = normalizePersistedState(persisted);
  state.capabilities = await detectCapabilities();
  if (
    !asBoolean(options.allowDirty, false) &&
    gitAvailable(paths.rootDir) &&
    gitDirty(paths.rootDir, { ignoreTransientAutomationArtifacts: true })
  ) {
    throw new Error('Refusing to resume with a dirty git worktree. Use --allow-dirty true to override.');
  }
  assertExecutorConfigured(options, config);
  assertValidationConfigured(options, config, paths);
  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);

  try {
    const roleConfig = resolveRoleOrchestration(config);
    await logEvent(paths, state, 'run_resumed', {
      requestedMode: options.mode ?? state.requestedMode,
      effectiveMode: state.effectiveMode,
      capabilities: state.capabilities,
      sessionPolicy: {
        contextThreshold: options.contextThreshold,
        requireResultPayload: options.requireResultPayload,
        contactPacks: {
          enabled: options.contactPackEnabled,
          maxPolicyBullets: options.contactPackMaxPolicyBullets,
          includeRecentEvidence: options.contactPackIncludeRecentEvidence,
          maxRecentEvidenceItems: options.contactPackMaxRecentEvidenceItems
        }
      },
      roleOrchestration: {
        enabled: roleConfig.enabled,
        mode: roleConfig.mode,
        pipelines: roleConfig.pipelines,
        stageBudgetsSeconds: roleConfig.stageBudgetsSeconds,
        stageReuse: roleConfig.stageReuse
      }
    }, options.dryRun);
    progressLog(
      options,
      `run resumed runId=${state.runId} mode=${state.effectiveMode} output=${options.outputMode} failureTailLines=${options.failureTailLines}`
    );

    const processed = await runLoop(paths, state, options, config, 'resume');

    const runDurationSeconds = durationSeconds(state.startedAt);
    await logEvent(paths, state, 'run_finished', {
      processedPlans: processed,
      completedPlans: state.completedPlanIds.length,
      blockedPlans: state.blockedPlanIds.length,
      failedPlans: state.failedPlanIds.length,
      promotions: state.stats?.promotions ?? 0,
      handoffs: state.stats?.handoffs ?? 0,
      commits: state.stats?.commits ?? 0,
      validationFailures: state.stats?.validationFailures ?? 0,
      durationSeconds: runDurationSeconds
    }, options.dryRun);

    await saveState(paths, state, options.dryRun);

    printRunSummary(options, 'resume', state, processed, runDurationSeconds);
  } finally {
    await releaseRunLock(paths, options);
  }
}

function parseEventLines(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines to keep audit resilient.
    }
  }
  return events;
}

async function auditCommand(paths, options) {
  if (!(await exists(paths.runEventsPath))) {
    console.log('[orchestrator] no run events found.');
    return;
  }

  const raw = await fs.readFile(paths.runEventsPath, 'utf8');
  const events = parseEventLines(raw);
  const filtered = options.runId ? events.filter((event) => event.runId === options.runId) : events;

  const countsByType = new Map();
  const latestPerPlan = new Map();
  const runIds = new Set();

  for (const event of filtered) {
    runIds.add(event.runId);
    countsByType.set(event.type, (countsByType.get(event.type) ?? 0) + 1);

    const planId = event.details?.planId || event.taskId;
    if (planId) {
      latestPerPlan.set(planId, {
        planId,
        type: event.type,
        timestamp: event.timestamp,
        reason: event.details?.reason ?? null
      });
    }
  }

  const payload = {
    runs: [...runIds].sort(),
    eventCount: filtered.length,
    countsByType: Object.fromEntries([...countsByType.entries()].sort(([a], [b]) => a.localeCompare(b))),
    planStatuses: [...latestPerPlan.values()].sort((a, b) => a.planId.localeCompare(b.planId))
  };

  if (asBoolean(options.json, false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('[orchestrator] audit summary');
  console.log(`- runs: ${payload.runs.join(', ') || 'none'}`);
  console.log(`- events: ${payload.eventCount}`);
  console.log('- counts by type:');
  for (const [type, count] of Object.entries(payload.countsByType)) {
    console.log(`  - ${type}: ${count}`);
  }

  console.log('- latest status by plan:');
  for (const status of payload.planStatuses) {
    const reasonSuffix = status.reason ? ` (${status.reason})` : '';
    console.log(`  - ${status.planId}: ${status.type} @ ${status.timestamp}${reasonSuffix}`);
  }
}

async function curateEvidenceCommand(paths, options) {
  const config = await loadConfig(paths);
  await ensureDirectories(paths, options.dryRun);

  const scope = normalizeCurationScope(options.scope);
  const directories = [];
  if (scope === 'active' || scope === 'all') {
    directories.push(...(await collectAllActiveEvidenceDirectories(paths, options.planId ?? null)));
  }
  if (scope === 'completed' || scope === 'all') {
    directories.push(...(await collectAllCompletedEvidenceDirectories(paths, options.planId ?? null)));
  }

  const summary = await curateEvidenceDirectories(paths, directories, options, config);
  const completedSummary =
    scope === 'completed' || scope === 'all'
      ? await canonicalizeCompletedPlansEvidence(paths, options, config, options.planId ?? null)
      : { plansVisited: 0, plansUpdated: 0, plansIndexed: 0 };
  await writeEvidenceIndexReadme(paths, options);

  if (asBoolean(options.json, false)) {
    console.log(
      JSON.stringify(
        {
          command: 'curate-evidence',
          scope,
          directories: [...new Set(directories)].length,
          ...summary,
          ...completedSummary
        },
        null,
        2
      )
    );
    return;
  }

  console.log('[orchestrator] evidence curation complete.');
  console.log(`- scope: ${scope}`);
  console.log(`- directories: ${[...new Set(directories)].length}`);
  console.log(`- files pruned: ${summary.filesPruned}`);
  console.log(`- files kept: ${summary.filesKept}`);
  console.log(`- docs updated: ${summary.filesUpdated}`);
  console.log(`- path replacements: ${summary.replacementsApplied}`);
  console.log(`- completed plans visited: ${completedSummary.plansVisited}`);
  console.log(`- completed plans updated: ${completedSummary.plansUpdated}`);
  console.log(`- completed plans indexed: ${completedSummary.plansIndexed}`);
}

async function main() {
  const { command, options: rawOptions } = parseArgs(process.argv.slice(2));

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (rawOptions.executor != null || rawOptions['executor-command'] != null) {
    throw new Error(
      'Executor CLI override is disabled. Set docs/ops/automation/orchestrator.config.json executor.command.'
    );
  }

  const options = {
    ...rawOptions,
    mode: rawOptions.mode ?? 'guarded',
    maxPlans: asInteger(rawOptions['max-plans'] ?? rawOptions.maxPlans, Number.MAX_SAFE_INTEGER),
    parallelPlans: asInteger(rawOptions['parallel-plans'] ?? rawOptions.parallelPlans, DEFAULT_PARALLEL_PLANS),
    contextThreshold: asInteger(rawOptions['context-threshold'] ?? rawOptions.contextThreshold, null),
    requireResultPayload: rawOptions['require-result-payload'] ?? rawOptions.requireResultPayload,
    handoffTokenBudget: asInteger(rawOptions['handoff-token-budget'] ?? rawOptions.handoffTokenBudget, DEFAULT_HANDOFF_TOKEN_BUDGET),
    maxRollovers: asInteger(rawOptions['max-rollovers'] ?? rawOptions.maxRollovers, DEFAULT_MAX_ROLLOVERS),
    maxSessionsPerPlan: asInteger(
      rawOptions['max-sessions-per-plan'] ?? rawOptions.maxSessionsPerPlan,
      DEFAULT_MAX_SESSIONS_PER_PLAN
    ),
    validationCommands: rawOptions.validation ?? rawOptions['validation-commands'] ?? '',
    commit: asBoolean(rawOptions.commit, true),
    skipPromotion: asBoolean(rawOptions['skip-promotion'] ?? rawOptions.skipPromotion, false),
    allowDirty: asBoolean(rawOptions['allow-dirty'] ?? rawOptions.allowDirty, false),
    dryRun: asBoolean(rawOptions['dry-run'] ?? rawOptions.dryRun, false),
    json: asBoolean(rawOptions.json, false),
    runId: rawOptions['run-id'] ?? rawOptions.runId,
    planId: rawOptions['plan-id'] ?? rawOptions.planId,
    scope: rawOptions.scope ?? 'all',
    handoffExitCode: asInteger(rawOptions['handoff-exit-code'] ?? rawOptions.handoffExitCode, DEFAULT_HANDOFF_EXIT_CODE),
    outputMode: rawOptions.output ?? rawOptions['output-mode'],
    failureTailLines: rawOptions['failure-tail-lines'] ?? rawOptions.failureTailLines,
    heartbeatSeconds: rawOptions['heartbeat-seconds'] ?? rawOptions.heartbeatSeconds,
    stallWarnSeconds: rawOptions['stall-warn-seconds'] ?? rawOptions.stallWarnSeconds,
    touchSummary: rawOptions['touch-summary'] ?? rawOptions.touchSummary,
    touchSampleSize: rawOptions['touch-sample-size'] ?? rawOptions.touchSampleSize,
    workerFirstTouchDeadlineSeconds:
      rawOptions['worker-first-touch-deadline-seconds'] ?? rawOptions.workerFirstTouchDeadlineSeconds,
    workerNoTouchRetryLimit:
      rawOptions['worker-no-touch-retry-limit'] ?? rawOptions.workerNoTouchRetryLimit
  };

  const rootDir = process.cwd();
  const paths = buildPaths(rootDir);

  if (command === 'run') {
    if (asInteger(options.parallelPlans, DEFAULT_PARALLEL_PLANS) > 1) {
      await runParallelCommand(paths, options);
      return;
    }
    await runCommand(paths, options);
    return;
  }

  if (command === 'run-parallel') {
    await runParallelCommand(paths, options);
    return;
  }

  if (command === 'resume-parallel') {
    options.resumeParallel = true;
    if (rawOptions['skip-promotion'] == null && rawOptions.skipPromotion == null) {
      options.skipPromotion = true;
    }
    await runParallelCommand(paths, options);
    return;
  }

  if (command === 'resume') {
    if (asInteger(options.parallelPlans, DEFAULT_PARALLEL_PLANS) > 1) {
      options.resumeParallel = true;
      if (rawOptions['skip-promotion'] == null && rawOptions.skipPromotion == null) {
        options.skipPromotion = true;
      }
      await runParallelCommand(paths, options);
      return;
    }
    await resumeCommand(paths, options);
    return;
  }

  if (command === 'audit') {
    await auditCommand(paths, options);
    return;
  }

  if (command === 'curate-evidence') {
    await curateEvidenceCommand(paths, options);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error('[orchestrator] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
