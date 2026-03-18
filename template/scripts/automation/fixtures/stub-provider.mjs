#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  setPlanDocumentFields,
  upsertSection
} from '../lib/plan-document-state.mjs';
import {
  emitAgentMessageStructuredResultEvent,
  emitStructuredResultEnvelope,
  emitTruncatedAgentMessageStructuredResultEvent
} from './scenario-driver.mjs';

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

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function loadAction(scenario, state, planId, role) {
  const actionList = scenario?.providerActions?.[planId]?.[role] ?? [];
  const key = `${planId}:${role}`;
  const nextIndex = Number.isInteger(state.providerCounters?.[key]) ? state.providerCounters[key] : 0;
  state.providerCounters = state.providerCounters ?? {};
  state.providerCounters[key] = nextIndex + 1;
  if (actionList.length === 0) {
    return {
      status: 'completed',
      summary: `Default fixture action for ${planId}/${role}.`,
      reason: 'default'
    };
  }
  return actionList[Math.min(nextIndex, actionList.length - 1)];
}

function checkMustLandChecklist(content) {
  return content.replace(/^-\s+\[\s\]\s+(`ml-[^`]+`.*)$/gm, '- [x] $1');
}

async function applyPlanAction(planFile, action) {
  let content = await fs.readFile(planFile, 'utf8');
  if (action?.plan?.checkMustLand === true) {
    content = checkMustLandChecklist(content);
  }
  if (action?.plan?.status || action?.plan?.validationReady) {
    content = setPlanDocumentFields(content, {
      ...(action.plan.status ? { Status: action.plan.status } : {}),
      ...(action.plan.validationReady ? { 'Validation-Ready': action.plan.validationReady } : {})
    });
  }
  if (Array.isArray(action?.plan?.validationEvidence) && action.plan.validationEvidence.length > 0) {
    content = upsertSection(
      content,
      'Validation Evidence',
      action.plan.validationEvidence.map((line) => (line.startsWith('- ') ? line : `- ${line}`))
    );
  }
  await fs.writeFile(planFile, content, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resultPath = path.resolve(String(options['result-path'] ?? ''));
  const planFile = path.resolve(String(options['plan-file'] ?? ''));
  const planId = String(options['plan-id'] ?? '').trim();
  const role = String(options.role ?? '').trim();
  const rootDir = process.cwd();
  const scenarioPath = path.join(rootDir, 'docs', 'ops', 'automation', 'fixture-scenario.json');
  const statePath = path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'fixture-provider-state.json');
  const scenario = await readJson(scenarioPath, {});
  const state = await readJson(statePath, {});
  const action = loadAction(scenario, state, planId, role);

  process.stdout.write(`${JSON.stringify({
    type: 'progress',
    activity: action.liveActivity ?? `${role} working on ${planId}`
  })}\n`);

  const delayMs = Number(action?.delayMs);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await sleep(delayMs);
  }

  for (const file of action.writeFiles ?? []) {
    const targetPath = path.join(rootDir, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, String(file.content ?? ''), 'utf8');
  }

  if (action.plan) {
    await applyPlanAction(planFile, action);
  }

  await writeJson(statePath, state);
  if (typeof action.rawResultText === 'string') {
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, action.rawResultText, 'utf8');
    const exitCode = Number.isFinite(action?.exitCode) ? Number(action.exitCode) : 0;
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }
  const payload = {
    status: action.status ?? 'completed',
    summary: action.summary ?? `Fixture action ${planId}/${role}`,
    reason: action.reason ?? null,
    contextRemaining: Number.isFinite(action.contextRemaining) ? action.contextRemaining : 64000,
    contextWindow: Number.isFinite(action.contextWindow) ? action.contextWindow : 128000,
    currentSubtask: action.currentSubtask ?? `${planId}/${role}`,
    nextAction: action.nextAction ?? 'Continue orchestration.',
    stateDelta: {
      completedWork: action.completedWork ?? [],
      acceptedFacts: action.acceptedFacts ?? [],
      decisions: action.decisions ?? [],
      openQuestions: action.openQuestions ?? [],
      pendingActions: action.pendingActions ?? [],
      recentResults: action.recentResults ?? [],
      artifacts: action.artifacts ?? [],
      risks: action.risks ?? [],
      reasoning: {
        summary: action.reasoningSummary ?? 'Fixture provider action executed.',
        nextAction: action.nextAction ?? 'Continue orchestration.'
      },
      evidence: action.evidence ?? []
    }
  };
  if (action.emitResultEnvelope === true) {
    emitStructuredResultEnvelope(payload);
  }
  if (action.emitAgentMessageResultEvent === true) {
    emitAgentMessageStructuredResultEvent(payload);
  }
  if (Number.isFinite(action.truncatedAgentMessageResultChars) && Number(action.truncatedAgentMessageResultChars) > 0) {
    emitTruncatedAgentMessageStructuredResultEvent(payload, Number(action.truncatedAgentMessageResultChars));
  }
  if (action.skipResultWrite !== true) {
    await writeJson(resultPath, payload);
  }

  const exitCode = Number.isFinite(action?.exitCode) ? Number(action.exitCode) : 0;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  process.stderr.write(`[stub-provider] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
