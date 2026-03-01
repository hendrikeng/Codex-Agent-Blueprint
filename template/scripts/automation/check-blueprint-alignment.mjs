#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const findings = [];
const advisories = [];

const requiredPaths = {
  orchestrator: path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
  wrapper: path.join(rootDir, 'scripts', 'automation', 'executor-wrapper.mjs'),
  config: path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json'),
  contextCompiler: path.join(rootDir, 'scripts', 'automation', 'compile-runtime-context.mjs'),
  verifyFast: path.join(rootDir, 'scripts', 'automation', 'verify-fast.mjs'),
  verifyFull: path.join(rootDir, 'scripts', 'automation', 'verify-full.mjs'),
  perfCollector: path.join(rootDir, 'scripts', 'automation', 'collect-performance-baseline.mjs'),
  policyManifest: path.join(rootDir, 'docs', 'governance', 'policy-manifest.json'),
  policySchema: path.join(rootDir, 'docs', 'governance', 'policy-manifest.schema.json')
};

function addFinding(code, message, filePath = null) {
  findings.push({ code, message, filePath });
}

function addAdvisory(code, message, filePath = null) {
  advisories.push({ code, message, filePath });
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

async function readUtf8IfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function commandIncludesRoleModel(command) {
  const value = String(command ?? '').trim();
  return value.includes('{prompt}') && value.includes('{role_model}');
}

function ensureScriptSignatures(orchestratorRaw, wrapperRaw) {
  if (!orchestratorRaw.includes("const DEFAULT_OUTPUT_MODE = 'pretty';")) {
    addFinding(
      'MISSING_PRETTY_DEFAULT',
      "scripts/automation/orchestrator.mjs must default to output mode 'pretty'.",
      'scripts/automation/orchestrator.mjs'
    );
  }
  if (!orchestratorRaw.includes('function isPrettyOutput(')) {
    addFinding(
      'MISSING_PRETTY_MODE_SUPPORT',
      'scripts/automation/orchestrator.mjs is missing pretty-mode support helpers.',
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
  if (!orchestratorRaw.includes('function runShellMonitored(')) {
    addFinding(
      'MISSING_LIVE_EXECUTION_MONITOR',
      'scripts/automation/orchestrator.mjs must include monitored command execution for live heartbeat status.',
      'scripts/automation/orchestrator.mjs'
    );
  }
  if (!orchestratorRaw.includes('function renderLiveStatusLine(')) {
    addFinding(
      'MISSING_LIVE_STATUS_RENDERER',
      'scripts/automation/orchestrator.mjs must include a single-line live status renderer.',
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

function ensureManifestPolicy(configPath) {
  // Config-independent policy assets are validated by existence checks.
  // This function intentionally reserves room for future manifest semantic checks.
  if (!configPath) {
    addFinding(
      'MISSING_CONFIG_PATH',
      'Could not resolve config path while validating policy-manifest requirements.'
    );
  }
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

  const runtimeContextPath = String(config?.context?.runtimeContextPath ?? '').trim();
  if (!runtimeContextPath) {
    addFinding(
      'MISSING_RUNTIME_CONTEXT_PATH',
      "context.runtimeContextPath must be set.",
      rel(configPath)
    );
  }

  const maxTokens = Number.parseInt(String(config?.context?.maxTokens ?? ''), 10);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    addFinding(
      'INVALID_RUNTIME_CONTEXT_MAX_TOKENS',
      'context.maxTokens must be a positive integer.',
      rel(configPath)
    );
  }

  if (config?.logging?.output !== 'pretty') {
    addFinding(
      'PRETTY_NOT_DEFAULT',
      "logging.output must be 'pretty'.",
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
  const heartbeatSeconds = Number.parseInt(String(config?.logging?.heartbeatSeconds ?? ''), 10);
  if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0) {
    addFinding(
      'INVALID_HEARTBEAT_SECONDS',
      'logging.heartbeatSeconds must be a positive integer.',
      rel(configPath)
    );
  }
  const stallWarnSeconds = Number.parseInt(String(config?.logging?.stallWarnSeconds ?? ''), 10);
  if (!Number.isFinite(stallWarnSeconds) || stallWarnSeconds <= 0) {
    addFinding(
      'INVALID_STALL_WARN_SECONDS',
      'logging.stallWarnSeconds must be a positive integer.',
      rel(configPath)
    );
  }
  if (Number.isFinite(heartbeatSeconds) && Number.isFinite(stallWarnSeconds) && stallWarnSeconds < heartbeatSeconds) {
    addFinding(
      'STALL_WARN_TOO_LOW',
      'logging.stallWarnSeconds must be greater than or equal to logging.heartbeatSeconds.',
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

  const stageReuse = config?.roleOrchestration?.stageReuse ?? {};
  if (stageReuse.enabled !== true) {
    addFinding(
      'STAGE_REUSE_DISABLED',
      "roleOrchestration.stageReuse.enabled must be true.",
      rel(configPath)
    );
  }
  const roles = Array.isArray(stageReuse.roles)
    ? stageReuse.roles.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
    : [];
  if (roles.length === 0 || !roles.includes('planner') || !roles.includes('explorer')) {
    addFinding(
      'INVALID_STAGE_REUSE_ROLES',
      "roleOrchestration.stageReuse.roles must include 'planner' and 'explorer'.",
      rel(configPath)
    );
  }
}

async function ensurePragmaticScaffold() {
  const readmePath = path.join(rootDir, 'README.md');
  const liteQuickstartDocPath = path.join(rootDir, 'docs', 'ops', 'automation', 'LITE_QUICKSTART.md');
  const outcomesDocPath = path.join(rootDir, 'docs', 'ops', 'automation', 'OUTCOMES.md');
  const interopDocPath = path.join(rootDir, 'docs', 'ops', 'automation', 'INTEROP_GITHUB.md');
  const providerCompatDocPath = path.join(rootDir, 'docs', 'ops', 'automation', 'PROVIDER_COMPATIBILITY.md');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const scriptsFragmentPath = path.join(rootDir, 'package.scripts.fragment.json');

  const readmeRaw = await readUtf8IfExists(readmePath);
  if (!readmeRaw) {
    addAdvisory('MISSING_README_FOR_ADOPTION_LANES', 'README.md not found for adoption-lane guidance checks.', 'README.md');
  } else {
    if (!readmeRaw.includes('## Adoption Lanes')) {
      addAdvisory(
        'MISSING_ADOPTION_LANES_SECTION',
        "README.md should include an 'Adoption Lanes' section to keep orchestration optional by risk.",
        'README.md'
      );
    }
    for (const lane of ['Lite', 'Guarded', 'Conveyor']) {
      if (!readmeRaw.includes(`\`${lane}\``)) {
        addAdvisory(
          'MISSING_ADOPTION_LANE_ENTRY',
          `README.md should include adoption lane '${lane}'.`,
          'README.md'
        );
      }
    }
    if (!readmeRaw.includes('Lite Quickstart') && !readmeRaw.includes('Lite-First Onboarding')) {
      addAdvisory(
        'MISSING_LITE_QUICKSTART_SECTION',
        "README.md should include a short Lite-first onboarding section for low-overhead adoption.",
        'README.md'
      );
    }
  }

  if (!(await fileExists(liteQuickstartDocPath))) {
    addAdvisory(
      'MISSING_LITE_QUICKSTART_DOC',
      'Expected optional Lite onboarding doc at docs/ops/automation/LITE_QUICKSTART.md.',
      rel(liteQuickstartDocPath)
    );
  }

  if (!(await fileExists(outcomesDocPath))) {
    addAdvisory(
      'MISSING_OUTCOMES_DOC',
      'Expected optional outcomes scorecard doc at docs/ops/automation/OUTCOMES.md.',
      rel(outcomesDocPath)
    );
  }
  if (!(await fileExists(interopDocPath))) {
    addAdvisory(
      'MISSING_INTEROP_DOC',
      'Expected optional GitHub interop mapping doc at docs/ops/automation/INTEROP_GITHUB.md.',
      rel(interopDocPath)
    );
  }
  if (!(await fileExists(providerCompatDocPath))) {
    addAdvisory(
      'MISSING_PROVIDER_COMPAT_DOC',
      'Expected provider compatibility doc at docs/ops/automation/PROVIDER_COMPATIBILITY.md.',
      rel(providerCompatDocPath)
    );
  }

  const scriptsSourcePath = (await fileExists(packageJsonPath)) ? packageJsonPath : scriptsFragmentPath;
  const scriptsSourceRel = rel(scriptsSourcePath);
  const scriptsRaw = await readUtf8IfExists(scriptsSourcePath);
  if (!scriptsRaw) {
    addAdvisory(
      'MISSING_SCRIPT_SOURCE',
      'Could not check optional outcomes/interop scripts because package.json or package.scripts.fragment.json is missing.',
      scriptsSourceRel
    );
    return;
  }

  if (!scriptsRaw.includes('"outcomes:report"')) {
    addAdvisory(
      'MISSING_OUTCOMES_SCRIPT',
      "Add 'outcomes:report' script for optional run outcome summarization.",
      scriptsSourceRel
    );
  }
  if (!scriptsRaw.includes('"interop:github:export"')) {
    addAdvisory(
      'MISSING_GITHUB_INTEROP_SCRIPT',
      "Add 'interop:github:export' script for optional GitHub-native profile export.",
      scriptsSourceRel
    );
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
  ensureManifestPolicy(requiredPaths.config);
  ensureConfigPolicy(config, requiredPaths.config);
  await ensurePragmaticScaffold();

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
  if (advisories.length > 0) {
    console.log(`[blueprint-verify] advisories (${advisories.length}):`);
    for (const advisory of advisories) {
      const pathSuffix = advisory.filePath ? ` (${advisory.filePath})` : '';
      console.log(`- [${advisory.code}] ${advisory.message}${pathSuffix}`);
    }
  }
  console.log(
    `[blueprint-verify] passed (provider=${provider}, pipelineRoles=${roleCount}, output=${config.logging.output}, advisories=${advisories.length}).`
  );
}

main().catch((error) => {
  console.error('[blueprint-verify] failed with an unexpected error.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
