import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  implementationTargetRoots,
  isTransientAutomationPath,
  normalizeTouchedPathList,
  pathMatchesRootPrefix
} from './plan-scope.mjs';
import {
  assertSafeRelativePlanPath,
  asBoolean,
  normalizeRelativePrefixList,
  normalizedRelativePrefix,
  nowIso,
  runShellCapture,
  shellQuote,
  toPosix
} from './orchestrator-shared.mjs';

export function parseGitPorcelainZPaths(stdout) {
  const raw = String(stdout ?? '');
  if (!raw) {
    return [];
  }
  const tokens = raw.split('\0').filter(Boolean);
  const paths = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) {
      continue;
    }
    const status = token.slice(0, 2);
    const primaryPath = toPosix(token.slice(3));
    if (primaryPath) {
      paths.push(primaryPath);
    }
    const isRenameOrCopy = status.includes('R') || status.includes('C');
    if (isRenameOrCopy && index + 1 < tokens.length) {
      const secondaryPath = toPosix(tokens[index + 1]);
      if (secondaryPath) {
        paths.push(secondaryPath);
      }
      index += 1;
    }
  }

  return paths;
}

export function gitAvailable(rootDir) {
  const result = runShellCapture('git rev-parse --is-inside-work-tree', rootDir);
  return result.status === 0;
}

export function isProgramPlan(plan) {
  return String(plan?.executionScope ?? '').trim().toLowerCase() === 'program';
}

export function isProductPlan(plan) {
  return String(plan?.deliveryClass ?? '').trim().toLowerCase() === 'product';
}

export function isArtifactSlicePlan(plan) {
  return !isProgramPlan(plan) && !isProductPlan(plan);
}

export function planRequiresImplementationEvidence(plan) {
  return isProductPlan(plan) && !isProgramPlan(plan);
}

export function dirtyRepoPaths(rootDir, options = {}) {
  const includeTransient = asBoolean(options.includeTransient, false);
  const result = runShellCapture('git status --porcelain=v1 -z', rootDir);
  if (result.status !== 0) {
    return [];
  }
  const paths = parseGitPorcelainZPaths(result.stdout);
  if (includeTransient) {
    return paths;
  }
  return paths.filter((entry) => !isTransientAutomationPath(entry));
}

export function stagedRepoPaths(rootDir, options = {}) {
  const includeTransient = asBoolean(options.includeTransient, false);
  const result = runShellCapture('git diff --cached --name-only -z', rootDir);
  if (result.status !== 0) {
    return [];
  }
  const paths = String(result.stdout ?? '')
    .split('\0')
    .map((entry) => toPosix(String(entry ?? '').trim()))
    .filter(Boolean);
  if (includeTransient) {
    return paths;
  }
  return paths.filter((entry) => !isTransientAutomationPath(entry));
}

export function gitDirty(rootDir, options = {}) {
  const ignoreTransientAutomationArtifacts = asBoolean(options.ignoreTransientAutomationArtifacts, false);
  const result = runShellCapture('git status --porcelain=v1 -z', rootDir);
  if (result.status !== 0) {
    return false;
  }
  const dirtyPaths = parseGitPorcelainZPaths(result.stdout);
  if (!ignoreTransientAutomationArtifacts) {
    return dirtyPaths.length > 0;
  }
  return dirtyPaths.some((pathValue) => !isTransientAutomationPath(pathValue));
}

export function dirtyImplementationTouchPaths(rootDir, plan) {
  const implementationRoots = implementationTargetRoots(plan, { sourceOnly: true });
  if (implementationRoots.length === 0) {
    return [];
  }

  return dirtyRepoPaths(rootDir, { includeTransient: false }).filter((entry) =>
    implementationRoots.some((root) => pathMatchesRootPrefix(entry, root))
  );
}

export function implementationEvidenceFingerprint(rootDir, relativePath) {
  const normalized = toPosix(String(relativePath ?? '').trim()).replace(/^\.?\//, '');
  if (!normalized) {
    return 'missing';
  }
  const absPath = path.join(rootDir, normalized);
  try {
    const stat = fsSync.lstatSync(absPath);
    if (stat.isFile()) {
      const digest = createHash('sha1').update(fsSync.readFileSync(absPath)).digest('hex');
      return `f:${stat.size}:${digest}`;
    }
    if (stat.isDirectory()) {
      return 'd';
    }
    if (stat.isSymbolicLink()) {
      return `l:${fsSync.readlinkSync(absPath)}`;
    }
    return 'o';
  } catch {
    return 'missing';
  }
}

export function implementationEvidenceEntries(state, plan, rootDir) {
  const implementationRoots = implementationTargetRoots(plan, { sourceOnly: true });
  if (implementationRoots.length === 0) {
    return [];
  }
  const entry = state?.implementationState?.[plan.planId];
  const pathRecords = entry?.pathRecords && typeof entry.pathRecords === 'object'
    ? entry.pathRecords
    : {};
  const touchedPaths = Array.isArray(entry?.touchedPaths) ? entry.touchedPaths : [];
  const merged = new Map();

  for (const [filePath, record] of Object.entries(pathRecords)) {
    const normalized = toPosix(String(filePath ?? '').trim()).replace(/^\.?\//, '');
    if (!normalized) {
      continue;
    }
    merged.set(normalized, {
      baselineFingerprint: String(record?.baselineFingerprint ?? '').trim(),
      recordedFingerprint: String(record?.recordedFingerprint ?? record?.fingerprint ?? '').trim()
    });
  }

  for (const filePath of normalizeTouchedPathList(touchedPaths)) {
    if (merged.has(filePath)) {
      continue;
    }
    merged.set(filePath, {
      baselineFingerprint: '',
      recordedFingerprint: implementationEvidenceFingerprint(rootDir, filePath)
    });
  }

  return [...merged.entries()]
    .filter(([filePath]) => implementationRoots.some((root) => pathMatchesRootPrefix(filePath, root)))
    .map(([filePath, record]) => ({
      path: filePath,
      baselineFingerprint: record.baselineFingerprint,
      recordedFingerprint: record.recordedFingerprint,
      currentFingerprint: implementationEvidenceFingerprint(rootDir, filePath)
    }));
}

export function implementationEvidencePaths(state, plan, rootDir) {
  return implementationEvidenceEntries(state, plan, rootDir)
    .filter((entry) => {
      if (!entry.currentFingerprint || entry.currentFingerprint === 'missing') {
        return false;
      }
      if (entry.baselineFingerprint) {
        return entry.currentFingerprint !== entry.baselineFingerprint;
      }
      return entry.recordedFingerprint && entry.currentFingerprint === entry.recordedFingerprint;
    })
    .map((entry) => entry.path);
}

export function hasRecordedImplementationEvidence(state, plan, rootDir) {
  return implementationEvidencePaths(state, plan, rootDir).length > 0;
}

export function recordImplementationEvidence(state, ensurePlanImplementationState, rootDir, plan, touchedPaths = [], metadata = {}) {
  const implementationRoots = implementationTargetRoots(plan, { sourceOnly: true });
  if (implementationRoots.length === 0) {
    return { recorded: false, matchedPaths: [] };
  }

  const matchedPaths = normalizeTouchedPathList(touchedPaths).filter((entry) =>
    implementationRoots.some((root) => pathMatchesRootPrefix(entry, root))
  );
  if (matchedPaths.length === 0) {
    return { recorded: false, matchedPaths: [] };
  }

  const current = ensurePlanImplementationState(state, plan.planId);
  const pathRecords = current.pathRecords && typeof current.pathRecords === 'object'
    ? current.pathRecords
    : {};
  const baselineFingerprints =
    metadata.baselineFingerprints && typeof metadata.baselineFingerprints === 'object'
      ? metadata.baselineFingerprints
      : {};
  const mergedPaths = [...new Set([...(Array.isArray(current.touchedPaths) ? current.touchedPaths : []), ...matchedPaths])];
  const recordedAt = nowIso();
  for (const filePath of matchedPaths) {
    const baselineFingerprint = String(
      Object.prototype.hasOwnProperty.call(baselineFingerprints, filePath)
        ? baselineFingerprints[filePath]
        : 'missing'
    ).trim();
    const recordedFingerprint = implementationEvidenceFingerprint(rootDir, filePath);
    pathRecords[filePath] = {
      baselineFingerprint,
      recordedFingerprint,
      fingerprint: recordedFingerprint,
      recordedAt,
      runId: metadata.runId ?? null,
      session: metadata.session ?? null,
      role: metadata.role ?? null
    };
  }
  state.implementationState[plan.planId] = {
    pathRecords,
    touchedPaths: mergedPaths,
    lastRecordedAt: recordedAt,
    updatedAt: recordedAt
  };
  return {
    recorded: true,
    matchedPaths
  };
}

export function resolveAtomicCommitRoots(plan, config, paths, completionContext = {}) {
  const policy = config?.git?.atomicCommitRoots ?? {};
  const includePlanMetadata = asBoolean(policy.allowPlanMetadata, true);
  const defaults = normalizeRelativePrefixList(policy.defaults);
  const shared = normalizeRelativePrefixList(policy.shared);
  const roots = new Set([...defaults, ...shared]);

  if (includePlanMetadata) {
    for (const root of normalizeRelativePrefixList(plan.atomicRoots ?? [])) {
      roots.add(root);
    }
  }

  if (plan.rel) {
    const planRel = assertSafeRelativePlanPath(plan.rel);
    roots.add(planRel);
  }

  const planSpecTargets =
    Array.isArray(plan.specTargets) && plan.specTargets.length > 0
      ? plan.specTargets
      : ['docs/product-specs/CURRENT-STATE.md'];
  for (const target of normalizeRelativePrefixList(planSpecTargets)) {
    roots.add(target);
  }

  for (const target of normalizeRelativePrefixList(plan.implementationTargets ?? [])) {
    roots.add(target);
  }

  const completedRelCandidate = completionContext.completedRel
    ? assertSafeRelativePlanPath(completionContext.completedRel)
    : null;
  if (completedRelCandidate) {
    roots.add(completedRelCandidate);
  }

  const evidenceIndexRel = assertSafeRelativePlanPath(
    toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, `${plan.planId}.md`)))
  );
  roots.add(evidenceIndexRel);
  roots.add(assertSafeRelativePlanPath(toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, 'README.md')))));

  roots.add(assertSafeRelativePlanPath(`docs/exec-plans/active/evidence/${plan.planId}.md`));
  roots.add(assertSafeRelativePlanPath('docs/exec-plans/active/evidence/README.md'));

  const runtimeContextPath = normalizedRelativePrefix(
    config?.context?.runtimeContextPath ?? 'docs/generated/AGENT-RUNTIME-CONTEXT.md'
  );
  if (runtimeContextPath) {
    roots.add(assertSafeRelativePlanPath(runtimeContextPath));
  }

  const runOutcomesPath = normalizedRelativePrefix('docs/generated/run-outcomes.json');
  if (runOutcomesPath) {
    roots.add(assertSafeRelativePlanPath(runOutcomesPath));
  }

  return [...roots]
    .map((entry) => normalizedRelativePrefix(entry))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function evaluateAtomicCommitReadiness(rootDir, planId, allowDirty, commitPolicy = {}, options = {}) {
  const requireDirty = asBoolean(options.requireDirty, true);
  if (allowDirty) {
    return {
      ok: false,
      committed: false,
      commitHash: null,
      reason: 'Refusing atomic commit with --allow-dirty true. Re-run with --allow-dirty false or --commit false.'
    };
  }

  if (!gitAvailable(rootDir)) {
    return { ok: true, committed: false, commitHash: null, reason: 'git-unavailable' };
  }

  const hasDirtyChanges = gitDirty(rootDir, { ignoreTransientAutomationArtifacts: true });
  if (requireDirty && !hasDirtyChanges) {
    return { ok: true, committed: false, commitHash: null, reason: 'no-changes' };
  }

  const enforceRoots = asBoolean(commitPolicy.enforceRoots, true);
  const allowedRoots = normalizeRelativePrefixList(commitPolicy.allowedRoots);
  if (enforceRoots && allowedRoots.length > 0) {
    const dirtyPaths = dirtyRepoPaths(rootDir);
    const outsideRoots = dirtyPaths.filter((entry) => !allowedRoots.some((root) => pathMatchesRootPrefix(entry, root)));
    if (outsideRoots.length > 0) {
      return {
        ok: false,
        committed: false,
        commitHash: null,
        reason: `Atomic root policy violation for ${planId}. Paths outside allowed roots: ${outsideRoots.join(', ')}`
      };
    }
  }

  const preStagedPaths = stagedRepoPaths(rootDir, { includeTransient: true });
  const stagedTransient = preStagedPaths.filter((entry) => isTransientAutomationPath(entry));
  if (stagedTransient.length > 0) {
    return {
      ok: false,
      committed: false,
      commitHash: null,
      reason: `Atomic commit refused because transient runtime files are already staged: ${stagedTransient.join(', ')}`
    };
  }
  if (enforceRoots && allowedRoots.length > 0) {
    const stagedOutsideRoots = preStagedPaths.filter(
      (entry) => !allowedRoots.some((root) => pathMatchesRootPrefix(entry, root))
    );
    if (stagedOutsideRoots.length > 0) {
      return {
        ok: false,
        committed: false,
        commitHash: null,
        reason: `Atomic root policy violation for ${planId}. Staged paths outside allowed roots: ${stagedOutsideRoots.join(', ')}`
      };
    }
  }

  return { ok: true, committed: false, commitHash: null, reason: null };
}

export function createAtomicCommit(rootDir, planId, dryRun, allowDirty, commitPolicy = {}) {
  if (dryRun) {
    return { ok: true, committed: false, commitHash: null, reason: 'dry-run' };
  }

  const preflight = evaluateAtomicCommitReadiness(rootDir, planId, allowDirty, commitPolicy, { requireDirty: true });
  if (!preflight.ok || preflight.reason === 'git-unavailable' || preflight.reason === 'no-changes') {
    return preflight;
  }

  const allowedRoots = normalizeRelativePrefixList(commitPolicy.allowedRoots);
  const addTargets = allowedRoots.length > 0 ? allowedRoots.map((entry) => shellQuote(entry)).join(' ') : '.';
  const add = runShellCapture(`git add --all -- ${addTargets}`, rootDir);
  if (add.status !== 0) {
    return { ok: false, committed: false, commitHash: null, reason: 'git add failed' };
  }

  const commitMessage = `exec-plan(${planId}): complete`;
  const commit = runShellCapture(`git commit -m ${JSON.stringify(commitMessage)}`, rootDir);
  if (commit.status !== 0) {
    return { ok: false, committed: false, commitHash: null, reason: 'git commit failed' };
  }

  const hash = runShellCapture('git rev-parse HEAD', rootDir);
  const commitHash = hash.status === 0 ? String(hash.stdout ?? '').trim() : null;
  return { ok: true, committed: true, commitHash, reason: null };
}
