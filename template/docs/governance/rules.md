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
- Keep agent hardening policy canonical from bootstrap.
- Keep security and data-safety controls explicit.
- Docs are part of done.
- Canonical docs must remain environment-agnostic: no personal machine paths, hostnames, credentials, or private runbooks.
- `docs/governance/policy-manifest.json` is the machine-readable policy source for runtime context compilation.

## Verification Profiles

- Fast iteration profile: `npm run verify:fast`
  - Scope-aware checks + mandatory safety checks.
- Full merge profile: `npm run verify:full`
  - `node ./scripts/automation/compile-runtime-context.mjs`
  - `node ./scripts/docs/check-governance.mjs`
  - `node ./scripts/check-article-conformance.mjs`
  - `node ./scripts/architecture/check-dependencies.mjs`
  - `node ./scripts/agent-hardening/check-agent-hardening.mjs`
  - `node ./scripts/agent-hardening/check-evals.mjs`
  - `node ./scripts/automation/check-harness-alignment.mjs`
  - `node ./scripts/automation/check-plan-metadata.mjs`
- Relevant domain tests remain required for changed behavior.
