#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REPORT_PATH = 'docs/generated/perf-comparison.json';
const DEFAULT_OUTCOMES_PATH = 'docs/generated/run-outcomes.json';
const DEFAULT_MODE = 'auto';
const DEFAULT_FRESHNESS_DAYS = 30;
const DEFAULT_MIN_SESSION_SAMPLE = 25;
const DEFAULT_MIN_PLAN_SAMPLE = 10;
const DEFAULT_BUDGETS = Object.freeze({
  runtimeContextTokens: 10,
  verifyFastDurationMs: 15,
  verifyFullDurationMs: 15,
  timeToFirstWorkerEditMedianSeconds: 15,
  averageSessionsPerCompletedPlan: 10
});

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

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMode(value, fallback = DEFAULT_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'warn' || normalized === 'warning') {
    return 'warn';
  }
  if (normalized === 'enforce' || normalized === 'strict') {
    return 'enforce';
  }
  return 'auto';
}

function shouldEnforce(mode) {
  if (mode === 'enforce') {
    return true;
  }
  if (mode === 'warn') {
    return false;
  }
  return asBoolean(process.env.CI, false) || asBoolean(process.env.ORCH_ENFORCE_PERF_GATES, false);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageInDays(isoTimestamp) {
  const parsed = parseTimestamp(isoTimestamp);
  if (parsed == null) {
    return null;
  }
  return (Date.now() - parsed) / (24 * 60 * 60 * 1000);
}

function metricDelta(report, key) {
  const entry = report?.comparison?.[key];
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const from = asNumber(entry.from);
  const to = asNumber(entry.to);
  const deltaPercent = asNumber(entry.deltaPercent);
  if (from == null || to == null || deltaPercent == null) {
    return null;
  }
  return {
    from,
    to,
    deltaPercent
  };
}

function evaluateMetric(result, name, budgetPercent, reasons, findings) {
  if (!result.comparable) {
    reasons.push(`[perf-verify] skipped ${name}: ${result.reason}`);
    return;
  }
  if (result.deltaPercent > budgetPercent) {
    findings.push(
      `${name} regressed ${result.deltaPercent}% (budget ${budgetPercent}%, baseline=${result.from}, current=${result.to})`
    );
    return;
  }
  reasons.push(
    `[perf-verify] passed ${name}: ${result.deltaPercent}% change within budget ${budgetPercent}%`
  );
}

function buildComparableMetricResult(comparisonEntry, reason) {
  if (!comparisonEntry) {
    return {
      comparable: false,
      reason
    };
  }
  return {
    comparable: true,
    ...comparisonEntry
  };
}

function evaluatePerfBudgets(report, outcomesReport, options = {}) {
  const reasons = [];
  const findings = [];
  const freshnessDays = Math.max(1, asNumber(options.freshnessDays, DEFAULT_FRESHNESS_DAYS));
  const minSessions = Math.max(1, asNumber(options.minSessions, DEFAULT_MIN_SESSION_SAMPLE));
  const minPlans = Math.max(1, asNumber(options.minPlans, DEFAULT_MIN_PLAN_SAMPLE));
  const budgets = {
    ...DEFAULT_BUDGETS,
    ...(options.budgets ?? {})
  };

  const baseline = report?.samples?.baseline ?? null;
  const after = report?.samples?.after ?? null;
  if (!baseline || !after) {
    return {
      findings,
      reasons: ['[perf-verify] skipped (missing baseline or after sample).']
    };
  }

  const reportAgeDays = ageInDays(report?.generatedAtUtc ?? report?.generatedAt);
  if (reportAgeDays == null) {
    reasons.push('[perf-verify] skipped freshness check: missing generatedAt timestamp.');
  } else if (reportAgeDays > freshnessDays) {
    return {
      findings,
      reasons: [`[perf-verify] skipped (baseline report stale: ${reportAgeDays.toFixed(1)}d > ${freshnessDays}d).`]
    };
  }

  const runtimeTokens = buildComparableMetricResult(
    metricDelta(report, 'runtimeContextTokens'),
    'missing runtime context comparison'
  );
  evaluateMetric(runtimeTokens, 'runtimeContextTokens', budgets.runtimeContextTokens, reasons, findings);

  const verifyFastStatuses = [
    asNumber(baseline?.validation?.verifyFastStatus, null),
    asNumber(after?.validation?.verifyFastStatus, null)
  ];
  const verifyFast = verifyFastStatuses.every((status) => status === 0)
    ? buildComparableMetricResult(metricDelta(report, 'verifyFastDurationMs'), 'missing verify-fast comparison')
    : { comparable: false, reason: 'verify-fast timing unavailable because one or more samples failed' };
  evaluateMetric(verifyFast, 'verifyFastDurationMs', budgets.verifyFastDurationMs, reasons, findings);

  const verifyFullStatuses = [
    asNumber(baseline?.validation?.verifyFullStatus, null),
    asNumber(after?.validation?.verifyFullStatus, null)
  ];
  const verifyFull = verifyFullStatuses.every((status) => status === 0)
    ? buildComparableMetricResult(metricDelta(report, 'verifyFullDurationMs'), 'missing verify-full comparison')
    : { comparable: false, reason: 'verify-full timing unavailable because one or more samples failed' };
  evaluateMetric(verifyFull, 'verifyFullDurationMs', budgets.verifyFullDurationMs, reasons, findings);

  const baselineWorkerEditSample = asNumber(baseline?.orchestration?.timeToFirstWorkerEditSampleSize, null);
  const afterWorkerEditSample = asNumber(after?.orchestration?.timeToFirstWorkerEditSampleSize, null);
  const workerEditSufficient = baselineWorkerEditSample != null &&
    afterWorkerEditSample != null &&
    baselineWorkerEditSample >= minSessions &&
    afterWorkerEditSample >= minSessions;
  const workerEdit = workerEditSufficient
    ? buildComparableMetricResult(
      metricDelta(report, 'timeToFirstWorkerEditMedianSeconds'),
      'missing time-to-first-worker-edit comparison'
    )
    : {
      comparable: false,
      reason: `insufficient time-to-first-worker-edit sample (${baselineWorkerEditSample ?? 0}/${afterWorkerEditSample ?? 0}, need ${minSessions})`
    };
  evaluateMetric(
    workerEdit,
    'timeToFirstWorkerEditMedianSeconds',
    budgets.timeToFirstWorkerEditMedianSeconds,
    reasons,
    findings
  );

  const baselineCompletedPlans = asNumber(baseline?.orchestration?.completedPlansSampleSize, null);
  const afterCompletedPlans = asNumber(after?.orchestration?.completedPlansSampleSize, null);
  const sessionsPerPlanSufficient = baselineCompletedPlans != null &&
    afterCompletedPlans != null &&
    baselineCompletedPlans >= minPlans &&
    afterCompletedPlans >= minPlans;
  const sessionsPerPlan = sessionsPerPlanSufficient
    ? buildComparableMetricResult(
      metricDelta(report, 'averageSessionsPerCompletedPlan'),
      'missing sessions-per-plan comparison'
    )
    : {
      comparable: false,
      reason: `insufficient completed-plan sample (${baselineCompletedPlans ?? 0}/${afterCompletedPlans ?? 0}, need ${minPlans})`
    };
  evaluateMetric(
    sessionsPerPlan,
    'averageSessionsPerCompletedPlan',
    budgets.averageSessionsPerCompletedPlan,
    reasons,
    findings
  );

  const currentWorkerEditSample = asNumber(
    outcomesReport?.summary?.speed?.timeToFirstWorkerEditSeconds?.sampleSize,
    null
  );
  if (currentWorkerEditSample != null && currentWorkerEditSample < minSessions) {
    reasons.push(
      `[perf-verify] advisory current worker-edit sample below floor (${currentWorkerEditSample}/${minSessions}).`
    );
  }

  return { findings, reasons };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const mode = asBoolean(options['warn-only'], false)
    ? 'warn'
    : normalizeMode(options.mode, DEFAULT_MODE);
  const enforce = shouldEnforce(mode);
  const reportPath = path.join(rootDir, String(options.report ?? DEFAULT_REPORT_PATH));
  const outcomesPath = path.join(rootDir, String(options.outcomes ?? DEFAULT_OUTCOMES_PATH));

  const [report, outcomesReport] = await Promise.all([
    readJson(reportPath),
    readJson(outcomesPath).catch(() => null)
  ]);

  const evaluation = evaluatePerfBudgets(report, outcomesReport, {
    freshnessDays: options['freshness-days'],
    minSessions: options['min-sessions'],
    minPlans: options['min-plans']
  });

  for (const reason of evaluation.reasons) {
    console.log(reason);
  }

  if (evaluation.findings.length === 0) {
    const anyComparable = evaluation.reasons.some((entry) => entry.startsWith('[perf-verify] passed'));
    if (anyComparable) {
      console.log('[perf-verify] passed.');
    }
    return;
  }

  const prefix = enforce ? '[perf-verify] failed:' : '[perf-verify] warning:';
  for (const finding of evaluation.findings) {
    console.log(`${prefix} ${finding}`);
  }
  if (enforce) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[perf-verify] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
