# Reliability

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Reliability Goals

- Deterministic state transitions for domain-critical workflows.
- Idempotent processing for webhooks/inbound events.
- Graceful failure behavior with explicit retries where appropriate.

## Critical Flows

- Auth/tenant scope checks.
- Domain lifecycle transitions.
- Money/tax side effects and reversals.

## Reliability Controls

- Transaction boundaries around critical mutations.
- Idempotency keys and deduplication on external callbacks.
- Monitoring and alerting for failure spikes.

## Validation Baseline

- `npm run docs:verify`
- `npm run architecture:verify`
- Focused tests for critical reliability-sensitive paths.
