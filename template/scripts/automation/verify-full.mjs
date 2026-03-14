#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    'node ./scripts/automation/check-outcomes-thresholds.mjs',
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

function runCommand(command, dryRun) {
  if (dryRun) {
    console.log(`[verify-full] dry-run: ${command}`);
    return 0;
  }
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = asBoolean(options['dry-run'], false);
  const commands = fullCommands();

  console.log(`[verify-full] running ${commands.length} command(s).`);
  for (const command of commands) {
    const status = runCommand(command, dryRun);
    if (status !== 0) {
      console.error(`[verify-full] failed: ${command}`);
      process.exit(status);
    }
  }
  console.log('[verify-full] passed.');
}

main().catch((error) => {
  console.error('[verify-full] failed with an unexpected error.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
