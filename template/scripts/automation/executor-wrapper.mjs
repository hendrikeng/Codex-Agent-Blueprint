#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROMPT_TEMPLATE =
  'Continue plan {plan_id} in {plan_file}. Apply the next concrete step. Update the plan document with progress and evidence. Reuse existing evidence files when blocker state is unchanged; update canonical evidence index/readme links instead of creating new timestamped evidence files. ALWAYS write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and numeric contextRemaining. Never exit 0 without writing this payload. If contextRemaining is at/below ORCH_CONTEXT_THRESHOLD, return status handoff_required. If all acceptance criteria and required validations are complete, set top-level Status: completed; otherwise keep top-level Status: in-progress and list remaining work.';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return options;
}

function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function renderRaw(template, values) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (match, rawKey) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) {
      return match;
    }
    return String(values[key] ?? '');
  });
}

function renderShellEscaped(template, values) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (match, rawKey) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) {
      return match;
    }
    return shellEscape(values[key]);
  });
}

function parseJsonConfig(raw, filePath) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

async function loadOrchestratorConfig(rootDir) {
  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = parseJsonConfig(raw, configPath);
  return { configPath, parsed };
}

function normalizeProvider(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getRequiredOption(options, key) {
  const value = options[key];
  if (value == null || String(value).trim() === '') {
    throw new Error(`Missing required option --${key}`);
  }
  return String(value).trim();
}

function runCommand(command, cwd, env) {
  const result = spawnSync(command, {
    cwd,
    env,
    stdio: 'inherit',
    shell: true
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

async function main() {
  const rootDir = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const { configPath, parsed: config } = await loadOrchestratorConfig(rootDir);
  const executor = config.executor && typeof config.executor === 'object' ? config.executor : {};

  const planId = getRequiredOption(options, 'plan-id');
  const planFile = getRequiredOption(options, 'plan-file');
  const runId = getRequiredOption(options, 'run-id');
  const mode = getRequiredOption(options, 'mode');
  const session = getRequiredOption(options, 'session');
  const resultPath = getRequiredOption(options, 'result-path');

  const provider = normalizeProvider(
    options.provider ?? process.env.ORCH_EXECUTOR_PROVIDER ?? executor.provider ?? 'codex'
  );

  const providerCommandTemplate = String(executor.providers?.[provider]?.command ?? '').trim();
  if (!providerCommandTemplate) {
    const available = Object.keys(executor.providers ?? {}).sort();
    const availableText = available.length > 0 ? available.join(', ') : 'none configured';
    throw new Error(
      `No executor provider command configured for '${provider}' in ${configPath}. Available providers: ${availableText}`
    );
  }

  if (!providerCommandTemplate.includes('{prompt}')) {
    throw new Error(
      `Executor provider '${provider}' command must include '{prompt}' placeholder in ${configPath}`
    );
  }

  const values = {
    plan_id: planId,
    plan_file: planFile,
    run_id: runId,
    mode,
    session,
    result_path: resultPath
  };

  const promptTemplate = String(executor.promptTemplate || DEFAULT_PROMPT_TEMPLATE).trim();
  const prompt = renderRaw(promptTemplate, values);
  const command = renderShellEscaped(providerCommandTemplate, {
    ...values,
    prompt
  });

  const status = runCommand(command, rootDir, {
    ...process.env,
    ORCH_EXECUTOR_PROVIDER: provider
  });
  process.exit(status);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[executor-wrapper] ${message}`);
  process.exit(1);
});
