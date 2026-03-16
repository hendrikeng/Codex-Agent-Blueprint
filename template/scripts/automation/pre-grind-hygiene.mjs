#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

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

function shellQuote(value) {
  const rendered = String(value ?? '');
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(rendered)) {
    return rendered;
  }
  return `'${rendered.replace(/'/g, `'\\''`)}'`;
}

function commandList(planId) {
  const scopedPlanArg = planId ? ` --plan-id ${shellQuote(planId)}` : '';
  return [
    'node ./scripts/automation/compile-runtime-context.mjs',
    `node ./scripts/automation/compile-program-children.mjs --write true${scopedPlanArg}`,
    'node ./scripts/docs/repair-plan-references.mjs',
    `node ./scripts/automation/check-plan-metadata.mjs${scopedPlanArg}`,
    'node ./scripts/automation/verify-orchestration-state.mjs',
    'node ./scripts/automation/verify-fast.mjs'
  ];
}

function runShell(command, env) {
  return spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = asBoolean(options['dry-run'] ?? options.dryRun, false);
  const planId = String(options['plan-id'] ?? options.planId ?? '').trim();
  const commands = commandList(planId);
  const env = planId ? { ...process.env, ORCH_PLAN_ID: planId } : process.env;

  for (const [index, command] of commands.entries()) {
    const label = `[pre-grind] step ${index + 1}/${commands.length}`;
    if (dryRun) {
      console.log(`${label} dry-run: ${command}`);
      continue;
    }
    console.log(`${label}: ${command}`);
    const result = runShell(command, env);
    const exitCode = result.status ?? 1;
    if (exitCode !== 0) {
      console.error(`[pre-grind] failed at step ${index + 1}: ${command}`);
      process.exit(exitCode);
    }
  }

  console.log('[pre-grind] hygiene passed.');
}

main().catch((error) => {
  console.error('[pre-grind] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
