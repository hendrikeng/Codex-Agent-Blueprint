# Architecture Layers

Status: canonical
Owner: Platform Engineering
Last Updated: 2026-02-27
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
