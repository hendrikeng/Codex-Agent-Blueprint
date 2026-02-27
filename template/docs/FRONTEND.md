# Frontend

Status: canonical
Owner: Frontend Engineering
Last Updated: 2026-02-27
Source of Truth: This document.

## Frontend Stack

- Next.js App Router + React + Tailwind
- Shared UI primitives/components are canonical
- Shared contracts/types are consumed from workspace packages

## UI Rules

- Do not fork shared primitives unless approved by design/system policy.
- Keep domain state transitions explicit in UI behavior.
- Match server-side authority assumptions in UX.

## Data-Wiring Rules

- Use typed contract boundaries between UI and API.
- Avoid client-side authority for sensitive state.
- Handle loading/error/retry paths explicitly.

## Current Workspace Entry Points

- App-specific routes and views live under app workspaces.
- Shared UI/domain utilities live in shared packages.
