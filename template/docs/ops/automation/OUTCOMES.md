# Automation Outcomes

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: This document.

## Purpose

Keep automation value measurable with a compact, repeatable scorecard.
Use this to demonstrate that orchestration reduces blast radius and debugging overhead.

## Data Sources

- `docs/ops/automation/run-events.jsonl`
- `docs/generated/perf-comparison.json`
- `docs/exec-plans/evidence-index/*.md`
- `docs/generated/run-outcomes.json`

## Scorecard Metrics

- Time to first worker edit:
  - Definition: plan start to first worker session that touches repository files.
  - Output: mean/median seconds (`summary.speed.timeToFirstWorkerEditSeconds`).
- Stage duration by role:
  - Definition: per-session execution duration from `session_finished` events grouped by role.
  - Output: sample size + mean/median for planner/explorer/worker/reviewer (`summary.speed.stageDurationsSeconds`).
- Lead time:
  - Definition: first plan event timestamp to terminal plan event timestamp.
  - Output: mean/median lead time seconds across plans.
- Validation reliability:
  - Definition: counts of passed/failed host and always validation events.
  - Output: pass/fail totals and failure rate.
- Evidence compactness:
  - Definition: number of evidence lifecycle/compaction events per run.
  - Output: curated vs noisy evidence trend.
- Rework loops:
  - Definition: count rollover/handoff and repeated non-terminal sessions.
  - Output: handoff totals, handoffs-per-plan distribution, and worker no-touch retry count.

## Report Workflow

1. Run automation (`automation:run` or `automation:run:parallel`).
2. Generate scorecard JSON: `npm run outcomes:report`.
3. Inspect `docs/generated/run-outcomes.json`.
4. Reference key numbers in plan closure notes or release notes.

## Interpretation Guide

- Good signal:
  - Time-to-first-edit medians trend down for similar risk tiers.
  - Planner/explorer/reviewer stage durations stay within expected budget envelopes.
  - Stable lead times for similar risk tiers.
  - Validation failures trend down over time.
  - Evidence compaction keeps references concise.
- Investigation signal:
  - Time-to-first-edit spikes without corresponding risk increase.
  - Long planner/explorer/reviewer sessions with zero touched files.
  - Spiking handoff/rework counts.
  - Repeated validation failures on same plan group.
  - High event volume with low completion throughput.

## Notes

- This scorecard is intentionally lightweight.
- It is an operational summary, not a replacement for domain-level KPIs.
