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
- Use a four-layer memory model:
  - active working context: runtime policy, current task scope, latest state snapshot, and the last one or two checkpoints
  - session summary: the latest durable continuity snapshot for the plan
  - episodic memory: append-only checkpoint records for prior sessions/subtasks
  - external artifacts: source files, plan docs, evidence indexes, logs, and validation output
- Treat logs and large tool output as external by default. Promote only distilled findings and stable pointers into active context.
- Separate reasoning state from evidence state in durable memory:
  - reasoning: current subtask, next action, blockers, rationale
  - evidence: accepted facts, artifact references, extracted findings, validation/log references
- Keep retrieval selective. Load only the latest state, the most recent checkpoint slice, and artifact references relevant to the current role/stage.

## Persistence Rules

- Persist only data required for continuity, audit, or user intent.
- Do not persist secrets, credentials, or transient sensitive payloads.
- Define expiration and deletion behavior for persisted memory.
- Persist continuity as repo-local runtime artifacts:
  - `latest.json` for machine-readable current state
  - `checkpoints.jsonl` for append-only episodic memory
  - structured JSON handoff packets plus operator-facing markdown handoff notes
- Checkpoint at every session end, every stage completion, every `pending` or `handoff_required`, and immediately before validation handoff.
- Summaries are replaceable, not sacred. Durable state must stay small, versioned, and reconstructable from checkpoints plus external artifacts.

## Retrieval Escalation Rule

### Default Rule

- Use repo-local continuity as the default architecture for long work: structured state, checkpoints, explicit handoffs, selective contact packs, externalized logs/evidence, and resumable orchestration.
- This design is intended to protect low-context work, safe handoff, nothing important getting lost, and reliable grind/resume without moving important memory outside the repo.

### Do Not Change It Yet

- Keep this design while all important information already lives in the repo.
- Keep this design while plans, evidence, docs, and code remain the source of truth.
- Keep this design while agents can resume from checkpoints and contact packs without losing important context.
- Keep this design while grind runs are not repeatedly missing important information.
- Keep this design while no agent needs memory from Slack, Jira, other repos, or other external systems.

### Consider External Retrieval Later

- agents repeatedly miss important context even though it exists
- repo-local checkpoints/contact packs stop being enough
- important memory starts living outside the repo
- you need one agent to search across many unrelated systems
- you can point to repeated failures, not just a vague worry

### Prefer Tuning Before Re-Architecture

- better checkpoint contents
- better contact-pack selection
- better evidence compaction
- better validation and observability

## Provenance and Redaction

- Record provenance for retrieved memory/context used in decisions.
- Prefer canonical local docs over ad-hoc memory for policy decisions.
- Redact sensitive fields in stored memory and retrieval logs.
- Retain exact anchors in durable state when they matter for resumption: file paths, plan IDs, run IDs, session log paths, evidence index paths, validation references, and concrete blockers.
