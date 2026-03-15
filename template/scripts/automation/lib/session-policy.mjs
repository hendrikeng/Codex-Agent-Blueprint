import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  classifyTouchedPath,
  disallowedWorkerTouchedPaths,
  normalizeTouchedPathList,
  pathMatchesRootPrefix
} from './plan-scope.mjs';
import {
  completionGateReadyForValidation,
  documentStatusValue,
  documentValidationReadyValue
} from './plan-document-state.mjs';
import {
  normalizeRelativePrefixList,
  toPosix
} from './orchestrator-shared.mjs';

function isProgramPlan(plan) {
  return String(plan?.executionScope ?? '').trim().toLowerCase() === 'program';
}

function isProductPlan(plan) {
  return String(plan?.deliveryClass ?? '').trim().toLowerCase() === 'product';
}

function isArtifactSlicePlan(plan) {
  return !isProgramPlan(plan) && !isProductPlan(plan);
}

export function isMeaningfulWorkerTouchCategory(category, touchPolicy = null) {
  const normalized = String(category ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === 'plan-docs') {
    return touchPolicy?.allowPlanDocsOnlyTouches === true;
  }
  return true;
}

export function isMeaningfulWorkerTouchPath(filePath, touchPolicy = null) {
  const normalized = toPosix(String(filePath ?? '').trim()).replace(/^\.?\//, '');
  if (!normalized) {
    return false;
  }
  if (!isMeaningfulWorkerTouchCategory(classifyTouchedPath(normalized), touchPolicy)) {
    return false;
  }
  if (!touchPolicy?.allowPlanDocsOnlyTouches) {
    return true;
  }
  const allowedTouchRoots = Array.isArray(touchPolicy.allowedTouchRoots) ? touchPolicy.allowedTouchRoots : [];
  if (allowedTouchRoots.length === 0) {
    return false;
  }
  return allowedTouchRoots.some((root) => pathMatchesRootPrefix(normalized, root));
}

export function hasMeaningfulWorkerTouchSummary(summary, touchPolicy = null) {
  const touchedPaths = Array.isArray(summary?.touched) ? summary.touched : [];
  if (touchedPaths.length > 0) {
    return touchedPaths.some((entry) => isMeaningfulWorkerTouchPath(entry, touchPolicy));
  }

  const categories = Array.isArray(summary?.categories) ? summary.categories : [];
  if (touchPolicy?.allowPlanDocsOnlyTouches) {
    return categories.some((entry) => {
      const category = String(entry?.category ?? '').trim().toLowerCase();
      const count = Number(entry?.count ?? 0);
      return category !== 'plan-docs' && isMeaningfulWorkerTouchCategory(category, touchPolicy) && Number.isFinite(count) && count > 0;
    });
  }
  return categories.some((entry) => {
    const category = String(entry?.category ?? '').trim().toLowerCase();
    const count = Number(entry?.count ?? 0);
    return isMeaningfulWorkerTouchCategory(category, touchPolicy) && Number.isFinite(count) && count > 0;
  });
}

export function buildWorkerTouchPolicy(plan) {
  const docsOnlyArtifactPlan = isArtifactSlicePlan(plan);
  const content = typeof plan?.content === 'string' ? plan.content : '';
  const documentStatus = content ? documentStatusValue(content) : '';
  const validationReady = content ? documentValidationReadyValue(content) : '';
  const validationOnlyPlan = completionGateReadyForValidation(documentStatus, validationReady);
  const allowPlanDocsOnlyTouches = docsOnlyArtifactPlan;
  const allowedTouchRoots = allowPlanDocsOnlyTouches
    ? normalizeRelativePrefixList([
        plan.rel,
        ...normalizeRelativePrefixList(plan.specTargets ?? []),
        toPosix(path.posix.join('docs', 'exec-plans', 'active', 'evidence', `${plan.planId}.md`)),
        toPosix(path.posix.join('docs', 'exec-plans', 'evidence-index', `${plan.planId}.md`))
      ])
    : [];
  const progressLabel = allowPlanDocsOnlyTouches
    ? 'repository edits in the plan\'s scoped docs/artifact targets'
    : 'repository edits outside plan/evidence files';

  return {
    docsOnlySpecTargets: docsOnlyArtifactPlan,
    validationOnlyPlan,
    allowPlanDocsOnlyTouches,
    allowedTouchRoots,
    progressLabel
  };
}

export function summarizeTouchedPaths(paths, sampleSize = 3) {
  const normalized = [...new Set((Array.isArray(paths) ? paths : []).map((entry) => toPosix(String(entry ?? '').trim())).filter(Boolean))];
  if (normalized.length === 0) {
    return {
      count: 0,
      categories: [],
      samples: [],
      fingerprint: 'none'
    };
  }

  const categoryCounts = new Map();
  for (const filePath of normalized) {
    const category = classifyTouchedPath(filePath);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  const categories = [...categoryCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category, count]) => ({ category, count }));
  const samples = normalized.slice(0, Math.max(1, sampleSize));
  const fingerprint = createHash('sha1')
    .update(normalized.join('\n'))
    .digest('hex')
    .slice(0, 10);

  return {
    count: normalized.length,
    categories,
    samples,
    fingerprint
  };
}

export function formatTouchSummaryInline(summary) {
  const payload = summary && typeof summary === 'object' ? summary : null;
  if (!payload || payload.count <= 0) {
    return 'touch=none';
  }
  const categories = payload.categories
    .slice(0, 2)
    .map((entry) => `${entry.category}:${entry.count}`)
    .join(',');
  return `touch=${payload.count}(${categories || 'n/a'})`;
}

export function formatTouchSummaryDetails(summary) {
  const payload = summary && typeof summary === 'object' ? summary : null;
  if (!payload || payload.count <= 0) {
    return 'touched=0';
  }
  const categories = payload.categories
    .slice(0, 4)
    .map((entry) => `${entry.category}:${entry.count}`)
    .join(', ');
  const samples = payload.samples.length > 0 ? payload.samples.join(', ') : 'none';
  return `touched=${payload.count} categories=[${categories}] sample=[${samples}]`;
}

export function disallowedTouchedPathsForRole(role, plan, touchedPaths = []) {
  const normalizedRole = String(role ?? '').trim().toLowerCase() || 'worker';
  if (normalizedRole === 'worker') {
    return disallowedWorkerTouchedPaths(plan, touchedPaths);
  }
  const normalized = normalizeTouchedPathList(touchedPaths);
  return normalized.filter((filePath) => !filePath.startsWith('docs/exec-plans/'));
}
