import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  CAPABILITY_PROOF_MAP_SECTION,
  parseCapabilityProofMap,
  parseMustLandChecklist,
  todayIsoDate
} from './plan-metadata.mjs';
import {
  appendToDeliveryLog,
  removeSection,
  setPlanDocumentFields,
  updateSimpleMetadataField,
  upsertSection
} from './plan-document-state.mjs';
import {
  isProductPlan,
  isProgramPlan
} from './atomic-commit-policy.mjs';
import {
  parentScopeIdsForPlan,
  recompileProgramChildrenForParentScopes
} from './program-child-refresh.mjs';
import {
  CONTRACT_IDS,
  prepareContractPayload
} from './contracts/index.mjs';
import {
  asBoolean,
  asInteger,
  durationSeconds,
  exists,
  formatDuration,
  isoDate,
  nowIso,
  readJsonIfExists,
  resolveSafeRepoPath,
  snapshotFileState,
  restoreFileState,
  stringList,
  toPosix,
  trimmedString
} from './orchestrator-shared.mjs';

export function resolveDefaultValidationCommands(rootDir, configuredCommands) {
  if (Array.isArray(configuredCommands) && configuredCommands.length > 0) {
    return configuredCommands;
  }

  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fsSync.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
    const scripts = parsed.scripts ?? {};
    const preferred = ['docs:verify', 'conformance:verify', 'architecture:verify', 'agent:verify', 'plans:verify'];
    return preferred.filter((name) => typeof scripts[name] === 'string').map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

export function parseValidationCommandList(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value
    .split(';;')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeSemanticProofMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'required' ? 'required' : 'advisory';
}

export function validationLaneName(label) {
  return label.toLowerCase() === 'validation' ? 'always' : 'host-required';
}

export function derivedValidationCommandId(lane, index) {
  return `${lane}:${index + 1}`;
}

export function normalizeValidationCommandSpec(entry, lane, index) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const command = String(entry.command ?? '').trim();
    if (!command) {
      return null;
    }
    const explicitId = String(entry.id ?? '').trim();
    return {
      id: explicitId || derivedValidationCommandId(lane, index),
      command,
      type: String(entry.type ?? '').trim().toLowerCase(),
      emitsFindings: asBoolean(entry.emitsFindings, false),
      emitsArtifacts: asBoolean(entry.emitsArtifacts, false)
    };
  }

  const command = String(entry ?? '').trim();
  if (!command) {
    return null;
  }
  return {
    id: derivedValidationCommandId(lane, index),
    command,
    type: lane === 'host-required' ? 'host-required' : '',
    emitsFindings: false,
    emitsArtifacts: false
  };
}

export function normalizeValidationCommandSpecs(entries, lane) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => normalizeValidationCommandSpec(entry, lane, index))
    .filter(Boolean);
}

export function resolveAlwaysValidationCommands(rootDir, options, config) {
  const explicit = parseValidationCommandList(options.validationCommands);
  if (explicit.length > 0) {
    return normalizeValidationCommandSpecs(explicit, 'always');
  }

  if (Array.isArray(config.validation?.always) && config.validation.always.length > 0) {
    return normalizeValidationCommandSpecs(config.validation.always, 'always');
  }

  return normalizeValidationCommandSpecs(resolveDefaultValidationCommands(rootDir, config.validationCommands), 'always');
}

export function resolveHostRequiredValidationCommands(config) {
  return normalizeValidationCommandSpecs(config.validation?.hostRequired, 'host-required');
}

export function resolveHostValidationMode(config, defaultMode = 'hybrid') {
  const mode = String(config.validation?.host?.mode ?? defaultMode).trim().toLowerCase();
  if (mode === 'ci' || mode === 'local' || mode === 'hybrid') {
    return mode;
  }
  return defaultMode;
}

export function validationCommandResultPath(paths, state, plan, lane, spec, index) {
  const runId = state?.runId ?? 'run';
  const planToken = (plan?.planId ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-');
  const laneToken = String(lane ?? 'validation').replace(/[^A-Za-z0-9._-]/g, '-');
  const specToken = String(spec?.id ?? derivedValidationCommandId(lane, index)).replace(/[^A-Za-z0-9._-]/g, '-');
  const baseDir = path.join(paths.runtimeDir, runId, 'validation-results');
  const fileName = `${planToken}-${laneToken}-${index + 1}-${specToken}.json`;
  return {
    abs: path.join(baseDir, fileName),
    rel: toPosix(path.relative(paths.rootDir, path.join(baseDir, fileName)))
  };
}

export function normalizeValidationFindingFiles(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => toPosix(String(entry ?? '').trim()).replace(/^\.?\//, ''))
      .filter(Boolean)
  )];
}

export function normalizeValidationReferenceList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => toPosix(String(entry ?? '').trim()).replace(/^\.?\//, ''))
      .filter(Boolean)
  )];
}

export function normalizeValidationResultPayload(payload, spec, lane, command, outputLogPath = null) {
  const status = String(payload?.status ?? '').trim().toLowerCase();
  return prepareContractPayload(CONTRACT_IDS.validationResult, {
    validationId: String(payload?.validationId ?? spec.id).trim() || spec.id,
    command,
    lane,
    type: String(payload?.type ?? spec.type ?? '').trim().toLowerCase(),
    status: status === 'passed' || status === 'failed' || status === 'pending' ? status : '',
    summary: String(payload?.summary ?? '').trim(),
    startedAt: trimmedString(payload?.startedAt),
    finishedAt: trimmedString(payload?.finishedAt),
    evidenceRefs: normalizeValidationReferenceList(payload?.evidenceRefs),
    artifactRefs: normalizeValidationReferenceList(payload?.artifactRefs),
    findingFiles: normalizeValidationFindingFiles(payload?.findingFiles),
    outputLogPath
  });
}

export function ensurePlanValidationResults(state, planId) {
  if (!state.validationResults || typeof state.validationResults !== 'object') {
    state.validationResults = {};
  }
  if (!state.validationResults[planId] || typeof state.validationResults[planId] !== 'object') {
    state.validationResults[planId] = {
      always: [],
      'host-required': [],
      updatedAt: null
    };
  }
  return state.validationResults[planId];
}

export function updatePlanValidationResults(state, planId, lane, results) {
  const current = ensurePlanValidationResults(state, planId);
  current[lane] = Array.isArray(results) ? results : [];
  current.updatedAt = nowIso();
}

function planScopedValidationRoots(plan) {
  return [
    plan?.rel ?? '',
    `docs/exec-plans/active/evidence/${plan?.planId ?? ''}.md`,
    `docs/exec-plans/evidence-index/${plan?.planId ?? ''}.md`,
    ...(Array.isArray(plan?.specTargets) ? plan.specTargets : []),
    ...(Array.isArray(plan?.implementationTargets) ? plan.implementationTargets : [])
  ]
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
}

export function classifyValidationFailureScope(failedResult, plan, pathMatchesRootPrefix) {
  const findingFiles = normalizeValidationFindingFiles(failedResult?.findingFiles);
  if (findingFiles.length === 0) {
    return 'unknown';
  }
  const roots = planScopedValidationRoots(plan);
  const inScope = findingFiles.filter((filePath) => roots.some((root) => pathMatchesRootPrefix(filePath, root)));
  if (inScope.length === 0) {
    return 'external';
  }
  if (inScope.length === findingFiles.length) {
    return 'in-scope';
  }
  return 'mixed';
}

export function proofTypeIsStrong(type, validationRef = '') {
  return type === 'integration' || type === 'contract' || type === 'end-to-end' || type === 'host-required';
}

export function proofResultMatchesReference(result, reference) {
  if (!result || !reference) {
    return false;
  }
  if (result.validationId === reference) {
    return true;
  }
  if (result.outputLogPath === reference) {
    return true;
  }
  return (
    (Array.isArray(result.artifactRefs) && result.artifactRefs.includes(reference)) ||
    (Array.isArray(result.evidenceRefs) && result.evidenceRefs.includes(reference))
  );
}

export function semanticProofEvaluationMode(config) {
  return normalizeSemanticProofMode(config?.semanticProof?.mode);
}

export function evaluateSemanticProofCoverage(plan, state, config) {
  if (!isProductPlan(plan) || isProgramPlan(plan)) {
    return {
      applicable: false,
      mode: semanticProofEvaluationMode(config),
      satisfied: true,
      issues: [],
      mustLandCoverage: [],
      proofStatuses: []
    };
  }

  const content = plan?.content ?? '';
  const mustLandEntries = parseMustLandChecklist(content);
  const proofMap = parseCapabilityProofMap(content);
  const issues = [];
  const proofStatuses = [];
  const mustLandCoverage = [];
  const mode = semanticProofEvaluationMode(config);

  if (mustLandEntries.some((entry) => !entry.id)) {
    issues.push('Product slice must-land items are missing stable IDs.');
  }
  if (!/^##\s+Capability Proof Map\s*$/m.test(content)) {
    issues.push(`Plan is missing '## ${CAPABILITY_PROOF_MAP_SECTION}'.`);
  }
  for (const error of proofMap.errors) {
    issues.push(error);
  }

  const validationResults = state?.validationResults?.[plan.planId] ?? { always: [], 'host-required': [] };
  const allResults = [
    ...(Array.isArray(validationResults.always) ? validationResults.always : []),
    ...(Array.isArray(validationResults['host-required']) ? validationResults['host-required'] : [])
  ];
  const implementationRecordedAt = trimmedString(state?.implementationState?.[plan.planId]?.lastRecordedAt);
  const implementationRecordedAtMs = implementationRecordedAt ? Date.parse(implementationRecordedAt) : Number.NaN;
  const capabilitiesByMustLand = new Map();
  const proofsByCapability = new Map();

  for (const capability of proofMap.capabilities) {
    for (const mustLandId of capability.mustLandIds) {
      if (!capabilitiesByMustLand.has(mustLandId)) {
        capabilitiesByMustLand.set(mustLandId, []);
      }
      capabilitiesByMustLand.get(mustLandId).push(capability);
    }
  }
  for (const proof of proofMap.proofs) {
    if (!proofsByCapability.has(proof.capabilityId)) {
      proofsByCapability.set(proof.capabilityId, []);
    }
    proofsByCapability.get(proof.capabilityId).push(proof);
  }

  const capabilitySatisfied = new Map();
  for (const capability of proofMap.capabilities) {
    const proofs = proofsByCapability.get(capability.capabilityId) ?? [];
    let hasStrongFreshProof = false;
    let hasAnyFreshProof = false;

    for (const proof of proofs) {
      const matchedResult = allResults.find((result) => proofResultMatchesReference(result, proof.validationRef));
      const matched = Boolean(matchedResult) && matchedResult.status === 'passed';
      const finishedAtMs = matchedResult?.finishedAt ? Date.parse(matchedResult.finishedAt) : Number.NaN;
      const fresh = !matched
        ? false
        : !Number.isFinite(implementationRecordedAtMs) || !Number.isFinite(finishedAtMs) || finishedAtMs >= implementationRecordedAtMs;
      const strong = proofTypeIsStrong(proof.type, proof.validationRef);
      if (matched && fresh) {
        hasAnyFreshProof = true;
      }
      if (matched && fresh && strong) {
        hasStrongFreshProof = true;
      }
      proofStatuses.push({
        proofId: proof.proofId,
        capabilityId: proof.capabilityId,
        validationRef: proof.validationRef,
        type: proof.type,
        status: !matchedResult
          ? 'missing'
          : matchedResult.status !== 'passed'
            ? matchedResult.status
            : !fresh
              ? 'stale'
              : strong
                ? 'strong'
                : 'weak'
      });
    }

    const requiredStrong = capability.requiredStrength === 'strong';
    capabilitySatisfied.set(capability.capabilityId, requiredStrong ? hasStrongFreshProof : hasAnyFreshProof);
    if (proofs.length === 0) {
      issues.push(`Capability '${capability.capabilityId}' has no proof rows.`);
    } else if (!capabilitySatisfied.get(capability.capabilityId)) {
      issues.push(
        requiredStrong
          ? `Capability '${capability.capabilityId}' lacks a fresh strong proof.`
          : `Capability '${capability.capabilityId}' lacks a fresh proof.`
      );
    }
  }

  for (const mustLandEntry of mustLandEntries) {
    if (!mustLandEntry.id) {
      continue;
    }
    const mappedCapabilities = capabilitiesByMustLand.get(mustLandEntry.id) ?? [];
    const satisfied = mappedCapabilities.length > 0 && mappedCapabilities.every((capability) => capabilitySatisfied.get(capability.capabilityId) === true);
    mustLandCoverage.push({
      mustLandId: mustLandEntry.id,
      satisfied,
      capabilities: mappedCapabilities.map((capability) => capability.capabilityId)
    });
    if (mappedCapabilities.length === 0) {
      issues.push(`Must-land item '${mustLandEntry.id}' is not mapped to any capability.`);
    }
  }

  return {
    applicable: true,
    mode,
    satisfied: mustLandCoverage.every((entry) => entry.satisfied) && issues.length === 0,
    issues: [...new Set(issues)],
    mustLandCoverage,
    proofStatuses
  };
}

export function semanticProofCoverageLines(report) {
  if (!report?.applicable) {
    return ['- Semantic proof not required for this plan.'];
  }
  const lines = [
    `- Mode: ${report.mode}`,
    `- Satisfied: ${report.satisfied ? 'yes' : 'no'}`
  ];
  if (report.mustLandCoverage.length === 0) {
    lines.push('- Must-Land Coverage: none recorded');
  } else {
    for (const entry of report.mustLandCoverage) {
      lines.push(
        `- Must-Land ${entry.mustLandId}: ${entry.satisfied ? 'covered' : 'uncovered'} (${entry.capabilities.length > 0 ? entry.capabilities.join(', ') : 'no capabilities'})`
      );
    }
  }
  for (const issue of report.issues.slice(0, 10)) {
    lines.push(`- Issue: ${issue}`);
  }
  return lines;
}

export async function writeSemanticProofManifest(paths, state, plan, report, options) {
  if (options.dryRun || !state?.runId) {
    return null;
  }
  const baseDir = path.join(paths.runtimeDir, state.runId, 'semantic-proof');
  const fileName = `${plan.planId}.json`;
  const targetPath = path.join(baseDir, fileName);
  await fs.mkdir(baseDir, { recursive: true });
  const payload = {
    generatedAt: nowIso(),
    runId: state.runId,
    planId: plan.planId,
    mode: report.mode,
    applicable: report.applicable,
    satisfied: report.satisfied,
    issues: report.issues,
    mustLandCoverage: report.mustLandCoverage,
    proofStatuses: report.proofStatuses
  };
  await fs.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return toPosix(path.relative(paths.rootDir, targetPath));
}

export function createValidationCompletionOps(deps = {}) {
  const required = [
    'runShellMonitored',
    'shouldCaptureCommandOutput',
    'executionOutput',
    'writeSessionExecutorLog',
    'tailLines',
    'didTimeout',
    'logEvent',
    'progressLog',
    'isTickerOutput',
    'requiresSecurityApproval',
    'resolvedSecurityApproval',
    'persistSecurityApproval',
    'setPlanStatus',
    'setResidualValidationBlockersSection',
    'setHostValidationSection',
    'updatePlanValidationState',
    'resolveEvidenceLifecycleConfig',
    'curateEvidenceForPlan',
    'refreshEvidenceIndex',
    'writeEvidenceIndex',
    'rewritePlanFileReferencesInPlanDocs',
    'resolveCompletedPlanTargetPath',
    'resolveAtomicCommitRoots',
    'evaluateAtomicCommitReadiness',
    'createAtomicCommit',
    'clearPlanContinuationState',
    'pathMatchesRootPrefix'
  ];
  for (const key of required) {
    if (typeof deps[key] !== 'function') {
      throw new Error(`createValidationCompletionOps missing required dependency '${key}'.`);
    }
  }

  async function logValidationTransition(paths, state, type, transitionCode, details, options, patch = {}) {
    if (typeof deps.logPlanTransition === 'function') {
      return deps.logPlanTransition(paths, state, type, details.planId, transitionCode, details, options.dryRun, patch);
    }
    return deps.logEvent(paths, state, type, details, options.dryRun);
  }

  async function runValidationCommands(paths, commands, options, label, state = null, plan = null) {
    if (commands.length === 0) {
      return {
        ok: false,
        failedCommand: '(none configured)',
        reason: `No ${label} commands configured.`,
        evidence: []
      };
    }

    const evidence = [];
    const results = [];
    const lane = validationLaneName(label);
    for (let index = 0; index < commands.length; index += 1) {
      const spec = commands[index];
      const command = spec.command;
      if (options.dryRun) {
        evidence.push(`Dry-run: ${label} command skipped: ${command}`);
        results.push({
          validationId: spec.id,
          command,
          lane,
          type: spec.type,
          status: 'passed',
          summary: `Dry-run: ${label} command skipped.`,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          evidenceRefs: [],
          artifactRefs: [],
          findingFiles: [],
          outputLogPath: null
        });
        continue;
      }

      const captureOutput = deps.shouldCaptureCommandOutput(options);
      const resultPath = validationCommandResultPath(paths, state, plan, lane, spec, index);
      const validationEnv = {
        ...process.env,
        ORCH_RUN_ID: state?.runId ?? process.env.ORCH_RUN_ID,
        ORCH_PLAN_ID: plan?.planId ?? process.env.ORCH_PLAN_ID,
        ORCH_PLAN_FILE: plan?.rel ?? process.env.ORCH_PLAN_FILE,
        ORCH_VALIDATION_LANE: lane,
        ORCH_VALIDATION_ID: spec.id,
        ORCH_VALIDATION_TYPE: spec.type ?? '',
        ORCH_VALIDATION_RESULT_PATH: resultPath.rel
      };
      const result = await deps.runShellMonitored(
        command,
        paths.rootDir,
        validationEnv,
        options.validationTimeoutMs,
        captureOutput ? 'pipe' : 'inherit',
        options,
        {
          phase: 'validation',
          planId: plan?.planId ?? 'run',
          role: 'validator',
          activity: label.toLowerCase() === 'validation' ? 'validation-always' : label.toLowerCase()
        }
      );
      const output = captureOutput ? deps.executionOutput(result) : '';
      let logPathRel = null;
      if (captureOutput && state?.runId) {
        const runSessionDir = path.join(paths.runtimeDir, state.runId);
        const planToken = (plan?.planId ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-');
        const labelToken = lane.replace(/[^A-Za-z0-9._-]/g, '-');
        const logPathAbs = path.join(runSessionDir, `${planToken}-${labelToken}-${index + 1}.log`);
        logPathRel = toPosix(path.relative(paths.rootDir, logPathAbs));
        await fs.mkdir(runSessionDir, { recursive: true });
        await deps.writeSessionExecutorLog(
          logPathAbs,
          [
            `# ${label} Command Log`,
            '',
            `- Run-ID: ${state.runId}`,
            `- Plan-ID: ${plan?.planId ?? 'n/a'}`,
            `- Command-Index: ${index + 1}/${commands.length}`,
            `- Command: ${command}`
          ],
          output,
          options.dryRun
        );
      }

      const structuredPayload = normalizeValidationResultPayload(
        await readJsonIfExists(resultPath.abs, null),
        spec,
        lane,
        command,
        logPathRel
      );

      if (deps.didTimeout(result)) {
        const failedResult = {
          ...structuredPayload,
          status: 'failed',
          summary: structuredPayload.summary || `${label} command timed out.`,
          finishedAt: structuredPayload.finishedAt || nowIso()
        };
        results.push(failedResult);
        return {
          ok: false,
          failedCommand: command,
          reason: `${label} command timed out after ${Math.floor((options.validationTimeoutMs ?? 0) / 1000)}s`,
          evidence,
          results,
          failedResult,
          outputLogPath: logPathRel,
          failureTail: deps.tailLines(output, options.failureTailLines)
        };
      }
      if (result.status !== 0) {
        const failedResult = {
          ...structuredPayload,
          status: structuredPayload.status || 'failed',
          summary: structuredPayload.summary || `${label} failed: ${command}`,
          finishedAt: structuredPayload.finishedAt || nowIso()
        };
        results.push(failedResult);
        return {
          ok: false,
          failedCommand: command,
          reason: `${label} failed: ${command}`,
          evidence,
          results,
          failedResult,
          outputLogPath: logPathRel,
          failureTail: deps.tailLines(output, options.failureTailLines)
        };
      }
      results.push({
        ...structuredPayload,
        status: structuredPayload.status || 'passed',
        summary: structuredPayload.summary || `${label} passed: ${command}`,
        finishedAt: structuredPayload.finishedAt || nowIso()
      });
      if (logPathRel) {
        evidence.push(`${label} output log: ${logPathRel}`);
      }
      evidence.push(`${label} passed: ${command}`);
    }

    return {
      ok: true,
      evidence,
      results
    };
  }

  async function runAlwaysValidation(paths, options, config, state = null, plan = null) {
    const commands = resolveAlwaysValidationCommands(paths.rootDir, options, config);
    if (commands.length === 0 && !options.requireAlwaysValidationCommands) {
      return {
        ok: true,
        evidence: ['Validation lane skipped: no validation.always commands configured.']
      };
    }
    return runValidationCommands(paths, commands, options, 'Validation', state, plan);
  }

  function hostProviderResultPath(paths, state, planId, provider, attemptId) {
    const baseDir = path.join(paths.runtimeDir, state.runId, 'host-validation');
    const attemptToken = String(attemptId ?? 'attempt').replace(/[^A-Za-z0-9_-]/g, '-');
    const fileName = `${planId}-${provider}-${attemptToken}.result.json`;
    return {
      abs: path.join(baseDir, fileName),
      rel: toPosix(path.relative(paths.rootDir, path.join(baseDir, fileName)))
    };
  }

  async function executeHostProviderCommand(provider, command, commands, paths, state, plan, options) {
    const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resultPaths = hostProviderResultPath(paths, state, plan.planId, provider, attemptId);
    const logPathAbs = resultPaths.abs.replace(/\.result\.json$/, '.log');
    const logPathRel = toPosix(path.relative(paths.rootDir, logPathAbs));
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(resultPaths.abs), { recursive: true });
    }

    if (options.dryRun) {
      return {
        status: 'passed',
        evidence: [`Dry-run: host validation (${provider}) command skipped: ${command}`],
        results: [],
        provider
      };
    }

    const env = {
      ...process.env,
      ORCH_RUN_ID: state.runId,
      ORCH_PLAN_ID: plan.planId,
      ORCH_PLAN_FILE: plan.rel,
      ORCH_HOST_PROVIDER: provider,
      ORCH_HOST_VALIDATION_COMMANDS: JSON.stringify(commands),
      ORCH_HOST_VALIDATION_RESULT_PATH: resultPaths.rel
    };

    const captureOutput = deps.shouldCaptureCommandOutput(options);
    const outputLogPath = captureOutput ? logPathRel : null;
    const executionResult = await deps.runShellMonitored(
      command,
      paths.rootDir,
      env,
      options.hostValidationTimeoutMs,
      captureOutput ? 'pipe' : 'inherit',
      options,
      {
        phase: 'host-validation',
        planId: plan.planId,
        role: provider,
        activity: 'validation-host'
      }
    );
    const output = captureOutput ? deps.executionOutput(executionResult) : '';
    if (captureOutput) {
      await deps.writeSessionExecutorLog(
        logPathAbs,
        [
          '# Host Validation Command Log',
          '',
          `- Run-ID: ${state.runId}`,
          `- Plan-ID: ${plan.planId}`,
          `- Provider: ${provider}`,
          `- Command: ${command}`
        ],
        output,
        options.dryRun
      );
    }

    if (deps.didTimeout(executionResult)) {
      return {
        status: 'unavailable',
        provider,
        reason: `Host validation provider '${provider}' timed out after ${Math.floor((options.hostValidationTimeoutMs ?? 0) / 1000)}s`,
        outputLogPath,
        failureTail: deps.tailLines(output, options.failureTailLines)
      };
    }

    if (executionResult.signal) {
      return {
        status: 'unavailable',
        provider,
        reason: `Host validation provider '${provider}' terminated by signal ${executionResult.signal}`,
        outputLogPath,
        failureTail: deps.tailLines(output, options.failureTailLines)
      };
    }

    const payload = await readJsonIfExists(resultPaths.abs, null);
    if (payload && typeof payload === 'object') {
      const reported = String(payload.status ?? '').trim().toLowerCase();
      if (reported === 'passed' || reported === 'failed' || reported === 'pending') {
        if (executionResult.status !== 0 && reported === 'passed') {
          return {
            status: 'unavailable',
            provider,
            reason:
              `Host validation provider '${provider}' reported 'passed' but command exited with status ${executionResult.status}`,
            outputLogPath,
            failureTail: deps.tailLines(output, options.failureTailLines)
          };
        }
        return {
          status: reported,
          provider,
          reason: payload.reason ?? null,
          evidence: Array.isArray(payload.evidence)
            ? payload.evidence.map((entry) => String(entry))
            : [`Host validation (${provider}) result payload loaded from ${resultPaths.rel}`],
          results: Array.isArray(payload.results) ? payload.results : [],
          failedResult: payload.failedResult ?? null,
          outputLogPath
        };
      }
    }

    if (executionResult.status === 0) {
      return {
        status: 'passed',
        provider,
        evidence: [
          `Host validation passed via ${provider} command: ${command}`,
          outputLogPath ? `Host validation output log: ${outputLogPath}` : null
        ].filter(Boolean),
        results: []
      };
    }

    return {
      status: 'unavailable',
      provider,
      reason: `Host validation provider '${provider}' command exited with status ${executionResult.status}`,
      outputLogPath,
      failureTail: deps.tailLines(output, options.failureTailLines)
    };
  }

  async function runHostValidation(paths, state, plan, options, config) {
    const commands = resolveHostRequiredValidationCommands(config);
    if (commands.length === 0) {
      if (options.requireHostValidationCommands) {
        return {
          status: 'failed',
          provider: 'none',
          reason:
            'Host validation lane is required but validation.hostRequired is empty. Configure host-required validation commands.',
          evidence: []
        };
      }
      return {
        status: 'passed',
        provider: 'none',
        reason: null,
        evidence: ['No host-required validation commands configured.']
      };
    }

    const mode = resolveHostValidationMode(config);
    const ciCommand = String(config.validation?.host?.ci?.command ?? '').trim();
    const localCommand = String(config.validation?.host?.local?.command ?? '').trim();
    const capability = state.capabilities ?? {};
    const localCapable = Boolean(capability.dockerSocket) && Boolean(capability.localhostBind);

    const tryCi = async () => {
      if (!ciCommand) {
        return { status: 'unavailable', provider: 'ci', reason: 'No CI host-validation command configured.' };
      }
      await deps.logEvent(paths, state, 'host_validation_started', { planId: plan.planId, provider: 'ci', mode }, options.dryRun);
      return executeHostProviderCommand('ci', ciCommand, commands, paths, state, plan, options);
    };

    const tryLocal = async () => {
      if (localCommand) {
        await deps.logEvent(paths, state, 'host_validation_started', { planId: plan.planId, provider: 'local', mode }, options.dryRun);
        return executeHostProviderCommand('local', localCommand, commands, paths, state, plan, options);
      }

      if (!localCapable) {
        return {
          status: 'unavailable',
          provider: 'local',
          reason: [
            'Local host validation unavailable.',
            capability.dockerSocket ? '' : 'Docker socket not reachable.',
            capability.localhostBind ? '' : 'localhost bind is not permitted.'
          ].filter(Boolean).join(' ')
        };
      }

      const result = await runValidationCommands(
        paths,
        commands,
        {
          ...options,
          validationTimeoutMs: options.hostValidationTimeoutMs ?? options.validationTimeoutMs
        },
        'Host validation',
        state,
        plan
      );
      if (!result.ok) {
        return {
          status: 'failed',
          provider: 'local',
          reason: `Host validation failed: ${result.failedCommand}`,
          evidence: result.evidence,
          results: result.results ?? [],
          failedResult: result.failedResult ?? null,
          outputLogPath: result.outputLogPath ?? null,
          failureTail: result.failureTail ?? ''
        };
      }

      return {
        status: 'passed',
        provider: 'local',
        reason: null,
        evidence: result.evidence,
        results: result.results ?? []
      };
    };

    if (mode === 'ci') {
      const ciResult = await tryCi();
      if (ciResult.status === 'passed' || ciResult.status === 'failed') {
        return ciResult;
      }
      return {
        status: 'pending',
        provider: 'ci',
        reason: ciResult.reason ?? 'CI host validation unavailable.',
        evidence: ciResult.evidence ?? [],
        outputLogPath: ciResult.outputLogPath ?? null,
        failureTail: ciResult.failureTail ?? ''
      };
    }

    if (mode === 'local') {
      const localResult = await tryLocal();
      if (localResult.status === 'passed' || localResult.status === 'failed') {
        return localResult;
      }
      return {
        status: 'pending',
        provider: 'local',
        reason: localResult.reason ?? 'Local host validation unavailable.',
        evidence: localResult.evidence ?? [],
        outputLogPath: localResult.outputLogPath ?? null,
        failureTail: localResult.failureTail ?? ''
      };
    }

    const ciResult = await tryCi();
    if (ciResult.status === 'passed' || ciResult.status === 'failed') {
      return ciResult;
    }

    const localResult = await tryLocal();
    if (localResult.status === 'passed' || localResult.status === 'failed') {
      return localResult;
    }

    return {
      status: 'pending',
      provider: 'hybrid',
      reason: [ciResult.reason, localResult.reason].filter(Boolean).join(' | ') || 'Host validation unavailable.',
      evidence: [...(ciResult.evidence ?? []), ...(localResult.evidence ?? [])],
      outputLogPath: ciResult.outputLogPath ?? localResult.outputLogPath ?? null,
      failureTail: ciResult.failureTail || localResult.failureTail || ''
    };
  }

  async function finalizeCompletedPlan(plan, paths, state, validationEvidence, options, config, completionInfo = {}) {
    const now = nowIso();
    const targetPath = completionInfo.targetPath
      ? path.resolve(completionInfo.targetPath)
      : await deps.resolveCompletedPlanTargetPath(plan.filePath, paths.completedDir);
    const completedRel = toPosix(path.relative(paths.rootDir, targetPath));
    const raw = await fs.readFile(plan.filePath, 'utf8');
    const indexResult = await deps.writeEvidenceIndex(paths, plan, raw, options, config, { sourcePlanRel: completedRel });
    const doneEvidenceValue = indexResult?.indexPath ?? (validationEvidence.length > 0 ? validationEvidence.join(', ') : 'none');
    const updatedMetadata = setPlanDocumentFields(raw, {
      Status: 'completed',
      'Done-Evidence': doneEvidenceValue
    });

    const validationLines = validationEvidence.length > 0
      ? validationEvidence.map((line) => `- ${line}`)
      : ['- No validation commands configured.'];

    const closureLines = [
      `- Completed At: ${now}`,
      `- Run-ID: ${state.runId}`,
      `- Mode: ${state.effectiveMode}`,
      '- Commit: recorded in run events after atomic commit.',
      '- Termination Reason: completed'
    ];
    const planDurationSeconds = durationSeconds(completionInfo.planStartedAt, now);
    const runDurationSeconds = durationSeconds(state.startedAt, now);
    const snapshotLines = [
      `- Plan-ID: ${plan.planId}`,
      `- Sessions Executed: ${completionInfo.sessionsExecuted ?? 'unknown'}`,
      `- Rollovers: ${completionInfo.rollovers ?? 0}`,
      `- Host Validation Provider: ${completionInfo.hostValidationProvider ?? 'none'}`,
      `- Risk Tier (Declared): ${completionInfo.declaredRiskTier ?? plan.riskTier ?? 'low'}`,
      `- Risk Tier (Effective): ${completionInfo.effectiveRiskTier ?? plan.riskTier ?? 'low'}`,
      `- Role Pipeline: ${completionInfo.rolePipeline ?? 'worker'}`,
      `- Plan Duration: ${formatDuration(planDurationSeconds)} (${planDurationSeconds ?? 'unknown'}s)`,
      `- Run Duration At Completion: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`
    ];
    const proofCoverageLines = completionInfo.semanticProofReport
      ? semanticProofCoverageLines(completionInfo.semanticProofReport)
      : [];
    if (completionInfo.semanticProofManifestPath) {
      proofCoverageLines.push(`- Manifest: ${completionInfo.semanticProofManifestPath}`);
    }

    let finalContent = upsertSection(updatedMetadata, 'Validation Evidence', validationLines);
    if (proofCoverageLines.length > 0) {
      finalContent = upsertSection(finalContent, 'Proof Coverage', proofCoverageLines);
    }
    finalContent = upsertSection(finalContent, 'Completion Snapshot', snapshotLines);
    if (indexResult?.indexPath) {
      finalContent = upsertSection(finalContent, 'Evidence Index', [
        `- Canonical Index: \`${indexResult.indexPath}\``,
        `- Included References: ${indexResult.referenceCount}`,
        `- Total References Found: ${indexResult.totalFound}`
      ]);
    }
    finalContent = upsertSection(finalContent, 'Closure', closureLines);

    if (!options.dryRun) {
      await fs.writeFile(targetPath, finalContent, 'utf8');
      await fs.unlink(plan.filePath);
    }

    const rewriteSummary = await deps.rewritePlanFileReferencesInPlanDocs(paths, plan.rel, completedRel, options);
    if (rewriteSummary.filesUpdated > 0 || rewriteSummary.replacementsApplied > 0) {
      await deps.logEvent(paths, state, 'plan_reference_rewritten', {
        planId: plan.planId,
        fromPath: plan.rel,
        toPath: completedRel,
        filesUpdated: rewriteSummary.filesUpdated,
        replacementsApplied: rewriteSummary.replacementsApplied
      }, options.dryRun);
    }

    return targetPath;
  }

  async function updateProductSpecs(plan, completedPath, paths, state, options) {
    const targets = plan.specTargets.length > 0 ? plan.specTargets : ['docs/product-specs/CURRENT-STATE.md'];
    const dateStamp = todayIsoDate();
    const relativeCompleted = toPosix(path.relative(paths.rootDir, completedPath));

    for (const target of targets) {
      let targetPath;
      let targetRel;
      try {
        const resolved = resolveSafeRepoPath(paths.rootDir, target, `Spec target for plan '${plan.planId}'`);
        targetPath = resolved.abs;
        targetRel = resolved.rel;
      } catch (error) {
        await deps.logEvent(paths, state, 'spec_update_skipped', {
          planId: plan.planId,
          target,
          reason: error instanceof Error ? error.message : String(error)
        }, options.dryRun);
        continue;
      }

      if (!(await exists(targetPath))) {
        await deps.logEvent(paths, state, 'spec_update_skipped', {
          planId: plan.planId,
          target: targetRel,
          reason: 'Spec target does not exist'
        }, options.dryRun);
        continue;
      }

      let targetStats;
      try {
        targetStats = await fs.stat(targetPath);
      } catch (error) {
        await deps.logEvent(paths, state, 'spec_update_skipped', {
          planId: plan.planId,
          target: targetRel,
          reason: error instanceof Error ? error.message : String(error)
        }, options.dryRun);
        continue;
      }

      if (!targetStats.isFile()) {
        await deps.logEvent(paths, state, 'spec_update_skipped', {
          planId: plan.planId,
          target: targetRel,
          reason: 'Spec target is not a regular file'
        }, options.dryRun);
        continue;
      }

      if (options.dryRun) {
        continue;
      }

      let content = await fs.readFile(targetPath, 'utf8');
      const entry = `${dateStamp}: completed \`${plan.planId}\` via \`${relativeCompleted}\``;
      content = appendToDeliveryLog(content, entry);

      if (targetRel === 'docs/product-specs/CURRENT-STATE.md') {
        content = updateSimpleMetadataField(content, 'Last Updated', dateStamp);
        content = updateSimpleMetadataField(content, 'Current State Date', dateStamp);
      }

      await fs.writeFile(targetPath, content, 'utf8');
    }
  }

  async function runValidationAndFinalize(plan, paths, state, options, config, assessment, roleState, executionContext = {}) {
    const session = asInteger(executionContext.session, 0);
    const planStartedAt = executionContext.planStartedAt ?? nowIso();
    const sessionsExecuted = asInteger(executionContext.sessionsExecuted, session);
    const rollovers = asInteger(executionContext.rollovers, 0);

    const approvalRequired = deps.requiresSecurityApproval(plan, assessment, config);
    const {
      securityApprovalField,
      securityApprovalValue,
      metadataSecurityApproval,
      source: securityApprovalSource
    } = deps.resolvedSecurityApproval(plan, assessment, config);
    plan.securityApproval = securityApprovalValue;

    if (approvalRequired && securityApprovalValue !== deps.SECURITY_APPROVAL_APPROVED) {
      await deps.setPlanStatus(plan.filePath, 'blocked', options.dryRun);
      if (metadataSecurityApproval === deps.SECURITY_APPROVAL_NOT_REQUIRED) {
        await deps.persistSecurityApproval(plan, securityApprovalField, deps.SECURITY_APPROVAL_PENDING, options.dryRun);
      }
      const reason = `Security approval required: set '${securityApprovalField}' to '${deps.SECURITY_APPROVAL_APPROVED}' for ${assessment.effectiveRiskTier}-risk completion.`;
      await deps.logEvent(paths, state, 'security_approval_pending', {
        planId: plan.planId,
        riskTier: assessment.effectiveRiskTier,
        securityApprovalField,
        securityApproval: securityApprovalValue,
        sensitive: assessment.sensitive,
        reason
      }, options.dryRun);
      deps.progressLog(options, `security approval pending for ${plan.planId}: ${reason}`);
      return { outcome: 'blocked', reason, riskTier: assessment.effectiveRiskTier };
    }

    if (approvalRequired && metadataSecurityApproval !== deps.SECURITY_APPROVAL_APPROVED) {
      await deps.persistSecurityApproval(plan, securityApprovalField, deps.SECURITY_APPROVAL_APPROVED, options.dryRun);
      await deps.logEvent(paths, state, 'security_approval_recorded', {
        planId: plan.planId,
        riskTier: assessment.effectiveRiskTier,
        securityApprovalField,
        source: securityApprovalSource
      }, options.dryRun);
      deps.progressLog(
        options,
        `security approval recorded for ${plan.planId}: source=${securityApprovalSource} status=${deps.SECURITY_APPROVAL_APPROVED}`
      );
    }

    const parentScopeIds = parentScopeIdsForPlan(plan);
    if (parentScopeIds.length > 0) {
      const compileResult = await recompileProgramChildrenForParentScopes(paths.rootDir, parentScopeIds, {
        write: !options.dryRun,
        dryRun: options.dryRun === true
      });
      for (const advisory of compileResult.advisories) {
        deps.progressLog(options, `child compile advisory ${advisory.code}: ${advisory.message}`);
      }
      for (const entry of compileResult.writes) {
        deps.progressLog(options, `compiled child ${entry.action} ${entry.planId}: ${entry.filePath}`);
      }
      for (const entry of compileResult.moves) {
        deps.progressLog(options, `compiled child moved ${entry.planId}: ${entry.source} -> ${entry.target}`);
      }
      if (compileResult.issues.length > 0) {
        const preview = compileResult.issues
          .slice(0, 3)
          .map((entry) => `${entry.code}: ${entry.message}`)
          .join(' | ');
        const reason = `Program child recompilation failed before validation: ${preview}`;
        await deps.logEvent(paths, state, 'validation_child_recompile_failed', {
          planId: plan.planId,
          parentPlanIds: parentScopeIds,
          reason
        }, options.dryRun);
        await deps.setPlanStatus(plan.filePath, 'blocked', options.dryRun);
        deps.progressLog(options, `validation blocked ${plan.planId}: ${reason}`);
        return {
          outcome: 'blocked',
          reason,
          riskTier: assessment.effectiveRiskTier
        };
      }
      if (!options.dryRun) {
        const refreshed = await fs.readFile(plan.filePath, 'utf8');
        plan.content = refreshed;
      }
    }

    await deps.setPlanStatus(plan.filePath, 'validation', options.dryRun);
    await logValidationTransition(paths, state, 'validation_started', 'validation_started', {
      planId: plan.planId,
      session,
      role: roleState?.stages?.[Math.min(asInteger(roleState?.currentIndex, 0), Math.max(0, (roleState?.stages?.length ?? 1) - 1))] ?? 'worker',
      effectiveRiskTier: assessment.effectiveRiskTier
    }, options, {
      currentRole: roleState?.stages?.[Math.min(asInteger(roleState?.currentIndex, 0), Math.max(0, (roleState?.stages?.length ?? 1) - 1))] ?? 'worker',
      currentStageIndex: Math.min(asInteger(roleState?.currentIndex, 0) + 1, roleState?.stages?.length ?? 1),
      currentStageTotal: roleState?.stages?.length ?? 1,
      declaredRiskTier: assessment.declaredRiskTier,
      computedRiskTier: assessment.computedRiskTier,
      effectiveRiskTier: assessment.effectiveRiskTier
    });
    deps.progressLog(options, `validation start ${plan.planId} lane=always`);
    const alwaysValidation = await runAlwaysValidation(paths, options, config, state, plan);
    updatePlanValidationResults(state, plan.planId, 'always', alwaysValidation.results ?? []);
    if (!alwaysValidation.ok) {
      state.stats.validationFailures += 1;
      const failureScope = classifyValidationFailureScope(alwaysValidation.failedResult, plan, deps.pathMatchesRootPrefix);
      if (failureScope === 'external') {
        deps.updatePlanValidationState(state, plan.planId, {
          always: 'pending',
          reason: alwaysValidation.reason ?? `Validation blocked by residual external failure: ${alwaysValidation.failedCommand}`
        });
        await deps.setPlanStatus(plan.filePath, 'validation', options.dryRun);
        await deps.setResidualValidationBlockersSection(
          plan.filePath,
          alwaysValidation.failedResult,
          alwaysValidation.reason ?? `Validation blocked by residual external failure: ${alwaysValidation.failedCommand}`,
          options.dryRun
        );
        await logValidationTransition(paths, state, 'validation_residual_external', 'validation_always_passed', {
          planId: plan.planId,
          command: alwaysValidation.failedCommand,
          reason: alwaysValidation.reason ?? null,
          findingFiles: alwaysValidation.failedResult?.findingFiles ?? [],
          outputLogPath: alwaysValidation.outputLogPath ?? null,
          faultCode: 'validation.always.external-blocker',
          recoveryAction: 'resume-after-external-validation'
        }, options, {
          lastReason: alwaysValidation.reason ?? `Validation blocked by residual external failure: ${alwaysValidation.failedCommand}`
        });
        deps.progressLog(
          options,
          `validation residual blocker ${plan.planId}: ${alwaysValidation.reason ?? alwaysValidation.failedCommand}`
        );
        return {
          outcome: 'pending',
          reason: alwaysValidation.reason ?? `Validation blocked by residual external failure: ${alwaysValidation.failedCommand}`,
          riskTier: assessment.effectiveRiskTier
        };
      }
      deps.updatePlanValidationState(state, plan.planId, {
        always: 'failed',
        reason: alwaysValidation.reason ?? `Validation failed: ${alwaysValidation.failedCommand}`
      });
      await deps.setPlanStatus(plan.filePath, 'failed', options.dryRun);
      await logValidationTransition(paths, state, 'validation_failed', 'validation_failed', {
        planId: plan.planId,
        command: alwaysValidation.failedCommand,
        reason: alwaysValidation.reason ?? null,
        outputLogPath: alwaysValidation.outputLogPath ?? null,
        faultCode: 'validation.always.failed',
        recoveryAction: 'fix-and-rerun-validation'
      }, options, {
        lastReason: alwaysValidation.reason ?? `Validation failed: ${alwaysValidation.failedCommand}`
      });
      deps.progressLog(options, `validation failed ${plan.planId}: ${alwaysValidation.reason ?? alwaysValidation.failedCommand}`);
      if (alwaysValidation.outputLogPath) {
        deps.progressLog(options, `validation log: ${alwaysValidation.outputLogPath}`);
      }
      if (alwaysValidation.failureTail && !deps.isTickerOutput(options)) {
        deps.progressLog(options, `validation failure tail:\n${alwaysValidation.failureTail}`);
      }

      return {
        outcome: 'failed',
        reason: alwaysValidation.reason ?? `Validation failed: ${alwaysValidation.failedCommand}`,
        riskTier: assessment.effectiveRiskTier
      };
    }

    deps.updatePlanValidationState(state, plan.planId, { always: 'passed', reason: null });
    await logValidationTransition(paths, state, 'validation_always_passed', 'validation_always_passed', {
      planId: plan.planId,
      session,
      effectiveRiskTier: assessment.effectiveRiskTier
    }, options, {
      declaredRiskTier: assessment.declaredRiskTier,
      computedRiskTier: assessment.computedRiskTier,
      effectiveRiskTier: assessment.effectiveRiskTier
    });
    deps.progressLog(options, `validation passed ${plan.planId} lane=always`);

    await logValidationTransition(paths, state, 'host_validation_requested', 'validation_host_started', {
      planId: plan.planId,
      mode: resolveHostValidationMode(config),
      commands: resolveHostRequiredValidationCommands(config)
    }, options, {
      declaredRiskTier: assessment.declaredRiskTier,
      computedRiskTier: assessment.computedRiskTier,
      effectiveRiskTier: assessment.effectiveRiskTier
    });
    deps.progressLog(options, `validation start ${plan.planId} lane=host mode=${resolveHostValidationMode(config)}`);

    const hostValidation = await runHostValidation(paths, state, plan, options, config);
    updatePlanValidationResults(state, plan.planId, 'host-required', hostValidation.results ?? []);
    if (hostValidation.status === 'failed') {
      state.stats.validationFailures += 1;
      const failureScope = classifyValidationFailureScope(hostValidation.failedResult, plan, deps.pathMatchesRootPrefix);
      if (failureScope === 'external') {
        deps.updatePlanValidationState(state, plan.planId, {
          host: 'pending',
          provider: hostValidation.provider ?? null,
          reason: hostValidation.reason ?? 'Host validation blocked by residual external failure.'
        });
        await deps.setPlanStatus(plan.filePath, 'validation', options.dryRun);
        await deps.setResidualValidationBlockersSection(
          plan.filePath,
          hostValidation.failedResult,
          hostValidation.reason ?? 'Host validation blocked by residual external failure.',
          options.dryRun
        );
        await logValidationTransition(paths, state, 'host_validation_residual_external', 'validation_host_pending', {
          planId: plan.planId,
          provider: hostValidation.provider ?? null,
          reason: hostValidation.reason ?? 'Host validation blocked by residual external failure.',
          findingFiles: hostValidation.failedResult?.findingFiles ?? [],
          outputLogPath: hostValidation.outputLogPath ?? null,
          faultCode: 'validation.host.external-blocker',
          recoveryAction: 'resume-after-external-validation'
        }, options, {
          lastReason: hostValidation.reason ?? 'Host validation blocked by residual external failure.'
        });
        deps.progressLog(
          options,
          `host validation residual blocker ${plan.planId}: ${hostValidation.reason ?? 'Host validation blocked.'}`
        );
        return {
          outcome: 'pending',
          reason: hostValidation.reason ?? 'Host validation blocked by residual external failure.',
          riskTier: assessment.effectiveRiskTier
        };
      }
      deps.updatePlanValidationState(state, plan.planId, {
        host: 'failed',
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation failed.'
      });
      await deps.setPlanStatus(plan.filePath, 'failed', options.dryRun);
      await logValidationTransition(paths, state, 'host_validation_failed', 'validation_failed', {
        planId: plan.planId,
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation failed.',
        outputLogPath: hostValidation.outputLogPath ?? null,
        faultCode: 'validation.host.failed',
        recoveryAction: 'fix-and-rerun-host-validation'
      }, options, {
        lastReason: hostValidation.reason ?? 'Host validation failed.'
      });
      deps.progressLog(options, `host validation failed ${plan.planId}: ${hostValidation.reason ?? 'Host validation failed.'}`);
      if (hostValidation.outputLogPath) {
        deps.progressLog(options, `host validation log: ${hostValidation.outputLogPath}`);
      }
      if (hostValidation.failureTail && !deps.isTickerOutput(options)) {
        deps.progressLog(options, `host validation failure tail:\n${hostValidation.failureTail}`);
      }

      return {
        outcome: 'failed',
        reason: hostValidation.reason ?? 'Host validation failed.',
        riskTier: assessment.effectiveRiskTier
      };
    }

    if (hostValidation.status === 'pending') {
      deps.updatePlanValidationState(state, plan.planId, {
        host: 'pending',
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation pending.'
      });
      await deps.setPlanStatus(plan.filePath, 'validation', options.dryRun);
      await deps.setHostValidationSection(
        plan.filePath,
        'pending',
        hostValidation.provider ?? 'unknown',
        hostValidation.reason ?? 'Host validation pending.',
        options.dryRun
      );
      await logValidationTransition(paths, state, 'host_validation_blocked', 'validation_host_pending', {
        planId: plan.planId,
        provider: hostValidation.provider ?? null,
        reason: hostValidation.reason ?? 'Host validation pending.',
        outputLogPath: hostValidation.outputLogPath ?? null,
        faultCode: 'validation.host.pending',
        recoveryAction: 'resume-after-host-validation'
      }, options, {
        lastReason: hostValidation.reason ?? 'Host validation pending.'
      });
      deps.progressLog(options, `host validation pending ${plan.planId}: ${hostValidation.reason ?? 'Host validation pending.'}`);
      if (hostValidation.outputLogPath) {
        deps.progressLog(options, `host validation log: ${hostValidation.outputLogPath}`);
      }
      if (hostValidation.failureTail && !deps.isTickerOutput(options)) {
        deps.progressLog(options, `host validation tail:\n${hostValidation.failureTail}`);
      }

      return {
        outcome: 'pending',
        reason: hostValidation.reason ?? 'Host validation pending.',
        riskTier: assessment.effectiveRiskTier
      };
    }

    deps.updatePlanValidationState(state, plan.planId, {
      host: 'passed',
      provider: hostValidation.provider ?? null,
      reason: null
    });
    await deps.setHostValidationSection(
      plan.filePath,
      'passed',
      hostValidation.provider ?? 'unknown',
      'Host-required validations passed.',
      options.dryRun
    );
    await logValidationTransition(paths, state, 'host_validation_passed', 'validation_host_passed', {
      planId: plan.planId,
      provider: hostValidation.provider ?? null
    }, options);
    deps.progressLog(options, `host validation passed ${plan.planId} provider=${hostValidation.provider ?? 'n/a'}`);

    const semanticProofReport = evaluateSemanticProofCoverage(plan, state, config);
    const semanticProofManifestPath = await writeSemanticProofManifest(paths, state, plan, semanticProofReport, options);
    await deps.logEvent(paths, state, 'semantic_proof_evaluated', {
      planId: plan.planId,
      mode: semanticProofReport.mode,
      applicable: semanticProofReport.applicable,
      satisfied: semanticProofReport.satisfied,
      issueCount: semanticProofReport.issues.length,
      manifestPath: semanticProofManifestPath
    }, options.dryRun);
    if (semanticProofReport.applicable && !semanticProofReport.satisfied) {
      deps.progressLog(
        options,
        `semantic proof ${semanticProofReport.mode} ${plan.planId}: ${semanticProofReport.issues.slice(0, 3).join(' | ') || 'coverage incomplete'}`
      );
      if (semanticProofReport.mode === 'required') {
        await deps.setPlanStatus(plan.filePath, 'failed', options.dryRun);
        return {
          outcome: 'failed',
          reason: `Semantic proof coverage incomplete: ${semanticProofReport.issues[0] ?? 'unknown proof gap'}`,
          riskTier: assessment.effectiveRiskTier
        };
      }
    }

    const mergedValidationEvidence = [
      ...alwaysValidation.evidence,
      ...(Array.isArray(hostValidation.evidence) ? hostValidation.evidence : []),
      ...semanticProofCoverageLines(semanticProofReport),
      ...(semanticProofManifestPath ? [`Semantic proof manifest: ${semanticProofManifestPath}`] : [])
    ];
    const shouldCreateAtomicCommit = asBoolean(options.commit, config.git.atomicCommits !== false);
    const completedTargetPath = await deps.resolveCompletedPlanTargetPath(plan.filePath, paths.completedDir);
    const completedTargetRel = toPosix(path.relative(paths.rootDir, completedTargetPath));
    const commitPolicy = {
      enforceRoots: asBoolean(config.git?.atomicCommitRoots?.enforce, true),
      allowedRoots: deps.resolveAtomicCommitRoots(plan, config, paths, { completedRel: completedTargetRel })
    };

    if (shouldCreateAtomicCommit && !options.dryRun) {
      const preflight = deps.evaluateAtomicCommitReadiness(
        paths.rootDir,
        plan.planId,
        options.allowDirty,
        commitPolicy,
        { requireDirty: false }
      );
      if (!preflight.ok) {
        await deps.setPlanStatus(plan.filePath, 'failed', options.dryRun);
        return { outcome: 'failed', reason: preflight.reason ?? 'atomic commit preflight failed' };
      }
    }

    const lifecycle = deps.resolveEvidenceLifecycleConfig(config);
    if (lifecycle.pruneOnComplete) {
      const completionCuration = await deps.curateEvidenceForPlan(plan, paths, options, config);
      if (completionCuration.filesPruned > 0 || completionCuration.filesUpdated > 0) {
        await deps.logEvent(paths, state, 'evidence_curated', {
          planId: plan.planId,
          stage: 'completion',
          session,
          directoriesVisited: completionCuration.directoriesVisited,
          filesPruned: completionCuration.filesPruned,
          filesKept: completionCuration.filesKept,
          filesUpdated: completionCuration.filesUpdated,
          replacementsApplied: completionCuration.replacementsApplied
        }, options.dryRun);
        await deps.refreshEvidenceIndex(plan, paths, state, options, config);
      }
    }

    if (shouldCreateAtomicCommit && !options.dryRun) {
      const preflight = deps.evaluateAtomicCommitReadiness(
        paths.rootDir,
        plan.planId,
        options.allowDirty,
        commitPolicy,
        { requireDirty: false }
      );
      if (!preflight.ok) {
        await deps.setPlanStatus(plan.filePath, 'failed', options.dryRun);
        return { outcome: 'failed', reason: preflight.reason ?? 'atomic commit preflight failed' };
      }
    }

    const rollbackSnapshots = new Map();
    const captureRollbackSnapshot = async (targetPath) => {
      const key = path.resolve(targetPath);
      if (rollbackSnapshots.has(key)) {
        return;
      }
      rollbackSnapshots.set(key, await snapshotFileState(key));
    };
    const rollbackCompletionMutation = async () => {
      const restoreTargets = [...rollbackSnapshots.keys()].reverse();
      for (const target of restoreTargets) {
        await restoreFileState(target, rollbackSnapshots.get(target));
      }
    };

    if (shouldCreateAtomicCommit && !options.dryRun) {
      await captureRollbackSnapshot(plan.filePath);
      await captureRollbackSnapshot(completedTargetPath);
      await captureRollbackSnapshot(path.join(paths.evidenceIndexDir, `${plan.planId}.md`));
      await captureRollbackSnapshot(path.join(paths.evidenceIndexDir, 'README.md'));
      const specTargets = plan.specTargets.length > 0 ? plan.specTargets : ['docs/product-specs/CURRENT-STATE.md'];
      for (const target of specTargets) {
        try {
          const resolved = resolveSafeRepoPath(paths.rootDir, target, `Spec target for plan '${plan.planId}'`);
          await captureRollbackSnapshot(resolved.abs);
        } catch {
          // updateProductSpecs emits explicit skip events for invalid targets.
        }
      }
    }

    const completedPath = await finalizeCompletedPlan(
      plan,
      paths,
      state,
      mergedValidationEvidence,
      options,
      config,
      {
        planStartedAt,
        sessionsExecuted,
        rollovers,
        hostValidationProvider: hostValidation.provider ?? 'none',
        semanticProofReport,
        semanticProofManifestPath,
        effectiveRiskTier: assessment.effectiveRiskTier,
        declaredRiskTier: assessment.declaredRiskTier,
        rolePipeline:
          Array.isArray(roleState?.stages) && roleState.stages.length > 0
            ? roleState.stages.join(' -> ')
            : 'worker',
        targetPath: completedTargetPath
      }
    );

    await updateProductSpecs(plan, completedPath, paths, state, options);

    let commitResult = { ok: true, committed: false, commitHash: null };
    if (shouldCreateAtomicCommit) {
      commitResult = deps.createAtomicCommit(
        paths.rootDir,
        plan.planId,
        options.dryRun,
        options.allowDirty,
        commitPolicy
      );
      if (!commitResult.ok) {
        if (!options.dryRun) {
          await rollbackCompletionMutation();
        }
        await deps.setPlanStatus(plan.filePath, 'failed', options.dryRun);
        return {
          outcome: 'failed',
          reason: commitResult.reason ?? 'atomic commit failed; completion mutation rolled back'
        };
      }
      if (commitResult.committed) {
        state.stats.commits += 1;
      }
    }

    deps.clearPlanContinuationState(state, plan.planId);
    return {
      outcome: 'completed',
      reason: 'completed',
      completedPath: toPosix(path.relative(paths.rootDir, completedPath)),
      commitHash: commitResult.commitHash,
      validationEvidence: mergedValidationEvidence,
      riskTier: assessment.effectiveRiskTier
    };
  }

  return {
    runValidationCommands,
    runAlwaysValidation,
    runHostValidation,
    runValidationAndFinalize,
    finalizeCompletedPlan,
    updateProductSpecs
  };
}
