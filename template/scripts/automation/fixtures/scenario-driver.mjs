import fs from 'node:fs/promises';
import path from 'node:path';

import {
  appendToDeliveryLog,
  setPlanDocumentFields,
  upsertSection
} from '../lib/plan-document-state.mjs';
import { writeTextFileAtomic } from '../lib/orchestrator-shared.mjs';
import {
  CONTRACT_IDS,
  prepareContractPayload
} from '../lib/contracts/index.mjs';

const SCENARIO_PATHS = [
  path.join('docs', 'ops', 'automation', 'runtime', 'fixture-scenario.json'),
  path.join('docs', 'ops', 'automation', 'fixture-scenario.json')
];
const STATE_PATH = path.join('docs', 'ops', 'automation', 'runtime', 'fixture-driver-state.json');

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function nextScenarioStep(rootDir, group, key, fallback = {}) {
  const statePath = path.join(rootDir, STATE_PATH);
  let scenario = {};
  for (const scenarioPath of SCENARIO_PATHS) {
    scenario = await readJsonIfExists(path.join(rootDir, scenarioPath), null);
    if (scenario && typeof scenario === 'object') {
      break;
    }
  }
  if (!scenario || typeof scenario !== 'object') {
    scenario = {};
  }
  const state = await readJsonIfExists(statePath, {});
  const groupState = state[group] && typeof state[group] === 'object' ? state[group] : {};
  const index = Number.isFinite(groupState[key]) ? groupState[key] : 0;
  const steps = Array.isArray(scenario?.[group]?.[key])
    ? scenario[group][key]
    : Array.isArray(scenario?.[group]?.default)
      ? scenario[group].default
      : [];
  const step = steps.length > 0 ? (steps[Math.min(index, steps.length - 1)] ?? fallback) : fallback;
  state[group] = {
    ...groupState,
    [key]: index + 1
  };
  await writeJson(statePath, state);
  return step && typeof step === 'object' ? step : fallback;
}

export async function applyTouches(rootDir, touches = []) {
  for (const entry of Array.isArray(touches) ? touches : []) {
    const relPath = String(entry?.path ?? '').trim().replace(/^\.?\//, '');
    if (!relPath) {
      continue;
    }
    const absPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const content = String(entry?.content ?? '');
    const mode = String(entry?.mode ?? 'append').trim().toLowerCase();
    if (mode === 'replace') {
      await fs.writeFile(absPath, content, 'utf8');
      continue;
    }
    await fs.appendFile(absPath, content || `${relPath}\n`, 'utf8');
  }
}

export async function applyPlanStep(rootDir, planFile, step = {}) {
  if (!planFile) {
    return;
  }
  const absPath = path.join(rootDir, String(planFile).trim());
  let content = await fs.readFile(absPath, 'utf8');
  const planFields = step.planFields && typeof step.planFields === 'object' ? step.planFields : {};
  if (Object.keys(planFields).length > 0) {
    content = setPlanDocumentFields(content, planFields);
  }
  if (step.checkAllMustLand === true) {
    content = content.replace(/^-\s+\[\s\]\s+/gm, '- [x] ');
  }
  if (step.deliveryLog) {
    content = appendToDeliveryLog(content, String(step.deliveryLog));
  }
  if (Array.isArray(step.sections)) {
    for (const section of step.sections) {
      const title = String(section?.title ?? '').trim();
      if (!title) {
        continue;
      }
      const body = Array.isArray(section?.lines)
        ? section.lines.map((line) => String(line))
        : String(section?.body ?? '');
      content = upsertSection(content, title, body);
    }
  }
  await fs.writeFile(absPath, content, 'utf8');
}

export function structuredResult(step = {}, defaults = {}) {
  const status = String(step.status ?? defaults.status ?? 'completed').trim().toLowerCase();
  return {
    status,
    summary: String(step.summary ?? defaults.summary ?? `${status} via fixture stub`).trim(),
    reason: String(step.reason ?? defaults.reason ?? '').trim() || null,
    contextRemaining: Number.isFinite(step.contextRemaining) ? step.contextRemaining : 48000,
    contextWindow: Number.isFinite(step.contextWindow) ? step.contextWindow : 128000,
    currentSubtask: String(step.currentSubtask ?? defaults.currentSubtask ?? 'fixture-execution').trim(),
    nextAction: String(step.nextAction ?? defaults.nextAction ?? 'Continue deterministic fixture flow').trim(),
    stateDelta: {
      completedWork: Array.isArray(step.completedWork) ? step.completedWork : [String(step.summary ?? defaults.summary ?? status)],
      acceptedFacts: Array.isArray(step.acceptedFacts) ? step.acceptedFacts : [],
      decisions: Array.isArray(step.decisions) ? step.decisions : [],
      openQuestions: Array.isArray(step.openQuestions) ? step.openQuestions : [],
      pendingActions: Array.isArray(step.pendingActions) ? step.pendingActions : [],
      recentResults: Array.isArray(step.recentResults) ? step.recentResults : [],
      artifacts: Array.isArray(step.artifacts) ? step.artifacts : [],
      risks: Array.isArray(step.risks) ? step.risks : [],
      reasoning: Array.isArray(step.reasoning) ? step.reasoning : [],
      evidence: Array.isArray(step.evidence) ? step.evidence : []
    }
  };
}

export async function writeStructuredResult(resultPath, payload) {
  const normalized = prepareContractPayload(CONTRACT_IDS.validationResult, payload);
  await writeTextFileAtomic(resultPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

export function emitStructuredResultEnvelope(payload, stream = process.stdout) {
  stream.write(`${JSON.stringify({ type: 'orch_result', payload })}\n`);
}

export function emitAgentMessageStructuredResultEvent(payload, stream = process.stdout) {
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: JSON.stringify({ type: 'orch_result', payload })
    }
  })}\n`);
}

export function emitTruncatedAgentMessageStructuredResultEvent(payload, maxChars, stream = process.stdout) {
  const truncated = JSON.stringify({ type: 'orch_result', payload }).slice(0, Math.max(1, Number(maxChars) || 1));
  stream.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: truncated
    }
  })}\n`);
}
