# AGENTS.md

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document delegates to linked canonical docs.

This file is the agent/human entrypoint map for repository behavior.
If instructions conflict, this file is the behavioral priority entrypoint.

## Operating Model

- Docs-first minimal: this file is a concise map, not an execution playbook.
- Humans define intent, constraints, and acceptance criteria.
- Agents execute scoped tasks using repository-local docs, code, and checks.
- Continuous docs hygiene is required through repository checks.

## Agent Handout

- Treat the repo as the main operating system for agent work.
- Keep plans, evidence, docs, code, and validation output as the source of truth.
- Treat `## Must-Land Checklist` as the execution contract and keep `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons` separate.
- Use repo-local checkpoints, contact packs, explicit handoffs, evidence indexes, and resumable orchestration as the default memory system.
- Keep context selective: load current scope, latest state, recent checkpoints, and relevant evidence; persist distilled findings and stable references, not raw session history.
- Improve checkpoint contents, contact-pack selection, evidence compaction, validation, and observability before changing memory architecture.
- Do not add external retrieval, provider-thread persistence, or off-repo working memory just because work is long or context is limited.
- Consider bigger memory changes only when repeated failures show repo-local continuity is insufficient or important context genuinely lives outside the repo.

## Intent Precedence

- Explicit user intent is binding.
- In normal/direct Codex sessions (outside orchestrator `run`/`resume`), follow user intent immediately.
- If the session is switched to plan mode, treat it as planning-only unless the user explicitly asks to implement.
- If a user asks for planning-only work (for example: "plan", "outline", "prepare for promotion", "no implementation yet"), do not modify source or test files.
- For planning-only requests, work in `docs/future/`, keep metadata complete, and set `Status: ready-for-promotion` when the plan is decision-complete.
- Planning outputs must separate `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons` so executable scope is explicit before promotion.
- Start implementation only when the user explicitly asks to implement or promote/execute the plan.

## Core Map

Start here, then follow linked source-of-truth docs:
- Platform scope/status: `README.md`
- Architecture quick entrypoint: `ARCHITECTURE.md`
- Canonical docs coverage manifest: `docs/MANIFEST.md`
- Documentation index: `docs/README.md`
- Governance policy (detailed): `docs/governance/RULES.md`
- Policy manifest (runtime source): `docs/governance/policy-manifest.json`
- Golden principles: `docs/governance/GOLDEN-PRINCIPLES.md`
- Quality scorecard: `docs/QUALITY_SCORE.md`
- Design docs: `docs/design-docs/README.md`
- Engineering invariants: `docs/design-docs/ENGINEERING-INVARIANTS.md`
- UI standards: `docs/design-docs/UI-STANDARDS.md`
- Frontend standards: `docs/FRONTEND.md`
- Backend standards: `docs/BACKEND.md`
- Agent hardening policy map: `docs/agent-hardening/README.md`
- Memory and context policy: `docs/agent-hardening/MEMORY_CONTEXT.md`
- Git safety: `docs/design-docs/GIT-SAFETY.md`
- Plan lifecycle (non-trivial changes): `docs/PLANS.md`
- Product specs index: `docs/product-specs/README.md`
- Product state snapshot: `docs/product-specs/CURRENT-STATE.md`
- Execution plans: `docs/exec-plans/README.md`
- Ops automation conveyor: `docs/ops/automation/README.md`
- Role orchestration contract: `docs/ops/automation/ROLE_ORCHESTRATION.md`
- Lite lane onboarding: `docs/ops/automation/LITE_QUICKSTART.md`
- Automation outcomes scorecard: `docs/ops/automation/OUTCOMES.md`
- GitHub interop mapping: `docs/ops/automation/INTEROP_GITHUB.md`
- Provider compatibility contract: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`
- Generated runtime context snapshot: `docs/generated/AGENT-RUNTIME-CONTEXT.md`

## Non-Negotiables

- Correctness over speed for `{{CRITICAL_DOMAIN_SET}}`.
- Server-side authority for `{{SERVER_AUTHORITY_BOUNDARY_SET}}`.
- No fake production success-path behavior.
- Shared contracts and shared UI primitives are canonical where applicable.
- Agent hardening policy in `docs/agent-hardening/*` is canonical and mandatory.
- `{{MONEY_AND_NUMERIC_RULE}}`

## Critical Domain Invariants

{{DOMAIN_INVARIANT_AREA_1}}:
- {{DOMAIN_INVARIANT_1A}}
- {{DOMAIN_INVARIANT_1B}}

{{DOMAIN_INVARIANT_AREA_2}}:
- {{DOMAIN_INVARIANT_2A}}
- {{DOMAIN_INVARIANT_2B}}

{{DOMAIN_INVARIANT_AREA_3}}:
- {{DOMAIN_INVARIANT_3A}}
- {{DOMAIN_INVARIANT_3B}}

## Documentation Contract

Any change affecting architecture boundaries, critical invariants,
security/compliance domains, or user-visible behavior must update:
- `README.md`
- relevant docs under `docs/`

Docs are part of done.

## Architecture Contract

- Follow `ARCHITECTURE.md` and `docs/governance/architecture-rules.json`.
- Respect module and layer dependency direction.
- Do not bypass CI architecture checks.

## Security and Data Safety

- Treat inbound integration data as untrusted.
- Ensure idempotency/retry safety where external callbacks exist.
- Enforce boundary checks server-side for sensitive operations.

## Git and File Safety

- Canonical policy location: `docs/design-docs/GIT-SAFETY.md`.
- Never edit `.env` or environment variable files.
- Never run destructive git/file commands without explicit written instruction.
- Do not use `git stash` unless explicitly requested in-thread.
- Do not switch branches or modify git worktrees unless explicitly requested in-thread.

## Test and Validation Expectations

- Runtime context generation is mandatory: `npm run context:compile`.
- Iteration profile: `npm run verify:fast`.
- Merge profile: `npm run verify:full`.
- Canonical verification policy lives in `docs/governance/RULES.md`.
- Add/adjust tests for behavior changes.
- Every bug fix needs a regression test.
- Critical flows require focused coverage.
- If required dependencies/tools are missing, install via the repo-defined package manager and rerun the exact command once.

## If Unsure

Do not guess. Stop, inspect, and apply the safest explicit change.

## Repo-Specific Extensions

- Put repo-specific domain constraints in `docs/product-specs/CURRENT-STATE.md` and domain docs.
