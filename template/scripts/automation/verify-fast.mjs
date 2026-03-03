#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const MANDATORY_COMMANDS = [
  'node ./scripts/automation/compile-runtime-context.mjs',
  'node ./scripts/docs/repair-plan-references.mjs',
  'node ./scripts/docs/check-governance.mjs',
  'node ./scripts/automation/check-plan-metadata.mjs'
];

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
  const selected = new Set(MANDATORY_COMMANDS);
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
    file === 'docs/generated/evals-report.json'
  ));
  if (changedHardening) {
    selected.add('node ./scripts/agent-hardening/check-agent-hardening.mjs');
    selected.add('node ./scripts/agent-hardening/check-evals.mjs');
  }

  const changedAutomation = anyMatch(changedFiles, (file) => (
    file.startsWith('docs/ops/automation/') ||
    file.startsWith('scripts/automation/') ||
    file === 'package.scripts.fragment.json' ||
    file === 'package.json'
  ));
  if (changedAutomation) {
    selected.add('node ./scripts/automation/check-blueprint-alignment.mjs');
  }

  const changedPlanContracts = anyMatch(changedFiles, (file) => (
    file === 'docs/PLANS.md' ||
    file.startsWith('docs/exec-plans/') ||
    file.startsWith('docs/future/')
  ));
  if (changedPlanContracts) {
    selected.add('node ./scripts/automation/check-plan-metadata.mjs');
  }

  return {
    changedCount,
    commands: [...selected]
  };
}

function runCommand(command, dryRun) {
  if (dryRun) {
    console.log(`[verify-fast] dry-run: ${command}`);
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
  for (const command of commands) {
    const status = runCommand(command, dryRun);
    if (status !== 0) {
      console.error(`[verify-fast] failed: ${command}`);
      process.exit(status);
    }
  }
  console.log('[verify-fast] passed.');
}

main().catch((error) => {
  console.error('[verify-fast] failed with an unexpected error.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
