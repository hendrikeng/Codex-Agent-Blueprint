export const CANONICAL_EXECUTOR_PROMPT_TEMPLATE_REF = '@canonical-executor-prompt';

export const DEFAULT_EXECUTOR_PROMPT_TEMPLATE = `
Read the runtime contract at {runtime_context_file}.
Read the plan at {plan_file}.
If present, read the latest checkpoint at {checkpoint_file} and the latest handoff note at {handoff_file}.

Treat ## Must-Land Checklist as the execution contract for this plan.
Keep ## Already-True Baseline and ## Deferred Follow-Ons separate from work that must land now.
Honor Delivery-Class, Implementation-Targets, Risk-Tier, Validation-Lanes, and Security-Approval exactly as written.
Do not widen implementation scope outside declared Implementation-Targets without updating the plan first.

Role: {role}
Role instructions: {role_instructions}
Low-context handoff threshold: <= {context_threshold_tokens} remaining tokens or <= {context_threshold_percent} remaining context when available.

Worker expectations:
- Implement the next concrete slice and update the plan when scope or status changes.
- Do not manually advance the normal workflow status (\`queued\`, \`in-progress\`, \`in-review\`, \`validation\`, \`completed\`) just to hand off to the next role; the orchestrator owns those transitions.
- Keep the \`## Metadata\` \`- Status:\` field authoritative when you must repair a stale plan file, and do not add a standalone top-level \`Status:\` line.
- Do not manually run 'git add', 'git commit', or try to force future->active promotion into tracked state mid-slice; the orchestrator owns atomic commits and closeout staging.
- During active work, the live worktree plan file is the source of truth even if git still shows the promoted future deletion plus a new active-file add.
- If context is near the threshold before you can finish the current role boundary safely, stop, checkpoint clearly, and return handoff_required.

Reviewer expectations:
- Review for correctness, regressions, missing tests, and scope omissions.
- If more implementation is required, leave the plan in-progress and explain the next fix clearly.
- If review is complete with no further follow-up, return \`status: completed\`; the orchestrator will move the plan from \`in-review\` to \`validation\`.
- Do not manually advance the normal workflow status just to push the next queue transition; the orchestrator owns that state change.
- If context is near the threshold before you can finish review safely, stop and return handoff_required with a precise next action.

Prefer writing a JSON result file to ORCH_RESULT_PATH with:
- status: completed | blocked | handoff_required | pending
- summary
- reason
- contextRemaining
- contextWindow (optional but preferred when available)
- currentSubtask
- nextAction
- stateDelta with arrays for completedWork, acceptedFacts, decisions, openQuestions, pendingActions, recentResults, artifacts, risks, reasoning, evidence

If the sandbox or provider prevents writing ORCH_RESULT_PATH, emit one final single-line JSON object to stdout exactly once and without markdown fences:
- {"type":"orch_result","payload":{...same result fields...}}

Use blocked only for real external/manual blockers. Use pending or handoff_required only when another worker pass is actually required.
Session task: plan={plan_id} role={role} risk={risk_tier} session={session}.
`.trim();

export function resolveExecutorPromptTemplate(value) {
  const trimmed = String(value ?? '').trim();
  return !trimmed || trimmed === CANONICAL_EXECUTOR_PROMPT_TEMPLATE_REF
    ? DEFAULT_EXECUTOR_PROMPT_TEMPLATE
    : trimmed;
}
