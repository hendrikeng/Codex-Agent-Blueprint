#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTIVE_STATUSES,
  listMarkdownFiles,
  metadataValue,
  normalizeStatus,
  parseListField,
  parseMetadata,
  parsePriority,
  priorityOrder,
  setMetadataFields,
  todayIsoDate,
  inferPlanId
} from './lib/plan-metadata.mjs';

const DEFAULT_CONTEXT_THRESHOLD = 2000;
const DEFAULT_HANDOFF_TOKEN_BUDGET = 1500;
const DEFAULT_MAX_ROLLOVERS = 5;
const DEFAULT_MAX_SESSIONS_PER_PLAN = 20;
const DEFAULT_HANDOFF_EXIT_CODE = 75;
const DEFAULT_HOST_VALIDATION_MODE = 'hybrid';
const DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS = 1800;
const DEFAULT_HOST_VALIDATION_POLL_SECONDS = 15;
const DEFAULT_EVIDENCE_MAX_REFERENCES = 25;
const TRANSIENT_AUTOMATION_FILES = new Set([
  'docs/ops/automation/run-state.json',
  'docs/ops/automation/run-events.jsonl'
]);
const TRANSIENT_AUTOMATION_DIR_PREFIXES = [
  'docs/ops/automation/runtime/',
  'docs/ops/automation/handoffs/'
];

function usage() {
  console.log(`Usage:
  node ./scripts/automation/orchestrator.mjs run [options]
  node ./scripts/automation/orchestrator.mjs resume [options]
  node ./scripts/automation/orchestrator.mjs audit [options]

Options:
  --mode guarded|full                Autonomy mode (default: guarded)
  --max-plans <n>                    Maximum plans to process in this run
  --context-threshold <n>            Trigger rollover when contextRemaining < n
  --handoff-token-budget <n>         Metadata field for handoff budget reporting
  --max-rollovers <n>                Maximum rollovers per plan (default: 5)
  --max-sessions-per-plan <n>        Maximum executor sessions per plan in one run (default: 20)
  --validation "cmd1;;cmd2"          Validation commands separated by ';;'
  --commit true|false                Create atomic git commit per completed plan
  --skip-promotion true|false        Skip future->active promotion stage
  --allow-dirty true|false           Allow starting with dirty git worktree
  --run-id <id>                      Resume or audit a specific run id
  --dry-run true|false               Do not write changes or run git commits
  --json true|false                  JSON output for audit
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

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function nowIso() {
  return new Date().toISOString();
}

function isoDate(value) {
  return String(value).slice(0, 10);
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

function runShell(command, cwd, env = process.env) {
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    stdio: 'inherit'
  });
}

function runShellCapture(command, cwd, env = process.env) {
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
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
      handoffExitCode: DEFAULT_HANDOFF_EXIT_CODE
    },
    validationCommands: [],
    validation: {
      always: [],
      hostRequired: [],
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
      }
    },
    git: {
      atomicCommits: true
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
      }
    },
    git: {
      ...defaultConfig.git,
      ...(configured.git ?? {})
    }
  };
}

async function acquireRunLock(paths, state, options) {
  if (options.dryRun) {
    return;
  }

  const existing = await readJsonIfExists(paths.runLockPath, null);
  const existingPid = Number.isInteger(existing?.pid) ? existing.pid : null;
  if (existingPid && existingPid !== process.pid && pidIsAlive(existingPid)) {
    throw new Error(
      `Another orchestrator run appears active (pid ${existingPid}, runId ${existing?.runId ?? 'unknown'}).`
    );
  }

  const payload = {
    pid: process.pid,
    runId: state.runId,
    mode: state.effectiveMode,
    acquiredAt: nowIso(),
    cwd: paths.rootDir
  };
  await writeJson(paths.runLockPath, payload, options.dryRun);
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

function createInitialState(runId, requestedMode, effectiveMode) {
  return {
    version: 1,
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
    evidenceState: {},
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
  normalized.evidenceState =
    normalized.evidenceState && typeof normalized.evidenceState === 'object' ? normalized.evidenceState : {};
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

async function logEvent(paths, state, type, details, dryRun) {
  const event = {
    timestamp: nowIso(),
    runId: state.runId,
    taskId: details.planId ?? null,
    type,
    model: details.model ?? process.env.ORCH_MODEL_ID ?? 'n/a',
    mode: state.effectiveMode,
    details
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

  if (effectiveMode === 'guarded' && (riskTier === 'medium' || riskTier === 'high')) {
    return { allowed: false, reason: `Risk tier '${riskTier}' requires explicit approvals in guarded mode.` };
  }

  if (effectiveMode === 'full' && riskTier === 'medium' && process.env.ORCH_APPROVED_MEDIUM !== '1') {
    return { allowed: false, reason: 'Missing ORCH_APPROVED_MEDIUM=1 for medium risk execution.' };
  }

  if (effectiveMode === 'full' && riskTier === 'high' && process.env.ORCH_APPROVED_HIGH !== '1') {
    return { allowed: false, reason: 'Missing ORCH_APPROVED_HIGH=1 for high risk execution.' };
  }

  return { allowed: true, reason: null };
}

async function readPlanRecord(rootDir, filePath, phase) {
  const content = await fs.readFile(filePath, 'utf8');
  const metadata = parseMetadata(content);

  const planId = metadataValue(metadata, 'Plan-ID') ?? inferPlanId(content, filePath);
  const status = normalizeStatus(metadataValue(metadata, 'Status'));
  const priority = parsePriority(metadataValue(metadata, 'Priority'));
  const owner = metadataValue(metadata, 'Owner') ?? 'unassigned';
  const dependencies = parseListField(metadataValue(metadata, 'Dependencies'));
  const specTargets = parseListField(metadataValue(metadata, 'Spec-Targets'));
  const doneEvidence = parseListField(metadataValue(metadata, 'Done-Evidence'));

  return {
    planId,
    phase,
    filePath,
    rel: toPosix(path.relative(rootDir, filePath)),
    title: (content.match(/^#\s+(.+)$/m)?.[1] ?? planId).trim(),
    content,
    metadata,
    status,
    priority,
    owner,
    dependencies,
    specTargets,
    doneEvidence,
    autonomyAllowed: metadataValue(metadata, 'Autonomy-Allowed') ?? 'both',
    riskTier: metadataValue(metadata, 'Risk-Tier') ?? 'low',
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
      'Risk-Tier': metadataValue(future.metadata, 'Risk-Tier') ?? 'low',
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

function executablePlans(activePlans, completedPlanIds, excludedPlanIds = new Set()) {
  return activePlans
    .filter((plan) => ACTIVE_STATUSES.has(plan.status))
    .filter((plan) => plan.status !== 'failed' && plan.status !== 'blocked' && plan.status !== 'completed')
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

async function setPlanStatus(planPath, status, dryRun) {
  if (dryRun) return;

  const content = await fs.readFile(planPath, 'utf8');
  const updated = setMetadataFields(content, { Status: status });
  await fs.writeFile(planPath, updated, 'utf8');
}

function replaceExecutorTokens(command, plan, session, runId, mode, resultPath) {
  return command
    .replaceAll('{plan_id}', plan.planId)
    .replaceAll('{plan_file}', plan.rel)
    .replaceAll('{run_id}', runId)
    .replaceAll('{mode}', mode)
    .replaceAll('{session}', String(session))
    .replaceAll('{result_path}', resultPath);
}

async function executePlanSession(plan, paths, state, options, config, sessionNumber) {
  const runSessionDir = path.join(paths.runtimeDir, state.runId);
  const resultPathAbs = path.join(runSessionDir, `${plan.planId}-session-${sessionNumber}.result.json`);
  const resultPathRel = toPosix(path.relative(paths.rootDir, resultPathAbs));

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

  const renderedCommand = replaceExecutorTokens(
    configuredExecutor,
    plan,
    sessionNumber,
    state.runId,
    state.effectiveMode,
    resultPathRel
  );

  await logEvent(paths, state, 'session_started', {
    planId: plan.planId,
    session: sessionNumber,
    command: renderedCommand
  }, options.dryRun);

  if (options.dryRun) {
    return {
      status: 'completed',
      summary: 'Dry-run: executor skipped.',
      resultPayloadFound: true
    };
  }

  const env = {
    ...process.env,
    ORCH_RUN_ID: state.runId,
    ORCH_PLAN_ID: plan.planId,
    ORCH_PLAN_FILE: plan.rel,
    ORCH_SESSION: String(sessionNumber),
    ORCH_MODE: state.effectiveMode,
    ORCH_RESULT_PATH: resultPathRel,
    ORCH_CONTEXT_THRESHOLD: String(options.contextThreshold),
    ORCH_HANDOFF_TOKEN_BUDGET: String(options.handoffTokenBudget)
  };

  const execution = runShell(renderedCommand, paths.rootDir, env);
  const handoffExitCode = asInteger(options.handoffExitCode, asInteger(config.executor.handoffExitCode, DEFAULT_HANDOFF_EXIT_CODE));

  if (execution.signal) {
    return {
      status: 'failed',
      reason: `Executor terminated by signal ${execution.signal}`
    };
  }

  if (execution.status === handoffExitCode) {
    return {
      status: 'handoff_required',
      reason: `Executor exited with handoff code ${handoffExitCode}`
    };
  }

  if (execution.status !== 0) {
    return {
      status: 'failed',
      reason: `Executor exited with status ${execution.status}`
    };
  }

  const resultPayload = await readJsonIfExists(resultPathAbs, null);
  if (!resultPayload) {
    return {
      status: 'completed',
      summary: 'Executor completed without result payload.',
      resultPayloadFound: false
    };
  }

  const reportedStatus = String(resultPayload.status ?? 'completed').trim().toLowerCase();
  const normalizedStatus =
    reportedStatus === 'handoff_required' || reportedStatus === 'blocked' || reportedStatus === 'failed'
      ? reportedStatus
      : 'completed';

  if (
    typeof resultPayload.contextRemaining === 'number' &&
    Number.isFinite(resultPayload.contextRemaining) &&
    resultPayload.contextRemaining < options.contextThreshold
  ) {
    return {
      status: 'handoff_required',
      reason: `contextRemaining (${resultPayload.contextRemaining}) below threshold (${options.contextThreshold})`,
      summary: resultPayload.summary ?? ''
    };
  }

  return {
    status: normalizedStatus,
    reason: resultPayload.reason ?? null,
    summary: resultPayload.summary ?? null,
    contextRemaining: resultPayload.contextRemaining ?? null,
    resultPayloadFound: true
  };
}

function upsertSection(content, sectionTitle, bodyLines) {
  const sectionRegex = new RegExp(`^##\\s+${escapeRegex(sectionTitle)}\\s*$([\\s\\S]*?)(?=^##\\s+|\\s*$)`, 'm');
  const body = Array.isArray(bodyLines) ? bodyLines.join('\n') : String(bodyLines ?? '');
  const rendered = `## ${sectionTitle}\n\n${body.trim()}\n\n`;

  if (sectionRegex.test(content)) {
    return content.replace(sectionRegex, rendered);
  }

  return `${content.trimEnd()}\n\n${rendered}`;
}

function appendToDeliveryLog(content, entryLine) {
  const sectionTitle = 'Automated Delivery Log';
  const sectionRegex = new RegExp(`^##\\s+${escapeRegex(sectionTitle)}\\s*$([\\s\\S]*?)(?=^##\\s+|\\s*$)`, 'm');

  if (!sectionRegex.test(content)) {
    return `${content.trimEnd()}\n\n## ${sectionTitle}\n\n- ${entryLine}\n`;
  }

  return content.replace(sectionRegex, (_match, body = '') => {
    const trimmedBody = String(body ?? '').trim();
    const lines = trimmedBody ? trimmedBody.split(/\r?\n/) : [];
    lines.push(`- ${entryLine}`);
    return `## ${sectionTitle}\n\n${lines.join('\n')}\n\n`;
  });
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

async function runValidationCommands(paths, commands, options, label) {
  if (commands.length === 0) {
    return {
      ok: true,
      evidence: [`No ${label} commands configured.`]
    };
  }

  const evidence = [];
  for (const command of commands) {
    if (options.dryRun) {
      evidence.push(`Dry-run: ${label} command skipped: ${command}`);
      continue;
    }

    const result = runShell(command, paths.rootDir);
    if (result.status !== 0) {
      return {
        ok: false,
        failedCommand: command,
        evidence
      };
    }
    evidence.push(`${label} passed: ${command}`);
  }

  return {
    ok: true,
    evidence
  };
}

async function runAlwaysValidation(paths, options, config) {
  const commands = resolveAlwaysValidationCommands(paths.rootDir, options, config);
  return runValidationCommands(paths, commands, options, 'Validation');
}

function hostProviderResultPath(paths, state, planId, provider) {
  const baseDir = path.join(paths.runtimeDir, state.runId, 'host-validation');
  const fileName = `${planId}-${provider}.result.json`;
  return {
    abs: path.join(baseDir, fileName),
    rel: toPosix(path.relative(paths.rootDir, path.join(baseDir, fileName)))
  };
}

async function executeHostProviderCommand(provider, command, commands, paths, state, plan, options) {
  const resultPaths = hostProviderResultPath(paths, state, plan.planId, provider);
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

  const execution = runShell(command, paths.rootDir, env);
  const payload = await readJsonIfExists(resultPaths.abs, null);
  if (payload && typeof payload === 'object') {
    const reported = String(payload.status ?? '').trim().toLowerCase();
    if (reported === 'passed' || reported === 'failed' || reported === 'pending') {
      return {
        status: reported,
        provider,
        reason: payload.reason ?? null,
        evidence: Array.isArray(payload.evidence)
          ? payload.evidence.map((entry) => String(entry))
          : [`Host validation (${provider}) result payload loaded from ${resultPaths.rel}`]
      };
    }
  }

  if (execution.signal) {
    return {
      status: 'unavailable',
      provider,
      reason: `Host validation provider '${provider}' terminated by signal ${execution.signal}`
    };
  }

  if (execution.status === 0) {
    return {
      status: 'passed',
      provider,
      evidence: [`Host validation passed via ${provider} command: ${command}`]
    };
  }

  return {
    status: 'unavailable',
    provider,
    reason: `Host validation provider '${provider}' command exited with status ${execution.status}`
  };
}

async function runHostValidation(paths, state, plan, options, config) {
  const commands = resolveHostRequiredValidationCommands(config);
  if (commands.length === 0) {
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

    const result = await runValidationCommands(paths, commands, options, 'Host validation');
    if (!result.ok) {
      return {
        status: 'failed',
        provider: 'local',
        reason: `Host validation failed: ${result.failedCommand}`,
        evidence: result.evidence
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
      evidence: ciResult.evidence ?? []
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
      evidence: localResult.evidence ?? []
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
    evidence: [...(ciResult.evidence ?? []), ...(localResult.evidence ?? [])]
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

async function writeEvidenceIndex(paths, plan, content, options, config) {
  const mode = String(config.evidence?.compaction?.mode ?? 'compact-index').trim().toLowerCase();
  if (mode !== 'compact-index') {
    return null;
  }

  const maxReferences = asInteger(config.evidence?.compaction?.maxReferences, DEFAULT_EVIDENCE_MAX_REFERENCES);
  const { selected, totalFound } = await collectEvidenceReferences(paths, plan.rel, content, maxReferences);
  const indexRel = toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, `${plan.planId}.md`)));
  const indexAbs = path.join(paths.rootDir, indexRel);

  const lines = [
    `# Evidence Index: ${plan.planId}`,
    '',
    `- Plan-ID: ${plan.planId}`,
    `- Last Updated: ${nowIso()}`,
    `- Source Plan: \`${plan.rel}\``,
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
  lines.push('- Superseded rerun artifacts remain in place for auditability unless pruned manually.');
  lines.push('');

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(indexAbs), { recursive: true });
    await fs.writeFile(indexAbs, lines.join('\n'), 'utf8');
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
  const updated = upsertSection(content, 'Host Validation', lines);
  await fs.writeFile(planPath, updated, 'utf8');
}

function gitAvailable(rootDir) {
  const result = runShellCapture('git rev-parse --is-inside-work-tree', rootDir);
  return result.status === 0;
}

function parseGitPorcelainPaths(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines.map((line) => {
    const payload = line.slice(3).trim();
    const renameMatch = payload.match(/^(.*)\s->\s(.*)$/);
    const pathValue = renameMatch ? renameMatch[2] : payload;
    return toPosix(pathValue.replace(/^"|"$/g, ''));
  });
}

function isTransientAutomationPath(pathValue) {
  if (TRANSIENT_AUTOMATION_FILES.has(pathValue)) {
    return true;
  }
  return TRANSIENT_AUTOMATION_DIR_PREFIXES.some((prefix) => pathValue.startsWith(prefix));
}

function gitDirty(rootDir, options = {}) {
  const ignoreTransientAutomationArtifacts = asBoolean(options.ignoreTransientAutomationArtifacts, false);
  const result = runShellCapture('git status --porcelain', rootDir);
  if (result.status !== 0) {
    return false;
  }
  const dirtyPaths = parseGitPorcelainPaths(result.stdout);
  if (!ignoreTransientAutomationArtifacts) {
    return dirtyPaths.length > 0;
  }
  return dirtyPaths.some((pathValue) => !isTransientAutomationPath(pathValue));
}

function createAtomicCommit(rootDir, planId, dryRun) {
  if (dryRun) {
    return { ok: true, committed: false, commitHash: null, reason: 'dry-run' };
  }

  if (!gitAvailable(rootDir)) {
    return { ok: true, committed: false, commitHash: null, reason: 'git-unavailable' };
  }

  if (!gitDirty(rootDir)) {
    return { ok: true, committed: false, commitHash: null, reason: 'no-changes' };
  }

  const add = runShellCapture('git add -A', rootDir);
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

async function finalizeCompletedPlan(plan, paths, state, validationEvidence, options, config, completionInfo = {}) {
  const now = nowIso();
  const completedDate = isoDate(now);
  const raw = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, raw, options, config);
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

  const currentBase = path.parse(path.basename(plan.filePath));
  const completedName = datedPlanFileName(completedDate, currentBase.name, currentBase.ext || '.md');
  let targetPath = path.join(paths.completedDir, completedName);
  if (await exists(targetPath)) {
    const parsed = path.parse(completedName);
    targetPath = path.join(paths.completedDir, `${parsed.name}-${Date.now()}${parsed.ext || '.md'}`);
  }

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
    const targetPath = path.join(paths.rootDir, target);
    if (!(await exists(targetPath))) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target,
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

    if (toPosix(path.relative(paths.rootDir, targetPath)) === 'docs/product-specs/current-state.md') {
      content = updateSimpleMetadataField(content, 'Last Updated', dateStamp);
      content = updateSimpleMetadataField(content, 'Current State Date', dateStamp);
    }

    await fs.writeFile(targetPath, content, 'utf8');
  }
}

async function writeHandoff(paths, state, plan, sessionNumber, reason, summary, options) {
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
    '- Continue remaining acceptance criteria steps.',
    '- Re-run required validations before completion.',
    ''
  ].join('\n');

  await fs.writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function processPlan(plan, paths, state, options, config) {
  const gate = evaluatePolicyGate(plan, state.effectiveMode);
  if (!gate.allowed) {
    await setPlanStatus(plan.filePath, 'blocked', options.dryRun);
    await logEvent(paths, state, 'plan_blocked', {
      planId: plan.planId,
      reason: gate.reason
    }, options.dryRun);

    return {
      outcome: 'blocked',
      reason: gate.reason
    };
  }

  await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);

  const maxRollovers = asInteger(options.maxRollovers, DEFAULT_MAX_ROLLOVERS);
  const maxSessionsPerPlan = asInteger(options.maxSessionsPerPlan, DEFAULT_MAX_SESSIONS_PER_PLAN);
  const planStartedAt = nowIso();
  let rollovers = 0;

  for (let session = 1; session <= maxSessionsPerPlan; session += 1) {
    state.inProgress = {
      planId: plan.planId,
      session,
      planFile: plan.rel,
      startedAt: nowIso()
    };

    await saveState(paths, state, options.dryRun);

    const sessionResult = await executePlanSession(plan, paths, state, options, config, session);
    await logEvent(paths, state, 'session_finished', {
      planId: plan.planId,
      session,
      status: sessionResult.status,
      reason: sessionResult.reason ?? null,
      summary: sessionResult.summary ?? null
    }, options.dryRun);
    await refreshEvidenceIndex(plan, paths, state, options, config);

    if (sessionResult.status === 'handoff_required') {
      const handoffPath = await writeHandoff(
        paths,
        state,
        plan,
        session,
        sessionResult.reason,
        sessionResult.summary,
        options
      );
      state.stats.handoffs += 1;
      await logEvent(paths, state, 'handoff_created', {
        planId: plan.planId,
        session,
        handoffPath: toPosix(path.relative(paths.rootDir, handoffPath)),
        reason: sessionResult.reason ?? 'executor-requested'
      }, options.dryRun);

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
      await setPlanStatus(plan.filePath, 'blocked', options.dryRun);
      return {
        outcome: 'blocked',
        reason: sessionResult.reason ?? 'executor blocked'
      };
    }

    if (sessionResult.status === 'failed') {
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      return {
        outcome: 'failed',
        reason: sessionResult.reason ?? 'executor failed'
      };
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
          reason: 'Executor produced no structured result payload. Deferring to next run to prevent repeated no-signal loops.'
        };
      }

      if (session >= maxSessionsPerPlan) {
        return {
          outcome: 'pending',
          reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}). ${completionGate.reason}`
        };
      }

      await logEvent(paths, state, 'session_continued', {
        planId: plan.planId,
        session,
        nextSession: session + 1,
        reason: completionGate.reason
      }, options.dryRun);

      continue;
    }

    await setPlanStatus(plan.filePath, 'validation', options.dryRun);

    const alwaysValidation = await runAlwaysValidation(paths, options, config);
    if (!alwaysValidation.ok) {
      state.stats.validationFailures += 1;
      updatePlanValidationState(state, plan.planId, {
        always: 'failed',
        reason: `Validation failed: ${alwaysValidation.failedCommand}`
      });
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      await logEvent(paths, state, 'validation_failed', {
        planId: plan.planId,
        command: alwaysValidation.failedCommand
      }, options.dryRun);

      return {
        outcome: 'failed',
        reason: `Validation failed: ${alwaysValidation.failedCommand}`
      };
    }

    updatePlanValidationState(state, plan.planId, {
      always: 'passed',
      reason: null
    });

    await logEvent(paths, state, 'host_validation_requested', {
      planId: plan.planId,
      mode: resolveHostValidationMode(config),
      commands: resolveHostRequiredValidationCommands(config)
    }, options.dryRun);

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
        reason: hostValidation.reason ?? 'Host validation failed.'
      }, options.dryRun);

      return {
        outcome: 'failed',
        reason: hostValidation.reason ?? 'Host validation failed.'
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
        reason: hostValidation.reason ?? 'Host validation pending.'
      }, options.dryRun);

      return {
        outcome: 'pending',
        reason: hostValidation.reason ?? 'Host validation pending.'
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

    const mergedValidationEvidence = [
      ...alwaysValidation.evidence,
      ...(Array.isArray(hostValidation.evidence) ? hostValidation.evidence : [])
    ];

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
        hostValidationProvider: hostValidation.provider ?? 'none'
      }
    );

    await updateProductSpecs(plan, completedPath, paths, state, options);

    let commitResult = { ok: true, committed: false, commitHash: null };
    if (asBoolean(options.commit, config.git.atomicCommits !== false)) {
      commitResult = createAtomicCommit(paths.rootDir, plan.planId, options.dryRun);
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
      completedPath: toPosix(path.relative(paths.rootDir, completedPath)),
      commitHash: commitResult.commitHash,
      validationEvidence: mergedValidationEvidence
    };
  }

  return {
    outcome: 'pending',
    reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}).`
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

async function runLoop(paths, state, options, config, runMode) {
  let processed = 0;
  const maxPlans = asInteger(options.maxPlans, Number.MAX_SAFE_INTEGER);
  const deferredPlanIds = new Set();
  const dependencyWaitCache = new Map();

  while (processed < maxPlans) {
    const catalog = await collectPlanCatalog(paths);
    const completedIds = new Set([
      ...state.completedPlanIds,
      ...catalog.completed.map((plan) => plan.planId)
    ]);

    const failedOrBlockedIds = new Set([
      ...state.failedPlanIds,
      ...state.blockedPlanIds,
      ...deferredPlanIds
    ]);
    const executable = executablePlans(catalog.active, completedIds, failedOrBlockedIds);
    const blockedByDependency = blockedPlans(catalog.active, completedIds, failedOrBlockedIds);

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
      break;
    }

    const nextPlan = executable[0];
    await logEvent(paths, state, 'plan_started', {
      planId: nextPlan.planId,
      planFile: nextPlan.rel,
      runMode
    }, options.dryRun);

    const outcome = await processPlan(nextPlan, paths, state, options, config);
    state.inProgress = null;

    if (outcome.outcome === 'completed') {
      if (!state.completedPlanIds.includes(nextPlan.planId)) {
        state.completedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_completed', {
        planId: nextPlan.planId,
        completedPath: outcome.completedPath,
        commitHash: outcome.commitHash ?? null
      }, options.dryRun);
    } else if (outcome.outcome === 'blocked') {
      if (!state.blockedPlanIds.includes(nextPlan.planId)) {
        state.blockedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_blocked', {
        planId: nextPlan.planId,
        reason: outcome.reason
      }, options.dryRun);
    } else if (outcome.outcome === 'pending') {
      deferredPlanIds.add(nextPlan.planId);
      await logEvent(paths, state, 'plan_pending', {
        planId: nextPlan.planId,
        reason: outcome.reason
      }, options.dryRun);
    } else {
      if (!state.failedPlanIds.includes(nextPlan.planId)) {
        state.failedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_failed', {
        planId: nextPlan.planId,
        reason: outcome.reason
      }, options.dryRun);
    }

    await saveState(paths, state, options.dryRun);
    processed += 1;
  }

  return processed;
}

async function runCommand(paths, options) {
  const config = await loadConfig(paths);
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

  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);
  await saveState(paths, state, options.dryRun);

  try {
    await logEvent(paths, state, 'run_started', {
      requestedMode: modeResolution.requestedMode,
      effectiveMode: modeResolution.effectiveMode,
      downgraded: modeResolution.downgraded,
      downgradeReason: modeResolution.reason,
      capabilities: state.capabilities
    }, options.dryRun);

    if (modeResolution.downgraded) {
      console.log(`[orchestrator] full mode downgraded to guarded: ${modeResolution.reason}`);
    }

    let processed = await runLoop(paths, state, options, config, 'run');

    if (!asBoolean(options.skipPromotion, false)) {
      const promoted = await promoteFuturePlans(paths, state, options);
      if (promoted > 0) {
        console.log(`[orchestrator] promoted ${promoted} future plan(s) into docs/exec-plans/active.`);
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

    console.log(`[orchestrator] run complete (${processed} processed).`);
    console.log(`- runId: ${state.runId}`);
    console.log(`- completed: ${state.completedPlanIds.length}`);
    console.log(`- blocked: ${state.blockedPlanIds.length}`);
    console.log(`- failed: ${state.failedPlanIds.length}`);
    console.log(`- duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
  } finally {
    await releaseRunLock(paths, options);
  }
}

async function resumeCommand(paths, options) {
  const config = await loadConfig(paths);
  const persisted = await readJsonIfExists(paths.runStatePath, null);

  if (!persisted || !persisted.runId) {
    throw new Error('No existing run-state found. Start with `run` first.');
  }

  if (options.runId && options.runId !== persisted.runId) {
    throw new Error(`Requested run-id '${options.runId}' does not match persisted run '${persisted.runId}'.`);
  }

  const state = normalizePersistedState(persisted);
  state.capabilities = await detectCapabilities();
  assertExecutorConfigured(options, config);
  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);

  try {
    await logEvent(paths, state, 'run_resumed', {
      requestedMode: options.mode ?? state.requestedMode,
      effectiveMode: state.effectiveMode,
      capabilities: state.capabilities
    }, options.dryRun);

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

    console.log(`[orchestrator] resume complete (${processed} processed).`);
    console.log(`- runId: ${state.runId}`);
    console.log(`- completed: ${state.completedPlanIds.length}`);
    console.log(`- blocked: ${state.blockedPlanIds.length}`);
    console.log(`- failed: ${state.failedPlanIds.length}`);
    console.log(`- duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
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
    contextThreshold: asInteger(rawOptions['context-threshold'] ?? rawOptions.contextThreshold, DEFAULT_CONTEXT_THRESHOLD),
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
    handoffExitCode: asInteger(rawOptions['handoff-exit-code'] ?? rawOptions.handoffExitCode, DEFAULT_HANDOFF_EXIT_CODE)
  };

  const rootDir = process.cwd();
  const paths = buildPaths(rootDir);

  if (command === 'run') {
    await runCommand(paths, options);
    return;
  }

  if (command === 'resume') {
    await resumeCommand(paths, options);
    return;
  }

  if (command === 'audit') {
    await auditCommand(paths, options);
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
