# Generated Docs

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This directory.

Generated artifacts are rebuildable outputs derived from canonical docs, policy checks, or measured runs. They are navigationally important, but they are not the primary hand-maintained source of truth.

## Core Generated Artifacts

- `docs/generated/AGENT-RUNTIME-CONTEXT.md`: compact runtime policy snapshot compiled for orchestrated role sessions.
- `docs/generated/run-outcomes.json`: aggregated run telemetry, continuity metrics, and outcome scorecard.
- `docs/generated/perf-comparison.json`: before/after performance comparison output when perf baselines are captured.
- `docs/generated/github-agent-export.json`: exported GitHub-agent scaffold metadata and sync report.
- `docs/generated/article-conformance.json`: conformance summary derived from the repo's article/check rules.
- `docs/generated/evals-report.json`: agent-hardening evaluation summary.
- `docs/generated/continuity-evals-report.json`: continuity-specific hardening evaluation summary.

## Optional Repo-Local Generated Artifacts

- Schema reference snapshot: optional repo-local generated output when a repo exports database schema docs from its canonical schema source.

## Rules

- Regenerate artifacts from canonical policy, schema, or telemetry sources instead of hand-editing generated outputs.
- If a generated artifact becomes a routine entrypoint, surface it from `docs/MANIFEST.md` or `docs/README.md`.
- Remove generated artifacts that are no longer produced by any documented contract or script.
