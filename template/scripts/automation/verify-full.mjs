#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRepoOrAbsolutePath } from './lib/orchestrator-shared.mjs';

const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const rootDir = process.cwd();
const aggregateResultPath = String(process.env.ORCH_VALIDATION_RESULT_PATH ?? '').trim();

function resolvedPlanMetadataCommand() {
  const planId = String(process.env.ORCH_PLAN_ID ?? '').trim().toLowerCase();
  if (!planId || !PLAN_ID_REGEX.test(planId)) {
    return 'node ./scripts/automation/check-plan-metadata.mjs';
  }
  return `node ./scripts/automation/check-plan-metadata.mjs --plan-id ${planId}`;
}

function fullCommands() {
  return [
    'node ./scripts/automation/compile-runtime-context.mjs',
    'node ./scripts/docs/check-governance.mjs',
    'node ./scripts/check-article-conformance.mjs',
    'node ./scripts/architecture/check-dependencies.mjs',
    'node ./scripts/agent-hardening/check-agent-hardening.mjs',
    'node ./scripts/agent-hardening/check-evals.mjs',
    'node ./scripts/automation/check-harness-alignment.mjs',
    'node ./scripts/automation/summarize-run-outcomes.mjs',
    'node ./scripts/automation/check-outcomes-thresholds.mjs --warn-only',
    resolvedPlanMetadataCommand()
  ];
}

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

async function writeValidationResult(payload) {
  if (!aggregateResultPath) {
    return;
  }
  const absPath = resolveRepoOrAbsolutePath(rootDir, aggregateResultPath)?.abs;
  if (!absPath) {
    return;
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function subcommandResultPath(index) {
  if (!aggregateResultPath) {
    return null;
  }
  const parsed = path.parse(aggregateResultPath);
  return path.join(parsed.dir, `${parsed.name}-command-${index + 1}.json`);
}

async function readJsonIfExists(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    const resolved = resolveRepoOrAbsolutePath(rootDir, filePath);
    if (!resolved) {
      return null;
    }
    const raw = await fs.readFile(resolved.abs, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runCommand(command, dryRun, env) {
  if (dryRun) {
    console.log(`[verify-full] dry-run: ${command}`);
    return { status: 0 };
  }
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1 };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = asBoolean(options['dry-run'], false);
  const commands = fullCommands();

  console.log(`[verify-full] running ${commands.length} command(s).`);
  const checks = [];
  for (const command of commands) {
    const index = checks.length;
    const childResultPath = subcommandResultPath(index);
    const env = childResultPath
      ? { ...process.env, ORCH_VALIDATION_RESULT_PATH: childResultPath }
      : process.env;
    const execution = runCommand(command, dryRun, env);
    const childResult = await readJsonIfExists(childResultPath);
    checks.push({ command, resultPath: childResultPath, childResult });
    if (execution.status !== 0) {
      await writeValidationResult({
        validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-full',
        type: process.env.ORCH_VALIDATION_TYPE || 'host-required',
        status: 'failed',
        summary: `[verify-full] failed: ${command}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        findingFiles: Array.isArray(childResult?.findingFiles) ? childResult.findingFiles : [],
        evidenceRefs: childResultPath ? [childResultPath] : [],
        artifactRefs: []
      });
      console.error(`[verify-full] failed: ${command}`);
      process.exit(execution.status);
    }
  }
  await writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-full',
    type: process.env.ORCH_VALIDATION_TYPE || 'host-required',
    status: 'passed',
    summary: '[verify-full] passed.',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: checks.map((entry) => entry.resultPath).filter(Boolean),
    artifactRefs: []
  });
  console.log('[verify-full] passed.');
}

main().catch((error) => {
  writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-full',
    type: process.env.ORCH_VALIDATION_TYPE || 'host-required',
    status: 'failed',
    summary: error instanceof Error ? error.message : String(error),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  }).finally(() => {
    console.error('[verify-full] failed with an unexpected error.');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
});
