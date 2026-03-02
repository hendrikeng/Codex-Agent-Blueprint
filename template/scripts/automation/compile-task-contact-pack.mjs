#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  metadataValue,
  parseListField,
  parseMetadata,
  parseRiskTier
} from './lib/plan-metadata.mjs';

const DEFAULT_POLICY_PATH = 'docs/governance/policy-manifest.json';
const DEFAULT_CONFIG_PATH = 'docs/ops/automation/orchestrator.config.json';
const DEFAULT_RUNTIME_CONTEXT_PATH = 'docs/generated/agent-runtime-context.md';
const DEFAULT_OUTPUT_PATH = 'docs/ops/automation/runtime/contacts/manual/contact-pack.md';
const DEFAULT_MAX_POLICY_BULLETS = 10;
const DEFAULT_MAX_RECENT_EVIDENCE_ITEMS = 6;

const ROLE_NAMES = new Set(['planner', 'explorer', 'worker', 'reviewer']);

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
  return String(value).split(path.sep).join('/');
}

function asInteger(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function normalizeRoleName(value, fallback = 'worker') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ROLE_NAMES.has(normalized) ? normalized : fallback;
}

function unique(items) {
  return [...new Set(items.map((entry) => String(entry ?? '').trim()).filter(Boolean))];
}

function summarizeSentence(value, maxWords = 24) {
  const words = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function parseEvidenceReferences(raw, maxItems) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const matches = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('- ')) {
      matches.push(trimmed.slice(2).trim());
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      matches.push(trimmed.replace(/^\d+\.\s+/, '').trim());
      continue;
    }
    const bracketMatch = trimmed.match(/\[.+?\]\(.+?\)/);
    if (bracketMatch) {
      matches.push(bracketMatch[0]);
    }
  }
  return unique(matches).slice(0, Math.max(0, maxItems));
}

async function readJsonStrict(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${toPosix(filePath)}: ${message}`);
  }
}

async function readUtf8IfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export async function compileTaskContactPack(input) {
  const rootDir = path.resolve(String(input.rootDir ?? process.cwd()));
  const planId = String(input.planId ?? '').trim();
  const planFile = String(input.planFile ?? '').trim();
  if (!planId) {
    throw new Error('Missing planId for contact-pack compilation.');
  }
  if (!planFile) {
    throw new Error('Missing planFile for contact-pack compilation.');
  }

  const policyPath = path.resolve(rootDir, String(input.policyPath ?? DEFAULT_POLICY_PATH));
  const configPath = path.resolve(rootDir, String(input.configPath ?? DEFAULT_CONFIG_PATH));
  const outputPath = path.resolve(rootDir, String(input.outputPath ?? DEFAULT_OUTPUT_PATH));
  const role = normalizeRoleName(input.role, 'worker');
  const stageIndex = Math.max(1, asInteger(input.stageIndex, 1));
  const stageTotal = Math.max(stageIndex, asInteger(input.stageTotal, stageIndex));

  const [policyManifest, config, planRaw] = await Promise.all([
    readJsonStrict(policyPath),
    readJsonStrict(configPath),
    fs.readFile(path.resolve(rootDir, planFile), 'utf8')
  ]);

  const metadata = parseMetadata(planRaw);
  const dependencies = parseListField(metadataValue(metadata, 'Dependencies'));
  const specTargets = parseListField(metadataValue(metadata, 'Spec-Targets'));
  const tags = parseListField(metadataValue(metadata, 'Tags'));
  const acceptanceCriteria = metadataValue(metadata, 'Acceptance-Criteria') ?? '';
  const declaredRiskTier = parseRiskTier(
    input.declaredRiskTier ?? metadataValue(metadata, 'Risk-Tier'),
    'low'
  );
  const effectiveRiskTier = parseRiskTier(input.effectiveRiskTier, declaredRiskTier);

  const roleContracts = policyManifest?.roleContracts ?? {};
  const validationPolicy = policyManifest?.validationPolicy ?? {};
  const mandatoryRules = Array.isArray(policyManifest?.mandatorySafetyRules)
    ? policyManifest.mandatorySafetyRules.filter((entry) => entry && typeof entry === 'object')
    : [];
  const requiredRules = mandatoryRules.filter((entry) => entry.requiredInRuntimeContext !== false);
  const ruleSource = requiredRules.length > 0 ? requiredRules : mandatoryRules;

  const configuredContactPacks = config?.context?.contactPacks ?? {};
  const maxPolicyBullets = Math.max(
    1,
    asInteger(input.maxPolicyBullets, asInteger(configuredContactPacks.maxPolicyBullets, DEFAULT_MAX_POLICY_BULLETS))
  );
  const maxRecentEvidenceItems = Math.max(
    0,
    asInteger(
      input.maxRecentEvidenceItems,
      asInteger(configuredContactPacks.maxRecentEvidenceItems, DEFAULT_MAX_RECENT_EVIDENCE_ITEMS)
    )
  );
  const includeRecentEvidence = asBoolean(
    input.includeRecentEvidence,
    asBoolean(configuredContactPacks.includeRecentEvidence, true)
  );
  const runtimeContextPath =
    String(input.runtimeContextPath ?? config?.context?.runtimeContextPath ?? DEFAULT_RUNTIME_CONTEXT_PATH).trim() ||
    DEFAULT_RUNTIME_CONTEXT_PATH;

  const roleContract = roleContracts?.[role] ?? {};
  const roleProfile = config?.roleOrchestration?.roleProfiles?.[role] ?? {};

  const evidenceCandidates = [
    path.join(rootDir, 'docs', 'exec-plans', 'evidence-index', `${planId}.md`),
    path.join(rootDir, 'docs', 'exec-plans', 'active', 'evidence', `${planId}.md`)
  ];
  const evidenceReferences = [];
  if (includeRecentEvidence && maxRecentEvidenceItems > 0) {
    for (const evidencePath of evidenceCandidates) {
      const evidenceRaw = await readUtf8IfExists(evidencePath);
      if (!evidenceRaw) {
        continue;
      }
      const parsed = parseEvidenceReferences(evidenceRaw, maxRecentEvidenceItems);
      for (const entry of parsed) {
        evidenceReferences.push(entry);
        if (evidenceReferences.length >= maxRecentEvidenceItems) {
          break;
        }
      }
      if (evidenceReferences.length >= maxRecentEvidenceItems) {
        break;
      }
    }
  }

  const renderedRules = ruleSource.slice(0, maxPolicyBullets);
  const lines = [];
  lines.push('# Task Contact Pack');
  lines.push('');
  lines.push(`Generated At: ${new Date().toISOString()}`);
  lines.push(`Plan-ID: ${planId}`);
  lines.push(`Plan-File: ${toPosix(planFile)}`);
  lines.push(`Role: ${role}`);
  lines.push(`Risk: declared=${declaredRiskTier}, effective=${effectiveRiskTier}`);
  lines.push(`Stage: ${stageIndex}/${stageTotal}`);
  lines.push(`Runtime-Context: ${toPosix(runtimeContextPath)}`);
  lines.push('');
  lines.push('## Task Scope');
  lines.push(`- Acceptance criteria: ${summarizeSentence(acceptanceCriteria || 'See plan metadata for acceptance criteria.', 28)}`);
  lines.push(`- Dependencies: ${dependencies.length > 0 ? dependencies.join(', ') : 'none'}`);
  lines.push(`- Spec targets: ${specTargets.length > 0 ? specTargets.join(', ') : 'none'}`);
  lines.push(`- Tags: ${tags.length > 0 ? tags.join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Hard Safety Rules');
  if (renderedRules.length === 0) {
    lines.push('- none');
  } else {
    for (const rule of renderedRules) {
      lines.push(`- [${rule.id}] ${rule.statement}`);
    }
  }
  lines.push('');
  lines.push('## Role Contract');
  lines.push(`- intent: ${summarizeSentence(roleContract?.intent ?? 'No role intent configured.', 22)}`);
  lines.push(`- sandbox: ${String(roleContract?.sandboxMode ?? roleProfile?.sandboxMode ?? 'n/a').trim()}`);
  lines.push(`- reasoning: ${String(roleContract?.reasoningEffort ?? roleProfile?.reasoningEffort ?? 'n/a').trim()}`);
  lines.push(`- profile model: ${String(roleProfile?.model ?? 'n/a').trim() || 'n/a'}`);
  lines.push(`- role instructions: ${summarizeSentence(roleProfile?.instructions ?? 'No role instructions configured.', 24)}`);
  lines.push('');
  lines.push('## Verification Expectations');
  const fastCommands = Array.isArray(validationPolicy.fastIteration) ? validationPolicy.fastIteration : [];
  const fullCommands = Array.isArray(validationPolicy.fullGate) ? validationPolicy.fullGate : [];
  lines.push(`- fast: ${fastCommands.length > 0 ? fastCommands.join(' ; ') : 'none configured'}`);
  lines.push(`- full: ${fullCommands.length > 0 ? fullCommands.join(' ; ') : 'none configured'}`);
  lines.push('');
  lines.push('## Recent Evidence');
  if (!includeRecentEvidence) {
    lines.push('- skipped (includeRecentEvidence=false)');
  } else if (evidenceReferences.length === 0) {
    lines.push('- none');
  } else {
    for (const entry of evidenceReferences) {
      lines.push(`- ${entry}`);
    }
  }
  lines.push('');
  lines.push('## Contact Boundaries');
  lines.push('- Use this pack as the primary context for this role session.');
  lines.push('- Expand beyond this pack only for explicit blockers tied to current scope.');
  lines.push('- Keep edits scoped to the active plan, canonical evidence, and required implementation files.');
  lines.push('');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const rendered = `${lines.join('\n')}\n`;
  await fs.writeFile(outputPath, rendered, 'utf8');

  const outputRel = toPosix(path.relative(rootDir, outputPath));
  return {
    outputPath: outputRel,
    bytes: Buffer.byteLength(rendered, 'utf8'),
    lineCount: lines.length,
    policyRuleCount: renderedRules.length,
    evidenceCount: evidenceReferences.length
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await compileTaskContactPack({
    rootDir: options['root-dir'] ?? process.cwd(),
    planId: options['plan-id'],
    planFile: options['plan-file'],
    role: options.role,
    declaredRiskTier: options['declared-risk-tier'],
    effectiveRiskTier: options['effective-risk-tier'],
    stageIndex: options['stage-index'],
    stageTotal: options['stage-total'],
    outputPath: options.output,
    policyPath: options.policy,
    configPath: options.config,
    runtimeContextPath: options['runtime-context-path'],
    maxPolicyBullets: options['max-policy-bullets'],
    includeRecentEvidence: options['include-recent-evidence'],
    maxRecentEvidenceItems: options['max-recent-evidence-items']
  });
  console.log(
    `[contact-pack] wrote ${result.outputPath} (rules=${result.policyRuleCount}, evidence=${result.evidenceCount}, bytes=${result.bytes}).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[contact-pack] failed.');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
