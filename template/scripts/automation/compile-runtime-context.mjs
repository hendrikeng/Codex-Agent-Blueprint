#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_TOKENS = 1400;
const DEFAULT_OUTPUT_PATH = 'docs/generated/AGENT-RUNTIME-CONTEXT.md';
const DEFAULT_POLICY_PATH = 'docs/governance/policy-manifest.json';
const DEFAULT_AGENTS_PATH = 'AGENTS.md';
const DEFAULT_MEMORY_CONTEXT_PATH = 'docs/agent-hardening/MEMORY_CONTEXT.md';
const DEFAULT_CONFIG_PATH = 'docs/ops/automation/orchestrator.config.json';

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

function asInteger(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(content, heading) {
  const pattern = new RegExp(
    `^##\\s+${escapeRegex(heading)}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    'm'
  );
  const match = content.match(pattern);
  if (!match) {
    return '';
  }
  return match[1].trim();
}

function extractBullets(sectionContent, maxItems = 6) {
  const bullets = [];
  for (const line of sectionContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) {
      continue;
    }
    bullets.push(trimmed.slice(2).trim());
    if (bullets.length >= maxItems) {
      break;
    }
  }
  return bullets;
}

function summarizeSentence(value, maxWords = 16) {
  const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function normalizeRuleList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => entry && typeof entry === 'object');
}

function normalizeStringList(value, maxItems = 6) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .slice(0, Math.max(0, maxItems));
}

function normalizeMemoryPosture(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    whatToDo: normalizeStringList(source.whatToDo, 5),
    improveBeforeRearchitecture: normalizeStringList(source.improveBeforeRearchitecture, 5),
    doNotAddYet: normalizeStringList(source.doNotAddYet, 4),
    escalateWhen: normalizeStringList(source.escalateWhen, 4),
    safeRule: String(source.safeRule ?? '').trim()
  };
}

function approximateTokenCount(content) {
  const normalized = String(content ?? '').trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function normalizeGeneratedAtLine(content) {
  return String(content ?? '').replace(/^Generated At:\s+.*$/m, 'Generated At: <normalized>');
}

function ensureManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Policy manifest must be a JSON object.');
  }
  if (!Array.isArray(manifest.mandatorySafetyRules) || manifest.mandatorySafetyRules.length === 0) {
    throw new Error('policy-manifest.json requires non-empty mandatorySafetyRules.');
  }
  if (!manifest.roleContracts || typeof manifest.roleContracts !== 'object') {
    throw new Error('policy-manifest.json requires roleContracts object.');
  }
  if (!manifest.validationPolicy || typeof manifest.validationPolicy !== 'object') {
    throw new Error('policy-manifest.json requires validationPolicy object.');
  }
  if (!manifest.memoryPosture || typeof manifest.memoryPosture !== 'object') {
    throw new Error('policy-manifest.json requires memoryPosture object.');
  }
}

function pipelineSummary(config) {
  const pipelines = config?.roleOrchestration?.pipelines ?? {};
  const low = Array.isArray(pipelines.low) ? pipelines.low : ['worker'];
  const medium = Array.isArray(pipelines.medium) ? pipelines.medium : ['planner', 'worker', 'reviewer'];
  const high = Array.isArray(pipelines.high) ? pipelines.high : ['planner', 'explorer', 'worker', 'reviewer'];
  return {
    low: low.join(' -> '),
    medium: medium.join(' -> '),
    high: high.join(' -> ')
  };
}

function buildRuntimeContext({
  missionBullets,
  mandatoryRules,
  memoryPosture,
  roleContracts,
  pipelines,
  validationPolicy,
  docContract,
  gitSafetyContract,
  includeRoleIntents,
  includeDocContract
}) {
  const lines = [];
  lines.push('# Agent Runtime Context (Generated)');
  lines.push('');
  lines.push(`Generated At: ${new Date().toISOString()}`);
  lines.push('Primary Sources: AGENTS.md, docs/agent-hardening/MEMORY_CONTEXT.md, docs/governance/policy-manifest.json, docs/ops/automation/orchestrator.config.json');
  lines.push('');
  lines.push('## Mission');
  for (const bullet of missionBullets) {
    lines.push(`- ${bullet}`);
  }
  lines.push('');
  lines.push('## Hard Safety Rules');
  for (const rule of mandatoryRules) {
    lines.push(`- [${rule.id}] ${rule.statement}`);
  }
  lines.push('');
  lines.push('## Risk Pipelines');
  lines.push(`- low: ${pipelines.low}`);
  lines.push(`- medium: ${pipelines.medium}`);
  lines.push(`- high: ${pipelines.high}`);
  lines.push('');
  lines.push('## Role Contracts');

  for (const [role, contract] of Object.entries(roleContracts)) {
    const detail = [];
    detail.push(`sandbox=${contract.sandboxMode}`);
    detail.push(`reasoning=${contract.reasoningEffort}`);
    if (includeRoleIntents) {
      detail.push(`intent=${summarizeSentence(contract.intent, 18)}`);
    }
    lines.push(`- ${role}: ${detail.join(', ')}`);
  }

  lines.push('');
  lines.push('## Verification Profiles');
  lines.push(`- fast: ${validationPolicy.fastIteration.join(' ; ')}`);
  lines.push(`- full: ${validationPolicy.fullGate.join(' ; ')}`);
  lines.push('');
  lines.push('## Memory Posture');
  for (const bullet of memoryPosture.whatToDo) {
    lines.push(`- do: ${bullet}`);
  }
  if (memoryPosture.improveBeforeRearchitecture.length > 0) {
    lines.push(`- improve first: ${memoryPosture.improveBeforeRearchitecture.join(' ; ')}`);
  }
  if (memoryPosture.doNotAddYet.length > 0) {
    lines.push(`- not yet: ${memoryPosture.doNotAddYet.join(' ; ')}`);
  }
  if (memoryPosture.escalateWhen.length > 0) {
    lines.push(`- escalate when: ${memoryPosture.escalateWhen.join(' ; ')}`);
  }
  if (memoryPosture.safeRule) {
    lines.push(`- safe rule: ${memoryPosture.safeRule}`);
  }
  lines.push('');
  lines.push('## Git Safety');
  for (const entry of gitSafetyContract.forbiddenWithoutExplicitInstruction ?? []) {
    lines.push(`- forbidden-without-instruction: ${entry}`);
  }
  if (gitSafetyContract.notes) {
    lines.push(`- ${gitSafetyContract.notes}`);
  }

  if (includeDocContract) {
    lines.push('');
    lines.push('## Documentation Contract');
    lines.push(`- Canonical entrypoints: ${(docContract.canonicalEntryPoints ?? []).join(', ')}`);
    for (const item of docContract.requiresSameChangeUpdateFor ?? []) {
      lines.push(`- Update docs in same change when affecting: ${item}`);
    }
  }

  lines.push('');
  lines.push('## Execution Checklist');
  lines.push('- Apply scoped changes only; keep evidence links canonical.');
  lines.push('- Preserve required safety gates and risk-routing behavior.');
  lines.push('- Use fast verification during iteration, full verification before merge.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();

  const outputPath = path.resolve(rootDir, String(options.output ?? DEFAULT_OUTPUT_PATH));
  const policyPath = path.resolve(rootDir, String(options.policy ?? DEFAULT_POLICY_PATH));
  const agentsPath = path.resolve(rootDir, String(options.agents ?? DEFAULT_AGENTS_PATH));
  const memoryContextPath = path.resolve(rootDir, DEFAULT_MEMORY_CONTEXT_PATH);
  const configPath = path.resolve(rootDir, String(options.config ?? DEFAULT_CONFIG_PATH));

  const [manifest, agentsRaw, _memoryContextRaw, orchestratorConfig] = await Promise.all([
    readJson(policyPath),
    fs.readFile(agentsPath, 'utf8'),
    fs.readFile(memoryContextPath, 'utf8'),
    readJson(configPath)
  ]);
  ensureManifestShape(manifest);

  const configuredMaxTokens = asInteger(orchestratorConfig?.context?.maxTokens, DEFAULT_MAX_TOKENS);
  const maxTokens = asInteger(options['max-tokens'], configuredMaxTokens);
  const missionSection = extractSection(agentsRaw, 'Operating Model');
  const missionBulletsRaw = extractBullets(missionSection, 6);
  const fallbackMission = [
    'Use repository-local docs as source of truth.',
    'Humans provide priorities and constraints; agents execute scoped tasks.',
    'Verification and documentation updates are part of done.'
  ];
  const missionBullets = missionBulletsRaw.length > 0 ? missionBulletsRaw : fallbackMission;
  const mandatoryRules = normalizeRuleList(manifest.mandatorySafetyRules);
  const memoryPosture = normalizeMemoryPosture(manifest.memoryPosture);
  const roleContracts = manifest.roleContracts ?? {};
  const validationPolicy = manifest.validationPolicy ?? { fastIteration: [], fullGate: [] };
  const docContract = manifest.docContract ?? {};
  const gitSafetyContract = manifest.gitSafetyContract ?? {};
  const pipelines = pipelineSummary(orchestratorConfig);

  const variants = [
    { includeRoleIntents: true, includeDocContract: true, missionBullets },
    { includeRoleIntents: false, includeDocContract: true, missionBullets },
    { includeRoleIntents: false, includeDocContract: false, missionBullets: missionBullets.slice(0, 3) }
  ];

  let rendered = '';
  let tokenCount = Number.POSITIVE_INFINITY;
  for (const variant of variants) {
    rendered = buildRuntimeContext({
      missionBullets: variant.missionBullets,
      mandatoryRules,
      memoryPosture,
      roleContracts,
      pipelines,
      validationPolicy,
      docContract,
      gitSafetyContract,
      includeRoleIntents: variant.includeRoleIntents,
      includeDocContract: variant.includeDocContract
    });
    tokenCount = approximateTokenCount(rendered);
    if (tokenCount <= maxTokens) {
      break;
    }
  }

  if (tokenCount > maxTokens) {
    throw new Error(`Runtime context is above max token budget (${tokenCount} > ${maxTokens}).`);
  }

  const requiredRules = mandatoryRules.filter((rule) => rule.requiredInRuntimeContext === true);
  for (const rule of requiredRules) {
    if (!rendered.includes(`[${rule.id}]`)) {
      throw new Error(`Runtime context is missing required safety rule id '${rule.id}'.`);
    }
  }

  let existing = null;
  try {
    existing = await fs.readFile(outputPath, 'utf8');
  } catch {
    existing = null;
  }

  if (
    typeof existing === 'string' &&
    normalizeGeneratedAtLine(existing) === normalizeGeneratedAtLine(rendered)
  ) {
    rendered = existing;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (existing !== rendered) {
    await fs.writeFile(outputPath, rendered, 'utf8');
  }

  const rel = toPosix(path.relative(rootDir, outputPath));
  console.log(`[context-compile] wrote ${rel} (${tokenCount} tokens, max ${maxTokens}).`);
}

main().catch((error) => {
  console.error('[context-compile] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
