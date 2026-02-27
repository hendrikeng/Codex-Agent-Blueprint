# Governance Rules

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Core Rules

- Canonical docs are source-of-truth for behavior and constraints.
- Correctness over speed for sensitive domains.
- Shared contracts/primitives are canonical.
- Server-side authority for money, lifecycle, auth, and tenant scope.
- No fabricated production behavior paths.
- Keep architecture boundaries enforceable.
- Keep security and data-safety controls explicit.
- Docs are part of done.

## Validation Gates

- `npm run docs:verify`
- `npm run conformance:verify`
- `npm run architecture:verify`
- Relevant domain tests for changed behavior
