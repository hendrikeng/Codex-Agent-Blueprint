# Agent Hardening

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document and linked docs in this folder.

## Why This Exists

- Agent quality and safety requirements must be explicit and shared.
- Hardening policy is canonical from repository bootstrap.
- This folder defines stack-agnostic contracts for evals, observability, tool use, and memory/context behavior.

## Canonical Documents

- `docs/agent-hardening/EVALS.md`
- `docs/agent-hardening/evals.config.json`
- `docs/agent-hardening/continuity-fixtures.json`
- `docs/agent-hardening/OBSERVABILITY.md`
- `docs/agent-hardening/TOOL_POLICY.md`
- `docs/agent-hardening/MEMORY_CONTEXT.md`
- `docs/generated/evals-report.json`
- `docs/generated/continuity-evals-report.json`

## Enforcement

- Targeted policy checks: `npm run agent:verify` and `npm run eval:verify`
- Continuity fixture runner: `npm run eval:continuity`
- Real-run continuity scorecard: `npm run outcomes:report` and `npm run outcomes:verify`
- Iteration profile: `npm run verify:fast`
- Merge profile: `npm run verify:full`

`agent:verify` and `eval:verify` are required and must pass before merge.
`eval:verify` gates template/local eval health, while `outcomes:verify` gates continuity thresholds from real automation runs such as derived continuity, resume-safe checkpoints, thin contact packs, and repeated handoff loops.
