# Governance README

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Canonical Governance Docs

- `docs/governance/rules.md`
- `docs/governance/golden-principles.md`
- `docs/governance/policy-manifest.json`
- `docs/governance/policy-manifest.schema.json`
- `docs/governance/doc-checks.config.json`
- `docs/governance/architecture-rules.json`

## Verification

- Fast profile: `npm run verify:fast`
- Full profile: `npm run verify:full`
- Performance evidence: `npm run perf:baseline` and `npm run perf:after`
- Run outcomes summary (optional): `npm run outcomes:report`
- GitHub interop export scaffold (optional): `npm run interop:github:export`
- GitHub interop export write mode (optional): `npm run interop:github:export:write`

## Operational References

- Lite onboarding: `docs/ops/automation/LITE_QUICKSTART.md`
- Provider compatibility: `docs/ops/automation/PROVIDER_COMPATIBILITY.md`
