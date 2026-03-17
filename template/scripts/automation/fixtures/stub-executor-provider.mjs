#!/usr/bin/env node
import path from 'node:path';

import {
  applyPlanStep,
  applyTouches,
  nextScenarioStep,
  structuredResult,
  writeStructuredResult
} from './scenario-driver.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

async function main() {
  const rootDir = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const planId = String(process.env.ORCH_PLAN_ID ?? '').trim();
  const planFile = String(options['plan-file'] ?? process.env.ORCH_PLAN_FILE ?? '').trim();
  const role = String(process.env.ORCH_ROLE ?? 'worker').trim().toLowerCase();
  const resultPath = String(process.env.ORCH_RESULT_PATH ?? '').trim();
  if (!resultPath) {
    throw new Error('ORCH_RESULT_PATH is required for stub executor provider.');
  }

  const step = await nextScenarioStep(rootDir, 'executor', `${planId}:${role}`, {
    status: 'completed',
    summary: `fixture completed ${planId}`,
    checkAllMustLand: role === 'worker',
    planFields: role === 'worker'
      ? { Status: 'validation', 'Validation-Ready': 'host-required-only' }
      : {}
  });
  if (role === 'worker' && step.status === 'completed' && step.checkAllMustLand == null) {
    step.checkAllMustLand = true;
  }

  console.log(JSON.stringify({
    type: 'progress',
    activity: step.liveActivity ?? `${role} working on ${planId}`
  }));

  await applyTouches(rootDir, step.touches);
  await applyPlanStep(rootDir, planFile, step);

  const payload = structuredResult(step, {
    status: 'completed',
    summary: `fixture completed ${planId}`,
    currentSubtask: `${planId}:${role}`,
    nextAction: `Return control to orchestrator for ${planId}`
  });
  await writeStructuredResult(path.join(rootDir, resultPath), payload);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
