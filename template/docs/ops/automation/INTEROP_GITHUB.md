# GitHub Interop Mapping

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Define a stable bridge from blueprint policy/orchestration contracts to GitHub-native agent profile scaffolds.
This keeps the blueprint provider-agnostic while making platform-native adoption easier.

## Inputs

- `AGENTS.md`
- `docs/governance/policy-manifest.json`
- `docs/ops/automation/orchestrator.config.json`

## Mapped Concepts

- Safety policy:
  - Source: `policy-manifest.mandatorySafetyRules`
  - Export: baseline policy profile.
- Role profiles:
  - Source: `orchestrator.config.roleOrchestration.roleProfiles`
  - Export: role capability profile per stage (`planner`, `explorer`, `worker`, `reviewer`).
- Risk routing:
  - Source: `orchestrator.config.roleOrchestration.pipelines`
  - Export: lane routing map (`low`, `medium`, `high`).
- Validation lanes:
  - Source: `orchestrator.config.validation`
  - Export: always/host-required checks metadata.
- Canonical entrypoints:
  - Source: `policy-manifest.docContract.canonicalEntryPoints`
  - Export: docs entrypoint hints.

## Export Contract

- Command: `npm run interop:github:export`
- Convenience write mode: `npm run interop:github:export:write`
- Default mode: dry run (no `.github/agents/` files written).
- Report output: `docs/generated/github-agent-export.json`
- Optional file emission: pass `--write-profiles true` to write scaffolds under `.github/agents/`.

## Scaffold Files

When write mode is enabled, exporter writes:

- `.github/agents/blueprint-default.agent.md`
- `.github/agents/blueprint-planner.agent.md`
- `.github/agents/blueprint-explorer.agent.md`
- `.github/agents/blueprint-worker.agent.md`
- `.github/agents/blueprint-reviewer.agent.md`
- `.github/agents/README.md`
- `.github/agents/base-policy.json`
- `.github/agents/role-profiles.json`
- `.github/agents/risk-pipelines.json`

`.agent.md` files are YAML-frontmatter markdown scaffolds intended for GitHub custom-agent workflows.
All exported files may require project-specific adjustments.

## Platform Caveats

- GitHub.com and IDE integrations may support different profile/frontmatter capabilities.
- Model and handoff behavior can differ by surface/version.
- Treat exported profiles as scaffolds; canonical policy remains in `docs/governance/*`.

## Non-Goals

- Enforcing a single platform-specific schema in governance checks.
- Replacing canonical blueprint policy docs.
- Auto-enabling orchestration features not explicitly configured.
