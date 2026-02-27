#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
const DEFAULT_HANDOFF_EXIT_CODE = 75;

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

function randomRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${random}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    productStatePath: path.join(docsDir, 'product-specs', 'current-state.md'),
    opsAutomationDir,
    handoffDir: path.join(opsAutomationDir, 'handoffs'),
    runtimeDir: path.join(opsAutomationDir, 'runtime'),
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

async function loadConfig(paths) {
  const defaultConfig = {
    executor: {
      command: '',
      handoffExitCode: DEFAULT_HANDOFF_EXIT_CODE
    },
    validationCommands: [],
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
    git: {
      ...defaultConfig.git,
      ...(configured.git ?? {})
    }
  };
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
    inProgress: null,
    stats: {
      promotions: 0,
      handoffs: 0,
      validationFailures: 0,
      commits: 0
    }
  };
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

    const targetName = `${future.planId}.md`;
    let targetPath = path.join(paths.activeDir, targetName);

    if (await exists(targetPath)) {
      targetPath = path.join(paths.activeDir, `${future.planId}-${Date.now()}.md`);
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

      const updatedFuture = setMetadataFields(future.content, {
        Status: 'promoted',
        'Promoted-Plan': toPosix(path.relative(paths.rootDir, targetPath))
      });
      await fs.writeFile(future.filePath, updatedFuture, 'utf8');
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
      summary: 'Dry-run: executor skipped.'
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
      summary: 'Executor completed without result payload.'
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
    contextRemaining: resultPayload.contextRemaining ?? null
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

async function runValidation(paths, options, config) {
  const explicit = typeof options.validationCommands === 'string' && options.validationCommands.trim().length > 0
    ? options.validationCommands.split(';;').map((value) => value.trim()).filter(Boolean)
    : null;

  const commands = explicit ?? resolveDefaultValidationCommands(paths.rootDir, config.validationCommands);
  if (commands.length === 0) {
    return {
      ok: true,
      evidence: ['No validation commands configured.']
    };
  }

  const evidence = [];
  for (const command of commands) {
    const result = runShell(command, paths.rootDir);
    if (result.status !== 0) {
      return {
        ok: false,
        failedCommand: command,
        evidence
      };
    }
    evidence.push(`Validation passed: ${command}`);
  }

  return {
    ok: true,
    evidence
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

function gitAvailable(rootDir) {
  const result = runShellCapture('git rev-parse --is-inside-work-tree', rootDir);
  return result.status === 0;
}

function gitDirty(rootDir) {
  const result = runShellCapture('git status --porcelain', rootDir);
  if (result.status !== 0) {
    return false;
  }
  return String(result.stdout ?? '').trim().length > 0;
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

async function finalizeCompletedPlan(plan, paths, state, validationEvidence, options) {
  const now = nowIso();
  const raw = await fs.readFile(plan.filePath, 'utf8');
  const updatedMetadata = setMetadataFields(raw, {
    Status: 'completed',
    'Done-Evidence': validationEvidence.length > 0 ? validationEvidence.join(', ') : 'none'
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

  let finalContent = upsertSection(updatedMetadata, 'Validation Evidence', validationLines);
  finalContent = upsertSection(finalContent, 'Closure', closureLines);

  let targetPath = path.join(paths.completedDir, path.basename(plan.filePath));
  if (targetPath === plan.filePath || (await exists(targetPath))) {
    const parsed = path.parse(path.basename(plan.filePath));
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
  for (let session = 1; session <= maxRollovers + 1; session += 1) {
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

      if (session > maxRollovers) {
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

    await setPlanStatus(plan.filePath, 'validation', options.dryRun);

    const validationResult = await runValidation(paths, options, config);
    if (!validationResult.ok) {
      state.stats.validationFailures += 1;
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      await logEvent(paths, state, 'validation_failed', {
        planId: plan.planId,
        command: validationResult.failedCommand
      }, options.dryRun);

      return {
        outcome: 'failed',
        reason: `Validation failed: ${validationResult.failedCommand}`
      };
    }

    const completionGate = await evaluateCompletionGate(plan.filePath);
    if (!completionGate.ready) {
      await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);
      return {
        outcome: 'pending',
        reason: completionGate.reason
      };
    }

    const completedPath = await finalizeCompletedPlan(
      plan,
      paths,
      state,
      validationResult.evidence,
      options
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
      validationEvidence: validationResult.evidence
    };
  }

  await setPlanStatus(plan.filePath, 'failed', options.dryRun);
  return {
    outcome: 'failed',
    reason: 'Exceeded session loop unexpectedly.'
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
      await logEvent(paths, state, 'plan_waiting_dependency', {
        planId: blocked.planId,
        missingDependencies: blocked.dependencies.filter((dependency) => !completedIds.has(dependency))
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

  if (!asBoolean(options.allowDirty, false) && gitAvailable(paths.rootDir) && gitDirty(paths.rootDir)) {
    throw new Error('Refusing to start with a dirty git worktree. Use --allow-dirty true to override.');
  }

  assertExecutorConfigured(options, config);

  await ensureDirectories(paths, options.dryRun);
  await saveState(paths, state, options.dryRun);

  await logEvent(paths, state, 'run_started', {
    requestedMode: modeResolution.requestedMode,
    effectiveMode: modeResolution.effectiveMode,
    downgraded: modeResolution.downgraded,
    downgradeReason: modeResolution.reason
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

  await logEvent(paths, state, 'run_finished', {
    processedPlans: processed,
    completedPlans: state.completedPlanIds.length,
    blockedPlans: state.blockedPlanIds.length,
    failedPlans: state.failedPlanIds.length,
    promotions: state.stats.promotions,
    handoffs: state.stats.handoffs,
    commits: state.stats.commits,
    validationFailures: state.stats.validationFailures
  }, options.dryRun);

  await saveState(paths, state, options.dryRun);

  console.log(`[orchestrator] run complete (${processed} processed).`);
  console.log(`- runId: ${state.runId}`);
  console.log(`- completed: ${state.completedPlanIds.length}`);
  console.log(`- blocked: ${state.blockedPlanIds.length}`);
  console.log(`- failed: ${state.failedPlanIds.length}`);
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

  const state = persisted;
  assertExecutorConfigured(options, config);
  await ensureDirectories(paths, options.dryRun);

  await logEvent(paths, state, 'run_resumed', {
    requestedMode: options.mode ?? state.requestedMode,
    effectiveMode: state.effectiveMode
  }, options.dryRun);

  const processed = await runLoop(paths, state, options, config, 'resume');

  await logEvent(paths, state, 'run_finished', {
    processedPlans: processed,
    completedPlans: state.completedPlanIds.length,
    blockedPlans: state.blockedPlanIds.length,
    failedPlans: state.failedPlanIds.length,
    promotions: state.stats?.promotions ?? 0,
    handoffs: state.stats?.handoffs ?? 0,
    commits: state.stats?.commits ?? 0,
    validationFailures: state.stats?.validationFailures ?? 0
  }, options.dryRun);

  await saveState(paths, state, options.dryRun);

  console.log(`[orchestrator] resume complete (${processed} processed).`);
  console.log(`- runId: ${state.runId}`);
  console.log(`- completed: ${state.completedPlanIds.length}`);
  console.log(`- blocked: ${state.blockedPlanIds.length}`);
  console.log(`- failed: ${state.failedPlanIds.length}`);
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
