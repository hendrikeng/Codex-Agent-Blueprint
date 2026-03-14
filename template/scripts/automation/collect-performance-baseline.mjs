#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_OUTPUT = 'docs/generated/perf-comparison.json';
const DEFAULT_RUNTIME_CONTEXT = 'docs/generated/AGENT-RUNTIME-CONTEXT.md';
const DEFAULT_EVENTS = 'docs/ops/automation/run-events.jsonl';
const DEFAULT_STAGE = 'baseline';

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
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${toPosix(filePath)}: ${message}`);
  }
}

function countTokensApprox(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function runCommandTimed(command, { allowFailure = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: process.env
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    throw result.error;
  }
  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    throw new Error(`Command failed (${status}): ${command}`);
  }
  return {
    command,
    status,
    durationMs
  };
}

function parseEventLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      events.push(parsed);
    } catch {
      // Ignore malformed lines.
    }
  }
  return events;
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeRunEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      runCount: 0,
      latestRunId: null,
      latestRunTimeToFirstActionSeconds: null,
      averageSessionsPerCompletedPlan: null
    };
  }

  const byRun = new Map();
  for (const event of events) {
    const runId = String(event?.runId ?? '').trim();
    if (!runId) {
      continue;
    }
    if (!byRun.has(runId)) {
      byRun.set(runId, {
        runId,
        startTs: null,
        firstActionTs: null,
        lastTs: null,
        sessionsFinished: 0,
        completedPlans: 0
      });
    }
    const summary = byRun.get(runId);
    const ts = parseTimestamp(event.timestamp);
    if (ts != null) {
      if (summary.startTs == null || ts < summary.startTs) {
        summary.startTs = ts;
      }
      if (summary.lastTs == null || ts > summary.lastTs) {
        summary.lastTs = ts;
      }
    }

    const type = String(event.type ?? '').trim();
    if (type === 'run_started' || type === 'run_started_parallel' || type === 'run_resumed') {
      if (ts != null && (summary.startTs == null || ts < summary.startTs)) {
        summary.startTs = ts;
      }
    }
    if (
      type === 'session_started' ||
      type === 'plan_started' ||
      type === 'parallel_worker_started'
    ) {
      if (ts != null && (summary.firstActionTs == null || ts < summary.firstActionTs)) {
        summary.firstActionTs = ts;
      }
    }
    if (type === 'session_finished') {
      summary.sessionsFinished += 1;
    }
    if (type === 'plan_completed' || type === 'plan_completed_parallel') {
      summary.completedPlans += 1;
    }
  }

  const runs = [...byRun.values()].sort((left, right) => (right.lastTs ?? 0) - (left.lastTs ?? 0));
  const latest = runs[0] ?? null;
  const totalSessions = runs.reduce((sum, run) => sum + run.sessionsFinished, 0);
  const totalCompletedPlans = runs.reduce((sum, run) => sum + run.completedPlans, 0);
  const avgSessions = totalCompletedPlans > 0 ? totalSessions / totalCompletedPlans : null;

  const timeToFirstActionSeconds = latest && latest.startTs != null && latest.firstActionTs != null
    ? Number(((latest.firstActionTs - latest.startTs) / 1000).toFixed(2))
    : null;

  return {
    runCount: runs.length,
    latestRunId: latest?.runId ?? null,
    latestRunTimeToFirstActionSeconds: timeToFirstActionSeconds,
    averageSessionsPerCompletedPlan: avgSessions == null ? null : Number(avgSessions.toFixed(3))
  };
}

function computeDelta(from, to) {
  if (from == null || to == null) {
    return null;
  }
  const raw = to - from;
  const pct = from !== 0 ? (raw / from) * 100 : null;
  return {
    from,
    to,
    delta: Number(raw.toFixed(3)),
    deltaPercent: pct == null ? null : Number(pct.toFixed(2))
  };
}

function buildComparison(samples) {
  const baseline = samples.baseline ?? null;
  const after = samples.after ?? null;
  if (!baseline || !after) {
    return null;
  }
  return {
    runtimeContextTokens: computeDelta(
      asNumber(baseline.runtimeContext?.tokens, null),
      asNumber(after.runtimeContext?.tokens, null)
    ),
    latestRunTimeToFirstActionSeconds: computeDelta(
      asNumber(baseline.orchestration?.latestRunTimeToFirstActionSeconds, null),
      asNumber(after.orchestration?.latestRunTimeToFirstActionSeconds, null)
    ),
    averageSessionsPerCompletedPlan: computeDelta(
      asNumber(baseline.orchestration?.averageSessionsPerCompletedPlan, null),
      asNumber(after.orchestration?.averageSessionsPerCompletedPlan, null)
    ),
    verifyFastDurationMs: computeDelta(
      asNumber(baseline.validation?.verifyFastDurationMs, null),
      asNumber(after.validation?.verifyFastDurationMs, null)
    ),
    verifyFullDurationMs: computeDelta(
      asNumber(baseline.validation?.verifyFullDurationMs, null),
      asNumber(after.validation?.verifyFullDurationMs, null)
    )
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const stage = String(options.stage ?? DEFAULT_STAGE).trim().toLowerCase();
  if (stage !== 'baseline' && stage !== 'after') {
    throw new Error("--stage must be either 'baseline' or 'after'.");
  }

  const outputPath = path.resolve(rootDir, String(options.output ?? DEFAULT_OUTPUT));
  const configPath = path.resolve(rootDir, 'docs/ops/automation/orchestrator.config.json');
  const config = readJsonIfExists(configPath, {});
  const configuredRuntimeContext = String(config?.context?.runtimeContextPath ?? DEFAULT_RUNTIME_CONTEXT);
  const runtimeContextPath = path.resolve(rootDir, String(options['runtime-context'] ?? configuredRuntimeContext));
  const eventsPath = path.resolve(rootDir, String(options.events ?? DEFAULT_EVENTS));
  const runMeasurements = asBoolean(options.measure, false);

  const compileResult = runCommandTimed('node ./scripts/automation/compile-runtime-context.mjs', { allowFailure: false });
  if (compileResult.status !== 0) {
    throw new Error('Failed to compile runtime context before collecting metrics.');
  }

  const runtimeRaw = fs.existsSync(runtimeContextPath) ? fs.readFileSync(runtimeContextPath, 'utf8') : '';
  const runtimeStats = {
    path: toPosix(path.relative(rootDir, runtimeContextPath)),
    bytes: Buffer.byteLength(runtimeRaw, 'utf8'),
    lines: runtimeRaw.length > 0 ? runtimeRaw.split('\n').length : 0,
    tokens: countTokensApprox(runtimeRaw)
  };

  const events = parseEventLines(eventsPath);
  const orchestration = summarizeRunEvents(events);

  let verifyFastDurationMs = null;
  let verifyFastStatus = null;
  let verifyFullDurationMs = null;
  let verifyFullStatus = null;
  if (runMeasurements) {
    const fast = runCommandTimed('node ./scripts/automation/verify-fast.mjs', { allowFailure: true });
    verifyFastDurationMs = fast.durationMs;
    verifyFastStatus = fast.status;
    const full = runCommandTimed('node ./scripts/automation/verify-full.mjs', { allowFailure: true });
    verifyFullDurationMs = full.durationMs;
    verifyFullStatus = full.status;
  }

  const nextSample = {
    capturedAtUtc: new Date().toISOString(),
    runtimeContext: runtimeStats,
    orchestration,
    validation: {
      verifyFastDurationMs,
      verifyFastStatus,
      verifyFullDurationMs,
      verifyFullStatus
    }
  };

  const existing = readJsonIfExists(outputPath, {});
  const samples = {
    baseline: existing?.samples?.baseline ?? null,
    after: existing?.samples?.after ?? null
  };
  samples[stage] = nextSample;

  const payload = {
    generatedAtUtc: new Date().toISOString(),
    source: 'scripts/automation/collect-performance-baseline.mjs',
    notes: runMeasurements
      ? 'Validation timings were measured by executing verify-fast and verify-full.'
      : 'Validation timings are null unless --measure true is provided.',
    samples,
    comparison: buildComparison(samples)
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`[perf-baseline] wrote ${toPosix(path.relative(rootDir, outputPath))}.`);
  console.log(`[perf-baseline] stage=${stage} runtimeTokens=${runtimeStats.tokens} runtimeLines=${runtimeStats.lines}`);
  if (runMeasurements) {
    console.log(`[perf-baseline] verify-fast=${verifyFastDurationMs}ms status=${verifyFastStatus}`);
    console.log(`[perf-baseline] verify-full=${verifyFullDurationMs}ms status=${verifyFullStatus}`);
  }
}

main().catch((error) => {
  console.error('[perf-baseline] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
