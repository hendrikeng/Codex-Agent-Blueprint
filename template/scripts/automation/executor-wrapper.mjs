#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROMPT_TEMPLATE =
  'Continue plan {plan_id} in {plan_file}. Current role: {role}. Declared risk tier: {declared_risk_tier}. Effective risk tier: {effective_risk_tier}. Execution profile: model={role_model}, reasoning={role_reasoning_effort}, sandbox={role_sandbox_mode}. Role instructions: {role_instructions}. Apply the next concrete step for this role. Update the plan document with progress and evidence. Reuse existing evidence files when blocker state is unchanged; update canonical evidence index/readme links instead of creating new timestamped evidence files. ALWAYS write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and numeric contextRemaining. Never exit 0 without writing this payload. If contextRemaining is at/below ORCH_CONTEXT_THRESHOLD, return status handoff_required. If all acceptance criteria and required validations are complete, set top-level Status: completed; otherwise keep top-level Status: in-progress and list remaining work.';

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

function getOptionalOption(options, key, fallback = '') {
  const value = options[key];
  if (value == null || String(value).trim() === '') {
    return String(fallback);
  }
  return String(value).trim();
}

function normalizeRoleProfile(profile = {}, defaults = {}) {
  const merged = {
    ...defaults,
    ...(profile && typeof profile === 'object' ? profile : {})
  };
  const model = String(merged.model ?? '').trim();
  const reasoningEffort = String(merged.reasoningEffort ?? 'medium').trim().toLowerCase();
  const sandboxMode = String(merged.sandboxMode ?? 'read-only').trim().toLowerCase();
  const instructions = String(merged.instructions ?? '').trim();
  return {
    model,
    reasoningEffort,
    sandboxMode,
    instructions
  };
}

function assertRoleSandboxPolicy(role, roleProfile) {
  const sandbox = String(roleProfile?.sandboxMode ?? '').trim().toLowerCase();
  if (role === 'worker') {
    if (sandbox !== 'full-access') {
      throw new Error(`Role '${role}' must use sandboxMode 'full-access' (found '${sandbox || 'unset'}').`);
    }
    return;
  }

  if (sandbox !== 'read-only') {
    throw new Error(`Role '${role}' must use sandboxMode 'read-only' (found '${sandbox || 'unset'}').`);
  }
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
  const role = getOptionalOption(options, 'role', 'worker').toLowerCase();
  const effectiveRiskTier = getOptionalOption(options, 'effective-risk-tier', 'low').toLowerCase();
  const declaredRiskTier = getOptionalOption(options, 'declared-risk-tier', 'low').toLowerCase();
  const stageIndex = getOptionalOption(options, 'stage-index', '1');
  const stageTotal = getOptionalOption(options, 'stage-total', '1');

  const provider = normalizeProvider(
    options.provider ?? process.env.ORCH_EXECUTOR_PROVIDER ?? executor.provider ?? 'codex'
  );

  const roleProviderValue = config.roleOrchestration?.providers?.[provider]?.roles?.[role];
  const roleProviderCommandTemplate = String(
    (typeof roleProviderValue === 'string' ? roleProviderValue : roleProviderValue?.command) ?? ''
  ).trim();
  const roleProfiles = config.roleOrchestration?.roleProfiles ?? {};
  const providerRoleProfiles = config.roleOrchestration?.providers?.[provider]?.roleProfiles ?? {};
  const roleProfile = normalizeRoleProfile(roleProfiles[role], {
    model: '',
    reasoningEffort: role === 'explorer' ? 'medium' : 'high',
    sandboxMode: role === 'worker' ? 'full-access' : 'read-only',
    instructions: ''
  });
  const providerRoleProfile = normalizeRoleProfile(providerRoleProfiles[role], roleProfile);
  assertRoleSandboxPolicy(role, providerRoleProfile);
  const providerCommandTemplate = String(executor.providers?.[provider]?.command ?? '').trim();
  const selectedCommandTemplate = roleProviderCommandTemplate || providerCommandTemplate;
  if (!selectedCommandTemplate) {
    const available = Object.keys(executor.providers ?? {}).sort();
    const availableText = available.length > 0 ? available.join(', ') : 'none configured';
    throw new Error(
      `No executor provider command configured for '${provider}' in ${configPath}. Available providers: ${availableText}`
    );
  }

  if (!selectedCommandTemplate.includes('{prompt}')) {
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
    role,
    effective_risk_tier: effectiveRiskTier,
    declared_risk_tier: declaredRiskTier,
    role_model: providerRoleProfile.model,
    role_reasoning_effort: providerRoleProfile.reasoningEffort,
    role_sandbox_mode: providerRoleProfile.sandboxMode,
    role_instructions: providerRoleProfile.instructions,
    stage_index: stageIndex,
    stage_total: stageTotal,
    result_path: resultPath
  };

  const promptTemplate = String(executor.promptTemplate || DEFAULT_PROMPT_TEMPLATE).trim();
  const prompt = renderRaw(promptTemplate, values);
  const command = renderShellEscaped(selectedCommandTemplate, {
    ...values,
    prompt
  });

  const status = runCommand(command, rootDir, {
    ...process.env,
    ORCH_EXECUTOR_PROVIDER: provider,
    ORCH_ROLE: role,
    ORCH_EFFECTIVE_RISK_TIER: effectiveRiskTier,
    ORCH_DECLARED_RISK_TIER: declaredRiskTier,
    ORCH_ROLE_MODEL: providerRoleProfile.model,
    ORCH_ROLE_REASONING_EFFORT: providerRoleProfile.reasoningEffort,
    ORCH_ROLE_SANDBOX_MODE: providerRoleProfile.sandboxMode,
    ORCH_ROLE_INSTRUCTIONS: providerRoleProfile.instructions,
    ORCH_STAGE_INDEX: stageIndex,
    ORCH_STAGE_TOTAL: stageTotal
  });
  process.exit(status);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[executor-wrapper] ${message}`);
  process.exit(1);
});
