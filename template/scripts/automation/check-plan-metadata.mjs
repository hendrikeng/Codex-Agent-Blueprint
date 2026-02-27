#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_STATUSES,
  COMPLETED_STATUSES,
  FUTURE_STATUSES,
  REQUIRED_METADATA_FIELDS,
  listMarkdownFiles,
  metadataValue,
  parseListField,
  parseMetadata,
  normalizeStatus,
  inferPlanId
} from './lib/plan-metadata.mjs';

const rootDir = process.cwd();
const directories = {
  future: path.join(rootDir, 'docs', 'future'),
  active: path.join(rootDir, 'docs', 'exec-plans', 'active'),
  completed: path.join(rootDir, 'docs', 'exec-plans', 'completed')
};

const findings = [];

function addFinding(code, message, filePath) {
  findings.push({ code, message, filePath });
}

async function scanPhase(phase, directoryPath) {
  const files = await listMarkdownFiles(directoryPath);
  const plans = [];

  for (const filePath of files) {
    const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
    const content = await fs.readFile(filePath, 'utf8');
    const metadata = parseMetadata(content);

    const requiredFields = REQUIRED_METADATA_FIELDS[phase] ?? [];
    for (const field of requiredFields) {
      if (!metadataValue(metadata, field)) {
        addFinding('MISSING_METADATA_FIELD', `Missing metadata field '${field}'`, rel);
      }
    }

    const status = normalizeStatus(metadataValue(metadata, 'Status'));
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

    if (!content.includes('## Metadata')) {
      addFinding('MISSING_METADATA_SECTION', "Missing '## Metadata' section", rel);
    }

    if (phase === 'completed') {
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
    }

    const planId = metadataValue(metadata, 'Plan-ID') ?? inferPlanId(content, filePath);
    plans.push({
      phase,
      rel,
      planId,
      dependencies: parseListField(metadataValue(metadata, 'Dependencies'))
    });
  }

  return plans;
}

async function main() {
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

  const summary = `plans=${allPlans.length} future=${futurePlans.length} active=${activePlans.length} completed=${completedPlans.length}`;

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
