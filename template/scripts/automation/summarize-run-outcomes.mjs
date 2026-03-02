#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EVENTS_PATH = 'docs/ops/automation/run-events.jsonl';
const DEFAULT_OUTPUT_PATH = 'docs/generated/run-outcomes.json';

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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(event) {
  const candidates = [
    event?.timestamp,
    event?.occurredAt,
    event?.time,
    event?.at,
    event?.createdAt,
    event?.meta?.timestamp
  ];

  for (const value of candidates) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue;
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function toEventType(event) {
  const value = String(event?.type ?? event?.event ?? 'unknown').trim();
  return value.length > 0 ? value : 'unknown';
}

function eventDetails(event) {
  if (event?.details && typeof event.details === 'object' && !Array.isArray(event.details)) {
    return event.details;
  }
  return {};
}

function toPlanId(event) {
  const details = eventDetails(event);
  const direct = String(event?.planId ?? event?.taskId ?? details.planId ?? details.taskId ?? '').trim();
  if (direct) {
    return direct;
  }
  const nested = String(event?.plan?.id ?? '').trim();
  return nested || null;
}

function toRunId(event) {
  const details = eventDetails(event);
  const direct = String(event?.runId ?? details.runId ?? '').trim();
  if (direct) {
    return direct;
  }
  const nested = String(event?.run?.id ?? '').trim();
  return nested || null;
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();

  const eventsPath = path.resolve(rootDir, String(options.events ?? DEFAULT_EVENTS_PATH));
  const outputPath = path.resolve(rootDir, String(options.output ?? DEFAULT_OUTPUT_PATH));

  const eventTypeCounts = new Map();
  const runIds = new Set();
  const planIds = new Set();
  const planStats = new Map();

  let totalLines = 0;
  let parsedEvents = 0;
  let malformedLines = 0;

  if (await exists(eventsPath)) {
    const raw = await fs.readFile(eventsPath, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    totalLines = lines.length;

    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }

      parsedEvents += 1;
      const type = toEventType(event);
      const typeLower = type.toLowerCase();
      eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1);

      const runId = toRunId(event);
      if (runId) {
        runIds.add(runId);
      }

      const planId = toPlanId(event);
      const timestamp = parseTimestamp(event);

      if (!planId) {
        continue;
      }

      planIds.add(planId);
      if (!planStats.has(planId)) {
        planStats.set(planId, {
          firstSeenMs: null,
          lastSeenMs: null,
          terminalMs: null,
          completed: 0,
          failed: 0,
          blocked: 0,
          pending: 0,
          handoff: 0,
          workerNoTouchRetries: 0,
          firstWorkerEditSeconds: null,
          stageDurationsSeconds: {
            planner: [],
            explorer: [],
            worker: [],
            reviewer: []
          },
          validationPassed: 0,
          validationFailed: 0,
          validationBlocked: 0
        });
      }

      const stats = planStats.get(planId);
      const details = eventDetails(event);
      const timestampMs = timestamp ? timestamp.getTime() : null;
      if (timestampMs !== null) {
        if (stats.firstSeenMs === null || timestampMs < stats.firstSeenMs) {
          stats.firstSeenMs = timestampMs;
        }
        if (stats.lastSeenMs === null || timestampMs > stats.lastSeenMs) {
          stats.lastSeenMs = timestampMs;
        }
      }

      if (typeLower.includes('completed')) {
        stats.completed += 1;
        if (timestampMs !== null) {
          stats.terminalMs = stats.terminalMs === null ? timestampMs : Math.max(stats.terminalMs, timestampMs);
        }
      }
      if (typeLower.includes('failed')) {
        stats.failed += 1;
        if (timestampMs !== null) {
          stats.terminalMs = stats.terminalMs === null ? timestampMs : Math.max(stats.terminalMs, timestampMs);
        }
      }
      if (typeLower.includes('blocked')) {
        stats.blocked += 1;
        if (timestampMs !== null) {
          stats.terminalMs = stats.terminalMs === null ? timestampMs : Math.max(stats.terminalMs, timestampMs);
        }
      }
      if (typeLower.includes('pending')) {
        stats.pending += 1;
      }
      if (typeLower.includes('handoff') || typeLower.includes('rollover')) {
        stats.handoff += 1;
      }
      if (typeLower === 'session_pending_no_touch_retry') {
        stats.workerNoTouchRetries += 1;
      }

      if (typeLower === 'worker_first_edit') {
        const firstEditSeconds = asNumber(details.secondsFromPlanStart);
        if (firstEditSeconds != null && firstEditSeconds >= 0) {
          stats.firstWorkerEditSeconds =
            stats.firstWorkerEditSeconds == null
              ? firstEditSeconds
              : Math.min(stats.firstWorkerEditSeconds, firstEditSeconds);
        }
      }
      if (typeLower === 'session_finished') {
        const role = String(details.role ?? '').trim().toLowerCase();
        const durationSeconds = asNumber(details.durationSeconds);
        if (role && Array.isArray(stats.stageDurationsSeconds?.[role]) && durationSeconds != null && durationSeconds >= 0) {
          stats.stageDurationsSeconds[role].push(durationSeconds);
        }

        const touchCount = asNumber(details.touchCount);
        if (
          role === 'worker' &&
          (touchCount ?? 0) > 0 &&
          stats.firstWorkerEditSeconds == null &&
          stats.firstSeenMs != null &&
          timestampMs != null &&
          timestampMs >= stats.firstSeenMs
        ) {
          stats.firstWorkerEditSeconds = (timestampMs - stats.firstSeenMs) / 1000;
        }
      }

      if (typeLower.includes('validation')) {
        if (typeLower.includes('passed') || typeLower.includes('success')) {
          stats.validationPassed += 1;
        } else if (typeLower.includes('failed') || typeLower.includes('error')) {
          stats.validationFailed += 1;
        } else if (typeLower.includes('blocked') || typeLower.includes('pending')) {
          stats.validationBlocked += 1;
        }
      }
    }
  }

  const leadTimesSeconds = [];
  let completedPlans = 0;
  let failedPlans = 0;
  let blockedPlans = 0;
  let pendingPlans = 0;
  let handoffEvents = 0;
  let workerNoTouchRetries = 0;
  let validationPassed = 0;
  let validationFailed = 0;
  let validationBlocked = 0;
  const firstWorkerEditSeconds = [];
  const handoffsPerPlan = [];
  const stageDurationsSeconds = {
    planner: [],
    explorer: [],
    worker: [],
    reviewer: []
  };

  for (const stats of planStats.values()) {
    if (stats.completed > 0) {
      completedPlans += 1;
    }
    if (stats.failed > 0) {
      failedPlans += 1;
    }
    if (stats.blocked > 0) {
      blockedPlans += 1;
    }
    if (stats.pending > 0) {
      pendingPlans += 1;
    }

    handoffEvents += stats.handoff;
    handoffsPerPlan.push(stats.handoff);
    workerNoTouchRetries += stats.workerNoTouchRetries;
    validationPassed += stats.validationPassed;
    validationFailed += stats.validationFailed;
    validationBlocked += stats.validationBlocked;
    if (asNumber(stats.firstWorkerEditSeconds) != null) {
      firstWorkerEditSeconds.push(stats.firstWorkerEditSeconds);
    }
    for (const role of Object.keys(stageDurationsSeconds)) {
      const durations = Array.isArray(stats.stageDurationsSeconds?.[role]) ? stats.stageDurationsSeconds[role] : [];
      for (const duration of durations) {
        if (asNumber(duration) != null) {
          stageDurationsSeconds[role].push(duration);
        }
      }
    }

    if (asNumber(stats.firstSeenMs) !== null && asNumber(stats.terminalMs) !== null && stats.terminalMs >= stats.firstSeenMs) {
      leadTimesSeconds.push((stats.terminalMs - stats.firstSeenMs) / 1000);
    }
  }

  const evidenceCompacted = eventTypeCounts.get('evidence_compacted') ?? 0;
  const evidenceCurated = eventTypeCounts.get('evidence_curated') ?? 0;

  const eventTypeEntries = [...eventTypeCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => ({ type, count }));

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      eventsPath: toPosix(path.relative(rootDir, eventsPath)),
      outputPath: toPosix(path.relative(rootDir, outputPath)),
      eventsFileExists: await exists(eventsPath),
      totalLines,
      parsedEvents,
      malformedLines
    },
    summary: {
      runs: runIds.size,
      plans: planIds.size,
      completion: {
        completedPlans,
        failedPlans,
        blockedPlans,
        pendingPlans
      },
      leadTimeSeconds: {
        sampleSize: leadTimesSeconds.length,
        mean: round(mean(leadTimesSeconds)),
        median: round(median(leadTimesSeconds))
      },
      speed: {
        timeToFirstWorkerEditSeconds: {
          sampleSize: firstWorkerEditSeconds.length,
          mean: round(mean(firstWorkerEditSeconds)),
          median: round(median(firstWorkerEditSeconds))
        },
        stageDurationsSeconds: {
          planner: {
            sampleSize: stageDurationsSeconds.planner.length,
            mean: round(mean(stageDurationsSeconds.planner)),
            median: round(median(stageDurationsSeconds.planner))
          },
          explorer: {
            sampleSize: stageDurationsSeconds.explorer.length,
            mean: round(mean(stageDurationsSeconds.explorer)),
            median: round(median(stageDurationsSeconds.explorer))
          },
          worker: {
            sampleSize: stageDurationsSeconds.worker.length,
            mean: round(mean(stageDurationsSeconds.worker)),
            median: round(median(stageDurationsSeconds.worker))
          },
          reviewer: {
            sampleSize: stageDurationsSeconds.reviewer.length,
            mean: round(mean(stageDurationsSeconds.reviewer)),
            median: round(median(stageDurationsSeconds.reviewer))
          }
        }
      },
      validation: {
        passed: validationPassed,
        failed: validationFailed,
        blockedOrPending: validationBlocked
      },
      evidence: {
        curatedEvents: evidenceCurated,
        compactedEvents: evidenceCompacted
      },
      rework: {
        handoffOrRolloverEvents: handoffEvents,
        handoffsPerPlan: {
          sampleSize: handoffsPerPlan.length,
          mean: round(mean(handoffsPerPlan)),
          median: round(median(handoffsPerPlan))
        },
        workerNoTouchRetries
      }
    },
    eventTypeCounts: eventTypeEntries
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(
    `[outcomes-report] wrote ${toPosix(path.relative(rootDir, outputPath))} (events=${parsedEvents}, plans=${planIds.size}, runs=${runIds.size}).`
  );
}

main().catch((error) => {
  console.error('[outcomes-report] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
