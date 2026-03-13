#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_STATUSES,
  inferPlanId,
  metadataValue,
  normalizeStatus,
  parseListField,
  parseMetadata,
  parsePlanId
} from './lib/plan-metadata.mjs';

const requestedCommand = String(process.argv[2] ?? 'run').trim().toLowerCase();
const passthroughArgs = process.argv.slice(3);

const firstCommand = requestedCommand === 'resume' || requestedCommand === 'resume-parallel'
  ? requestedCommand
  : requestedCommand === 'run-parallel'
    ? 'run-parallel'
    : 'run';

const resumeCommand = firstCommand.includes('parallel') ? 'resume-parallel' : 'resume';

const maxCycles = Number.parseInt(process.env.ORCH_SUPERVISOR_MAX_CYCLES ?? '120', 10);
const stableLimit = Number.parseInt(process.env.ORCH_SUPERVISOR_STABLE_LIMIT ?? '4', 10);
const maxConsecutiveErrors = Number.parseInt(process.env.ORCH_SUPERVISOR_MAX_CONSECUTIVE_ERRORS ?? '2', 10);
const continueOnError = String(process.env.ORCH_SUPERVISOR_CONTINUE_ON_ERROR ?? '1').trim() !== '0';
const allowDirtyRecovery = String(process.env.ORCH_SUPERVISOR_ALLOW_DIRTY_RECOVERY ?? '0').trim() === '1';
const enforceBudgetGuards = String(process.env.ORCH_SUPERVISOR_ENFORCE_BUDGET_GUARDS ?? '1').trim() !== '0';
const stopOnSessionBudgetExhaustion =
  String(process.env.ORCH_SUPERVISOR_STOP_ON_SESSION_BUDGET_EXHAUSTION ?? '0').trim() !== '0';
const guardedMaxSessionsPerPlan = Number.parseInt(process.env.ORCH_SUPERVISOR_MAX_SESSIONS_PER_PLAN ?? '12', 10);
const guardedWorkerPendingStreakLimit = Number.parseInt(
  process.env.ORCH_SUPERVISOR_WORKER_PENDING_STREAK_LIMIT ?? '6',
  10
);

const rootDir = process.cwd();
const runStatePath = path.join(rootDir, 'docs/ops/automation/run-state.json');
const runEventsPath = path.join(rootDir, 'docs/ops/automation/run-events.jsonl');
const activePlansDir = path.join(rootDir, 'docs/exec-plans/active');
const TRANSIENT_AUTOMATION_FILES = new Set([
  'docs/ops/automation/run-state.json',
  'docs/ops/automation/run-events.jsonl'
]);
const TRANSIENT_AUTOMATION_DIR_PREFIXES = [
  'docs/ops/automation/runtime/',
  'docs/ops/automation/handoffs/'
];

let stableCycles = 0;
let consecutiveErrors = 0;
let previousSignature = '';
let dirtyRecoveryMode = false;

function normalizePathValue(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function isTransientAutomationPath(relPath) {
  const normalized = normalizePathValue(relPath);
  if (!normalized) {
    return false;
  }
  if (TRANSIENT_AUTOMATION_FILES.has(normalized)) {
    return true;
  }
  return TRANSIENT_AUTOMATION_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function hasCliOption(optionName) {
  return passthroughArgs.some((arg) => arg === optionName || arg.startsWith(`${optionName}=`));
}

function appendDefaultOption(args, optionName, rawValue) {
  if (hasCliOption(optionName)) {
    return;
  }
  const value = Number.parseInt(String(rawValue ?? ''), 10);
  if (Number.isFinite(value) && value > 0) {
    args.push(optionName, String(value));
  }
}

function withOrchestratorArgs(command) {
  const base = ['./scripts/automation/orchestrator.mjs', command, ...passthroughArgs];
  if (dirtyRecoveryMode) {
    base.push('--allow-dirty', 'true', '--commit', 'false');
  }
  if (enforceBudgetGuards) {
    appendDefaultOption(base, '--max-sessions-per-plan', guardedMaxSessionsPerPlan);
    appendDefaultOption(base, '--worker-pending-streak-limit', guardedWorkerPendingStreakLimit);
  }
  return base;
}

function runOrchestrator(command) {
  const args = withOrchestratorArgs(command);
  console.log(`[supervisor] cycle command=${command}${dirtyRecoveryMode ? ' (dirty-recovery non-atomic)' : ''}`);
  const result = spawnSync('node', args, {
    env: process.env,
    stdio: 'inherit'
  });
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    console.error(`[supervisor] orchestrator exited with code ${exitCode}`);
  }
  return exitCode;
}

function readRunState() {
  if (!existsSync(runStatePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(runStatePath, 'utf8'));
  } catch (error) {
    console.error(
      `[supervisor] failed to parse ${runStatePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

function readActivePlanRecords() {
  if (!existsSync(activePlansDir)) {
    return [];
  }

  const records = [];
  for (const fileName of readdirSync(activePlansDir)) {
    if (!fileName.endsWith('.md') || fileName === 'README.md') {
      continue;
    }
    const filePath = path.join(activePlansDir, fileName);
    const content = readFileSync(filePath, 'utf8');
    const metadata = parseMetadata(content);
    const status = normalizeStatus(metadataValue(metadata, 'Status'));
    const validationReady = normalizeStatus(metadataValue(metadata, 'Validation-Ready'));
    const explicitPlanId = metadataValue(metadata, 'Plan-ID');
    const planId = parsePlanId(explicitPlanId, null) ?? inferPlanId(content, filePath);
    if (!planId) {
      continue;
    }

    const dependencies = parseListField(metadataValue(metadata, 'Dependencies'))
      .map((entry) => parsePlanId(entry, null))
      .filter(Boolean);

    records.push({ planId, status, validationReady, dependencies });
  }
  return records;
}

function unresolvedActivePlanIds(state, activePlans) {
  const completed = new Set(Array.isArray(state?.completedPlanIds) ? state.completedPlanIds : []);
  const blocked = new Set(Array.isArray(state?.blockedPlanIds) ? state.blockedPlanIds : []);
  const failed = new Set(Array.isArray(state?.failedPlanIds) ? state.failedPlanIds : []);

  return activePlans
    .filter((plan) => {
      if (!ACTIVE_STATUSES.has(plan.status)) {
        return false;
      }
      // Only treat validation plans as externally gated when readiness is explicit.
      if (plan.status !== 'validation') {
        return true;
      }
      return plan.validationReady !== 'yes' && plan.validationReady !== 'host-required-only';
    })
    .map((plan) => plan.planId)
    .filter((planId) => !completed.has(planId) && !blocked.has(planId) && !failed.has(planId))
    .sort((a, b) => a.localeCompare(b));
}

function queueDrained(state, unresolvedIds) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  return queue.length === 0 && !state?.inProgress && unresolvedIds.length === 0;
}

function stateSignature(state, unresolvedIds) {
  return JSON.stringify({
    queue: Array.isArray(state?.queue) ? state.queue : [],
    blocked: Array.isArray(state?.blockedPlanIds) ? state.blockedPlanIds : [],
    failed: Array.isArray(state?.failedPlanIds) ? state.failedPlanIds : [],
    completedCount: Array.isArray(state?.completedPlanIds) ? state.completedPlanIds.length : 0,
    inProgressPlan: state?.inProgress?.planId ?? null,
    unresolvedActive: unresolvedIds
  });
}

function renderSummary(state, unresolvedIds) {
  const queueCount = Array.isArray(state?.queue) ? state.queue.length : 0;
  const blockedCount = Array.isArray(state?.blockedPlanIds) ? state.blockedPlanIds.length : 0;
  const failedCount = Array.isArray(state?.failedPlanIds) ? state.failedPlanIds.length : 0;
  const inProgressPlan = state?.inProgress?.planId ?? 'none';
  return (
    `queue=${queueCount} blocked=${blockedCount} failed=${failedCount} inProgress=${inProgressPlan} ` +
    `unresolvedActive=${unresolvedIds.length}`
  );
}

function listRepoPaths(args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout ?? '')
    .split('\0')
    .map((entry) => normalizePathValue(entry))
    .filter(Boolean);
}

function worktreeHasNonTransientChanges() {
  const buckets = [
    listRepoPaths(['diff', '--name-only', '-z']),
    listRepoPaths(['diff', '--cached', '--name-only', '-z']),
    listRepoPaths(['ls-files', '--others', '--exclude-standard', '-z'])
  ];
  if (buckets.some((bucket) => bucket == null)) {
    // Fail-safe: if git inspection fails, prefer safe dirty-recovery mode.
    return true;
  }
  return buckets
    .flat()
    .some((entry) => !isTransientAutomationPath(entry));
}

function eventContainsAtomicDeadlockText(event) {
  const haystack = `${event?.type ?? ''} ${JSON.stringify(event?.details ?? {})}`.toLowerCase();
  return (
    haystack.includes('atomic commit preflight failed') ||
    haystack.includes('atomic commit failed') ||
    haystack.includes('atomic commit refused') ||
    haystack.includes('atomic root policy violation') ||
    haystack.includes('paths outside allowed roots') ||
    haystack.includes('refusing --allow-dirty true with --commit true') ||
    haystack.includes('refusing to start with a dirty git worktree') ||
    haystack.includes('refusing to resume with a dirty git worktree') ||
    haystack.includes('refusing parallel execution with dirty git worktree') ||
    haystack.includes('refusing parallel resume with dirty git worktree')
  );
}

function eventContainsSessionBudgetExhaustionText(event) {
  const eventType = String(event?.type ?? '').trim().toLowerCase();
  const haystack = `${eventType} ${JSON.stringify(event?.details ?? {})}`.toLowerCase();
  return (
    eventType === 'session_stage_budget_exceeded' ||
    eventType === 'session_pending_streak_fail_fast' ||
    eventType === 'session_pending_fail_fast' ||
    haystack.includes('maximum sessions reached without completion') ||
    haystack.includes('worker pending streak exceeded') ||
    haystack.includes('repeated pending signal without progress') ||
    haystack.includes('exceeded stage budget') ||
    haystack.includes('without repository edits outside plan/evidence files') ||
    haystack.includes('without touching source/tests files') ||
    haystack.includes('plan/evidence-only updates are insufficient for worker pending') ||
    haystack.includes('same-role pending too many times') ||
    haystack.includes('without resolving the role-scoped objective') ||
    haystack.includes('narrow to one implementation slice and resume')
  );
}

function hasAtomicDeadlockSignalInCurrentRun() {
  if (!existsSync(runEventsPath)) {
    return false;
  }
  const state = readRunState();
  const runId = state?.runId ? String(state.runId) : '';
  try {
    const raw = readFileSync(runEventsPath, 'utf8');
    const window = raw.length > 512_000 ? raw.slice(-512_000) : raw;
    const lines = window.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (runId && String(event?.runId ?? '') !== runId) {
        continue;
      }
      if (eventContainsAtomicDeadlockText(event)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function hasSessionBudgetExhaustionSignalInCurrentRun() {
  if (!existsSync(runEventsPath)) {
    return false;
  }
  const state = readRunState();
  const runId = state?.runId ? String(state.runId) : '';
  try {
    const raw = readFileSync(runEventsPath, 'utf8');
    const window = raw.length > 512_000 ? raw.slice(-512_000) : raw;
    const lines = window.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (runId && String(event?.runId ?? '') !== runId) {
        continue;
      }
      if (eventContainsSessionBudgetExhaustionText(event)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function main() {
  let nextCommand = firstCommand;

  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const command = nextCommand;
    const hadRunStateBefore = existsSync(runStatePath);
    const exitCode = runOrchestrator(command);
    if (exitCode === 0) {
      consecutiveErrors = 0;
    } else {
      if (allowDirtyRecovery && !dirtyRecoveryMode) {
        const dirtyWorktree = worktreeHasNonTransientChanges();
        const startupDirtyDeadlock = command === firstCommand && dirtyWorktree;
        const followupDirtyDeadlock = command !== firstCommand && dirtyWorktree;
        const atomicDeadlockSignal = hasAtomicDeadlockSignalInCurrentRun();
        if (startupDirtyDeadlock || followupDirtyDeadlock || atomicDeadlockSignal) {
          dirtyRecoveryMode = true;
          consecutiveErrors = 0;
          nextCommand = command;
          console.error(
            '[supervisor] enabling dirty recovery mode after orchestrator failure ' +
            '(--allow-dirty true --commit false) because ORCH_SUPERVISOR_ALLOW_DIRTY_RECOVERY=1.'
          );
          continue;
        }
      }
      consecutiveErrors += 1;
      if (!continueOnError || consecutiveErrors > maxConsecutiveErrors) {
        process.exit(exitCode);
      }
    }

    const state = readRunState();
    if (!state) {
      if (command === firstCommand && continueOnError && consecutiveErrors <= maxConsecutiveErrors) {
        console.error(
          '[supervisor] run-state not found after initial run attempt; retrying initial run command.'
        );
        nextCommand = firstCommand;
        continue;
      }
      console.log('[supervisor] run-state not found; stopping.');
      process.exit(exitCode === 0 ? 0 : exitCode);
    }

    nextCommand = resumeCommand;

    const activePlans = readActivePlanRecords();
    const unresolvedIds = unresolvedActivePlanIds(state, activePlans);
    console.log(`[supervisor] state after cycle ${cycle + 1}: ${renderSummary(state, unresolvedIds)}`);

    if (allowDirtyRecovery && !dirtyRecoveryMode && unresolvedIds.length > 0 && worktreeHasNonTransientChanges()) {
      dirtyRecoveryMode = true;
      console.error(
        '[supervisor] enabling dirty recovery mode for follow-up cycles ' +
        '(--allow-dirty true --commit false) because unresolved work remains on a dirty workspace.'
      );
    }

    if (queueDrained(state, unresolvedIds)) {
      console.log('[supervisor] queue drained; done.');
      process.exit(0);
    }

    if (
      stopOnSessionBudgetExhaustion &&
      unresolvedIds.length > 0 &&
      hasSessionBudgetExhaustionSignalInCurrentRun()
    ) {
      console.error(
        '[supervisor] stopping auto-resume to protect token budget: detected repeated pending/session-budget ' +
        'exhaustion in this run. Narrow to one implementation slice, then resume manually with ' +
        '--max-plans 1 --allow-dirty true --commit false.'
      );
      process.exit(2);
    }

    const signature = stateSignature(state, unresolvedIds);
    if (signature === previousSignature) {
      stableCycles += 1;
    } else {
      stableCycles = 0;
    }
    previousSignature = signature;

    if (stableCycles >= stableLimit) {
      console.error(
        `[supervisor] no queue progress for ${stableCycles + 1} consecutive cycles. ` +
        'Stopping for manual review.'
      );
      process.exit(2);
    }
  }

  console.error(`[supervisor] reached ORCH_SUPERVISOR_MAX_CYCLES=${maxCycles}. Stopping.`);
  process.exit(2);
}

main();
