#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_STATUSES,
  COMPLETED_STATUSES,
  FUTURE_STATUSES,
  REQUIRED_METADATA_FIELDS,
  RISK_TIERS,
  SECURITY_APPROVAL_VALUES,
  listMarkdownFiles,
  metadataValue,
  parseListField,
  parseMetadata,
  parsePlanId,
  normalizeStatus,
  inferPlanId
} from './lib/plan-metadata.mjs';

const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const rootDir = process.cwd();
const directories = {
  future: path.join(rootDir, 'docs', 'future'),
  active: path.join(rootDir, 'docs', 'exec-plans', 'active'),
  completed: path.join(rootDir, 'docs', 'exec-plans', 'completed')
};

const findings = [];
const autoHeals = [];
const MUST_LAND_SECTION = 'Must-Land Checklist';
const DEFERRED_SECTION = 'Deferred Follow-Ons';
const BASELINE_SECTION = 'Already-True Baseline';
const PROMOTION_BLOCKERS_SECTION = 'Promotion Blockers';
const COVERAGE_SECTION_TITLES = ['Master Plan Coverage', 'Capability Coverage Matrix'];

function addFinding(code, message, filePath) {
  findings.push({ code, message, filePath });
}

function addAutoHeal(filePath, fromStatus, toStatus) {
  autoHeals.push({ filePath, fromStatus, toStatus });
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
    const metadataStatus = normalizeStatus(metadataValue(metadata, 'Status'));
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
    if (
      phase === 'active' &&
      normalizedTopLevelStatus === 'completed' &&
      (status === 'blocked' || status === 'failed')
    ) {
      addFinding(
        'CONTRADICTORY_STATUS',
        `Top-level Status is 'completed' while metadata Status is '${status}'. Resolve status mismatch before orchestration.`,
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

    if (phase === 'completed') {
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
      dependencies: parsedDependencies
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

  scanPhase.autoHealEnabled = autoHealEnabled;
  scanPhase.scopedRepairPlanId = scopedPlanId;

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

  let scopeSummary = '';
  if (scopedPlanId) {
    const scopedFiles = new Set();
    for (const plan of allPlans) {
      const ids = candidatePlanScopeIds(plan, scopedPlanId);
      if (ids.size > 0) {
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
    findings.length = 0;
    findings.push(...scopedFindings);
    scopeSummary = ` scopePlanId=${scopedPlanId}`;
  }

  const summary = `plans=${allPlans.length} future=${futurePlans.length} active=${activePlans.length} completed=${completedPlans.length}${scopeSummary}`;
  if (autoHeals.length > 0) {
    console.log(`[plans-verify] auto-healed ${autoHeals.length} status drift issue(s).`);
    for (const heal of autoHeals) {
      console.log(`- ${heal.filePath}: ${heal.fromStatus} -> ${heal.toStatus}`);
    }
  }

  if (findings.length > 0) {
    console.error(`[plans-verify] failed (${findings.length} issue(s), ${summary}).`);
    for (const finding of findings) {
      console.error(`- [${finding.code}] ${finding.message} (${finding.filePath})`);
    }
    process.exit(1);
  }

  console.log(`[plans-verify] passed (${summary}).`);
}

main().catch((error) => {
  console.error('[plans-verify] failed with an unexpected error.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
