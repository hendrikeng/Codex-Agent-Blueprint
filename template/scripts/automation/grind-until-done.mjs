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

const commandArg = String(process.argv[2] ?? 'run').trim().toLowerCase();
const firstCommand = commandArg === 'resume' ? 'resume' : 'run';
const passthroughArgs = process.argv.slice(3);

const maxCycles = Number.parseInt(process.env.ORCH_GRIND_MAX_CYCLES ?? '120', 10);
const stableLimit = Number.parseInt(process.env.ORCH_GRIND_STABLE_LIMIT ?? '4', 10);
const rootDir = process.cwd();
const runStatePath = path.join(rootDir, 'docs/ops/automation/run-state.json');
const activePlansDir = path.join(rootDir, 'docs/exec-plans/active');

const baseArgs = [
  '--mode', 'guarded',
  '--retry-failed', 'true',
  '--auto-unblock', 'true',
  '--max-failed-retries', '2',
  '--output', process.env.ORCH_OUTPUT ?? 'pretty'
];

function hasCliFlag(flag) {
  return passthroughArgs.some((entry) => entry === flag || entry.startsWith(`${flag}=`));
}

if (!hasCliFlag('--allow-dirty')) {
  baseArgs.push('--allow-dirty', 'true');
}
if (!hasCliFlag('--commit')) {
  baseArgs.push('--commit', 'false');
}

let stableCycles = 0;
let previousSignature = '';

function runOrchestrator(command) {
  const args = ['./scripts/automation/orchestrator.mjs', command, ...baseArgs, ...passthroughArgs];
  const renderedArgs = [command, ...baseArgs, ...passthroughArgs].join(' ');
  console.log(`[grind] starting: node ./scripts/automation/orchestrator.mjs ${renderedArgs}`);
  const result = spawnSync('node', args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readRunState() {
  if (!existsSync(runStatePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(runStatePath, 'utf8'));
  } catch (error) {
    console.error(`[grind] failed to parse ${runStatePath}: ${error instanceof Error ? error.message : String(error)}`);
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

function stateSignature(state, unresolvedActivePlanIdsList) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const blocked = Array.isArray(state?.blockedPlanIds) ? state.blockedPlanIds : [];
  const failed = Array.isArray(state?.failedPlanIds) ? state.failedPlanIds : [];
  const completedCount = Array.isArray(state?.completedPlanIds) ? state.completedPlanIds.length : 0;
  const inProgressPlan = state?.inProgress?.planId ?? null;
  return JSON.stringify({
    queue,
    blocked,
    failed,
    completedCount,
    inProgressPlan,
    unresolvedActive: unresolvedActivePlanIdsList
  });
}

function queueDrained(state, unresolvedActivePlanIdsList) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  return queue.length === 0 && !state?.inProgress && unresolvedActivePlanIdsList.length === 0;
}

function renderSummary(state, unresolvedActivePlanIdsList) {
  const queueCount = Array.isArray(state?.queue) ? state.queue.length : 0;
  const blockedCount = Array.isArray(state?.blockedPlanIds) ? state.blockedPlanIds.length : 0;
  const failedCount = Array.isArray(state?.failedPlanIds) ? state.failedPlanIds.length : 0;
  const inProgressPlan = state?.inProgress?.planId ?? 'none';
  const unresolvedCount = unresolvedActivePlanIdsList.length;
  const unresolvedSample = unresolvedCount > 0 ? unresolvedActivePlanIdsList.slice(0, 3).join(',') : 'none';
  return (
    `queue=${queueCount} blocked=${blockedCount} failed=${failedCount} inProgress=${inProgressPlan} ` +
    `unresolvedActive=${unresolvedCount} sample=${unresolvedSample}`
  );
}

for (let cycle = 0; cycle < maxCycles; cycle += 1) {
  const command = cycle === 0 ? firstCommand : 'resume';
  runOrchestrator(command);

  const state = readRunState();
  if (!state) {
    console.log('[grind] run-state not found; stopping.');
    process.exit(0);
  }

  const activePlans = readActivePlanRecords();
  const unresolvedIds = unresolvedActivePlanIds(state, activePlans);
  console.log(`[grind] state after cycle ${cycle + 1}: ${renderSummary(state, unresolvedIds)}`);

  if (queueDrained(state, unresolvedIds)) {
    console.log('[grind] queue drained; done.');
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
      `[grind] no queue progress for ${stableCycles + 1} consecutive cycles. ` +
      'Stopping for manual review to avoid endless retries.'
    );
    process.exit(2);
  }
}

console.error(`[grind] reached ORCH_GRIND_MAX_CYCLES=${maxCycles}. Stopping.`);
process.exit(2);
