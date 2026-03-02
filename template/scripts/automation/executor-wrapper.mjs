#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROMPT_TEMPLATE =
  'Continue plan {plan_id} in {plan_file}. Current role: {role}. Declared risk tier: {declared_risk_tier}. Effective risk tier: {effective_risk_tier}. Execution profile: model={role_model}, reasoning={role_reasoning_effort}, sandbox={role_sandbox_mode}. Primary task contact pack: {contact_pack_file}. Primary runtime policy reference: {runtime_context_file}. Use the contact pack first and expand scope only when a blocker requires targeted evidence. Role instructions: {role_instructions}. Focus edits on {plan_file}, {plan_evidence_file}, and {plan_evidence_index_file}; avoid scanning unrelated docs unless required for this role stage. Apply the next concrete step for this role. Update the plan document with progress and evidence. Reuse existing evidence files when blocker state is unchanged; update canonical evidence index/readme links instead of creating new timestamped evidence files. Avoid redundant validation reruns: do not repeat the same verification command in consecutive sessions unless relevant files changed or the last run failed. Do not run host-bound validations directly in this executor session (infra/bootstrap, DB migrations, Playwright/E2E/browser tests); treat them as validation.hostRequired work and leave execution to the host-validation lane. ALWAYS write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and numeric contextRemaining. Use status pending (not blocked) only when the same role needs another session in this run after concrete progress. For worker role sessions, do not defer implementation to planner/explorer; if no external blocker exists, apply at least one concrete repository edit before returning pending. For planner/explorer/reviewer role stages, return status completed once role-scoped objectives are done, even when the overall plan stays in-progress for later roles. Planner/explorer must record concrete next implementation steps directly in plan/evidence docs before returning completed. Reserve blocked for external/manual gates orchestration cannot progress automatically. Never exit 0 without writing this payload. If contextRemaining is at/below ORCH_CONTEXT_THRESHOLD, return status handoff_required. Do not wait for host-required validations to run inside this executor session. If implementation acceptance criteria are complete and the plan is ready for orchestration validation lanes, set top-level Status: completed to trigger validation; otherwise keep top-level Status: in-progress and list remaining implementation work.';
const DEFAULT_RUNTIME_CONTEXT_PATH = 'docs/generated/agent-runtime-context.md';

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

function toPosix(value) {
  return String(value).split(path.sep).join('/');
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

function asBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function asInteger(value, fallback = 0) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  const workerNoTouchRetryCount = Math.max(0, asInteger(process.env.ORCH_WORKER_NO_TOUCH_RETRY_COUNT, 0));
  const workerNoTouchRetryLimit = Math.max(0, asInteger(process.env.ORCH_WORKER_NO_TOUCH_RETRY_LIMIT, 0));
  const runtimeContextFile = String(config?.context?.runtimeContextPath ?? DEFAULT_RUNTIME_CONTEXT_PATH).trim() || DEFAULT_RUNTIME_CONTEXT_PATH;
  const contactPackFile = getOptionalOption(
    options,
    'contact-pack-file',
    process.env.ORCH_CONTACT_PACK_FILE ?? runtimeContextFile
  );
  const planEvidenceFile = toPosix(path.join('docs', 'exec-plans', 'active', 'evidence', `${planId}.md`));
  const planEvidenceIndexFile = toPosix(path.join('docs', 'exec-plans', 'evidence-index', `${planId}.md`));

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
  const enforceRoleModelSelection = asBoolean(executor.enforceRoleModelSelection, true);
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
  if (enforceRoleModelSelection) {
    if (!providerRoleProfile.model) {
      throw new Error(
        `Role '${role}' is missing a configured model in ${configPath}. Set roleOrchestration.roleProfiles.${role}.model (or provider override).`
      );
    }
    if (!selectedCommandTemplate.includes('{role_model}')) {
      throw new Error(
        `Executor provider '${provider}' role '${role}' command must include '{role_model}' in ${configPath} to enforce role-specific model switching.`
      );
    }
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
    result_path: resultPath,
    contact_pack_file: contactPackFile,
    runtime_context_file: runtimeContextFile,
    plan_evidence_file: planEvidenceFile,
    plan_evidence_index_file: planEvidenceIndexFile
  };

  const promptTemplate = String(executor.promptTemplate || DEFAULT_PROMPT_TEMPLATE).trim();
  if (!promptTemplate.includes('{contact_pack_file}')) {
    throw new Error(
      `Executor prompt template must include '{contact_pack_file}' in ${configPath} to enforce task-scoped context loading.`
    );
  }
  const basePrompt = renderRaw(promptTemplate, values);
  const workerRetryDirective =
    role === 'worker' && workerNoTouchRetryCount > 0
      ? `Worker retry directive: previous worker session returned pending with zero touched files (${workerNoTouchRetryCount}/${workerNoTouchRetryLimit || '?'}). Apply at least one concrete repository edit immediately before extended analysis. If no repository edit is possible because of an external dependency, return status blocked with the explicit external gate instead of pending.`
      : '';
  const prompt = workerRetryDirective ? `${basePrompt} ${workerRetryDirective}` : basePrompt;
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
    ORCH_CONTACT_PACK_FILE: contactPackFile,
    ORCH_RUNTIME_CONTEXT_FILE: runtimeContextFile,
    ORCH_PLAN_EVIDENCE_FILE: planEvidenceFile,
    ORCH_PLAN_EVIDENCE_INDEX_FILE: planEvidenceIndexFile,
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
