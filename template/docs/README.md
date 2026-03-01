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
- Product state: `docs/product-specs/current-state.md`
- Plan workflow: `docs/PLANS.md`
- Ops automation: `docs/ops/automation/README.md`
- Role orchestration: `docs/ops/automation/ROLE_ORCHESTRATION.md`
- Lite quickstart: `docs/ops/automation/LITE_QUICKSTART.md`
- Outcomes scorecard: `docs/ops/automation/OUTCOMES.md`
- GitHub interop mapping: `docs/ops/automation/INTEROP_GITHUB.md`
- Provider compatibility: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`
- Runtime context snapshot: `docs/generated/agent-runtime-context.md`

## Layering Model

- `AGENTS.md`: map and constraints.
- `README.md`: product summary and navigation entrypoint.
- `ARCHITECTURE.md` + `docs/architecture/*`: architecture truth and dependency rules.
- `docs/agent-hardening/*`: mandatory agent eval/observability/tool/memory policy.
- `docs/FRONTEND.md` and `docs/BACKEND.md`: implementation-side standards by runtime surface.

## Authoring Rules

- Keep docs concise, canonical, and linked from `AGENTS.md`/`README.md`/`docs/index.md`.
- Update docs in the same change as behavior or boundary changes.
- Prefer canonical docs over ad-hoc notes.
