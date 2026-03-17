# Documentation README

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

This file is the navigation and usage entrypoint for `docs/`. Use `docs/MANIFEST.md` as the completeness manifest for first-class docs and folders.

## Entry Points

- Canonical manifest: `docs/MANIFEST.md`
- Agent hardening policy: `docs/agent-hardening/README.md`
- Governance policy: `docs/governance/README.md`
- Governance rules: `docs/governance/RULES.md`
- Golden principles: `docs/governance/GOLDEN-PRINCIPLES.md`
- Policy manifest: `docs/governance/policy-manifest.json`
- Architecture rules: `docs/governance/architecture-rules.json`
- Architecture map: `docs/architecture/README.md`
- Design docs: `docs/design-docs/README.md`
- Deployment model: `docs/deploy/README.md`
- Environment model: `docs/env/README.md`
- Product specs index: `docs/product-specs/README.md`
- Product state: `docs/product-specs/CURRENT-STATE.md`
- References index: `docs/references/README.md`
- UI contracts: `docs/ui/README.md`
- Plan workflow: `docs/PLANS.md`
- Evidence index: `docs/exec-plans/evidence-index/README.md`
- Ops runbooks: `docs/ops/README.md`
- Ops automation: `docs/ops/automation/README.md`
- Role orchestration: `docs/ops/automation/ROLE_ORCHESTRATION.md`
- Lite quickstart: `docs/ops/automation/LITE_QUICKSTART.md`
- Outcomes scorecard: `docs/ops/automation/OUTCOMES.md`
- GitHub interop mapping: `docs/ops/automation/INTEROP_GITHUB.md`
- Provider compatibility: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`
- Generated artifact index: `docs/generated/README.md`
- Runtime context snapshot: `docs/generated/AGENT-RUNTIME-CONTEXT.md`

## Documentation Classes

- Canonical docs: hand-maintained source of truth such as `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `docs/governance/*`, `docs/architecture/*`, and plan/evidence docs.
- Generated docs: rebuildable artifacts derived from canonical policy or measured runs, such as `docs/generated/*`.
- Runtime artifacts: transient orchestration state under `docs/ops/automation/runtime/*` and `docs/ops/automation/handoffs/*`.
- Derived platform surfaces: optional repo-local exports or scaffolds for platform-native agents; these are scaffolds, not canonical policy.

## Layering Model

- `AGENTS.md`: map and constraints.
- `README.md`: product summary and navigation entrypoint.
- `ARCHITECTURE.md` + `docs/architecture/*`: architecture truth and dependency rules.
- `docs/agent-hardening/*`: mandatory agent eval/observability/tool/memory policy.
- `docs/FRONTEND.md` and `docs/BACKEND.md`: implementation-side standards by runtime surface.

## Agent Consumption Order

- Humans and general-purpose agents start with `AGENTS.md`, `README.md`, and `docs/MANIFEST.md`.
- Queue runtime sessions consume `docs/generated/AGENT-RUNTIME-CONTEXT.md`, the current plan, the latest checkpoint, the latest handoff note, and only the evidence needed for the active slice.
- If a repository chooses to export platform-native scaffolds, treat them as optional derived surfaces described by `docs/ops/automation/INTEROP_GITHUB.md` rather than as canonical policy.
- When canonical policy changes, regenerate derived surfaces instead of editing generated or exported files by hand.

## Authoring Rules

- Keep docs concise, canonical, and linked from `AGENTS.md`/`README.md`/`docs/MANIFEST.md`.
- Update docs in the same change as behavior or boundary changes.
- Prefer canonical docs over ad-hoc notes.
- Use one executable slice per future/active plan file and express larger efforts with multiple plan files linked by `Dependencies`.
- Keep `## Already-True Baseline`, `## Must-Land Checklist`, and `## Deferred Follow-Ons` explicit so broader vision does not silently become executable scope.
- Do not reintroduce program parents, child-slice generation, or legacy metadata such as `Execution-Scope`, `Authoring-Intent`, and `Parent-Plan-ID`.
- Do not move platform-specific agent instructions into canonical governance docs unless they are truly cross-provider policy.
