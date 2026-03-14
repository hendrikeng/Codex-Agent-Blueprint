# Architecture Overview

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document and `docs/architecture/`.

## Read Order

1. `docs/architecture/README.md`
2. `docs/architecture/TOPOLOGY.md`
3. `docs/architecture/LAYERS.md`
4. `docs/architecture/DEPENDENCY-RULES.md`
5. `docs/governance/architecture-rules.json`
6. `docs/agent-hardening/OBSERVABILITY.md`
7. `docs/agent-hardening/TOOL_POLICY.md`

## Core Invariants

- Dependency flow must remain directional and enforceable.
- Shared contracts/types are canonical interfaces.
- Sensitive-domain authority remains server-side for `{{SERVER_AUTHORITY_BOUNDARY_SET}}`.
- Runtime surfaces and transitional entrypoints must stay explicit in `docs/architecture/TOPOLOGY.md`.
- Architecture rules must map to actual module tags and import behavior.
- Agent runs must preserve explicit observability and tool-approval boundaries.

## Verification

- During implementation loops, run `npm run verify:fast`.
- Before merge, run `npm run verify:full`.
- For architecture-only focused checks, run `npm run architecture:verify`.
- Keep `docs/governance/architecture-rules.json` aligned with actual module policy.
