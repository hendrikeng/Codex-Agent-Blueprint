#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRepoOrAbsolutePath, writeTextFileAtomic } from './lib/orchestrator-shared.mjs';
import { CONTRACT_IDS, prepareContractPayload } from './lib/contracts/index.mjs';

const rootDir = process.cwd();
const aggregateResultPath = String(process.env.ORCH_VALIDATION_RESULT_PATH ?? '').trim();
const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function asBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function runCommand(command, dryRun) {
  if (dryRun) {
    console.log(`[verify-fast] dry-run: ${command}`);
    return { status: 0 };
  }
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1 };
}

function detectChangedFiles() {
  const provided = String(process.env.VERIFY_FAST_FILES ?? '').trim();
  if (provided) {
    return [...new Set(
      provided
        .split(',')
        .map((entry) => toPosix(entry.trim()))
        .filter(Boolean)
    )];
  }
  return [];
}

function resolvedPlanMetadataCommand() {
  const planId = String(process.env.ORCH_PLAN_ID ?? '').trim().toLowerCase();
  if (!planId || !PLAN_ID_REGEX.test(planId)) {
    return 'node ./scripts/automation/check-plan-metadata.mjs';
  }
  return `node ./scripts/automation/check-plan-metadata.mjs --plan-id ${planId}`;
}

function buildCommandSet(changedFiles) {
  const inOrchestratedPlanRun = String(process.env.ORCH_PLAN_ID ?? '').trim() !== '';
  const commands = [
    'node ./scripts/automation/compile-runtime-context.mjs',
    asBoolean(process.env.CI, false) || inOrchestratedPlanRun
      ? 'node ./scripts/docs/repair-plan-references.mjs --dry-run'
      : 'node ./scripts/docs/repair-plan-references.mjs',
    'node ./scripts/docs/check-governance.mjs',
    resolvedPlanMetadataCommand(),
    'node ./scripts/automation/check-harness-alignment.mjs'
  ];

  const needsArchitecture = changedFiles.some((file) => (
    file === 'ARCHITECTURE.md' ||
    file.startsWith('docs/architecture/') ||
    file.startsWith('scripts/architecture/')
  ));
  if (needsArchitecture) {
    commands.push('node ./scripts/architecture/check-dependencies.mjs');
  }

  return commands;
}

async function writeValidationResult(payload) {
  if (!aggregateResultPath) {
    return;
  }
  const absPath = resolveRepoOrAbsolutePath(rootDir, aggregateResultPath)?.abs;
  if (!absPath) {
    return;
  }
  const normalized = prepareContractPayload(CONTRACT_IDS.validationResult, {
    ...payload,
    command: String(payload?.command ?? 'npm run verify:fast').trim(),
    lane: 'always'
  });
  await writeTextFileAtomic(absPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = asBoolean(options['dry-run'], false);
  const changedFiles = detectChangedFiles();
  const commands = buildCommandSet(changedFiles);

  console.log(`[verify-fast] running ${commands.length} command(s).`);
  for (const command of commands) {
    const execution = runCommand(command, dryRun);
    if (execution.status !== 0) {
      await writeValidationResult({
        validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-fast',
        type: process.env.ORCH_VALIDATION_TYPE || 'always',
        status: 'failed',
        summary: `[verify-fast] failed: ${command}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        findingFiles: [],
        evidenceRefs: [],
        artifactRefs: []
      });
      process.exit(execution.status);
    }
  }

  await writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-fast',
    type: process.env.ORCH_VALIDATION_TYPE || 'always',
    status: 'passed',
    summary: '[verify-fast] passed.',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  });
  console.log('[verify-fast] passed.');
}

main().catch((error) => {
  writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-fast',
    type: process.env.ORCH_VALIDATION_TYPE || 'always',
    status: 'failed',
    summary: error instanceof Error ? error.message : String(error),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  }).finally(() => {
    console.error('[verify-fast] failed with an unexpected error.');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
});
