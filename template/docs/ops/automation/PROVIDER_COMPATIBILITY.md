# Provider Compatibility

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Define the minimum provider CLI contract required by the automation conveyor.
Keep this file current when changing provider commands, flags, or output behavior.

## Supported Providers

- Codex CLI (provider key: `codex`)
- Claude Code CLI (provider key: `claude`)

## Required Execution Contract

Every provider command must support:

- Non-interactive invocation suitable for orchestration runs.
- Prompt injection via `{prompt}` placeholder.
- Role model selection via `{role_model}` placeholder.
- Command exit status propagation.
- Structured result payload written by executor wrapper to `ORCH_RESULT_PATH`.

## Baseline Command Templates

- Codex: `codex exec --full-auto -c model_reasoning_effort={role_reasoning_effort} -m {role_model} {prompt}`
- Claude: `claude -p --model {role_model} {prompt}`

These are baseline templates, not universal guarantees across all versions.

## Compatibility Notes

- If a provider CLI version removes or changes required flags, update:
  - `docs/ops/automation/orchestrator.config.json`
  - this document
  - any exported interop scaffolds
- Prefer explicit pinning in project setup docs when reproducibility matters.

## Structured Payload Guarantee

The orchestrator relies on the executor wrapper to enforce structured output:

- Required payload fields: `status`, `summary`, `reason`, `contextRemaining`
- Payload path: `ORCH_RESULT_PATH`
- Allowed status values: `completed`, `blocked`, `handoff_required`, `pending`

If payload is missing or invalid, orchestration treats the session as incomplete and forces safe continuation behavior.

## GitHub Interop Caveat

GitHub custom agent profiles (`.agent.md`) are exported as scaffolds.
Some profile properties may behave differently between GitHub.com and IDE integrations.
Treat exported profiles as starting points, not canonical policy.

## Verification Checklist

When updating provider commands:

1. Run `npm run verify:fast`.
2. Run `npm run verify:full`.
3. Run `npm run interop:github:export -- --dry-run true`.
4. Confirm role placeholders remain present (`{prompt}`, `{role_model}`, `{role_reasoning_effort}` for Codex).
