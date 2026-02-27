# Architecture Overview

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document and `docs/architecture/`.

## Read Order

1. `docs/architecture/README.md`
2. `docs/architecture/layers.md`
3. `docs/architecture/dependency-rules.md`
4. `docs/governance/architecture-rules.json`

## Core Invariants

- Dependency flow must remain directional and enforceable.
- Shared contracts/types are canonical interfaces.
- Money/auth/inventory/lifecycle authority remains server-side.
- Tenant boundaries and RBAC are enforced server-side.

## Verification

- Run `npm run architecture:verify`.
- Run `npm run docs:verify` when architecture docs or boundaries change.
- Keep `docs/governance/architecture-rules.json` aligned with actual module policy.
