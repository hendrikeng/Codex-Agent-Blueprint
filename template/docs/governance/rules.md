# Governance Rules

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Core Rules

- Canonical docs are source-of-truth for behavior and constraints.
- Correctness over speed for sensitive domains.
- Shared contracts/primitives are canonical.
- Server-side authority for critical invariants.
- No fabricated production behavior paths.
- Keep architecture boundaries enforceable.
- Keep security and data-safety controls explicit.
- Docs are part of done.
- Canonical docs must remain environment-agnostic: no personal machine paths, hostnames, credentials, or private runbooks.

## Validation Gates

- `npm run docs:verify`
- `npm run conformance:verify`
- `npm run architecture:verify`
- Relevant domain tests for changed behavior
