#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_AGENTS_PATH = 'AGENTS.md';
const DEFAULT_POLICY_PATH = 'docs/governance/policy-manifest.json';
const DEFAULT_CONFIG_PATH = 'docs/ops/automation/orchestrator.config.json';
const DEFAULT_REPORT_PATH = 'docs/generated/github-agent-export.json';
const DEFAULT_PROFILES_DIR = '.github/agents';

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

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${toPosix(filePath)}: ${message}`);
  }
}

function extractDocRefs(agentsRaw) {
  const refs = new Set();
  const regex = /`(AGENTS\.md|README\.md|ARCHITECTURE\.md|docs\/[A-Za-z0-9_./-]+\.(?:md|json|ya?ml))`/g;
  for (const match of agentsRaw.matchAll(regex)) {
    refs.add(match[1]);
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function normalizeRoleProfiles(config) {
  const source = config?.roleOrchestration?.roleProfiles ?? {};
  const result = {};
  for (const [role, profile] of Object.entries(source)) {
    if (!profile || typeof profile !== 'object') {
      continue;
    }
    result[role] = {
      model: String(profile.model ?? '').trim(),
      reasoningEffort: String(profile.reasoningEffort ?? '').trim(),
      sandboxMode: String(profile.sandboxMode ?? '').trim(),
      instructions: String(profile.instructions ?? '').trim()
    };
  }
  return result;
}

function normalizePipelines(config) {
  const pipelines = config?.roleOrchestration?.pipelines ?? {};
  return {
    low: Array.isArray(pipelines.low) ? pipelines.low : ['worker'],
    medium: Array.isArray(pipelines.medium) ? pipelines.medium : ['planner', 'worker', 'reviewer'],
    high: Array.isArray(pipelines.high) ? pipelines.high : ['planner', 'explorer', 'worker', 'reviewer']
  };
}

function normalizeMandatoryRules(manifest) {
  return Array.isArray(manifest?.mandatorySafetyRules)
    ? manifest.mandatorySafetyRules.map((rule) => ({
        id: String(rule.id ?? '').trim(),
        statement: String(rule.statement ?? '').trim(),
        requiredInRuntimeContext: Boolean(rule.requiredInRuntimeContext)
      }))
    : [];
}

function yamlScalar(value) {
  const text = String(value ?? '');
  const safe = /^[A-Za-z0-9_.:/@+-]+$/.test(text);
  if (safe) {
    return text;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function renderFrontmatter(entries) {
  const lines = ['---'];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function renderRoleAgentMarkdown(role, profile, pipelines, mandatoryRules, canonicalEntrypoints) {
  const roleName = titleCase(role);
  const frontmatter = renderFrontmatter([
    ['name', `blueprint-${role}`],
    ['description', `${roleName} role scaffold exported from Agent-Blueprint governance.`],
    ['model', profile.model || 'set-model']
  ]);

  const requiredRules = mandatoryRules.filter((rule) => rule.requiredInRuntimeContext === true);
  const lines = [];
  lines.push(frontmatter);
  lines.push('');
  lines.push(`# Blueprint ${roleName} Agent`);
  lines.push('');
  lines.push('This profile is generated from repository governance and is safe to customize for your repo.');
  lines.push('');
  lines.push('## Role Contract');
  lines.push(`- Role: \`${role}\``);
  lines.push(`- Reasoning effort: \`${profile.reasoningEffort || 'high'}\``);
  lines.push(`- Sandbox mode: \`${profile.sandboxMode || 'read-only'}\``);
  if (profile.instructions) {
    lines.push(`- Intent: ${profile.instructions}`);
  }
  lines.push('');
  lines.push('## Risk Pipelines');
  lines.push(`- low: \`${pipelines.low.join(' -> ')}\``);
  lines.push(`- medium: \`${pipelines.medium.join(' -> ')}\``);
  lines.push(`- high: \`${pipelines.high.join(' -> ')}\``);
  lines.push('');
  lines.push('## Hard Rules (Required)');
  for (const rule of requiredRules) {
    lines.push(`- [${rule.id}] ${rule.statement}`);
  }
  lines.push('');
  lines.push('## Canonical Entrypoints');
  for (const entry of canonicalEntrypoints) {
    lines.push(`- \`${entry}\``);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('- Keep this profile aligned with `docs/governance/policy-manifest.json`.');
  lines.push('- GitHub.com may ignore some frontmatter capabilities that IDE integrations support.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderDefaultAgentMarkdown(pipelines, canonicalEntrypoints) {
  const frontmatter = renderFrontmatter([
    ['name', 'blueprint-default'],
    ['description', 'Default blueprint agent profile scaffold with lane-aware guidance.'],
    ['model', 'set-model']
  ]);

  const lines = [];
  lines.push(frontmatter);
  lines.push('');
  lines.push('# Blueprint Default Agent');
  lines.push('');
  lines.push('Use the least process that still protects correctness.');
  lines.push('');
  lines.push('## Adoption Lanes');
  lines.push('- Lite: manual loop (`active -> completed`) with `verify:fast` and `verify:full`.');
  lines.push('- Guarded: sequential orchestration with risk and approval gates.');
  lines.push('- Conveyor: parallel/worktree orchestration for bounded, dependency-safe slices.');
  lines.push('');
  lines.push('## Risk Pipelines');
  lines.push(`- low: \`${pipelines.low.join(' -> ')}\``);
  lines.push(`- medium: \`${pipelines.medium.join(' -> ')}\``);
  lines.push(`- high: \`${pipelines.high.join(' -> ')}\``);
  lines.push('');
  lines.push('## Canonical Entrypoints');
  for (const entry of canonicalEntrypoints) {
    lines.push(`- \`${entry}\``);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('- This scaffold is provider-agnostic and should be adapted to platform-specific schema support.');
  lines.push('- Keep `docs/ops/automation/PROVIDER_COMPATIBILITY.md` in sync when changing provider commands.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function renderProfilesReadme() {
  return `# Exported Agent Profiles\n\nGenerated by \`interop:github:export\`.\n\nFiles:\n- \`*.agent.md\`: GitHub custom-agent scaffolds with YAML frontmatter.\n- \`*.json\`: machine-readable governance snapshots for tooling bridges.\n\nNotes:\n- GitHub.com and IDE integrations may differ in supported frontmatter properties (for example, model and handoffs).\n- Treat these files as scaffolds and keep canonical policy in \`docs/governance/*\`.\n`;
}

async function writeFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();

  const agentsPath = path.resolve(rootDir, String(options.agents ?? DEFAULT_AGENTS_PATH));
  const policyPath = path.resolve(rootDir, String(options.policy ?? DEFAULT_POLICY_PATH));
  const configPath = path.resolve(rootDir, String(options.config ?? DEFAULT_CONFIG_PATH));
  const reportPath = path.resolve(rootDir, String(options.output ?? DEFAULT_REPORT_PATH));
  const profilesDir = path.resolve(rootDir, String(options['profiles-dir'] ?? DEFAULT_PROFILES_DIR));

  const writeProfiles = parseBoolean(options['write-profiles'], false);
  const dryRun = parseBoolean(options['dry-run'], !writeProfiles);
  const shouldWriteProfiles = writeProfiles && !dryRun;

  const [agentsRaw, policyManifest, orchestratorConfig] = await Promise.all([
    fs.readFile(agentsPath, 'utf8'),
    readJson(policyPath),
    readJson(configPath)
  ]);

  const roleProfiles = normalizeRoleProfiles(orchestratorConfig);
  const riskPipelines = normalizePipelines(orchestratorConfig);
  const mandatorySafetyRules = normalizeMandatoryRules(policyManifest);

  const canonicalEntrypoints = Array.isArray(policyManifest?.docContract?.canonicalEntryPoints)
    ? policyManifest.docContract.canonicalEntryPoints
    : [];

  const extractedEntrypoints = extractDocRefs(agentsRaw);

  const basePolicy = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      policyManifest: toPosix(path.relative(rootDir, policyPath)),
      agents: toPosix(path.relative(rootDir, agentsPath))
    },
    mandatorySafetyRules,
    docContract: policyManifest?.docContract ?? {},
    gitSafetyContract: policyManifest?.gitSafetyContract ?? {}
  };

  const roleProfilesPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      orchestratorConfig: toPosix(path.relative(rootDir, configPath))
    },
    roleProfiles,
    provider: String(orchestratorConfig?.executor?.provider ?? 'codex').trim().toLowerCase()
  };

  const riskPipelinesPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      orchestratorConfig: toPosix(path.relative(rootDir, configPath))
    },
    pipelines: riskPipelines,
    riskModel: orchestratorConfig?.roleOrchestration?.riskModel ?? {},
    approvalGates: orchestratorConfig?.roleOrchestration?.approvalGates ?? {},
    validation: orchestratorConfig?.validation ?? {}
  };

  const roleAgentFiles = Object.entries(roleProfiles).map(([role, profile]) => ({
    path: path.join(profilesDir, `blueprint-${role}.agent.md`),
    relPath: toPosix(path.relative(rootDir, path.join(profilesDir, `blueprint-${role}.agent.md`))),
    payload: renderRoleAgentMarkdown(role, profile, riskPipelines, mandatorySafetyRules, canonicalEntrypoints)
  }));

  const exportFiles = [
    {
      path: path.join(profilesDir, 'base-policy.json'),
      relPath: toPosix(path.relative(rootDir, path.join(profilesDir, 'base-policy.json'))),
      payload: `${JSON.stringify(basePolicy, null, 2)}\n`
    },
    {
      path: path.join(profilesDir, 'role-profiles.json'),
      relPath: toPosix(path.relative(rootDir, path.join(profilesDir, 'role-profiles.json'))),
      payload: `${JSON.stringify(roleProfilesPayload, null, 2)}\n`
    },
    {
      path: path.join(profilesDir, 'risk-pipelines.json'),
      relPath: toPosix(path.relative(rootDir, path.join(profilesDir, 'risk-pipelines.json'))),
      payload: `${JSON.stringify(riskPipelinesPayload, null, 2)}\n`
    },
    {
      path: path.join(profilesDir, 'blueprint-default.agent.md'),
      relPath: toPosix(path.relative(rootDir, path.join(profilesDir, 'blueprint-default.agent.md'))),
      payload: renderDefaultAgentMarkdown(riskPipelines, canonicalEntrypoints)
    },
    {
      path: path.join(profilesDir, 'README.md'),
      relPath: toPosix(path.relative(rootDir, path.join(profilesDir, 'README.md'))),
      payload: renderProfilesReadme()
    },
    ...roleAgentFiles
  ];

  if (shouldWriteProfiles) {
    for (const file of exportFiles) {
      await writeFile(file.path, file.payload);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: {
      dryRun,
      writeProfilesRequested: writeProfiles,
      wroteProfiles: shouldWriteProfiles
    },
    inputs: {
      agents: toPosix(path.relative(rootDir, agentsPath)),
      policyManifest: toPosix(path.relative(rootDir, policyPath)),
      orchestratorConfig: toPosix(path.relative(rootDir, configPath))
    },
    mapping: {
      agentProfileFormat: '.agent.md with YAML frontmatter',
      safetyPolicy: 'policy-manifest.mandatorySafetyRules -> base-policy.json + role .agent.md hard rules section',
      roleProfiles: 'roleOrchestration.roleProfiles -> role-profiles.json + blueprint-<role>.agent.md',
      riskRouting: 'roleOrchestration.pipelines -> risk-pipelines.json + .agent.md lane sections',
      validationLanes: 'validation -> risk-pipelines.json',
      canonicalEntrypoints: {
        fromPolicyManifest: canonicalEntrypoints,
        discoveredFromAgentsMd: extractedEntrypoints
      },
      platformNotes: {
        githubCom: 'Some profile properties may be ignored; treat these as scaffolds.',
        ideIntegrations: 'Richer profile properties may be supported depending on IDE and extension versions.'
      }
    },
    files: exportFiles.map((file) => ({
      path: file.relPath,
      status: shouldWriteProfiles ? 'written' : 'preview-only'
    })),
    notes: [
      'This export is a scaffold and may require platform-specific schema adjustments.',
      'Blueprint governance remains canonical; exported files should be treated as derived artifacts.'
    ]
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `[github-interop-export] wrote ${toPosix(path.relative(rootDir, reportPath))} (dryRun=${dryRun}, wroteProfiles=${shouldWriteProfiles}, files=${exportFiles.length}).`
  );
}

main().catch((error) => {
  console.error('[github-interop-export] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
