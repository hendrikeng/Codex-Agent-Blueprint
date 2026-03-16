#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTRACT_IDS,
  parseContractPayload
} from './lib/contracts/index.mjs';
import {
  normalizeOrchestrationState,
  replayOrchestrationTransitions,
  summarizeOrchestrationState
} from './lib/orchestration-state-machine.mjs';

const DEFAULT_RUN_STATE_PATH = 'docs/ops/automation/run-state.json';
const DEFAULT_RUN_EVENTS_PATH = 'docs/ops/automation/run-events.jsonl';

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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function comparableSummary(summary) {
  if (!summary) {
    return null;
  }
  return {
    planState: summary.planState,
    stageState: summary.stageState,
    validationState: summary.validationState,
    currentRole: summary.currentRole,
    currentStageIndex: summary.currentStageIndex,
    currentStageTotal: summary.currentStageTotal,
    lastTransitionEvent: summary.lastTransitionEvent,
    lastTransitionCode: summary.lastTransitionCode,
    transitionCount: summary.transitionCount
  };
}

function parseRunEvents(raw, sourcePath) {
  const events = [];
  const lines = String(raw ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(parseContractPayload(CONTRACT_IDS.runEvent, JSON.parse(trimmed)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid run-event at ${sourcePath}:${index + 1}: ${reason}`);
    }
  }
  return events;
}

export function evaluateOrchestrationState(runState, runEvents) {
  const persistedStates = runState?.orchestrationState && typeof runState.orchestrationState === 'object'
    ? runState.orchestrationState
    : {};
  const eventsByPlan = new Map();
  for (const event of Array.isArray(runEvents) ? runEvents : []) {
    const planId = String(event?.details?.planId ?? event?.taskId ?? '').trim();
    if (!planId) {
      continue;
    }
    const entries = eventsByPlan.get(planId) ?? [];
    entries.push({
      type: event.type,
      details: event.details ?? {}
    });
    eventsByPlan.set(planId, entries);
  }

  const planIds = [...new Set([...Object.keys(persistedStates), ...eventsByPlan.keys()])].sort((a, b) => a.localeCompare(b));
  const mismatches = [];
  const replayErrors = [];
  const summaries = [];

  for (const planId of planIds) {
    const persistedSummary = persistedStates[planId]
      ? summarizeOrchestrationState(normalizeOrchestrationState(persistedStates[planId], { planId }))
      : null;
    try {
      const replayed = replayOrchestrationTransitions(eventsByPlan.get(planId) ?? []);
      const replayedSummary = replayed?.planId ? summarizeOrchestrationState(replayed) : null;
      const matches = JSON.stringify(comparableSummary(persistedSummary)) === JSON.stringify(comparableSummary(replayedSummary));
      if (!matches) {
        mismatches.push({
          planId,
          persisted: comparableSummary(persistedSummary),
          replayed: comparableSummary(replayedSummary)
        });
      }
      summaries.push({
        planId,
        persisted: comparableSummary(persistedSummary),
        replayed: comparableSummary(replayedSummary),
        matches
      });
    } catch (error) {
      replayErrors.push({
        planId,
        error: error instanceof Error ? error.message : String(error)
      });
      summaries.push({
        planId,
        persisted: comparableSummary(persistedSummary),
        replayed: null,
        matches: false
      });
    }
  }

  return {
    checkedPlans: planIds.length,
    mismatches,
    replayErrors,
    summaries
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const runStatePath = path.join(rootDir, String(options['run-state'] ?? DEFAULT_RUN_STATE_PATH));
  const runEventsPath = path.join(rootDir, String(options['run-events'] ?? DEFAULT_RUN_EVENTS_PATH));

  const [hasRunState, hasRunEvents] = await Promise.all([exists(runStatePath), exists(runEventsPath)]);
  if (!hasRunState && !hasRunEvents) {
    console.log('[state-verify] skipped (no run-state or run-events artifacts found).');
    return;
  }

  const [runState, runEvents] = await Promise.all([
    hasRunState
      ? fs.readFile(runStatePath, 'utf8').then((raw) => parseContractPayload(CONTRACT_IDS.runState, JSON.parse(raw)))
      : Promise.resolve(null),
    hasRunEvents
      ? fs.readFile(runEventsPath, 'utf8').then((raw) => parseRunEvents(raw, path.relative(rootDir, runEventsPath)))
      : Promise.resolve([])
  ]);

  const evaluation = evaluateOrchestrationState(runState, runEvents);
  if (evaluation.replayErrors.length > 0) {
    for (const entry of evaluation.replayErrors) {
      console.error(`[state-verify] replay error ${entry.planId}: ${entry.error}`);
    }
  }
  if (evaluation.mismatches.length > 0) {
    for (const entry of evaluation.mismatches) {
      console.error(
        `[state-verify] mismatch ${entry.planId}: persisted=${JSON.stringify(entry.persisted)} replayed=${JSON.stringify(entry.replayed)}`
      );
    }
  }
  if (evaluation.replayErrors.length > 0 || evaluation.mismatches.length > 0) {
    process.exit(1);
  }

  console.log(`[state-verify] passed (${evaluation.checkedPlans} plan(s) checked).`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error('[state-verify] failed.');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
