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

const rootDir = process.cwd();
const runStatePath = path.join(rootDir, 'docs/ops/automation/run-state.json');
const activePlansDir = path.join(rootDir, 'docs/exec-plans/active');

let stableCycles = 0;
let consecutiveErrors = 0;
let previousSignature = '';
let dirtyRecoveryMode = false;

function withOrchestratorArgs(command) {
  const base = ['./scripts/automation/orchestrator.mjs', command, ...passthroughArgs];
  if (dirtyRecoveryMode) {
    base.push('--allow-dirty', 'true', '--commit', 'false');
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
    const explicitPlanId = metadataValue(metadata, 'Plan-ID');
    const planId = parsePlanId(explicitPlanId, null) ?? inferPlanId(content, filePath);
    if (!planId) {
      continue;
    }

    const dependencies = parseListField(metadataValue(metadata, 'Dependencies'))
      .map((entry) => parsePlanId(entry, null))
      .filter(Boolean);

    records.push({ planId, status, dependencies });
  }
  return records;
}

function unresolvedActivePlanIds(state, activePlans) {
  const completed = new Set(Array.isArray(state?.completedPlanIds) ? state.completedPlanIds : []);
  const blocked = new Set(Array.isArray(state?.blockedPlanIds) ? state.blockedPlanIds : []);
  const failed = new Set(Array.isArray(state?.failedPlanIds) ? state.failedPlanIds : []);

  return activePlans
    .filter((plan) => ACTIVE_STATUSES.has(plan.status))
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
        const hasRunStateAfter = existsSync(runStatePath);
        const likelyAtomicStartupDeadlock = command === firstCommand || hadRunStateBefore || hasRunStateAfter;
        if (likelyAtomicStartupDeadlock) {
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

    if (queueDrained(state, unresolvedIds)) {
      console.log('[supervisor] queue drained; done.');
      process.exit(0);
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
