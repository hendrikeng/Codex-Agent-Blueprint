#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { nextScenarioStep, writeStructuredResult } from './scenario-driver.mjs';
import {
  CONTRACT_IDS,
  prepareContractPayload
} from '../lib/contracts/index.mjs';

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
  const lane = String(options.lane ?? process.env.ORCH_VALIDATION_LANE ?? 'always').trim().toLowerCase();
  const planId = String(process.env.ORCH_PLAN_ID ?? '').trim();
  const resultPath = String(process.env.ORCH_VALIDATION_RESULT_PATH ?? '').trim();
  if (!resultPath) {
    throw new Error('ORCH_VALIDATION_RESULT_PATH is required for stub validation command.');
  }

  const step = await nextScenarioStep(rootDir, 'validation', `${lane}:${planId}`, {
    status: 'passed',
    summary: `${lane} validation passed for ${planId}`
  });
  const payload = prepareContractPayload(CONTRACT_IDS.validationResult, {
    validationId: String(process.env.ORCH_VALIDATION_ID ?? `fixture:${lane}`).trim(),
    command: String(process.env.ORCH_VALIDATION_COMMAND ?? `fixture:${lane}`).trim(),
    lane,
    type: String(process.env.ORCH_VALIDATION_TYPE ?? lane).trim(),
    status: String(step.status ?? 'passed').trim().toLowerCase(),
    summary: String(step.summary ?? `${lane} validation passed for ${planId}`).trim(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: Array.isArray(step.findingFiles) ? step.findingFiles : [],
    evidenceRefs: Array.isArray(step.evidenceRefs) ? step.evidenceRefs : [],
    artifactRefs: Array.isArray(step.artifactRefs) ? step.artifactRefs : []
  });
  const absResultPath = path.join(rootDir, resultPath);
  if (step.skipResultWrite !== true) {
    if (typeof step.rawResultText === 'string') {
      await fs.mkdir(path.dirname(absResultPath), { recursive: true });
      await fs.writeFile(absResultPath, step.rawResultText, 'utf8');
    } else {
      await writeStructuredResult(absResultPath, payload);
    }
  }

  process.exit(payload.status === 'failed' ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
