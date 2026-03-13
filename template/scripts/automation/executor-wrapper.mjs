#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROMPT_TEMPLATE =
  'Use the task contact pack as the primary context for this session and expand scope only when a blocker requires targeted evidence. Apply the next concrete step for this role. Keep plan/evidence updates concise and net-new only; avoid large pasted excerpts, repeated unchanged checklists, and duplicate long session narratives. When session history grows, keep only the recent entries in the active plan/evidence files and archive older detail. Treat `## Must-Land Checklist` as the executable contract for the current plan: do not mark a plan ready for validation or completion while any checklist item remains unchecked. If the plan references broader target state, keep `## Already-True Baseline` and `## Deferred Follow-Ons` separate from the must-land scope instead of collapsing everything into one milestone. For future blueprints and strategic active phase plans, require `## Prior Completed Plan Reconciliation` so overlapping completed plans are explicitly classified before promotion or validation. Reuse existing evidence files when blocker state is unchanged; update canonical evidence index/readme links instead of creating new timestamped evidence files. Avoid redundant validation reruns: do not repeat the same verification command in consecutive sessions unless relevant files changed or the last run failed. Do not run host-bound validations directly in this executor session (infra/bootstrap, DB migrations, Playwright/E2E/browser tests); leave them to the validation.hostRequired lane. ALWAYS write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and numeric contextRemaining. Use status pending only when the same role needs another session in this run after concrete progress. Worker sessions must apply at least one concrete repository edit outside the active plan/evidence docs before returning pending unless an explicit external blocker exists. Planner/explorer/reviewer stages should return completed once role-scoped objectives are done, even when the overall plan remains in progress for later roles. Planner/explorer must record concrete next implementation steps before returning completed. Reserve blocked for external/manual gates orchestration cannot progress automatically. If contextRemaining is at or below ORCH_CONTEXT_THRESHOLD and another same-role session is still required for concrete progress, return status handoff_required. If implementation acceptance criteria are complete and every `## Must-Land Checklist` item is checked, set `Validation-Ready: yes` and top-level `Status: validation` in the same edit; when only host-required validations remain, set `Validation-Ready: host-required-only` and `Status: validation`. Do not set `Status: validation` by itself. Progress reporting requirement: interim status updates must be concise plain text with complete words and full identifiers, without markdown headings, bullet lists, or file links. Session task: plan={plan_id} file={plan_file} role={role} stage={stage_index}/{stage_total} declared-risk={declared_risk_tier} effective-risk={effective_risk_tier}. Primary task contact pack: {contact_pack_file}. Primary runtime policy reference: {runtime_context_file}. Role contract: sandbox={role_sandbox_mode}, reasoning={role_reasoning_effort}. Role instructions: {role_instructions}. Focus edits on {plan_file}, {plan_evidence_file}, and {plan_evidence_index_file}; avoid scanning unrelated docs unless required for this role stage.';
const DEFAULT_RUNTIME_CONTEXT_PATH = 'docs/generated/agent-runtime-context.md';
const LEGACY_PROMPT_CONTEXT_SENTENCE =
  'ALWAYS write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and numeric contextRemaining. Use status pending only when the same role needs another session in this run after concrete progress.';
const UPDATED_PROMPT_CONTEXT_SENTENCE =
  'ALWAYS write a structured JSON result to ORCH_RESULT_PATH with status (completed|blocked|handoff_required|pending), summary, reason, and numeric contextRemaining. Include numeric contextWindow and contextUsedRatio when the provider/runtime can estimate them reliably. Use status pending only when the same role needs another session in this run after concrete progress and the hard low-context guardrails are not yet active.';
const LEGACY_PROMPT_THRESHOLD_SENTENCE =
  'If contextRemaining is at or below ORCH_CONTEXT_THRESHOLD and another same-role session is still required for concrete progress, return status handoff_required.';
const UPDATED_PROMPT_THRESHOLD_SENTENCE =
  'Treat ORCH_CONTEXT_ABSOLUTE_FLOOR (legacy alias ORCH_CONTEXT_THRESHOLD) as a hard remaining-context backstop. Treat ORCH_CONTEXT_SOFT_USED_RATIO as the point where you should stop widening scope and close the current narrow slice. Treat ORCH_CONTEXT_HARD_USED_RATIO as the point where another same-role session is unsafe: if more same-role work is still required and estimated contextUsedRatio is at or above that hard limit, or contextRemaining is at or below the absolute floor, return status handoff_required.';

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
  const reasoningEffortByRisk = {
    ...normalizeReasoningEffortByRisk(defaults?.reasoningEffortByRisk),
    ...normalizeReasoningEffortByRisk(profile?.reasoningEffortByRisk)
  };
  const model = String(merged.model ?? '').trim();
  const reasoningEffort = normalizeReasoningEffort(merged.reasoningEffort, 'medium');
  const sandboxMode = String(merged.sandboxMode ?? 'read-only').trim().toLowerCase();
  const instructions = String(merged.instructions ?? '').trim();
  return {
    model,
    reasoningEffort,
    reasoningEffortByRisk,
    sandboxMode,
    instructions
  };
}

function normalizeReasoningEffort(value, fallback = 'medium') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'xhigh'].includes(normalized) ? normalized : fallback;
}

function normalizeReasoningEffortByRisk(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};
  for (const riskTier of ['low', 'medium', 'high']) {
    const effort = normalizeReasoningEffort(source[riskTier], '');
    if (effort) {
      normalized[riskTier] = effort;
    }
  }
  return normalized;
}

function resolveReasoningEffortForRisk(profile, riskTier, fallback = 'medium') {
  const normalizedRiskTier = ['low', 'medium', 'high'].includes(String(riskTier ?? '').trim().toLowerCase())
    ? String(riskTier).trim().toLowerCase()
    : 'low';
  const override = normalizeReasoningEffort(profile?.reasoningEffortByRisk?.[normalizedRiskTier], '');
  if (override) {
    return override;
  }
  return normalizeReasoningEffort(profile?.reasoningEffort, fallback);
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
    reasoningEffortByRisk: {},
    sandboxMode: role === 'worker' ? 'full-access' : 'read-only',
    instructions: ''
  });
  const providerRoleProfileBase = normalizeRoleProfile(providerRoleProfiles[role], roleProfile);
  const providerRoleProfile = {
    ...providerRoleProfileBase,
    reasoningEffort: resolveReasoningEffortForRisk(
      providerRoleProfileBase,
      effectiveRiskTier,
      role === 'explorer' ? 'medium' : 'high'
    )
  };
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

  const promptTemplate = String(executor.promptTemplate || DEFAULT_PROMPT_TEMPLATE)
    .trim()
    .replace(LEGACY_PROMPT_CONTEXT_SENTENCE, UPDATED_PROMPT_CONTEXT_SENTENCE)
    .replace(LEGACY_PROMPT_THRESHOLD_SENTENCE, UPDATED_PROMPT_THRESHOLD_SENTENCE);
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
