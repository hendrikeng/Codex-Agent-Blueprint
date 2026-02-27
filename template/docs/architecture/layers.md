# Architecture Layers

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Layer Order

1. Types
2. Config
3. Repo
4. Service
5. Runtime
6. UI

## Dependency Direction

- Higher layers can depend on lower layers.
- Lower layers cannot depend on higher layers.
- Shared contracts/types form stable boundaries.
