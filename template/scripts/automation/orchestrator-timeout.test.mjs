import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { runShellMonitored, writeCheckpoint } from './orchestrator.mjs';

const logging = {
  mode: 'minimal',
  heartbeatSeconds: 1,
  stallWarnSeconds: 2
};

test('runShellMonitored keeps extending the timeout while the executor emits progress', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-timeout-progress-'));
  const command = `node --input-type=module -e "for (let step = 0; step < 6; step += 1) { console.log(JSON.stringify({ type: 'progress', activity: 'step-' + step })); await new Promise((resolve) => setTimeout(resolve, 250)); } console.log('done');"`;

  const execution = await runShellMonitored(command, cwd, process.env, 1000, logging, {
    phase: 'session',
    planId: 'timeout-progress',
    role: 'worker',
    activity: 'implementing'
  });

  assert.equal(execution.status, 0);
  assert.equal(execution.error, null);
  assert.match(String(execution.stdout), /done/);
});

test('runShellMonitored still times out when the executor stops making progress', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-timeout-stall-'));
  const command = `node --input-type=module -e "console.log(JSON.stringify({ type: 'progress', activity: 'starting' })); await new Promise((resolve) => setTimeout(resolve, 1500));"`;

  const execution = await runShellMonitored(command, cwd, process.env, 1000, logging, {
    phase: 'session',
    planId: 'timeout-stall',
    role: 'worker',
    activity: 'implementing'
  });

  assert.deepEqual(execution.error, { code: 'ETIMEDOUT' });
  assert.notEqual(execution.status, 0);
});

test('runShellMonitored normalizes timeout exit status when the child exits 0 after SIGTERM', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-timeout-clean-exit-'));
  const command = `node --input-type=module -e "process.on('SIGTERM', () => process.exit(0)); console.log(JSON.stringify({ type: 'progress', activity: 'starting' })); await new Promise((resolve) => setTimeout(resolve, 1500));"`;

  const execution = await runShellMonitored(command, cwd, process.env, 1000, logging, {
    phase: 'session',
    planId: 'timeout-clean-exit',
    role: 'reviewer',
    activity: 'reviewing'
  });

  assert.deepEqual(execution.error, { code: 'ETIMEDOUT' });
  assert.equal(execution.status, 124);
});

test('writeCheckpoint removes a stale handoff after a completed session', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-handoff-clear-'));
  const handoffPath = path.join(rootDir, 'docs', 'ops', 'automation', 'handoffs', 'stale-handoff-plan.md');
  const checkpointPath = path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'state', 'stale-handoff-plan', 'latest.json');
  const plan = { planId: 'stale-handoff-plan' };

  const baseResult = {
    summary: 'fixture result',
    reason: 'fixture reason',
    contextRemaining: null,
    contextWindow: null,
    contextRemainingPercent: null,
    currentSubtask: 'fixture',
    nextAction: 'continue',
    stateDelta: {
      completedWork: [],
      acceptedFacts: [],
      decisions: [],
      openQuestions: [],
      pendingActions: [],
      recentResults: [],
      artifacts: [],
      risks: [],
      reasoning: [],
      evidence: []
    }
  };

  await writeCheckpoint(rootDir, 'run-fixture', plan, 'reviewer', 1, {
    ...baseResult,
    status: 'pending'
  });

  await fs.access(handoffPath);

  await writeCheckpoint(rootDir, 'run-fixture', plan, 'worker', 2, {
    ...baseResult,
    status: 'completed'
  });

  await assert.rejects(fs.access(handoffPath));

  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  assert.equal(checkpoint.status, 'completed');
});
