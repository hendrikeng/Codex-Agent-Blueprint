# UI README

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Scope

- `docs/ui/` captures canonical user-visible interaction contracts.
- Keep this folder for UI behavior that is more specific than product specs and more stable than implementation notes.
- Do not duplicate visual system rules from `docs/design-docs/UI-STANDARDS.md` or runtime implementation details from `docs/FRONTEND.md`.

## Current Inventory

- `docs/ui/INTENTS.md`: canonical interaction-intent and UI event vocabulary.

## When To Add More Here

- Add route or flow contracts when user-visible behavior spans multiple screens.
- Add state contracts when loading, empty, validation, retry, or error semantics must stay stable.
- Add user-visible copy or prompt contracts only when they are part of the product behavior contract.
- If a repo only needs `intents.md` today, that is valid; the folder still remains the canonical UI contract surface.
