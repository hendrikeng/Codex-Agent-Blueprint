# Security

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Security Model

- Default-deny server-side authorization.
- Tenant isolation as a mandatory constraint.
- Least-privilege access for privileged operations.

## Identity and Scope

- Use shared auth/session modules as source of truth.
- Enforce tenant scope server-side on tenant-owned entities.
- Keep sensitive actions auditable.

## Data Safety Requirements

- Treat inbound integration payloads as untrusted.
- Validate and sanitize external input.
- Avoid secrets in source-controlled docs/code.

## Security Testing Expectations

- Regression tests for auth and RBAC boundaries.
- Validation tests around tenant isolation.
- Security-sensitive workflow tests in CI.
