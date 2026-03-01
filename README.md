# Agent Blueprint

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-28
Source of Truth: This directory.

Reusable blueprint for initializing agent-first repositories with standardized docs/governance architecture.

## Includes

- Canonical docs skeleton under `template/docs/`
- Canonical agent hardening docs under `template/docs/agent-hardening/`
- Base top-level docs: `template/AGENTS.md`, `template/README.md`, `template/ARCHITECTURE.md`
- Runtime standards docs: `template/docs/FRONTEND.md`, `template/docs/BACKEND.md`
- Governance/conformance/architecture checker scripts under `template/scripts/`
- Agent hardening checker script under `template/scripts/agent-hardening/`
- Plan metadata validator and execution orchestrator under `template/scripts/automation/`
- Risk-adaptive role orchestration contract and provider adapters under `template/docs/ops/automation/`
- Governance config and architecture rule schema in `template/docs/governance/`
- Placeholder contract: `template/PLACEHOLDERS.md`

## Required Script Interface

- `docs:verify` -> `node ./scripts/docs/check-governance.mjs`
- `conformance:verify` -> `node ./scripts/check-article-conformance.mjs`
- `architecture:verify` -> `node ./scripts/architecture/check-dependencies.mjs`
- `agent:verify` -> `node ./scripts/agent-hardening/check-agent-hardening.mjs`
- `plans:verify` -> `node ./scripts/automation/check-plan-metadata.mjs`

## Automation Commands

- `automation:run` -> `node ./scripts/automation/orchestrator.mjs run`
- `automation:resume` -> `node ./scripts/automation/orchestrator.mjs resume`
- `automation:audit` -> `node ./scripts/automation/orchestrator.mjs audit`
- Executor is required and loaded from `docs/ops/automation/orchestrator.config.json` (`executor.command`).
- Role routing is risk-adaptive (`low: worker`, `medium: planner->worker->reviewer`, `high: planner->explorer->worker->reviewer`) with Security-Approval gates for high/sensitive plans.

## When To Run Checks

- Run all checks before merge: `docs:verify`, `conformance:verify`, `architecture:verify`, `agent:verify`, `plans:verify`.
- Run `agent:verify` when changing eval policy, agent observability, tool-safety, or memory/context rules.
- Run `architecture:verify` when changing dependency boundaries.

## Template Policy

This blueprint is intentionally stack- and domain-agnostic.
Agents must replace all `{{...}}` placeholders before treating a repo as production-ready.

## State-of-the-Art Workflow

Use a dual-track lifecycle for implemented work:

1. Strategic/non-trivial work: `future -> active -> completed`.
2. Quick/manual fixes: `active -> completed` (no prior `future` blueprint required).
3. In both tracks, `active` plans must keep metadata/status current and evidence curated.
4. Completed plans must keep concise closure plus canonical `Done-Evidence` index references.

Orchestration is the default execution driver. Manual execution is valid only when it follows the same metadata, status, and evidence-index contract.

## Bootstrap Steps

1. Copy `template/` contents into a new repository root.
2. Replace placeholders listed in `PLACEHOLDERS.md`.
3. Verify no placeholders remain:
   - `./scripts/check-template-placeholders.sh`
4. Add script entries to repository `package.json`:
   - `docs:verify`
   - `conformance:verify`
   - `architecture:verify`
   - `agent:verify`
   - `plans:verify`
5. Update `docs/generated/article-conformance.json` evidence paths for the new repository.
6. Run `./scripts/bootstrap-verify.sh` (or run each verify command manually).


## Agent Quickstart (Plan Mode)

Use this when initializing a new repo from the blueprint:

1. Create a new repository using this GitHub template.
2. Enter the repository from CLI (`cd <new-repo>`).
3. Start the agent in plan mode and define the app before any file edits.
4. Lock decisions for product scope, first features, stack/runtime, and core invariants.
5. After decisions are approved, execute bootstrap: copy `template/` into repo root, replace placeholders from `PLACEHOLDERS.md`, and wire required scripts.
6. Seed strategic work in `docs/future/`; track quick/manual fixes directly in `docs/exec-plans/active/`.
7. Run `./scripts/check-template-placeholders.sh` until clean.
8. Run `./scripts/bootstrap-verify.sh`.

Suggested prompt for an agent:

```text
We are starting a new app from this Agent Blueprint repository template.
In plan mode, first collaborate with me to decide:
- what the app does,
- which features we implement first,
- which stack/runtime/tooling we use,
- and which core invariants we enforce.
Do not edit files yet.
After I confirm those decisions, execute bootstrap:
1) copy template files into repository root,
2) replace placeholders from PLACEHOLDERS.md,
3) wire required package scripts,
4) seed initial strategic plans in docs/future,
5) use direct docs/exec-plans/active plans for quick/manual fixes,
6) run ./scripts/check-template-placeholders.sh and ./scripts/bootstrap-verify.sh.
Do not stop until the checks pass with zero errors.
```
