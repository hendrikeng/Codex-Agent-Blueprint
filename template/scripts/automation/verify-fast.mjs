#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveRepoOrAbsolutePath,
  writeTextFileAtomic
} from './lib/orchestrator-shared.mjs';
import {
  CONTRACT_IDS,
  parseContractPayload,
  prepareContractPayload
} from './lib/contracts/index.mjs';

const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const READ_ONLY_ORCH_ROLES = new Set(['planner', 'explorer', 'reviewer']);
const rootDir = process.cwd();
const aggregateResultPath = String(process.env.ORCH_VALIDATION_RESULT_PATH ?? '').trim();

function orchestratorRole() {
  const role = String(process.env.ORCH_ROLE ?? '').trim().toLowerCase();
  return READ_ONLY_ORCH_ROLES.has(role) || role === 'worker' ? role : null;
}

function resolvedPlanMetadataCommand() {
  const planId = String(process.env.ORCH_PLAN_ID ?? '').trim().toLowerCase();
  if (!planId || !PLAN_ID_REGEX.test(planId)) {
    return 'node ./scripts/automation/check-plan-metadata.mjs';
  }
  return `node ./scripts/automation/check-plan-metadata.mjs --plan-id ${planId}`;
}

function mandatoryCommands() {
  const ciMode = asBoolean(process.env.CI, false);
  const role = orchestratorRole();
  const roleReadOnlyMode = role != null && role !== 'worker';
  const repairCommand = (ciMode || roleReadOnlyMode)
    ? 'node ./scripts/docs/repair-plan-references.mjs --dry-run'
    : 'node ./scripts/docs/repair-plan-references.mjs';
  const runtimeContextCommand = roleReadOnlyMode
    ? 'node ./scripts/automation/compile-runtime-context.mjs --output /tmp/agent-runtime-context.md'
    : 'node ./scripts/automation/compile-runtime-context.mjs';
  const planMetadataCommand = roleReadOnlyMode
    ? `ORCH_PLAN_METADATA_AUTO_HEAL_STATUS=0 ${resolvedPlanMetadataCommand()}`
    : resolvedPlanMetadataCommand();

  return [
    runtimeContextCommand,
    repairCommand,
    'node ./scripts/docs/check-governance.mjs',
    planMetadataCommand
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

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function runShell(command) {
  const result = spawnSync(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '')
  };
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
    lane: String(payload?.lane ?? 'always').trim()
  });
  await writeTextFileAtomic(absPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
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
    return parseContractPayload(CONTRACT_IDS.validationResult, JSON.parse(raw));
  } catch {
    return null;
  }
}

function collectFromLines(raw) {
  return raw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(toPosix);
}

function detectChangedFiles() {
  const provided = String(process.env.VERIFY_FAST_FILES ?? '').trim();
  if (provided) {
    return [...new Set(
      provided
        .split(',')
        .map((entry) => toPosix(entry.trim()))
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
  }

  const collected = new Set();
  const commands = [
    'git diff --name-only --diff-filter=ACMR HEAD',
    'git diff --name-only --cached --diff-filter=ACMR',
    'git ls-files --others --exclude-standard'
  ];

  for (const command of commands) {
    try {
      const result = runShell(command);
      if (result.status !== 0) {
        continue;
      }
      for (const file of collectFromLines(result.stdout)) {
        collected.add(file);
      }
    } catch {
      // Best effort mode.
    }
  }

  return [...collected].sort((a, b) => a.localeCompare(b));
}

function anyMatch(files, matcher) {
  return files.some((file) => matcher(file));
}

function buildCommandSet(changedFiles) {
  const selected = new Set(mandatoryCommands());
  const changedCount = changedFiles.length;

  const changedArchitecture = anyMatch(changedFiles, (file) => (
    file === 'ARCHITECTURE.md' ||
    file.startsWith('docs/architecture/') ||
    file === 'docs/governance/architecture-rules.json' ||
    file.startsWith('scripts/architecture/')
  ));
  if (changedArchitecture) {
    selected.add('node ./scripts/architecture/check-dependencies.mjs');
  }

  const changedConformance = anyMatch(changedFiles, (file) => (
    file === 'docs/generated/article-conformance.json' ||
    file === 'scripts/check-article-conformance.mjs'
  ));
  if (changedConformance) {
    selected.add('node ./scripts/check-article-conformance.mjs');
  }

  const changedHardening = anyMatch(changedFiles, (file) => (
    file.startsWith('docs/agent-hardening/') ||
    file.startsWith('scripts/agent-hardening/') ||
    file === 'docs/generated/evals-report.json' ||
    file === 'docs/generated/continuity-evals-report.json'
  ));
  if (changedHardening) {
    selected.add('node ./scripts/agent-hardening/check-agent-hardening.mjs');
    selected.add('node ./scripts/agent-hardening/check-evals.mjs');
  }

  const changedAutomation = anyMatch(changedFiles, (file) => (
    file.startsWith('docs/ops/automation/') ||
    file.startsWith('scripts/automation/') ||
    file === 'package.scripts.fragment.json' ||
    file === 'package.json' ||
    file === 'docs/generated/run-outcomes.json'
  ));
  if (changedAutomation) {
    selected.add('node ./scripts/automation/check-harness-alignment.mjs');
    selected.add('node ./scripts/automation/check-outcomes-thresholds.mjs');
    selected.add('node ./scripts/automation/check-performance-budgets.mjs');
    selected.add('node ./scripts/automation/verify-orchestration-state.mjs');
  }

  const changedPlanContracts = anyMatch(changedFiles, (file) => (
    file === 'docs/PLANS.md' ||
    file.startsWith('docs/exec-plans/') ||
    file.startsWith('docs/future/')
  ));
  if (changedPlanContracts) {
    selected.add(resolvedPlanMetadataCommand());
  }

  return {
    changedCount,
    commands: [...selected]
  };
}

function runCommand(command, dryRun, env) {
  if (dryRun) {
    console.log(`[verify-fast] dry-run: ${command}`);
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
  const changedFiles = detectChangedFiles();
  const { changedCount, commands } = buildCommandSet(changedFiles);

  console.log(`[verify-fast] changed files detected: ${changedCount}`);
  if (changedCount > 0) {
    for (const file of changedFiles) {
      console.log(`- ${file}`);
    }
  } else {
    console.log('[verify-fast] no changed files detected; running mandatory safety commands only.');
  }

  console.log(`[verify-fast] running ${commands.length} command(s).`);
  const checks = [];
  for (const command of commands) {
    const index = checks.length;
    const childResultPath = subcommandResultPath(index);
    const env = childResultPath
      ? { ...process.env, ORCH_VALIDATION_RESULT_PATH: childResultPath }
      : process.env;
    const execution = runCommand(command, dryRun, env);
    const childResult = await readJsonIfExists(childResultPath);
    checks.push({
      command,
      status: execution.status === 0 ? 'passed' : 'failed',
      resultPath: childResultPath,
      childResult
    });
    if (execution.status !== 0) {
      await writeValidationResult({
        validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-fast',
        type: process.env.ORCH_VALIDATION_TYPE || 'integration',
        status: 'failed',
        summary: `[verify-fast] failed: ${command}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        findingFiles: Array.isArray(childResult?.findingFiles) ? childResult.findingFiles : [],
        evidenceRefs: childResultPath ? [childResultPath] : [],
        artifactRefs: []
      });
      console.error(`[verify-fast] failed: ${command}`);
      process.exit(execution.status);
    }
  }
  await writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-fast',
    type: process.env.ORCH_VALIDATION_TYPE || 'integration',
    status: 'passed',
    summary: '[verify-fast] passed.',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: checks.map((entry) => entry.resultPath).filter(Boolean),
    artifactRefs: []
  });
  console.log('[verify-fast] passed.');
}

main().catch((error) => {
  writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'repo:verify-fast',
    type: process.env.ORCH_VALIDATION_TYPE || 'integration',
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
