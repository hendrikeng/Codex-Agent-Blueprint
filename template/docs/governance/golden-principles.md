# Golden Principles

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Principles

- Correctness over speed.
- Explicit domain invariants over implied behavior.
- Shared contracts and primitives over divergence.
- Security and tenant isolation by default.
- Mechanical checks over manual interpretation.

## Mechanical Enforcement Map

- Docs governance: `npm run docs:verify`
- Scope/conformance guardrail: `npm run conformance:verify`
- Architecture constraints: `npm run architecture:verify`
