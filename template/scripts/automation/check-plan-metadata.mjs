#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_STATUSES,
  COMPLETED_STATUSES,
  DELIVERY_CLASSES,
  FUTURE_STATUSES,
  LEGACY_METADATA_FIELDS,
  PRIORITIES,
  REQUIRED_METADATA_FIELDS,
  RISK_TIERS,
  SECURITY_APPROVAL_VALUES,
  VALIDATION_LANES,
  inferPlanId,
  listMarkdownFiles,
  metadataValue,
  parseDeliveryClass,
  parseListField,
  parseMetadata,
  parseMustLandChecklist,
  parsePlanId,
  parsePriority,
  parseRiskTier,
  parseSecurityApproval,
  parseValidationLanes,
  sectionBody
} from './lib/plan-metadata.mjs';

const rootDir = process.cwd();
const PLAN_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLAN_SECTION_TITLES = [
  'Already-True Baseline',
  'Must-Land Checklist',
  'Deferred Follow-Ons'
];
const LEGACY_SECTION_TITLES = [
  'Capability Coverage Matrix',
  'Child Slice Definitions',
  'Master Plan Coverage',
  'Promotion Blockers',
  'Prior Completed Plan Reconciliation',
  'Validation Contract'
];

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

function normalizeScope(value) {
  const normalized = String(value ?? 'future-active').trim().toLowerCase();
  return normalized === 'all' ? 'all' : 'future-active';
}

function rel(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function shouldSkipPlanFile(filePath) {
  const relative = rel(filePath);
  if (relative.includes('/evidence/')) {
    return true;
  }
  return false;
}

function addFinding(findings, code, message, filePath) {
  findings.push({ code, message, filePath });
}

function statusSetForPhase(phase) {
  if (phase === 'future') {
    return FUTURE_STATUSES;
  }
  if (phase === 'active') {
    return ACTIVE_STATUSES;
  }
  return COMPLETED_STATUSES;
}

function isDocPath(value) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.?\//, '');
  return normalized.startsWith('docs/') || normalized.endsWith('.md') || normalized.endsWith('.mdx');
}

async function loadPlans() {
  const directories = {
    future: path.join(rootDir, 'docs', 'future'),
    active: path.join(rootDir, 'docs', 'exec-plans', 'active'),
    completed: path.join(rootDir, 'docs', 'exec-plans', 'completed')
  };
  const plans = [];

  for (const [phase, directoryPath] of Object.entries(directories)) {
    const files = await listMarkdownFiles(directoryPath);
    for (const filePath of files) {
      if (path.basename(filePath) === 'README.md' || shouldSkipPlanFile(filePath)) {
        continue;
      }
      const content = await fs.readFile(filePath, 'utf8');
      plans.push({
        phase,
        filePath,
        rel: rel(filePath),
        content,
        metadata: parseMetadata(content),
        planId: inferPlanId(content, filePath)
      });
    }
  }

  return plans;
}

function validateRequiredMetadata(plan, findings) {
  const requiredFields = REQUIRED_METADATA_FIELDS[plan.phase] ?? [];
  for (const field of requiredFields) {
    const value = metadataValue(plan.metadata, field);
    if (!String(value ?? '').trim()) {
      addFinding(findings, 'MISSING_METADATA_FIELD', `Missing metadata field '${field}'.`, plan.rel);
    }
  }
}

function validateLegacyMetadata(plan, findings) {
  for (const field of LEGACY_METADATA_FIELDS) {
    const value = metadataValue(plan.metadata, field);
    if (String(value ?? '').trim()) {
      addFinding(
        findings,
        'LEGACY_METADATA_FIELD',
        `Legacy metadata field '${field}' is not supported in the flat queue harness.`,
        plan.rel
      );
    }
  }
  const topLevelValidationReady = String(plan.content.match(/^Validation-Ready:\s*(.+)$/m)?.[1] ?? '').trim();
  if (topLevelValidationReady) {
    addFinding(
      findings,
      'LEGACY_TOP_LEVEL_FIELD',
      "Top-level 'Validation-Ready' is not supported in the flat queue harness.",
      plan.rel
    );
  }
}

function validatePlanIdentity(plan, findings, seenPlanIds) {
  const explicitPlanId = metadataValue(plan.metadata, 'Plan-ID');
  if (!PLAN_ID_REGEX.test(String(explicitPlanId ?? '').trim())) {
    addFinding(findings, 'INVALID_PLAN_ID', 'Plan-ID must be lowercase kebab-case.', plan.rel);
  }
  if (!plan.planId) {
    addFinding(findings, 'UNREADABLE_PLAN_ID', 'Unable to infer Plan-ID from metadata or filename.', plan.rel);
    return;
  }
  if (seenPlanIds.has(plan.planId)) {
    addFinding(findings, 'DUPLICATE_PLAN_ID', `Duplicate Plan-ID '${plan.planId}'.`, plan.rel);
    return;
  }
  seenPlanIds.add(plan.planId);
}

function validateStatus(plan, findings) {
  const status = String(metadataValue(plan.metadata, 'Status')).trim().toLowerCase();
  if (!statusSetForPhase(plan.phase).has(status)) {
    addFinding(findings, 'INVALID_STATUS', `Status '${status || 'missing'}' is invalid for ${plan.phase} plans.`, plan.rel);
  }
  const topLevelStatus = String(plan.content.match(/^Status:\s*(.+)$/m)?.[1] ?? '').trim().toLowerCase();
  if (topLevelStatus && topLevelStatus !== status) {
    addFinding(
      findings,
      'STATUS_MISMATCH',
      `Top-level Status '${topLevelStatus}' does not match metadata Status '${status}'.`,
      plan.rel
    );
  }
}

function validateMetadataValues(plan, findings, allPlanIds) {
  const priority = parsePriority(metadataValue(plan.metadata, 'Priority'), '');
  if (!PRIORITIES.has(priority)) {
    addFinding(findings, 'INVALID_PRIORITY', 'Priority must be one of p0, p1, p2, p3.', plan.rel);
  }

  const deliveryClass = parseDeliveryClass(metadataValue(plan.metadata, 'Delivery-Class'), '');
  if (!DELIVERY_CLASSES.has(deliveryClass)) {
    addFinding(findings, 'INVALID_DELIVERY_CLASS', `Unsupported Delivery-Class '${metadataValue(plan.metadata, 'Delivery-Class')}'.`, plan.rel);
  }

  const riskTier = parseRiskTier(metadataValue(plan.metadata, 'Risk-Tier'), '');
  if (!RISK_TIERS.has(riskTier)) {
    addFinding(findings, 'INVALID_RISK_TIER', `Unsupported Risk-Tier '${metadataValue(plan.metadata, 'Risk-Tier')}'.`, plan.rel);
  }

  const securityApproval = parseSecurityApproval(metadataValue(plan.metadata, 'Security-Approval'), '');
  if (!SECURITY_APPROVAL_VALUES.has(securityApproval)) {
    addFinding(
      findings,
      'INVALID_SECURITY_APPROVAL',
      `Unsupported Security-Approval '${metadataValue(plan.metadata, 'Security-Approval')}'.`,
      plan.rel
    );
  }

  const validationLanes = parseValidationLanes(metadataValue(plan.metadata, 'Validation-Lanes'), []);
  if (validationLanes.length === 0) {
    addFinding(findings, 'MISSING_VALIDATION_LANES', 'Validation-Lanes must include always and/or host-required.', plan.rel);
  }
  for (const lane of validationLanes) {
    if (!VALIDATION_LANES.has(lane)) {
      addFinding(findings, 'INVALID_VALIDATION_LANE', `Unsupported validation lane '${lane}'.`, plan.rel);
    }
  }

  const dependencies = parseListField(metadataValue(plan.metadata, 'Dependencies'));
  for (const dependency of dependencies) {
    if (dependency.toLowerCase() === 'none') {
      continue;
    }
    if (!parsePlanId(dependency, null)) {
      addFinding(findings, 'INVALID_DEPENDENCY', `Dependency '${dependency}' must be a Plan-ID or 'none'.`, plan.rel);
      continue;
    }
    if (!allPlanIds.has(dependency)) {
      addFinding(findings, 'UNKNOWN_DEPENDENCY', `Dependency '${dependency}' does not match any known plan.`, plan.rel);
    }
  }

  const specTargets = parseListField(metadataValue(plan.metadata, 'Spec-Targets'));
  if (specTargets.length === 0) {
    addFinding(findings, 'MISSING_SPEC_TARGETS', 'Spec-Targets must contain at least one path.', plan.rel);
  }

  const implementationTargets = parseListField(metadataValue(plan.metadata, 'Implementation-Targets'));
  if (deliveryClass === 'product') {
    if (implementationTargets.length === 0) {
      addFinding(findings, 'MISSING_IMPLEMENTATION_TARGETS', 'Product plans require Implementation-Targets.', plan.rel);
    }
    if (!implementationTargets.some((target) => !isDocPath(target))) {
      addFinding(
        findings,
        'DOC_ONLY_IMPLEMENTATION_TARGETS',
        'Product plans require at least one non-doc Implementation-Target.',
        plan.rel
      );
    }
  }

  const doneEvidence = String(metadataValue(plan.metadata, 'Done-Evidence')).trim();
  if (plan.phase === 'completed') {
    if (!doneEvidence || doneEvidence.toLowerCase() === 'pending') {
      addFinding(findings, 'MISSING_DONE_EVIDENCE', 'Completed plans require non-pending Done-Evidence.', plan.rel);
    }
  } else if (!doneEvidence || doneEvidence.toLowerCase() !== 'pending') {
    addFinding(findings, 'INVALID_DONE_EVIDENCE', "Future and active plans must keep Done-Evidence as 'pending'.", plan.rel);
  }
}

function validatePlanSections(plan, findings) {
  for (const title of PLAN_SECTION_TITLES) {
    if (!sectionBody(plan.content, title)) {
      addFinding(findings, 'MISSING_SECTION', `Missing required section '## ${title}'.`, plan.rel);
    }
  }

  for (const title of LEGACY_SECTION_TITLES) {
    if (sectionBody(plan.content, title)) {
      addFinding(
        findings,
        'LEGACY_SECTION',
        `Legacy section '## ${title}' is not supported in the flat queue harness.`,
        plan.rel
      );
    }
  }

  const mustLand = parseMustLandChecklist(plan.content);
  if (mustLand.length === 0) {
    addFinding(findings, 'EMPTY_MUST_LAND', 'Must-Land Checklist must contain at least one checkbox item.', plan.rel);
  }
  for (const entry of mustLand) {
    if (!entry.id) {
      addFinding(findings, 'MISSING_MUST_LAND_ID', 'Each must-land checkbox should begin with a backticked stable ID.', plan.rel);
      break;
    }
  }
  if (plan.phase === 'completed' && mustLand.some((entry) => !entry.checked)) {
    addFinding(findings, 'UNCHECKED_MUST_LAND', 'Completed plans must have every must-land item checked.', plan.rel);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filterPlanId = parsePlanId(options['plan-id'] ?? options.planId, null);
  const scope = normalizeScope(options.scope);
  const findings = [];
  const allLoadedPlans = await loadPlans();
  const plans = allLoadedPlans.filter((plan) => scope === 'all' || plan.phase !== 'completed');
  const seenPlanIds = new Set();
  const allPlanIds = new Set(allLoadedPlans.map((plan) => plan.planId).filter(Boolean));

  for (const plan of plans) {
    if (filterPlanId && plan.planId !== filterPlanId) {
      continue;
    }
    validateRequiredMetadata(plan, findings);
    validateLegacyMetadata(plan, findings);
    validatePlanIdentity(plan, findings, seenPlanIds);
    validateStatus(plan, findings);
    validateMetadataValues(plan, findings, allPlanIds);
    validatePlanSections(plan, findings);
  }

  if (findings.length > 0) {
    console.error(`[plans:verify] failed with ${findings.length} issue(s).`);
    for (const finding of findings) {
      console.error(`- [${finding.code}] ${finding.message} (${finding.filePath})`);
    }
    process.exit(1);
  }

  console.log(`[plans:verify] ok (${filterPlanId ? `plan=${filterPlanId}` : `${plans.length} plan(s)`} scope=${scope}).`);
}

main().catch((error) => {
  console.error('[plans:verify] failed with an unexpected error.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
