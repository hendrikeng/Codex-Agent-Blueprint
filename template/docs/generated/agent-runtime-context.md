# Agent Runtime Context (Generated)

Generated At: 2026-03-02T12:39:02.268Z
Primary Sources: AGENTS.md, docs/governance/policy-manifest.json, docs/ops/automation/orchestrator.config.json

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
- planner: sandbox=read-only, reasoning=high, intent=Break down implementation into decision-complete execution steps.
- explorer: sandbox=read-only, reasoning=medium, intent=Trace risky surfaces and dependencies before implementation.
- worker: sandbox=full-access, reasoning=high, intent=Implement scoped changes and keep docs/evidence aligned.
- reviewer: sandbox=read-only, reasoning=high, intent=Check correctness, security, race conditions, flaky tests, and regressions.

## Verification Profiles
- fast: node ./scripts/automation/compile-runtime-context.mjs ; node ./scripts/docs/check-governance.mjs ; node ./scripts/automation/check-plan-metadata.mjs
- full: node ./scripts/automation/compile-runtime-context.mjs ; node ./scripts/docs/check-governance.mjs ; node ./scripts/check-article-conformance.mjs ; node ./scripts/architecture/check-dependencies.mjs ; node ./scripts/agent-hardening/check-agent-hardening.mjs ; node ./scripts/agent-hardening/check-evals.mjs ; node ./scripts/automation/check-blueprint-alignment.mjs ; node ./scripts/automation/check-plan-metadata.mjs

## Git Safety
- forbidden-without-instruction: git reset --hard
- forbidden-without-instruction: git checkout -- <path>
- forbidden-without-instruction: rm -rf
- forbidden-without-instruction: git clean -fd
- Do not edit .env files or switch branches/worktrees unless explicitly requested in-thread.

## Documentation Contract
- Canonical entrypoints: AGENTS.md, README.md, ARCHITECTURE.md, docs/index.md
- Update docs in same change when affecting: architecture boundaries
- Update docs in same change when affecting: critical invariants
- Update docs in same change when affecting: security/compliance behavior
- Update docs in same change when affecting: user-visible behavior

## Execution Checklist
- Apply scoped changes only; keep evidence links canonical.
- Preserve required safety gates and risk-routing behavior.
- Use fast verification during iteration, full verification before merge.

