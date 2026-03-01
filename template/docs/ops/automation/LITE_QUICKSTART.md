# Lite Quickstart

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Start with the lowest-overhead lane while keeping correctness protections.
Use this as the default onboarding path for individuals and small teams.

## When To Use Lite

Use Lite when:

- Work is low-risk and scoped to one focused slice.
- You want fast manual iteration without orchestration overhead.
- You still want plan metadata, docs discipline, and verification gates.

## 5-Step Loop

1. Create/update an active plan in `docs/exec-plans/active/`.
2. Implement the smallest safe slice.
3. Run `npm run verify:fast` during iteration.
4. Run `npm run verify:full` before completion/merge.
5. Move plan to `completed/` with canonical `Done-Evidence` references.

## Required Commands

- `npm run context:compile`
- `npm run verify:fast`
- `npm run verify:full`

Optional reporting:

- `npm run outcomes:report`
- `npm run interop:github:export -- --dry-run true`

## Upgrade Path

Move from Lite to Guarded/Conveyor only when needed:

- Cross-domain or high-risk changes.
- Multi-plan dependency chains.
- Repeatable batch execution where parallelism materially helps.

The goal is progressive structure, not mandatory orchestration.
