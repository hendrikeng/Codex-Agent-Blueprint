# {{PRODUCT}}

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document delegates to linked canonical docs.
Current State Date: 2026-02-27

{{SUMMARY}}

## Operating Model

- Docs-first minimal: repository-local docs are the system of record.
- `AGENTS.md` is the concise map for humans and agents.
- Humans define priorities and constraints; agents execute scoped changes.
- Documentation and verification checks are required before merge.

## Documentation Navigation

Start with:
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/index.md`
- `docs/README.md`
- `docs/PLANS.md`
- `docs/governance/README.md`
- `docs/product-specs/index.md`
- `docs/product-specs/current-state.md`
- `docs/exec-plans/README.md`

## Platform Scope Snapshot

- {{SCOPE1}}
- {{SCOPE2}}
- {{SCOPE3}}
- Detailed current behavior is tracked in `docs/product-specs/current-state.md`.

## Architecture At A Glance

- Frontend: Next.js App Router + React + Tailwind + shared UI primitives
- Backend: NestJS + Prisma
- Shared contracts/primitives are canonical across apps/packages
- Verification gates are required in CI

## Enforcement and Quality Gates

- Docs verification: `npm run docs:verify`
- Conformance scope guardrail: `npm run conformance:verify`
- Architecture boundary checks: `npm run architecture:verify`

## Change Discipline

Changes affecting architecture, lifecycle behavior, money/tax logic,
tenant boundaries, RBAC, or user-visible behavior must update docs in the same change.
