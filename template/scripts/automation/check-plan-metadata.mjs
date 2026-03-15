#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_STATUSES,
  CAPABILITY_PROOF_MAP_SECTION,
  COMPLETED_STATUSES,
  COVERAGE_SECTION_TITLES,
  DELIVERY_CLASSES,
  EXECUTION_SCOPES,
  FUTURE_STATUSES,
  PROOF_FRESHNESS_VALUES,
  PROOF_LANES,
  PROOF_TYPES,
  REQUIRED_METADATA_FIELDS,
  RISK_TIERS,
  SECURITY_APPROVAL_VALUES,
  collectUnfinishedCoverageRows,
  extractProgramChildUnitDeclarations,
  listMarkdownFiles,
  metadataValue,
  parseCapabilityProofMap,
  parseMustLandChecklist,
  parseDeliveryClass,
  parseExecutionScope,
  parseListField,
  parseMetadata,
  parsePlanId,
  normalizeStatus,
  inferPlanId
} from './lib/plan-metadata.mjs';

const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const rootDir = process.cwd();
const validationResultPath = String(process.env.ORCH_VALIDATION_RESULT_PATH ?? '').trim();
const directories = {
  future: path.join(rootDir, 'docs', 'future'),
  active: path.join(rootDir, 'docs', 'exec-plans', 'active'),
  completed: path.join(rootDir, 'docs', 'exec-plans', 'completed')
};

const findings = [];
const advisories = [];
const autoHeals = [];
const MUST_LAND_SECTION = 'Must-Land Checklist';
const DEFERRED_SECTION = 'Deferred Follow-Ons';
const BASELINE_SECTION = 'Already-True Baseline';
const PROMOTION_BLOCKERS_SECTION = 'Promotion Blockers';
const RECONCILIATION_SECTION = 'Prior Completed Plan Reconciliation';

function addFinding(code, message, filePath) {
  findings.push({ code, message, filePath });
}

function addAutoHeal(filePath, fromStatus, toStatus) {
  autoHeals.push({ filePath, fromStatus, toStatus });
}

function addAdvisory(code, message, filePath) {
  advisories.push({ code, message, filePath });
}

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

function normalizePlanId(value) {
  const rendered = String(value ?? '').trim().toLowerCase();
  if (!rendered) {
    return null;
  }
  return PLAN_ID_REGEX.test(rendered) ? rendered : null;
}

function normalizeTargetPathValue(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function implementationTargetCategory(value) {
  const normalized = normalizeTargetPathValue(value);
  if (!normalized) {
    return '';
  }
  const baseName = path.posix.basename(normalized).toLowerCase();
  const lower = normalized.toLowerCase();
  if (lower.startsWith('docs/')) {
    return 'docs';
  }
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) {
    return 'docs';
  }
  if (
    baseName.endsWith('.spec.ts') ||
    baseName.endsWith('.spec.tsx') ||
    baseName.endsWith('.spec.js') ||
    baseName.endsWith('.spec.jsx') ||
    baseName.endsWith('.test.ts') ||
    baseName.endsWith('.test.tsx') ||
    baseName.endsWith('.test.js') ||
    baseName.endsWith('.test.jsx') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/test/') ||
    normalized.includes('/e2e/')
  ) {
    return 'tests';
  }
  if (
    baseName === 'package-lock.json' ||
    baseName === 'pnpm-lock.yaml' ||
    baseName === 'yarn.lock' ||
    baseName === 'bun.lockb'
  ) {
    return 'lockfiles';
  }
  if (
    baseName === 'package.json' ||
    baseName === 'tsconfig.json' ||
    baseName === 'tsconfig.base.json' ||
    baseName === 'turbo.json' ||
    baseName === 'components.json' ||
    baseName === 'biome.json' ||
    baseName === 'biome.jsonc' ||
    baseName === 'eslint.config.js' ||
    baseName === 'eslint.config.mjs' ||
    baseName === 'eslint.config.cjs' ||
    baseName === 'eslint.config.ts' ||
    baseName === 'vitest.config.js' ||
    baseName === 'vitest.config.mjs' ||
    baseName === 'vitest.config.cjs' ||
    baseName === 'vitest.config.ts' ||
    baseName === 'jest.config.js' ||
    baseName === 'jest.config.mjs' ||
    baseName === 'jest.config.cjs' ||
    baseName === 'jest.config.ts' ||
    baseName === 'playwright.config.js' ||
    baseName === 'playwright.config.mjs' ||
    baseName === 'playwright.config.cjs' ||
    baseName === 'playwright.config.ts' ||
    baseName === 'vite.config.js' ||
    baseName === 'vite.config.mjs' ||
    baseName === 'vite.config.cjs' ||
    baseName === 'vite.config.ts' ||
    baseName === 'next.config.js' ||
    baseName === 'next.config.mjs' ||
    baseName === 'next.config.cjs' ||
    baseName === 'next.config.ts' ||
    baseName === 'tailwind.config.js' ||
    baseName === 'tailwind.config.mjs' ||
    baseName === 'tailwind.config.cjs' ||
    baseName === 'tailwind.config.ts' ||
    baseName === 'pnpm-workspace.yaml' ||
    baseName === 'pnpm-workspace.yml' ||
    baseName.startsWith('.eslintrc') ||
    baseName.startsWith('.prettierrc')
  ) {
    return 'configs';
  }
  if (
    lower.startsWith('config/') ||
    lower.startsWith('configs/') ||
    lower.startsWith('db/') ||
    lower.startsWith('migrations/') ||
    lower.startsWith('prisma/') ||
    lower.startsWith('sql/') ||
    lower.startsWith('apps/') ||
    lower.startsWith('libs/') ||
    lower.startsWith('packages/') ||
    lower.startsWith('src/')
  ) {
    return 'source';
  }
  if (lower.startsWith('scripts/')) {
    return 'scripts';
  }
  return 'other';
}

function isSupportedImplementationTarget(value) {
  const category = implementationTargetCategory(value);
  return (
    category === 'source' ||
    category === 'tests' ||
    category === 'scripts' ||
    category === 'configs' ||
    category === 'lockfiles'
  );
}

function isSourceImplementationTarget(value) {
  return implementationTargetCategory(value) === 'source';
}

function sectionBounds(content, sectionTitle) {
  const regex = new RegExp(`^##\\s+${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = regex.exec(content);
  if (!match || match.index == null) {
    return null;
  }

  const start = match.index;
  const bodyStart = start + match[0].length;
  const remainder = content.slice(bodyStart);
  const nextSectionMatch = /^##\s+/m.exec(remainder);
  const end = nextSectionMatch && nextSectionMatch.index != null
    ? bodyStart + nextSectionMatch.index
    : content.length;
  return { start, bodyStart, end };
}

function sectionBody(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return '';
  }
  return content.slice(bounds.bodyStart, bounds.end).trim();
}

function firstSectionBody(content, sectionTitles) {
  for (const title of sectionTitles) {
    const body = sectionBody(content, title);
    if (body) {
      return { title, body };
    }
  }
  return { title: null, body: '' };
}

function checkboxLines(sectionContent) {
  if (!sectionContent) {
    return [];
  }
  return sectionContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+\[[ xX]\]\s+/.test(line));
}

function uncheckedCheckboxLines(lines) {
  return lines.filter((line) => /^-\s+\[\s\]\s+/.test(line));
}

function normalizeProofMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'required') {
    return 'required';
  }
  return 'advisory';
}

async function loadAutomationConfig() {
  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function collectConfiguredValidationIds(config) {
  const ids = new Set();
  const record = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return;
    }
    const id = String(entry.id ?? '').trim();
    if (id) {
      ids.add(id);
    }
  };
  for (const entry of config?.validation?.always ?? []) {
    record(entry);
  }
  for (const entry of config?.validation?.hostRequired ?? []) {
    record(entry);
  }
  return ids;
}

function isArtifactValidationReference(value) {
  const normalized = String(value ?? '').trim();
  return (
    normalized.startsWith('docs/') ||
    normalized.startsWith('apps/') ||
    normalized.startsWith('packages/') ||
    normalized.startsWith('scripts/') ||
    normalized.startsWith('prisma/') ||
    normalized.endsWith('.md') ||
    normalized.endsWith('.json') ||
    normalized.endsWith('.log')
  );
}

function reportSemanticProofIssue(proofMode, code, message, filePath, forceError = false) {
  if (forceError || proofMode === 'required') {
    addFinding(code, message, filePath);
    return;
  }
  addAdvisory(code, message, filePath);
}

async function writeValidationResult(payload) {
  if (!validationResultPath) {
    return;
  }
  const absPath = path.join(rootDir, validationResultPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function candidatePlanScopeIds(plan, targetPlanId) {
  const candidates = new Set();
  if (plan.planId === targetPlanId) {
    candidates.add(targetPlanId);
  }
  const rel = String(plan.rel ?? '').trim().toLowerCase();
  if (rel.endsWith(`/${targetPlanId}.md`) || rel.endsWith(`-${targetPlanId}.md`)) {
    candidates.add(targetPlanId);
  }
  return candidates;
}

function expandScopedPlanIds(allPlans, targetPlanId) {
  const scopedPlanIds = new Set();
  const queue = [];

  for (const plan of allPlans) {
    if (candidatePlanScopeIds(plan, targetPlanId).size === 0 || !plan.planId) {
      continue;
    }
    if (!scopedPlanIds.has(plan.planId)) {
      scopedPlanIds.add(plan.planId);
      queue.push(plan.planId);
    }
  }

  while (queue.length > 0) {
    const currentPlanId = queue.shift();
    for (const plan of allPlans) {
      const relatesToCurrent = plan.planId === currentPlanId || plan.parentPlanId === currentPlanId;
      if (!relatesToCurrent) {
        continue;
      }
      if (plan.planId && !scopedPlanIds.has(plan.planId)) {
        scopedPlanIds.add(plan.planId);
        queue.push(plan.planId);
      }
      if (plan.parentPlanId && !scopedPlanIds.has(plan.parentPlanId)) {
        scopedPlanIds.add(plan.parentPlanId);
        queue.push(plan.parentPlanId);
      }
    }
  }

  return scopedPlanIds;
}

async function scanPhase(phase, directoryPath) {
  const files = await listMarkdownFiles(directoryPath);
  const plans = [];

  for (const filePath of files) {
    const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
    let content = await fs.readFile(filePath, 'utf8');
    let metadata = parseMetadata(content);
    const rawPlanId = metadataValue(metadata, 'Plan-ID');
    const parsedPlanId = rawPlanId ? parsePlanId(rawPlanId, null) : null;
    const inferredPlanId = parsedPlanId ?? inferPlanId(content, filePath);
    const topLevelStatusMatch = content.match(/^Status:\s*(.+)$/m);
    const topLevelStatus = normalizeStatus(topLevelStatusMatch?.[1] ?? '');
    const topLevelValidationReadyMatch = content.match(/^Validation-Ready:\s*(.+)$/m);
    const topLevelValidationReady = normalizeStatus(topLevelValidationReadyMatch?.[1] ?? '');
    const metadataStatus = normalizeStatus(metadataValue(metadata, 'Status'));
    const metadataValidationReady = normalizeStatus(metadataValue(metadata, 'Validation-Ready'));
    const scopedRepairPlanId = scanPhase.scopedRepairPlanId ?? null;
    const inRepairScope = !scopedRepairPlanId || inferredPlanId === scopedRepairPlanId;
    const autoHealEnabled = scanPhase.autoHealEnabled === true;

    if (
      autoHealEnabled &&
      inRepairScope &&
      topLevelStatusMatch &&
      topLevelStatus &&
      metadataStatus &&
      topLevelStatus !== metadataStatus
    ) {
      const updatedContent = content.replace(/^Status:\s*.+$/m, `Status: ${metadataStatus}`);
      if (updatedContent !== content) {
        await fs.writeFile(filePath, updatedContent, 'utf8');
        addAutoHeal(rel, topLevelStatus, metadataStatus);
        content = updatedContent;
        metadata = parseMetadata(content);
      }
    }
    if (
      autoHealEnabled &&
      inRepairScope &&
      topLevelValidationReadyMatch &&
      topLevelValidationReady &&
      metadataValidationReady &&
      topLevelValidationReady !== metadataValidationReady
    ) {
      const updatedContent = content.replace(/^Validation-Ready:\s*.+$/m, `Validation-Ready: ${metadataValidationReady}`);
      if (updatedContent !== content) {
        await fs.writeFile(filePath, updatedContent, 'utf8');
        content = updatedContent;
        metadata = parseMetadata(content);
      }
    }

    const requiredFields = REQUIRED_METADATA_FIELDS[phase] ?? [];
    for (const field of requiredFields) {
      if (!metadataValue(metadata, field)) {
        addFinding('MISSING_METADATA_FIELD', `Missing metadata field '${field}'`, rel);
      }
    }

    const status = normalizeStatus(metadataValue(metadata, 'Status'));
    const validationReady = normalizeStatus(metadataValue(metadata, 'Validation-Ready'));
    if (!status) {
      addFinding('MISSING_STATUS', 'Missing Status metadata value', rel);
    } else {
      const allowed = phase === 'future'
        ? FUTURE_STATUSES
        : phase === 'active'
          ? ACTIVE_STATUSES
          : COMPLETED_STATUSES;

      if (!allowed.has(status)) {
        addFinding('INVALID_STATUS', `Invalid status '${status}' for ${phase} plan`, rel);
      }
    }

    if (
      phase === 'active' &&
      status === 'validation' &&
      validationReady !== 'yes' &&
      validationReady !== 'host-required-only'
    ) {
      addFinding(
        'VALIDATION_READY_REQUIRED',
        "Active plan with Status 'validation' must set `Validation-Ready` to 'yes' or 'host-required-only'",
        rel
      );
    }

    const normalizedTopLevelStatus = normalizeStatus(content.match(/^Status:\s*(.+)$/m)?.[1] ?? '');
    if (phase === 'active' && normalizedTopLevelStatus && status && normalizedTopLevelStatus !== status) {
      addFinding(
        'CONTRADICTORY_STATUS',
        `Top-level Status is '${normalizedTopLevelStatus}' while metadata Status is '${status}'. Resolve status mismatch before orchestration.`,
        rel
      );
    }

    if (!content.includes('## Metadata')) {
      addFinding('MISSING_METADATA_SECTION', "Missing '## Metadata' section", rel);
    }

    const mustLandBody = sectionBody(content, MUST_LAND_SECTION);
    const mustLandItems = checkboxLines(mustLandBody);
    const incompleteMustLandItems = uncheckedCheckboxLines(mustLandItems);
    const promotionBlockersBody = sectionBody(content, PROMOTION_BLOCKERS_SECTION);
    const coverageSection = firstSectionBody(content, COVERAGE_SECTION_TITLES);
    const unfinishedCoverageRows = collectUnfinishedCoverageRows(content, COVERAGE_SECTION_TITLES);
    const reconciliationBody = sectionBody(content, RECONCILIATION_SECTION);
    const deliveryClassRaw = metadataValue(metadata, 'Delivery-Class');
    const deliveryClass = parseDeliveryClass(deliveryClassRaw, '');
    const executionScopeRaw = metadataValue(metadata, 'Execution-Scope');
    const executionScope = parseExecutionScope(executionScopeRaw, '');
    const parentPlanIdRaw = metadataValue(metadata, 'Parent-Plan-ID');
    const parentPlanId = parentPlanIdRaw ? parsePlanId(parentPlanIdRaw, null) : null;
    const implementationTargetsRaw = parseListField(metadataValue(metadata, 'Implementation-Targets'));
    const implementationTargets = implementationTargetsRaw.map(normalizeTargetPathValue).filter(Boolean);
    const implementationTargetsProvided = implementationTargets.length > 0;
    const productSlicePlan = deliveryClass === 'product' && executionScope === 'slice';
    const proofMode = scanPhase.proofMode ?? 'advisory';
    const configuredValidationIds = scanPhase.configuredValidationIds ?? new Set();
    const reconciliationRequired =
      phase === 'future' || (phase === 'active' && executionScope === 'program');
    const declaredProgramUnits = executionScope === 'program'
      ? extractProgramChildUnitDeclarations(content)
      : [];

    const mustLandRequired = phase === 'future' || phase === 'active';

    if (!mustLandBody && mustLandRequired) {
      addFinding(
        'MISSING_MUST_LAND_SECTION',
        `Missing '## ${MUST_LAND_SECTION}' section`,
        rel
      );
    } else if (mustLandBody && mustLandItems.length === 0) {
      addFinding(
        'EMPTY_MUST_LAND_CHECKLIST',
        `'## ${MUST_LAND_SECTION}' must contain markdown checkbox items`,
        rel
      );
    }

    if (phase === 'future' && !coverageSection.body) {
      addFinding(
        'MISSING_CAPABILITY_COVERAGE_SECTION',
        `Future blueprint must include '## ${COVERAGE_SECTION_TITLES[0]}' or '## ${COVERAGE_SECTION_TITLES[1]}' to reconcile upstream scope explicitly.`,
        rel
      );
    }

    if (phase === 'future' && !promotionBlockersBody) {
      addFinding(
        'MISSING_PROMOTION_BLOCKERS_SECTION',
        `Future blueprint must include '## ${PROMOTION_BLOCKERS_SECTION}' so promotion readiness and unresolved gates are explicit.`,
        rel
      );
    }

    if (reconciliationRequired && !reconciliationBody) {
      addFinding(
        'MISSING_RECONCILIATION_SECTION',
        `Plan must include '## ${RECONCILIATION_SECTION}' so relevant completed plans are explicitly classified as kept, refactored, superseded, obsolete, or reopened.`,
        rel
      );
    }

    const acceptanceCriteria = metadataValue(metadata, 'Acceptance-Criteria') ?? '';
    if ((phase === 'future' || phase === 'active') && /\bat minimum\b/i.test(acceptanceCriteria)) {
      addFinding(
        'AMBIGUOUS_ACCEPTANCE_CRITERIA',
        "Acceptance-Criteria must not use 'at minimum'. Move concrete deliverables into '## Must-Land Checklist' and rewrite the metadata to describe full completion.",
        rel
      );
    }

    const riskTierRaw = metadataValue(metadata, 'Risk-Tier');
    if (riskTierRaw && !RISK_TIERS.has(riskTierRaw.trim().toLowerCase())) {
      addFinding(
        'INVALID_RISK_TIER',
        `Invalid Risk-Tier '${riskTierRaw}' (expected: low|medium|high)`,
        rel
      );
    }

    const securityApprovalRaw = metadataValue(metadata, 'Security-Approval');
    if (securityApprovalRaw && !SECURITY_APPROVAL_VALUES.has(securityApprovalRaw.trim().toLowerCase())) {
      addFinding(
        'INVALID_SECURITY_APPROVAL',
        `Invalid Security-Approval '${securityApprovalRaw}' (expected: not-required|pending|approved)`,
        rel
      );
    }

    if (deliveryClassRaw && !deliveryClass) {
      addFinding(
        'INVALID_DELIVERY_CLASS',
        `Invalid Delivery-Class '${deliveryClassRaw}' (expected: ${[...DELIVERY_CLASSES].join('|')})`,
        rel
      );
    }

    if (executionScopeRaw && !executionScope) {
      addFinding(
        'INVALID_EXECUTION_SCOPE',
        `Invalid Execution-Scope '${executionScopeRaw}' (expected: ${[...EXECUTION_SCOPES].join('|')})`,
        rel
      );
    }

    if (parentPlanIdRaw && !parentPlanId) {
      addFinding(
        'INVALID_PARENT_PLAN_ID',
        `Invalid Parent-Plan-ID '${parentPlanIdRaw}' (expected lowercase kebab-case Plan-ID)`,
        rel
      );
    }

    if (phase !== 'completed' && !deliveryClass) {
      addFinding(
        'MISSING_DELIVERY_CLASS',
        "Missing metadata field 'Delivery-Class'",
        rel
      );
    }

    if (phase !== 'completed' && !executionScope) {
      addFinding(
        'MISSING_EXECUTION_SCOPE',
        "Missing metadata field 'Execution-Scope'",
        rel
      );
    }

    if (productSlicePlan && !implementationTargetsProvided) {
      addFinding(
        'MISSING_IMPLEMENTATION_TARGETS',
        "Product slice plans must declare 'Implementation-Targets' with at least one non-doc root.",
        rel
      );
    }

    if (productSlicePlan && implementationTargetsProvided && !implementationTargets.some(isSupportedImplementationTarget)) {
      addFinding(
        'INVALID_IMPLEMENTATION_TARGETS',
        "Product slice plans must include at least one runtime-supported path in 'Implementation-Targets' (source|tests|scripts|configs|lockfiles outside docs).",
        rel
      );
    }

    if (productSlicePlan && implementationTargetsProvided && !implementationTargets.some(isSourceImplementationTarget)) {
      addFinding(
        'MISSING_SOURCE_IMPLEMENTATION_TARGET',
        "Product slice plans must include at least one source-code path in 'Implementation-Targets' so completion maps to shipped product behavior.",
        rel
      );
    }

    if (!productSlicePlan && implementationTargetsProvided) {
      addFinding(
        'UNEXPECTED_IMPLEMENTATION_TARGETS',
        "Only 'Delivery-Class: product' plus 'Execution-Scope: slice' plans may declare 'Implementation-Targets'. Use 'none' or remove the field for program/docs/ops/reconciliation plans.",
        rel
      );
    }

    if (productSlicePlan) {
      const mustLandEntries = parseMustLandChecklist(content);
      const mustLandIds = mustLandEntries.map((entry) => entry.id).filter(Boolean);
      const missingMustLandIds = mustLandEntries.filter((entry) => !entry.id);
      if (missingMustLandIds.length > 0) {
        reportSemanticProofIssue(
          proofMode,
          'MISSING_MUST_LAND_IDS',
          "Product slice plans should prefix every `## Must-Land Checklist` checkbox with a stable backticked ID such as `ml-example-capability`.",
          rel
        );
      }

      const proofMap = parseCapabilityProofMap(content);
      const proofMapPresent = /^##\s+Capability Proof Map\s*$/m.test(content);
      if (!proofMapPresent) {
        reportSemanticProofIssue(
          proofMode,
          'MISSING_CAPABILITY_PROOF_MAP',
          `Product slice plans should include '## ${CAPABILITY_PROOF_MAP_SECTION}' so must-land items map to explicit proof obligations.`,
          rel
        );
      } else {
        for (const error of proofMap.errors) {
          reportSemanticProofIssue(
            proofMode,
            'INVALID_CAPABILITY_PROOF_MAP',
            error,
            rel,
            true
          );
        }

        const capabilityIds = new Set();
        const duplicateCapabilityIds = new Set();
        for (const capability of proofMap.capabilities) {
          if (!capability.capabilityId) {
            reportSemanticProofIssue(
              proofMode,
              'MISSING_CAPABILITY_ID',
              'Capability Proof Map capability rows must set Capability ID.',
              rel,
              true
            );
            continue;
          }
          if (capabilityIds.has(capability.capabilityId)) {
            duplicateCapabilityIds.add(capability.capabilityId);
          }
          capabilityIds.add(capability.capabilityId);
          if (capability.mustLandIds.length === 0) {
            reportSemanticProofIssue(
              proofMode,
              'EMPTY_CAPABILITY_MUST_LAND_MAP',
              `Capability '${capability.capabilityId}' must reference at least one must-land ID.`,
              rel
            );
          }
          if (!capability.claim) {
            reportSemanticProofIssue(
              proofMode,
              'EMPTY_CAPABILITY_CLAIM',
              `Capability '${capability.capabilityId}' must include a claim.`,
              rel
            );
          }
          if (capability.requiredStrength !== 'strong' && capability.requiredStrength !== 'weak') {
            reportSemanticProofIssue(
              proofMode,
              'INVALID_CAPABILITY_REQUIRED_STRENGTH',
              `Capability '${capability.capabilityId}' uses invalid required strength '${capability.requiredStrength || 'missing'}' (expected: strong|weak).`,
              rel,
              true
            );
          }
          for (const mustLandId of capability.mustLandIds) {
            if (!mustLandIds.includes(mustLandId)) {
              reportSemanticProofIssue(
                proofMode,
                'UNKNOWN_MUST_LAND_REFERENCE',
                `Capability '${capability.capabilityId}' references unknown must-land ID '${mustLandId}'.`,
                rel,
                true
              );
            }
          }
        }
        for (const duplicateId of duplicateCapabilityIds) {
          reportSemanticProofIssue(
            proofMode,
            'DUPLICATE_CAPABILITY_ID',
            `Capability Proof Map repeats capability ID '${duplicateId}'.`,
            rel,
            true
          );
        }

        const proofIds = new Set();
        const duplicateProofIds = new Set();
        const proofsByCapability = new Map();
        for (const proof of proofMap.proofs) {
          if (!proof.proofId) {
            reportSemanticProofIssue(
              proofMode,
              'MISSING_PROOF_ID',
              'Capability Proof Map proof rows must set Proof ID.',
              rel,
              true
            );
            continue;
          }
          if (proofIds.has(proof.proofId)) {
            duplicateProofIds.add(proof.proofId);
          }
          proofIds.add(proof.proofId);
          if (!capabilityIds.has(proof.capabilityId)) {
            reportSemanticProofIssue(
              proofMode,
              'UNKNOWN_PROOF_CAPABILITY',
              `Proof '${proof.proofId}' references unknown capability '${proof.capabilityId || 'missing'}'.`,
              rel,
              true
            );
          }
          if (!PROOF_TYPES.has(proof.type)) {
            reportSemanticProofIssue(
              proofMode,
              'INVALID_PROOF_TYPE',
              `Proof '${proof.proofId}' uses invalid type '${proof.type || 'missing'}'.`,
              rel,
              true
            );
          }
          if (!PROOF_LANES.has(proof.lane)) {
            reportSemanticProofIssue(
              proofMode,
              'INVALID_PROOF_LANE',
              `Proof '${proof.proofId}' uses invalid lane '${proof.lane || 'missing'}'.`,
              rel,
              true
            );
          }
          if (!PROOF_FRESHNESS_VALUES.has(proof.freshness)) {
            reportSemanticProofIssue(
              proofMode,
              'INVALID_PROOF_FRESHNESS',
              `Proof '${proof.proofId}' uses invalid freshness '${proof.freshness || 'missing'}'.`,
              rel,
              true
            );
          }
          if (!proof.validationRef) {
            reportSemanticProofIssue(
              proofMode,
              'MISSING_PROOF_REFERENCE',
              `Proof '${proof.proofId}' must declare a validation ID or artifact path.`,
              rel,
              true
            );
          } else if (!configuredValidationIds.has(proof.validationRef) && !isArtifactValidationReference(proof.validationRef)) {
            reportSemanticProofIssue(
              proofMode,
              'UNKNOWN_PROOF_REFERENCE',
              `Proof '${proof.proofId}' references unknown validation ID or artifact '${proof.validationRef}'.`,
              rel
            );
          }
          if (!proofsByCapability.has(proof.capabilityId)) {
            proofsByCapability.set(proof.capabilityId, []);
          }
          proofsByCapability.get(proof.capabilityId).push(proof);
        }
        for (const duplicateId of duplicateProofIds) {
          reportSemanticProofIssue(
            proofMode,
            'DUPLICATE_PROOF_ID',
            `Capability Proof Map repeats proof ID '${duplicateId}'.`,
            rel,
            true
          );
        }
        for (const capability of proofMap.capabilities) {
          if (!proofsByCapability.has(capability.capabilityId)) {
            reportSemanticProofIssue(
              proofMode,
              'CAPABILITY_WITHOUT_PROOFS',
              `Capability '${capability.capabilityId}' does not declare any proof rows.`,
              rel
            );
          }
        }
        const coveredMustLandIds = new Set(
          proofMap.capabilities.flatMap((capability) => capability.mustLandIds)
        );
        for (const mustLandId of mustLandIds) {
          if (!coveredMustLandIds.has(mustLandId)) {
            reportSemanticProofIssue(
              proofMode,
              'UNMAPPED_MUST_LAND_ID',
              `Must-land item '${mustLandId}' is not referenced by any capability in '## ${CAPABILITY_PROOF_MAP_SECTION}'.`,
              rel
            );
          }
        }
      }
    }

    if (executionScope === 'program' && parentPlanId) {
      addFinding(
        'PROGRAM_PLAN_WITH_PARENT',
        "Program plans must not set 'Parent-Plan-ID'. Only child slice plans may point to a parent program.",
        rel
      );
    }

    if (phase === 'active' && executionScope === 'program') {
      if (status === 'validation' || status === 'completed') {
        addFinding(
          'PROGRAM_PLAN_NOT_EXECUTABLE',
          "Active program plans are non-executable parent contracts and cannot move to 'validation' or 'completed'. Keep them active and close child slices instead.",
          rel
        );
      }
      if (validationReady === 'yes' || validationReady === 'host-required-only') {
        addFinding(
          'PROGRAM_PLAN_NOT_VALIDATION_READY',
          "Active program plans must not set 'Validation-Ready: yes' or 'host-required-only'.",
          rel
        );
      }
    }

    if (phase === 'completed') {
      if (unfinishedCoverageRows.length > 0) {
        const preview = unfinishedCoverageRows
          .slice(0, 3)
          .map((entry) => `${entry.capability}='${entry.status}'`)
          .join(', ');
        addFinding(
          'UNFINISHED_COVERAGE_STATUS',
          `Completed plan still records unfinished current-status rows in '${unfinishedCoverageRows[0].sectionTitle}': ${preview}`,
          rel
        );
      }
      if (mustLandBody && incompleteMustLandItems.length > 0) {
        addFinding(
          'INCOMPLETE_MUST_LAND_CHECKLIST',
          `Completed plan still has unchecked items in '## ${MUST_LAND_SECTION}'`,
          rel
        );
      }
      if (!/^##\s+Closure\b/m.test(content)) {
        addFinding('MISSING_CLOSURE_SECTION', "Completed plan is missing '## Closure' section", rel);
      }
      if (!/^##\s+Validation Evidence\b/m.test(content)) {
        addFinding('MISSING_VALIDATION_SECTION', "Completed plan is missing '## Validation Evidence' section", rel);
      }

      const canonicalStatus = normalizeStatus(content.match(/^Status:\s*(.+)$/m)?.[1] ?? '');
      if (canonicalStatus && canonicalStatus !== 'completed') {
        addFinding(
          'CANONICAL_STATUS_MISMATCH',
          `Completed plan top-level Status must be 'completed' (found '${canonicalStatus}')`,
          rel
        );
      }

      const completedRiskTier = (riskTierRaw ?? '').trim().toLowerCase();
      const completedSecurityApproval = (securityApprovalRaw ?? '').trim().toLowerCase();
      if (completedRiskTier === 'high' && completedSecurityApproval !== 'approved') {
        addFinding(
          'SECURITY_APPROVAL_REQUIRED',
          "Completed high-risk plan must set Security-Approval to 'approved'",
          rel
        );
      }
      if (
        completedRiskTier === 'medium' &&
        completedSecurityApproval &&
        completedSecurityApproval !== 'approved' &&
        completedSecurityApproval !== 'not-required'
      ) {
        addFinding(
          'SECURITY_APPROVAL_INCOMPLETE',
          `Completed plan has Risk-Tier '${completedRiskTier}' but Security-Approval is '${completedSecurityApproval}'`,
          rel
        );
      }
    }

    if (
      phase === 'active' &&
      (status === 'validation' ||
        status === 'completed' ||
        validationReady === 'yes' ||
        validationReady === 'host-required-only') &&
      (deliveryClass === 'product' || executionScope === 'program') &&
      unfinishedCoverageRows.length > 0
    ) {
      const preview = unfinishedCoverageRows
        .slice(0, 3)
        .map((entry) => `${entry.capability}='${entry.status}'`)
        .join(', ');
      addFinding(
        'UNFINISHED_COVERAGE_STATUS',
        `Active plan cannot enter validation/completion while '${unfinishedCoverageRows[0].sectionTitle}' still records unfinished current-status rows: ${preview}`,
        rel
      );
    }

    if (phase === 'active' && (status === 'validation' || status === 'completed') && incompleteMustLandItems.length > 0) {
      addFinding(
        'VALIDATION_WITH_OPEN_MUST_LAND',
        `Active plan with Status '${status}' still has unchecked items in '## ${MUST_LAND_SECTION}'`,
        rel
      );
    }

    if (phase === 'future' && status === 'ready-for-promotion' && incompleteMustLandItems.length === 0) {
      addFinding(
        'READY_FUTURE_WITHOUT_OPEN_MUST_LAND',
        `Future blueprint set to 'ready-for-promotion' must keep executable work in '## ${MUST_LAND_SECTION}'`,
        rel
      );
    }

    if (phase === 'future' && status === 'ready-for-promotion' && !coverageSection.body) {
      addFinding(
        'READY_FUTURE_WITHOUT_CAPABILITY_COVERAGE',
        `Future blueprint set to 'ready-for-promotion' must include '## ${COVERAGE_SECTION_TITLES[0]}' or '## ${COVERAGE_SECTION_TITLES[1]}'`,
        rel
      );
    }

    if (phase === 'future' && status === 'ready-for-promotion' && !promotionBlockersBody) {
      addFinding(
        'READY_FUTURE_WITHOUT_PROMOTION_BLOCKERS',
        `Future blueprint set to 'ready-for-promotion' must include '## ${PROMOTION_BLOCKERS_SECTION}'`,
        rel
      );
    }

    if (phase === 'future' && status === 'ready-for-promotion' && !reconciliationBody) {
      addFinding(
        'READY_FUTURE_WITHOUT_RECONCILIATION',
        `Future blueprint set to 'ready-for-promotion' must include '## ${RECONCILIATION_SECTION}'`,
        rel
      );
    }

    const mentionsFutureState = /target state|future state|later phase|later phases|logical target|eventual/i.test(content);
    const hasScopeSeparation = content.includes(`## ${BASELINE_SECTION}`) || content.includes(`## ${DEFERRED_SECTION}`);
    if ((phase === 'future' || phase === 'active') && mentionsFutureState && !hasScopeSeparation) {
      addFinding(
        'MISSING_SCOPE_SEPARATION',
        `Plan references broader future state but does not separate baseline/deferred scope. Add '## ${BASELINE_SECTION}' and/or '## ${DEFERRED_SECTION}' so executable scope stays auditable.`,
        rel
      );
    }

    if (rawPlanId && !parsedPlanId) {
      addFinding(
        'INVALID_PLAN_ID',
        `Invalid Plan-ID '${rawPlanId}' (expected lowercase kebab-case, e.g. 'fix-auth-timeout')`,
        rel
      );
    }

    const planId = parsedPlanId ?? inferPlanId(content, filePath);
    const parsedDependencies = [];
    for (const dependency of parseListField(metadataValue(metadata, 'Dependencies'))) {
      const normalizedDependency = parsePlanId(dependency, null);
      if (!normalizedDependency) {
        addFinding(
          'INVALID_DEPENDENCY_PLAN_ID',
          `Invalid dependency '${dependency}' (expected lowercase kebab-case Plan-ID)`,
          rel
        );
        continue;
      }
      parsedDependencies.push(normalizedDependency);
    }

    plans.push({
      phase,
      rel,
      planId,
      dependencies: parsedDependencies,
      deliveryClass,
      executionScope,
      parentPlanId,
      declaredProgramUnits
    });
  }

  return plans;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scopedPlanIdInput = options['plan-id'] ?? options.planId;
  const scopedPlanId = scopedPlanIdInput == null ? null : normalizePlanId(scopedPlanIdInput);
  if (scopedPlanIdInput != null && !scopedPlanId) {
    console.error(
      `[plans-verify] invalid --plan-id '${String(scopedPlanIdInput)}' (expected lowercase kebab-case).`
    );
    process.exit(1);
  }
  const ciMode = asBoolean(process.env.CI, false);
  const autoHealEnabled = asBoolean(
    options['auto-heal-status'] ??
    options.autoHealStatus ??
    process.env.ORCH_PLAN_METADATA_AUTO_HEAL_STATUS,
    !ciMode
  );
  const automationConfig = await loadAutomationConfig();
  const proofMode = normalizeProofMode(automationConfig?.semanticProof?.mode);
  const configuredValidationIds = collectConfiguredValidationIds(automationConfig);

  scanPhase.autoHealEnabled = autoHealEnabled;
  scanPhase.scopedRepairPlanId = scopedPlanId;
  scanPhase.proofMode = proofMode;
  scanPhase.configuredValidationIds = configuredValidationIds;

  const [futurePlans, activePlans, completedPlans] = await Promise.all([
    scanPhase('future', directories.future),
    scanPhase('active', directories.active),
    scanPhase('completed', directories.completed)
  ]);

  const allPlans = [...futurePlans, ...activePlans, ...completedPlans];
  const seenPlanIds = new Map();

  for (const plan of allPlans) {
    if (!plan.planId) {
      addFinding('MISSING_PLAN_ID', 'Could not infer or parse Plan-ID', plan.rel);
      continue;
    }

    if (seenPlanIds.has(plan.planId)) {
      addFinding(
        'DUPLICATE_PLAN_ID',
        `Duplicate Plan-ID '${plan.planId}' (also in ${seenPlanIds.get(plan.planId)})`,
        plan.rel
      );
      continue;
    }

    seenPlanIds.set(plan.planId, plan.rel);
  }

  for (const plan of allPlans) {
    for (const dependency of plan.dependencies) {
      if (!seenPlanIds.has(dependency)) {
        addFinding(
          'MISSING_DEPENDENCY_PLAN',
          `Dependency '${dependency}' does not exist in future/active/completed plans`,
          plan.rel
        );
      }
    }
  }

  const planById = new Map(allPlans.filter((plan) => plan.planId).map((plan) => [plan.planId, plan]));
  const childrenByParent = new Map();

  for (const plan of allPlans) {
    if (!plan.parentPlanId) {
      continue;
    }
    if (!seenPlanIds.has(plan.parentPlanId)) {
      addFinding(
        'MISSING_PARENT_PLAN',
        `Parent-Plan-ID '${plan.parentPlanId}' does not exist in future/active/completed plans`,
        plan.rel
      );
      continue;
    }
    if (plan.parentPlanId === plan.planId) {
      addFinding(
        'SELF_REFERENTIAL_PARENT_PLAN',
        'Parent-Plan-ID must not point to the same plan.',
        plan.rel
      );
      continue;
    }
    if (!childrenByParent.has(plan.parentPlanId)) {
      childrenByParent.set(plan.parentPlanId, []);
    }
    childrenByParent.get(plan.parentPlanId).push(plan);

    const parentPlan = planById.get(plan.parentPlanId);
    if (parentPlan?.executionScope && parentPlan.executionScope !== 'program') {
      addFinding(
        'PARENT_PLAN_NOT_PROGRAM',
        `Parent-Plan-ID '${plan.parentPlanId}' must point to a plan with 'Execution-Scope: program'`,
        plan.rel
      );
    }
    if (plan.executionScope && plan.executionScope !== 'slice') {
      addFinding(
        'CHILD_PLAN_NOT_SLICE',
        `Plans with Parent-Plan-ID must use 'Execution-Scope: slice'`,
        plan.rel
      );
    }
    if (
      parentPlan?.deliveryClass &&
      plan.deliveryClass &&
      parentPlan.deliveryClass !== plan.deliveryClass
    ) {
      addFinding(
        'PARENT_CHILD_DELIVERY_CLASS_MISMATCH',
        `Parent plan '${plan.parentPlanId}' uses Delivery-Class '${parentPlan.deliveryClass}' but child uses '${plan.deliveryClass}'`,
        plan.rel
      );
    }
  }

  for (const plan of allPlans) {
    if (
      plan.phase === 'active' &&
      plan.executionScope === 'program' &&
      Array.isArray(plan.declaredProgramUnits) &&
      plan.declaredProgramUnits.length > 0
    ) {
      const children = childrenByParent.get(plan.planId) ?? [];
      if (children.length < plan.declaredProgramUnits.length) {
        const childPlanIds = new Set(children.map((child) => child.planId).filter(Boolean));
        const missingHints = plan.declaredProgramUnits
          .filter((unit) => unit.planIdHint && !childPlanIds.has(unit.planIdHint))
          .map((unit) => unit.planIdHint);
        const unlabeledUnits = plan.declaredProgramUnits
          .filter((unit) => !unit.planIdHint)
          .map((unit) => unit.title)
          .slice(0, 3);
        const detailParts = [];
        if (missingHints.length > 0) {
          detailParts.push(`missing child Plan-IDs: ${missingHints.join(', ')}`);
        }
        if (unlabeledUnits.length > 0) {
          detailParts.push(`missing declared units include: ${unlabeledUnits.join(' | ')}`);
        }
        const detail = detailParts.length > 0 ? ` ${detailParts.join('; ')}.` : '';
        addFinding(
          'ACTIVE_PROGRAM_CHILD_PLAN_GAP',
          `Active program plan declares ${plan.declaredProgramUnits.length} child units but only ${children.length} child plan(s) reference this parent. Materialize the missing child plans in future/active before expecting grind to continue.${detail}`,
          plan.rel
        );
      }
    }

    if (plan.phase !== 'completed' || plan.executionScope !== 'program') {
      continue;
    }
    const children = childrenByParent.get(plan.planId) ?? [];
    if (children.length === 0) {
      addFinding(
        'PROGRAM_PLAN_WITHOUT_CHILD_SLICES',
        'Completed program plans must close from completed child slices; no child slices reference this parent.',
        plan.rel
      );
      continue;
    }
    const incompleteChildren = children.filter((child) => child.phase !== 'completed');
    if (incompleteChildren.length > 0) {
      addFinding(
        'PROGRAM_CHILD_NOT_COMPLETED',
        `Completed program plan still has non-completed child slices: ${incompleteChildren.map((child) => child.planId).join(', ')}`,
        plan.rel
      );
    }
  }

  let scopeSummary = '';
  if (scopedPlanId) {
    const scopedPlanIds = expandScopedPlanIds(allPlans, scopedPlanId);
    const scopedFiles = new Set();
    for (const plan of allPlans) {
      const ids = candidatePlanScopeIds(plan, scopedPlanId);
      if (ids.size > 0 || (plan.planId && scopedPlanIds.has(plan.planId))) {
        scopedFiles.add(plan.rel);
      }
    }
    if (scopedFiles.size === 0) {
      addFinding(
        'PLAN_ID_NOT_FOUND',
        `Plan-ID '${scopedPlanId}' was not found in future/active/completed plans`,
        'docs/exec-plans'
      );
    }
    const scopedFindings = findings.filter((finding) => {
      if (finding.code === 'PLAN_ID_NOT_FOUND') {
        return true;
      }
      if (scopedFiles.has(finding.filePath)) {
        return true;
      }
      if (finding.code === 'DUPLICATE_PLAN_ID' && finding.message.includes(`'${scopedPlanId}'`)) {
        return true;
      }
      return false;
    });
    const scopedAdvisories = advisories.filter((advisory) => {
      if (scopedFiles.has(advisory.filePath)) {
        return true;
      }
      return false;
    });
    findings.length = 0;
    findings.push(...scopedFindings);
    advisories.length = 0;
    advisories.push(...scopedAdvisories);
    scopeSummary = ` scopePlanId=${scopedPlanId}`;
  }

  const summary = `plans=${allPlans.length} future=${futurePlans.length} active=${activePlans.length} completed=${completedPlans.length}${scopeSummary}`;
  if (autoHeals.length > 0) {
    console.log(`[plans-verify] auto-healed ${autoHeals.length} status drift issue(s).`);
    for (const heal of autoHeals) {
      console.log(`- ${heal.filePath}: ${heal.fromStatus} -> ${heal.toStatus}`);
    }
  }

  if (advisories.length > 0) {
    console.log(`[plans-verify] advisories (${advisories.length}, semanticProof=${proofMode}).`);
    for (const advisory of advisories) {
      console.log(`- [${advisory.code}] ${advisory.message} (${advisory.filePath})`);
    }
  }

  if (findings.length > 0) {
    await writeValidationResult({
      validationId: process.env.ORCH_VALIDATION_ID || 'plans:metadata',
      type: process.env.ORCH_VALIDATION_TYPE || 'contract',
      status: 'failed',
      summary: `[plans-verify] failed (${findings.length} issue(s), ${summary}).`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      findingFiles: findings.map((finding) => finding.filePath).filter(Boolean),
      evidenceRefs: [],
      artifactRefs: []
    });
    console.error(`[plans-verify] failed (${findings.length} issue(s), ${summary}).`);
    for (const finding of findings) {
      console.error(`- [${finding.code}] ${finding.message} (${finding.filePath})`);
    }
    process.exit(1);
  }

  await writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'plans:metadata',
    type: process.env.ORCH_VALIDATION_TYPE || 'contract',
    status: 'passed',
    summary: `[plans-verify] passed (${summary}).`,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  });
  console.log(`[plans-verify] passed (${summary}).`);
}

main().catch((error) => {
  Promise.resolve(writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'plans:metadata',
    type: process.env.ORCH_VALIDATION_TYPE || 'contract',
    status: 'failed',
    summary: error instanceof Error ? error.message : String(error),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  })).finally(() => {
    console.error('[plans-verify] failed with an unexpected error.');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
});
