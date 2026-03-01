#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const findings = [];

const requiredPaths = {
  orchestrator: path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
  wrapper: path.join(rootDir, 'scripts', 'automation', 'executor-wrapper.mjs'),
  config: path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json')
};

function addFinding(code, message, filePath = null) {
  findings.push({ code, message, filePath });
}

function rel(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonStrict(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${rel(filePath)}: ${message}`);
  }
}

function commandIncludesRoleModel(command) {
  const value = String(command ?? '').trim();
  return value.includes('{prompt}') && value.includes('{role_model}');
}

function ensureScriptSignatures(orchestratorRaw, wrapperRaw) {
  if (!orchestratorRaw.includes("const DEFAULT_OUTPUT_MODE = 'ticker';")) {
    addFinding(
      'MISSING_TICKER_DEFAULT',
      "scripts/automation/orchestrator.mjs must default to output mode 'ticker'.",
      'scripts/automation/orchestrator.mjs'
    );
  }
  if (!orchestratorRaw.includes('function shouldCaptureCommandOutput(')) {
    addFinding(
      'MISSING_OUTPUT_CAPTURE_POLICY',
      'scripts/automation/orchestrator.mjs is missing command output capture policy.',
      'scripts/automation/orchestrator.mjs'
    );
  }
  if (!wrapperRaw.includes('enforceRoleModelSelection')) {
    addFinding(
      'MISSING_ROLE_MODEL_ENFORCEMENT',
      "scripts/automation/executor-wrapper.mjs must enforce role-model selection policy.",
      'scripts/automation/executor-wrapper.mjs'
    );
  }
}

function gatherPipelineRoles(config) {
  const pipelines = config?.roleOrchestration?.pipelines ?? {};
  const roles = new Set();
  for (const entries of Object.values(pipelines)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const role = String(entry ?? '').trim().toLowerCase();
      if (role) roles.add(role);
    }
  }
  return [...roles];
}

function ensureConfigPolicy(config, configPath) {
  const provider = String(config?.executor?.provider ?? 'codex').trim().toLowerCase();
  const roleProfiles = config?.roleOrchestration?.roleProfiles ?? {};
  const providerRoleProfiles = config?.roleOrchestration?.providers?.[provider]?.roleProfiles ?? {};
  const providerRoles = config?.roleOrchestration?.providers?.[provider]?.roles ?? {};
  const fallbackProviderCommand = config?.executor?.providers?.[provider]?.command ?? '';

  if (config?.executor?.enforceRoleModelSelection !== true) {
    addFinding(
      'ROLE_MODEL_ENFORCEMENT_DISABLED',
      "executor.enforceRoleModelSelection must be true.",
      rel(configPath)
    );
  }

  if (config?.logging?.output !== 'ticker') {
    addFinding(
      'TICKER_NOT_DEFAULT',
      "logging.output must be 'ticker'.",
      rel(configPath)
    );
  }

  const failureTailLines = Number.parseInt(String(config?.logging?.failureTailLines ?? ''), 10);
  if (!Number.isFinite(failureTailLines) || failureTailLines <= 0) {
    addFinding(
      'INVALID_FAILURE_TAIL_LINES',
      'logging.failureTailLines must be a positive integer.',
      rel(configPath)
    );
  }

  if (!commandIncludesRoleModel(fallbackProviderCommand)) {
    addFinding(
      'MISSING_ROLE_MODEL_IN_PROVIDER_COMMAND',
      `executor.providers.${provider}.command must include '{prompt}' and '{role_model}'.`,
      rel(configPath)
    );
  }

  const pipelineRoles = gatherPipelineRoles(config);
  for (const role of pipelineRoles) {
    const roleCommand = providerRoles?.[role]?.command ?? fallbackProviderCommand;
    if (!commandIncludesRoleModel(roleCommand)) {
      addFinding(
        'MISSING_ROLE_MODEL_IN_ROLE_COMMAND',
        `roleOrchestration.providers.${provider}.roles.${role}.command must include '{prompt}' and '{role_model}'.`,
        rel(configPath)
      );
    }

    const model = String(providerRoleProfiles?.[role]?.model ?? roleProfiles?.[role]?.model ?? '').trim();
    if (!model) {
      addFinding(
        'MISSING_ROLE_MODEL_PROFILE',
        `Role '${role}' is missing a configured model in roleOrchestration.roleProfiles or provider override.`,
        rel(configPath)
      );
    }
  }
}

async function main() {
  for (const filePath of Object.values(requiredPaths)) {
    if (!(await fileExists(filePath))) {
      addFinding('MISSING_REQUIRED_FILE', `Missing required file '${rel(filePath)}'.`, rel(filePath));
    }
  }

  if (findings.length > 0) {
    console.error(`[blueprint-verify] failed with ${findings.length} issue(s):`);
    for (const finding of findings) {
      const pathSuffix = finding.filePath ? ` (${finding.filePath})` : '';
      console.error(`- [${finding.code}] ${finding.message}${pathSuffix}`);
    }
    process.exit(1);
  }

  const [orchestratorRaw, wrapperRaw, config] = await Promise.all([
    fs.readFile(requiredPaths.orchestrator, 'utf8'),
    fs.readFile(requiredPaths.wrapper, 'utf8'),
    readJsonStrict(requiredPaths.config)
  ]);

  ensureScriptSignatures(orchestratorRaw, wrapperRaw);
  ensureConfigPolicy(config, requiredPaths.config);

  if (findings.length > 0) {
    console.error(`[blueprint-verify] failed with ${findings.length} issue(s):`);
    for (const finding of findings) {
      const pathSuffix = finding.filePath ? ` (${finding.filePath})` : '';
      console.error(`- [${finding.code}] ${finding.message}${pathSuffix}`);
    }
    process.exit(1);
  }

  const provider = String(config?.executor?.provider ?? 'codex').trim().toLowerCase();
  const roleCount = gatherPipelineRoles(config).length;
  console.log(
    `[blueprint-verify] passed (provider=${provider}, pipelineRoles=${roleCount}, output=${config.logging.output}).`
  );
}

main().catch((error) => {
  console.error('[blueprint-verify] failed with an unexpected error.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
