# Agent Runtime Context (Generated)

Generated At: 2026-03-13T22:08:28.470Z
Primary Sources: AGENTS.md, docs/agent-hardening/MEMORY_CONTEXT.md, docs/governance/policy-manifest.json, docs/ops/automation/orchestrator.config.json

## Mission
- Docs-first minimal: this file is a concise map, not an execution playbook.
- Humans define intent, constraints, and acceptance criteria.
- Agents execute scoped tasks using repository-local docs, code, and checks.
- Continuous docs hygiene is required through repository checks.

## Hard Safety Rules
- [correctness_over_speed] Correctness over speed for critical domains.
- [server_side_authority] Sensitive authority remains server-side for critical boundaries.
- [no_fake_success_paths] Never fabricate production success-path behavior.
- [shared_contracts_are_canonical] Shared contracts and primitives are canonical where applicable.
- [docs_are_part_of_done] Architecture, invariant, and user-visible changes must update canonical docs in the same change.
- [no_destructive_git_without_instruction] Never run destructive git/file commands without explicit written instruction.

## Risk Pipelines
- low: worker
- medium: planner -> worker -> reviewer
- high: planner -> explorer -> worker -> reviewer

## Role Contracts
- planner: sandbox=read-only, reasoning=medium, intent=Break down implementation into decision-complete execution steps.
- explorer: sandbox=read-only, reasoning=medium, intent=Trace risky surfaces and dependencies before implementation.
- worker: sandbox=full-access, reasoning=high, intent=Implement scoped changes and keep docs/evidence aligned.
- reviewer: sandbox=read-only, reasoning=high, intent=Check correctness, security, race conditions, flaky tests, and regressions.

## Verification Profiles
- fast: node ./scripts/automation/compile-runtime-context.mjs ; node ./scripts/docs/check-governance.mjs ; node ./scripts/automation/check-plan-metadata.mjs
- full: node ./scripts/automation/compile-runtime-context.mjs ; node ./scripts/docs/check-governance.mjs ; node ./scripts/check-article-conformance.mjs ; node ./scripts/architecture/check-dependencies.mjs ; node ./scripts/agent-hardening/check-agent-hardening.mjs ; node ./scripts/agent-hardening/check-evals.mjs ; node ./scripts/automation/check-harness-alignment.mjs ; node ./scripts/automation/check-plan-metadata.mjs

## Memory Posture
- do: Treat the repo as the main operating system for agent work.
- do: Keep plans, evidence, docs, code, and validation output as the source of truth.
- do: Treat `## Must-Land Checklist` as the execution contract and keep `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons` separate.
- do: Use repo-local checkpoints, contact packs, explicit handoffs, evidence indexes, and resumable orchestration as the default memory system.
- do: Keep context selective: load current scope, latest state, recent checkpoints, and relevant evidence; persist distilled findings and stable references, not raw session history.
- improve first: Better checkpoint contents. ; Better contact-pack selection. ; Better evidence compaction. ; Better validation and observability. ; Fix rolling-context and contact-pack implementation gaps before changing architecture.
- not yet: Do not add external retrieval just because work is long. ; Do not add provider-thread persistence just because context is limited. ; Do not move important working memory outside the repo while repo-local continuity is sufficient. ; Do not treat extra memory systems as a substitute for better checkpoints and contact packs.
- escalate when: Agents repeatedly miss important context even though it exists. ; Repo-local checkpoints and contact packs stop being enough. ; Important memory starts living outside the repo. ; You need one agent to search across many unrelated systems.
- safe rule: If repo-local state is enough, keep this design. If important context lives outside the repo and agents keep missing it, then consider external retrieval.

## Git Safety
- forbidden-without-instruction: git reset --hard
- forbidden-without-instruction: git checkout -- <path>
- forbidden-without-instruction: rm -rf
- forbidden-without-instruction: git clean -fd
- Do not edit .env files or switch branches/worktrees unless explicitly requested in-thread.

## Documentation Contract
- Canonical entrypoints: AGENTS.md, README.md, ARCHITECTURE.md, docs/MANIFEST.md
- Update docs in same change when affecting: architecture boundaries
- Update docs in same change when affecting: critical invariants
- Update docs in same change when affecting: security/compliance behavior
- Update docs in same change when affecting: user-visible behavior

## Execution Checklist
- Apply scoped changes only; keep evidence links canonical.
- Preserve required safety gates and risk-routing behavior.
- Use fast verification during iteration, full verification before merge.
