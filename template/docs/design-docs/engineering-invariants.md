# Engineering Invariants

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Core Invariants

- Server-side authority for sensitive state.
- Tenant isolation and RBAC enforcement.
- No float money math.
- UTC persistence for timestamps.

## Documentation Discipline

- Canonical docs must reflect real behavior.
- Behavior changes must update docs in the same change.
- Avoid parallel policy sources.
