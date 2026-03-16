import { sectionBody } from './plan-document-state.mjs';
import { nowIso } from './orchestrator-shared.mjs';

function classifyChildStatus(plan) {
  if (plan.phase === 'completed' || plan.status === 'completed') {
    return 'completed';
  }
  if (plan.phase === 'future') {
    return 'future';
  }
  if (plan.status === 'validation') {
    return 'validation';
  }
  if (plan.status === 'blocked') {
    return 'blocked';
  }
  if (plan.status === 'failed') {
    return 'failed';
  }
  if (plan.status === 'queued') {
    return 'queued';
  }
  return 'in-progress';
}

function childCountsTemplate() {
  return {
    future: 0,
    queued: 0,
    'in-progress': 0,
    blocked: 0,
    failed: 0,
    validation: 0,
    completed: 0
  };
}

function summaryLine(counts, totalChildren) {
  return (
    `${counts.completed}/${totalChildren} completed, ` +
    `validation=${counts.validation}, in-progress=${counts['in-progress']}, ` +
    `queued=${counts.queued}, blocked=${counts.blocked}, failed=${counts.failed}, future=${counts.future}`
  );
}

function reconciliationReady(parent) {
  const body = sectionBody(parent.content ?? '', 'Prior Completed Plan Reconciliation');
  if (!body) {
    return false;
  }
  const normalized = body.toLowerCase();
  if (
    normalized.includes('tbd') ||
    normalized.includes('todo') ||
    normalized.includes('pending') ||
    normalized.includes('unresolved')
  ) {
    return false;
  }
  return true;
}

export function deriveProgramStates(catalog, options = {}) {
  const allPlans = [
    ...(Array.isArray(catalog?.future) ? catalog.future : []),
    ...(Array.isArray(catalog?.active) ? catalog.active : []),
    ...(Array.isArray(catalog?.completed) ? catalog.completed : [])
  ];
  const compilationIssuesByParent = options.compilationIssuesByParent instanceof Map
    ? options.compilationIssuesByParent
    : new Map();
  const parentOutcomesByParent = options.parentOutcomesByParent instanceof Map
    ? options.parentOutcomesByParent
    : new Map();
  const byId = new Map(allPlans.map((plan) => [plan.planId, plan]));
  const childrenByParent = new Map();

  for (const plan of allPlans) {
    if (!plan?.parentPlanId) {
      continue;
    }
    if (!childrenByParent.has(plan.parentPlanId)) {
      childrenByParent.set(plan.parentPlanId, []);
    }
    childrenByParent.get(plan.parentPlanId).push(plan);
  }

  const programStates = {};
  for (const parent of allPlans) {
    if (parent.executionScope !== 'program') {
      continue;
    }
    const children = childrenByParent.get(parent.planId) ?? [];
    const counts = childCountsTemplate();
    const blockedChildPlanIds = [];
    const failedChildPlanIds = [];
    const validationPendingChildPlanIds = [];
    const incompleteChildPlanIds = [];
    const unresolvedDependencies = new Set();
    const childStatuses = [];
    const compilationIssues = compilationIssuesByParent.get(parent.planId) ?? [];
    const parentOutcome = parentOutcomesByParent.get(parent.planId) ?? null;

    for (const child of children) {
      const childStatus = classifyChildStatus(child);
      counts[childStatus] += 1;
      childStatuses.push({
        planId: child.planId,
        phase: child.phase,
        status: child.status,
        derivedStatus: childStatus,
        rel: child.rel
      });
      if (childStatus !== 'completed') {
        incompleteChildPlanIds.push(child.planId);
      }
      if (childStatus === 'validation') {
        validationPendingChildPlanIds.push(child.planId);
      }
      if (childStatus === 'blocked') {
        blockedChildPlanIds.push(child.planId);
      }
      if (childStatus === 'failed') {
        failedChildPlanIds.push(child.planId);
      }
      for (const dependency of child.dependencies ?? []) {
        const dependencyPlan = byId.get(dependency);
        const dependencyCompleted = dependencyPlan?.phase === 'completed' || dependencyPlan?.status === 'completed';
        if (!dependencyCompleted) {
          unresolvedDependencies.add(dependency);
        }
      }
    }

    const totalChildren = children.length;
    const completedChildren = counts.completed;
    const percentComplete = totalChildren === 0 ? 0 : Math.round((completedChildren / totalChildren) * 100);
    const closeoutBlockedReasons = [];
    const isReconciliationReady = reconciliationReady(parent);
    if (totalChildren === 0) {
      closeoutBlockedReasons.push('No child slices reference this parent.');
    }
    if (incompleteChildPlanIds.length > 0) {
      closeoutBlockedReasons.push(`Incomplete child slices remain: ${incompleteChildPlanIds.join(', ')}`);
    }
    if (validationPendingChildPlanIds.length > 0) {
      closeoutBlockedReasons.push(`Validation pending for child slices: ${validationPendingChildPlanIds.join(', ')}`);
    }
    if (blockedChildPlanIds.length > 0) {
      closeoutBlockedReasons.push(`Blocked child slices require unblock: ${blockedChildPlanIds.join(', ')}`);
    }
    if (failedChildPlanIds.length > 0) {
      closeoutBlockedReasons.push(`Failed child slices require retry or unblock: ${failedChildPlanIds.join(', ')}`);
    }
    if (unresolvedDependencies.size > 0) {
      closeoutBlockedReasons.push(`Unresolved child dependencies remain: ${[...unresolvedDependencies].join(', ')}`);
    }
    if (!isReconciliationReady) {
      closeoutBlockedReasons.push('Prior completed plan reconciliation is missing or unresolved.');
    }
    if (parentOutcome?.status === 'blocked-missing-child-definitions') {
      closeoutBlockedReasons.push('Program parent cannot run because no child definitions exist.');
    }
    if (parentOutcome?.status === 'blocked-legacy-headings') {
      closeoutBlockedReasons.push('Legacy headings block structured child compilation.');
    }
    if (parentOutcome?.status === 'blocked-draft-scaffold') {
      closeoutBlockedReasons.push('Draft child scaffold still requires review.');
    }
    if (parentOutcome?.status === 'skipped-blueprint-only') {
      closeoutBlockedReasons.push('Program parent is intentionally blueprint-only.');
    }
    if (compilationIssues.length > 0) {
      closeoutBlockedReasons.push(
        `Compiled child plans are stale or invalid: ${compilationIssues.map((issue) => issue.code).join(', ')}`
      );
    }

    const closeoutEligible =
      parent.phase === 'active' &&
      parent.status !== 'completed' &&
      closeoutBlockedReasons.length === 0;

    programStates[parent.planId] = {
      planId: parent.planId,
      phase: parent.phase,
      status: parent.status,
      rel: parent.rel,
      authoringIntent: parentOutcome?.authoringIntent ?? '',
      authoringStatus: parentOutcome?.status ?? '',
      authoringReason: parentOutcome?.reason ?? '',
      totalChildren,
      completedChildren,
      futureChildren: counts.future,
      queuedChildren: counts.queued,
      inProgressChildren: counts['in-progress'],
      blockedChildren: counts.blocked,
      failedChildren: counts.failed,
      validationChildren: counts.validation,
      percentComplete,
      childStatuses,
      incompleteChildPlanIds,
      blockingChildPlanIds: [...new Set([...blockedChildPlanIds, ...failedChildPlanIds])],
      blockedChildPlanIds,
      failedChildPlanIds,
      validationPendingChildPlanIds,
      unresolvedDependencies: [...unresolvedDependencies].sort((left, right) => left.localeCompare(right)),
      reconciliationReady: isReconciliationReady,
      childCompilationCurrent: compilationIssues.length === 0,
      childCompilationIssues: compilationIssues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        filePath: issue.filePath
      })),
      closeoutEligible,
      closeoutBlockedReasons,
      summary: summaryLine(counts, totalChildren),
      lastDerivedAt: options.derivedAt ?? nowIso()
    };
  }

  return programStates;
}
