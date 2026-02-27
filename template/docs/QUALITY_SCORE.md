# Quality Score

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Scoring Legend

- 5: strong and continuously enforced
- 4: implemented with minor gaps
- 3: baseline exists but needs hardening
- 2: partial or inconsistent
- 1: missing or largely manual

## Domain Scores

- Domain correctness and invariants: 4
- Money/tax safety and auditability: 4
- Tenant scope and RBAC enforcement: 4

## Platform Scores

- Architecture boundary enforcement: 4
- Documentation governance enforcement: 4
- Test coverage for critical flows: 3

## Current Gaps

- Improve critical-flow regression coverage.
- Reduce unreachable-doc warnings by tightening doc graph linking.
