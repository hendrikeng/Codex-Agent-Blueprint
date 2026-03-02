# Memory and Context Policy

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Context Budget Rules

- Prioritize active task requirements and recent authoritative state.
- Default to task-scoped contact packs per role session; expand beyond the pack only for explicit blockers.
- Trim low-value context before truncating policy or invariants.
- Keep prompts deterministic for critical workflows.

## Persistence Rules

- Persist only data required for continuity, audit, or user intent.
- Do not persist secrets, credentials, or transient sensitive payloads.
- Define expiration and deletion behavior for persisted memory.

## Provenance and Redaction

- Record provenance for retrieved memory/context used in decisions.
- Prefer canonical local docs over ad-hoc memory for policy decisions.
- Redact sensitive fields in stored memory and retrieval logs.
