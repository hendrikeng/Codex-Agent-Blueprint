import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateOrchestrationState } from './verify-orchestration-state.mjs';
import { createOrchestrationState } from './lib/orchestration-state-machine.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templateRoot = path.join(repoRoot, 'template');

test('evaluateOrchestrationState passes matching replayed and persisted summaries', () => {
  const runState = {
    orchestrationState: {
      'plan-a': {
        ...createOrchestrationState('plan-a'),
        planState: 'completed',
        stageState: 'completed',
        validationState: 'passed',
        currentRole: 'worker',
        currentStageIndex: 1,
        currentStageTotal: 1,
        lastTransitionEvent: 'plan_completed',
        lastTransitionCode: 'plan.completed',
        transitionCount: 7
      }
    }
  };
  const runEvents = [
    { type: 'plan_started', details: { planId: 'plan-a' } },
    { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
    { type: 'completion_gate_opened', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } },
    { type: 'validation_started', details: { planId: 'plan-a' } },
    { type: 'validation_always_passed', details: { planId: 'plan-a' } },
    { type: 'host_validation_passed', details: { planId: 'plan-a' } },
    { type: 'plan_completed', details: { planId: 'plan-a' } }
  ];

  const result = evaluateOrchestrationState(runState, runEvents);
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.replayErrors.length, 0);
  assert.equal(result.checkedPlans, 1);
});

test('evaluateOrchestrationState reports mismatched persisted summaries', () => {
  const runState = {
    orchestrationState: {
      'plan-a': createOrchestrationState('plan-a')
    }
  };
  const runEvents = [
    { type: 'session_started', details: { planId: 'plan-a', role: 'worker', stageIndex: 1, stageTotal: 1 } }
  ];

  const result = evaluateOrchestrationState(runState, runEvents);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].planId, 'plan-a');
});

test('evaluateOrchestrationState reports illegal transition replay errors', () => {
  const result = evaluateOrchestrationState(null, [
    { type: 'host_validation_passed', details: { planId: 'plan-a' } }
  ]);

  assert.equal(result.replayErrors.length, 1);
  assert.match(result.replayErrors[0].error, /Illegal plan machine transition/);
});

test('verify-orchestration-state writes structured finding files for malformed run-events', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-orchestration-state-'));
  await fs.cp(templateRoot, rootDir, { recursive: true });

  const opsDir = path.join(rootDir, 'docs', 'ops', 'automation');
  await fs.mkdir(opsDir, { recursive: true });
  await fs.writeFile(path.join(opsDir, 'run-events.jsonl'), '{"schemaVersion":1,"type":"plan_started"\n', 'utf8');

  const resultPath = path.join(rootDir, 'tmp-validation-result.json');
  const result = spawnSync(
    'node',
    ['./scripts/automation/verify-orchestration-state.mjs'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCH_VALIDATION_RESULT_PATH: resultPath
      }
    }
  );

  assert.equal(result.status, 1);
  const payload = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  assert.equal(payload.status, 'failed');
  assert.deepEqual(payload.findingFiles, ['docs/ops/automation/run-events.jsonl']);
});
