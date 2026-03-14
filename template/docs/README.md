# Documentation README

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Entry Points

- Canonical index: `docs/index.md`
- Agent hardening policy: `docs/agent-hardening/README.md`
- Governance policy: `docs/governance/README.md`
- Policy manifest: `docs/governance/policy-manifest.json`
- Architecture map: `docs/architecture/README.md`
- Design docs: `docs/design-docs/README.md`
- Deployment model: `docs/deploy/README.md`
- Environment model: `docs/env/README.md`
- Product state: `docs/product-specs/current-state.md`
- Plan workflow: `docs/PLANS.md`
- Evidence index: `docs/exec-plans/evidence-index/README.md`
- Ops automation: `docs/ops/automation/README.md`
- Role orchestration: `docs/ops/automation/ROLE_ORCHESTRATION.md`
- Lite quickstart: `docs/ops/automation/LITE_QUICKSTART.md`
- Outcomes scorecard: `docs/ops/automation/OUTCOMES.md`
- GitHub interop mapping: `docs/ops/automation/INTEROP_GITHUB.md`
- Provider compatibility: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`
- Runtime context snapshot: `docs/generated/agent-runtime-context.md`

## Documentation Classes

- Canonical docs: hand-maintained source of truth such as `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `docs/governance/*`, `docs/architecture/*`, and plan/evidence docs.
- Generated docs: rebuildable artifacts derived from canonical policy or measured runs, such as `docs/generated/*`.
- Runtime artifacts: transient orchestration state under `docs/ops/automation/runtime/*` and `docs/ops/automation/handoffs/*`.
- Derived platform surfaces: optional exports for platform-native agents such as `.github/agents/*`; these are scaffolds, not canonical policy.

## Layering Model

- `AGENTS.md`: map and constraints.
- `README.md`: product summary and navigation entrypoint.
- `ARCHITECTURE.md` + `docs/architecture/*`: architecture truth and dependency rules.
- `docs/agent-hardening/*`: mandatory agent eval/observability/tool/memory policy.
- `docs/FRONTEND.md` and `docs/BACKEND.md`: implementation-side standards by runtime surface.

## Agent Consumption Order

- Humans and general-purpose agents start with `AGENTS.md`, `README.md`, and `docs/index.md`.
- Orchestrated role sessions consume `docs/generated/agent-runtime-context.md` plus task contact packs as the primary compact context.
- Platform-native feature agents should prefer exported scaffolds from `docs/ops/automation/INTEROP_GITHUB.md` rather than copying policy into ad-hoc prompt files.
- When canonical policy changes, regenerate derived surfaces instead of editing generated or exported files by hand.

## Authoring Rules

- Keep docs concise, canonical, and linked from `AGENTS.md`/`README.md`/`docs/index.md`.
- Update docs in the same change as behavior or boundary changes.
- Prefer canonical docs over ad-hoc notes.
- When updating strategic plans, keep upstream capability coverage and prior completed-plan reconciliation explicit instead of relying on implicit history.
- Do not move platform-specific agent instructions into canonical governance docs unless they are truly cross-provider policy.
