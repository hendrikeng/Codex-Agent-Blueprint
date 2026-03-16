#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  replayOrchestrationTransitions,
  summarizeOrchestrationState
} from '../automation/lib/orchestration-state-machine.mjs';

const DEFAULT_FIXTURES_PATH = 'docs/agent-hardening/resilience-fixtures.json';
const DEFAULT_OUTPUT_PATH = 'docs/generated/resilience-evals-report.json';

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

function summarizeChecks(checks) {
  const total = checks.length;
  const passed = checks.filter((entry) => entry.pass).length;
  return {
    total,
    passed,
    failed: total - passed,
    score: total > 0 ? Math.round((passed / total) * 10000) / 10000 : 0
  };
}

function findEvent(events, type) {
  return (Array.isArray(events) ? events : []).find((entry) => String(entry?.type ?? '').trim() === type) ?? null;
}

export function evaluateResilienceScenario(scenario) {
  const events = Array.isArray(scenario?.events) ? scenario.events : [];
  const expected = scenario?.expected && typeof scenario.expected === 'object' ? scenario.expected : {};
  const checks = [];

  let replayedSummary = null;
  let replayError = null;
  try {
    const replayed = replayOrchestrationTransitions(events.map((entry) => ({
      type: entry.type,
      details: entry.details ?? {}
    })));
    replayedSummary = replayed?.planId ? summarizeOrchestrationState(replayed) : null;
  } catch (error) {
    replayError = error instanceof Error ? error.message : String(error);
  }

  if (replayError) {
    checks.push({
      id: 'replay',
      pass: false,
      observed: replayError,
      expected: 'legal transition sequence'
    });
  } else {
    checks.push({
      id: 'replay',
      pass: true,
      observed: 'legal transition sequence',
      expected: 'legal transition sequence'
    });
  }

  const expectedFinalState = expected.finalState && typeof expected.finalState === 'object' ? expected.finalState : {};
  for (const [key, value] of Object.entries(expectedFinalState)) {
    checks.push({
      id: `finalState.${key}`,
      pass: replayedSummary?.[key] === value,
      observed: replayedSummary?.[key] ?? null,
      expected: value
    });
  }

  if (typeof expected.lastTransitionCode === 'string' && expected.lastTransitionCode.trim()) {
    checks.push({
      id: 'lastTransitionCode',
      pass: replayedSummary?.lastTransitionCode === expected.lastTransitionCode,
      observed: replayedSummary?.lastTransitionCode ?? null,
      expected: expected.lastTransitionCode
    });
  }

  const targetEvent = typeof expected.eventType === 'string' ? findEvent(events, expected.eventType) : null;
  if (typeof expected.eventType === 'string' && expected.eventType.trim()) {
    checks.push({
      id: 'eventType',
      pass: Boolean(targetEvent),
      observed: targetEvent ? expected.eventType : null,
      expected: expected.eventType
    });
  }

  if (typeof expected.faultCode === 'string' && expected.faultCode.trim()) {
    const observedFaultCode = targetEvent?.details?.faultCode ?? null;
    checks.push({
      id: 'faultCode',
      pass: observedFaultCode === expected.faultCode,
      observed: observedFaultCode,
      expected: expected.faultCode
    });
  }

  if (typeof expected.recoveryAction === 'string' && expected.recoveryAction.trim()) {
    const observedRecoveryAction = targetEvent?.details?.recoveryAction ?? null;
    checks.push({
      id: 'recoveryAction',
      pass: observedRecoveryAction === expected.recoveryAction,
      observed: observedRecoveryAction,
      expected: expected.recoveryAction
    });
  }

  const summary = summarizeChecks(checks);
  return {
    id: String(scenario?.id ?? '').trim() || 'unknown-scenario',
    suite: String(scenario?.suite ?? 'resilience-critical-faults').trim() || 'resilience-critical-faults',
    critical: scenario?.critical !== false,
    status: summary.failed === 0 ? 'pass' : 'fail',
    score: summary.score,
    checks,
    replayedState: replayedSummary
  };
}

export function evaluateResilienceFixtures(fixtures) {
  const scenarios = Array.isArray(fixtures?.scenarios) ? fixtures.scenarios : [];
  const results = scenarios.map(evaluateResilienceScenario);
  const suites = new Map();
  for (const result of results) {
    const current = suites.get(result.suite) ?? { id: result.suite, total: 0, passed: 0, failed: 0, skipped: 0 };
    current.total += 1;
    if (result.status === 'pass') current.passed += 1;
    if (result.status === 'fail') current.failed += 1;
    suites.set(result.suite, current);
  }
  const critical = results.filter((entry) => entry.critical);
  const criticalPassed = critical.filter((entry) => entry.status === 'pass');
  return {
    summary: {
      total: results.length,
      passed: results.filter((entry) => entry.status === 'pass').length,
      failed: results.filter((entry) => entry.status === 'fail').length,
      skipped: 0,
      passRate: results.length > 0 ? Math.round((results.filter((entry) => entry.status === 'pass').length / results.length) * 10000) / 10000 : null,
      criticalTotal: critical.length,
      criticalPassed: criticalPassed.length,
      criticalPassRate: critical.length > 0 ? Math.round((criticalPassed.length / critical.length) * 10000) / 10000 : null
    },
    suites: [...suites.values()].map((entry) => ({
      ...entry,
      status: entry.failed > 0 ? 'fail' : 'pass'
    })),
    scenarios: results,
    evidence: [
      DEFAULT_FIXTURES_PATH
    ]
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const fixturesPath = path.join(rootDir, String(options.fixtures ?? DEFAULT_FIXTURES_PATH));
  const outputPath = path.join(rootDir, String(options.output ?? DEFAULT_OUTPUT_PATH));
  const fixtures = JSON.parse(await fs.readFile(fixturesPath, 'utf8'));
  const report = {
    generatedAtUtc: new Date().toISOString(),
    ...evaluateResilienceFixtures(fixtures)
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[resilience-evals] wrote ${path.relative(rootDir, outputPath)} (${report.summary.passed}/${report.summary.total} passed).`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error('[resilience-evals] failed.');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
