# Agent Runtime Context (Generated)

Primary Sources: AGENTS.md, docs/governance/policy-manifest.json, docs/ops/automation/orchestrator.config.json

## Mission
- Plan futures by creating or updating executable future slices directly in docs/future/.
- Run a flat queue in sequence: promote ready slices, implement them, review medium/high risk work, validate, and close.
- Keep the repo as the source of truth for plans, evidence, runtime state, and handoffs.

## Hard Safety Rules
- [correctness_over_speed] Correctness over speed for critical domains.
- [server_side_authority] Sensitive authority remains server-side for critical boundaries.
- [no_fake_success_paths] Never fabricate production success-path behavior.
- [shared_contracts_are_canonical] Shared contracts and primitives are canonical where applicable.
- [docs_are_part_of_done] Architecture, invariant, and user-visible changes must update canonical docs in the same change.
- [plan_mode_stops_at_future_docs] In plan mode or planning-only requests, stop after creating or updating docs/future output; do not edit source, test, or runtime files unless implementation is explicitly requested.
- [no_destructive_git_without_instruction] Never run destructive git/file commands without explicit written instruction.

## Planning Roles
- planner: Turn user intent into decision-complete future slices only; do not continue into implementation unless the user explicitly asks to implement, execute, or promote the plan.
- explorer: Trace risky surfaces and dependencies before implementation when planning needs more facts.

## Grind Roles
- worker: sandbox=full-access, reasoning=high
- reviewer: sandbox=read-only, reasoning=high
- review required for: medium, high
- explicit security approval required for: high
- low-context handoff threshold: <= 12000 remaining tokens or <= 15% remaining context when available

## Verification Profiles
- fast: node ./scripts/automation/compile-runtime-context.mjs ; node ./scripts/docs/check-governance.mjs ; node ./scripts/automation/check-plan-metadata.mjs ; node ./scripts/automation/check-harness-alignment.mjs
- full: node ./scripts/automation/compile-runtime-context.mjs ; node ./scripts/docs/check-governance.mjs ; node ./scripts/check-article-conformance.mjs ; node ./scripts/architecture/check-dependencies.mjs ; node ./scripts/agent-hardening/check-agent-hardening.mjs ; node ./scripts/agent-hardening/check-evals.mjs ; node ./scripts/automation/check-harness-alignment.mjs ; node ./scripts/automation/check-plan-metadata.mjs
- validation lanes: always=repo:verify-fast ; host-required=repo:verify-full

## Memory Posture
- do: Treat the repo as the main operating system for agent work.
- do: Keep plans, evidence, docs, code, and validation output as the source of truth.
- do: Treat `## Must-Land Checklist` as the execution contract and keep `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons` separate.
- do: Use repo-local checkpoints, explicit handoffs, evidence indexes, and resumable orchestration as the default memory system.
- do: Keep context selective: load current scope, latest checkpoint, latest handoff, and relevant evidence; persist distilled findings, not raw session history.
- improve first: Better checkpoint contents.
- improve first: Better handoff notes.
- improve first: Better evidence compaction.
- improve first: Better validation and observability.
- improve first: Fix plan quality before widening the memory system.
- not yet: Do not add external retrieval just because work is long.
- not yet: Do not add provider-thread persistence just because context is limited.
- not yet: Do not move important working memory outside the repo while repo-local continuity is sufficient.
- not yet: Do not treat extra memory systems as a substitute for better plans, checkpoints, and handoffs.
- escalate when: Agents repeatedly miss important context even though it exists.
- escalate when: Repo-local checkpoints and handoffs stop being enough.
- escalate when: Important memory starts living outside the repo.
- escalate when: You need one agent to search across many unrelated systems.
- escalate when: You can point to repeated failures, not just a vague worry.
- safe rule: If repo-local plans, checkpoints, and handoffs are enough, keep this design. If important context lives outside the repo and agents keep missing it, then consider external retrieval.

## Execution Checklist
- Read the current plan and latest checkpoint before editing.
- Honor Implementation-Targets, Validation-Lanes, and Security-Approval exactly as written.
- Write a structured result to ORCH_RESULT_PATH after each worker or reviewer session, or emit a single-line {"type":"orch_result","payload":...} stdout envelope if the sandbox prevents direct writes.
- Move plans to validation only when every must-land item is checked.
