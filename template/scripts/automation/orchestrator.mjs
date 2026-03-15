#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { compileTaskContactPack } from './compile-task-contact-pack.mjs';
import {
  ACTIVE_STATUSES,
  CAPABILITY_PROOF_MAP_SECTION,
  collectUnfinishedCoverageRows,
  isValidPlanId,
  listMarkdownFiles,
  metadataValue,
  normalizeStatus,
  parseCapabilityProofMap,
  parseDeliveryClass,
  parseExecutionScope,
  parseMustLandChecklist,
  parsePlanId,
  parseRiskTier,
  parseSecurityApproval,
  parseListField,
  parseMetadata,
  PROOF_TYPES,
  parsePriority,
  priorityOrder,
  setMetadataFields,
  todayIsoDate,
  inferPlanId
} from './lib/plan-metadata.mjs';
import {
  disallowedWorkerTouchedPaths,
  implementationTargetRoots,
  isTransientAutomationPath,
  normalizeTouchedPathList,
  pathMatchesRootPrefix
} from './lib/plan-scope.mjs';
import {
  appendToDeliveryLog,
  completionGateReadyForValidation,
  documentStatusValue,
  documentValidationReadyValue,
  evaluateCompletionGate,
  maybeAutoPromoteCompletionGate,
  removeDuplicateSections,
  removeSection,
  sectionBody,
  sectionBounds,
  sectionlessPreamble,
  setHostValidationSection,
  setPlanDocumentFields,
  setPlanStatus,
  setResidualValidationBlockersSection,
  updateSimpleMetadataField,
  upsertSection
} from './lib/plan-document-state.mjs';
import {
  buildWorkerTouchPolicy,
  disallowedTouchedPathsForRole,
  formatTouchSummaryDetails,
  formatTouchSummaryInline,
  hasMeaningfulWorkerTouchSummary,
  summarizeTouchedPaths
} from './lib/session-policy.mjs';
import {
  createAtomicCommit,
  dirtyImplementationTouchPaths,
  dirtyRepoPaths,
  gitAvailable,
  gitDirty,
  hasRecordedImplementationEvidence,
  implementationEvidencePaths,
  isArtifactSlicePlan,
  isProductPlan,
  isProgramPlan,
  parseGitPorcelainZPaths,
  planRequiresImplementationEvidence,
  recordImplementationEvidence,
  resolveAtomicCommitRoots,
  stagedRepoPaths,
  evaluateAtomicCommitReadiness
} from './lib/atomic-commit-policy.mjs';
import {
  classifyValidationFailureScope,
  createValidationCompletionOps
} from './lib/validation-completion.mjs';

const DEFAULT_CONTEXT_THRESHOLD = 10000;
const DEFAULT_CONTEXT_SOFT_USED_RATIO = 0.65;
const DEFAULT_CONTEXT_HARD_USED_RATIO = 0.8;
const DEFAULT_HANDOFF_TOKEN_BUDGET = 1500;
const DEFAULT_MAX_ROLLOVERS = 20;
const DEFAULT_MAX_SESSIONS_PER_PLAN = 12;
const DEFAULT_HANDOFF_EXIT_CODE = 75;
const DEFAULT_REQUIRE_RESULT_PAYLOAD = true;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 1800;
const DEFAULT_RUNTIME_CONTEXT_PATH = 'docs/generated/AGENT-RUNTIME-CONTEXT.md';
const DEFAULT_HOST_VALIDATION_MODE = 'hybrid';
const DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS = 1800;
const DEFAULT_HOST_VALIDATION_POLL_SECONDS = 15;
const DEFAULT_OUTPUT_MODE = 'pretty';
const DEFAULT_FAILURE_TAIL_LINES = 60;
const PRETTY_SPINNER_FRAMES = ['|', '/', '-', '\\'];
const PRETTY_LIVE_DOT_FRAMES = ['...', '.. ', '.  ', ' ..'];
const DEFAULT_HEARTBEAT_SECONDS = 120;
const DEFAULT_STALL_WARN_SECONDS = 120;
const DEFAULT_TOUCH_SUMMARY = true;
const DEFAULT_TOUCH_SAMPLE_SIZE = 3;
const DEFAULT_TOUCH_SCAN_MODE = 'adaptive';
const DEFAULT_TOUCH_SCAN_MIN_HEARTBEATS = 1;
const DEFAULT_TOUCH_SCAN_MAX_HEARTBEATS = 8;
const DEFAULT_TOUCH_SCAN_BACKOFF_UNCHANGED = 2;
const DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS = 180;
const DEFAULT_WORKER_RETRY_FIRST_TOUCH_DEADLINE_SECONDS = DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS;
const DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT = 1;
const DEFAULT_WORKER_PENDING_STREAK_LIMIT = 4;
const DEFAULT_READ_ONLY_PENDING_STREAK_LIMIT = 1;
const DEFAULT_WORKER_STALL_FAIL_SECONDS = 900;
const DEFAULT_LIVE_ACTIVITY_MODE = 'best-effort';
const DEFAULT_LIVE_ACTIVITY_MAX_CHARS = 0;
const DEFAULT_LIVE_ACTIVITY_SAMPLE_SECONDS = 2;
const DEFAULT_LIVE_ACTIVITY_EMIT_EVENT_LINES = false;
const DEFAULT_LIVE_ACTIVITY_REDACT_PATTERNS = [
  '(token|secret|password|passphrase|api[-_]?key|authorization|cookie|session)\\s*[:=]\\s*\\S+',
  'ghp_[A-Za-z0-9]+',
  'sk-[A-Za-z0-9]+'
];
const LIVE_ACTIVITY_PROVIDER_NAME_TOKENS = new Set(['codex', 'claude']);
const LIVE_ACTIVITY_JSON_TYPE_HINTS = [
  'status',
  'progress',
  'reasoning',
  'thinking',
  'task',
  'step',
  'tool',
  'action',
  'activity'
];
const LIVE_ACTIVITY_JSON_TYPE_DENY = [
  'output_text',
  'final',
  'result',
  'usage',
  'token',
  'metrics'
];
const LIVE_ACTIVITY_GENERIC_TOKENS = new Set([
  'in_progress',
  'in-progress',
  'progress',
  'pending',
  'started',
  'starting',
  'running',
  'completed',
  'complete',
  'ok',
  'done'
]);
const DEFAULT_CONTACT_PACKS_ENABLED = true;
const DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS = 10;
const DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE = true;
const DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS = 6;
const DEFAULT_CONTACT_PACKS_INCLUDE_LATEST_STATE = true;
const DEFAULT_CONTACT_PACKS_MAX_RECENT_CHECKPOINT_ITEMS = 2;
const DEFAULT_CONTACT_PACKS_MAX_STATE_LIST_ITEMS = 6;
const DEFAULT_CONTINUITY_MIN_COMPLETED_SCORE = 0.8;
const DEFAULT_CONTINUITY_MAX_DERIVED_RATE = 0.1;
const DEFAULT_CONTINUITY_MIN_RESUME_SAFE_RATE = 0.95;
const DEFAULT_CONTINUITY_MAX_THIN_PACK_RATE = 0.1;
const DEFAULT_CONTINUITY_MAX_REPEATED_HANDOFF_LOOP_PLANS = 0;
const DEFAULT_RETRY_FAILED_PLANS = true;
const DEFAULT_AUTO_UNBLOCK_PLANS = true;
const DEFAULT_MAX_FAILED_RETRIES = 2;
const DEFAULT_PARALLEL_PLANS = 1;
const DEFAULT_PARALLEL_WORKTREE_ROOT = 'docs/ops/automation/runtime/worktrees';
const DEFAULT_PARALLEL_BRANCH_PREFIX = 'orch';
const DEFAULT_PARALLEL_BASE_REF = 'CURRENT_BRANCH';
const DEFAULT_PARALLEL_GIT_REMOTE = 'origin';
const DEFAULT_PARALLEL_WORKER_OUTPUT = 'minimal';
const DEFAULT_PARALLEL_KEEP_WORKTREES = false;
const DEFAULT_PARALLEL_PUSH_BRANCHES = false;
const DEFAULT_PARALLEL_OPEN_PULL_REQUESTS = false;
const DEFAULT_PARALLEL_ASSUME_DEPENDENCY_COMPLETION = false;
let prettySpinnerIndex = 0;
let prettyLiveDotIndex = 0;
let liveStatusLineLength = 0;
const DEFAULT_EVIDENCE_MAX_REFERENCES = 25;
const DEFAULT_EVIDENCE_TRACK_MODE = 'curated';
const MUST_LAND_SECTION = 'Must-Land Checklist';
const DEFAULT_EVIDENCE_DEDUP_MODE = 'strict-upsert';
const DEFAULT_EVIDENCE_PRUNE_ON_COMPLETE = true;
const DEFAULT_EVIDENCE_KEEP_MAX_PER_BLOCKER = 1;
const DEFAULT_EVIDENCE_SESSION_CURATION_MODE = 'on-change';
const DEFAULT_EVIDENCE_SESSION_INDEX_REFRESH_MODE = 'on-change';
const DEFAULT_CONTACT_PACK_CACHE_MODE = 'run-memory';
const DEFAULT_SEMANTIC_PROOF_MODE = 'advisory';
const DEFAULT_ROLE_ORCHESTRATION_ENABLED = true;
const DEFAULT_RISK_THRESHOLD_MEDIUM = 3;
const DEFAULT_RISK_THRESHOLD_HIGH = 6;
const DEFAULT_RISK_WEIGHT_DECLARED_MEDIUM = 2;
const DEFAULT_RISK_WEIGHT_DECLARED_HIGH = 4;
const DEFAULT_RISK_WEIGHT_DEPENDENCY = 1;
const DEFAULT_RISK_WEIGHT_SENSITIVE_TAG = 2;
const DEFAULT_RISK_WEIGHT_SENSITIVE_PATH = 2;
const DEFAULT_RISK_WEIGHT_AUTONOMY_FULL = 1;
const DEFAULT_RISK_WEIGHT_VALIDATION_FAILURE = 2;
const DEFAULT_STAGE_REUSE_ENABLED = true;
const DEFAULT_STAGE_REUSE_SAME_RUN_ONLY = false;
const DEFAULT_STAGE_REUSE_REQUIRES_STABLE_PLAN_HASH = true;
const DEFAULT_STAGE_REUSE_REQUIRES_NO_SCOPE_CHANGE = true;
const DEFAULT_STAGE_REUSE_MAX_AGE_MINUTES = 60;
const DEFAULT_STAGE_BUDGET_PLANNER_SECONDS = 300;
const DEFAULT_STAGE_BUDGET_EXPLORER_SECONDS = 300;
const DEFAULT_STAGE_BUDGET_REVIEWER_SECONDS = 420;
const ROLE_PLANNER = 'planner';
const ROLE_EXPLORER = 'explorer';
const ROLE_WORKER = 'worker';
const ROLE_REVIEWER = 'reviewer';
const ROLE_NAMES = new Set([ROLE_PLANNER, ROLE_EXPLORER, ROLE_WORKER, ROLE_REVIEWER]);
const REASONING_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh']);
const SECURITY_APPROVAL_NOT_REQUIRED = 'not-required';
const SECURITY_APPROVAL_PENDING = 'pending';
const SECURITY_APPROVAL_APPROVED = 'approved';
const RISK_TIER_ORDER = {
  low: 0,
  medium: 1,
  high: 2
};
const EVIDENCE_NOISE_TOKENS = new Set([
  'after',
  'additional',
  'attempt',
  'continuation',
  'current',
  'follow',
  'following',
  'final',
  'further',
  'latest',
  'next',
  'post',
  'progress',
  'refresh',
  'rerun',
  'retry',
  'step',
  'up'
]);
const SAFE_PLAN_RELATIVE_PATH_REGEX = /^[A-Za-z0-9._/-]+$/;
const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_REGEX = /(token|secret|password|passphrase|api[-_]?key|authorization|cookie|session)/i;
const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const RUN_MEMORY_PLAN_RECORD_CACHE = new Map();
const RUN_MEMORY_CONTACT_PACK_CACHE = new Map();
const ROLLING_CONTEXT_SCHEMA_VERSION = 2;
const validationCompletionOps = createValidationCompletionOps({
  SECURITY_APPROVAL_APPROVED,
  SECURITY_APPROVAL_NOT_REQUIRED,
  SECURITY_APPROVAL_PENDING,
  clearPlanContinuationState,
  createAtomicCommit,
  createTouchBaseline,
  curateEvidenceForPlan,
  didTimeout,
  evaluateAtomicCommitReadiness,
  executionOutput,
  isTickerOutput,
  logEvent,
  pathMatchesRootPrefix,
  persistSecurityApproval,
  progressLog,
  refreshEvidenceIndex,
  requiresSecurityApproval,
  resolveAtomicCommitRoots,
  resolveCompletedPlanTargetPath,
  resolveEvidenceLifecycleConfig,
  resolvedSecurityApproval,
  rewritePlanFileReferencesInPlanDocs,
  runShellMonitored,
  setHostValidationSection,
  setPlanStatus,
  setResidualValidationBlockersSection,
  shouldCaptureCommandOutput,
  tailLines,
  updatePlanValidationState,
  writeEvidenceIndex,
  writeSessionExecutorLog
});

function usage() {
  console.log(`Usage:
  node ./scripts/automation/orchestrator.mjs run [options]
  node ./scripts/automation/orchestrator.mjs run-parallel [options]
  node ./scripts/automation/orchestrator.mjs resume-parallel [options]
  node ./scripts/automation/orchestrator.mjs resume [options]
  node ./scripts/automation/orchestrator.mjs audit [options]
  node ./scripts/automation/orchestrator.mjs curate-evidence [options]

Options:
  --mode guarded|full                Autonomy mode (default: guarded)
  --max-plans <n>                    Maximum plans to process in this run
  --parallel-plans <n>               Number of plans to execute in parallel (default: 1)
  --base-ref <ref>                   Base ref for parallel worktrees/PRs (default: CURRENT_BRANCH)
  --branch-prefix <value>            Prefix for generated parallel worker branches
  --git-remote <name>                Remote used for parallel branch push/PR operations
  --context-threshold <n>            Legacy alias for absolute remaining-context floor
  --context-absolute-floor <n>       Trigger handoff backstop when contextRemaining <= n
  --context-soft-used-ratio <n>      Soft rollover threshold for context used ratio (0-1 or 0-100)
  --context-hard-used-ratio <n>      Hard rollover threshold for context used ratio (0-1 or 0-100)
  --require-result-payload true|false Require ORCH_RESULT_PATH payload with contextRemaining (default: true)
  --handoff-token-budget <n>         Metadata field for handoff budget reporting
  --max-rollovers <n>                Maximum rollovers per plan (default: 20)
  --max-sessions-per-plan <n>        Maximum executor sessions per plan in one run (default: 12)
  --validation "cmd1;;cmd2"          Validation commands separated by ';;'
  --commit true|false                Create atomic git commit per completed plan
  --skip-promotion true|false        Skip future->active promotion stage
  --allow-dirty true|false           Allow starting with dirty git worktree
  --run-id <id>                      Resume or audit a specific run id
  --plan-id <id>                     Filter curation scope to paths containing this value
  --scope active|completed|all       Curation scope for curate-evidence (default: all)
  --dry-run true|false               Do not write changes or run git commits
  --json true|false                  JSON output for audit
  --output minimal|ticker|pretty|verbose Console output mode (default: pretty)
  --failure-tail-lines <n>           Lines of command output to print on failures (default: 60)
  --heartbeat-seconds <n>            Live status heartbeat cadence in seconds (default: 120)
  --stall-warn-seconds <n>           Warn when no command output for this many seconds (default: 120)
  --touch-summary true|false         Show live touched-file summary in heartbeats (default: true)
  --touch-sample-size <n>            Number of touched-file examples in heartbeat details (default: 3)
  --touch-scan-mode adaptive|always|off Touch scan cadence policy for heartbeats (default: adaptive)
  --touch-scan-min-heartbeats <n>    Minimum heartbeats between touch scans in adaptive mode (default: 1)
  --touch-scan-max-heartbeats <n>    Maximum heartbeats between touch scans in adaptive mode (default: 8)
  --touch-scan-backoff-unchanged <n> Adaptive backoff multiplier when scans are unchanged (default: 2)
  --live-activity-mode off|best-effort Provider text to heartbeat channel (default: best-effort)
  --live-activity-max-chars <n>      Max live activity message chars (default: 0, no truncation)
  --live-activity-sample-seconds <n> Minimum seconds between live message updates (default: 2)
  --live-activity-emit-event-lines true|false Emit provider_activity events to run-events.jsonl (default: false)
  --live-activity-redact-patterns "<regex1>;;<regex2>" Extra redaction regexes for live activity
  --worker-first-touch-deadline-seconds <n> Fail-fast worker sessions that make no edits after n seconds (default: 180, 0 disables)
  --worker-retry-first-touch-deadline-seconds <n> Retry-session first-touch deadline for no-touch worker retries (default: inherits worker-first-touch-deadline-seconds)
  --worker-no-touch-retry-limit <n> Retry worker pending-without-edits sessions automatically up to n times (default: 1)
  --worker-pending-streak-limit <n> Fail-fast when worker returns same-role pending more than n consecutive sessions (default: 4, 0 disables)
  --worker-stall-fail-seconds <n>   Fail-fast worker sessions that go idle after making edits (default: 900, 0 disables)
  --retry-failed true|false          Retry failed plans automatically when policy gates allow (default: true)
  --auto-unblock true|false          Auto-unblock blocked plans when policy gates are now satisfied (default: true)
  --max-failed-retries <n>           Maximum automatic retries per failed plan (default: 2)
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return { command, options };
}

function asBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function asInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRatio(value, fallback = null) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(1, Math.max(0, normalized));
}

function deriveContextUsedRatio(contextRemaining, contextWindow) {
  if (
    typeof contextRemaining !== 'number' ||
    !Number.isFinite(contextRemaining) ||
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null;
  }
  const normalizedRemaining = Math.min(Math.max(contextRemaining, 0), contextWindow);
  return Math.min(1, Math.max(0, 1 - normalizedRemaining / contextWindow));
}

function normalizeOutputMode(value, fallback = DEFAULT_OUTPUT_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'ticker') {
    return 'ticker';
  }
  if (normalized === 'pretty') {
    return 'pretty';
  }
  if (normalized === 'verbose') {
    return 'verbose';
  }
  return 'minimal';
}

function normalizeTouchScanMode(value, fallback = DEFAULT_TOUCH_SCAN_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'always' || normalized === 'adaptive' || normalized === 'off') {
    return normalized;
  }
  return fallback;
}

function normalizeLiveActivityMode(value, fallback = DEFAULT_LIVE_ACTIVITY_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'off' || normalized === 'best-effort') {
    return normalized;
  }
  return fallback;
}

function normalizeSessionEvidenceMode(value, fallback = DEFAULT_EVIDENCE_SESSION_CURATION_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'always' || normalized === 'on-change' || normalized === 'off') {
    return normalized;
  }
  return fallback;
}

function normalizeContactPackCacheMode(value, fallback = DEFAULT_CONTACT_PACK_CACHE_MODE) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (normalized === 'off' || normalized === 'run-memory') {
    return normalized;
  }
  return fallback;
}

function parseListOption(value, fallback = []) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : [...fallback];
  }
  const raw = String(value ?? '').trim();
  if (!raw) {
    return [...fallback];
  }
  const delimiter = raw.includes(';;') ? ';;' : ',';
  const parsed = raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function compileRegexList(patterns = []) {
  const compiled = [];
  for (const pattern of patterns) {
    const normalized = String(pattern ?? '').trim();
    if (!normalized) {
      continue;
    }
    try {
      compiled.push(new RegExp(normalized, 'gi'));
    } catch {
      // Ignore invalid regex patterns and keep the stream resilient.
    }
  }
  return compiled;
}

function stripAnsiControl(value) {
  return String(value ?? '').replace(ANSI_ESCAPE_REGEX, '');
}

function extractStringFromUnknown(value, depth = 0) {
  if (depth > 3) {
    return null;
  }
  if (typeof value === 'string') {
    const rendered = value.trim();
    return rendered || null;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) {
      const extracted = extractStringFromUnknown(entry, depth + 1);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const preferred = ['text', 'content', 'message', 'delta', 'summary', 'reason', 'title', 'value'];
  for (const key of preferred) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const extracted = extractStringFromUnknown(value[key], depth + 1);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function normalizeJsonEventType(payload) {
  const candidates = [
    payload?.type,
    payload?.event?.type,
    payload?.eventType,
    payload?.name,
    payload?.event?.name
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const rendered = candidate.trim().toLowerCase();
    if (rendered) {
      return rendered;
    }
  }
  return '';
}

function eventTypeHasLiveActivityHint(eventType) {
  if (!eventType) {
    return false;
  }
  return LIVE_ACTIVITY_JSON_TYPE_HINTS.some((token) => eventType.includes(token));
}

function eventTypeDeniedForLiveActivity(eventType) {
  if (!eventType) {
    return false;
  }
  return LIVE_ACTIVITY_JSON_TYPE_DENY.some((token) => eventType.includes(token));
}

function eventTypeIsItemEvent(eventType) {
  if (!eventType) {
    return false;
  }
  return eventType.startsWith('item.');
}

function extractLiveActivityFromJsonLine(line) {
  const rendered = String(line ?? '').trim();
  if (!rendered || !rendered.startsWith('{')) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const eventType = normalizeJsonEventType(parsed);
  if (eventTypeDeniedForLiveActivity(eventType)) {
    return null;
  }

  const nestedItemCandidates = [parsed.item, parsed.event?.item, parsed.data?.item, parsed.payload?.item];
  const hasAgentMessageItem = nestedItemCandidates.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return String(item.type ?? '').trim().toLowerCase() === 'agent_message';
  });

  // Codex-style item envelopes: only accept completed agent_message text.
  if (hasAgentMessageItem) {
    if (eventType !== 'item.completed') {
      return null;
    }
    for (const item of nestedItemCandidates) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const itemType = String(item.type ?? '').trim().toLowerCase();
      if (itemType !== 'agent_message') {
        continue;
      }
      const preferred = extractStringFromUnknown(item.text ?? item.content ?? item.message);
      if (preferred) {
        return preferred;
      }
    }
    return null;
  }

  if (eventTypeIsItemEvent(eventType)) {
    return null;
  }

  // For non-item JSON envelopes, only parse when type hints imply activity/progress.
  if (eventType && !eventTypeHasLiveActivityHint(eventType)) {
    return null;
  }

  const containers = [parsed, parsed.event, parsed.data, parsed.payload, parsed.details, parsed.message];
  const keys = ['activity', 'progress', 'summary', 'reason', 'message', 'text', 'content'];
  for (const container of containers) {
    if (!container || typeof container !== 'object') {
      continue;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(container, key)) {
        continue;
      }
      const extracted = extractStringFromUnknown(container[key]);
      if (extracted) {
        return extracted;
      }
    }
  }

  if (eventTypeHasLiveActivityHint(eventType)) {
    const fallback = extractStringFromUnknown(parsed);
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

function looksLikeJsonEnvelope(line) {
  const rendered = String(line ?? '').trim();
  return rendered.startsWith('{') && rendered.endsWith('}');
}

function isGenericLiveActivityToken(value) {
  const rendered = String(value ?? '').trim().toLowerCase();
  if (!rendered) {
    return true;
  }
  if (LIVE_ACTIVITY_GENERIC_TOKENS.has(rendered)) {
    return true;
  }
  return /^[a-z_][a-z0-9_-]*$/.test(rendered) && rendered.length <= 24;
}

function condenseVerboseLiveActivity(rendered) {
  const value = String(rendered ?? '').trim();
  if (!value) {
    return value;
  }
  const looksMarkdownHeavy =
    value.includes('**') ||
    value.includes('](') ||
    value.includes('`') ||
    value.includes(' - ') ||
    value.includes('• ');
  if (!looksMarkdownHeavy || value.length <= 260) {
    return value;
  }

  const sentenceMatch = value.match(/^(.{1,360}?[.!?])(?:\s|$)/);
  if (sentenceMatch && sentenceMatch[1]) {
    return sentenceMatch[1].trim();
  }
  return value.slice(0, 220).trimEnd();
}

function sanitizeLiveActivityLine(line, redactionPatterns, maxChars) {
  let rendered = stripAnsiControl(line).replace(/\s+/g, ' ').trim();
  if (!rendered) {
    return null;
  }

  for (const pattern of redactionPatterns) {
    rendered = rendered.replace(pattern, REDACTED_VALUE);
  }

  if (!/[A-Za-z]/.test(rendered)) {
    return null;
  }

  const lower = rendered.toLowerCase();
  if (LIVE_ACTIVITY_PROVIDER_NAME_TOKENS.has(lower)) {
    return null;
  }
  if (isGenericLiveActivityToken(lower)) {
    return null;
  }

  rendered = condenseVerboseLiveActivity(rendered);

  const maxCharsLimit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (maxCharsLimit > 0 && rendered.length > maxCharsLimit) {
    rendered =
      maxCharsLimit === 1
        ? '…'
        : `${rendered.slice(0, Math.max(1, maxCharsLimit - 1)).trimEnd()}…`;
  }

  return rendered || null;
}

function visibleTextLength(value) {
  return stripAnsiControl(value).length;
}

function wrapTextForConsole(text, maxWidth) {
  const rendered = String(text ?? '').trim();
  if (!rendered) {
    return [''];
  }
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return [rendered];
  }

  const words = rendered.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  const splitLongToken = (token) => {
    let remaining = token;
    while (remaining.length > maxWidth) {
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    return remaining;
  };

  for (const word of words) {
    if (!current) {
      if (word.length <= maxWidth) {
        current = word;
      } else {
        current = splitLongToken(word);
      }
      continue;
    }

    if (current.length + 1 + word.length <= maxWidth) {
      current = `${current} ${word}`;
      continue;
    }

    lines.push(current);
    if (word.length <= maxWidth) {
      current = word;
    } else {
      current = splitLongToken(word);
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [rendered];
}

function printIndentedPrettyMessage(prefix, message) {
  const renderedPrefix = String(prefix ?? '');
  const renderedMessage = String(message ?? '').trim();
  if (!renderedMessage) {
    console.log(renderedPrefix.trimEnd());
    return;
  }

  const visiblePrefixLength = visibleTextLength(renderedPrefix);
  const consoleWidth =
    process.stdout.isTTY && Number.isFinite(process.stdout.columns) ? Number(process.stdout.columns) : 0;
  const maxWidth = consoleWidth > visiblePrefixLength + 12 ? consoleWidth - visiblePrefixLength : 0;
  const lines = wrapTextForConsole(renderedMessage, maxWidth);

  console.log(`${renderedPrefix}${lines[0] ?? ""}`);
  if (lines.length <= 1) {
    return;
  }

  const continuationPrefix = ' '.repeat(Math.max(0, visiblePrefixLength));
  for (const line of lines.slice(1)) {
    console.log(`${continuationPrefix}${line}`);
  }
}

function parseStructuredLogMessage(message) {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { headline: '', details: [] };
  }
  const firstDetailIndex = normalized.search(/\b[A-Za-z][A-Za-z0-9_-]*=[^\s]+/);
  if (firstDetailIndex < 0) {
    return { headline: normalized, details: [] };
  }
  const headline = normalized.slice(0, firstDetailIndex).trim();
  const detailText = normalized.slice(firstDetailIndex).trim();
  const details = [];
  const keyTokenPattern = /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/;
  let currentKey = null;
  let currentValue = '';
  for (const token of detailText.split(/\s+/)) {
    const keyMatch = token.match(keyTokenPattern);
    if (keyMatch) {
      if (currentKey && currentValue.trim()) {
        details.push({ key: currentKey, value: currentValue.trim() });
      }
      currentKey = keyMatch[1];
      currentValue = keyMatch[2] ?? '';
      continue;
    }
    if (!currentKey) {
      continue;
    }
    currentValue = currentValue ? `${currentValue} ${token}` : token;
  }
  if (currentKey && currentValue.trim()) {
    details.push({ key: currentKey, value: currentValue.trim() });
  }
  if (details.length === 0) {
    return { headline: normalized, details: [] };
  }
  return { headline: headline || normalized, details };
}

function colorizeStructuredHeadline(options, headline, level = 'run') {
  const value = String(headline ?? '').trim();
  const lower = value.toLowerCase();
  if (!value) {
    return value;
  }
  if (lower.startsWith('heartbeat') || lower.startsWith('file activity')) {
    return colorize(options, '32', value);
  }
  if (lower.startsWith('plan start') || (lower.startsWith('session') && lower.includes(' start'))) {
    return colorize(options, '32', value);
  }
  if (lower.startsWith('run resumed') || lower.startsWith('run start')) {
    return colorize(options, '36', value);
  }
  if (level === 'warn') {
    return colorize(options, '33', value);
  }
  if (level === 'error') {
    return colorize(options, '31', value);
  }
  return value;
}

function colorizeStructuredValue(options, key, value, level = 'run') {
  const keyLower = String(key ?? '').trim().toLowerCase();
  const valueText = String(value ?? '').trim();
  const valueLower = valueText.toLowerCase();
  if (!valueText) {
    return valueText;
  }

  if (keyLower === 'runid') return colorize(options, '96', valueText);
  if (keyLower === 'plan') return colorize(options, '36', valueText);
  if (keyLower === 'model') return colorize(options, '94', valueText);
  if (keyLower === 'provider') return colorize(options, '36', valueText);
  if (keyLower === 'role') return colorize(options, '35', valueText);
  if (keyLower === 'phase' || keyLower === 'activity') return colorize(options, '32', valueText);
  if (keyLower === 'elapsed' || keyLower === 'idle') return colorize(options, '32', valueText);
  if (keyLower === 'touch') return colorize(options, '36', valueText);

  if (['declared', 'effective', 'risk', 'status'].includes(keyLower)) {
    if (valueLower === 'low' || valueLower === 'completed' || valueLower === 'passed') {
      return colorize(options, '32', valueText);
    }
    if (valueLower === 'medium' || valueLower === 'pending' || valueLower === 'blocked') {
      return colorize(options, '33', valueText);
    }
    if (valueLower === 'high' || valueLower === 'failed' || valueLower === 'error') {
      return colorize(options, '31', valueText);
    }
    return colorize(options, '33', valueText);
  }

  if (keyLower === 'score') return colorize(options, '35', valueText);

  if (level === 'warn') return colorize(options, '33', valueText);
  if (level === 'error') return colorize(options, '31', valueText);
  return colorize(options, '37', valueText);
}

function printPrettyRunMessage(options, prefix, message, level = 'run') {
  const parsed = parseStructuredLogMessage(message);
  if (parsed.details.length === 0) {
    const headlineText = String(parsed.headline ?? '').trim();
    if (!headlineText) {
      printIndentedPrettyMessage(prefix, message);
      return;
    }
    printIndentedPrettyMessage(prefix, colorizeStructuredHeadline(options, headlineText, level));
    return;
  }

  const headlineText = String(parsed.headline ?? '').trim();
  printIndentedPrettyMessage(prefix, colorizeStructuredHeadline(options, headlineText, level));
  const continuationPrefix = ' '.repeat(Math.max(0, visibleTextLength(prefix)));
  const keyWidth = 16;
  for (const entry of parsed.details) {
    const keyLabel = colorize(options, '90', `${entry.key.padEnd(keyWidth, ' ')}`);
    const separator = colorize(options, '90', ' = ');
    const valueLabel = colorizeStructuredValue(options, entry.key, entry.value, level);
    printIndentedPrettyMessage(`${continuationPrefix}${keyLabel}${separator}`, valueLabel);
  }
}

function shouldCaptureCommandOutput(options) {
  return normalizeOutputMode(options?.outputMode, DEFAULT_OUTPUT_MODE) !== 'verbose';
}

function isTickerOutput(options) {
  return normalizeOutputMode(options?.outputMode, DEFAULT_OUTPUT_MODE) === 'ticker';
}

function isPrettyOutput(options) {
  return normalizeOutputMode(options?.outputMode, DEFAULT_OUTPUT_MODE) === 'pretty';
}

function canUseColor(options) {
  if (!isPrettyOutput(options)) {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  if (String(process.env.NO_COLOR ?? '').trim() !== '') {
    return false;
  }
  if (String(process.env.CI ?? '').trim() !== '') {
    return false;
  }
  return String(process.env.TERM ?? '').trim().toLowerCase() !== 'dumb';
}

function colorize(options, code, text) {
  if (!canUseColor(options)) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

function nextPrettySpinner(options) {
  if (!process.stdout.isTTY) {
    return '.';
  }
  const frame = PRETTY_SPINNER_FRAMES[prettySpinnerIndex % PRETTY_SPINNER_FRAMES.length];
  prettySpinnerIndex += 1;
  return colorize(options, '36', frame);
}

function nextPrettyLiveDots(options) {
  if (!process.stdout.isTTY) {
    return '...';
  }
  const frame = PRETTY_LIVE_DOT_FRAMES[prettyLiveDotIndex % PRETTY_LIVE_DOT_FRAMES.length];
  prettyLiveDotIndex += 1;
  return colorize(options, '36', frame);
}

function supportsLiveStatusLine(options) {
  return isPrettyOutput(options) && process.stdout.isTTY;
}

function clearLiveStatusLine() {
  if (!process.stdout.isTTY) {
    return;
  }
  if (typeof process.stdout.clearLine === 'function' && typeof process.stdout.cursorTo === 'function') {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    liveStatusLineLength = 0;
    return;
  }
  if (liveStatusLineLength <= 0) {
    return;
  }
  process.stdout.write(`\r${' '.repeat(liveStatusLineLength)}\r`);
  liveStatusLineLength = 0;
}

function renderLiveStatusLine(options, message) {
  if (!supportsLiveStatusLine(options)) {
    return;
  }
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return;
  }

  const width = Number.isFinite(process.stdout.columns) ? Number(process.stdout.columns) : 0;
  const visible = stripAnsiControl(normalized);
  let rendered = normalized;
  let visibleLength = visible.length;
  if (width > 3 && visibleLength >= width) {
    const clipped = visible.slice(0, Math.max(1, width - 2)).trimEnd();
    rendered = `${clipped}…`;
    visibleLength = stripAnsiControl(rendered).length;
  }

  if (typeof process.stdout.clearLine === 'function' && typeof process.stdout.cursorTo === 'function') {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(rendered);
    liveStatusLineLength = visibleLength;
    return;
  }

  const padded = rendered.padEnd(Math.max(liveStatusLineLength, visibleLength), ' ');
  process.stdout.write(`\r${padded}`);
  liveStatusLineLength = Math.max(visibleLength, stripAnsiControl(padded).length);
}

function classifyPrettyLevel(message) {
  const value = String(message ?? '').toLowerCase();
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.startsWith('next steps ')) return 'warn';
  if (value.includes('failed') || value.includes('error')) return 'error';
  if (value.includes('blocked') || value.includes('pending') || value.includes('downgraded')) return 'warn';
  if (value.includes('passed') || value.includes('complete') || value.includes('promoted')) return 'ok';
  if (value.includes('start') || value.includes('resume') || value.includes('session') || value.includes('transition')) {
    return 'run';
  }
  return 'info';
}

function prettyLevelTag(options, level) {
  if (level === 'error') return colorize(options, '31', 'ERROR');
  if (level === 'warn') return colorize(options, '33', 'WARN ');
  if (level === 'ok') return colorize(options, '32', 'OK   ');
  if (level === 'run') return colorize(options, '36', 'RUN  ');
  return colorize(options, '35', 'INFO ');
}

function progressLog(options, message) {
  clearLiveStatusLine();
  if (isTickerOutput(options)) {
    console.log(`[ticker] ${nowIso()} ${message}`);
    return;
  }
  if (isPrettyOutput(options)) {
    const stamp = colorize(options, '90', nowIso().slice(11, 19));
    const level = classifyPrettyLevel(message);
    const spinner = nextPrettySpinner(options);
    const tag = prettyLevelTag(options, level);
    const prefix = `${stamp} ${spinner} ${tag} `;
    if (parseStructuredLogMessage(message).details.length > 0) {
      printPrettyRunMessage(options, prefix, message, level);
      return;
    }
    printIndentedPrettyMessage(prefix, message);
    return;
  }
  console.log(`[orchestrator] ${message}`);
}

function tailLines(value, maxLines) {
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return '';
  }
  const start = Math.max(0, lines.length - Math.max(1, maxLines));
  return lines.slice(start).join('\n');
}

function executionOutput(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (stdout && stderr) {
    return `${stdout}\n${stderr}`;
  }
  return stdout || stderr || '';
}

function printRunSummary(options, label, state, processed, runDurationSeconds) {
  if (isTickerOutput(options)) {
    progressLog(
      options,
      `${label} complete processed=${processed} runId=${state.runId} completed=${state.completedPlanIds.length} blocked=${state.blockedPlanIds.length} failed=${state.failedPlanIds.length} duration=${formatDuration(runDurationSeconds)}`
    );
    return;
  }
  if (isPrettyOutput(options)) {
    const border = colorize(options, '90', '------------------------------------------------------------');
    const title = colorize(options, '1;36', `${label.toUpperCase()} SUMMARY`);
    console.log(border);
    console.log(title);
    console.log(`runId: ${state.runId}`);
    console.log(`processed: ${processed}`);
    console.log(`completed: ${state.completedPlanIds.length}`);
    console.log(`blocked: ${state.blockedPlanIds.length}`);
    console.log(`failed: ${state.failedPlanIds.length}`);
    console.log(`duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
    console.log(border);
    return;
  }

  progressLog(options, `${label} complete (${processed} processed).`);
  console.log(`- runId: ${state.runId}`);
  console.log(`- completed (cumulative for runId): ${state.completedPlanIds.length}`);
  console.log(`- blocked (cumulative for runId): ${state.blockedPlanIds.length}`);
  console.log(`- failed (cumulative for runId): ${state.failedPlanIds.length}`);
  console.log(`- duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
  console.log('- note: processed count is for this invocation; completed/blocked/failed are cumulative for the runId.');
}

function printParallelRunSummary(options, state, processed, runDurationSeconds, summary) {
  if (isTickerOutput(options)) {
    progressLog(
      options,
      `run-parallel complete processed=${processed} runId=${state.runId} branchCompleted=${summary.completed} branchBlocked=${summary.blocked} branchFailed=${summary.failed} branchPending=${summary.pending} duration=${formatDuration(runDurationSeconds)}`
    );
    return;
  }
  if (isPrettyOutput(options)) {
    const border = colorize(options, '90', '------------------------------------------------------------');
    const title = colorize(options, '1;36', 'RUN-PARALLEL SUMMARY');
    console.log(border);
    console.log(title);
    console.log(`runId: ${state.runId}`);
    console.log(`processed workers: ${processed}`);
    console.log(`branch completed: ${summary.completed}`);
    console.log(`branch blocked: ${summary.blocked}`);
    console.log(`branch failed: ${summary.failed}`);
    console.log(`branch pending: ${summary.pending}`);
    console.log(`duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
    console.log(border);
    return;
  }

  progressLog(options, `run-parallel complete (${processed} workers processed).`);
  console.log(`- runId: ${state.runId}`);
  console.log(`- branch completed: ${summary.completed}`);
  console.log(`- branch blocked: ${summary.blocked}`);
  console.log(`- branch failed: ${summary.failed}`);
  console.log(`- branch pending: ${summary.pending}`);
  console.log(`- duration: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`);
}

function normalizeRoleProfile(profile = {}, defaults = {}) {
  const merged = {
    ...defaults,
    ...(profile && typeof profile === 'object' ? profile : {})
  };
  const reasoningEffortByRisk = {
    ...normalizeReasoningEffortByRisk(defaults?.reasoningEffortByRisk),
    ...normalizeReasoningEffortByRisk(profile?.reasoningEffortByRisk)
  };
  return {
    model: String(merged.model ?? '').trim(),
    reasoningEffort: normalizeReasoningEffort(merged.reasoningEffort, 'medium'),
    reasoningEffortByRisk,
    sandboxMode: String(merged.sandboxMode ?? 'read-only').trim().toLowerCase(),
    instructions: String(merged.instructions ?? '').trim()
  };
}

function normalizeReasoningEffort(value, fallback = 'medium') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (REASONING_EFFORT_VALUES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeReasoningEffortByRisk(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};
  for (const riskTier of Object.keys(RISK_TIER_ORDER)) {
    const effort = normalizeReasoningEffort(source[riskTier], '');
    if (effort) {
      normalized[riskTier] = effort;
    }
  }
  return normalized;
}

function resolveReasoningEffortForRisk(profile, riskTier, fallback = 'medium') {
  const normalizedRiskTier = parseRiskTier(riskTier, 'low');
  const override = normalizeReasoningEffort(profile?.reasoningEffortByRisk?.[normalizedRiskTier], '');
  if (override) {
    return override;
  }
  return normalizeReasoningEffort(profile?.reasoningEffort, fallback);
}

function resolveExecutorProvider(config) {
  return String(process.env.ORCH_EXECUTOR_PROVIDER ?? config?.executor?.provider ?? 'codex').trim().toLowerCase();
}

function resolveRoleExecutionProfile(config, role, riskTier = 'low') {
  const normalizedRole = normalizeRoleName(role, ROLE_WORKER);
  const provider = resolveExecutorProvider(config);
  const roleProfiles = config?.roleOrchestration?.roleProfiles ?? {};
  const providerRoleProfiles = config?.roleOrchestration?.providers?.[provider]?.roleProfiles ?? {};
  const baseProfile = normalizeRoleProfile(roleProfiles[normalizedRole], {
    model: '',
    reasoningEffort: normalizedRole === ROLE_EXPLORER ? 'medium' : 'high',
    reasoningEffortByRisk: {},
    sandboxMode: normalizedRole === ROLE_WORKER ? 'full-access' : 'read-only',
    instructions: ''
  });
  const resolvedProfile = normalizeRoleProfile(providerRoleProfiles[normalizedRole], baseProfile);
  return {
    provider,
    ...resolvedProfile,
    reasoningEffort: resolveReasoningEffortForRisk(
      resolvedProfile,
      riskTier,
      normalizedRole === ROLE_EXPLORER ? 'medium' : 'high'
    )
  };
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function nowIso() {
  return new Date().toISOString();
}

function isoDate(value) {
  return String(value).slice(0, 10);
}

function parseIsoMillis(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function computePlanShapeHash(plan) {
  const payload = {
    planId: plan.planId,
    rel: plan.rel,
    dependencies: [...(plan.dependencies ?? [])].sort(),
    specTargets: [...(plan.specTargets ?? [])].sort(),
    tags: [...(plan.tags ?? [])].sort(),
    riskTier: parseRiskTier(plan.riskTier, 'low'),
    acceptanceCriteria: String(plan.acceptanceCriteria ?? '').trim()
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function durationSeconds(startIso, endIso = nowIso()) {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  return Math.floor((endMs - startMs) / 1000);
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds == null) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatDurationClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds == null) {
    return '--:--';
  }
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function randomRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${random}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDatePrefix(value) {
  return String(value).replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function datedPlanFileName(datePrefix, stem, ext = '.md') {
  const baseStem = stripDatePrefix(stem).trim();
  return `${datePrefix}-${baseStem}${ext}`;
}

function assertSafeRelativePlanPath(relPath) {
  const normalized = toPosix(String(relPath ?? '').trim());
  if (!normalized) {
    throw new Error('Plan file path is empty.');
  }
  if (path.posix.isAbsolute(normalized) || path.isAbsolute(normalized) || normalized.includes('..')) {
    throw new Error(`Unsafe plan file path '${normalized}'.`);
  }
  if (!SAFE_PLAN_RELATIVE_PATH_REGEX.test(normalized)) {
    throw new Error(`Plan file path contains unsafe characters: '${normalized}'.`);
  }
  return normalized;
}

function isWithinRoot(rootDir, absPath) {
  const relative = path.relative(rootDir, absPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveSafeRepoPath(rootDir, relPath, label = 'Repository path') {
  const normalized = assertSafeRelativePlanPath(relPath);
  const abs = path.resolve(rootDir, normalized);
  if (!isWithinRoot(rootDir, abs)) {
    throw new Error(`${label} escapes repository root: '${normalized}'.`);
  }
  return {
    rel: toPosix(path.relative(rootDir, abs)),
    abs
  };
}

function assertValidPlanId(planId, relPath) {
  if (!isValidPlanId(planId)) {
    throw new Error(
      `Invalid Plan-ID '${planId}' in ${relPath}. Use lowercase kebab-case (e.g. 'fix-auth-timeout').`
    );
  }
  return String(planId);
}

function buildPaths(rootDir) {
  const docsDir = path.join(rootDir, 'docs');
  const opsAutomationDir = path.join(docsDir, 'ops', 'automation');
  return {
    rootDir,
    docsDir,
    futureDir: path.join(docsDir, 'future'),
    activeDir: path.join(docsDir, 'exec-plans', 'active'),
    completedDir: path.join(docsDir, 'exec-plans', 'completed'),
    evidenceIndexDir: path.join(docsDir, 'exec-plans', 'evidence-index'),
    productStatePath: path.join(docsDir, 'product-specs', 'current-state.md'),
    opsAutomationDir,
    handoffDir: path.join(opsAutomationDir, 'handoffs'),
    runtimeDir: path.join(opsAutomationDir, 'runtime'),
    runtimeStateDir: path.join(opsAutomationDir, 'runtime', 'state'),
    contactPackDir: path.join(opsAutomationDir, 'runtime', 'contacts'),
    continuityAnalyticsPath: path.join(opsAutomationDir, 'runtime', 'continuity-analytics.json'),
    incidentBundleDir: path.join(opsAutomationDir, 'runtime', 'incidents'),
    parallelWorktreesDir: path.join(opsAutomationDir, 'runtime', 'worktrees'),
    runLockPath: path.join(opsAutomationDir, 'runtime', 'orchestrator.lock.json'),
    runStatePath: path.join(opsAutomationDir, 'run-state.json'),
    runEventsPath: path.join(opsAutomationDir, 'run-events.jsonl'),
    orchestratorConfigPath: path.join(opsAutomationDir, 'orchestrator.config.json')
  };
}

async function ensureDirectories(paths, dryRun) {
  if (dryRun) {
    return;
  }

  await fs.mkdir(paths.opsAutomationDir, { recursive: true });
  await fs.mkdir(paths.handoffDir, { recursive: true });
  await fs.mkdir(paths.runtimeDir, { recursive: true });
  await fs.mkdir(paths.runtimeStateDir, { recursive: true });
  await fs.mkdir(paths.contactPackDir, { recursive: true });
  await fs.mkdir(paths.incidentBundleDir, { recursive: true });
  await fs.mkdir(paths.parallelWorktreesDir, { recursive: true });
  await fs.mkdir(paths.evidenceIndexDir, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readJsonStrict(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${toPosix(path.relative(process.cwd(), filePath))}: ${message}`);
  }
}

async function writeJson(filePath, payload, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function appendJsonLine(filePath, payload, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function trimmedString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function stringList(value, maxItems = 8) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => trimmedString(entry)).filter(Boolean))].slice(0, Math.max(0, maxItems));
}

function renderSummaryBullet(label, values) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
  return `- ${label}: ${items.length > 0 ? items.join(' ; ') : 'none'}`;
}

function continuityStateDirForPlan(paths, planId) {
  return path.join(paths.runtimeStateDir, planId);
}

function continuityLatestStatePath(paths, planId) {
  return path.join(continuityStateDirForPlan(paths, planId), 'latest.json');
}

function continuityCheckpointLogPath(paths, planId) {
  return path.join(continuityStateDirForPlan(paths, planId), 'checkpoints.jsonl');
}

function continuityStateArtifactRel(planId) {
  return toPosix(path.join('docs', 'ops', 'automation', 'runtime', 'state', planId, 'latest.json'));
}

function continuityCheckpointArtifactRel(planId) {
  return toPosix(path.join('docs', 'ops', 'automation', 'runtime', 'state', planId, 'checkpoints.jsonl'));
}

function normalizeContinuitySection(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeContinuityDelta(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const reasoning = normalizeContinuitySection(source.reasoning);
  const evidence = normalizeContinuitySection(source.evidence);
  return {
    completedWork: stringList(source.completedWork, 10),
    acceptedFacts: stringList(source.acceptedFacts, 10),
    decisions: stringList(source.decisions, 10),
    openQuestions: stringList(source.openQuestions, 10),
    pendingActions: stringList(source.pendingActions, 10),
    recentResults: stringList(source.recentResults, 10),
    artifacts: stringList(source.artifacts, 12),
    risks: stringList(source.risks, 10),
    reasoning: {
      nextAction: trimmedString(source.nextAction ?? reasoning.nextAction),
      blockers: stringList(reasoning.blockers, 8),
      rationale: stringList(reasoning.rationale, 8)
    },
    evidence: {
      artifactRefs: stringList(evidence.artifactRefs, 12),
      extractedFacts: stringList(evidence.extractedFacts, 10),
      logRefs: stringList(evidence.logRefs, 8),
      validationRefs: stringList(evidence.validationRefs, 8)
    }
  };
}

function continuityMetrics(raw) {
  const delta = normalizeContinuityDelta(raw);
  return {
    pendingActionCount: delta.pendingActions.length,
    completedWorkCount: delta.completedWork.length,
    decisionCount: delta.decisions.length,
    openQuestionCount: delta.openQuestions.length,
    artifactCount:
      delta.artifacts.length +
      delta.evidence.artifactRefs.length +
      delta.evidence.logRefs.length +
      delta.evidence.validationRefs.length,
    blockerCount: delta.reasoning.blockers.length
  };
}

function normalizeCheckpointQuality(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    score: Math.max(0, Math.min(1, asNumber(source.score, 0))),
    resumeSafe: source.resumeSafe === true,
    missingFields: stringList(source.missingFields, 8),
    degradedReasons: stringList(source.degradedReasons, 8)
  };
}

function assessCheckpointQuality(record, minCompletedScore = DEFAULT_CONTINUITY_MIN_COMPLETED_SCORE) {
  const status = trimmedString(record?.status, 'completed');
  const currentSubtask = trimmedString(record?.currentSubtask);
  const nextAction = trimmedString(record?.nextAction);
  const delta = normalizeContinuityDelta(record?.stateDelta);
  const hasDecisionContext = delta.decisions.length > 0 || delta.openQuestions.length > 0;
  const hasBlocker = delta.reasoning.blockers.length > 0 || /blocked|failed/i.test(trimmedString(record?.reason));
  const hasArtifactRef =
    delta.artifacts.length > 0 ||
    delta.evidence.artifactRefs.length > 0 ||
    delta.evidence.logRefs.length > 0 ||
    delta.evidence.validationRefs.length > 0;
  const hasOutcomeDelta = delta.completedWork.length > 0 || delta.recentResults.length > 0;
  const missingFields = [];

  if (!currentSubtask) {
    missingFields.push('currentSubtask');
  }

  if (status === 'pending' || status === 'handoff_required') {
    if (!nextAction) missingFields.push('nextAction');
    if (!hasDecisionContext) missingFields.push('decisionOrOpenQuestion');
    if (!hasArtifactRef) missingFields.push('artifactOrValidationRef');
    if (!hasOutcomeDelta) missingFields.push('completedWorkOrRecentResults');
  } else if (status === 'blocked' || status === 'failed') {
    if (!nextAction) missingFields.push('nextAction');
    if (!hasDecisionContext) missingFields.push('decisionOrOpenQuestion');
    if (!hasBlocker) missingFields.push('blockerOrReason');
    if (!hasArtifactRef) missingFields.push('artifactOrValidationRef');
  } else {
    if (!hasOutcomeDelta) missingFields.push('completedWorkOrRecentResults');
    if (!hasArtifactRef) missingFields.push('artifactOrValidationRef');
  }

  const requiredCount =
    status === 'pending' || status === 'handoff_required'
      ? 5
      : status === 'blocked' || status === 'failed'
        ? 5
        : 3;
  const satisfiedCount = Math.max(0, requiredCount - missingFields.length);
  const score = requiredCount > 0 ? Math.round((satisfiedCount / requiredCount) * 100) / 100 : 1;
  const resumeSafe =
    status === 'completed'
      ? score >= minCompletedScore
      : missingFields.length === 0;
  const degradedReasons = [];
  if (!resumeSafe) {
    degradedReasons.push(`checkpoint_quality_below_threshold:${score.toFixed(2)}`);
  }
  return {
    score,
    resumeSafe,
    missingFields,
    degradedReasons
  };
}

function continuityStateFromRecord(plan, checkpoint, existingState = null) {
  const prior = existingState && typeof existingState === 'object' ? existingState : {};
  const delta = normalizeContinuityDelta(checkpoint?.stateDelta);
  const quality = normalizeCheckpointQuality(checkpoint?.quality ?? prior?.quality);
  const nextAction = trimmedString(
    checkpoint?.nextAction ??
      delta.reasoning.nextAction ??
      checkpoint?.reasoning?.nextAction ??
      prior?.reasoning?.nextAction
  );
  return {
    schemaVersion: ROLLING_CONTEXT_SCHEMA_VERSION,
    planId: plan.planId,
    goal: trimmedString(prior.goal ?? plan.acceptanceCriteria ?? plan.planId, plan.planId),
    currentSubtask: trimmedString(checkpoint?.currentSubtask ?? prior.currentSubtask),
    status: trimmedString(checkpoint?.status ?? prior.status),
    roleCursor: {
      role: trimmedString(checkpoint?.role ?? prior?.roleCursor?.role, ROLE_WORKER),
      stageIndex: Math.max(1, asInteger(checkpoint?.stageIndex, asInteger(prior?.roleCursor?.stageIndex, 1))),
      stageTotal: Math.max(
        1,
        asInteger(checkpoint?.stageTotal, asInteger(prior?.roleCursor?.stageTotal, 1))
      ),
      session: Math.max(1, asInteger(checkpoint?.session, asInteger(prior?.roleCursor?.session, 1)))
    },
    acceptedFacts: stringList([...(prior.acceptedFacts ?? []), ...delta.acceptedFacts], 12),
    decisions: stringList([...(prior.decisions ?? []), ...delta.decisions], 12),
    openQuestions: stringList(
      checkpoint?.status === 'completed'
        ? delta.openQuestions
        : [...(prior.openQuestions ?? []), ...delta.openQuestions],
      12
    ),
    pendingActions: stringList(delta.pendingActions.length > 0 ? delta.pendingActions : prior.pendingActions, 12),
    completedWork: stringList([...(prior.completedWork ?? []), ...delta.completedWork], 12),
    recentResults: stringList([...(prior.recentResults ?? []), ...delta.recentResults], 12),
    artifacts: stringList([...(prior.artifacts ?? []), ...delta.artifacts], 16),
    risks: stringList([...(prior.risks ?? []), ...delta.risks], 12),
    reasoning: {
      nextAction,
      blockers: stringList(delta.reasoning.blockers.length > 0 ? delta.reasoning.blockers : prior?.reasoning?.blockers, 10),
      rationale: stringList([...(prior?.reasoning?.rationale ?? []), ...delta.reasoning.rationale], 10)
    },
    evidence: {
      artifactRefs: stringList([...(prior?.evidence?.artifactRefs ?? []), ...delta.evidence.artifactRefs], 16),
      extractedFacts: stringList([...(prior?.evidence?.extractedFacts ?? []), ...delta.evidence.extractedFacts], 12),
      logRefs: stringList([...(prior?.evidence?.logRefs ?? []), ...delta.evidence.logRefs], 10),
      validationRefs: stringList(
        [...(prior?.evidence?.validationRefs ?? []), ...delta.evidence.validationRefs],
        10
      )
    },
    quality,
    updatedAt: nowIso()
  };
}

async function readLatestContinuityState(paths, planId) {
  return readJsonIfExists(continuityLatestStatePath(paths, planId), null);
}

async function persistContinuityCheckpoint(paths, plan, checkpoint, options) {
  if (options.dryRun) {
    return null;
  }
  const stateDir = continuityStateDirForPlan(paths, plan.planId);
  await fs.mkdir(stateDir, { recursive: true });
  const latestPath = continuityLatestStatePath(paths, plan.planId);
  const checkpointsPath = continuityCheckpointLogPath(paths, plan.planId);
  const existing = await readLatestContinuityState(paths, plan.planId);
  const latest = continuityStateFromRecord(plan, checkpoint, existing);
  await writeJson(latestPath, latest, false);
  await appendJsonLine(checkpointsPath, checkpoint, false);
  return {
    latestPath,
    checkpointsPath,
    latest
  };
}

function timeoutMsFromSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.floor(seconds * 1000);
}

function runShell(command, cwd, env = process.env, timeoutMs = undefined, stdioMode = 'inherit') {
  const capture = stdioMode === 'pipe';
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    timeout: timeoutMs,
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: capture ? 1024 * 1024 * 25 : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
}

function runShellCapture(command, cwd, env = process.env, timeoutMs = undefined) {
  return spawnSync(command, {
    shell: true,
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function didTimeout(result) {
  return result?.error?.code === 'ETIMEDOUT';
}

function didFirstTouchDeadlineTimeout(result) {
  return result?.error?.code === 'ENO_TOUCH_DEADLINE';
}

function didWorkerStallTimeout(result) {
  return result?.error?.code === 'EWORKER_STALL';
}

function roleActivity(role) {
  const normalized = normalizeRoleName(role, ROLE_WORKER);
  if (normalized === ROLE_PLANNER) return 'planning';
  if (normalized === ROLE_EXPLORER) return 'exploring';
  if (normalized === ROLE_REVIEWER) return 'reviewing';
  return 'implementing';
}

function safeDisplayToken(value, fallback = 'n/a') {
  const rendered = String(value ?? '').trim();
  return rendered.length > 0 ? rendered : fallback;
}

function compactDisplayToken(value, fallback = 'n/a', maxLength = 24) {
  const rendered = safeDisplayToken(value, fallback);
  if (rendered.length <= maxLength) {
    return rendered;
  }
  if (maxLength <= 8) {
    return rendered.slice(0, maxLength);
  }
  const available = maxLength - 1;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${rendered.slice(0, head)}…${rendered.slice(rendered.length - tail)}`;
}

function formatCommandHeartbeatMessage(context, elapsedSeconds, idleSeconds) {
  const phase = compactDisplayToken(context.phase, 'session', 10);
  const planId = compactDisplayToken(context.planId, 'run', 26);
  const role = compactDisplayToken(context.role, 'n/a', 10);
  const activity = compactDisplayToken(context.activity, phase, 16);
  const touchSummary = formatTouchSummaryInline(context.touchSummary);
  const elapsed = formatDurationClock(elapsedSeconds);
  const idle = formatDurationClock(idleSeconds);
  return (
    `heartbeat plan=${planId} role=${role} phase=${phase} activity=${activity} elapsed=${elapsed} idle=${idle} ${touchSummary}`
  );
}

function touchPathSignature(rootDir, relativePath) {
  const normalized = toPosix(String(relativePath ?? '').trim()).replace(/^\.?\//, '');
  if (!normalized) {
    return 'missing';
  }
  const absPath = path.join(rootDir, normalized);
  try {
    const stat = fsSync.statSync(absPath);
    const kind = stat.isFile() ? 'f' : stat.isDirectory() ? 'd' : 'o';
    return `${kind}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function createTouchBaseline(cwd) {
  const initialPaths = dirtyRepoPaths(cwd, { includeTransient: true })
    .filter((entry) => !isTransientAutomationPath(entry));
  const initialPathSet = new Set(initialPaths);
  const initialSignatures = new Map();
  for (const filePath of initialPathSet) {
    initialSignatures.set(filePath, touchPathSignature(cwd, filePath));
  }
  return {
    initialPathSet,
    initialSignatures,
    touchedPathSet: new Set()
  };
}

function monitorTouchedPaths(cwd, baselineState, options = {}) {
  if (!baselineState || !(baselineState.initialPathSet instanceof Set)) {
    return null;
  }

  const current = dirtyRepoPaths(cwd, { includeTransient: true })
    .filter((entry) => !isTransientAutomationPath(entry));
  for (const entry of current) {
    if (!baselineState.initialPathSet.has(entry)) {
      baselineState.touchedPathSet.add(entry);
      continue;
    }
    const initialSignature = baselineState.initialSignatures.get(entry);
    if (initialSignature === undefined) {
      continue;
    }
    const currentSignature = touchPathSignature(cwd, entry);
    if (currentSignature !== initialSignature) {
      baselineState.touchedPathSet.add(entry);
    }
  }
  const touched = [...baselineState.touchedPathSet];
  const summary = summarizeTouchedPaths(touched, options.touchSampleSize);
  return {
    ...summary,
    touched
  };
}

async function runShellMonitored(
  command,
  cwd,
  env = process.env,
  timeoutMs = undefined,
  stdioMode = 'inherit',
  options = {},
  context = {}
) {
  const capture = stdioMode === 'pipe';
  const startedAtMs = Date.now();
  let lastOutputAtMs = startedAtMs;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let firstTouchDeadlineTimedOut = false;
  let workerStallFailTimedOut = false;
  let workerFirstMeaningfulTouchObserved = false;
  let lastMeaningfulTouchAtMs = null;
  let processError = null;
  let settled = false;
  let warnEmitted = false;
  let timeoutTimer = null;
  let forceKillTimer = null;
  const liveActivityMode = normalizeLiveActivityMode(options.liveActivityMode, DEFAULT_LIVE_ACTIVITY_MODE);
  const liveActivityEnabled = capture && liveActivityMode === 'best-effort';
  const liveActivityMaxChars = Math.max(
    0,
    asInteger(options.liveActivityMaxChars, DEFAULT_LIVE_ACTIVITY_MAX_CHARS)
  );
  const liveActivitySampleMs = Math.max(
    0,
    asInteger(options.liveActivitySampleSeconds, DEFAULT_LIVE_ACTIVITY_SAMPLE_SECONDS) * 1000
  );
  const liveActivityRedactionPatterns = compileRegexList(
    parseListOption(options.liveActivityRedactPatterns, DEFAULT_LIVE_ACTIVITY_REDACT_PATTERNS)
  );
  let stdoutRemainder = '';
  let stderrRemainder = '';
  let sawJsonEnvelopeOutput = false;
  let latestProviderActivity = null;
  let latestProviderActivityAtMs = null;
  let liveActivityUpdates = 0;
  let lastLiveActivityAcceptedAtMs = 0;
  let lastVisibleStatusAtMs = startedAtMs;
  const touchSummaryEnabled = asBoolean(options.touchSummary, DEFAULT_TOUCH_SUMMARY);
  const touchScanMode = normalizeTouchScanMode(options.touchScanMode, DEFAULT_TOUCH_SCAN_MODE);
  const touchScanMinHeartbeats = Math.max(
    1,
    asInteger(options.touchScanMinHeartbeats, DEFAULT_TOUCH_SCAN_MIN_HEARTBEATS)
  );
  const touchScanMaxHeartbeats = Math.max(
    touchScanMinHeartbeats,
    asInteger(options.touchScanMaxHeartbeats, DEFAULT_TOUCH_SCAN_MAX_HEARTBEATS)
  );
  const touchScanBackoffUnchanged = Math.max(
    1,
    asInteger(options.touchScanBackoffUnchanged, DEFAULT_TOUCH_SCAN_BACKOFF_UNCHANGED)
  );
  const touchSampleSize = Math.max(1, asInteger(options.touchSampleSize, DEFAULT_TOUCH_SAMPLE_SIZE));
  const touchMonitoringEnabled = touchSummaryEnabled && touchScanMode !== 'off';
  const touchBaseline = touchMonitoringEnabled && gitAvailable(cwd) ? createTouchBaseline(cwd) : null;
  let touchSummary = null;
  let lastTouchChangeAtMs = startedAtMs;
  let lastTouchFingerprint = null;
  let heartbeatsUntilNextTouchScan = 0;
  let currentTouchScanInterval = touchScanMinHeartbeats;
  let touchScansExecuted = 0;
  let touchScansSkipped = 0;
  const firstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(options.workerFirstTouchDeadlineSeconds, DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS)
  );
  const enforceFirstTouchDeadline =
    touchBaseline != null &&
    String(context.phase ?? '').trim().toLowerCase() === 'session' &&
    normalizeRoleName(context.role, ROLE_WORKER) === ROLE_WORKER &&
    firstTouchDeadlineSeconds > 0;
  const firstTouchDeadlineMs = enforceFirstTouchDeadline ? firstTouchDeadlineSeconds * 1000 : 0;
  const workerStallFailSeconds = Math.max(
    0,
    asInteger(options.workerStallFailSeconds, DEFAULT_WORKER_STALL_FAIL_SECONDS)
  );
  const enforceWorkerStallFail =
    touchBaseline != null &&
    String(context.phase ?? '').trim().toLowerCase() === 'session' &&
    normalizeRoleName(context.role, ROLE_WORKER) === ROLE_WORKER &&
    workerStallFailSeconds > 0;
  const workerStallFailMs = enforceWorkerStallFail ? workerStallFailSeconds * 1000 : 0;
  const workerTouchPolicy = context?.workerTouchPolicy ?? null;

  const child = spawn(command, {
    shell: true,
    detached: process.platform !== 'win32',
    cwd,
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });

  function markVisibleStatus(nowMs = Date.now()) {
    lastVisibleStatusAtMs = nowMs;
  }

  function maybeRecordLiveActivity(line, source, nowMs = Date.now()) {
    if (!liveActivityEnabled) {
      return;
    }
    const sanitized = sanitizeLiveActivityLine(line, liveActivityRedactionPatterns, liveActivityMaxChars);
    if (!sanitized) {
      return;
    }
    if (sanitized === latestProviderActivity) {
      return;
    }
    if (liveActivitySampleMs > 0 && nowMs - lastLiveActivityAcceptedAtMs < liveActivitySampleMs) {
      return;
    }
    latestProviderActivity = sanitized;
    latestProviderActivityAtMs = nowMs;
    lastLiveActivityAcceptedAtMs = nowMs;
    liveActivityUpdates += 1;
    let surfaced = false;
    const callback = context && typeof context.onLiveActivity === 'function' ? context.onLiveActivity : null;
    if (callback) {
      callback({
        source,
        message: sanitized,
        timestamp: nowIso()
      });
      surfaced = true;
    }
    if (isPrettyOutput(options)) {
      const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
      const stamp = colorize(options, '90', nowIso().slice(11, 19));
      const spinner = nextPrettySpinner(options);
      const workingLabel = colorize(options, '36', `WORKING (${formatDurationClock(elapsedSeconds)})`);
      const workingMessage = colorize(options, '37', sanitized);
      clearLiveStatusLine();
      printIndentedPrettyMessage(`${stamp} ${spinner} ${workingLabel} `, workingMessage);
      surfaced = true;
    }
    if (surfaced) {
      markVisibleStatus(nowMs);
    }
  }

  function processStreamChunk(source, chunk, nowMs = Date.now()) {
    const rendered = chunk.toString();
    if (source === 'stdout') {
      stdout += rendered;
    } else {
      stderr += rendered;
    }
    lastOutputAtMs = nowMs;
    if (!liveActivityEnabled) {
      return;
    }
    const previousRemainder = source === 'stdout' ? stdoutRemainder : stderrRemainder;
    const combined = `${previousRemainder}${rendered}`;
    const parts = combined.split(/\r?\n|\r/g);
    const remainder = parts.pop() ?? '';
    if (source === 'stdout') {
      stdoutRemainder = remainder;
    } else {
      stderrRemainder = remainder;
    }
    for (const line of parts) {
      const jsonActivity = extractLiveActivityFromJsonLine(line);
      if (jsonActivity) {
        sawJsonEnvelopeOutput = true;
        maybeRecordLiveActivity(jsonActivity, source, nowMs);
        continue;
      }
      if (looksLikeJsonEnvelope(line)) {
        sawJsonEnvelopeOutput = true;
        continue;
      }
      if (sawJsonEnvelopeOutput) {
        continue;
      }
      maybeRecordLiveActivity(line, source, nowMs);
    }
  }

  if (capture) {
    child.stdout?.on('data', (chunk) => {
      processStreamChunk('stdout', chunk, Date.now());
    });
    child.stderr?.on('data', (chunk) => {
      processStreamChunk('stderr', chunk, Date.now());
    });
  }

  const heartbeatMs = Math.max(3000, asInteger(options.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS) * 1000);
  const stallWarnMs = Math.max(
    heartbeatMs,
    asInteger(options.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS) * 1000
  );
  const heartbeatEnabled = isPrettyOutput(options) || isTickerOutput(options);
  let heartbeatTimer = null;

  function maybeRefreshTouchSummary(nowMs = Date.now(), force = false) {
    if (!touchBaseline) {
      return;
    }

    const forceDeadlineScan = enforceFirstTouchDeadline && !workerFirstMeaningfulTouchObserved;
    let shouldScan = force || forceDeadlineScan;
    if (!shouldScan) {
      if (touchScanMode === 'always') {
        shouldScan = true;
      } else if (touchScanMode === 'adaptive') {
        shouldScan = heartbeatsUntilNextTouchScan <= 0;
      }
    }

    if (!shouldScan) {
      touchScansSkipped += 1;
      heartbeatsUntilNextTouchScan = Math.max(0, heartbeatsUntilNextTouchScan - 1);
      return;
    }

    touchScansExecuted += 1;
    const latestTouchSummary = monitorTouchedPaths(cwd, touchBaseline, { touchSampleSize });
    if (!latestTouchSummary) {
      heartbeatsUntilNextTouchScan = 0;
      return;
    }

    touchSummary = latestTouchSummary;
    const changed = latestTouchSummary.fingerprint !== lastTouchFingerprint;
    if (changed) {
      lastTouchFingerprint = latestTouchSummary.fingerprint;
      lastTouchChangeAtMs = nowMs;
      if (latestTouchSummary.count > 0) {
        progressLog(
          options,
          `file activity phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} ${formatTouchSummaryDetails(latestTouchSummary)}`
        );
        markVisibleStatus(nowMs);
      }
    }

    if (touchScanMode === 'adaptive') {
      if (changed) {
        currentTouchScanInterval = touchScanMinHeartbeats;
      } else {
        const nextInterval = Math.max(
          touchScanMinHeartbeats,
          Math.floor(currentTouchScanInterval * touchScanBackoffUnchanged)
        );
        currentTouchScanInterval = Math.min(touchScanMaxHeartbeats, nextInterval);
      }
      heartbeatsUntilNextTouchScan = Math.max(0, currentTouchScanInterval - 1);
    } else {
      heartbeatsUntilNextTouchScan = 0;
    }
  }

  const emitHeartbeat = () => {
    const nowMs = Date.now();
    maybeRefreshTouchSummary(nowMs);
    const elapsedSeconds = Math.floor((nowMs - startedAtMs) / 1000);
    const effectiveProgressAtMs = Math.max(lastOutputAtMs, lastTouchChangeAtMs);
    const idleSeconds = Math.floor((nowMs - effectiveProgressAtMs) / 1000);
    const hasMeaningfulWorkerTouch = hasMeaningfulWorkerTouchSummary(touchSummary, workerTouchPolicy);
    if (hasMeaningfulWorkerTouch) {
      workerFirstMeaningfulTouchObserved = true;
      lastMeaningfulTouchAtMs = nowMs;
    }
    const effectiveWorkerProgressAtMs =
      workerFirstMeaningfulTouchObserved && lastMeaningfulTouchAtMs != null
        ? Math.max(lastOutputAtMs, lastMeaningfulTouchAtMs)
        : effectiveProgressAtMs;
    const workerIdleSeconds = Math.floor((nowMs - effectiveWorkerProgressAtMs) / 1000);
    const shouldEmitHeartbeat = nowMs - lastVisibleStatusAtMs >= heartbeatMs;
    if (shouldEmitHeartbeat) {
      progressLog(
        options,
        formatCommandHeartbeatMessage({ ...context, touchSummary }, elapsedSeconds, idleSeconds)
      );
      markVisibleStatus(nowMs);
    }

    if (idleSeconds * 1000 >= stallWarnMs && !warnEmitted) {
      warnEmitted = true;
      progressLog(
        options,
        `stall warning phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} idle=${formatDuration(idleSeconds)} ${formatTouchSummaryInline(touchSummary)}`
      );
    }

    if (enforceFirstTouchDeadline && !firstTouchDeadlineTimedOut) {
      if (!workerFirstMeaningfulTouchObserved && nowMs - startedAtMs >= firstTouchDeadlineMs) {
        firstTouchDeadlineTimedOut = true;
        progressLog(
          options,
          `first-touch deadline exceeded phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} deadline=${firstTouchDeadlineSeconds}s without ${workerTouchPolicy?.progressLabel ?? 'repository edits outside plan/evidence files'}`
        );
        signalMonitoredProcess(child, 'SIGTERM');
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (monitoredProcessAlive(child)) {
              signalMonitoredProcess(child, 'SIGKILL');
            }
          }, 5000);
          forceKillTimer.unref?.();
        }
      }
    }

    if (enforceWorkerStallFail && !workerStallFailTimedOut) {
      if (workerFirstMeaningfulTouchObserved && nowMs - effectiveWorkerProgressAtMs >= workerStallFailMs) {
        workerStallFailTimedOut = true;
        progressLog(
          options,
          `worker stall fail-fast phase=${safeDisplayToken(context.phase, 'session')} plan=${safeDisplayToken(context.planId, 'run')} role=${safeDisplayToken(context.role, 'n/a')} idle=${formatDuration(workerIdleSeconds)} threshold=${workerStallFailSeconds}s`
        );
        signalMonitoredProcess(child, 'SIGTERM');
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (monitoredProcessAlive(child)) {
              signalMonitoredProcess(child, 'SIGKILL');
            }
          }, 5000);
          forceKillTimer.unref?.();
        }
      }
    }
  };

  if (heartbeatEnabled) {
    emitHeartbeat();
    heartbeatTimer = setInterval(emitHeartbeat, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalMonitoredProcess(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (monitoredProcessAlive(child)) {
          signalMonitoredProcess(child, 'SIGKILL');
        }
      }, 5000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  function cleanupTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    clearLiveStatusLine();
  }

  return new Promise((resolve) => {
    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      const stdoutJsonActivity = extractLiveActivityFromJsonLine(stdoutRemainder);
      if (stdoutJsonActivity) {
        maybeRecordLiveActivity(stdoutJsonActivity, 'stdout', Date.now());
      } else if (!looksLikeJsonEnvelope(stdoutRemainder)) {
        maybeRecordLiveActivity(stdoutRemainder, 'stdout', Date.now());
      }
      const stderrJsonActivity = extractLiveActivityFromJsonLine(stderrRemainder);
      if (stderrJsonActivity) {
        maybeRecordLiveActivity(stderrJsonActivity, 'stderr', Date.now());
      } else if (!looksLikeJsonEnvelope(stderrRemainder)) {
        maybeRecordLiveActivity(stderrRemainder, 'stderr', Date.now());
      }
      maybeRefreshTouchSummary(Date.now(), true);
      const finalTouchSummary = touchSummary;
      resolve({
        status,
        signal,
        error: workerStallFailTimedOut
          ? { code: 'EWORKER_STALL' }
          : firstTouchDeadlineTimedOut
            ? { code: 'ENO_TOUCH_DEADLINE' }
            : timedOut
              ? { code: 'ETIMEDOUT' }
              : processError,
        stdout,
        stderr,
        touchSummary: finalTouchSummary ?? null,
        liveActivity:
          latestProviderActivityAtMs != null && latestProviderActivity
            ? {
                message: latestProviderActivity,
                updatedAt: new Date(latestProviderActivityAtMs).toISOString()
              }
            : null,
        liveActivityUpdates,
        touchMonitor: {
          mode: touchBaseline
            ? touchScanMode
            : touchSummaryEnabled
              ? (touchScanMode === 'off' ? 'off' : 'unavailable')
              : 'disabled',
          scansExecuted: touchScansExecuted,
          scansSkipped: touchScansSkipped
        }
      });
    };

    child.on('error', (error) => {
      processError = error;
      finish(null, null);
    });

    child.on('close', (status, signal) => {
      finish(status, signal);
    });
  });
}

function signalMonitoredProcess(child, signal = 'SIGTERM') {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fallback to direct child signal if group signal is unavailable.
    }
  }

  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function monitoredProcessAlive(child) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      // Fall through to direct pid check.
    }
  }

  return pidIsAlive(pid);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(paths) {
  const defaultConfig = {
    executor: {
      command: '',
      handoffExitCode: DEFAULT_HANDOFF_EXIT_CODE,
      timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS
    },
    context: {
      runtimeContextPath: DEFAULT_RUNTIME_CONTEXT_PATH,
      maxTokens: 1400,
      contactPacks: {
        enabled: DEFAULT_CONTACT_PACKS_ENABLED,
        maxPolicyBullets: DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS,
        includeRecentEvidence: DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE,
        maxRecentEvidenceItems: DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS,
        cacheMode: DEFAULT_CONTACT_PACK_CACHE_MODE
      }
    },
    continuity: {
      checkpointQuality: {
        minCompletedScore: DEFAULT_CONTINUITY_MIN_COMPLETED_SCORE
      },
      thresholds: {
        maxDerivedContinuityRate: DEFAULT_CONTINUITY_MAX_DERIVED_RATE,
        minResumeSafeCheckpointRate: DEFAULT_CONTINUITY_MIN_RESUME_SAFE_RATE,
        maxThinPackRate: DEFAULT_CONTINUITY_MAX_THIN_PACK_RATE,
        maxRepeatedHandoffLoopPlans: DEFAULT_CONTINUITY_MAX_REPEATED_HANDOFF_LOOP_PLANS
      },
      incidentBundles: {
        enabled: true,
        emitOn: ['failed', 'degraded']
      }
    },
    validationCommands: [],
    validation: {
      always: [],
      requireAlwaysCommands: true,
      hostRequired: [],
      requireHostRequiredCommands: true,
      timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
      host: {
        mode: DEFAULT_HOST_VALIDATION_MODE,
        ci: {
          command: '',
          timeoutSeconds: DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS,
          pollSeconds: DEFAULT_HOST_VALIDATION_POLL_SECONDS
        },
        local: {
          command: ''
        }
      }
    },
    evidence: {
      sessionCurationMode: DEFAULT_EVIDENCE_SESSION_CURATION_MODE,
      sessionIndexRefreshMode: DEFAULT_EVIDENCE_SESSION_INDEX_REFRESH_MODE,
      compaction: {
        mode: 'compact-index',
        maxReferences: DEFAULT_EVIDENCE_MAX_REFERENCES
      },
      lifecycle: {
        trackMode: DEFAULT_EVIDENCE_TRACK_MODE,
        dedupMode: DEFAULT_EVIDENCE_DEDUP_MODE,
        pruneOnComplete: DEFAULT_EVIDENCE_PRUNE_ON_COMPLETE,
        keepMaxPerBlocker: DEFAULT_EVIDENCE_KEEP_MAX_PER_BLOCKER
      }
    },
    semanticProof: {
      mode: DEFAULT_SEMANTIC_PROOF_MODE
    },
    roleOrchestration: {
      enabled: DEFAULT_ROLE_ORCHESTRATION_ENABLED,
      mode: 'risk-adaptive',
      roleProfiles: {
        explorer: {
          model: 'gpt-5.3-codex-spark',
          reasoningEffort: 'medium',
          sandboxMode: 'read-only',
          instructions:
            'You are a fast codebase explorer. Search files, read code, trace dependencies, and answer scoped questions. You may update active plan/evidence docs for this stage, but do not modify product/source code. Record concrete implementation-ready findings in plan/evidence docs before finishing.'
        },
        reviewer: {
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          sandboxMode: 'read-only',
          instructions:
            'Focus on high-priority issues: security vulnerabilities, correctness bugs, race conditions, test flakiness, and performance problems.'
        },
        worker: {
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          sandboxMode: 'full-access',
          instructions:
            'You are an execution-focused agent. Implement features, fix bugs, and refactor precisely while following existing patterns. Start with a concrete repository edit as soon as feasible, then continue iteratively. Do not defer implementation work back to planner/explorer when a concrete edit can be made now. When sending interim status updates, write complete words and full identifiers; do not shorten with ellipses. Keep interim status updates concise (1-2 short sentences) and plain text; avoid markdown headings, bullet lists, and file links in live updates.'
        },
        planner: {
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          reasoningEffortByRisk: {
            high: 'high'
          },
          sandboxMode: 'read-only',
          instructions:
            'You are an architect agent. Break down tasks into implementation steps, identify dependencies/risks, and output a structured execution plan. Update plan/evidence docs with concrete next-step checklists, and avoid modifying product/source code.'
        }
      },
      pipelines: {
        low: [ROLE_WORKER],
        medium: [ROLE_PLANNER, ROLE_WORKER, ROLE_REVIEWER],
        high: [ROLE_PLANNER, ROLE_EXPLORER, ROLE_WORKER, ROLE_REVIEWER]
      },
      stageBudgetsSeconds: {
        planner: DEFAULT_STAGE_BUDGET_PLANNER_SECONDS,
        explorer: DEFAULT_STAGE_BUDGET_EXPLORER_SECONDS,
        reviewer: DEFAULT_STAGE_BUDGET_REVIEWER_SECONDS
      },
      riskModel: {
        thresholds: {
          medium: DEFAULT_RISK_THRESHOLD_MEDIUM,
          high: DEFAULT_RISK_THRESHOLD_HIGH
        },
        weights: {
          declaredMedium: DEFAULT_RISK_WEIGHT_DECLARED_MEDIUM,
          declaredHigh: DEFAULT_RISK_WEIGHT_DECLARED_HIGH,
          dependency: DEFAULT_RISK_WEIGHT_DEPENDENCY,
          sensitiveTag: DEFAULT_RISK_WEIGHT_SENSITIVE_TAG,
          sensitivePath: DEFAULT_RISK_WEIGHT_SENSITIVE_PATH,
          autonomyFull: DEFAULT_RISK_WEIGHT_AUTONOMY_FULL,
          validationFailure: DEFAULT_RISK_WEIGHT_VALIDATION_FAILURE
        },
        sensitiveTags: ['security', 'auth', 'authentication', 'payments', 'pii', 'migration', 'infra'],
        sensitivePaths: ['payments', 'billing', 'auth', 'security', 'migrations', 'db', 'compliance']
      },
      approvalGates: {
        requireSecurityOpsForHigh: true,
        requireSecurityOpsForMediumIfSensitive: true,
        securityApprovalMetadataField: 'Security-Approval'
      },
      providers: {}
    },
    logging: {
      output: DEFAULT_OUTPUT_MODE,
      failureTailLines: DEFAULT_FAILURE_TAIL_LINES,
      heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
      stallWarnSeconds: DEFAULT_STALL_WARN_SECONDS,
      touchSummary: DEFAULT_TOUCH_SUMMARY,
      touchSampleSize: DEFAULT_TOUCH_SAMPLE_SIZE,
      touchScanMode: DEFAULT_TOUCH_SCAN_MODE,
      touchScanMinHeartbeats: DEFAULT_TOUCH_SCAN_MIN_HEARTBEATS,
      touchScanMaxHeartbeats: DEFAULT_TOUCH_SCAN_MAX_HEARTBEATS,
      touchScanBackoffUnchanged: DEFAULT_TOUCH_SCAN_BACKOFF_UNCHANGED,
      liveActivity: {
        mode: DEFAULT_LIVE_ACTIVITY_MODE,
        maxChars: DEFAULT_LIVE_ACTIVITY_MAX_CHARS,
        sampleSeconds: DEFAULT_LIVE_ACTIVITY_SAMPLE_SECONDS,
        emitEventLines: DEFAULT_LIVE_ACTIVITY_EMIT_EVENT_LINES,
        redactPatterns: [...DEFAULT_LIVE_ACTIVITY_REDACT_PATTERNS]
      },
      workerFirstTouchDeadlineSeconds: DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS,
      workerRetryFirstTouchDeadlineSeconds: DEFAULT_WORKER_RETRY_FIRST_TOUCH_DEADLINE_SECONDS,
      workerNoTouchRetryLimit: DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT,
      workerStallFailSeconds: DEFAULT_WORKER_STALL_FAIL_SECONDS
    },
    parallel: {
      maxPlans: DEFAULT_PARALLEL_PLANS,
      worktreeRoot: DEFAULT_PARALLEL_WORKTREE_ROOT,
      branchPrefix: DEFAULT_PARALLEL_BRANCH_PREFIX,
      baseRef: DEFAULT_PARALLEL_BASE_REF,
      gitRemote: DEFAULT_PARALLEL_GIT_REMOTE,
      workerOutputMode: DEFAULT_PARALLEL_WORKER_OUTPUT,
      keepWorktrees: DEFAULT_PARALLEL_KEEP_WORKTREES,
      pushBranches: DEFAULT_PARALLEL_PUSH_BRANCHES,
      openPullRequests: DEFAULT_PARALLEL_OPEN_PULL_REQUESTS,
      assumeDependencyCompletion: DEFAULT_PARALLEL_ASSUME_DEPENDENCY_COMPLETION,
      pullRequest: {
        createCommand: '',
        mergeCommand: ''
      }
    },
    git: {
      atomicCommits: true,
      atomicCommitRoots: {
        defaults: [],
        shared: [],
        allowPlanMetadata: true,
        enforce: true
      }
    }
  };

  const configured = await readJsonIfExists(paths.orchestratorConfigPath, {});
  return {
    ...defaultConfig,
    ...configured,
    executor: {
      ...defaultConfig.executor,
      ...(configured.executor ?? {})
    },
    context: {
      ...defaultConfig.context,
      ...(configured.context ?? {}),
      contactPacks: {
        ...defaultConfig.context.contactPacks,
        ...(configured.context?.contactPacks ?? {})
      }
    },
    continuity: {
      ...defaultConfig.continuity,
      ...(configured.continuity ?? {}),
      checkpointQuality: {
        ...defaultConfig.continuity.checkpointQuality,
        ...(configured.continuity?.checkpointQuality ?? {})
      },
      thresholds: {
        ...defaultConfig.continuity.thresholds,
        ...(configured.continuity?.thresholds ?? {})
      },
      incidentBundles: {
        ...defaultConfig.continuity.incidentBundles,
        ...(configured.continuity?.incidentBundles ?? {})
      }
    },
    validation: {
      ...defaultConfig.validation,
      ...(configured.validation ?? {}),
      host: {
        ...defaultConfig.validation.host,
        ...(configured.validation?.host ?? {}),
        ci: {
          ...defaultConfig.validation.host.ci,
          ...(configured.validation?.host?.ci ?? {})
        },
        local: {
          ...defaultConfig.validation.host.local,
          ...(configured.validation?.host?.local ?? {})
        }
      }
    },
    evidence: {
      ...defaultConfig.evidence,
      ...(configured.evidence ?? {}),
      compaction: {
        ...defaultConfig.evidence.compaction,
        ...(configured.evidence?.compaction ?? {})
      },
      lifecycle: {
        ...defaultConfig.evidence.lifecycle,
        ...(configured.evidence?.lifecycle ?? {})
      }
    },
    semanticProof: {
      ...defaultConfig.semanticProof,
      ...(configured.semanticProof ?? {})
    },
    roleOrchestration: {
      ...defaultConfig.roleOrchestration,
      ...(configured.roleOrchestration ?? {}),
      roleProfiles: {
        ...defaultConfig.roleOrchestration.roleProfiles,
        ...(configured.roleOrchestration?.roleProfiles ?? {})
      },
      pipelines: {
        ...defaultConfig.roleOrchestration.pipelines,
        ...(configured.roleOrchestration?.pipelines ?? {})
      },
      stageBudgetsSeconds: {
        ...defaultConfig.roleOrchestration.stageBudgetsSeconds,
        ...(configured.roleOrchestration?.stageBudgetsSeconds ?? {})
      },
      riskModel: {
        ...defaultConfig.roleOrchestration.riskModel,
        ...(configured.roleOrchestration?.riskModel ?? {}),
        thresholds: {
          ...defaultConfig.roleOrchestration.riskModel.thresholds,
          ...(configured.roleOrchestration?.riskModel?.thresholds ?? {})
        },
        weights: {
          ...defaultConfig.roleOrchestration.riskModel.weights,
          ...(configured.roleOrchestration?.riskModel?.weights ?? {})
        }
      },
      approvalGates: {
        ...defaultConfig.roleOrchestration.approvalGates,
        ...(configured.roleOrchestration?.approvalGates ?? {})
      },
      providers: {
        ...(defaultConfig.roleOrchestration.providers ?? {}),
        ...(configured.roleOrchestration?.providers ?? {})
      }
    },
    logging: {
      ...defaultConfig.logging,
      ...(configured.logging ?? {}),
      liveActivity: {
        ...defaultConfig.logging.liveActivity,
        ...(configured.logging?.liveActivity ?? {})
      }
    },
    parallel: {
      ...defaultConfig.parallel,
      ...(configured.parallel ?? {}),
      pullRequest: {
        ...defaultConfig.parallel.pullRequest,
        ...(configured.parallel?.pullRequest ?? {})
      }
    },
    git: {
      ...defaultConfig.git,
      ...(configured.git ?? {}),
      atomicCommitRoots: {
        ...defaultConfig.git.atomicCommitRoots,
        ...(configured.git?.atomicCommitRoots ?? {})
      }
    }
  };
}

async function acquireRunLock(paths, state, options) {
  if (options.dryRun) {
    return;
  }

  const payload = {
    pid: process.pid,
    runId: state.runId,
    mode: state.effectiveMode,
    acquiredAt: nowIso(),
    cwd: paths.rootDir
  };

  async function tryCreateLock() {
    const handle = await fs.open(paths.runLockPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await tryCreateLock();
      return;
    } catch (error) {
      const code = error?.code;
      if (code !== 'EEXIST') {
        throw error;
      }

      const existing = await readJsonStrict(paths.runLockPath);
      const existingPid = Number.isInteger(existing?.pid) ? existing.pid : null;
      if (existingPid && existingPid !== process.pid && pidIsAlive(existingPid)) {
        throw new Error(
          `Another orchestrator run appears active (pid ${existingPid}, runId ${existing?.runId ?? 'unknown'}).`
        );
      }

      await fs.unlink(paths.runLockPath);
    }
  }

  throw new Error('Unable to acquire orchestrator run lock after stale-lock cleanup.');
}

async function releaseRunLock(paths, options) {
  if (options.dryRun) {
    return;
  }

  const existing = await readJsonIfExists(paths.runLockPath, null);
  if (!existing || existing.pid !== process.pid) {
    return;
  }

  try {
    await fs.unlink(paths.runLockPath);
  } catch {
    // Best-effort cleanup.
  }
}

function configuredExecutorCommand(options, config) {
  return String(config.executor.command || '').trim();
}

function assertExecutorConfigured(options, config) {
  if (options.dryRun) {
    return;
  }

  if (!configuredExecutorCommand(options, config)) {
    throw new Error(
      'No executor command configured. Set docs/ops/automation/orchestrator.config.json executor.command.'
    );
  }
}

function assertValidationConfigured(options, config, paths) {
  if (options.dryRun) {
    return;
  }

  const alwaysValidation = resolveAlwaysValidationCommands(paths.rootDir, options, config);
  if (options.requireAlwaysValidationCommands && alwaysValidation.length === 0) {
    throw new Error(
      'No validation.always commands configured. Set docs/ops/automation/orchestrator.config.json validation.always.'
    );
  }

  const hostValidation = resolveHostRequiredValidationCommands(config);
  if (options.requireHostValidationCommands && hostValidation.length === 0) {
    throw new Error(
      'No validation.hostRequired commands configured. Set docs/ops/automation/orchestrator.config.json validation.hostRequired.'
    );
  }
}

function resolveRuntimeExecutorOptions(options, config) {
  const configContextAbsoluteFloor = asInteger(
    config.executor?.contextAbsoluteFloor ?? config.executor?.contextThreshold,
    DEFAULT_CONTEXT_THRESHOLD
  );
  const contextThreshold = asInteger(
    options.contextAbsoluteFloor ?? options.contextThreshold,
    configContextAbsoluteFloor
  );
  const configContextSoftUsedRatio = asRatio(
    config.executor?.contextSoftUsedRatio,
    DEFAULT_CONTEXT_SOFT_USED_RATIO
  );
  const contextSoftUsedRatio = asRatio(options.contextSoftUsedRatio, configContextSoftUsedRatio);
  const configContextHardUsedRatio = asRatio(
    config.executor?.contextHardUsedRatio,
    DEFAULT_CONTEXT_HARD_USED_RATIO
  );
  const contextHardUsedRatio = Math.max(
    contextSoftUsedRatio,
    asRatio(options.contextHardUsedRatio, configContextHardUsedRatio)
  );
  const configRequireResultPayload = asBoolean(
    config.executor?.requireResultPayload,
    DEFAULT_REQUIRE_RESULT_PAYLOAD
  );
  const requireResultPayload = asBoolean(options.requireResultPayload, configRequireResultPayload);
  const executorTimeoutSeconds = asInteger(
    config.executor?.timeoutSeconds,
    DEFAULT_COMMAND_TIMEOUT_SECONDS
  );
  const validationTimeoutSeconds = asInteger(
    config.validation?.timeoutSeconds,
    DEFAULT_COMMAND_TIMEOUT_SECONDS
  );
  const hostValidationTimeoutSeconds = asInteger(
    config.validation?.host?.ci?.timeoutSeconds ?? config.validation?.host?.timeoutSeconds,
    DEFAULT_HOST_VALIDATION_TIMEOUT_SECONDS
  );
  const requireAlwaysValidationCommands = asBoolean(
    config.validation?.requireAlwaysCommands,
    true
  );
  const requireHostValidationCommands = asBoolean(
    config.validation?.requireHostRequiredCommands,
    true
  );
  const outputMode = normalizeOutputMode(
    options.outputMode ?? options.output ?? config.logging?.output,
    DEFAULT_OUTPUT_MODE
  );
  const failureTailLines = asInteger(
    options.failureTailLines ?? config.logging?.failureTailLines,
    DEFAULT_FAILURE_TAIL_LINES
  );
  const heartbeatSeconds = Math.max(
    3,
    asInteger(options.heartbeatSeconds ?? config.logging?.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS)
  );
  const stallWarnSeconds = Math.max(
    heartbeatSeconds,
    asInteger(options.stallWarnSeconds ?? config.logging?.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS)
  );
  const touchSummary = asBoolean(
    options.touchSummary ?? options['touch-summary'] ?? config.logging?.touchSummary,
    DEFAULT_TOUCH_SUMMARY
  );
  const touchSampleSize = Math.max(
    1,
    asInteger(options.touchSampleSize ?? options['touch-sample-size'] ?? config.logging?.touchSampleSize, DEFAULT_TOUCH_SAMPLE_SIZE)
  );
  const touchScanMode = normalizeTouchScanMode(
    options.touchScanMode ?? options['touch-scan-mode'] ?? config.logging?.touchScanMode,
    DEFAULT_TOUCH_SCAN_MODE
  );
  const touchScanMinHeartbeats = Math.max(
    1,
    asInteger(
      options.touchScanMinHeartbeats ?? options['touch-scan-min-heartbeats'] ?? config.logging?.touchScanMinHeartbeats,
      DEFAULT_TOUCH_SCAN_MIN_HEARTBEATS
    )
  );
  const touchScanMaxHeartbeats = Math.max(
    touchScanMinHeartbeats,
    asInteger(
      options.touchScanMaxHeartbeats ?? options['touch-scan-max-heartbeats'] ?? config.logging?.touchScanMaxHeartbeats,
      DEFAULT_TOUCH_SCAN_MAX_HEARTBEATS
    )
  );
  const touchScanBackoffUnchanged = Math.max(
    1,
    asInteger(
      options.touchScanBackoffUnchanged ??
        options['touch-scan-backoff-unchanged'] ??
        config.logging?.touchScanBackoffUnchanged,
      DEFAULT_TOUCH_SCAN_BACKOFF_UNCHANGED
    )
  );
  const liveActivity = config.logging?.liveActivity ?? {};
  const liveActivityMode = normalizeLiveActivityMode(
    options.liveActivityMode ?? options['live-activity-mode'] ?? liveActivity.mode,
    DEFAULT_LIVE_ACTIVITY_MODE
  );
  const liveActivityMaxChars = Math.max(
    0,
    asInteger(
      options.liveActivityMaxChars ?? options['live-activity-max-chars'] ?? liveActivity.maxChars,
      DEFAULT_LIVE_ACTIVITY_MAX_CHARS
    )
  );
  const liveActivitySampleSeconds = Math.max(
    0,
    asInteger(
      options.liveActivitySampleSeconds ??
        options['live-activity-sample-seconds'] ??
        liveActivity.sampleSeconds,
      DEFAULT_LIVE_ACTIVITY_SAMPLE_SECONDS
    )
  );
  const liveActivityEmitEventLines = asBoolean(
    options.liveActivityEmitEventLines ??
      options['live-activity-emit-event-lines'] ??
      liveActivity.emitEventLines,
    DEFAULT_LIVE_ACTIVITY_EMIT_EVENT_LINES
  );
  const liveActivityRedactPatterns = parseListOption(
    options.liveActivityRedactPatterns ??
      options['live-activity-redact-patterns'] ??
      liveActivity.redactPatterns,
    DEFAULT_LIVE_ACTIVITY_REDACT_PATTERNS
  );
  const workerFirstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(
      options.workerFirstTouchDeadlineSeconds ??
        options['worker-first-touch-deadline-seconds'] ??
        config.logging?.workerFirstTouchDeadlineSeconds,
      DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS
    )
  );
  const workerRetryFirstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(
      options.workerRetryFirstTouchDeadlineSeconds ??
        options['worker-retry-first-touch-deadline-seconds'] ??
        config.logging?.workerRetryFirstTouchDeadlineSeconds ??
        workerFirstTouchDeadlineSeconds,
      workerFirstTouchDeadlineSeconds
    )
  );
  const workerNoTouchRetryLimit = Math.max(
    0,
    asInteger(
      options.workerNoTouchRetryLimit ??
        options['worker-no-touch-retry-limit'] ??
        config.logging?.workerNoTouchRetryLimit,
      DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT
    )
  );
  const workerPendingStreakLimit = Math.max(
    0,
    asInteger(
      options.workerPendingStreakLimit ??
        options['worker-pending-streak-limit'] ??
        config.logging?.workerPendingStreakLimit,
      DEFAULT_WORKER_PENDING_STREAK_LIMIT
    )
  );
  const workerStallFailSeconds = Math.max(
    0,
    asInteger(
      options.workerStallFailSeconds ??
        options['worker-stall-fail-seconds'] ??
        config.logging?.workerStallFailSeconds,
      DEFAULT_WORKER_STALL_FAIL_SECONDS
    )
  );
  const contactPacks = config.context?.contactPacks ?? {};
  const continuity = config.continuity ?? {};
  const continuityCheckpointQuality = continuity.checkpointQuality ?? {};
  const continuityIncidentBundles = continuity.incidentBundles ?? {};
  const contactPackEnabled = asBoolean(
    contactPacks.enabled,
    DEFAULT_CONTACT_PACKS_ENABLED
  );
  const contactPackMaxPolicyBullets = Math.max(
    1,
    asInteger(contactPacks.maxPolicyBullets, DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS)
  );
  const contactPackIncludeRecentEvidence = asBoolean(
    contactPacks.includeRecentEvidence,
    DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE
  );
  const contactPackMaxRecentEvidenceItems = Math.max(
    0,
    asInteger(contactPacks.maxRecentEvidenceItems, DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS)
  );
  const contactPackIncludeLatestState = asBoolean(
    contactPacks.includeLatestState,
    DEFAULT_CONTACT_PACKS_INCLUDE_LATEST_STATE
  );
  const contactPackMaxRecentCheckpointItems = Math.max(
    0,
    asInteger(
      contactPacks.maxRecentCheckpointItems,
      DEFAULT_CONTACT_PACKS_MAX_RECENT_CHECKPOINT_ITEMS
    )
  );
  const contactPackMaxStateListItems = Math.max(
    1,
    asInteger(contactPacks.maxStateListItems, DEFAULT_CONTACT_PACKS_MAX_STATE_LIST_ITEMS)
  );
  const contactPackCacheMode = normalizeContactPackCacheMode(
    contactPacks.cacheMode,
    DEFAULT_CONTACT_PACK_CACHE_MODE
  );
  const continuityMinCompletedScore = asRatio(
    continuityCheckpointQuality.minCompletedScore,
    DEFAULT_CONTINUITY_MIN_COMPLETED_SCORE
  );
  const continuityIncidentBundlesEnabled = asBoolean(
    continuityIncidentBundles.enabled,
    true
  );
  const continuityIncidentEmitOn = Array.isArray(continuityIncidentBundles.emitOn)
    ? continuityIncidentBundles.emitOn.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
    : ['failed', 'degraded'];
  const evidenceSessionCurationMode = normalizeSessionEvidenceMode(
    config.evidence?.sessionCurationMode,
    DEFAULT_EVIDENCE_SESSION_CURATION_MODE
  );
  const evidenceSessionIndexRefreshMode = normalizeSessionEvidenceMode(
    config.evidence?.sessionIndexRefreshMode,
    DEFAULT_EVIDENCE_SESSION_INDEX_REFRESH_MODE
  );
  const retryFailedPlans = asBoolean(
    options.retryFailed ?? options['retry-failed'] ?? config.recovery?.retryFailed,
    DEFAULT_RETRY_FAILED_PLANS
  );
  const autoUnblockPlans = asBoolean(
    options.autoUnblock ?? options['auto-unblock'] ?? config.recovery?.autoUnblock,
    DEFAULT_AUTO_UNBLOCK_PLANS
  );
  const maxFailedRetries = Math.max(
    1,
    asInteger(
      options.maxFailedRetries ?? options['max-failed-retries'] ?? config.recovery?.maxFailedRetries,
      DEFAULT_MAX_FAILED_RETRIES
    )
  );

  return {
    ...options,
    contextThreshold,
    contextAbsoluteFloor: contextThreshold,
    contextSoftUsedRatio,
    contextHardUsedRatio,
    requireResultPayload,
    executorTimeoutMs: timeoutMsFromSeconds(executorTimeoutSeconds),
    validationTimeoutMs: timeoutMsFromSeconds(validationTimeoutSeconds),
    hostValidationTimeoutMs: timeoutMsFromSeconds(hostValidationTimeoutSeconds),
    requireAlwaysValidationCommands,
    requireHostValidationCommands,
    outputMode,
    failureTailLines,
    heartbeatSeconds,
    stallWarnSeconds,
    touchSummary,
    touchSampleSize,
    touchScanMode,
    touchScanMinHeartbeats,
    touchScanMaxHeartbeats,
    touchScanBackoffUnchanged,
    liveActivityMode,
    liveActivityMaxChars,
    liveActivitySampleSeconds,
    liveActivityEmitEventLines,
    liveActivityRedactPatterns,
    workerFirstTouchDeadlineSeconds,
    workerRetryFirstTouchDeadlineSeconds,
    workerNoTouchRetryLimit,
    workerPendingStreakLimit,
    workerStallFailSeconds,
    contactPackEnabled,
    contactPackMaxPolicyBullets,
    contactPackIncludeRecentEvidence,
    contactPackMaxRecentEvidenceItems,
    contactPackIncludeLatestState,
    contactPackMaxRecentCheckpointItems,
    contactPackMaxStateListItems,
    contactPackCacheMode,
    continuityMinCompletedScore,
    continuityIncidentBundlesEnabled,
    continuityIncidentEmitOn,
    evidenceSessionCurationMode,
    evidenceSessionIndexRefreshMode,
    retryFailedPlans,
    autoUnblockPlans,
    maxFailedRetries
  };
}

function normalizedRelativePrefix(value) {
  const normalized = toPosix(String(value ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!normalized) {
    return null;
  }
  assertSafeRelativePlanPath(normalized);
  return normalized;
}

function normalizeRelativePrefixList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const set = new Set();
  for (const value of values) {
    const normalized = normalizedRelativePrefix(value);
    if (normalized) {
      set.add(normalized);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function currentBranchRefOrNull(rootDir) {
  if (!gitAvailable(rootDir)) {
    return null;
  }
  const result = runShellCapture('git symbolic-ref --quiet --short HEAD', rootDir);
  if (result.status !== 0) {
    return null;
  }
  const branch = String(result.stdout ?? '').trim();
  return branch || null;
}

function resolveParallelBaseRef(rootDir, requestedBaseRef) {
  const raw = String(requestedBaseRef ?? '').trim();
  if (!raw) {
    return DEFAULT_PARALLEL_BASE_REF;
  }
  const token = raw.toUpperCase();
  if (token === 'CURRENT' || token === 'CURRENT_BRANCH' || token === 'HEAD') {
    return currentBranchRefOrNull(rootDir) ?? 'HEAD';
  }
  return raw;
}

function resolveParallelExecutionOptions(rootDir, options, config) {
  const configParallel = config?.parallel ?? {};
  const parallelPlans = Math.max(
    1,
    asInteger(options.parallelPlans ?? options['parallel-plans'] ?? configParallel.maxPlans, DEFAULT_PARALLEL_PLANS)
  );
  const worktreeRoot = normalizedRelativePrefix(configParallel.worktreeRoot ?? DEFAULT_PARALLEL_WORKTREE_ROOT);
  const branchPrefix =
    String(options.branchPrefix ?? options['branch-prefix'] ?? configParallel.branchPrefix ?? DEFAULT_PARALLEL_BRANCH_PREFIX)
      .trim() || DEFAULT_PARALLEL_BRANCH_PREFIX;
  const requestedBaseRef =
    options.baseRef ?? options['base-ref'] ?? configParallel.baseRef ?? DEFAULT_PARALLEL_BASE_REF;
  const baseRef = resolveParallelBaseRef(rootDir, requestedBaseRef);
  const gitRemote =
    String(options.gitRemote ?? options['git-remote'] ?? configParallel.gitRemote ?? DEFAULT_PARALLEL_GIT_REMOTE).trim()
      || DEFAULT_PARALLEL_GIT_REMOTE;
  const parentOutputMode = normalizeOutputMode(options.outputMode, DEFAULT_OUTPUT_MODE);
  const workerOutputMode = normalizeOutputMode(
    configParallel.workerOutputMode ?? parentOutputMode,
    parentOutputMode
  );
  return {
    parallelPlans,
    worktreeRoot: worktreeRoot ?? DEFAULT_PARALLEL_WORKTREE_ROOT,
    branchPrefix,
    baseRef,
    gitRemote,
    workerOutputMode,
    keepWorktrees: asBoolean(configParallel.keepWorktrees, DEFAULT_PARALLEL_KEEP_WORKTREES),
    pushBranches: asBoolean(configParallel.pushBranches, DEFAULT_PARALLEL_PUSH_BRANCHES),
    openPullRequests: asBoolean(configParallel.openPullRequests, DEFAULT_PARALLEL_OPEN_PULL_REQUESTS),
    assumeDependencyCompletion: asBoolean(
      configParallel.assumeDependencyCompletion,
      DEFAULT_PARALLEL_ASSUME_DEPENDENCY_COMPLETION
    ),
    pullRequest: {
      createCommand: String(configParallel.pullRequest?.createCommand ?? '').trim(),
      mergeCommand: String(configParallel.pullRequest?.mergeCommand ?? '').trim()
    }
  };
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function sanitizeBranchToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '');
}

function normalizeRoleName(value, fallback = ROLE_WORKER) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ROLE_NAMES.has(normalized) ? normalized : fallback;
}

function normalizeRolePipeline(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }
  const normalized = value
    .map((entry) => normalizeRoleName(entry, ''))
    .filter((entry) => ROLE_NAMES.has(entry));
  return normalized.length > 0 ? normalized : fallback;
}

function resolveRoleOrchestration(config) {
  const source = config?.roleOrchestration ?? {};
  const riskModel = source.riskModel ?? {};
  const thresholds = riskModel.thresholds ?? {};
  const weights = riskModel.weights ?? {};
  const stageReuseSource = source.stageReuse ?? {};
  const stageBudgetsSource = source.stageBudgetsSeconds ?? {};
  const stageReuseRoles = Array.isArray(stageReuseSource.roles)
    ? stageReuseSource.roles
      .map((entry) => normalizeRoleName(entry, ''))
      .filter((entry) => ROLE_NAMES.has(entry))
    : [ROLE_PLANNER, ROLE_EXPLORER];
  return {
    enabled: asBoolean(source.enabled, DEFAULT_ROLE_ORCHESTRATION_ENABLED),
    mode: String(source.mode ?? 'risk-adaptive').trim().toLowerCase(),
    pipelines: {
      low: normalizeRolePipeline(source.pipelines?.low, [ROLE_WORKER]),
      medium: normalizeRolePipeline(source.pipelines?.medium, [ROLE_PLANNER, ROLE_WORKER, ROLE_REVIEWER]),
      high: normalizeRolePipeline(source.pipelines?.high, [ROLE_PLANNER, ROLE_EXPLORER, ROLE_WORKER, ROLE_REVIEWER])
    },
    stageBudgetsSeconds: {
      planner: Math.max(0, asInteger(stageBudgetsSource.planner, DEFAULT_STAGE_BUDGET_PLANNER_SECONDS)),
      explorer: Math.max(0, asInteger(stageBudgetsSource.explorer, DEFAULT_STAGE_BUDGET_EXPLORER_SECONDS)),
      reviewer: Math.max(0, asInteger(stageBudgetsSource.reviewer, DEFAULT_STAGE_BUDGET_REVIEWER_SECONDS))
    },
    stageReuse: {
      enabled: asBoolean(stageReuseSource.enabled, DEFAULT_STAGE_REUSE_ENABLED),
      roles: stageReuseRoles.length > 0 ? [...new Set(stageReuseRoles)] : [ROLE_PLANNER, ROLE_EXPLORER],
      sameRunOnly: asBoolean(stageReuseSource.sameRunOnly, DEFAULT_STAGE_REUSE_SAME_RUN_ONLY),
      maxAgeMinutes: Math.max(0, asInteger(stageReuseSource.maxAgeMinutes, DEFAULT_STAGE_REUSE_MAX_AGE_MINUTES)),
      requiresStablePlanHash: asBoolean(
        stageReuseSource.requiresStablePlanHash,
        DEFAULT_STAGE_REUSE_REQUIRES_STABLE_PLAN_HASH
      ),
      requiresNoScopeChange: asBoolean(
        stageReuseSource.requiresNoScopeChange,
        DEFAULT_STAGE_REUSE_REQUIRES_NO_SCOPE_CHANGE
      )
    },
    riskModel: {
      thresholds: {
        medium: asInteger(thresholds.medium, DEFAULT_RISK_THRESHOLD_MEDIUM),
        high: asInteger(thresholds.high, DEFAULT_RISK_THRESHOLD_HIGH)
      },
      weights: {
        declaredMedium: asInteger(weights.declaredMedium, DEFAULT_RISK_WEIGHT_DECLARED_MEDIUM),
        declaredHigh: asInteger(weights.declaredHigh, DEFAULT_RISK_WEIGHT_DECLARED_HIGH),
        dependency: asInteger(weights.dependency, DEFAULT_RISK_WEIGHT_DEPENDENCY),
        sensitiveTag: asInteger(weights.sensitiveTag, DEFAULT_RISK_WEIGHT_SENSITIVE_TAG),
        sensitivePath: asInteger(weights.sensitivePath, DEFAULT_RISK_WEIGHT_SENSITIVE_PATH),
        autonomyFull: asInteger(weights.autonomyFull, DEFAULT_RISK_WEIGHT_AUTONOMY_FULL),
        validationFailure: asInteger(weights.validationFailure, DEFAULT_RISK_WEIGHT_VALIDATION_FAILURE)
      },
      sensitiveTags: Array.isArray(riskModel.sensitiveTags)
        ? riskModel.sensitiveTags.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : ['security', 'auth', 'authentication', 'payments', 'pii', 'migration', 'infra'],
      sensitivePaths: Array.isArray(riskModel.sensitivePaths)
        ? riskModel.sensitivePaths.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : ['payments', 'billing', 'auth', 'security', 'migrations', 'db', 'compliance']
    },
    approvalGates: {
      requireSecurityOpsForHigh: asBoolean(source.approvalGates?.requireSecurityOpsForHigh, true),
      requireSecurityOpsForMediumIfSensitive: asBoolean(
        source.approvalGates?.requireSecurityOpsForMediumIfSensitive,
        true
      ),
      securityApprovalMetadataField: String(
        source.approvalGates?.securityApprovalMetadataField ?? 'Security-Approval'
      )
    }
  };
}

function riskTierOrder(value) {
  return RISK_TIER_ORDER[String(value ?? 'low').trim().toLowerCase()] ?? RISK_TIER_ORDER.low;
}

function maxRiskTier(a, b) {
  return riskTierOrder(a) >= riskTierOrder(b) ? a : b;
}

function sensitivityMatches(values, needles) {
  const hits = [];
  const normalizedValues = values.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean);
  for (const needle of needles) {
    for (const value of normalizedValues) {
      if (value.includes(needle)) {
        hits.push({ needle, value });
        break;
      }
    }
  }
  return hits;
}

function computedRiskTierFromScore(score, thresholds) {
  if (score >= thresholds.high) {
    return 'high';
  }
  if (score >= thresholds.medium) {
    return 'medium';
  }
  return 'low';
}

function computeRiskAssessment(plan, state, config) {
  const roleConfig = resolveRoleOrchestration(config);
  const weights = roleConfig.riskModel.weights;
  const thresholds = roleConfig.riskModel.thresholds;
  let score = 0;
  const reasons = [];
  const declaredRiskTier = parseRiskTier(plan.riskTier, 'low');

  if (declaredRiskTier === 'medium') {
    score += weights.declaredMedium;
    reasons.push(`declared risk tier medium (+${weights.declaredMedium})`);
  } else if (declaredRiskTier === 'high') {
    score += weights.declaredHigh;
    reasons.push(`declared risk tier high (+${weights.declaredHigh})`);
  }

  if (plan.dependencies.length > 0) {
    const dependencyScore = Math.min(3, plan.dependencies.length) * weights.dependency;
    score += dependencyScore;
    reasons.push(`dependencies (${plan.dependencies.length}) (+${dependencyScore})`);
  }

  const tagMatches = sensitivityMatches(plan.tags, roleConfig.riskModel.sensitiveTags);
  if (tagMatches.length > 0) {
    const tagScore = Math.min(2, tagMatches.length) * weights.sensitiveTag;
    score += tagScore;
    reasons.push(`sensitive tags (${tagMatches.map((hit) => hit.value).join(', ')}) (+${tagScore})`);
  }

  const scopeMatches = sensitivityMatches(plan.specTargets, roleConfig.riskModel.sensitivePaths);
  if (scopeMatches.length > 0) {
    const scopeScore = Math.min(2, scopeMatches.length) * weights.sensitivePath;
    score += scopeScore;
    reasons.push(`sensitive paths (${scopeMatches.map((hit) => hit.value).join(', ')}) (+${scopeScore})`);
  }

  if (String(plan.autonomyAllowed ?? '').trim().toLowerCase() === 'full') {
    score += weights.autonomyFull;
    reasons.push(`autonomy full (+${weights.autonomyFull})`);
  }

  const validationState = state.validationState?.[plan.planId] ?? {};
  if (validationState.always === 'failed' || validationState.host === 'failed') {
    score += weights.validationFailure;
    reasons.push(`previous validation failure (+${weights.validationFailure})`);
  }

  const computedRiskTier = computedRiskTierFromScore(score, thresholds);
  const effectiveRiskTier = maxRiskTier(computedRiskTier, declaredRiskTier);
  const sensitive = tagMatches.length > 0 || scopeMatches.length > 0;

  return {
    declaredRiskTier,
    computedRiskTier,
    effectiveRiskTier,
    score,
    reasons,
    sensitive,
    sensitiveTagHits: tagMatches.map((hit) => hit.value),
    sensitivePathHits: scopeMatches.map((hit) => hit.value)
  };
}

function resolvePipelineStages(assessment, config) {
  const roleConfig = resolveRoleOrchestration(config);
  if (!roleConfig.enabled) {
    return [ROLE_WORKER];
  }
  const tier = parseRiskTier(assessment.effectiveRiskTier, 'low');
  const stages = roleConfig.pipelines[tier] ?? roleConfig.pipelines.low;
  return normalizeRolePipeline(stages, [ROLE_WORKER]);
}

function ensureRoleState(state, plan, assessment, stages, config) {
  if (!state.roleState || typeof state.roleState !== 'object') {
    state.roleState = {};
  }

  const planId = plan.planId;
  const roleConfig = resolveRoleOrchestration(config);
  const stageReuse = roleConfig.stageReuse;
  const stageKey = stages.join('>');
  const planShapeHash = computePlanShapeHash(plan);
  const scopeSignature = [...(plan.specTargets ?? [])].sort().join('|');
  const existing = state.roleState[planId];
  if (
    existing &&
    existing.stageKey === stageKey &&
    existing.effectiveRiskTier === assessment.effectiveRiskTier
  ) {
    return existing;
  }

  const existingUpdatedAtMs = parseIsoMillis(existing?.updatedAt);
  const maxAgeMs = Math.max(0, stageReuse.maxAgeMinutes) * 60 * 1000;
  const ageEligible =
    existingUpdatedAtMs != null &&
    (maxAgeMs <= 0 || Date.now() - existingUpdatedAtMs <= maxAgeMs);
  const shapeEligible = !stageReuse.requiresStablePlanHash || existing?.planShapeHash === planShapeHash;
  const scopeEligible = !stageReuse.requiresNoScopeChange || existing?.scopeSignature === scopeSignature;
  const runEligible = !stageReuse.sameRunOnly || existing?.runId === state.runId;

  const completedExisting = new Set(
    Array.isArray(existing?.completedStages)
      ? existing.completedStages.map((entry) => normalizeRoleName(entry, ''))
      : []
  );
  const reusableRoles = new Set(stageReuse.roles ?? []);
  const reusablePrefixStages = [];
  if (stageReuse.enabled && existing && ageEligible && shapeEligible && scopeEligible && runEligible) {
    for (const role of stages) {
      const normalizedRole = normalizeRoleName(role, '');
      if (!normalizedRole || !completedExisting.has(normalizedRole) || !reusableRoles.has(normalizedRole)) {
        break;
      }
      reusablePrefixStages.push(normalizedRole);
    }
  }

  const currentIndex = Math.min(reusablePrefixStages.length, Math.max(0, stages.length - 1));
  const next = {
    stages: [...stages],
    stageKey,
    currentIndex,
    completedStages: [...new Set(reusablePrefixStages)],
    declaredRiskTier: assessment.declaredRiskTier,
    computedRiskTier: assessment.computedRiskTier,
    effectiveRiskTier: assessment.effectiveRiskTier,
    score: assessment.score,
    sensitive: assessment.sensitive,
    sensitiveTagHits: assessment.sensitiveTagHits ?? [],
    sensitivePathHits: assessment.sensitivePathHits ?? [],
    reasons: assessment.reasons ?? [],
    runId: state.runId,
    planShapeHash,
    scopeSignature,
    reusedPrefixStages: [...new Set(reusablePrefixStages)],
    updatedAt: nowIso()
  };
  state.roleState[planId] = next;
  return next;
}

function advanceRoleState(roleState, role) {
  const completed = new Set(Array.isArray(roleState.completedStages) ? roleState.completedStages : []);
  completed.add(role);
  roleState.completedStages = [...completed];
  if (roleState.currentIndex < roleState.stages.length - 1) {
    roleState.currentIndex += 1;
  }
  roleState.updatedAt = nowIso();
}

function resetRoleStateToImplementation(roleState) {
  const workerIndex = roleState.stages.indexOf(ROLE_WORKER);
  if (workerIndex >= 0) {
    roleState.currentIndex = workerIndex;
  } else {
    roleState.currentIndex = Math.max(0, roleState.stages.length - 1);
  }
  roleState.updatedAt = nowIso();
}

function setRoleStateToRole(roleState, role) {
  const targetRole = normalizeRoleName(role, ROLE_WORKER);
  const targetIndex = roleState.stages.indexOf(targetRole);
  if (targetIndex >= 0) {
    roleState.currentIndex = targetIndex;
  } else {
    resetRoleStateToImplementation(roleState);
  }
  roleState.updatedAt = nowIso();
}

function pendingReasonSuggestsImplementationHandoff(reason) {
  const text = String(reason ?? '').trim().toLowerCase();
  if (!text) {
    return false;
  }

  return (
    text.includes('implementation') ||
    text.includes('worker') ||
    text.includes('handoff') ||
    text.includes('implementation-ready') ||
    text.includes('implementation ready') ||
    text.includes('ready for implementation') ||
    text.includes('ready for worker') ||
    text.includes('proceed to worker') ||
    text.includes('apply code changes') ||
    text.includes('apply source changes') ||
    text.includes('code edit') ||
    text.includes('code change') ||
    text.includes('read-only') ||
    text.includes('read only') ||
    text.includes('cannot apply plan doc edits')
  );
}

function resolvePendingNextRole(currentRole, roleState, roleIndex, pendingReason) {
  if (currentRole === ROLE_REVIEWER) {
    return ROLE_WORKER;
  }

  if (currentRole !== ROLE_PLANNER && currentRole !== ROLE_EXPLORER) {
    return currentRole;
  }

  if (!pendingReasonSuggestsImplementationHandoff(pendingReason)) {
    return currentRole;
  }

  const nextRoleIndex = Math.min(roleIndex + 1, Math.max(0, roleState.stages.length - 1));
  const nextRoleCandidate = roleState.stages[nextRoleIndex] ?? currentRole;
  return normalizeRoleName(nextRoleCandidate, currentRole);
}

function pendingSignalSignature(role, nextRole, reason) {
  const normalizedRole = normalizeRoleName(role, ROLE_WORKER);
  const normalizedNextRole = normalizeRoleName(nextRole, normalizedRole);
  const normalizedReason = String(reason ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return `${normalizedRole}->${normalizedNextRole}|${normalizedReason}`;
}

function approvalEnvPrefixForRiskTier(riskTier) {
  const normalized = parseRiskTier(riskTier, 'low');
  if (normalized === 'high') {
    return 'ORCH_APPROVED_MEDIUM=1 ORCH_APPROVED_HIGH=1 ';
  }
  if (normalized === 'medium') {
    return 'ORCH_APPROVED_MEDIUM=1 ';
  }
  return '';
}

function suggestedResumeCommand(state, riskTier) {
  const mode = String(state?.effectiveMode ?? 'guarded').trim() || 'guarded';
  return (
    `${approvalEnvPrefixForRiskTier(riskTier)}node ./scripts/automation/orchestrator.mjs ` +
    `resume --mode ${mode} --retry-failed true --auto-unblock true --max-plans 1 --allow-dirty true --commit false`
  );
}

function deriveOutcomeNextSteps(plan, outcome, state, config, riskTier) {
  const status = String(outcome?.outcome ?? '').trim().toLowerCase();
  const reason = String(outcome?.reason ?? '').trim();
  const reasonLower = reason.toLowerCase();
  const steps = [];
  const resumeCommand = suggestedResumeCommand(state, riskTier);
  const securityApprovalField =
    resolveRoleOrchestration(config).approvalGates.securityApprovalMetadataField || 'Security-Approval';

  if (status === 'blocked') {
    if (reasonLower.includes('security approval required')) {
      steps.push(`Set '${securityApprovalField}: approved' in the active plan metadata.`);
      steps.push(`Resume: ${resumeCommand}`);
      return steps;
    }
    if (reasonLower.includes('dependency')) {
      steps.push('Complete missing dependency plans first, then resume.');
      steps.push(`Resume: ${resumeCommand}`);
      return steps;
    }
    steps.push('Run `npm run automation:audit -- --json true` to inspect blocker details.');
    steps.push(`Resume: ${resumeCommand}`);
    return steps;
  }

  if (status === 'failed') {
    if (reasonLower.includes('executor exited with status') || reasonLower.includes('executor failed')) {
      steps.push(`Inspect latest session logs in docs/ops/automation/runtime/${state.runId}/.`);
    }
    if (reasonLower.includes('outside declared implementation-targets')) {
      steps.push('Update plan `Implementation-Targets` to include the needed code roots, or revert the out-of-scope edits, then resume.');
    }
    if (reasonLower.includes('atomic root policy violation')) {
      steps.push('Stage only plan-scoped files (or run with `--commit false`) while unrelated workspace changes exist.');
    }
    steps.push(`Retry: ${resumeCommand}`);
    return steps;
  }

  if (status === 'pending') {
    if (reasonLower.includes('repeated pending signal without progress')) {
      steps.push('Update the active plan with one concrete worker action (or mark current role stage complete) before retry.');
    } else if (reasonLower.includes('maximum sessions reached without completion')) {
      steps.push('Narrow to one implementation slice, then resume.');
    } else if (reasonLower.includes('host validation pending')) {
      steps.push('Run required host validations (for example `npm run verify:full`) and resume.');
    }
    steps.push(`Continue: ${resumeCommand}`);
    return steps;
  }

  return steps;
}

function requiresSecurityApproval(plan, assessment, config) {
  const roleConfig = resolveRoleOrchestration(config);
  if (!roleConfig.enabled) {
    return false;
  }
  if (assessment.effectiveRiskTier === 'high' && roleConfig.approvalGates.requireSecurityOpsForHigh) {
    return true;
  }
  if (
    assessment.effectiveRiskTier === 'medium' &&
    assessment.sensitive &&
    roleConfig.approvalGates.requireSecurityOpsForMediumIfSensitive
  ) {
    return true;
  }
  return false;
}

function runtimeSecurityApprovalGranted(assessment, config) {
  if (!requiresSecurityApproval({}, assessment, config)) {
    return false;
  }

  const effectiveRiskTier = parseRiskTier(assessment?.effectiveRiskTier, 'low');
  if (effectiveRiskTier === 'high') {
    return process.env.ORCH_APPROVED_HIGH === '1';
  }
  if (effectiveRiskTier === 'medium') {
    return process.env.ORCH_APPROVED_MEDIUM === '1';
  }
  return false;
}

function resolvedSecurityApproval(plan, assessment, config) {
  const securityApprovalField =
    resolveRoleOrchestration(config).approvalGates.securityApprovalMetadataField || 'Security-Approval';
  const metadataSecurityApproval = parseSecurityApproval(
    metadataValue(plan.metadata, securityApprovalField),
    plan.securityApproval
  );

  if (!requiresSecurityApproval(plan, assessment, config)) {
    return {
      securityApprovalField,
      securityApprovalValue: metadataSecurityApproval,
      metadataSecurityApproval,
      source: 'metadata',
      runtimeGranted: false
    };
  }

  if (metadataSecurityApproval === SECURITY_APPROVAL_APPROVED) {
    return {
      securityApprovalField,
      securityApprovalValue: SECURITY_APPROVAL_APPROVED,
      metadataSecurityApproval,
      source: 'metadata',
      runtimeGranted: true
    };
  }

  const runtimeGranted = runtimeSecurityApprovalGranted(assessment, config);
  return {
    securityApprovalField,
    securityApprovalValue: runtimeGranted ? SECURITY_APPROVAL_APPROVED : metadataSecurityApproval,
    metadataSecurityApproval,
    source: runtimeGranted ? 'runtime-env' : 'metadata',
    runtimeGranted
  };
}

async function persistSecurityApproval(plan, securityApprovalField, securityApprovalValue, dryRun) {
  if (dryRun) {
    return;
  }

  const rawPlan = await fs.readFile(plan.filePath, 'utf8');
  const updatedPlan = setMetadataFields(rawPlan, {
    [securityApprovalField]: securityApprovalValue
  });
  await fs.writeFile(plan.filePath, updatedPlan, 'utf8');

  if (plan.metadata instanceof Map) {
    plan.metadata.set(securityApprovalField, securityApprovalValue);
  }
  plan.securityApproval = securityApprovalValue;
}

function createInitialState(runId, requestedMode, effectiveMode) {
  return {
    version: 6,
    runId,
    requestedMode,
    effectiveMode,
    startedAt: nowIso(),
    lastUpdated: nowIso(),
    queue: [],
    completedPlanIds: [],
    blockedPlanIds: [],
    failedPlanIds: [],
    capabilities: {
      dockerSocket: false,
      dockerSocketPath: null,
      localhostBind: false,
      browserRuntime: false,
      checkedAt: null
    },
    validationState: {},
    validationResults: {},
    recoveryState: {},
    continuationState: {},
    sessionState: {},
    evidenceState: {},
    implementationState: {},
    roleState: {},
    parallelState: {
      activeWorkers: {},
      lastResults: {}
    },
    inProgress: null,
    stats: {
      promotions: 0,
      handoffs: 0,
      validationFailures: 0,
      commits: 0
    }
  };
}

function normalizePersistedState(state) {
  const normalized = { ...(state ?? {}) };
  normalized.queue = Array.isArray(normalized.queue) ? normalized.queue : [];
  normalized.completedPlanIds = Array.isArray(normalized.completedPlanIds) ? normalized.completedPlanIds : [];
  normalized.blockedPlanIds = Array.isArray(normalized.blockedPlanIds) ? normalized.blockedPlanIds : [];
  normalized.failedPlanIds = Array.isArray(normalized.failedPlanIds) ? normalized.failedPlanIds : [];
  normalized.validationState =
    normalized.validationState && typeof normalized.validationState === 'object' ? normalized.validationState : {};
  normalized.validationResults =
    normalized.validationResults && typeof normalized.validationResults === 'object' ? normalized.validationResults : {};
  normalized.recoveryState =
    normalized.recoveryState && typeof normalized.recoveryState === 'object' ? normalized.recoveryState : {};
  normalized.continuationState =
    normalized.continuationState && typeof normalized.continuationState === 'object'
      ? normalized.continuationState
      : {};
  normalized.sessionState =
    normalized.sessionState && typeof normalized.sessionState === 'object'
      ? normalized.sessionState
      : {};
  normalized.evidenceState =
    normalized.evidenceState && typeof normalized.evidenceState === 'object' ? normalized.evidenceState : {};
  normalized.implementationState =
    normalized.implementationState && typeof normalized.implementationState === 'object'
      ? normalized.implementationState
      : {};
  normalized.roleState =
    normalized.roleState && typeof normalized.roleState === 'object' ? normalized.roleState : {};
  normalized.parallelState =
    normalized.parallelState && typeof normalized.parallelState === 'object'
      ? normalized.parallelState
      : { activeWorkers: {}, lastResults: {} };
  normalized.parallelState.activeWorkers =
    normalized.parallelState.activeWorkers && typeof normalized.parallelState.activeWorkers === 'object'
      ? normalized.parallelState.activeWorkers
      : {};
  normalized.parallelState.lastResults =
    normalized.parallelState.lastResults && typeof normalized.parallelState.lastResults === 'object'
      ? normalized.parallelState.lastResults
      : {};
  normalized.capabilities =
    normalized.capabilities && typeof normalized.capabilities === 'object'
      ? normalized.capabilities
      : {
          dockerSocket: false,
          dockerSocketPath: null,
          localhostBind: false,
          browserRuntime: false,
          checkedAt: null
        };
  normalized.stats =
    normalized.stats && typeof normalized.stats === 'object'
      ? {
          promotions: asInteger(normalized.stats.promotions, 0),
          handoffs: asInteger(normalized.stats.handoffs, 0),
          validationFailures: asInteger(normalized.stats.validationFailures, 0),
          commits: asInteger(normalized.stats.commits, 0)
        }
      : {
          promotions: 0,
          handoffs: 0,
          validationFailures: 0,
          commits: 0
        };
  return normalized;
}

function dockerSocketCandidates() {
  const candidates = [];
  const dockerHost = String(process.env.DOCKER_HOST || '').trim();
  if (dockerHost.startsWith('unix://')) {
    candidates.push(dockerHost.replace(/^unix:\/\//, ''));
  }
  candidates.push(path.join(os.homedir(), '.docker', 'run', 'docker.sock'));
  candidates.push('/var/run/docker.sock');
  return [...new Set(candidates)];
}

async function detectLocalhostBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function detectCapabilities() {
  let dockerSocketPath = null;
  for (const candidate of dockerSocketCandidates()) {
    try {
      await fs.access(candidate, fsSync.constants.R_OK | fsSync.constants.W_OK);
      dockerSocketPath = candidate;
      break;
    } catch {
      // Continue candidate scan.
    }
  }

  const localhostBind = await detectLocalhostBind();

  return {
    dockerSocket: Boolean(dockerSocketPath),
    dockerSocketPath,
    localhostBind,
    browserRuntime: localhostBind,
    checkedAt: nowIso()
  };
}

function ensurePlanValidationState(state, planId) {
  if (!state.validationState || typeof state.validationState !== 'object') {
    state.validationState = {};
  }
  if (!state.validationState[planId] || typeof state.validationState[planId] !== 'object') {
    state.validationState[planId] = {
      always: 'pending',
      host: 'pending',
      provider: null,
      reason: null,
      updatedAt: null
    };
  }
  return state.validationState[planId];
}

function updatePlanValidationState(state, planId, patch) {
  const current = ensurePlanValidationState(state, planId);
  state.validationState[planId] = {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
}

function proofTypeIsStrong(type, validationRef = '') {
  if (String(validationRef ?? '').trim().startsWith('repo:')) {
    return false;
  }
  return type === 'integration' || type === 'contract' || type === 'end-to-end' || type === 'host-required';
}

function proofResultMatchesReference(result, reference) {
  if (!result || !reference) {
    return false;
  }
  if (result.validationId === reference) {
    return true;
  }
  if (result.outputLogPath === reference) {
    return true;
  }
  return (
    (Array.isArray(result.artifactRefs) && result.artifactRefs.includes(reference)) ||
    (Array.isArray(result.evidenceRefs) && result.evidenceRefs.includes(reference))
  );
}

function semanticProofEvaluationMode(config) {
  return normalizeSemanticProofMode(config?.semanticProof?.mode);
}

function evaluateSemanticProofCoverage(plan, state, config) {
  if (!isProductPlan(plan) || isProgramPlan(plan)) {
    return {
      applicable: false,
      mode: semanticProofEvaluationMode(config),
      satisfied: true,
      issues: [],
      mustLandCoverage: [],
      proofStatuses: []
    };
  }

  const content = plan?.content ?? '';
  const mustLandEntries = parseMustLandChecklist(content);
  const proofMap = parseCapabilityProofMap(content);
  const issues = [];
  const proofStatuses = [];
  const mustLandCoverage = [];
  const mode = semanticProofEvaluationMode(config);

  if (mustLandEntries.some((entry) => !entry.id)) {
    issues.push('Product slice must-land items are missing stable IDs.');
  }
  if (!/^##\s+Capability Proof Map\s*$/m.test(content)) {
    issues.push(`Plan is missing '## ${CAPABILITY_PROOF_MAP_SECTION}'.`);
  }
  for (const error of proofMap.errors) {
    issues.push(error);
  }

  const validationResults = state?.validationResults?.[plan.planId] ?? { always: [], 'host-required': [] };
  const allResults = [
    ...(Array.isArray(validationResults.always) ? validationResults.always : []),
    ...(Array.isArray(validationResults['host-required']) ? validationResults['host-required'] : [])
  ];
  const implementationRecordedAt = trimmedString(state?.implementationState?.[plan.planId]?.lastRecordedAt);
  const implementationRecordedAtMs = implementationRecordedAt ? Date.parse(implementationRecordedAt) : Number.NaN;
  const capabilitiesByMustLand = new Map();
  const proofsByCapability = new Map();

  for (const capability of proofMap.capabilities) {
    for (const mustLandId of capability.mustLandIds) {
      if (!capabilitiesByMustLand.has(mustLandId)) {
        capabilitiesByMustLand.set(mustLandId, []);
      }
      capabilitiesByMustLand.get(mustLandId).push(capability);
    }
  }
  for (const proof of proofMap.proofs) {
    if (!proofsByCapability.has(proof.capabilityId)) {
      proofsByCapability.set(proof.capabilityId, []);
    }
    proofsByCapability.get(proof.capabilityId).push(proof);
  }

  const capabilitySatisfied = new Map();
  for (const capability of proofMap.capabilities) {
    const proofs = proofsByCapability.get(capability.capabilityId) ?? [];
    let hasStrongFreshProof = false;
    let hasAnyFreshProof = false;

    for (const proof of proofs) {
      const matchedResult = allResults.find((result) => proofResultMatchesReference(result, proof.validationRef));
      const matched = Boolean(matchedResult) && matchedResult.status === 'passed';
      const finishedAtMs = matchedResult?.finishedAt ? Date.parse(matchedResult.finishedAt) : Number.NaN;
      const fresh = !matched
        ? false
        : !Number.isFinite(implementationRecordedAtMs) || !Number.isFinite(finishedAtMs) || finishedAtMs >= implementationRecordedAtMs;
      const strong = proofTypeIsStrong(proof.type, proof.validationRef);
      if (matched && fresh) {
        hasAnyFreshProof = true;
      }
      if (matched && fresh && strong) {
        hasStrongFreshProof = true;
      }
      proofStatuses.push({
        proofId: proof.proofId,
        capabilityId: proof.capabilityId,
        validationRef: proof.validationRef,
        type: proof.type,
        status: !matchedResult
          ? 'missing'
          : matchedResult.status !== 'passed'
            ? matchedResult.status
            : !fresh
              ? 'stale'
              : strong
                ? 'strong'
                : 'weak'
      });
    }

    const requiredStrong = capability.requiredStrength === 'strong';
    capabilitySatisfied.set(capability.capabilityId, requiredStrong ? hasStrongFreshProof : hasAnyFreshProof);
    if (proofs.length === 0) {
      issues.push(`Capability '${capability.capabilityId}' has no proof rows.`);
    } else if (!capabilitySatisfied.get(capability.capabilityId)) {
      issues.push(
        requiredStrong
          ? `Capability '${capability.capabilityId}' lacks a fresh strong proof.`
          : `Capability '${capability.capabilityId}' lacks a fresh proof.`
      );
    }
  }

  for (const mustLandEntry of mustLandEntries) {
    if (!mustLandEntry.id) {
      continue;
    }
    const mappedCapabilities = capabilitiesByMustLand.get(mustLandEntry.id) ?? [];
    const satisfied = mappedCapabilities.length > 0 && mappedCapabilities.every((capability) => capabilitySatisfied.get(capability.capabilityId) === true);
    mustLandCoverage.push({
      mustLandId: mustLandEntry.id,
      satisfied,
      capabilities: mappedCapabilities.map((capability) => capability.capabilityId)
    });
    if (mappedCapabilities.length === 0) {
      issues.push(`Must-land item '${mustLandEntry.id}' is not mapped to any capability.`);
    }
  }

  return {
    applicable: true,
    mode,
    satisfied: mustLandCoverage.every((entry) => entry.satisfied) && issues.length === 0,
    issues: [...new Set(issues)],
    mustLandCoverage,
    proofStatuses
  };
}

function semanticProofCoverageLines(report) {
  if (!report?.applicable) {
    return ['- Semantic proof not required for this plan.'];
  }
  const lines = [
    `- Mode: ${report.mode}`,
    `- Satisfied: ${report.satisfied ? 'yes' : 'no'}`
  ];
  if (report.mustLandCoverage.length === 0) {
    lines.push('- Must-Land Coverage: none recorded');
  } else {
    for (const entry of report.mustLandCoverage) {
      lines.push(
        `- Must-Land ${entry.mustLandId}: ${entry.satisfied ? 'covered' : 'uncovered'} (${entry.capabilities.length > 0 ? entry.capabilities.join(', ') : 'no capabilities'})`
      );
    }
  }
  for (const issue of report.issues.slice(0, 10)) {
    lines.push(`- Issue: ${issue}`);
  }
  return lines;
}

async function writeSemanticProofManifest(paths, state, plan, report, options) {
  if (options.dryRun || !state?.runId) {
    return null;
  }
  const baseDir = path.join(paths.runtimeDir, state.runId, 'semantic-proof');
  const fileName = `${plan.planId}.json`;
  const targetPath = path.join(baseDir, fileName);
  await fs.mkdir(baseDir, { recursive: true });
  const payload = {
    generatedAt: nowIso(),
    runId: state.runId,
    planId: plan.planId,
    mode: report.mode,
    applicable: report.applicable,
    satisfied: report.satisfied,
    issues: report.issues,
    mustLandCoverage: report.mustLandCoverage,
    proofStatuses: report.proofStatuses
  };
  await fs.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return toPosix(path.relative(paths.rootDir, targetPath));
}

function ensurePlanRecoveryState(state, planId) {
  if (!state.recoveryState || typeof state.recoveryState !== 'object') {
    state.recoveryState = {};
  }
  if (!state.recoveryState[planId] || typeof state.recoveryState[planId] !== 'object') {
    state.recoveryState[planId] = {
      failedAttempts: 0,
      lastFailureReason: null,
      lastFailedAt: null,
      lastRetriedAt: null,
      updatedAt: null
    };
  }
  return state.recoveryState[planId];
}

function failedAttemptCount(state, planId) {
  const current = state?.recoveryState?.[planId];
  return Math.max(0, asInteger(current?.failedAttempts, 0));
}

function registerPlanFailureAttempt(state, planId, reason) {
  const current = ensurePlanRecoveryState(state, planId);
  state.recoveryState[planId] = {
    ...current,
    failedAttempts: Math.max(0, asInteger(current.failedAttempts, 0)) + 1,
    lastFailureReason: reason ?? null,
    lastFailedAt: nowIso(),
    updatedAt: nowIso()
  };
}

function registerPlanRetryAttempt(state, planId) {
  const current = ensurePlanRecoveryState(state, planId);
  state.recoveryState[planId] = {
    ...current,
    lastRetriedAt: nowIso(),
    updatedAt: nowIso()
  };
}

function clearPlanRecoveryState(state, planId) {
  if (!state.recoveryState || typeof state.recoveryState !== 'object') {
    return;
  }
  delete state.recoveryState[planId];
}

function ensurePlanContinuationState(state, planId) {
  if (!state.continuationState || typeof state.continuationState !== 'object') {
    state.continuationState = {};
  }
  if (!state.continuationState[planId] || typeof state.continuationState[planId] !== 'object') {
    state.continuationState[planId] = {
      rollovers: 0,
      workerNoTouchRetryCount: 0,
      workerPendingStreak: 0,
      readOnlyPendingStreak: 0,
      lastPendingSignal: null,
      updatedAt: null
    };
  }
  return state.continuationState[planId];
}

function ensurePlanSessionState(state, planId) {
  if (!state.sessionState || typeof state.sessionState !== 'object') {
    state.sessionState = {};
  }
  if (!state.sessionState[planId] || typeof state.sessionState[planId] !== 'object') {
    state.sessionState[planId] = {
      nextSessionOrdinal: 0,
      updatedAt: null
    };
  }
  return state.sessionState[planId];
}

function nextPlanSessionOrdinal(state, planId) {
  const current = ensurePlanSessionState(state, planId);
  current.nextSessionOrdinal = Math.max(0, asInteger(current.nextSessionOrdinal, 0)) + 1;
  current.updatedAt = nowIso();
  return current.nextSessionOrdinal;
}

function clearPlanContinuationState(state, planId) {
  if (!state.continuationState || typeof state.continuationState !== 'object') {
    return;
  }
  delete state.continuationState[planId];
}

function ensureEvidenceState(state, planId) {
  if (!state.evidenceState || typeof state.evidenceState !== 'object') {
    state.evidenceState = {};
  }
  if (!state.evidenceState[planId] || typeof state.evidenceState[planId] !== 'object') {
    state.evidenceState[planId] = {
      indexPath: null,
      referenceCount: 0,
      signature: '',
      updatedAt: null
    };
  }
  return state.evidenceState[planId];
}

function ensurePlanImplementationState(state, planId) {
  if (!state.implementationState || typeof state.implementationState !== 'object') {
    state.implementationState = {};
  }
  if (!state.implementationState[planId] || typeof state.implementationState[planId] !== 'object') {
    state.implementationState[planId] = {
      pathRecords: {},
      touchedPaths: [],
      lastRecordedAt: null,
      updatedAt: null
    };
  }
  return state.implementationState[planId];
}

function captureImplementationBaseline(rootDir, plan) {
  const implementationRoots = implementationTargetRoots(plan, { sourceOnly: true });
  if (implementationRoots.length === 0) {
    return {};
  }

  const fingerprints = {};
  const visited = new Set();

  const recordPath = (relativePath) => {
    const normalized = toPosix(String(relativePath ?? '').trim()).replace(/^\.?\//, '');
    if (!normalized || visited.has(normalized)) {
      return;
    }
    visited.add(normalized);
    fingerprints[normalized] = implementationEvidenceFingerprint(rootDir, normalized);
  };

  for (const root of implementationRoots) {
    const normalizedRoot = toPosix(String(root ?? '').trim()).replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!normalizedRoot) {
      continue;
    }

    const absRoot = path.join(rootDir, normalizedRoot);
    try {
      const stat = fsSync.lstatSync(absRoot);
      if (stat.isFile() || stat.isSymbolicLink() || !stat.isDirectory()) {
        recordPath(normalizedRoot);
        continue;
      }

      const stack = [normalizedRoot];
      while (stack.length > 0) {
        const current = stack.pop();
        const absCurrent = path.join(rootDir, current);
        let entries = [];
        try {
          entries = fsSync.readdirSync(absCurrent, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          const child = toPosix(path.posix.join(current, entry.name));
          if (entry.isDirectory()) {
            stack.push(child);
            continue;
          }
          recordPath(child);
        }
      }
    } catch {
      recordPath(normalizedRoot);
    }
  }

  return fingerprints;
}

async function saveState(paths, state, dryRun) {
  state.lastUpdated = nowIso();
  await writeJson(paths.runStatePath, state, dryRun);
}

async function hydrateSessionStateFromRunEvents(paths, state) {
  if (!state?.runId) {
    return;
  }
  let raw = '';
  try {
    raw = await fs.readFile(paths.runEventsPath, 'utf8');
  } catch {
    return;
  }
  for (const event of parseEventLines(raw)) {
    if (String(event?.runId ?? '') !== state.runId) {
      continue;
    }
    const details = event?.details && typeof event.details === 'object' ? event.details : {};
    const planId = String(event?.planId ?? details.planId ?? '').trim();
    const session = Math.max(0, asInteger(event?.session ?? details.session, 0));
    if (!planId || session <= 0) {
      continue;
    }
    const current = ensurePlanSessionState(state, planId);
    current.nextSessionOrdinal = Math.max(asInteger(current.nextSessionOrdinal, 0), session);
    current.updatedAt = nowIso();
  }
}

function redactString(value) {
  let redacted = String(value);
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  redacted = redacted.replace(/(token|secret|password|passphrase|api[-_]?key)\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, '$1=[REDACTED]');
  return redacted;
}

function sanitizeEventDetails(value, parentKey = '') {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEventDetails(entry, parentKey));
  }

  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        next[key] = REDACTED_VALUE;
        continue;
      }
      next[key] = sanitizeEventDetails(entry, key);
    }
    return next;
  }

  if (typeof value === 'string') {
    if (SENSITIVE_KEY_REGEX.test(parentKey)) {
      return REDACTED_VALUE;
    }
    return redactString(value);
  }

  return value;
}

async function logEvent(paths, state, type, details, dryRun) {
  const sanitizedDetails = sanitizeEventDetails(details ?? {});
  const event = {
    timestamp: nowIso(),
    runId: state.runId,
    taskId: sanitizedDetails.planId ?? null,
    type,
    model: sanitizedDetails.model ?? process.env.ORCH_MODEL_ID ?? 'n/a',
    mode: state.effectiveMode,
    details: sanitizedDetails
  };
  await appendJsonLine(paths.runEventsPath, event, dryRun);
}

function resolveEffectiveMode(requestedMode) {
  const normalized = (requestedMode ?? 'guarded').toLowerCase() === 'full' ? 'full' : 'guarded';

  if (normalized === 'full' && process.env.ORCH_ALLOW_FULL_AUTONOMY !== '1') {
    return {
      requestedMode: 'full',
      effectiveMode: 'guarded',
      downgraded: true,
      reason: 'ORCH_ALLOW_FULL_AUTONOMY is not set to 1'
    };
  }

  return {
    requestedMode: normalized,
    effectiveMode: normalized,
    downgraded: false,
    reason: null
  };
}

function evaluatePolicyGate(plan, effectiveMode) {
  const autonomyAllowed = (plan.autonomyAllowed || 'both').toLowerCase();
  const riskTier = (plan.riskTier || 'low').toLowerCase();

  if (autonomyAllowed === 'guarded' && effectiveMode === 'full') {
    return { allowed: false, reason: 'Plan is restricted to guarded mode.' };
  }

  if (autonomyAllowed === 'full' && effectiveMode !== 'full') {
    return { allowed: false, reason: 'Plan requires full mode but run is guarded.' };
  }

  if (riskTier === 'medium' && process.env.ORCH_APPROVED_MEDIUM !== '1') {
    return {
      allowed: false,
      reason: `Missing ORCH_APPROVED_MEDIUM=1 for medium risk execution in ${effectiveMode} mode.`
    };
  }

  if (riskTier === 'high' && process.env.ORCH_APPROVED_HIGH !== '1') {
    return {
      allowed: false,
      reason: `Missing ORCH_APPROVED_HIGH=1 for high risk execution in ${effectiveMode} mode.`
    };
  }

  return { allowed: true, reason: null };
}

async function readPlanRecord(rootDir, filePath, phase) {
  const content = await fs.readFile(filePath, 'utf8');
  const metadata = parseMetadata(content);
  const rel = assertSafeRelativePlanPath(toPosix(path.relative(rootDir, filePath)));
  const explicitPlanId = metadataValue(metadata, 'Plan-ID');
  const parsedExplicitPlanId = explicitPlanId ? parsePlanId(explicitPlanId, null) : null;
  if (explicitPlanId && !parsedExplicitPlanId) {
    throw new Error(
      `Invalid Plan-ID '${explicitPlanId}' in ${rel}. Use lowercase kebab-case (e.g. 'fix-auth-timeout').`
    );
  }
  const inferredPlanId = inferPlanId(content, filePath);
  const planId = parsedExplicitPlanId ?? inferredPlanId;
  if (!planId) {
    throw new Error(`Could not parse or infer Plan-ID for ${rel}.`);
  }
  assertValidPlanId(planId, rel);

  const status = normalizeStatus(metadataValue(metadata, 'Status'));
  const priority = parsePriority(metadataValue(metadata, 'Priority'));
  const owner = metadataValue(metadata, 'Owner') ?? 'unassigned';
  const dependencies = parseListField(metadataValue(metadata, 'Dependencies')).map((dependency) => {
    const parsedDependency = parsePlanId(dependency, null);
    if (!parsedDependency) {
      throw new Error(
        `Invalid dependency '${dependency}' in ${rel}. Dependencies must be lowercase kebab-case Plan-ID values.`
      );
    }
    return parsedDependency;
  });
  const tags = parseListField(metadataValue(metadata, 'Tags'));
  const specTargets = parseListField(metadataValue(metadata, 'Spec-Targets')).map((target) => (
    resolveSafeRepoPath(rootDir, target, `Spec-Targets entry in ${rel}`).rel
  ));
  const implementationTargets = parseListField(metadataValue(metadata, 'Implementation-Targets')).map((target) => (
    resolveSafeRepoPath(rootDir, target, `Implementation-Targets entry in ${rel}`).rel
  ));
  const doneEvidence = parseListField(metadataValue(metadata, 'Done-Evidence'));
  const parentPlanIdRaw = metadataValue(metadata, 'Parent-Plan-ID');
  const parentPlanId = parentPlanIdRaw ? parsePlanId(parentPlanIdRaw, null) : null;
  if (parentPlanIdRaw && !parentPlanId) {
    throw new Error(
      `Invalid Parent-Plan-ID '${parentPlanIdRaw}' in ${rel}. Parent-Plan-ID must be a lowercase kebab-case Plan-ID value.`
    );
  }
  const atomicRoots = parseListField(metadataValue(metadata, 'Atomic-Roots')).map((entry) => (
    resolveSafeRepoPath(rootDir, entry, `Atomic-Roots entry in ${rel}`).rel
  ));
  const concurrencyLocks = parseListField(metadataValue(metadata, 'Concurrency-Locks')).map((entry) => (
    String(entry).trim().toLowerCase()
  )).filter(Boolean);

  return {
    planId,
    phase,
    filePath,
    rel,
    title: (content.match(/^#\s+(.+)$/m)?.[1] ?? planId).trim(),
    content,
    metadata,
    status,
    priority,
    owner,
    dependencies,
    tags,
    specTargets,
    deliveryClass: parseDeliveryClass(metadataValue(metadata, 'Delivery-Class'), ''),
    executionScope: parseExecutionScope(metadataValue(metadata, 'Execution-Scope'), ''),
    implementationTargets,
    parentPlanId,
    doneEvidence,
    atomicRoots,
    concurrencyLocks,
    autonomyAllowed: metadataValue(metadata, 'Autonomy-Allowed') ?? 'both',
    riskTier: parseRiskTier(metadataValue(metadata, 'Risk-Tier'), 'low'),
    securityApproval: parseSecurityApproval(metadataValue(metadata, 'Security-Approval'), SECURITY_APPROVAL_NOT_REQUIRED),
    acceptanceCriteria: metadataValue(metadata, 'Acceptance-Criteria') ?? ''
  };
}

function clonePlanRecord(record) {
  return {
    ...record,
    metadata: new Map(
      [...(record.metadata instanceof Map ? record.metadata.entries() : [])].map(([key, value]) => [
        key,
        value && typeof value === 'object'
          ? { ...value }
          : value
      ])
    ),
    dependencies: [...(record.dependencies ?? [])],
    tags: [...(record.tags ?? [])],
    specTargets: [...(record.specTargets ?? [])],
    implementationTargets: [...(record.implementationTargets ?? [])],
    doneEvidence: [...(record.doneEvidence ?? [])],
    atomicRoots: [...(record.atomicRoots ?? [])],
    concurrencyLocks: [...(record.concurrencyLocks ?? [])],
    parentPlanId: record.parentPlanId ?? null
  };
}

async function readPlanRecordCached(rootDir, filePath, phase) {
  const cacheKey = `${phase}:${toPosix(path.resolve(filePath))}`;
  let signature = null;
  try {
    const stat = await fs.stat(filePath);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    RUN_MEMORY_PLAN_RECORD_CACHE.delete(cacheKey);
    return readPlanRecord(rootDir, filePath, phase);
  }

  const cached = RUN_MEMORY_PLAN_RECORD_CACHE.get(cacheKey);
  if (cached && cached.signature === signature && cached.record) {
    return clonePlanRecord(cached.record);
  }

  const record = await readPlanRecord(rootDir, filePath, phase);
  RUN_MEMORY_PLAN_RECORD_CACHE.set(cacheKey, {
    signature,
    record: clonePlanRecord(record)
  });
  return record;
}

async function resolveEvidenceFreshnessToken(planId, paths, state) {
  const normalizedPlanId = String(planId ?? '').trim();
  if (!normalizedPlanId) {
    return 'none';
  }

  const signature = String(state?.evidenceState?.[normalizedPlanId]?.signature ?? '').trim();
  if (signature) {
    return `sig:${signature}`;
  }

  const indexAbs = path.join(paths.evidenceIndexDir, `${normalizedPlanId}.md`);
  try {
    const stat = await fs.stat(indexAbs);
    const mtimeMs = Number.isFinite(stat?.mtimeMs) ? Math.round(stat.mtimeMs) : 0;
    const size = Number.isFinite(stat?.size) ? stat.size : 0;
    return `stat:${mtimeMs}:${size}`;
  } catch {
    return 'none';
  }
}

async function loadPlanRecords(rootDir, directoryPath, phase) {
  const files = await listMarkdownFiles(directoryPath);
  const activeCacheKeys = new Set(files.map((filePath) => `${phase}:${toPosix(path.resolve(filePath))}`));
  for (const cacheKey of RUN_MEMORY_PLAN_RECORD_CACHE.keys()) {
    if (!cacheKey.startsWith(`${phase}:`)) {
      continue;
    }
    if (!activeCacheKeys.has(cacheKey)) {
      RUN_MEMORY_PLAN_RECORD_CACHE.delete(cacheKey);
    }
  }
  const records = [];
  for (const filePath of files) {
    records.push(await readPlanRecordCached(rootDir, filePath, phase));
  }
  return records;
}

function uniqueByPlanId(records) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.planId)) {
      map.set(record.planId, record);
    }
  }
  return map;
}

async function promoteFuturePlans(paths, state, options) {
  const futures = await loadPlanRecords(paths.rootDir, paths.futureDir, 'future');
  const active = await loadPlanRecords(paths.rootDir, paths.activeDir, 'active');
  const completed = await loadPlanRecords(paths.rootDir, paths.completedDir, 'completed');

  const takenPlanIds = new Set([...active, ...completed].map((plan) => plan.planId));
  let promoted = 0;

  for (const future of futures) {
    if (future.status !== 'ready-for-promotion') {
      continue;
    }

    if (takenPlanIds.has(future.planId)) {
      await logEvent(paths, state, 'promotion_skipped', {
        planId: future.planId,
        reason: 'Plan-ID already present in active/completed plans'
      }, options.dryRun);
      continue;
    }

    const targetDate = todayIsoDate();
    const targetName = datedPlanFileName(targetDate, future.planId);
    let targetPath = path.join(paths.activeDir, targetName);

    if (await exists(targetPath)) {
      const parsed = path.parse(targetName);
      targetPath = path.join(paths.activeDir, `${parsed.name}-${Date.now()}${parsed.ext || '.md'}`);
    }

    const promotedMetadata = {
      'Plan-ID': future.planId,
      Status: isProgramPlan(future) ? 'in-progress' : 'queued',
      Priority: future.priority,
      Owner: future.owner,
      'Acceptance-Criteria': future.acceptanceCriteria || 'Define acceptance criteria before execution.',
      Dependencies: future.dependencies.length > 0 ? future.dependencies.join(', ') : 'none',
      'Autonomy-Allowed': metadataValue(future.metadata, 'Autonomy-Allowed') ?? 'both',
      'Risk-Tier': parseRiskTier(metadataValue(future.metadata, 'Risk-Tier'), 'low'),
      'Security-Approval':
        parseSecurityApproval(
          metadataValue(future.metadata, 'Security-Approval'),
          SECURITY_APPROVAL_NOT_REQUIRED
        ),
      'Spec-Targets': future.specTargets.length > 0 ? future.specTargets.join(', ') : 'docs/product-specs/CURRENT-STATE.md',
      'Done-Evidence': future.doneEvidence.length > 0 ? future.doneEvidence.join(', ') : 'pending'
    };

    const promotedContent = setPlanDocumentFields(future.content, promotedMetadata);
    if (!options.dryRun) {
      await fs.writeFile(targetPath, promotedContent, 'utf8');
      await fs.unlink(future.filePath);
    }

    promoted += 1;
    state.stats.promotions += 1;
    takenPlanIds.add(future.planId);

    await logEvent(paths, state, 'promoted_future', {
      planId: future.planId,
      source: future.rel,
      target: toPosix(path.relative(paths.rootDir, targetPath))
    }, options.dryRun);
  }

  return promoted;
}

function executablePlans(activePlans, completedPlanIds, excludedPlanIds = new Set(), recoveredPlanIds = new Set()) {
  return activePlans
    .filter((plan) => ACTIVE_STATUSES.has(plan.status))
    .filter((plan) => !(plan.status === 'completed' && completedPlanIds.has(plan.planId)))
    .filter((plan) => !isProgramPlan(plan))
    .filter((plan) =>
      plan.status !== 'failed' && plan.status !== 'blocked'
        ? true
        : recoveredPlanIds.has(plan.planId)
    )
    .filter((plan) => !excludedPlanIds.has(plan.planId))
    .filter((plan) => plan.dependencies.every((dependency) => completedPlanIds.has(dependency)))
    .sort((a, b) => {
      const priorityDelta = priorityOrder(a.priority) - priorityOrder(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return a.rel.localeCompare(b.rel);
    });
}

function blockedPlans(activePlans, completedPlanIds, excludedPlanIds = new Set()) {
  return activePlans
    .filter((plan) => ACTIVE_STATUSES.has(plan.status))
    .filter((plan) => !excludedPlanIds.has(plan.planId))
    .filter((plan) => plan.dependencies.some((dependency) => !completedPlanIds.has(dependency)));
}

function evaluateExecutionEligibility(plan) {
  if (!plan.deliveryClass) {
    return {
      allowed: false,
      reason: "Plan is missing 'Delivery-Class'."
    };
  }

  if (!plan.executionScope) {
    return {
      allowed: false,
      reason: "Plan is missing 'Execution-Scope'."
    };
  }

  if (isProgramPlan(plan)) {
    return {
      allowed: false,
      reason: 'Program plans are non-executable parent contracts. Extract or complete child slices instead.'
    };
  }

  if (isProductPlan(plan) && implementationTargetRoots(plan, { sourceOnly: true }).length === 0) {
    return {
      allowed: false,
      reason: "Product slice plans must declare at least one source-code 'Implementation-Targets' root before worker/reviewer execution."
    };
  }

  return { allowed: true, reason: null };
}

function securityApprovalSatisfied(plan, assessment, config) {
  const {
    securityApprovalField,
    securityApprovalValue
  } = resolvedSecurityApproval(plan, assessment, config);
  if (!requiresSecurityApproval(plan, assessment, config)) {
    return { ok: true, securityApprovalField, securityApprovalValue };
  }
  return {
    ok: securityApprovalValue === SECURITY_APPROVAL_APPROVED,
    securityApprovalField,
    securityApprovalValue
  };
}

function classifyRecoverablePlans(activePlans, completedPlanIds, state, options, config) {
  const retryableFailed = new Map();
  const unblockable = new Map();

  for (const plan of activePlans) {
    if (!ACTIVE_STATUSES.has(plan.status)) {
      continue;
    }
    if (!planDependenciesReady(plan, completedPlanIds)) {
      continue;
    }

    const assessment = computeRiskAssessment(plan, state, config);
    const policyGate = evaluatePolicyGate(
      {
        ...plan,
        riskTier: assessment.effectiveRiskTier
      },
      state.effectiveMode
    );
    const approval = securityApprovalSatisfied(plan, assessment, config);

    if (plan.status === 'failed' && options.retryFailedPlans) {
      const attempts = failedAttemptCount(state, plan.planId);
      if (attempts < asInteger(options.maxFailedRetries, DEFAULT_MAX_FAILED_RETRIES) && policyGate.allowed && approval.ok) {
        retryableFailed.set(plan.planId, {
          attempts,
          maxAttempts: asInteger(options.maxFailedRetries, DEFAULT_MAX_FAILED_RETRIES)
        });
      }
    }

    if (plan.status === 'blocked' && options.autoUnblockPlans) {
      if (policyGate.allowed && approval.ok) {
        unblockable.set(plan.planId, {
          reason: 'Policy/approval gates now satisfied.'
        });
      }
    }
  }

  return {
    retryableFailed,
    unblockable
  };
}

async function snapshotFileState(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { exists: true, content };
  } catch {
    return { exists: false, content: null };
  }
}

async function restoreFileState(filePath, snapshot) {
  if (!snapshot?.exists) {
    if (await exists(filePath)) {
      await fs.unlink(filePath);
    }
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, snapshot.content ?? '', 'utf8');
}

function replaceExecutorTokens(command, plan, sessionContext) {
  const {
    session,
    runId,
    mode,
    resultPath,
    contactPackFile = DEFAULT_RUNTIME_CONTEXT_PATH,
    role = ROLE_WORKER,
    effectiveRiskTier = 'low',
    declaredRiskTier = 'low',
    stageIndex = 1,
    stageTotal = 1
  } = sessionContext;
  return command
    .replaceAll('{plan_id}', plan.planId)
    .replaceAll('{plan_file}', plan.rel)
    .replaceAll('{run_id}', runId)
    .replaceAll('{mode}', mode)
    .replaceAll('{session}', String(session))
    .replaceAll('{role}', role)
    .replaceAll('{effective_risk_tier}', effectiveRiskTier)
    .replaceAll('{declared_risk_tier}', declaredRiskTier)
    .replaceAll('{stage_index}', String(stageIndex))
    .replaceAll('{stage_total}', String(stageTotal))
    .replaceAll('{result_path}', resultPath)
    .replaceAll('{contact_pack_file}', contactPackFile);
}

async function prepareTaskContactPack(plan, paths, state, options, config, sessionContext) {
  const runtimeContextPath =
    String(config?.context?.runtimeContextPath ?? DEFAULT_RUNTIME_CONTEXT_PATH).trim() ||
    DEFAULT_RUNTIME_CONTEXT_PATH;
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const contactPackEnabled = asBoolean(options.contactPackEnabled, DEFAULT_CONTACT_PACKS_ENABLED);
  const contactPackCacheMode = normalizeContactPackCacheMode(
    options.contactPackCacheMode,
    DEFAULT_CONTACT_PACK_CACHE_MODE
  );
  if (!contactPackEnabled) {
    return {
      enabled: false,
      contactPackFile: toPosix(runtimeContextPath),
      generated: false,
      reason: 'contact packs disabled by configuration'
    };
  }

  const contactPackRel = toPosix(
    path.join('docs', 'ops', 'automation', 'runtime', 'contacts', state.runId, plan.planId, `${role}.md`)
  );

  if (options.dryRun) {
    return {
      enabled: true,
      contactPackFile: contactPackRel,
      generated: false,
      reason: 'dry-run',
      checkpointCount: 0,
      contactPackManifestFile: contactPackRel.replace(/\.md$/, '.json'),
      selectedInputCount: 0,
      thinPack: false,
      thinPackMissingCategories: []
    };
  }

  const evidenceFreshness = await resolveEvidenceFreshnessToken(plan.planId, paths, state);
  const cacheKey = createHash('sha256').update(JSON.stringify({
    runId: state.runId,
    planId: plan.planId,
    planShapeHash: computePlanShapeHash(plan),
    evidenceFreshness,
    role,
    declaredRiskTier: parseRiskTier(sessionContext.declaredRiskTier, 'low'),
    effectiveRiskTier: parseRiskTier(sessionContext.effectiveRiskTier, 'low'),
    stageIndex: Math.max(1, asInteger(sessionContext.stageIndex, 1)),
    stageTotal: Math.max(1, asInteger(sessionContext.stageTotal, 1)),
    outputPath: contactPackRel,
    configPath: toPosix(path.relative(paths.rootDir, paths.orchestratorConfigPath)),
    maxPolicyBullets: asInteger(options.contactPackMaxPolicyBullets, DEFAULT_CONTACT_PACKS_MAX_POLICY_BULLETS),
    includeRecentEvidence: asBoolean(options.contactPackIncludeRecentEvidence, DEFAULT_CONTACT_PACKS_INCLUDE_RECENT_EVIDENCE),
    maxRecentEvidenceItems: asInteger(options.contactPackMaxRecentEvidenceItems, DEFAULT_CONTACT_PACKS_MAX_RECENT_EVIDENCE_ITEMS),
    includeLatestState: asBoolean(options.contactPackIncludeLatestState, DEFAULT_CONTACT_PACKS_INCLUDE_LATEST_STATE),
    maxRecentCheckpointItems: asInteger(
      options.contactPackMaxRecentCheckpointItems,
      DEFAULT_CONTACT_PACKS_MAX_RECENT_CHECKPOINT_ITEMS
    ),
    maxStateListItems: asInteger(options.contactPackMaxStateListItems, DEFAULT_CONTACT_PACKS_MAX_STATE_LIST_ITEMS)
  })).digest('hex');
  if (contactPackCacheMode === 'run-memory') {
    const cached = RUN_MEMORY_CONTACT_PACK_CACHE.get(cacheKey);
    if (cached && await exists(path.join(paths.rootDir, cached.contactPackFile))) {
      return {
        enabled: true,
        contactPackFile: cached.contactPackFile,
        generated: false,
        reason: 'run-memory-cache-hit',
        bytes: cached.bytes,
        lineCount: cached.lineCount,
        policyRuleCount: cached.policyRuleCount,
        evidenceCount: cached.evidenceCount,
        checkpointCount: cached.checkpointCount,
        contactPackManifestFile: cached.contactPackManifestFile,
        selectedInputCount: cached.selectedInputCount,
        thinPack: cached.thinPack,
        thinPackMissingCategories: cached.thinPackMissingCategories
      };
    }
  }

  const result = await compileTaskContactPack({
    rootDir: paths.rootDir,
    runId: state.runId,
    planId: plan.planId,
    planFile: plan.rel,
    role,
    declaredRiskTier: sessionContext.declaredRiskTier,
    effectiveRiskTier: sessionContext.effectiveRiskTier,
    stageIndex: sessionContext.stageIndex,
    stageTotal: sessionContext.stageTotal,
    outputPath: contactPackRel,
    configPath: toPosix(path.relative(paths.rootDir, paths.orchestratorConfigPath)),
    maxPolicyBullets: options.contactPackMaxPolicyBullets,
    includeRecentEvidence: options.contactPackIncludeRecentEvidence,
    maxRecentEvidenceItems: options.contactPackMaxRecentEvidenceItems,
    includeLatestState: options.contactPackIncludeLatestState,
    maxRecentCheckpointItems: options.contactPackMaxRecentCheckpointItems,
    maxStateListItems: options.contactPackMaxStateListItems
  });

  if (contactPackCacheMode === 'run-memory') {
    RUN_MEMORY_CONTACT_PACK_CACHE.set(cacheKey, {
      contactPackFile: result.outputPath,
      bytes: result.bytes,
      lineCount: result.lineCount,
      policyRuleCount: result.policyRuleCount,
      evidenceCount: result.evidenceCount,
      checkpointCount: result.checkpointCount,
      contactPackManifestFile: result.manifestPath,
      selectedInputCount: result.selectedInputCount,
      thinPack: result.thinPack,
      thinPackMissingCategories: result.thinPackMissingCategories
    });
  }

  return {
    enabled: true,
    contactPackFile: result.outputPath,
    contactPackManifestFile: result.manifestPath,
    generated: true,
    bytes: result.bytes,
    lineCount: result.lineCount,
    policyRuleCount: result.policyRuleCount,
    evidenceCount: result.evidenceCount,
    checkpointCount: result.checkpointCount,
    selectedInputCount: result.selectedInputCount,
    thinPack: result.thinPack,
    thinPackMissingCategories: result.thinPackMissingCategories
  };
}

function meaningfulTouchSamples(touchSummary) {
  return stringList(Array.isArray(touchSummary?.samples) ? touchSummary.samples : [], 6);
}

function synthesizeContinuityDelta(plan, sessionContext, summary, reason, sessionLogPath, contactPackFile, touchSummary) {
  const currentSubtask = trimmedString(
    summary ?? reason,
    `Continue ${sessionContext.role ?? ROLE_WORKER} work for ${plan.planId}.`
  );
  const nextAction = trimmedString(
    reason ?? summary,
    `Load ${contactPackFile} and continue the current ${sessionContext.role ?? ROLE_WORKER} stage.`
  );
  const touched = meaningfulTouchSamples(touchSummary);
  const artifacts = stringList(
    [
      contactPackFile,
      continuityStateArtifactRel(plan.planId),
      continuityCheckpointArtifactRel(plan.planId),
      sessionLogPath,
      ...touched
    ],
    10
  );
  return {
    currentSubtask,
    nextAction,
    stateDelta: {
      completedWork: [],
      acceptedFacts: [],
      decisions: [],
      openQuestions: [],
      pendingActions: [nextAction],
      recentResults: stringList([summary, reason], 4),
      artifacts,
      risks: reason ? [reason] : [],
      reasoning: {
        nextAction,
        blockers: [],
        rationale: []
      },
      evidence: {
        artifactRefs: touched,
        extractedFacts: stringList([summary], 4),
        logRefs: stringList([sessionLogPath], 4),
        validationRefs: []
      }
    }
  };
}

function normalizeSessionContinuity(plan, sessionContext, resultPayload, sessionLogPath, contactPackFile, touchSummary) {
  const currentSubtask = trimmedString(resultPayload?.currentSubtask);
  const nextAction = trimmedString(resultPayload?.nextAction);
  const stateDelta = normalizeContinuityDelta(resultPayload?.stateDelta);
  const hasStructured =
    Boolean(currentSubtask) &&
    Boolean(nextAction) &&
    (
      stateDelta.pendingActions.length > 0 ||
      stateDelta.completedWork.length > 0 ||
      stateDelta.recentResults.length > 0 ||
      stateDelta.artifacts.length > 0 ||
      stateDelta.reasoning.nextAction
    );
  if (hasStructured) {
    return {
      derived: false,
      currentSubtask,
      nextAction,
      stateDelta
    };
  }
  return {
    derived: true,
    ...synthesizeContinuityDelta(
    plan,
    sessionContext,
    resultPayload?.summary,
    resultPayload?.reason,
    sessionLogPath,
    contactPackFile,
    touchSummary
    )
  };
}

async function writeSessionExecutorLog(logPathAbs, metadataLines, outputText, dryRun) {
  if (dryRun) {
    return;
  }
  const parts = [...metadataLines, '', '## Output', '', String(outputText ?? '').trim()];
  const rendered = `${parts.join('\n').trimEnd()}\n`;
  await fs.writeFile(logPathAbs, rendered, 'utf8');
}

async function executePlanSession(plan, paths, state, options, config, sessionNumber, sessionContext = {}) {
  assertValidPlanId(plan.planId, plan.rel);
  assertSafeRelativePlanPath(plan.rel);
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const effectiveRiskTier = parseRiskTier(sessionContext.effectiveRiskTier, 'low');
  const roleProfile = resolveRoleExecutionProfile(config, role, effectiveRiskTier);
  const declaredRiskTier = parseRiskTier(sessionContext.declaredRiskTier, 'low');
  const stageIndex = asInteger(sessionContext.stageIndex, 1);
  const stageTotal = asInteger(sessionContext.stageTotal, 1);
  const workerNoTouchRetryCount = Math.max(0, asInteger(sessionContext.workerNoTouchRetryCount, 0));
  const workerNoTouchRetryLimit = Math.max(
    0,
    asInteger(
      sessionContext.workerNoTouchRetryLimit,
      asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)
    )
  );
  const runSessionDir = path.join(paths.runtimeDir, state.runId);
  const resultPathAbs = path.join(runSessionDir, `${plan.planId}-${role}-session-${sessionNumber}.result.json`);
  const resultPathRel = toPosix(path.relative(paths.rootDir, resultPathAbs));
  const sessionLogPathAbs = path.join(runSessionDir, `${plan.planId}-${role}-session-${sessionNumber}.executor.log`);
  const sessionLogPathRel = toPosix(path.relative(paths.rootDir, sessionLogPathAbs));
  const workerDirtyImplementationBaselinePaths =
    role === ROLE_WORKER ? dirtyImplementationTouchPaths(paths.rootDir, plan) : [];
  const workerImplementationBaseline =
    role === ROLE_WORKER ? captureImplementationBaseline(paths.rootDir, plan) : {};
  const workerHasImplementationBaseline =
    role === ROLE_WORKER
      ? workerDirtyImplementationBaselinePaths.length > 0 || hasRecordedImplementationEvidence(state, plan, paths.rootDir)
      : false;

  if (!options.dryRun) {
    await fs.mkdir(runSessionDir, { recursive: true });
  }

  const configuredExecutor = configuredExecutorCommand(options, config);
  if (!configuredExecutor) {
    return {
      status: 'failed',
      reason: 'No executor command configured (set docs/ops/automation/orchestrator.config.json executor.command).'
    };
  }

  let contactPack = null;
  try {
    contactPack = await prepareTaskContactPack(plan, paths, state, options, config, {
      role,
      declaredRiskTier,
      effectiveRiskTier,
      stageIndex,
      stageTotal
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `Failed to prepare task contact pack: ${reason}`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null
    };
  }
  const contactPackFile = String(contactPack?.contactPackFile ?? DEFAULT_RUNTIME_CONTEXT_PATH).trim() || DEFAULT_RUNTIME_CONTEXT_PATH;

  const renderedCommand = replaceExecutorTokens(
    configuredExecutor,
    plan,
    {
      session: sessionNumber,
      runId: state.runId,
      mode: state.effectiveMode,
      resultPath: resultPathRel,
      role,
      effectiveRiskTier,
      declaredRiskTier,
      stageIndex,
      stageTotal,
      contactPackFile
    }
  );
  const captureOutput = shouldCaptureCommandOutput(options);
  const sessionLogPath = captureOutput ? sessionLogPathRel : null;

  await logEvent(paths, state, 'session_started', {
    planId: plan.planId,
    session: sessionNumber,
    role,
    provider: roleProfile.provider,
    model: roleProfile.model || null,
    reasoningEffort: roleProfile.reasoningEffort,
    sandboxMode: roleProfile.sandboxMode,
    effectiveRiskTier,
    declaredRiskTier,
    stageIndex,
    stageTotal,
    contactPackFile,
    contactPackManifestFile: contactPack?.contactPackManifestFile ?? null,
    contactPackEnabled: contactPack?.enabled ?? false,
    contactPackGenerated: contactPack?.generated ?? false,
    contactPackPolicyRuleCount: contactPack?.policyRuleCount ?? 0,
    contactPackEvidenceCount: contactPack?.evidenceCount ?? 0,
    contactPackCheckpointCount: contactPack?.checkpointCount ?? 0,
    contactPackSelectedInputCount: contactPack?.selectedInputCount ?? 0,
    contactPackThin: contactPack?.thinPack ?? false,
    executorCommandConfigured: true,
    commandLogPath: sessionLogPath
  }, options.dryRun);

  if (options.dryRun) {
    return {
      status: 'completed',
      summary: 'Dry-run: executor skipped.',
      resultPayloadFound: true,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      contactPackFile,
      contactPackManifestFile: contactPack?.contactPackManifestFile ?? null,
      contactPackGenerated: contactPack?.generated ?? false,
      contactPackPolicyRuleCount: contactPack?.policyRuleCount ?? 0,
      contactPackEvidenceCount: contactPack?.evidenceCount ?? 0,
      contactPackCheckpointCount: contactPack?.checkpointCount ?? 0,
      contactPackSelectedInputCount: contactPack?.selectedInputCount ?? 0,
      contactPackThin: contactPack?.thinPack ?? false,
      contactPackThinPackMissingCategories: contactPack?.thinPackMissingCategories ?? [],
      durationSeconds: 0
    };
  }

  const env = {
    ...process.env,
    ORCH_RUN_ID: state.runId,
    ORCH_PLAN_ID: plan.planId,
    ORCH_PLAN_FILE: plan.rel,
    ORCH_SESSION: String(sessionNumber),
    ORCH_ROLE: role,
    ORCH_EFFECTIVE_RISK_TIER: effectiveRiskTier,
    ORCH_DECLARED_RISK_TIER: declaredRiskTier,
    ORCH_STAGE_INDEX: String(stageIndex),
    ORCH_STAGE_TOTAL: String(stageTotal),
    ORCH_MODE: state.effectiveMode,
    ORCH_RESULT_PATH: resultPathRel,
    ORCH_CONTACT_PACK_FILE: contactPackFile,
    ORCH_CONTEXT_THRESHOLD: String(options.contextThreshold),
    ORCH_CONTEXT_ABSOLUTE_FLOOR: String(options.contextAbsoluteFloor ?? options.contextThreshold),
    ORCH_CONTEXT_SOFT_USED_RATIO: String(options.contextSoftUsedRatio),
    ORCH_CONTEXT_HARD_USED_RATIO: String(options.contextHardUsedRatio),
    ORCH_HANDOFF_TOKEN_BUDGET: String(options.handoffTokenBudget),
    ORCH_WORKER_NO_TOUCH_RETRY_COUNT: String(workerNoTouchRetryCount),
    ORCH_WORKER_NO_TOUCH_RETRY_LIMIT: String(workerNoTouchRetryLimit)
  };

  const executionStartedAtMs = Date.now();
  const baseWorkerFirstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(options.workerFirstTouchDeadlineSeconds, DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS)
  );
  const retryWorkerFirstTouchDeadlineSeconds = Math.max(
    0,
    asInteger(options.workerRetryFirstTouchDeadlineSeconds, baseWorkerFirstTouchDeadlineSeconds)
  );
  const effectiveWorkerFirstTouchDeadlineSeconds =
    role !== ROLE_WORKER
      ? baseWorkerFirstTouchDeadlineSeconds
      : workerHasImplementationBaseline
        ? 0
        : workerNoTouchRetryCount > 0 &&
            baseWorkerFirstTouchDeadlineSeconds > 0 &&
            retryWorkerFirstTouchDeadlineSeconds > 0
          ? Math.min(
              baseWorkerFirstTouchDeadlineSeconds,
              retryWorkerFirstTouchDeadlineSeconds
            )
          : baseWorkerFirstTouchDeadlineSeconds;
  const workerTouchPolicy = buildWorkerTouchPolicy(plan);
  const sessionExecutionOptions =
    effectiveWorkerFirstTouchDeadlineSeconds === baseWorkerFirstTouchDeadlineSeconds
      ? options
      : {
          ...options,
          workerFirstTouchDeadlineSeconds: effectiveWorkerFirstTouchDeadlineSeconds
        };
  const execution = await runShellMonitored(
    renderedCommand,
    paths.rootDir,
    env,
    options.executorTimeoutMs,
    captureOutput ? 'pipe' : 'inherit',
    sessionExecutionOptions,
    {
      phase: 'session',
      planId: plan.planId,
      role,
      activity: roleActivity(role),
      workerTouchPolicy
    }
  );
  const commandOutput = captureOutput ? executionOutput(execution) : '';
  const durationSeconds = Math.max(0, (Date.now() - executionStartedAtMs) / 1000);
  const sessionTouchSummary = execution.touchSummary ?? null;
  const sessionTouchMonitor = execution.touchMonitor ?? null;
  const withSessionTouchSummary = (result) => ({
    ...result,
    touchSummary: sessionTouchSummary,
    touchMonitor: sessionTouchMonitor,
    implementationBaseline: workerImplementationBaseline,
    contactPackFile,
    contactPackManifestFile: contactPack?.contactPackManifestFile ?? null,
    contactPackGenerated: contactPack?.generated ?? false,
    contactPackPolicyRuleCount: contactPack?.policyRuleCount ?? 0,
    contactPackEvidenceCount: contactPack?.evidenceCount ?? 0,
    contactPackCheckpointCount: contactPack?.checkpointCount ?? 0,
    contactPackSelectedInputCount: contactPack?.selectedInputCount ?? 0,
    contactPackThin: contactPack?.thinPack ?? false,
    contactPackThinPackMissingCategories: contactPack?.thinPackMissingCategories ?? [],
    durationSeconds
  });
  if (captureOutput) {
    await writeSessionExecutorLog(
      sessionLogPathAbs,
      [
        '# Executor Session Log',
        '',
        `- Run-ID: ${state.runId}`,
        `- Plan-ID: ${plan.planId}`,
        `- Plan-File: ${plan.rel}`,
        `- Session: ${sessionNumber}`,
        `- Stage: ${stageIndex}/${stageTotal}`,
        `- Role: ${role}`,
        `- Provider: ${roleProfile.provider}`,
        `- Model: ${roleProfile.model || 'n/a'}`,
        `- Reasoning-Effort: ${roleProfile.reasoningEffort}`,
        `- Sandbox-Mode: ${roleProfile.sandboxMode}`,
        `- Effective-Risk-Tier: ${effectiveRiskTier}`,
        `- Declared-Risk-Tier: ${declaredRiskTier}`,
        `- Contact-Pack: ${contactPackFile}`
      ],
      commandOutput,
      options.dryRun
    );
  }
  const handoffExitCode = asInteger(options.handoffExitCode, asInteger(config.executor.handoffExitCode, DEFAULT_HANDOFF_EXIT_CODE));

  if (didTimeout(execution)) {
    const reason = `Executor command timed out after ${Math.floor((options.executorTimeoutMs ?? 0) / 1000)}s`;
    return withSessionTouchSummary({
      status: 'failed',
      reason,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  if (didFirstTouchDeadlineTimeout(execution)) {
    const deadlineSeconds = effectiveWorkerFirstTouchDeadlineSeconds;
    return withSessionTouchSummary({
      status: 'pending',
      reason: `Worker first-touch deadline exceeded (${deadlineSeconds}s) without ${workerTouchPolicy.progressLabel}.`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  if (didWorkerStallTimeout(execution)) {
    const stallSeconds = Math.max(
      0,
      asInteger(options.workerStallFailSeconds, DEFAULT_WORKER_STALL_FAIL_SECONDS)
    );
    return withSessionTouchSummary({
      status: 'pending',
      reason: `Worker stalled after making edits (idle >= ${stallSeconds}s). Start a fresh worker session to continue safely.`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  if (execution.signal) {
    const reason = `Executor terminated by signal ${execution.signal}`;
    return withSessionTouchSummary({
      status: 'failed',
      reason,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  if (execution.status === handoffExitCode) {
    return withSessionTouchSummary({
      status: 'handoff_required',
      reason: `Executor exited with handoff code ${handoffExitCode}`,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  if (execution.status !== 0) {
    const reason = `Executor exited with status ${execution.status}`;
    return withSessionTouchSummary({
      status: 'failed',
      reason,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath,
      failureTail: tailLines(commandOutput, options.failureTailLines)
    });
  }

  const resultPayload = await readJsonIfExists(resultPathAbs, null);
  if (!resultPayload) {
    if (options.requireResultPayload) {
      return withSessionTouchSummary({
        status: 'handoff_required',
        reason:
          'Executor exited 0 without writing ORCH_RESULT_PATH payload. Rolling over immediately to preserve context safety.',
        role,
        provider: roleProfile.provider,
        model: roleProfile.model || null,
        sessionLogPath,
        failureTail: tailLines(commandOutput, options.failureTailLines)
      });
    }

    return withSessionTouchSummary({
      status: 'completed',
      summary: 'Executor completed without result payload.',
      resultPayloadFound: false,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  const reportedStatus = String(resultPayload.status ?? 'completed').trim().toLowerCase();
  const normalizedStatus =
    reportedStatus === 'handoff_required' || reportedStatus === 'blocked' || reportedStatus === 'failed' || reportedStatus === 'pending'
      ? reportedStatus
      : 'completed';
  const rawContextRemaining = resultPayload.contextRemaining;
  const hasContextRemaining =
    typeof rawContextRemaining === 'number' && Number.isFinite(rawContextRemaining);
  const contextRemaining = hasContextRemaining ? rawContextRemaining : null;
  const rawContextWindow = resultPayload.contextWindow;
  const hasContextWindow =
    typeof rawContextWindow === 'number' && Number.isFinite(rawContextWindow) && rawContextWindow > 0;
  const contextWindow = hasContextWindow ? rawContextWindow : null;
  const reportedContextUsedRatio = asRatio(resultPayload.contextUsedRatio, null);
  const contextUsedRatio =
    reportedContextUsedRatio ??
    (hasContextRemaining && hasContextWindow ? deriveContextUsedRatio(contextRemaining, contextWindow) : null);

  if (
    (normalizedStatus === 'completed' || normalizedStatus === 'pending') &&
    options.requireResultPayload &&
    !hasContextRemaining
  ) {
    return withSessionTouchSummary({
      status: 'handoff_required',
      reason:
        'Executor payload is missing numeric contextRemaining. Rolling over immediately to avoid low-context execution.',
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  const belowContextFloor =
    typeof contextRemaining === 'number' &&
    Number.isFinite(contextRemaining) &&
    contextRemaining <= options.contextThreshold;
  const aboveHardContextLimit =
    typeof contextUsedRatio === 'number' &&
    Number.isFinite(contextUsedRatio) &&
    contextUsedRatio >= options.contextHardUsedRatio;

  if (normalizedStatus === 'pending' && (belowContextFloor || aboveHardContextLimit)) {
    const continuity = normalizeSessionContinuity(
      plan,
      sessionContext,
      resultPayload,
      sessionLogPath,
      contactPackFile,
      sessionTouchSummary
    );
    const reasonParts = [];
    if (belowContextFloor) {
      reasonParts.push(
        `contextRemaining=${contextRemaining} is at or below the absolute floor ${options.contextThreshold}`
      );
    }
    if (aboveHardContextLimit) {
      reasonParts.push(
        `contextUsedRatio=${contextUsedRatio} is at or above the hard limit ${options.contextHardUsedRatio}`
      );
    }
    return withSessionTouchSummary({
      status: 'handoff_required',
      reason: `Executor returned pending while low-context guardrails were active (${reasonParts.join('; ')}). Rolling over immediately to preserve same-role context safety.`,
      summary: resultPayload.summary ?? null,
      contextRemaining,
      contextWindow,
      contextUsedRatio,
      currentSubtask: continuity.currentSubtask,
      nextAction: continuity.nextAction,
      stateDelta: continuity.stateDelta,
      continuityDerived: continuity.derived,
      resultPayloadFound: true,
      role,
      provider: roleProfile.provider,
      model: roleProfile.model || null,
      sessionLogPath
    });
  }

  const continuity = normalizeSessionContinuity(
    plan,
    sessionContext,
    resultPayload,
    sessionLogPath,
    contactPackFile,
    sessionTouchSummary
  );
  const missingStructuredContinuity =
    (normalizedStatus === 'pending' || normalizedStatus === 'handoff_required') &&
    continuity.derived;
  const finalStatus = missingStructuredContinuity ? 'handoff_required' : normalizedStatus;
  const finalReason = missingStructuredContinuity
    ? `Executor returned ${normalizedStatus} without structured continuity fields. Rolling over immediately to preserve safe resume state.`
    : resultPayload.reason ?? null;

  return withSessionTouchSummary({
    status: finalStatus,
    reason: finalReason,
    summary: resultPayload.summary ?? null,
    contextRemaining,
    contextWindow,
    contextUsedRatio,
    currentSubtask: continuity.currentSubtask,
    nextAction: continuity.nextAction,
    stateDelta: continuity.stateDelta,
    continuityDerived: continuity.derived,
    resultPayloadFound: true,
    role,
    provider: roleProfile.provider,
    model: roleProfile.model || null,
    sessionLogPath
  });
}

async function findPlanRecordById(paths, planId) {
  const [activePlans, completedPlans] = await Promise.all([
    loadPlanRecords(paths.rootDir, paths.activeDir, 'active'),
    loadPlanRecords(paths.rootDir, paths.completedDir, 'completed')
  ]);

  return (
    activePlans.find((candidate) => candidate.planId === planId) ??
    completedPlans.find((candidate) => candidate.planId === planId) ??
    null
  );
}

function syncPlanRecord(plan, nextRecord) {
  if (!nextRecord) {
    return;
  }

  plan.filePath = nextRecord.filePath;
  plan.rel = nextRecord.rel;
  plan.phase = nextRecord.phase;
  plan.status = nextRecord.status;
  plan.metadata = nextRecord.metadata;
  plan.content = nextRecord.content;
  plan.tags = nextRecord.tags;
  plan.specTargets = nextRecord.specTargets;
  plan.deliveryClass = nextRecord.deliveryClass;
  plan.executionScope = nextRecord.executionScope;
  plan.implementationTargets = nextRecord.implementationTargets;
  plan.parentPlanId = nextRecord.parentPlanId ?? null;
  plan.dependencies = nextRecord.dependencies;
  plan.riskTier = nextRecord.riskTier;
  plan.securityApproval = nextRecord.securityApproval;
  plan.autonomyAllowed = nextRecord.autonomyAllowed;
}


function resolveDefaultValidationCommands(rootDir, configuredCommands) {
  if (Array.isArray(configuredCommands) && configuredCommands.length > 0) {
    return configuredCommands;
  }

  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fsSync.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf8'));
    const scripts = parsed.scripts ?? {};
    const preferred = ['docs:verify', 'conformance:verify', 'architecture:verify', 'agent:verify', 'plans:verify'];
    return preferred.filter((name) => typeof scripts[name] === 'string').map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

function parseValidationCommandList(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value
    .split(';;')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSemanticProofMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'required') {
    return 'required';
  }
  return 'advisory';
}

function validationLaneName(label) {
  return label.toLowerCase() === 'validation' ? 'always' : 'host-required';
}

function derivedValidationCommandId(lane, index) {
  return `${lane}:${index + 1}`;
}

function normalizeValidationCommandSpec(entry, lane, index) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const command = String(entry.command ?? '').trim();
    if (!command) {
      return null;
    }
    const explicitId = String(entry.id ?? '').trim();
    return {
      id: explicitId || derivedValidationCommandId(lane, index),
      command,
      type: String(entry.type ?? '').trim().toLowerCase(),
      emitsFindings: asBoolean(entry.emitsFindings, false),
      emitsArtifacts: asBoolean(entry.emitsArtifacts, false)
    };
  }

  const command = String(entry ?? '').trim();
  if (!command) {
    return null;
  }
  return {
    id: derivedValidationCommandId(lane, index),
    command,
    type: lane === 'host-required' ? 'host-required' : '',
    emitsFindings: false,
    emitsArtifacts: false
  };
}

function normalizeValidationCommandSpecs(entries, lane) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => normalizeValidationCommandSpec(entry, lane, index))
    .filter(Boolean);
}

function resolveAlwaysValidationCommands(rootDir, options, config) {
  const explicit = parseValidationCommandList(options.validationCommands);
  if (explicit.length > 0) {
    return normalizeValidationCommandSpecs(explicit, 'always');
  }

  if (Array.isArray(config.validation?.always) && config.validation.always.length > 0) {
    return normalizeValidationCommandSpecs(config.validation.always, 'always');
  }

  return normalizeValidationCommandSpecs(resolveDefaultValidationCommands(rootDir, config.validationCommands), 'always');
}

function resolveHostRequiredValidationCommands(config) {
  return normalizeValidationCommandSpecs(config.validation?.hostRequired, 'host-required');
}

function resolveHostValidationMode(config) {
  const mode = String(config.validation?.host?.mode ?? DEFAULT_HOST_VALIDATION_MODE).trim().toLowerCase();
  if (mode === 'ci' || mode === 'local' || mode === 'hybrid') {
    return mode;
  }
  return DEFAULT_HOST_VALIDATION_MODE;
}

function validationCommandResultPath(paths, state, plan, lane, spec, index) {
  const runId = state?.runId ?? 'run';
  const planToken = (plan?.planId ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-');
  const laneToken = String(lane ?? 'validation').replace(/[^A-Za-z0-9._-]/g, '-');
  const specToken = String(spec?.id ?? derivedValidationCommandId(lane, index)).replace(/[^A-Za-z0-9._-]/g, '-');
  const baseDir = path.join(paths.runtimeDir, runId, 'validation-results');
  const fileName = `${planToken}-${laneToken}-${index + 1}-${specToken}.json`;
  return {
    abs: path.join(baseDir, fileName),
    rel: toPosix(path.relative(paths.rootDir, path.join(baseDir, fileName)))
  };
}

function normalizeValidationFindingFiles(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => toPosix(String(entry ?? '').trim()).replace(/^\.?\//, ''))
      .filter(Boolean)
  )];
}

function normalizeValidationReferenceList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => toPosix(String(entry ?? '').trim()))
      .filter(Boolean)
  )];
}

function normalizeValidationResultPayload(payload, spec, lane, command, outputLogPath = null) {
  const status = String(payload?.status ?? '').trim().toLowerCase();
  return {
    validationId: String(payload?.validationId ?? spec.id).trim() || spec.id,
    command,
    lane,
    type: String(payload?.type ?? spec.type ?? '').trim().toLowerCase(),
    status: status === 'passed' || status === 'failed' || status === 'pending' ? status : '',
    summary: String(payload?.summary ?? '').trim(),
    startedAt: trimmedString(payload?.startedAt),
    finishedAt: trimmedString(payload?.finishedAt),
    evidenceRefs: normalizeValidationReferenceList(payload?.evidenceRefs),
    artifactRefs: normalizeValidationReferenceList(payload?.artifactRefs),
    findingFiles: normalizeValidationFindingFiles(payload?.findingFiles),
    outputLogPath
  };
}

function ensurePlanValidationResults(state, planId) {
  if (!state.validationResults || typeof state.validationResults !== 'object') {
    state.validationResults = {};
  }
  if (!state.validationResults[planId] || typeof state.validationResults[planId] !== 'object') {
    state.validationResults[planId] = {
      always: [],
      'host-required': [],
      updatedAt: null
    };
  }
  return state.validationResults[planId];
}

function updatePlanValidationResults(state, planId, lane, results) {
  const current = ensurePlanValidationResults(state, planId);
  current[lane] = Array.isArray(results) ? results : [];
  current.updatedAt = nowIso();
}

async function runValidationCommands(paths, commands, options, label, state = null, plan = null) {
  if (commands.length === 0) {
    return {
      ok: false,
      failedCommand: '(none configured)',
      reason: `No ${label} commands configured.`,
      evidence: []
    };
  }

  const evidence = [];
  const results = [];
  const lane = validationLaneName(label);
  for (let index = 0; index < commands.length; index += 1) {
    const spec = commands[index];
    const command = spec.command;
    if (options.dryRun) {
      evidence.push(`Dry-run: ${label} command skipped: ${command}`);
      results.push({
        validationId: spec.id,
        command,
        lane,
        type: spec.type,
        status: 'passed',
        summary: `Dry-run: ${label} command skipped.`,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        evidenceRefs: [],
        artifactRefs: [],
        findingFiles: [],
        outputLogPath: null
      });
      continue;
    }

    const captureOutput = shouldCaptureCommandOutput(options);
    const resultPath = validationCommandResultPath(paths, state, plan, lane, spec, index);
    const validationEnv = {
      ...process.env,
      ORCH_RUN_ID: state?.runId ?? process.env.ORCH_RUN_ID,
      ORCH_PLAN_ID: plan?.planId ?? process.env.ORCH_PLAN_ID,
      ORCH_PLAN_FILE: plan?.rel ?? process.env.ORCH_PLAN_FILE,
      ORCH_VALIDATION_LANE: lane,
      ORCH_VALIDATION_ID: spec.id,
      ORCH_VALIDATION_TYPE: spec.type ?? '',
      ORCH_VALIDATION_RESULT_PATH: resultPath.rel
    };
    const result = await runShellMonitored(
      command,
      paths.rootDir,
      validationEnv,
      options.validationTimeoutMs,
      captureOutput ? 'pipe' : 'inherit',
      options,
      {
        phase: 'validation',
        planId: plan?.planId ?? 'run',
        role: 'validator',
        activity: label.toLowerCase() === 'validation' ? 'validation-always' : label.toLowerCase()
      }
    );
    const output = captureOutput ? executionOutput(result) : '';
    let logPathRel = null;
    if (captureOutput && state?.runId) {
      const runSessionDir = path.join(paths.runtimeDir, state.runId);
      const planToken = (plan?.planId ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-');
      const labelToken = lane.replace(/[^A-Za-z0-9._-]/g, '-');
      const logPathAbs = path.join(runSessionDir, `${planToken}-${labelToken}-${index + 1}.log`);
      logPathRel = toPosix(path.relative(paths.rootDir, logPathAbs));
      await fs.mkdir(runSessionDir, { recursive: true });
      await writeSessionExecutorLog(
        logPathAbs,
        [
          `# ${label} Command Log`,
          '',
          `- Run-ID: ${state.runId}`,
          `- Plan-ID: ${plan?.planId ?? 'n/a'}`,
          `- Command-Index: ${index + 1}/${commands.length}`,
          `- Command: ${command}`
        ],
        output,
        options.dryRun
      );
    }

    const structuredPayload = normalizeValidationResultPayload(
      await readJsonIfExists(resultPath.abs, null),
      spec,
      lane,
      command,
      logPathRel
    );

    if (didTimeout(result)) {
      const failedResult = {
        ...structuredPayload,
        status: 'failed',
        summary: structuredPayload.summary || `${label} command timed out.`,
        finishedAt: structuredPayload.finishedAt || nowIso()
      };
      results.push(failedResult);
      return {
        ok: false,
        failedCommand: command,
        reason: `${label} command timed out after ${Math.floor((options.validationTimeoutMs ?? 0) / 1000)}s`,
        evidence,
        results,
        failedResult,
        outputLogPath: logPathRel,
        failureTail: tailLines(output, options.failureTailLines)
      };
    }
    if (result.status !== 0) {
      const failedResult = {
        ...structuredPayload,
        status: structuredPayload.status || 'failed',
        summary: structuredPayload.summary || `${label} failed: ${command}`,
        finishedAt: structuredPayload.finishedAt || nowIso()
      };
      results.push(failedResult);
      return {
        ok: false,
        failedCommand: command,
        reason: `${label} failed: ${command}`,
        evidence,
        results,
        failedResult,
        outputLogPath: logPathRel,
        failureTail: tailLines(output, options.failureTailLines)
      };
    }
    results.push({
      ...structuredPayload,
      status: structuredPayload.status || 'passed',
      summary: structuredPayload.summary || `${label} passed: ${command}`,
      finishedAt: structuredPayload.finishedAt || nowIso()
    });
    if (logPathRel) {
      evidence.push(`${label} output log: ${logPathRel}`);
    }
    evidence.push(`${label} passed: ${command}`);
  }

  return {
    ok: true,
    evidence,
    results
  };
}

async function runAlwaysValidation(paths, options, config, state = null, plan = null) {
  const commands = resolveAlwaysValidationCommands(paths.rootDir, options, config);
  if (commands.length === 0 && !options.requireAlwaysValidationCommands) {
    return {
      ok: true,
      evidence: ['Validation lane skipped: no validation.always commands configured.']
    };
  }
  return runValidationCommands(paths, commands, options, 'Validation', state, plan);
}

function hostProviderResultPath(paths, state, planId, provider, attemptId) {
  const baseDir = path.join(paths.runtimeDir, state.runId, 'host-validation');
  const attemptToken = String(attemptId ?? 'attempt').replace(/[^A-Za-z0-9_-]/g, '-');
  const fileName = `${planId}-${provider}-${attemptToken}.result.json`;
  return {
    abs: path.join(baseDir, fileName),
    rel: toPosix(path.relative(paths.rootDir, path.join(baseDir, fileName)))
  };
}

async function executeHostProviderCommand(provider, command, commands, paths, state, plan, options) {
  const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resultPaths = hostProviderResultPath(paths, state, plan.planId, provider, attemptId);
  const logPathAbs = resultPaths.abs.replace(/\.result\.json$/, '.log');
  const logPathRel = toPosix(path.relative(paths.rootDir, logPathAbs));
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(resultPaths.abs), { recursive: true });
  }

  if (options.dryRun) {
    return {
      status: 'passed',
      evidence: [`Dry-run: host validation (${provider}) command skipped: ${command}`],
      results: [],
      provider
    };
  }

  const env = {
    ...process.env,
    ORCH_RUN_ID: state.runId,
    ORCH_PLAN_ID: plan.planId,
    ORCH_PLAN_FILE: plan.rel,
    ORCH_HOST_PROVIDER: provider,
    ORCH_HOST_VALIDATION_COMMANDS: JSON.stringify(commands),
    ORCH_HOST_VALIDATION_RESULT_PATH: resultPaths.rel
  };

  const captureOutput = shouldCaptureCommandOutput(options);
  const outputLogPath = captureOutput ? logPathRel : null;
  const executionResult = await runShellMonitored(
    command,
    paths.rootDir,
    env,
    options.hostValidationTimeoutMs,
    captureOutput ? 'pipe' : 'inherit',
    options,
    {
      phase: 'host-validation',
      planId: plan.planId,
      role: provider,
      activity: 'validation-host'
    }
  );
  const output = captureOutput ? executionOutput(executionResult) : '';
  if (captureOutput) {
    await writeSessionExecutorLog(
      logPathAbs,
      [
        '# Host Validation Command Log',
        '',
        `- Run-ID: ${state.runId}`,
        `- Plan-ID: ${plan.planId}`,
        `- Provider: ${provider}`,
        `- Command: ${command}`
      ],
      output,
      options.dryRun
    );
  }

  if (didTimeout(executionResult)) {
    return {
      status: 'unavailable',
      provider,
      reason: `Host validation provider '${provider}' timed out after ${Math.floor((options.hostValidationTimeoutMs ?? 0) / 1000)}s`,
      outputLogPath,
      failureTail: tailLines(output, options.failureTailLines)
    };
  }

  if (executionResult.signal) {
    return {
      status: 'unavailable',
      provider,
      reason: `Host validation provider '${provider}' terminated by signal ${executionResult.signal}`,
      outputLogPath,
      failureTail: tailLines(output, options.failureTailLines)
    };
  }

  const payload = await readJsonIfExists(resultPaths.abs, null);
  if (payload && typeof payload === 'object') {
    const reported = String(payload.status ?? '').trim().toLowerCase();
    if (reported === 'passed' || reported === 'failed' || reported === 'pending') {
      if (executionResult.status !== 0 && reported === 'passed') {
        return {
          status: 'unavailable',
          provider,
          reason:
            `Host validation provider '${provider}' reported 'passed' but command exited with status ${executionResult.status}`,
          outputLogPath,
          failureTail: tailLines(output, options.failureTailLines)
        };
      }
      return {
        status: reported,
        provider,
        reason: payload.reason ?? null,
        evidence: Array.isArray(payload.evidence)
          ? payload.evidence.map((entry) => String(entry))
          : [`Host validation (${provider}) result payload loaded from ${resultPaths.rel}`],
        results: Array.isArray(payload.results) ? payload.results : [],
        failedResult: payload.failedResult ?? null,
        outputLogPath
      };
    }
  }

  if (executionResult.status === 0) {
    return {
      status: 'passed',
      provider,
      evidence: [
        `Host validation passed via ${provider} command: ${command}`,
        outputLogPath ? `Host validation output log: ${outputLogPath}` : null
      ].filter(Boolean),
      results: []
    };
  }

  return {
    status: 'unavailable',
    provider,
    reason: `Host validation provider '${provider}' command exited with status ${executionResult.status}`,
    outputLogPath,
    failureTail: tailLines(output, options.failureTailLines)
  };
}

async function runHostValidation(paths, state, plan, options, config) {
  const commands = resolveHostRequiredValidationCommands(config);
  if (commands.length === 0) {
    if (options.requireHostValidationCommands) {
      return {
        status: 'failed',
        provider: 'none',
        reason:
          'Host validation lane is required but validation.hostRequired is empty. Configure host-required validation commands.',
        evidence: []
      };
    }
    return {
      status: 'passed',
      provider: 'none',
      reason: null,
      evidence: ['No host-required validation commands configured.']
    };
  }

  const mode = resolveHostValidationMode(config);
  const ciCommand = String(config.validation?.host?.ci?.command ?? '').trim();
  const localCommand = String(config.validation?.host?.local?.command ?? '').trim();
  const capability = state.capabilities ?? {};
  const localCapable = Boolean(capability.dockerSocket) && Boolean(capability.localhostBind);

  const tryCi = async () => {
    if (!ciCommand) {
      return {
        status: 'unavailable',
        provider: 'ci',
        reason: 'No CI host-validation command configured.'
      };
    }
    await logEvent(paths, state, 'host_validation_started', {
      planId: plan.planId,
      provider: 'ci',
      mode
    }, options.dryRun);
    return executeHostProviderCommand('ci', ciCommand, commands, paths, state, plan, options);
  };

  const tryLocal = async () => {
    if (localCommand) {
      await logEvent(paths, state, 'host_validation_started', {
        planId: plan.planId,
        provider: 'local',
        mode
      }, options.dryRun);
      return executeHostProviderCommand('local', localCommand, commands, paths, state, plan, options);
    }

    if (!localCapable) {
      return {
        status: 'unavailable',
        provider: 'local',
        reason: [
          'Local host validation unavailable.',
          capability.dockerSocket ? '' : 'Docker socket not reachable.',
          capability.localhostBind ? '' : 'localhost bind is not permitted.'
        ].filter(Boolean).join(' ')
      };
    }

    const result = await runValidationCommands(
      paths,
      commands,
      {
        ...options,
        validationTimeoutMs: options.hostValidationTimeoutMs ?? options.validationTimeoutMs
      },
      'Host validation',
      state,
      plan
    );
    if (!result.ok) {
      return {
        status: 'failed',
        provider: 'local',
        reason: `Host validation failed: ${result.failedCommand}`,
        evidence: result.evidence,
        results: result.results ?? [],
        failedResult: result.failedResult ?? null,
        outputLogPath: result.outputLogPath ?? null,
        failureTail: result.failureTail ?? ''
      };
    }

    return {
      status: 'passed',
      provider: 'local',
      reason: null,
      evidence: result.evidence,
      results: result.results ?? []
    };
  };

  if (mode === 'ci') {
    const ciResult = await tryCi();
    if (ciResult.status === 'passed' || ciResult.status === 'failed') {
      return ciResult;
    }
    return {
      status: 'pending',
      provider: 'ci',
      reason: ciResult.reason ?? 'CI host validation unavailable.',
      evidence: ciResult.evidence ?? [],
      outputLogPath: ciResult.outputLogPath ?? null,
      failureTail: ciResult.failureTail ?? ''
    };
  }

  if (mode === 'local') {
    const localResult = await tryLocal();
    if (localResult.status === 'passed' || localResult.status === 'failed') {
      return localResult;
    }
    return {
      status: 'pending',
      provider: 'local',
      reason: localResult.reason ?? 'Local host validation unavailable.',
      evidence: localResult.evidence ?? [],
      outputLogPath: localResult.outputLogPath ?? null,
      failureTail: localResult.failureTail ?? ''
    };
  }

  const ciResult = await tryCi();
  if (ciResult.status === 'passed' || ciResult.status === 'failed') {
    return ciResult;
  }

  const localResult = await tryLocal();
  if (localResult.status === 'passed' || localResult.status === 'failed') {
    return localResult;
  }

  return {
    status: 'pending',
    provider: 'hybrid',
    reason: [ciResult.reason, localResult.reason].filter(Boolean).join(' | ') || 'Host validation unavailable.',
    evidence: [...(ciResult.evidence ?? []), ...(localResult.evidence ?? [])],
    outputLogPath: ciResult.outputLogPath ?? localResult.outputLogPath ?? null,
    failureTail: ciResult.failureTail || localResult.failureTail || ''
  };
}

function normalizeEvidenceReference(reference, planRel) {
  if (!reference) return null;
  const clean = String(reference).trim().split('#')[0];
  if (!clean || clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('mailto:')) {
    return null;
  }

  const planDir = toPosix(path.posix.dirname(planRel));
  const rootScopedPrefixes = ['docs/', 'apps/', 'packages/', 'scripts/', 'prisma/'];
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return toPosix(path.posix.normalize(path.posix.join(planDir, clean)));
  }
  if (clean.startsWith('evidence/')) {
    return toPosix(path.posix.normalize(path.posix.join(planDir, clean)));
  }
  if (rootScopedPrefixes.some((prefix) => clean.startsWith(prefix))) {
    return toPosix(path.posix.normalize(clean));
  }
  if (/^[A-Za-z0-9._-]+\.md$/u.test(clean)) {
    return toPosix(path.posix.normalize(clean));
  }
  return null;
}

function isRepoEvidenceReference(reference) {
  const normalized = toPosix(String(reference ?? '').trim());
  return (
    normalized.startsWith('docs/') ||
    normalized.startsWith('apps/') ||
    normalized.startsWith('packages/') ||
    normalized.startsWith('scripts/') ||
    normalized.startsWith('prisma/') ||
    /^[A-Za-z0-9._-]+\.md$/u.test(normalized)
  );
}

function isLikelyEvidenceCommand(reference) {
  const normalized = String(reference ?? '').trim();
  if (!normalized) {
    return false;
  }
  return /^(?:npm|pnpm|yarn|bun|npx|node|tsx|vitest|playwright|jest|cargo|go|pytest|uv)\b/u.test(normalized);
}

function extractEvidenceReferencesFromContent(content, planRel) {
  const found = new Set();
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  const inlineCodeRegex = /`([^`]+)`/g;
  const barePathRegex =
    /(^|[\s(:>])((?:\.\.\/|\.\/)?evidence\/[A-Za-z0-9._/-]+|(?:\.\.\/|\.\/)?(?:docs|apps|packages|scripts|prisma)\/[A-Za-z0-9._/-]+|(?:README|AGENTS|ARCHITECTURE)\.md)(?=$|[\s),.:;!?])/gm;

  function recordEvidenceReference(candidate) {
    const normalized = normalizeEvidenceReference(candidate, planRel);
    if (normalized && isRepoEvidenceReference(normalized)) {
      found.add(normalized);
    }
  }

  let linkMatch;
  while ((linkMatch = linkRegex.exec(content)) != null) {
    recordEvidenceReference(linkMatch[1]);
  }

  let codeMatch;
  while ((codeMatch = inlineCodeRegex.exec(content)) != null) {
    recordEvidenceReference(codeMatch[1]);
  }

  let barePathMatch;
  while ((barePathMatch = barePathRegex.exec(content)) != null) {
    recordEvidenceReference(barePathMatch[2]);
  }

  return [...found];
}

function extractEvidenceCommandReferencesFromContent(content) {
  const found = new Set();
  const inlineCodeRegex = /`([^`]+)`/g;
  let codeMatch;
  while ((codeMatch = inlineCodeRegex.exec(content)) != null) {
    const candidate = String(codeMatch[1] ?? '').trim();
    if (isLikelyEvidenceCommand(candidate)) {
      found.add(candidate);
    }
  }
  return [...found];
}

function evidenceReferencePriority(reference, planRel, companionEvidenceRel) {
  const normalized = toPosix(String(reference ?? '').trim());
  if (!normalized) {
    return 50;
  }
  if (companionEvidenceRel && normalized === companionEvidenceRel) {
    return 0;
  }
  if (normalized === planRel) {
    return 1;
  }
  if (normalized.startsWith('docs/exec-plans/completed/')) {
    return 2;
  }
  if (normalized.startsWith('docs/exec-plans/')) {
    return 3;
  }
  if (normalized.startsWith('docs/')) {
    return 4;
  }
  return 5;
}

async function collectEvidenceReferences(paths, plan, content, maxReferences) {
  const candidates = new Map();
  const planRel = plan.rel;
  const companionEvidenceRel = toPosix(path.posix.join('docs', 'exec-plans', 'active', 'evidence', `${plan.planId}.md`));
  const companionEvidenceAbs = path.join(paths.rootDir, companionEvidenceRel);

  function addPathCandidate(relPath) {
    const normalized = normalizeEvidenceReference(relPath, planRel);
    if (!normalized || !isRepoEvidenceReference(normalized)) {
      return;
    }
    candidates.set(`path:${normalized}`, {
      kind: 'path',
      relPath: normalized,
      priority: evidenceReferencePriority(normalized, planRel, companionEvidenceRel)
    });
  }

  function addLiteralCandidate(value, sourceAbsPath = null) {
    const normalized = String(value ?? '').trim();
    if (!isLikelyEvidenceCommand(normalized)) {
      return;
    }
    candidates.set(`literal:${normalized}`, {
      kind: 'literal',
      value: normalized,
      sourceAbsPath,
      priority: 6
    });
  }

  addPathCandidate(planRel);
  for (const relPath of extractEvidenceReferencesFromContent(content, planRel)) {
    addPathCandidate(relPath);
  }
  for (const command of extractEvidenceCommandReferencesFromContent(content)) {
    addLiteralCandidate(command, path.join(paths.rootDir, planRel));
  }

  try {
    await fs.access(companionEvidenceAbs);
    addPathCandidate(companionEvidenceRel);
    const companionContent = await fs.readFile(companionEvidenceAbs, 'utf8');
    for (const relPath of extractEvidenceReferencesFromContent(companionContent, companionEvidenceRel)) {
      addPathCandidate(relPath);
    }
    for (const command of extractEvidenceCommandReferencesFromContent(companionContent)) {
      addLiteralCandidate(command, companionEvidenceAbs);
    }
  } catch {
    // Companion evidence is optional; skip when absent.
  }

  const enriched = [];

  for (const candidate of candidates.values()) {
    if (candidate.kind === 'literal') {
      let mtimeMs = 0;
      if (candidate.sourceAbsPath) {
        try {
          const stats = await fs.stat(candidate.sourceAbsPath);
          mtimeMs = stats.mtimeMs;
        } catch {
          mtimeMs = 0;
        }
      }
      enriched.push({
        kind: 'literal',
        value: candidate.value,
        mtimeMs,
        priority: candidate.priority
      });
      continue;
    }

    const absPath = path.join(paths.rootDir, candidate.relPath);
    try {
      const stats = await fs.stat(absPath);
      enriched.push({
        kind: 'path',
        relPath: candidate.relPath,
        absPath,
        mtimeMs: stats.mtimeMs,
        priority: candidate.priority
      });
    } catch {
      // Skip missing references to keep index deterministic and valid.
    }
  }

  enriched.sort((a, b) => (
    a.priority - b.priority ||
    b.mtimeMs - a.mtimeMs ||
    (a.kind === 'path' ? a.relPath : a.value).localeCompare(b.kind === 'path' ? b.relPath : b.value)
  ));
  const selected = enriched.slice(0, maxReferences);
  return {
    selected,
    totalFound: enriched.length
  };
}

function resolveEvidenceLifecycleConfig(config) {
  const lifecycle = config?.evidence?.lifecycle ?? {};
  return {
    trackMode: String(lifecycle.trackMode ?? DEFAULT_EVIDENCE_TRACK_MODE).trim().toLowerCase(),
    dedupMode: String(lifecycle.dedupMode ?? DEFAULT_EVIDENCE_DEDUP_MODE).trim().toLowerCase(),
    pruneOnComplete: asBoolean(lifecycle.pruneOnComplete, DEFAULT_EVIDENCE_PRUNE_ON_COMPLETE),
    keepMaxPerBlocker: Math.max(1, asInteger(lifecycle.keepMaxPerBlocker, DEFAULT_EVIDENCE_KEEP_MAX_PER_BLOCKER))
  };
}

function evidenceMaintenanceRootsForPlan(plan) {
  return [
    assertSafeRelativePlanPath(plan.rel),
    'docs/exec-plans/active/evidence/',
    'docs/exec-plans/completed/evidence/',
    'docs/exec-plans/evidence-index/',
    `docs/exec-plans/evidence-index/${plan.planId}.md`
  ];
}

function hasPlanEvidencePathChanges(plan, touchedPaths = []) {
  const roots = evidenceMaintenanceRootsForPlan(plan);
  return normalizeTouchedPathList(touchedPaths).some((filePath) => (
    roots.some((root) => pathMatchesRootPrefix(filePath, root))
  ));
}

function evaluateSessionEvidenceMaintenance(plan, paths, sessionResult, options) {
  const indexMode = normalizeSessionEvidenceMode(
    options.evidenceSessionIndexRefreshMode,
    DEFAULT_EVIDENCE_SESSION_INDEX_REFRESH_MODE
  );
  const curationMode = normalizeSessionEvidenceMode(
    options.evidenceSessionCurationMode,
    DEFAULT_EVIDENCE_SESSION_CURATION_MODE
  );

  let changed = false;
  let detectedVia = 'none';
  const touchSummary = sessionResult?.touchSummary ?? null;
  if (Array.isArray(touchSummary?.touched)) {
    changed = hasPlanEvidencePathChanges(plan, touchSummary.touched);
    detectedVia = 'touch-summary';
  } else {
    const dirtyPaths = dirtyRepoPaths(paths.rootDir, { includeTransient: true });
    changed = hasPlanEvidencePathChanges(plan, dirtyPaths);
    detectedVia = 'dirty-scan';
  }

  const shouldRefreshIndex = indexMode === 'always' || (indexMode === 'on-change' && changed);
  const shouldCurate = curationMode === 'always' || (curationMode === 'on-change' && changed);
  return {
    changed,
    detectedVia,
    shouldRefreshIndex,
    shouldCurate,
    indexMode,
    curationMode
  };
}

function evidenceStemInfo(fileName) {
  const stem = path.parse(fileName).name.toLowerCase();
  const hasNumericPrefix = /^\d+-/.test(stem);
  const withoutPrefix = stem.replace(/^\d+-/, '');
  let tokens = withoutPrefix.split('-').filter(Boolean);
  const hasNoise = tokens.some((token) => EVIDENCE_NOISE_TOKENS.has(token));

  if (hasNoise) {
    const afterIndex = tokens.findIndex((token) => token === 'after');
    const postIndex = tokens.findIndex((token, index) => token === 'post' && index > 1);
    const boundaryIndex =
      afterIndex > 1 && postIndex > 1 ? Math.min(afterIndex, postIndex) : afterIndex > 1 ? afterIndex : postIndex;
    if (boundaryIndex > 1) {
      tokens = tokens.slice(0, boundaryIndex);
    }

    while (tokens.length > 2) {
      const last = tokens[tokens.length - 1];
      if (EVIDENCE_NOISE_TOKENS.has(last) || /^\d+$/.test(last)) {
        tokens = tokens.slice(0, -1);
        continue;
      }
      break;
    }
  }

  const key = (tokens.join('-') || withoutPrefix || stem).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return {
    key,
    noisy: hasNoise,
    hasNumericPrefix
  };
}

async function collectEvidenceMarkdownFiles(directoryAbs, directoryRel, rootDir) {
  const entries = await fs.readdir(directoryAbs, { withFileTypes: true });
  const markdownFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'readme.md') {
      continue;
    }
    const absPath = path.join(directoryAbs, entry.name);
    const relPath = toPosix(path.relative(rootDir, absPath));
    const stats = await fs.stat(absPath);
    const info = evidenceStemInfo(entry.name);
    markdownFiles.push({
      fileName: entry.name,
      absPath,
      relPath,
      mtimeMs: stats.mtimeMs,
      key: info.key,
      noisy: info.noisy,
      hasNumericPrefix: info.hasNumericPrefix
    });
  }

  return markdownFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName));
}

function titleCaseFromSlug(value) {
  return String(value)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function defaultEvidenceReadmePreamble(directoryRel) {
  const folderName = path.posix.basename(directoryRel);
  const title = titleCaseFromSlug(folderName || 'evidence');
  return [
    `# ${title} Evidence`,
    '',
    `Path: \`${directoryRel}\``,
    'Purpose: Canonical evidence artifacts for this execution area.'
  ].join('\n');
}

function renderEvidenceDirectoryReadme(rawReadme, directoryRel, keptFiles) {
  const artifactLines =
    keptFiles.length > 0
      ? keptFiles
          .sort((a, b) => a.fileName.localeCompare(b.fileName))
          .map((entry) => `- [\`${entry.fileName}\`](./${entry.fileName})`)
      : ['- none'];
  const curationLines = [
    '- Dedup Mode: strict-upsert',
    `- Files Currently Kept: ${keptFiles.length}`,
    '- Canonicalized: true'
  ];

  const preamble = sectionlessPreamble(rawReadme) || defaultEvidenceReadmePreamble(directoryRel);
  const resultSummary = sectionBody(rawReadme, 'Result Summary');
  const rebuilt = [
    preamble,
    '',
    '## Evidence Artifacts',
    '',
    ...artifactLines,
    ''
  ];
  if (resultSummary) {
    rebuilt.push('## Result Summary', '', resultSummary, '');
  }
  rebuilt.push('## Curation', '', ...curationLines, '');
  return `${rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

async function writeEvidenceIndexReadme(paths, options) {
  if (options.dryRun) {
    return;
  }

  await fs.mkdir(paths.evidenceIndexDir, { recursive: true });
  const indexFiles = await listMarkdownFiles(paths.evidenceIndexDir, ['README.md', '.gitkeep']);
  const readmeAbs = path.join(paths.evidenceIndexDir, 'README.md');
  const lines = [
    '# Evidence Index',
    '',
    'Purpose: Canonical, plan-scoped evidence references after curation/completion.',
    '',
    '## Usage',
    '',
    '- Each completed plan should point `Done-Evidence` to `docs/exec-plans/evidence-index/<plan-id>.md`.',
    '- Each index file is the compact source for retained evidence links.',
    '',
    '## Indexed Plans',
    ''
  ];

  if (indexFiles.length === 0) {
    lines.push('- none');
  } else {
    for (const indexFile of indexFiles) {
      const rel = toPosix(path.relative(paths.evidenceIndexDir, indexFile));
      lines.push(`- [\`${rel}\`](./${rel})`);
    }
  }

  lines.push('', '## Policy', '');
  lines.push('- Evidence is curated to keep useful, non-redundant information.');
  lines.push('- Repeated unchanged blocker reruns are collapsed by strict-upsert policy.');
  lines.push('');

  const rendered = `${lines.join('\n')}\n`;
  let existing = null;
  try {
    existing = await fs.readFile(readmeAbs, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== rendered) {
    await fs.writeFile(readmeAbs, rendered, 'utf8');
  }
}

async function curateEvidenceDirectory(paths, directoryRel, options, keepMaxPerBlocker) {
  const directoryAbs = path.join(paths.rootDir, directoryRel);
  const files = await collectEvidenceMarkdownFiles(directoryAbs, directoryRel, paths.rootDir);
  if (files.length === 0) {
    return {
      directoryRel,
      keptCount: 0,
      prunedCount: 0,
      replacements: []
    };
  }

  const byKey = new Map();
  for (const file of files) {
    if (!byKey.has(file.key)) {
      byKey.set(file.key, []);
    }
    byKey.get(file.key).push(file);
  }

  const keep = new Set();
  const prune = [];
  const replacements = [];

  for (const groupFiles of byKey.values()) {
    groupFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName));
    const shouldDeduplicate =
      groupFiles.length > keepMaxPerBlocker &&
      (groupFiles.some((entry) => entry.noisy) || groupFiles.every((entry) => entry.hasNumericPrefix));

    if (!shouldDeduplicate) {
      for (const entry of groupFiles) {
        keep.add(entry.relPath);
      }
      continue;
    }

    const keepEntries = groupFiles.slice(0, keepMaxPerBlocker);
    for (const entry of keepEntries) {
      keep.add(entry.relPath);
    }

    const replacementTarget = keepEntries[0]?.relPath ?? groupFiles[0].relPath;
    for (const entry of groupFiles.slice(keepMaxPerBlocker)) {
      prune.push(entry);
      replacements.push({
        fromRel: entry.relPath,
        fallbackToRel: replacementTarget
      });
    }
  }

  const readmeAbs = path.join(directoryAbs, 'README.md');
  const readmeExists = await exists(readmeAbs);
  const readmeRel = toPosix(path.relative(paths.rootDir, readmeAbs));
  const keptFiles = files.filter((entry) => !prune.some((removed) => removed.relPath === entry.relPath));

  const finalizedReplacements = replacements.map((entry) => ({
    fromRel: entry.fromRel,
    toRel: readmeRel || entry.fallbackToRel
  }));

  if (!options.dryRun) {
    for (const removed of prune) {
      await fs.unlink(removed.absPath);
    }

    let rawReadme = '';
    if (readmeExists) {
      rawReadme = await fs.readFile(readmeAbs, 'utf8');
    }
    const nextReadme = renderEvidenceDirectoryReadme(rawReadme, directoryRel, keptFiles);
    if (nextReadme !== rawReadme) {
      await fs.writeFile(readmeAbs, nextReadme, 'utf8');
    }
  }

  return {
    directoryRel,
    keptCount: keptFiles.length,
    prunedCount: prune.length,
    replacements: finalizedReplacements
  };
}

function replacePathEverywhere(content, fromValue, toValue) {
  if (!fromValue || fromValue === toValue || !content.includes(fromValue)) {
    return { content, replaced: 0 };
  }
  const parts = content.split(fromValue);
  const replaced = Math.max(0, parts.length - 1);
  return {
    content: parts.join(toValue),
    replaced
  };
}

async function collectExecutionPlanMarkdownFiles(paths) {
  const collected = [];
  const visited = new Set();

  async function walk(directoryAbs) {
    const normalizedDir = toPosix(directoryAbs);
    if (visited.has(normalizedDir)) {
      return;
    }
    visited.add(normalizedDir);

    let entries = [];
    try {
      entries = await fs.readdir(directoryAbs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }
      collected.push(entryPath);
    }
  }

  await walk(paths.activeDir);
  await walk(paths.completedDir);
  return collected.sort((a, b) => a.localeCompare(b));
}

async function rewriteExecutionDocPathReferences(paths, replacements, options) {
  if (replacements.length === 0) {
    return { filesUpdated: 0, replacementsApplied: 0 };
  }

  const files = await collectExecutionPlanMarkdownFiles(paths);
  let filesUpdated = 0;
  let replacementsApplied = 0;

  for (const filePath of files) {
    const fileRel = toPosix(path.relative(paths.rootDir, filePath));
    const fileDir = path.posix.dirname(fileRel);
    const original = await fs.readFile(filePath, 'utf8');
    let updated = original;

    for (const replacement of replacements) {
      const direct = replacePathEverywhere(updated, replacement.fromRel, replacement.toRel);
      updated = direct.content;
      replacementsApplied += direct.replaced;

      const relativeFrom = toPosix(path.posix.relative(fileDir, replacement.fromRel));
      const relativeTo = toPosix(path.posix.relative(fileDir, replacement.toRel));
      const relative = replacePathEverywhere(updated, relativeFrom, relativeTo);
      updated = relative.content;
      replacementsApplied += relative.replaced;

      const dotRelativeFrom = relativeFrom.startsWith('.') ? relativeFrom : `./${relativeFrom}`;
      const dotRelativeTo = relativeTo.startsWith('.') ? relativeTo : `./${relativeTo}`;
      const dotRelative = replacePathEverywhere(updated, dotRelativeFrom, dotRelativeTo);
      updated = dotRelative.content;
      replacementsApplied += dotRelative.replaced;
    }

    if (updated !== original) {
      filesUpdated += 1;
      if (!options.dryRun) {
        await fs.writeFile(filePath, updated, 'utf8');
      }
    }
  }

  return {
    filesUpdated,
    replacementsApplied
  };
}

async function rewriteEvidenceReferencesInPlanDocs(paths, replacements, options) {
  return rewriteExecutionDocPathReferences(paths, replacements, options);
}

async function rewritePlanFileReferencesInPlanDocs(paths, fromRel, toRel, options) {
  if (!fromRel || !toRel || fromRel === toRel) {
    return { filesUpdated: 0, replacementsApplied: 0 };
  }
  return rewriteExecutionDocPathReferences(
    paths,
    [{ fromRel: assertSafeRelativePlanPath(fromRel), toRel: assertSafeRelativePlanPath(toRel) }],
    options
  );
}

function evidenceDirectoriesFromContent(content, planRel) {
  const references = extractEvidenceReferencesFromContent(content, planRel);
  const directories = new Set();
  for (const ref of references) {
    if (!ref.startsWith('docs/exec-plans/') || !ref.includes('/evidence/')) {
      continue;
    }
    directories.add(toPosix(path.posix.dirname(ref)));
  }
  return [...directories].sort();
}

function matchesPlanIdFilter(plan, planIdFilter) {
  if (!planIdFilter) {
    return true;
  }
  const needle = String(planIdFilter).trim().toLowerCase();
  return plan.planId.toLowerCase().includes(needle) || plan.rel.toLowerCase().includes(needle);
}

async function curateEvidenceDirectories(paths, directories, options, config) {
  const lifecycle = resolveEvidenceLifecycleConfig(config);
  if (lifecycle.trackMode !== 'curated' || lifecycle.dedupMode !== 'strict-upsert') {
    return {
      directoriesVisited: 0,
      filesPruned: 0,
      filesKept: 0,
      filesUpdated: 0,
      replacementsApplied: 0
    };
  }

  const uniqueDirectories = [...new Set(directories)].sort();
  const allReplacements = [];
  let filesPruned = 0;
  let filesKept = 0;

  for (const directoryRel of uniqueDirectories) {
    const directoryAbs = path.join(paths.rootDir, directoryRel);
    if (!(await exists(directoryAbs))) {
      continue;
    }
    const result = await curateEvidenceDirectory(paths, directoryRel, options, lifecycle.keepMaxPerBlocker);
    filesPruned += result.prunedCount;
    filesKept += result.keptCount;
    allReplacements.push(...result.replacements);
  }

  const replacementBySource = new Map();
  for (const replacement of allReplacements) {
    replacementBySource.set(replacement.fromRel, replacement.toRel);
  }
  const replacements = [...replacementBySource.entries()].map(([fromRel, toRel]) => ({ fromRel, toRel }));
  const rewriteSummary = await rewriteEvidenceReferencesInPlanDocs(paths, replacements, options);

  return {
    directoriesVisited: uniqueDirectories.length,
    filesPruned,
    filesKept,
    filesUpdated: rewriteSummary.filesUpdated,
    replacementsApplied: rewriteSummary.replacementsApplied
  };
}

async function curateEvidenceForPlan(plan, paths, options, config) {
  if (!(await exists(plan.filePath))) {
    return {
      directoriesVisited: 0,
      filesPruned: 0,
      filesKept: 0,
      filesUpdated: 0,
      replacementsApplied: 0
    };
  }

  const content = await fs.readFile(plan.filePath, 'utf8');
  const directories = evidenceDirectoriesFromContent(content, plan.rel);
  return curateEvidenceDirectories(paths, directories, options, config);
}

async function collectAllActiveEvidenceDirectories(paths, planIdFilter = null) {
  const root = path.join(paths.activeDir, 'evidence');
  if (!(await exists(root))) {
    return [];
  }

  const normalizedFilter = planIdFilter ? String(planIdFilter).trim().toLowerCase() : null;
  const directories = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    let hasMarkdownArtifact = false;

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
        hasMarkdownArtifact = true;
      }
    }

    if (!hasMarkdownArtifact) {
      continue;
    }

    const rel = toPosix(path.relative(paths.rootDir, current));
    if (normalizedFilter && !rel.toLowerCase().includes(normalizedFilter)) {
      continue;
    }
    directories.push(rel);
  }

  return directories.sort();
}

async function collectAllCompletedEvidenceDirectories(paths, planIdFilter = null) {
  const completedPlans = await loadPlanRecords(paths.rootDir, paths.completedDir, 'completed');
  const directories = new Set();

  for (const plan of completedPlans) {
    if (!matchesPlanIdFilter(plan, planIdFilter)) {
      continue;
    }
    const refs = evidenceDirectoriesFromContent(plan.content, plan.rel);
    for (const dir of refs) {
      directories.add(dir);
    }
  }

  return [...directories].sort();
}

function normalizeCurationScope(scopeValue) {
  const normalized = String(scopeValue ?? 'all').trim().toLowerCase();
  if (normalized === 'active' || normalized === 'completed' || normalized === 'all') {
    return normalized;
  }
  throw new Error(`Invalid scope '${scopeValue}'. Expected one of: active, completed, all.`);
}

async function writeEvidenceIndex(paths, plan, content, options, config, overrides = {}) {
  const mode = String(config.evidence?.compaction?.mode ?? 'compact-index').trim().toLowerCase();
  if (mode !== 'compact-index') {
    return null;
  }

  const maxReferences = asInteger(config.evidence?.compaction?.maxReferences, DEFAULT_EVIDENCE_MAX_REFERENCES);
  const { selected, totalFound } = await collectEvidenceReferences(paths, plan, content, maxReferences);
  const sourcePlanRel = toPosix(String(overrides.sourcePlanRel ?? plan.rel));
  const indexRel = toPosix(path.relative(paths.rootDir, path.join(paths.evidenceIndexDir, `${plan.planId}.md`)));
  const indexAbs = path.join(paths.rootDir, indexRel);

  const lines = [
    `# Evidence Index: ${plan.planId}`,
    '',
    `- Plan-ID: ${plan.planId}`,
    `- Last Updated: ${todayIsoDate()}`,
    `- Source Plan: \`${sourcePlanRel}\``,
    `- Total Evidence References Found: ${totalFound}`,
    `- References Included: ${selected.length}`,
    ''
  ];

  lines.push('## Canonical References', '');
  if (selected.length === 0) {
    lines.push('- No canonical evidence references detected in the plan or companion evidence yet.');
  } else {
    for (const ref of selected) {
      if (ref.kind === 'literal') {
        lines.push(`- \`${ref.value}\``);
        continue;
      }
      const relativeLink = toPosix(path.relative(path.dirname(indexAbs), ref.absPath));
      lines.push(`- [${ref.relPath}](${relativeLink})`);
    }
  }

  lines.push('', '## Notes', '');
  lines.push('- This index is the canonical compact view for plan evidence.');
  lines.push('- Superseded rerun artifacts are curated according to evidence.lifecycle policy.');
  lines.push('');

  if (!options.dryRun) {
    const rendered = `${lines.join('\n')}\n`;
    await fs.mkdir(path.dirname(indexAbs), { recursive: true });
    let existingText = null;
    try {
      existingText = await fs.readFile(indexAbs, 'utf8');
    } catch {
      existingText = null;
    }
    if (existingText !== rendered) {
      await fs.writeFile(indexAbs, rendered, 'utf8');
    }
    await writeEvidenceIndexReadme(paths, options);
  }

  return {
    indexPath: indexRel,
    referenceCount: selected.length,
    totalFound
  };
}

async function refreshEvidenceIndex(plan, paths, state, options, config) {
  if (!(await exists(plan.filePath))) {
    return null;
  }

  const content = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, content, options, config);
  if (!indexResult) {
    return null;
  }

  const previous = ensureEvidenceState(state, plan.planId);
  const signature = `${indexResult.indexPath}|${indexResult.referenceCount}|${indexResult.totalFound}`;
  state.evidenceState[plan.planId] = {
    indexPath: indexResult.indexPath,
    referenceCount: indexResult.referenceCount,
    signature,
    updatedAt: nowIso()
  };

  if (previous.signature !== signature) {
    await logEvent(paths, state, 'evidence_compacted', {
      planId: plan.planId,
      indexPath: indexResult.indexPath,
      referenceCount: indexResult.referenceCount,
      totalFound: indexResult.totalFound
    }, options.dryRun);
  }

  return indexResult;
}

async function canonicalizeCompletedPlanEvidence(plan, paths, options, config) {
  if (!(await exists(plan.filePath))) {
    return { updated: false, indexPath: null };
  }

  const raw = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, raw, options, config);
  if (!indexResult) {
    return { updated: false, indexPath: null };
  }

  let updated = setPlanDocumentFields(raw, {
    Status: 'completed',
    'Done-Evidence': indexResult.indexPath
  });
  updated = upsertSection(updated, 'Evidence Index', [
    `- Canonical Index: \`${indexResult.indexPath}\``,
    `- Included References: ${indexResult.referenceCount}`,
    `- Total References Found: ${indexResult.totalFound}`
  ]);
  updated = removeDuplicateSections(updated, 'Evidence Index');
  updated = normalizeBulletSection(updated, 'Evidence Index');
  updated = removeDuplicateSections(updated, 'Closure');
  updated = normalizeClosureSection(updated);
  updated = normalizeBulletSection(updated, 'Closure');

  const changed = updated !== raw;
  if (changed && !options.dryRun) {
    await fs.writeFile(plan.filePath, updated, 'utf8');
  }

  return {
    updated: changed,
    indexPath: indexResult.indexPath
  };
}

async function canonicalizeCompletedPlansEvidence(paths, options, config, planIdFilter = null) {
  const completedPlans = await loadPlanRecords(paths.rootDir, paths.completedDir, 'completed');
  let visited = 0;
  let updated = 0;
  let indexed = 0;

  for (const plan of completedPlans) {
    if (!matchesPlanIdFilter(plan, planIdFilter)) {
      continue;
    }
    visited += 1;
    const result = await canonicalizeCompletedPlanEvidence(plan, paths, options, config);
    if (result.updated) {
      updated += 1;
    }
    if (result.indexPath) {
      indexed += 1;
    }
  }

  return {
    plansVisited: visited,
    plansUpdated: updated,
    plansIndexed: indexed
  };
}

async function resolveCompletedPlanTargetPath(planFilePath, completedDir) {
  const completedDate = isoDate(nowIso());
  const currentBase = path.parse(path.basename(planFilePath));
  const completedName = datedPlanFileName(completedDate, currentBase.name, currentBase.ext || '.md');
  let targetPath = path.join(completedDir, completedName);
  if (await exists(targetPath)) {
    const parsed = path.parse(completedName);
    targetPath = path.join(completedDir, `${parsed.name}-${Date.now()}${parsed.ext || '.md'}`);
  }
  return targetPath;
}

async function finalizeCompletedPlan(plan, paths, state, validationEvidence, options, config, completionInfo = {}) {
  const now = nowIso();
  const targetPath = completionInfo.targetPath
    ? path.resolve(completionInfo.targetPath)
    : await resolveCompletedPlanTargetPath(plan.filePath, paths.completedDir);
  const completedRel = toPosix(path.relative(paths.rootDir, targetPath));
  const raw = await fs.readFile(plan.filePath, 'utf8');
  const indexResult = await writeEvidenceIndex(paths, plan, raw, options, config, { sourcePlanRel: completedRel });
  const doneEvidenceValue = indexResult?.indexPath ?? (validationEvidence.length > 0 ? validationEvidence.join(', ') : 'none');
  const updatedMetadata = setPlanDocumentFields(raw, {
    Status: 'completed',
    'Done-Evidence': doneEvidenceValue
  });

  const validationLines = validationEvidence.length > 0
    ? validationEvidence.map((line) => `- ${line}`)
    : ['- No validation commands configured.'];

  const closureLines = [
    `- Completed At: ${now}`,
    `- Run-ID: ${state.runId}`,
    `- Mode: ${state.effectiveMode}`,
    '- Commit: recorded in run events after atomic commit.',
    `- Termination Reason: completed`
  ];
  const planDurationSeconds = durationSeconds(completionInfo.planStartedAt, now);
  const runDurationSeconds = durationSeconds(state.startedAt, now);
  const snapshotLines = [
    `- Plan-ID: ${plan.planId}`,
    `- Sessions Executed: ${completionInfo.sessionsExecuted ?? 'unknown'}`,
    `- Rollovers: ${completionInfo.rollovers ?? 0}`,
    `- Host Validation Provider: ${completionInfo.hostValidationProvider ?? 'none'}`,
    `- Risk Tier (Declared): ${completionInfo.declaredRiskTier ?? plan.riskTier ?? 'low'}`,
    `- Risk Tier (Effective): ${completionInfo.effectiveRiskTier ?? plan.riskTier ?? 'low'}`,
    `- Role Pipeline: ${completionInfo.rolePipeline ?? ROLE_WORKER}`,
    `- Plan Duration: ${formatDuration(planDurationSeconds)} (${planDurationSeconds ?? 'unknown'}s)`,
    `- Run Duration At Completion: ${formatDuration(runDurationSeconds)} (${runDurationSeconds ?? 'unknown'}s)`
  ];
  const proofCoverageLines = completionInfo.semanticProofReport
    ? semanticProofCoverageLines(completionInfo.semanticProofReport)
    : [];
  if (completionInfo.semanticProofManifestPath) {
    proofCoverageLines.push(`- Manifest: ${completionInfo.semanticProofManifestPath}`);
  }

  let finalContent = upsertSection(updatedMetadata, 'Validation Evidence', validationLines);
  if (proofCoverageLines.length > 0) {
    finalContent = upsertSection(finalContent, 'Proof Coverage', proofCoverageLines);
  }
  finalContent = upsertSection(finalContent, 'Completion Snapshot', snapshotLines);
  if (indexResult?.indexPath) {
    finalContent = upsertSection(finalContent, 'Evidence Index', [
      `- Canonical Index: \`${indexResult.indexPath}\``,
      `- Included References: ${indexResult.referenceCount}`,
      `- Total References Found: ${indexResult.totalFound}`
    ]);
  }
  finalContent = upsertSection(finalContent, 'Closure', closureLines);

  if (!options.dryRun) {
    await fs.writeFile(targetPath, finalContent, 'utf8');
    await fs.unlink(plan.filePath);
  }

  const rewriteSummary = await rewritePlanFileReferencesInPlanDocs(paths, plan.rel, completedRel, options);
  if (rewriteSummary.filesUpdated > 0 || rewriteSummary.replacementsApplied > 0) {
    await logEvent(paths, state, 'plan_reference_rewritten', {
      planId: plan.planId,
      fromPath: plan.rel,
      toPath: completedRel,
      filesUpdated: rewriteSummary.filesUpdated,
      replacementsApplied: rewriteSummary.replacementsApplied
    }, options.dryRun);
  }

  return targetPath;
}

async function updateProductSpecs(plan, completedPath, paths, state, options) {
  const targets = plan.specTargets.length > 0 ? plan.specTargets : ['docs/product-specs/CURRENT-STATE.md'];
  const dateStamp = todayIsoDate();
  const relativeCompleted = toPosix(path.relative(paths.rootDir, completedPath));

  for (const target of targets) {
    let targetPath;
    let targetRel;
    try {
      const resolved = resolveSafeRepoPath(paths.rootDir, target, `Spec target for plan '${plan.planId}'`);
      targetPath = resolved.abs;
      targetRel = resolved.rel;
    } catch (error) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target,
        reason: error instanceof Error ? error.message : String(error)
      }, options.dryRun);
      continue;
    }

    if (!(await exists(targetPath))) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target: targetRel,
        reason: 'Spec target does not exist'
      }, options.dryRun);
      continue;
    }

    let targetStats;
    try {
      targetStats = await fs.stat(targetPath);
    } catch (error) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target: targetRel,
        reason: error instanceof Error ? error.message : String(error)
      }, options.dryRun);
      continue;
    }

    if (!targetStats.isFile()) {
      await logEvent(paths, state, 'spec_update_skipped', {
        planId: plan.planId,
        target: targetRel,
        reason: 'Spec target is not a regular file'
      }, options.dryRun);
      continue;
    }

    if (options.dryRun) {
      continue;
    }

    let content = await fs.readFile(targetPath, 'utf8');
    const entry = `${dateStamp}: completed \`${plan.planId}\` via \`${relativeCompleted}\``;
    content = appendToDeliveryLog(content, entry);

    if (targetRel === 'docs/product-specs/CURRENT-STATE.md') {
      content = updateSimpleMetadataField(content, 'Last Updated', dateStamp);
      content = updateSimpleMetadataField(content, 'Current State Date', dateStamp);
    }

    await fs.writeFile(targetPath, content, 'utf8');
  }
}

async function writeHandoff(paths, state, plan, sessionNumber, reason, summary, options, sessionContext = {}) {
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const stageIndex = asInteger(sessionContext.stageIndex, 1);
  const stageTotal = asInteger(sessionContext.stageTotal, 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const markdownName = `${stamp}-session-${sessionNumber}.md`;
  const jsonName = `${stamp}-session-${sessionNumber}.json`;
  const targetPath = path.join(paths.handoffDir, plan.planId, markdownName);
  const jsonPath = path.join(paths.handoffDir, plan.planId, jsonName);
  const stateDelta = normalizeContinuityDelta(sessionContext.stateDelta);
  const quality = normalizeCheckpointQuality(sessionContext.quality);
  const handoffPacket = {
    schemaVersion: ROLLING_CONTEXT_SCHEMA_VERSION,
    planId: plan.planId,
    runId: state.runId,
    session: sessionNumber,
    role,
    stageIndex,
    stageTotal,
    mode: state.effectiveMode,
    createdAt: nowIso(),
    status: trimmedString(sessionContext.status, 'handoff_required'),
    reason: reason || 'unspecified',
    summary: summary || 'Executor requested rollover without additional summary.',
    currentSubtask: trimmedString(sessionContext.currentSubtask),
    nextAction: trimmedString(sessionContext.nextAction ?? stateDelta.reasoning.nextAction),
    contextRemaining:
      typeof sessionContext.contextRemaining === 'number' && Number.isFinite(sessionContext.contextRemaining)
        ? sessionContext.contextRemaining
        : null,
    contextWindow:
      typeof sessionContext.contextWindow === 'number' && Number.isFinite(sessionContext.contextWindow)
        ? sessionContext.contextWindow
        : null,
    contextUsedRatio:
      typeof sessionContext.contextUsedRatio === 'number' && Number.isFinite(sessionContext.contextUsedRatio)
        ? sessionContext.contextUsedRatio
        : null,
    contactPackFile: trimmedString(sessionContext.contactPackFile),
    contactPackManifestFile: trimmedString(sessionContext.contactPackManifestFile),
    sessionLogPath: trimmedString(sessionContext.sessionLogPath),
    stateDelta,
    quality
  };

  if (options.dryRun) {
    return { markdownPath: targetPath, jsonPath, packet: handoffPacket };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await writeJson(jsonPath, handoffPacket, false);

  const content = [
    `# Handoff ${plan.planId}`,
    '',
    '## Metadata',
    '',
    `- Plan-ID: ${plan.planId}`,
    `- Run-ID: ${state.runId}`,
    `- Session: ${sessionNumber}`,
    `- Role: ${role}`,
    `- Stage: ${stageIndex}/${stageTotal}`,
    `- Mode: ${state.effectiveMode}`,
    `- Created At: ${nowIso()}`,
    `- Reason: ${reason || 'unspecified'}`,
    `- Current Subtask: ${handoffPacket.currentSubtask || 'none'}`,
    `- Next Action: ${handoffPacket.nextAction || 'none'}`,
    `- Contact Pack: ${handoffPacket.contactPackFile || 'none'}`,
    `- Contact Pack Manifest: ${handoffPacket.contactPackManifestFile || 'none'}`,
    `- Session Log: ${handoffPacket.sessionLogPath || 'none'}`,
    '',
    '## Summary',
    '',
    summary || 'Executor requested rollover without additional summary.',
    '',
    '## Structured State',
    '',
    renderSummaryBullet('pending actions', stateDelta.pendingActions),
    renderSummaryBullet('open questions', stateDelta.openQuestions),
    renderSummaryBullet('risks', stateDelta.risks),
    renderSummaryBullet('artifacts', stringList([
      ...stateDelta.artifacts,
      ...stateDelta.evidence.artifactRefs,
      ...stateDelta.evidence.logRefs,
      ...stateDelta.evidence.validationRefs
    ], 8)),
    '',
    '## Next Session Checklist',
    '',
    '- Load latest handoff and active plan file.',
    '- Continue current role stage before advancing pipeline.',
    '- Continue remaining acceptance criteria steps.',
    '- Re-run required validations before completion.',
    ''
  ].join('\n');

  await fs.writeFile(targetPath, content, 'utf8');
  return { markdownPath: targetPath, jsonPath, packet: handoffPacket };
}

function buildSessionCheckpointRecord(plan, state, sessionNumber, sessionResult, sessionContext = {}, options = {}) {
  const role = normalizeRoleName(sessionContext.role, ROLE_WORKER);
  const stageIndex = asInteger(sessionContext.stageIndex, 1);
  const stageTotal = asInteger(sessionContext.stageTotal, 1);
  const synthesized = synthesizeContinuityDelta(
    plan,
    { role },
    sessionResult?.summary,
    sessionResult?.reason,
    sessionResult?.sessionLogPath,
    sessionResult?.contactPackFile,
    sessionResult?.touchSummary
  );
  const normalized = {
    currentSubtask: trimmedString(sessionResult?.currentSubtask ?? synthesized.currentSubtask),
    nextAction: trimmedString(sessionResult?.nextAction ?? synthesized.nextAction),
    stateDelta: normalizeContinuityDelta(sessionResult?.stateDelta ?? synthesized.stateDelta)
  };
  const quality = assessCheckpointQuality(
    {
      status: trimmedString(sessionResult?.status, 'completed'),
      currentSubtask: normalized.currentSubtask,
      nextAction: normalized.nextAction,
      stateDelta: normalized.stateDelta,
      reason: trimmedString(sessionResult?.reason)
    },
    asRatio(options.continuityMinCompletedScore, DEFAULT_CONTINUITY_MIN_COMPLETED_SCORE)
  );
  return {
    schemaVersion: ROLLING_CONTEXT_SCHEMA_VERSION,
    createdAt: nowIso(),
    planId: plan.planId,
    runId: state.runId,
    session: sessionNumber,
    role,
    stageIndex,
    stageTotal,
    status: trimmedString(sessionResult?.status, 'completed'),
    summary: trimmedString(sessionResult?.summary),
    reason: trimmedString(sessionResult?.reason),
    currentSubtask: normalized.currentSubtask,
    nextAction: normalized.nextAction,
    contextRemaining:
      typeof sessionResult?.contextRemaining === 'number' && Number.isFinite(sessionResult.contextRemaining)
        ? sessionResult.contextRemaining
        : null,
    contextWindow:
      typeof sessionResult?.contextWindow === 'number' && Number.isFinite(sessionResult.contextWindow)
        ? sessionResult.contextWindow
        : null,
    contextUsedRatio:
      typeof sessionResult?.contextUsedRatio === 'number' && Number.isFinite(sessionResult.contextUsedRatio)
        ? sessionResult.contextUsedRatio
        : null,
    contactPackFile: trimmedString(sessionResult?.contactPackFile),
    contactPackManifestFile: trimmedString(sessionResult?.contactPackManifestFile),
    contactPackThin: sessionResult?.contactPackThin === true,
    contactPackThinPackMissingCategories: stringList(sessionResult?.contactPackThinPackMissingCategories, 4),
    sessionLogPath: trimmedString(sessionResult?.sessionLogPath),
    touchSamples: meaningfulTouchSamples(sessionResult?.touchSummary),
    stateDelta: normalized.stateDelta,
    quality
  };
}

function normalizeContinuityAnalytics(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    schemaVersion: asInteger(source.schemaVersion, 1),
    updatedAt: trimmedString(source.updatedAt),
    items: source.items && typeof source.items === 'object' ? source.items : {}
  };
}

async function readContactPackManifest(paths, manifestRel) {
  const rel = trimmedString(manifestRel);
  if (!rel) {
    return null;
  }
  return readJsonIfExists(path.join(paths.rootDir, rel), null);
}

function selectedInputArtifactReused(selectedInput, checkpointRecord) {
  if (!selectedInput || selectedInput.category !== 'artifact') {
    return false;
  }
  const probe = trimmedString(selectedInput.value).toLowerCase();
  if (!probe) {
    return false;
  }
  const haystack = [
    ...checkpointRecord.stateDelta.artifacts,
    ...checkpointRecord.stateDelta.evidence.artifactRefs,
    ...checkpointRecord.stateDelta.evidence.logRefs,
    ...checkpointRecord.stateDelta.evidence.validationRefs,
    ...checkpointRecord.touchSamples
  ]
    .map((entry) => trimmedString(entry).toLowerCase())
    .filter(Boolean);
  return haystack.some((entry) => entry.includes(probe) || probe.includes(entry));
}

async function updateContinuityAnalytics(paths, checkpointRecord, sessionResult, options) {
  const manifest = await readContactPackManifest(paths, checkpointRecord.contactPackManifestFile);
  if (!manifest || !Array.isArray(manifest.selectedInputs) || options.dryRun) {
    return { helpfulSessions: 0, degradedSessions: 0, trackedItems: 0 };
  }

  const store = normalizeContinuityAnalytics(await readJsonIfExists(paths.continuityAnalyticsPath, null));
  const helpful = sessionResult?.continuityDerived !== true && checkpointRecord.quality.resumeSafe && sessionResult?.status !== 'failed';
  const degraded =
    sessionResult?.continuityDerived === true ||
    checkpointRecord.quality.resumeSafe !== true ||
    checkpointRecord.contactPackThin === true;

  for (const selectedInput of manifest.selectedInputs) {
    const itemId = trimmedString(selectedInput?.itemId);
    if (!itemId) {
      continue;
    }
    const current = store.items[itemId] && typeof store.items[itemId] === 'object' ? store.items[itemId] : {};
    const artifactReused = selectedInputArtifactReused(selectedInput, checkpointRecord);
    store.items[itemId] = {
      itemId,
      category: trimmedString(selectedInput.category),
      selectedCount: asInteger(current.selectedCount, 0) + 1,
      helpfulSessions: asInteger(current.helpfulSessions, 0) + (helpful ? 1 : 0),
      degradedSessions: asInteger(current.degradedSessions, 0) + (degraded ? 1 : 0),
      artifactReuseCount: asInteger(current.artifactReuseCount, 0) + (artifactReused ? 1 : 0),
      lastSeenAt: nowIso()
    };
  }
  store.updatedAt = nowIso();
  await writeJson(paths.continuityAnalyticsPath, store, false);
  return {
    helpfulSessions: helpful ? 1 : 0,
    degradedSessions: degraded ? 1 : 0,
    trackedItems: manifest.selectedInputs.length
  };
}

function continuityDegradationReasons(sessionResult, checkpointRecord) {
  const reasons = [];
  if (sessionResult?.continuityDerived === true) {
    reasons.push('continuity_derived');
  }
  if (checkpointRecord?.quality?.resumeSafe !== true) {
    reasons.push(...normalizeCheckpointQuality(checkpointRecord?.quality).degradedReasons);
  }
  if (checkpointRecord?.contactPackThin === true) {
    reasons.push(
      `thin_contact_pack:${stringList(checkpointRecord.contactPackThinPackMissingCategories, 4).join(',') || 'low_item_count'}`
    );
  }
  return stringList(reasons, 8);
}

async function writeContinuityIncidentBundle(paths, state, plan, sessionNumber, sessionResult, checkpointRecord, options) {
  if (!options.continuityIncidentBundlesEnabled || options.dryRun) {
    return null;
  }
  const degradationReasons = continuityDegradationReasons(sessionResult, checkpointRecord);
  const shouldEmitFailed = sessionResult?.status === 'failed' && options.continuityIncidentEmitOn.includes('failed');
  const shouldEmitDegraded = degradationReasons.length > 0 && options.continuityIncidentEmitOn.includes('degraded');
  if (!shouldEmitFailed && !shouldEmitDegraded) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(paths.incidentBundleDir, state.runId, plan.planId, `${stamp}-session-${sessionNumber}.json`);
  const manifest = await readContactPackManifest(paths, checkpointRecord.contactPackManifestFile);
  const bundle = {
    schemaVersion: ROLLING_CONTEXT_SCHEMA_VERSION,
    runId: state.runId,
    planId: plan.planId,
    session: sessionNumber,
    role: checkpointRecord.role,
    stageIndex: checkpointRecord.stageIndex,
    stageTotal: checkpointRecord.stageTotal,
    status: checkpointRecord.status,
    summary: checkpointRecord.summary,
    reason: checkpointRecord.reason,
    classification: shouldEmitFailed ? 'failed' : 'degraded',
    degradationReasons,
    continuityDerived: sessionResult?.continuityDerived === true,
    quality: checkpointRecord.quality,
    latestStateRef: continuityStateArtifactRel(plan.planId),
    checkpointsRef: continuityCheckpointArtifactRel(plan.planId),
    contactPackFile: checkpointRecord.contactPackFile,
    contactPackManifestFile: checkpointRecord.contactPackManifestFile,
    sessionLogPath: checkpointRecord.sessionLogPath,
    selectedInputs: Array.isArray(manifest?.selectedInputs) ? manifest.selectedInputs : [],
    stateDelta: checkpointRecord.stateDelta
  };
  await fs.mkdir(path.dirname(bundlePath), { recursive: true });
  await writeJson(bundlePath, bundle, false);
  return toPosix(path.relative(paths.rootDir, bundlePath));
}

async function announceStageReuse(paths, state, plan, roleState, options) {
  if (!Array.isArray(roleState?.reusedPrefixStages) || roleState.reusedPrefixStages.length === 0) {
    return;
  }
  if (roleState.reuseAnnouncedAtRunId === state.runId) {
    return;
  }
  roleState.reuseAnnouncedAtRunId = state.runId;
  state.roleState[plan.planId] = roleState;
  await logEvent(paths, state, 'role_stage_reused', {
    planId: plan.planId,
    reusedStages: roleState.reusedPrefixStages,
    nextRole: roleState.stages[Math.min(roleState.currentIndex, roleState.stages.length - 1)] ?? ROLE_WORKER
  }, options.dryRun);
  progressLog(options, `role stage reuse ${plan.planId}: skipped ${roleState.reusedPrefixStages.join(' -> ')}`);
}

async function processPlan(plan, paths, state, options, config) {
  let lastAssessment = computeRiskAssessment(plan, state, config);
  const gate = evaluatePolicyGate(
    {
      ...plan,
      riskTier: lastAssessment.effectiveRiskTier
    },
    state.effectiveMode
  );
  if (!gate.allowed) {
    await setPlanStatus(plan.filePath, 'blocked', options.dryRun);

    return {
      outcome: 'blocked',
      reason: gate.reason
    };
  }

  const executionEligibility = evaluateExecutionEligibility(plan);
  if (!executionEligibility.allowed) {
    await setPlanStatus(plan.filePath, isProgramPlan(plan) ? 'in-progress' : 'blocked', options.dryRun);
    return {
      outcome: isProgramPlan(plan) ? 'pending' : 'blocked',
      reason: executionEligibility.reason
    };
  }

  const initialCompletionGate = await evaluateCompletionGate(plan, paths.rootDir, state, {
    implementationEvidencePaths
  });
  if (!initialCompletionGate.ready) {
    await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);
  }

  const maxRollovers = asInteger(options.maxRollovers, DEFAULT_MAX_ROLLOVERS);
  const maxSessionsPerPlan = asInteger(options.maxSessionsPerPlan, DEFAULT_MAX_SESSIONS_PER_PLAN);
  const roleConfig = resolveRoleOrchestration(config);
  const planStartedAt = nowIso();
  const planStartedAtMs = Date.now();
  const continuationState = ensurePlanContinuationState(state, plan.planId);
  let firstWorkerEditSeconds = null;
  let rollovers = Math.max(0, asInteger(continuationState.rollovers, 0));
  let lastPendingSignal = trimmedString(continuationState.lastPendingSignal, null);
  let workerNoTouchRetryCount = Math.max(0, asInteger(continuationState.workerNoTouchRetryCount, 0));
  let workerPendingStreak = Math.max(0, asInteger(continuationState.workerPendingStreak, 0));
  let readOnlyPendingStreak = Math.max(0, asInteger(continuationState.readOnlyPendingStreak, 0));
  const storeContinuationState = () => {
    state.continuationState[plan.planId] = {
      ...continuationState,
      rollovers,
      workerNoTouchRetryCount,
      workerPendingStreak,
      readOnlyPendingStreak,
      lastPendingSignal,
      updatedAt: nowIso()
    };
  };
  let roleState = ensureRoleState(state, plan, lastAssessment, resolvePipelineStages(lastAssessment, config), config);
  await announceStageReuse(paths, state, plan, roleState, options);

  for (let sessionAttempt = 1; sessionAttempt <= maxSessionsPerPlan; sessionAttempt += 1) {
    lastAssessment = computeRiskAssessment(plan, state, config);
    const dynamicGate = evaluatePolicyGate(
      {
        ...plan,
        riskTier: lastAssessment.effectiveRiskTier
      },
      state.effectiveMode
    );
    if (!dynamicGate.allowed) {
      await setPlanStatus(plan.filePath, 'blocked', options.dryRun);
      return {
        outcome: 'blocked',
        reason: dynamicGate.reason,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }
    roleState = ensureRoleState(state, plan, lastAssessment, resolvePipelineStages(lastAssessment, config), config);
    await announceStageReuse(paths, state, plan, roleState, options);
    const stageTotal = roleState.stages.length;
    const roleIndex = Math.min(roleState.currentIndex, Math.max(0, stageTotal - 1));
    const stageIndex = roleIndex + 1;
    const currentRole = normalizeRoleName(roleState.stages[roleIndex], ROLE_WORKER);
    const currentRoleProfile = resolveRoleExecutionProfile(config, currentRole, lastAssessment.effectiveRiskTier);
    const completionGateBeforeSession = await evaluateCompletionGate(plan, paths.rootDir, state, {
      implementationEvidencePaths
    });
    if (completionGateBeforeSession.ready) {
      progressLog(
        options,
        `validation fast-path ${plan.planId}: status gate already open, skipping role=${currentRole}`
      );
      return validationCompletionOps.runValidationAndFinalize(plan, paths, state, options, config, lastAssessment, roleState, {
        session: Math.max(0, asInteger(ensurePlanSessionState(state, plan.planId).nextSessionOrdinal, 0)),
        sessionsExecuted: Math.max(0, sessionAttempt - 1),
        planStartedAt,
        rollovers
      });
    }

    const session = nextPlanSessionOrdinal(state, plan.planId);

    state.inProgress = {
      planId: plan.planId,
      session,
      planFile: plan.rel,
      role: currentRole,
      stageIndex,
      stageTotal,
      declaredRiskTier: lastAssessment.declaredRiskTier,
      computedRiskTier: lastAssessment.computedRiskTier,
      effectiveRiskTier: lastAssessment.effectiveRiskTier,
      startedAt: nowIso()
    };

    await saveState(paths, state, options.dryRun);
    progressLog(
      options,
      `session ${session} start ${plan.planId} role=${currentRole} stage=${stageIndex}/${stageTotal} provider=${currentRoleProfile.provider} model=${currentRoleProfile.model || 'n/a'} risk=${lastAssessment.effectiveRiskTier}`
    );

    const sessionResult = await executePlanSession(plan, paths, state, options, config, session, {
      role: currentRole,
      effectiveRiskTier: lastAssessment.effectiveRiskTier,
      declaredRiskTier: lastAssessment.declaredRiskTier,
      stageIndex,
      stageTotal,
      workerNoTouchRetryCount: currentRole === ROLE_WORKER ? workerNoTouchRetryCount : 0,
      workerNoTouchRetryLimit: asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)
    });
    const checkpointRecord = buildSessionCheckpointRecord(
      plan,
      state,
      session,
      sessionResult,
      { role: currentRole, stageIndex, stageTotal },
      options
    );
    const sessionContinuityMetrics = continuityMetrics(checkpointRecord.stateDelta);
    const continuityDegraded = continuityDegradationReasons(sessionResult, checkpointRecord).length > 0;
    await logEvent(paths, state, 'session_finished', {
      planId: plan.planId,
      session,
      role: currentRole,
      stageIndex,
      stageTotal,
      declaredRiskTier: lastAssessment.declaredRiskTier,
      computedRiskTier: lastAssessment.computedRiskTier,
      effectiveRiskTier: lastAssessment.effectiveRiskTier,
      riskScore: lastAssessment.score,
      status: sessionResult.status,
      reason: sessionResult.reason ?? null,
      summary: sessionResult.summary ?? null,
      currentSubtask: checkpointRecord.currentSubtask,
      nextAction: checkpointRecord.nextAction,
      provider: sessionResult.provider ?? currentRoleProfile.provider,
      model: sessionResult.model ?? currentRoleProfile.model ?? null,
      commandLogPath: sessionResult.sessionLogPath ?? null,
      contactPackFile: sessionResult.contactPackFile ?? null,
      contactPackManifestFile: sessionResult.contactPackManifestFile ?? null,
      contactPackGenerated: sessionResult.contactPackGenerated ?? false,
      contactPackPolicyRuleCount: sessionResult.contactPackPolicyRuleCount ?? 0,
      contactPackEvidenceCount: sessionResult.contactPackEvidenceCount ?? 0,
      contactPackCheckpointCount: sessionResult.contactPackCheckpointCount ?? 0,
      contactPackSelectedInputCount: sessionResult.contactPackSelectedInputCount ?? 0,
      contactPackThin: sessionResult.contactPackThin ?? false,
      continuityDerived: sessionResult.continuityDerived ?? false,
      continuityDegraded,
      checkpointQualityScore: checkpointRecord.quality.score,
      checkpointResumeSafe: checkpointRecord.quality.resumeSafe,
      checkpointMissingFieldCount: checkpointRecord.quality.missingFields.length,
      continuityPendingActionCount: sessionContinuityMetrics.pendingActionCount,
      continuityCompletedWorkCount: sessionContinuityMetrics.completedWorkCount,
      continuityDecisionCount: sessionContinuityMetrics.decisionCount,
      continuityOpenQuestionCount: sessionContinuityMetrics.openQuestionCount,
      continuityArtifactCount: sessionContinuityMetrics.artifactCount,
      continuityBlockerCount: sessionContinuityMetrics.blockerCount,
      durationSeconds:
        typeof sessionResult.durationSeconds === 'number' && Number.isFinite(sessionResult.durationSeconds)
          ? Math.round(sessionResult.durationSeconds * 100) / 100
          : null,
      touchCount: sessionResult.touchSummary?.count ?? 0,
      touchCategories: sessionResult.touchSummary?.categories ?? [],
      touchSamples: sessionResult.touchSummary?.samples ?? [],
      touchScanMode: sessionResult.touchMonitor?.mode ?? null,
      touchScansExecuted: sessionResult.touchMonitor?.scansExecuted ?? 0,
      touchScansSkipped: sessionResult.touchMonitor?.scansSkipped ?? 0,
      liveActivity: sessionResult.liveActivity?.message ?? null,
      liveActivityUpdatedAt: sessionResult.liveActivity?.updatedAt ?? null,
      liveActivityUpdates: sessionResult.liveActivityUpdates ?? 0
    }, options.dryRun);
    if (options.liveActivityEmitEventLines && sessionResult.liveActivity?.message) {
      await logEvent(paths, state, 'provider_activity', {
        planId: plan.planId,
        session,
        role: currentRole,
        provider: sessionResult.provider ?? currentRoleProfile.provider,
        model: sessionResult.model ?? currentRoleProfile.model ?? null,
        message: sessionResult.liveActivity.message,
        updatedAt: sessionResult.liveActivity.updatedAt ?? null
      }, options.dryRun);
    }
    const workerTouchCount =
      typeof sessionResult.touchSummary?.count === 'number' && Number.isFinite(sessionResult.touchSummary.count)
        ? sessionResult.touchSummary.count
        : 0;
    if (currentRole === ROLE_WORKER && workerTouchCount > 0 && firstWorkerEditSeconds == null) {
      firstWorkerEditSeconds = Math.max(0, (Date.now() - planStartedAtMs) / 1000);
      await logEvent(paths, state, 'worker_first_edit', {
        planId: plan.planId,
        session,
        role: currentRole,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        secondsFromPlanStart: Math.round(firstWorkerEditSeconds * 100) / 100,
        touchCount: workerTouchCount
      }, options.dryRun);
    }
    const contextSuffix =
      typeof sessionResult.contextRemaining === 'number' && Number.isFinite(sessionResult.contextRemaining)
        ? ` contextRemaining=${sessionResult.contextRemaining}`
        : '';
    progressLog(
      options,
      `session ${session} end ${plan.planId} role=${currentRole} status=${sessionResult.status}${contextSuffix}`
    );
    if (sessionResult.sessionLogPath && (sessionResult.status === 'failed' || sessionResult.status === 'handoff_required')) {
      progressLog(options, `session log: ${sessionResult.sessionLogPath}`);
    }
    if (sessionResult.failureTail && !isTickerOutput(options)) {
      progressLog(options, `session failure tail:\n${sessionResult.failureTail}`);
    }
    const evidenceMaintenance = evaluateSessionEvidenceMaintenance(plan, paths, sessionResult, options);
    if (evidenceMaintenance.shouldRefreshIndex) {
      await refreshEvidenceIndex(plan, paths, state, options, config);
    }
    if (evidenceMaintenance.shouldCurate) {
      const sessionCuration = await curateEvidenceForPlan(plan, paths, options, config);
      if (sessionCuration.filesPruned > 0 || sessionCuration.filesUpdated > 0) {
        await logEvent(paths, state, 'evidence_curated', {
          planId: plan.planId,
          stage: 'session',
          session,
          directoriesVisited: sessionCuration.directoriesVisited,
          filesPruned: sessionCuration.filesPruned,
          filesKept: sessionCuration.filesKept,
          filesUpdated: sessionCuration.filesUpdated,
          replacementsApplied: sessionCuration.replacementsApplied,
          changedDetectedVia: evidenceMaintenance.detectedVia
        }, options.dryRun);
        if (evidenceMaintenance.shouldRefreshIndex) {
          await refreshEvidenceIndex(plan, paths, state, options, config);
        }
      }
    }
    await persistContinuityCheckpoint(paths, plan, checkpointRecord, options);
    const analyticsUpdate = await updateContinuityAnalytics(paths, checkpointRecord, sessionResult, options);
    if (analyticsUpdate.trackedItems > 0) {
      await logEvent(paths, state, 'continuity_analytics_updated', {
        planId: plan.planId,
        session,
        trackedItems: analyticsUpdate.trackedItems,
        helpfulSessions: analyticsUpdate.helpfulSessions,
        degradedSessions: analyticsUpdate.degradedSessions
      }, options.dryRun);
    }
    const incidentBundleFile = await writeContinuityIncidentBundle(
      paths,
      state,
      plan,
      session,
      sessionResult,
      checkpointRecord,
      options
    );
    if (incidentBundleFile) {
      await logEvent(paths, state, 'continuity_incident_bundle_created', {
        planId: plan.planId,
        session,
        role: currentRole,
        incidentBundleFile,
        status: sessionResult.status
      }, options.dryRun);
    }

    if (currentRole === ROLE_WORKER && sessionResult.status !== 'failed' && sessionResult.status !== 'blocked') {
      const implementationEvidenceUpdate = recordImplementationEvidence(
        state,
        ensurePlanImplementationState,
        paths.rootDir,
        plan,
        sessionResult.touchSummary?.touched ?? [],
        {
          runId: state.runId,
          session,
          role: currentRole,
          baselineFingerprints: sessionResult.implementationBaseline ?? {}
        }
      );
      if (implementationEvidenceUpdate.recorded) {
        await logEvent(paths, state, 'implementation_evidence_recorded', {
          planId: plan.planId,
          session,
          role: currentRole,
          matchedPaths: implementationEvidenceUpdate.matchedPaths.slice(0, 20),
          matchedCount: implementationEvidenceUpdate.matchedPaths.length
        }, options.dryRun);
        await saveState(paths, state, options.dryRun);
      }
    }

    if (sessionResult.status === 'handoff_required') {
      const handoffPaths = await writeHandoff(
        paths,
        state,
        plan,
        session,
        sessionResult.reason,
        sessionResult.summary,
        options,
        {
          role: currentRole,
          stageIndex,
          stageTotal,
          status: sessionResult.status,
          currentSubtask: checkpointRecord.currentSubtask,
          nextAction: checkpointRecord.nextAction,
          stateDelta: checkpointRecord.stateDelta,
          quality: checkpointRecord.quality,
          sessionLogPath: sessionResult.sessionLogPath,
          contactPackFile: sessionResult.contactPackFile,
          contactPackManifestFile: sessionResult.contactPackManifestFile,
          contextRemaining: sessionResult.contextRemaining,
          contextWindow: sessionResult.contextWindow,
          contextUsedRatio: sessionResult.contextUsedRatio
        }
      );
      state.stats.handoffs += 1;
      await logEvent(paths, state, 'handoff_created', {
        planId: plan.planId,
        session,
        role: currentRole,
        stageIndex,
        stageTotal,
        handoffPath: toPosix(path.relative(paths.rootDir, handoffPaths.markdownPath)),
        handoffJsonPath: toPosix(path.relative(paths.rootDir, handoffPaths.jsonPath)),
        reason: sessionResult.reason ?? 'executor-requested'
      }, options.dryRun);
      progressLog(
        options,
        `handoff created for ${plan.planId}: ${toPosix(path.relative(paths.rootDir, handoffPaths.markdownPath))}`
      );

      rollovers += 1;
      storeContinuationState();
      await saveState(paths, state, options.dryRun);
      if (rollovers > maxRollovers) {
        await setPlanStatus(plan.filePath, 'failed', options.dryRun);
        clearPlanContinuationState(state, plan.planId);
        return {
          outcome: 'failed',
          reason: `Maximum rollovers exceeded (${maxRollovers})`
        };
      }

      continue;
    }

    if (sessionResult.status === 'blocked') {
      await setPlanStatus(plan.filePath, 'blocked', options.dryRun);
      clearPlanContinuationState(state, plan.planId);
      await logEvent(paths, state, 'session_blocked', {
        planId: plan.planId,
        session,
        role: currentRole,
        stageIndex,
        stageTotal,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        reason: sessionResult.reason ?? 'executor blocked'
      }, options.dryRun);
      progressLog(options, `session blocked for ${plan.planId}: ${sessionResult.reason ?? 'executor blocked'}`);
      return {
        outcome: 'blocked',
        reason: sessionResult.reason ?? 'executor blocked',
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (sessionResult.status === 'failed') {
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      clearPlanContinuationState(state, plan.planId);
      progressLog(options, `session failed for ${plan.planId}: ${sessionResult.reason ?? 'executor failed'}`);
      return {
        outcome: 'failed',
        reason: sessionResult.reason ?? 'executor failed',
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (!(await exists(plan.filePath))) {
      const relocatedPlan = await findPlanRecordById(paths, plan.planId);
      if (relocatedPlan?.phase === 'completed') {
        const completionGateForRelocatedPlan = await evaluateCompletionGate(relocatedPlan, paths.rootDir, state, {
          implementationEvidencePaths
        });
        if (!completionGateForRelocatedPlan.ready) {
          return {
            outcome: 'failed',
            reason: `Plan was moved to completed without completion status. ${completionGateForRelocatedPlan.reason}`
          };
        }

        await canonicalizeCompletedPlanEvidence(relocatedPlan, paths, options, config);
        await updateProductSpecs(plan, relocatedPlan.filePath, paths, state, options);

        let commitResult = { ok: true, committed: false, commitHash: null };
        if (asBoolean(options.commit, config.git.atomicCommits !== false)) {
          commitResult = createAtomicCommit(
            paths.rootDir,
            plan.planId,
            options.dryRun,
            options.allowDirty,
            {
              enforceRoots: asBoolean(config.git?.atomicCommitRoots?.enforce, true),
              allowedRoots: resolveAtomicCommitRoots(plan, config, paths, { completedRel: relocatedPlan.rel })
            }
          );
          if (!commitResult.ok) {
            return {
              outcome: 'failed',
              reason: commitResult.reason ?? 'atomic commit failed'
            };
          }
          if (commitResult.committed) {
            state.stats.commits += 1;
          }
        }

        clearPlanContinuationState(state, plan.planId);
        return {
          outcome: 'completed',
          reason: 'completed',
          completedPath: relocatedPlan.rel,
          commitHash: commitResult.commitHash,
          validationEvidence: [],
          riskTier: lastAssessment.effectiveRiskTier
        };
      }

      if (relocatedPlan) {
        syncPlanRecord(plan, relocatedPlan);
      }
    }

    if (!(await exists(plan.filePath))) {
      return {
        outcome: 'failed',
        reason: `Plan file is missing after executor session: ${plan.rel}`,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    const refreshedPlan = await readPlanRecord(paths.rootDir, plan.filePath, 'active');
    syncPlanRecord(plan, refreshedPlan);
    const workerTouchPolicy = buildWorkerTouchPolicy(plan);
    const disallowedWrites = disallowedTouchedPathsForRole(currentRole, plan, sessionResult.touchSummary?.touched ?? []);
    if (disallowedWrites.length > 0) {
      const violationSample = disallowedWrites.slice(0, 3).join(', ');
      const violationReason =
        currentRole === ROLE_WORKER
          ? `Role '${currentRole}' touched files outside declared Implementation-Targets. ` +
            `Update the plan roots before widening scope or revert the out-of-scope edits. Sample: ${violationSample}`
          : `Role '${currentRole}' touched files outside docs/exec-plans. ` +
            `Allowed scope is execution plan/evidence docs only. Sample: ${violationSample}`;
      await logEvent(paths, state, 'session_policy_violation', {
        planId: plan.planId,
        session,
        role: currentRole,
        stageIndex,
        stageTotal,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        disallowedTouchedCount: disallowedWrites.length,
        disallowedTouchedSample: disallowedWrites.slice(0, 10),
        reason: violationReason
      }, options.dryRun);
      await setPlanStatus(plan.filePath, 'failed', options.dryRun);
      progressLog(options, `session policy violation ${plan.planId}: ${violationReason}`);
      return {
        outcome: 'failed',
        reason: violationReason,
        riskTier: lastAssessment.effectiveRiskTier
      };
    }

    if (sessionResult.status === 'pending') {
      const pendingReason = sessionResult.reason ?? 'Executor reported pending implementation work.';
      const nextRole = resolvePendingNextRole(currentRole, roleState, roleIndex, pendingReason);
      const pendingTouchCount =
        typeof sessionResult.touchSummary?.count === 'number' && Number.isFinite(sessionResult.touchSummary.count)
          ? sessionResult.touchSummary.count
          : 0;
      const pendingTouchCategories = Array.isArray(sessionResult.touchSummary?.categories)
        ? sessionResult.touchSummary.categories
        : [];
      const workerHasMeaningfulTouch = hasMeaningfulWorkerTouchSummary(
        {
          touched: sessionResult.touchSummary?.touched ?? [],
          categories: pendingTouchCategories
        },
        workerTouchPolicy
      );
      const workerNeedsMeaningfulTouch =
        currentRole === ROLE_WORKER && nextRole === currentRole && !workerHasMeaningfulTouch;
      const stageBudgetSeconds = Math.max(
        0,
        asInteger(roleConfig.stageBudgetsSeconds?.[currentRole], 0)
      );
      const sessionDurationSeconds =
        typeof sessionResult.durationSeconds === 'number' && Number.isFinite(sessionResult.durationSeconds)
          ? sessionResult.durationSeconds
          : 0;
      if (
        currentRole !== ROLE_WORKER &&
        nextRole === currentRole &&
        stageBudgetSeconds > 0 &&
        sessionDurationSeconds > stageBudgetSeconds
      ) {
        const progressSummary =
          pendingTouchCount > 0
            ? `Touched ${pendingTouchCount} plan/evidence file(s) but did not finish the ${currentRole} stage.`
            : 'Returned pending without touching plan/evidence files.';
        const budgetReason =
          `Role '${currentRole}' exceeded stage budget (${Math.round(sessionDurationSeconds)}s > ${stageBudgetSeconds}s) ` +
          `without resolving the role-scoped objective. ${progressSummary} ${pendingReason}`;
        await logEvent(paths, state, 'session_stage_budget_exceeded', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          durationSeconds: Math.round(sessionDurationSeconds * 100) / 100,
          stageBudgetSeconds,
          touchCount: pendingTouchCount,
          reason: budgetReason
        }, options.dryRun);
        progressLog(options, `session stage-budget fail-fast ${plan.planId}: ${budgetReason}`);
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: budgetReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      const workerNoTouchRetryLimit = Math.max(
        0,
        asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)
      );
      const workerPendingStreakLimit = Math.max(
        0,
        asInteger(options.workerPendingStreakLimit, DEFAULT_WORKER_PENDING_STREAK_LIMIT)
      );
      if (
        workerNeedsMeaningfulTouch &&
        workerNoTouchRetryCount < workerNoTouchRetryLimit &&
        sessionAttempt < maxSessionsPerPlan
      ) {
        workerNoTouchRetryCount += 1;
        const retryReason =
          `Worker returned pending without ${workerTouchPolicy.progressLabel}; retrying worker with edit-first directive ` +
          `(${workerNoTouchRetryCount}/${workerNoTouchRetryLimit}). ${pendingReason}`;
        await logEvent(paths, state, 'session_pending_no_touch_retry', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          touchCount: pendingTouchCount,
          retryAttempt: workerNoTouchRetryCount,
          retryLimit: workerNoTouchRetryLimit,
          reason: retryReason
        }, options.dryRun);
        progressLog(options, `session retry ${plan.planId}: ${retryReason}`);
        lastPendingSignal = null;
        workerPendingStreak = 0;
        readOnlyPendingStreak = 0;
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        continue;
      }
      if (workerNeedsMeaningfulTouch) {
        const retrySummary =
          workerNoTouchRetryLimit > 0
            ? `after ${workerNoTouchRetryCount}/${workerNoTouchRetryLimit} no-touch retries`
            : 'with no-touch retries disabled';
        const requiredEditGuidance =
          workerTouchPolicy.allowPlanDocsOnlyTouches
            ? 'Apply at least one concrete repository edit in the plan\'s scoped docs/evidence targets before returning pending; plan/evidence-only updates outside the declared plan scope are still insufficient.'
            : 'Apply at least one concrete repository edit outside the active plan/evidence docs before returning pending; plan/evidence-only updates are insufficient for worker pending.';
        const failFastReason =
          `Worker returned pending without ${workerTouchPolicy.progressLabel} ${retrySummary}. ${pendingReason} ` +
          requiredEditGuidance;
        await logEvent(paths, state, 'session_pending_fail_fast', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          touchCount: pendingTouchCount,
          reason: failFastReason
        }, options.dryRun);
        progressLog(options, `session fail-fast ${plan.planId}: ${failFastReason}`);
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: failFastReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      if (currentRole === ROLE_WORKER && workerHasMeaningfulTouch) {
        workerNoTouchRetryCount = 0;
      } else if (currentRole !== ROLE_WORKER) {
        workerNoTouchRetryCount = 0;
      }
      if (currentRole === ROLE_WORKER && nextRole === currentRole) {
        workerPendingStreak += 1;
      } else {
        workerPendingStreak = 0;
      }
      if (currentRole !== ROLE_WORKER && nextRole === currentRole) {
        readOnlyPendingStreak += 1;
      } else {
        readOnlyPendingStreak = 0;
      }
      if (
        currentRole === ROLE_WORKER &&
        nextRole === currentRole &&
        workerPendingStreakLimit > 0 &&
        workerPendingStreak > workerPendingStreakLimit
      ) {
        const failFastReason =
          `Worker pending streak exceeded (${workerPendingStreak}/${workerPendingStreakLimit}) ` +
          `without leaving implementation stage. ${pendingReason} Narrow to one implementation slice and resume.`;
        await logEvent(paths, state, 'session_pending_streak_fail_fast', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          pendingStreak: workerPendingStreak,
          pendingStreakLimit: workerPendingStreakLimit,
          reason: failFastReason
        }, options.dryRun);
        progressLog(options, `session fail-fast ${plan.planId}: ${failFastReason}`);
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: failFastReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      if (
        currentRole !== ROLE_WORKER &&
        nextRole === currentRole &&
        readOnlyPendingStreak > DEFAULT_READ_ONLY_PENDING_STREAK_LIMIT
      ) {
        const failFastReason =
          `Read-only role '${currentRole}' returned same-role pending too many times ` +
          `(${readOnlyPendingStreak}/${DEFAULT_READ_ONLY_PENDING_STREAK_LIMIT}) without handing off or completing. ` +
          `${pendingReason} Mark the role stage completed, switch to implementation, or narrow the role scope before resuming.`;
        await logEvent(paths, state, 'session_pending_fail_fast', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          pendingStreak: readOnlyPendingStreak,
          pendingStreakLimit: DEFAULT_READ_ONLY_PENDING_STREAK_LIMIT,
          reason: failFastReason
        }, options.dryRun);
        progressLog(options, `session fail-fast ${plan.planId}: ${failFastReason}`);
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: failFastReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      const signal = pendingSignalSignature(currentRole, nextRole, pendingReason);
      if (nextRole === currentRole && signal === lastPendingSignal) {
        const failFastReason = `Repeated pending signal without progress for role '${currentRole}'. ${pendingReason}`;
        await logEvent(paths, state, 'session_pending_fail_fast', {
          planId: plan.planId,
          session,
          role: currentRole,
          nextRole,
          effectiveRiskTier: lastAssessment.effectiveRiskTier,
          reason: failFastReason
        }, options.dryRun);
        progressLog(options, `session fail-fast ${plan.planId}: ${failFastReason}`);
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: failFastReason,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      lastPendingSignal = nextRole === currentRole ? signal : null;
      setRoleStateToRole(roleState, nextRole);
      state.roleState[plan.planId] = roleState;
      storeContinuationState();
      await saveState(paths, state, options.dryRun);
      if (sessionAttempt >= maxSessionsPerPlan) {
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}). ${pendingReason}`,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }
      await logEvent(paths, state, 'session_continued', {
        planId: plan.planId,
        session,
        role: currentRole,
        nextRole,
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        nextSession: session + 1,
        reason: pendingReason
      }, options.dryRun);
      progressLog(
        options,
        `session pending ${plan.planId}: nextRole=${nextRole} reason=${pendingReason}`
      );
      continue;
    }

    lastPendingSignal = null;
    workerNoTouchRetryCount = 0;
    workerPendingStreak = 0;
    readOnlyPendingStreak = 0;
    storeContinuationState();

    advanceRoleState(roleState, currentRole);
    state.roleState[plan.planId] = roleState;
    await saveState(paths, state, options.dryRun);

    if (roleIndex < roleState.stages.length - 1) {
      const nextRole = roleState.stages[Math.min(roleIndex + 1, roleState.stages.length - 1)];
      await logEvent(paths, state, 'role_stage_advanced', {
        planId: plan.planId,
        session,
        completedRole: currentRole,
        nextRole,
        stageIndexCompleted: stageIndex,
        stageTotal,
        effectiveRiskTier: lastAssessment.effectiveRiskTier
      }, options.dryRun);
      progressLog(options, `role transition ${plan.planId}: ${currentRole} -> ${nextRole}`);
      continue;
    }

    let completionGate = await evaluateCompletionGate(plan, paths.rootDir, state, {
      implementationEvidencePaths
    });
    if (!completionGate.ready) {
      const autoPromotedGate = await maybeAutoPromoteCompletionGate(
        plan.filePath,
        currentRole,
        sessionResult,
        options
      );
      if (autoPromotedGate.promoted) {
        const refreshedPlan = await findPlanRecordById(paths, plan.planId);
        syncPlanRecord(plan, refreshedPlan);
        completionGate = await evaluateCompletionGate(plan, paths.rootDir, state, {
          implementationEvidencePaths
        });
        await logEvent(paths, state, 'completion_gate_auto_promoted_validation', {
          planId: plan.planId,
          session,
          role: currentRole,
          reason: autoPromotedGate.reason
        }, options.dryRun);
        progressLog(
          options,
          `completion gate auto-promoted ${plan.planId}: status=validation reason=${autoPromotedGate.reason}`
        );
      }
    }
    if (!completionGate.ready) {
      await setPlanStatus(plan.filePath, 'in-progress', options.dryRun);
      updatePlanValidationState(state, plan.planId, {
        always: 'pending',
        host: 'pending',
        provider: null,
        reason: completionGate.reason
      });

      if (sessionResult.resultPayloadFound === false) {
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: 'Executor produced no structured result payload. Deferring to next run to prevent repeated no-signal loops.',
          riskTier: lastAssessment.effectiveRiskTier
        };
      }

      if (session >= maxSessionsPerPlan) {
        storeContinuationState();
        await saveState(paths, state, options.dryRun);
        return {
          outcome: 'pending',
          reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}). ${completionGate.reason}`,
          riskTier: lastAssessment.effectiveRiskTier
        };
      }

      resetRoleStateToImplementation(roleState);
      state.roleState[plan.planId] = roleState;
      storeContinuationState();
      await saveState(paths, state, options.dryRun);

      await logEvent(paths, state, 'session_continued', {
        planId: plan.planId,
        session,
        role: currentRole,
        nextRole: roleState.stages[roleState.currentIndex],
        effectiveRiskTier: lastAssessment.effectiveRiskTier,
        nextSession: session + 1,
        reason: completionGate.reason
      }, options.dryRun);
      progressLog(
        options,
        `session continuation ${plan.planId}: nextRole=${roleState.stages[roleState.currentIndex]} reason=${completionGate.reason}`
      );

      continue;
    }

    return validationCompletionOps.runValidationAndFinalize(plan, paths, state, options, config, lastAssessment, roleState, {
      session,
      sessionsExecuted: sessionAttempt,
      planStartedAt,
      rollovers
    });
  }

  storeContinuationState();
  await saveState(paths, state, options.dryRun);
  return {
    outcome: 'pending',
    reason: `Maximum sessions reached without completion (${maxSessionsPerPlan}).`,
    riskTier: lastAssessment.effectiveRiskTier
  };
}

async function collectPlanCatalog(paths) {
  const [future, active, completed] = await Promise.all([
    loadPlanRecords(paths.rootDir, paths.futureDir, 'future'),
    loadPlanRecords(paths.rootDir, paths.activeDir, 'active'),
    loadPlanRecords(paths.rootDir, paths.completedDir, 'completed')
  ]);

  return {
    future,
    active,
    completed,
    byId: uniqueByPlanId([...future, ...active, ...completed])
  };
}

function reconcileOutcomeTracking(state, catalog) {
  const completedIds = new Set([
    ...state.completedPlanIds,
    ...catalog.completed.map((plan) => plan.planId)
  ]);
  const blockedIds = new Set(
    catalog.active.filter((plan) => plan.status === 'blocked').map((plan) => plan.planId)
  );
  const failedIds = new Set(
    catalog.active.filter((plan) => plan.status === 'failed').map((plan) => plan.planId)
  );

  state.completedPlanIds = [...completedIds];
  state.blockedPlanIds = [...blockedIds].filter((planId) => !completedIds.has(planId));
  state.failedPlanIds = [...failedIds].filter((planId) => !completedIds.has(planId));
}

async function runLoop(paths, state, options, config, runMode) {
  let processed = 0;
  const maxPlans = asInteger(options.maxPlans, Number.MAX_SAFE_INTEGER);
  const deferredPlanIds = new Set();
  const dependencyWaitCache = new Map();
  const recoveryAnnounced = new Set();

  while (processed < maxPlans) {
    const catalog = await collectPlanCatalog(paths);
    reconcileOutcomeTracking(state, catalog);
    const completedIds = new Set(state.completedPlanIds);
    const recoverable = classifyRecoverablePlans(catalog.active, completedIds, state, options, config);
    const recoverablePlanIds = new Set([
      ...recoverable.retryableFailed.keys(),
      ...recoverable.unblockable.keys()
    ]);

    for (const [planId, details] of recoverable.retryableFailed.entries()) {
      if (recoveryAnnounced.has(`retry:${planId}`)) {
        continue;
      }
      recoveryAnnounced.add(`retry:${planId}`);
      await logEvent(paths, state, 'plan_retry_armed', {
        planId,
        attempts: details.attempts,
        maxAttempts: details.maxAttempts
      }, options.dryRun);
      progressLog(options, `retry armed ${planId}: attempt ${details.attempts + 1}/${details.maxAttempts}`);
    }
    for (const [planId, details] of recoverable.unblockable.entries()) {
      if (recoveryAnnounced.has(`unblock:${planId}`)) {
        continue;
      }
      recoveryAnnounced.add(`unblock:${planId}`);
      await logEvent(paths, state, 'plan_unblock_armed', {
        planId,
        reason: details.reason
      }, options.dryRun);
      progressLog(options, `auto-unblock armed ${planId}: ${details.reason}`);
    }

    const failedOrBlockedIds = new Set([...deferredPlanIds]);
    for (const planId of state.failedPlanIds) {
      if (!recoverablePlanIds.has(planId)) {
        failedOrBlockedIds.add(planId);
      }
    }
    for (const planId of state.blockedPlanIds) {
      if (!recoverablePlanIds.has(planId)) {
        failedOrBlockedIds.add(planId);
      }
    }

    state.failedPlanIds = state.failedPlanIds.filter((planId) => !recoverablePlanIds.has(planId));
    state.blockedPlanIds = state.blockedPlanIds.filter((planId) => !recoverablePlanIds.has(planId));

    let executable = executablePlans(catalog.active, completedIds, failedOrBlockedIds, recoverablePlanIds);
    let blockedByDependency = blockedPlans(catalog.active, completedIds, failedOrBlockedIds);
    if (options.planId) {
      executable = executable.filter((plan) => matchesPlanIdFilter(plan, options.planId));
      blockedByDependency = blockedByDependency.filter((plan) => matchesPlanIdFilter(plan, options.planId));
    }

    state.queue = executable.map((plan) => plan.planId);
    await saveState(paths, state, options.dryRun);

    for (const blocked of blockedByDependency) {
      const missingDependencies = blocked.dependencies.filter((dependency) => !completedIds.has(dependency));
      const cacheValue = missingDependencies.slice().sort().join(',');
      if (dependencyWaitCache.get(blocked.planId) === cacheValue) {
        continue;
      }

      dependencyWaitCache.set(blocked.planId, cacheValue);
      await logEvent(paths, state, 'plan_waiting_dependency', {
        planId: blocked.planId,
        missingDependencies
      }, options.dryRun);
    }

    if (executable.length === 0) {
      if (state.blockedPlanIds.length > 0) {
        progressLog(
          options,
          `no executable plans; ${state.blockedPlanIds.length} plan(s) are blocked in this run. Run audit for details.`
        );
      }
      break;
    }

    const nextPlan = executable[0];
    if (nextPlan.status === 'failed' && recoverable.retryableFailed.has(nextPlan.planId)) {
      registerPlanRetryAttempt(state, nextPlan.planId);
    }
    const nextPlanRisk = computeRiskAssessment(nextPlan, state, config);
    await logEvent(paths, state, 'plan_started', {
      planId: nextPlan.planId,
      planFile: nextPlan.rel,
      runMode,
      declaredRiskTier: nextPlanRisk.declaredRiskTier,
      computedRiskTier: nextPlanRisk.computedRiskTier,
      effectiveRiskTier: nextPlanRisk.effectiveRiskTier,
      riskScore: nextPlanRisk.score,
      sensitive: nextPlanRisk.sensitive
    }, options.dryRun);
    progressLog(
      options,
      `plan start ${nextPlan.planId} declared=${nextPlanRisk.declaredRiskTier} effective=${nextPlanRisk.effectiveRiskTier} score=${nextPlanRisk.score}`
    );

    const outcome = await processPlan(nextPlan, paths, state, options, config);
    state.inProgress = null;

    if (outcome.outcome === 'completed') {
      delete state.roleState[nextPlan.planId];
      clearPlanRecoveryState(state, nextPlan.planId);
      clearPlanContinuationState(state, nextPlan.planId);
      if (!state.completedPlanIds.includes(nextPlan.planId)) {
        state.completedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_completed', {
        planId: nextPlan.planId,
        completedPath: outcome.completedPath,
        commitHash: outcome.commitHash ?? null,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      }, options.dryRun);
      progressLog(options, `plan completed ${nextPlan.planId}`);
    } else if (outcome.outcome === 'blocked') {
      clearPlanContinuationState(state, nextPlan.planId);
      const nextSteps = deriveOutcomeNextSteps(
        nextPlan,
        outcome,
        state,
        config,
        outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      );
      if (!state.blockedPlanIds.includes(nextPlan.planId)) {
        state.blockedPlanIds.push(nextPlan.planId);
      }
      progressLog(options, `blocked ${nextPlan.planId}: ${outcome.reason}`);
      if (nextSteps.length > 0) {
        progressLog(options, `next steps ${nextPlan.planId}: ${nextSteps.join(' | ')}`);
      }
      await logEvent(paths, state, 'plan_blocked', {
        planId: nextPlan.planId,
        reason: outcome.reason,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier,
        nextSteps
      }, options.dryRun);
    } else if (outcome.outcome === 'pending') {
      const nextSteps = deriveOutcomeNextSteps(
        nextPlan,
        outcome,
        state,
        config,
        outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      );
      deferredPlanIds.add(nextPlan.planId);
      await logEvent(paths, state, 'plan_pending', {
        planId: nextPlan.planId,
        reason: outcome.reason,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier,
        nextSteps
      }, options.dryRun);
      progressLog(options, `plan pending ${nextPlan.planId}: ${outcome.reason}`);
      if (nextSteps.length > 0) {
        progressLog(options, `next steps ${nextPlan.planId}: ${nextSteps.join(' | ')}`);
      }
    } else {
      const nextSteps = deriveOutcomeNextSteps(
        nextPlan,
        outcome,
        state,
        config,
        outcome.riskTier ?? nextPlanRisk.effectiveRiskTier
      );
      delete state.roleState[nextPlan.planId];
      clearPlanContinuationState(state, nextPlan.planId);
      registerPlanFailureAttempt(state, nextPlan.planId, outcome.reason ?? 'unknown failure');
      if (!state.failedPlanIds.includes(nextPlan.planId)) {
        state.failedPlanIds.push(nextPlan.planId);
      }
      await logEvent(paths, state, 'plan_failed', {
        planId: nextPlan.planId,
        reason: outcome.reason,
        riskTier: outcome.riskTier ?? nextPlanRisk.effectiveRiskTier,
        nextSteps
      }, options.dryRun);
      progressLog(options, `plan failed ${nextPlan.planId}: ${outcome.reason}`);
      if (nextSteps.length > 0) {
        progressLog(options, `next steps ${nextPlan.planId}: ${nextSteps.join(' | ')}`);
      }
    }

    await saveState(paths, state, options.dryRun);
    processed += 1;
  }

  return processed;
}

function planDependenciesReady(plan, completedPlanIds) {
  return (plan.dependencies ?? []).every((dependency) => completedPlanIds.has(dependency));
}

function schedulerLocksForPlan(plan) {
  const locks = new Set();
  for (const lock of Array.isArray(plan.concurrencyLocks) ? plan.concurrencyLocks : []) {
    locks.add(`custom:${String(lock).trim().toLowerCase()}`);
  }
  const targets =
    Array.isArray(plan.specTargets) && plan.specTargets.length > 0
      ? plan.specTargets
      : ['docs/product-specs/CURRENT-STATE.md'];
  for (const target of targets) {
    locks.add(`spec:${target}`);
  }
  if (targets.includes('docs/product-specs/CURRENT-STATE.md')) {
    locks.add('shared:product-spec-current-state');
  }
  return [...locks].sort((a, b) => a.localeCompare(b));
}

function selectParallelDispatchBatch(candidates, activeLocks, maxToSelect) {
  const selected = [];
  const localLocks = new Set(activeLocks);
  for (const plan of candidates) {
    if (selected.length >= maxToSelect) {
      break;
    }
    const planLocks = schedulerLocksForPlan(plan);
    const conflicts = planLocks.some((entry) => localLocks.has(entry));
    if (conflicts) {
      continue;
    }
    selected.push(plan);
    for (const lock of planLocks) {
      localLocks.add(lock);
    }
  }
  return selected;
}

function parallelWorkerRunId(runId, planId) {
  return `${runId}-${planId}`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function replaceParallelCommandTokens(template, details) {
  return String(template)
    .replaceAll('{plan_id}', details.planId)
    .replaceAll('{branch}', details.branchName)
    .replaceAll('{base_ref}', details.baseRef)
    .replaceAll('{git_remote}', details.gitRemote)
    .replaceAll('{run_id}', details.runId)
    .replaceAll('{head_sha}', details.headSha ?? '')
    .replaceAll('{worktree}', details.worktreeDir);
}

function buildParallelWorkerCommand(plan, state, options, parallelOptions) {
  const args = [
    'node',
    './scripts/automation/orchestrator.mjs',
    'run',
    '--mode',
    state.effectiveMode,
    '--max-plans',
    '1',
    '--skip-promotion',
    'true',
    '--plan-id',
    plan.planId,
    '--run-id',
    parallelWorkerRunId(state.runId, plan.planId),
    '--parallel-plans',
    '1',
    '--max-rollovers',
    String(asInteger(options.maxRollovers, DEFAULT_MAX_ROLLOVERS)),
    '--max-sessions-per-plan',
    String(asInteger(options.maxSessionsPerPlan, DEFAULT_MAX_SESSIONS_PER_PLAN)),
    '--context-threshold',
    String(asInteger(options.contextThreshold, DEFAULT_CONTEXT_THRESHOLD)),
    '--context-absolute-floor',
    String(asInteger(options.contextAbsoluteFloor, DEFAULT_CONTEXT_THRESHOLD)),
    '--context-soft-used-ratio',
    String(asRatio(options.contextSoftUsedRatio, DEFAULT_CONTEXT_SOFT_USED_RATIO)),
    '--context-hard-used-ratio',
    String(asRatio(options.contextHardUsedRatio, DEFAULT_CONTEXT_HARD_USED_RATIO)),
    '--require-result-payload',
    String(asBoolean(options.requireResultPayload, DEFAULT_REQUIRE_RESULT_PAYLOAD)),
    '--output',
    parallelOptions.workerOutputMode,
    '--failure-tail-lines',
    String(asInteger(options.failureTailLines, DEFAULT_FAILURE_TAIL_LINES)),
    '--heartbeat-seconds',
    String(asInteger(options.heartbeatSeconds, DEFAULT_HEARTBEAT_SECONDS)),
    '--stall-warn-seconds',
    String(asInteger(options.stallWarnSeconds, DEFAULT_STALL_WARN_SECONDS)),
    '--touch-summary',
    String(asBoolean(options.touchSummary, DEFAULT_TOUCH_SUMMARY)),
    '--touch-sample-size',
    String(asInteger(options.touchSampleSize, DEFAULT_TOUCH_SAMPLE_SIZE)),
    '--touch-scan-mode',
    String(normalizeTouchScanMode(options.touchScanMode, DEFAULT_TOUCH_SCAN_MODE)),
    '--touch-scan-min-heartbeats',
    String(asInteger(options.touchScanMinHeartbeats, DEFAULT_TOUCH_SCAN_MIN_HEARTBEATS)),
    '--touch-scan-max-heartbeats',
    String(asInteger(options.touchScanMaxHeartbeats, DEFAULT_TOUCH_SCAN_MAX_HEARTBEATS)),
    '--touch-scan-backoff-unchanged',
    String(asInteger(options.touchScanBackoffUnchanged, DEFAULT_TOUCH_SCAN_BACKOFF_UNCHANGED)),
    '--live-activity-mode',
    String(normalizeLiveActivityMode(options.liveActivityMode, DEFAULT_LIVE_ACTIVITY_MODE)),
    '--live-activity-max-chars',
    String(asInteger(options.liveActivityMaxChars, DEFAULT_LIVE_ACTIVITY_MAX_CHARS)),
    '--live-activity-sample-seconds',
    String(asInteger(options.liveActivitySampleSeconds, DEFAULT_LIVE_ACTIVITY_SAMPLE_SECONDS)),
    '--live-activity-emit-event-lines',
    String(asBoolean(options.liveActivityEmitEventLines, DEFAULT_LIVE_ACTIVITY_EMIT_EVENT_LINES)),
    '--live-activity-redact-patterns',
    parseListOption(options.liveActivityRedactPatterns, DEFAULT_LIVE_ACTIVITY_REDACT_PATTERNS).join(';;'),
    '--worker-first-touch-deadline-seconds',
    String(asInteger(options.workerFirstTouchDeadlineSeconds, DEFAULT_WORKER_FIRST_TOUCH_DEADLINE_SECONDS)),
    '--worker-retry-first-touch-deadline-seconds',
    String(asInteger(options.workerRetryFirstTouchDeadlineSeconds, DEFAULT_WORKER_RETRY_FIRST_TOUCH_DEADLINE_SECONDS)),
    '--worker-no-touch-retry-limit',
    String(asInteger(options.workerNoTouchRetryLimit, DEFAULT_WORKER_NO_TOUCH_RETRY_LIMIT)),
    '--worker-pending-streak-limit',
    String(asInteger(options.workerPendingStreakLimit, DEFAULT_WORKER_PENDING_STREAK_LIMIT)),
    '--worker-stall-fail-seconds',
    String(asInteger(options.workerStallFailSeconds, DEFAULT_WORKER_STALL_FAIL_SECONDS)),
    '--retry-failed',
    String(asBoolean(options.retryFailedPlans, DEFAULT_RETRY_FAILED_PLANS)),
    '--auto-unblock',
    String(asBoolean(options.autoUnblockPlans, DEFAULT_AUTO_UNBLOCK_PLANS)),
    '--max-failed-retries',
    String(asInteger(options.maxFailedRetries, DEFAULT_MAX_FAILED_RETRIES)),
    '--commit',
    String(asBoolean(options.commit, true)),
    '--allow-dirty',
    'false'
  ];
  if (options.dryRun) {
    args.push('--dry-run', 'true');
  }
  return args.map((entry) => shellQuote(entry)).join(' ');
}

async function prepareParallelWorktree(paths, parallelOptions, plan, state, options) {
  const runToken = sanitizeBranchToken(state.runId) || `run-${Date.now()}`;
  const planToken = sanitizeBranchToken(plan.planId) || `plan-${Date.now()}`;
  const branchName = `${parallelOptions.branchPrefix}/${runToken}/${planToken}`;
  const worktreeDir = path.join(paths.rootDir, parallelOptions.worktreeRoot, `${runToken}-${planToken}`);

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
    if (await exists(worktreeDir)) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
    try {
      const add = runShellCapture(
        `git worktree add --detach ${shellQuote(worktreeDir)} ${shellQuote(parallelOptions.baseRef)}`,
        paths.rootDir
      );
      if (add.status !== 0) {
        throw new Error(`Failed to create worktree for ${plan.planId}. ${tailLines(executionOutput(add), 5)}`);
      }
      const checkout = runShellCapture(
        `git -C ${shellQuote(worktreeDir)} checkout -B ${shellQuote(branchName)}`,
        paths.rootDir
      );
      if (checkout.status !== 0) {
        throw new Error(`Failed to create branch ${branchName} for ${plan.planId}. ${tailLines(executionOutput(checkout), 5)}`);
      }
    } catch (error) {
      runShellCapture(`git worktree remove --force ${shellQuote(worktreeDir)}`, paths.rootDir);
      throw error;
    }
  }

  return {
    branchName,
    worktreeDir
  };
}

async function cleanupParallelWorktree(paths, worktreeDir, options) {
  if (options.dryRun) {
    return { ok: true, reason: null };
  }
  const remove = runShellCapture(`git worktree remove --force ${shellQuote(worktreeDir)}`, paths.rootDir);
  if (remove.status !== 0) {
    const prune = runShellCapture('git worktree prune', paths.rootDir);
    if (prune.status === 0) {
      return {
        ok: false,
        reason: `worktree cleanup failed but prune succeeded for ${worktreeDir}: ${tailLines(executionOutput(remove), 5)}`
      };
    }
    return {
      ok: false,
      reason:
        `worktree cleanup failed for ${worktreeDir}: ${tailLines(executionOutput(remove), 5)}; ` +
        `prune failed: ${tailLines(executionOutput(prune), 5)}`
    };
  }
  return { ok: true, reason: null };
}

async function seedParallelWorkerPlanFile(plan, paths, worktreeDir, options) {
  if (options.dryRun) {
    return { ok: true, seeded: false, planRel: null };
  }
  if (!(await exists(plan.filePath))) {
    return {
      ok: false,
      seeded: false,
      planRel: null,
      reason: `Parallel worker source plan file missing for ${plan.planId}: ${plan.rel}`
    };
  }

  const planRel = assertSafeRelativePlanPath(toPosix(path.relative(paths.rootDir, plan.filePath)));
  const targetPath = path.join(worktreeDir, planRel);
  if (await exists(targetPath)) {
    return { ok: true, seeded: false, planRel };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(plan.filePath, targetPath);

  const add = runShellCapture(
    `git -C ${shellQuote(worktreeDir)} add ${shellQuote(planRel)}`,
    paths.rootDir
  );
  if (add.status !== 0) {
    return {
      ok: false,
      seeded: false,
      planRel,
      reason: `Failed to seed ${plan.planId} into worker worktree: ${tailLines(executionOutput(add), 5)}`
    };
  }

  const commit = runShellCapture(
    `git -C ${shellQuote(worktreeDir)} commit -m ${shellQuote(`chore(automation): seed active plan ${plan.planId}`)} -- ${shellQuote(planRel)}`,
    paths.rootDir
  );
  if (commit.status !== 0) {
    return {
      ok: false,
      seeded: false,
      planRel,
      reason: `Failed to commit seeded active plan ${plan.planId} in worker worktree: ${tailLines(executionOutput(commit), 5)}`
    };
  }

  return { ok: true, seeded: true, planRel };
}

async function runParallelWorkerPlan(plan, paths, state, options, config, parallelOptions) {
  let prepared = null;
  let execution = { status: 0, error: null, stdout: '', stderr: '' };
  let result = null;
  try {
    prepared = await prepareParallelWorktree(paths, parallelOptions, plan, state, options);
    const seededPlan = await seedParallelWorkerPlanFile(plan, paths, prepared.worktreeDir, options);
    if (!seededPlan.ok) {
      throw new Error(seededPlan.reason || `Failed to seed worker plan file for ${plan.planId}.`);
    }
    const workerRunId = parallelWorkerRunId(state.runId, plan.planId);
    const workerCommand = buildParallelWorkerCommand(plan, state, options, parallelOptions);
    const baseShaResult = options.dryRun
      ? { status: 0, stdout: '' }
      : runShellCapture(`git -C ${shellQuote(prepared.worktreeDir)} rev-parse HEAD`, paths.rootDir);
    const baseSha = baseShaResult.status === 0 ? String(baseShaResult.stdout ?? '').trim() : null;

    if (!options.dryRun) {
      execution = await runShellMonitored(
        workerCommand,
        prepared.worktreeDir,
        process.env,
        undefined,
        'pipe',
        options,
        { phase: 'parallel-worker', planId: plan.planId, role: 'worker', activity: 'branch-execution' }
      );
    }

    let workerState = null;
    const workerStatePath = path.join(prepared.worktreeDir, 'docs', 'ops', 'automation', 'run-state.json');
    if (!options.dryRun && execution.status === 0) {
      if (!(await exists(workerStatePath))) {
        throw new Error(`Worker run-state missing for ${plan.planId}: ${toPosix(path.relative(paths.rootDir, workerStatePath))}`);
      }
      workerState = await readJsonStrict(workerStatePath);
    } else {
      workerState = await readJsonIfExists(workerStatePath, null);
    }
    const completed = new Set(Array.isArray(workerState?.completedPlanIds) ? workerState.completedPlanIds : []);
    const failed = new Set(Array.isArray(workerState?.failedPlanIds) ? workerState.failedPlanIds : []);
    const blocked = new Set(Array.isArray(workerState?.blockedPlanIds) ? workerState.blockedPlanIds : []);

    const headShaResult = options.dryRun
      ? { status: 0, stdout: '' }
      : runShellCapture(`git -C ${shellQuote(prepared.worktreeDir)} rev-parse HEAD`, paths.rootDir);
    const headSha = headShaResult.status === 0 ? String(headShaResult.stdout ?? '').trim() : null;
    const committed = Boolean(baseSha && headSha && baseSha !== headSha);

    let outcome = 'pending';
    let reason = 'branch worker pending';
    if (completed.has(plan.planId)) {
      outcome = 'completed';
      reason = 'completed in branch worker';
    } else if (failed.has(plan.planId) || execution.status !== 0) {
      outcome = 'failed';
      reason = execution.status !== 0
        ? `branch worker failed (exit ${execution.status ?? 'n/a'}): ${tailLines(executionOutput(execution), 8)}`
        : 'branch worker marked failed';
    } else if (blocked.has(plan.planId)) {
      outcome = 'blocked';
      reason = 'blocked in branch worker';
    } else if (execution.status === 0 && !options.dryRun) {
      const outputTail = tailLines(executionOutput(execution), 8);
      outcome = 'pending';
      reason = outputTail
        ? `branch worker exited 0 without terminal plan outcome; treated as pending. output: ${outputTail}`
        : 'branch worker exited 0 without terminal plan outcome; treated as pending';
    }

    if (!options.dryRun && committed && parallelOptions.pushBranches) {
      const push = runShellCapture(
        `git push -u ${shellQuote(parallelOptions.gitRemote)} ${shellQuote(prepared.branchName)}`,
        prepared.worktreeDir
      );
      if (push.status !== 0) {
        outcome = 'failed';
        reason = `branch push failed: ${tailLines(executionOutput(push), 8)}`;
      }
    }

    if (
      !options.dryRun &&
      committed &&
      parallelOptions.openPullRequests &&
      parallelOptions.pullRequest.createCommand
    ) {
      const prCommand = replaceParallelCommandTokens(parallelOptions.pullRequest.createCommand, {
        planId: plan.planId,
        branchName: prepared.branchName,
        baseRef: parallelOptions.baseRef,
        gitRemote: parallelOptions.gitRemote,
        runId: workerRunId,
        headSha,
        worktreeDir: prepared.worktreeDir
      });
      const pr = runShellCapture(prCommand, prepared.worktreeDir);
      if (pr.status !== 0) {
        outcome = 'failed';
        reason = `PR creation failed: ${tailLines(executionOutput(pr), 8)}`;
      }
      if (pr.status === 0 && parallelOptions.pullRequest.mergeCommand) {
        const mergeCommand = replaceParallelCommandTokens(parallelOptions.pullRequest.mergeCommand, {
          planId: plan.planId,
          branchName: prepared.branchName,
          baseRef: parallelOptions.baseRef,
          gitRemote: parallelOptions.gitRemote,
          runId: workerRunId,
          headSha,
          worktreeDir: prepared.worktreeDir
        });
        const merge = runShellCapture(mergeCommand, prepared.worktreeDir);
        if (merge.status !== 0) {
          outcome = 'failed';
          reason = `PR merge/queue command failed: ${tailLines(executionOutput(merge), 8)}`;
        }
      }
    }

    result = {
      planId: plan.planId,
      planFile: plan.rel,
      outcome,
      branchName: prepared.branchName,
      worktreeDir: prepared.worktreeDir,
      runId: workerRunId,
      committed,
      baseSha,
      headSha,
      reason,
      exitCode: execution.status
    };
    return result;
  } finally {
    const shouldKeepForDiagnostics = Boolean(
      prepared && !options.dryRun && (!result || result.outcome !== 'completed')
    );
    if (shouldKeepForDiagnostics && result) {
      result.cleanupWarning = result.cleanupWarning ?? `worker worktree preserved for diagnostics: ${prepared.worktreeDir}`;
    }
    if (prepared && !parallelOptions.keepWorktrees && !shouldKeepForDiagnostics) {
      const cleanup = await cleanupParallelWorktree(paths, prepared.worktreeDir, options);
      if (!cleanup.ok) {
        if (result) {
          result.cleanupWarning = cleanup.reason;
        } else if (!execution || execution.status === 0) {
          throw new Error(cleanup.reason || `worktree cleanup failed for ${prepared.worktreeDir}`);
        }
      }
    }
  }
}

async function runParallelCommand(paths, options) {
  const config = await loadConfig(paths);
  Object.assign(options, resolveRuntimeExecutorOptions(options, config));
  const parallelOptions = resolveParallelExecutionOptions(paths.rootDir, options, config);
  const resumeParallel = asBoolean(options.resumeParallel, false);
  if (parallelOptions.parallelPlans <= 1) {
    return resumeParallel ? resumeCommand(paths, options) : runCommand(paths, options);
  }

  if (!gitAvailable(paths.rootDir)) {
    throw new Error('Parallel execution requires git (worktree/branch mode).');
  }
  if (asBoolean(options.allowDirty, false) && asBoolean(options.commit, config.git.atomicCommits !== false)) {
    throw new Error('Refusing --allow-dirty true with --commit true. Disable commits or start from a clean worktree.');
  }
  let modeResolution = null;
  let state = null;
  if (resumeParallel) {
    const persisted = await readJsonIfExists(paths.runStatePath, null);
    if (!persisted || !persisted.runId) {
      throw new Error('No existing run-state found. Start with `run` first.');
    }
    if (options.runId && options.runId !== persisted.runId) {
      throw new Error(`Requested run-id '${options.runId}' does not match persisted run '${persisted.runId}'.`);
    }
    state = normalizePersistedState(persisted);
    state.capabilities = await detectCapabilities();
  } else {
    modeResolution = resolveEffectiveMode(options.mode);
    const runId = options.runId || randomRunId();
    state = createInitialState(runId, modeResolution.requestedMode, modeResolution.effectiveMode);
    state.capabilities = await detectCapabilities();
  }
  if (
    !asBoolean(options.allowDirty, false) &&
    gitDirty(paths.rootDir, { ignoreTransientAutomationArtifacts: true })
  ) {
    throw new Error(
      resumeParallel
        ? 'Refusing parallel resume with dirty git worktree.'
        : 'Refusing parallel execution with dirty git worktree.'
    );
  }

  assertExecutorConfigured(options, config);
  assertValidationConfigured(options, config, paths);

  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);
  await saveState(paths, state, options.dryRun);

  try {
    if (resumeParallel) {
      await logEvent(paths, state, 'run_resumed_parallel', {
        requestedMode: options.mode ?? state.requestedMode,
        effectiveMode: state.effectiveMode,
        parallelPlans: parallelOptions.parallelPlans,
        branchPrefix: parallelOptions.branchPrefix,
        baseRef: parallelOptions.baseRef,
        worktreeRoot: parallelOptions.worktreeRoot,
        capabilities: state.capabilities
      }, options.dryRun);
    } else {
      await logEvent(paths, state, 'run_started_parallel', {
        requestedMode: modeResolution.requestedMode,
        effectiveMode: modeResolution.effectiveMode,
        parallelPlans: parallelOptions.parallelPlans,
        branchPrefix: parallelOptions.branchPrefix,
        baseRef: parallelOptions.baseRef,
        worktreeRoot: parallelOptions.worktreeRoot
      }, options.dryRun);
    }

    if (!resumeParallel && !asBoolean(options.skipPromotion, false)) {
      const promoted = await promoteFuturePlans(paths, state, options);
      if (promoted > 0) {
        progressLog(options, `promoted ${promoted} future plan(s) into docs/exec-plans/active.`);
      }
    }

    const catalog = await collectPlanCatalog(paths);
    reconcileOutcomeTracking(state, catalog);

    let candidates = catalog.active
      .filter((plan) => ACTIVE_STATUSES.has(plan.status))
      .filter((plan) => plan.status !== 'completed')
      .sort((a, b) => {
        const priorityDelta = priorityOrder(a.priority) - priorityOrder(b.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return a.rel.localeCompare(b.rel);
      });
    if (options.planId) {
      candidates = candidates.filter((plan) => matchesPlanIdFilter(plan, options.planId));
    }
    const maxPlans = asInteger(options.maxPlans, Number.MAX_SAFE_INTEGER);
    if (Number.isFinite(maxPlans)) {
      candidates = candidates.slice(0, maxPlans);
    }

    const completedForScheduling = new Set([...state.completedPlanIds, ...catalog.completed.map((plan) => plan.planId)]);
    const recoverable = classifyRecoverablePlans(catalog.active, completedForScheduling, state, options, config);
    const recoverablePlanIds = new Set([
      ...recoverable.retryableFailed.keys(),
      ...recoverable.unblockable.keys()
    ]);
    candidates = candidates.filter((plan) => (
      plan.status !== 'failed' && plan.status !== 'blocked'
        ? true
        : recoverablePlanIds.has(plan.planId)
    ));
    const pending = new Map(candidates.map((plan) => [plan.planId, plan]));
    const launched = new Set();
    const active = new Map();
    const activeLocks = new Map();
    const dependencyWaitCache = new Map();
    const outcomeSummary = {
      completed: 0,
      blocked: 0,
      failed: 0,
      pending: 0
    };
    let processed = 0;
    state.parallelState.activeWorkers = {};

    while ((launched.size < pending.size || active.size > 0) && processed < maxPlans) {
      const waiting = [...pending.values()]
        .filter((plan) => !launched.has(plan.planId))
        .filter((plan) => !planDependenciesReady(plan, completedForScheduling));
      for (const blocked of waiting) {
        const missingDependencies = blocked.dependencies.filter((dependency) => !completedForScheduling.has(dependency));
        const cacheValue = missingDependencies.slice().sort().join(',');
        if (dependencyWaitCache.get(blocked.planId) === cacheValue) {
          continue;
        }
        dependencyWaitCache.set(blocked.planId, cacheValue);
        await logEvent(paths, state, 'plan_waiting_dependency_parallel', {
          planId: blocked.planId,
          missingDependencies
        }, options.dryRun);
      }

      const ready = [...pending.values()]
        .filter((plan) => !launched.has(plan.planId))
        .filter((plan) => planDependenciesReady(plan, completedForScheduling));
      const remainingBudget = Math.max(0, maxPlans - launched.size);
      const freeSlots = Math.max(0, Math.min(parallelOptions.parallelPlans - active.size, remainingBudget));
      state.queue = ready.map((plan) => plan.planId);
      await saveState(paths, state, options.dryRun);
      if (freeSlots > 0 && ready.length > 0) {
        const reservedLocks = new Set([...activeLocks.values()].flat());
        const batch = selectParallelDispatchBatch(ready, reservedLocks, freeSlots);
        for (const plan of batch) {
          launched.add(plan.planId);
          const locks = schedulerLocksForPlan(plan);
          activeLocks.set(plan.planId, locks);
          progressLog(options, `parallel worker start ${plan.planId}`);
          await logEvent(paths, state, 'parallel_worker_started', {
            planId: plan.planId,
            planFile: plan.rel,
            branchPrefix: parallelOptions.branchPrefix,
            locks
          }, options.dryRun);
          state.parallelState.activeWorkers[plan.planId] = {
            planId: plan.planId,
            planFile: plan.rel,
            branchPrefix: parallelOptions.branchPrefix,
            startedAt: nowIso(),
            locks
          };
          const workerPromise = runParallelWorkerPlan(plan, paths, state, options, config, parallelOptions)
            .then((result) => ({ ...result }))
            .catch((error) => ({
              planId: plan.planId,
              planFile: plan.rel,
              outcome: 'failed',
              reason: error instanceof Error ? error.message : String(error),
              committed: false,
              branchName: null,
              worktreeDir: null,
              runId: parallelWorkerRunId(state.runId, plan.planId),
              baseSha: null,
              headSha: null,
              exitCode: 1
            }));
          active.set(plan.planId, workerPromise);
        }
        await saveState(paths, state, options.dryRun);
      }

      if (active.size === 0) {
        const unresolved = [...pending.values()].filter((plan) => !launched.has(plan.planId));
        for (const unresolvedPlan of unresolved) {
          const missingDependencies = unresolvedPlan.dependencies.filter(
            (dependency) => !completedForScheduling.has(dependency)
          );
          await logEvent(paths, state, 'plan_unscheduled_parallel', {
            planId: unresolvedPlan.planId,
            reason:
              missingDependencies.length > 0
                ? 'dependencies-not-integrated'
                : 'conflict-locks-or-budget',
            missingDependencies
          }, options.dryRun);
        }
        break;
      }

      const nextFinished = await Promise.race(
        [...active.entries()].map(([planId, promise]) => promise.then((result) => ({ planId, result })))
      );
      active.delete(nextFinished.planId);
      activeLocks.delete(nextFinished.planId);
      delete state.parallelState.activeWorkers[nextFinished.planId];
      processed += 1;

      const result = nextFinished.result;
      const plan = pending.get(result.planId);
      if (!plan) {
        continue;
      }

      if (result.outcome === 'completed') {
        outcomeSummary.completed += 1;
        if (parallelOptions.assumeDependencyCompletion) {
          completedForScheduling.add(plan.planId);
        }
        await logEvent(paths, state, 'plan_completed_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          committed: result.committed,
          headSha: result.headSha,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      } else if (result.outcome === 'blocked') {
        outcomeSummary.blocked += 1;
        await logEvent(paths, state, 'plan_blocked_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          reason: result.reason,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      } else if (result.outcome === 'failed') {
        outcomeSummary.failed += 1;
        await logEvent(paths, state, 'plan_failed_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          reason: result.reason,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      } else {
        outcomeSummary.pending += 1;
        await logEvent(paths, state, 'plan_pending_parallel', {
          planId: plan.planId,
          branch: result.branchName,
          reason: result.reason,
          cleanupWarning: result.cleanupWarning ?? null
        }, options.dryRun);
      }
      state.parallelState.lastResults[plan.planId] = {
        outcome: result.outcome,
        reason: result.reason ?? null,
        branch: result.branchName ?? null,
        headSha: result.headSha ?? null,
        cleanupWarning: result.cleanupWarning ?? null,
        finishedAt: nowIso()
      };
      progressLog(options, `parallel worker end ${plan.planId} outcome=${result.outcome}`);
      await saveState(paths, state, options.dryRun);
    }

    const unresolvedNotLaunched = [...pending.values()].filter((plan) => !launched.has(plan.planId)).length;
    state.queue = [...pending.values()].filter((plan) => !launched.has(plan.planId)).map((plan) => plan.planId);
    state.parallelState.activeWorkers = {};
    if (unresolvedNotLaunched > 0) {
      outcomeSummary.pending += unresolvedNotLaunched;
    }

    const runDurationSeconds = durationSeconds(state.startedAt);
    await logEvent(paths, state, 'run_finished_parallel', {
      processedPlans: processed,
      branchCompletedPlans: outcomeSummary.completed,
      branchBlockedPlans: outcomeSummary.blocked,
      branchFailedPlans: outcomeSummary.failed,
      branchPendingPlans: outcomeSummary.pending,
      unlaunchedPlans: unresolvedNotLaunched,
      durationSeconds: runDurationSeconds,
      parallelPlans: parallelOptions.parallelPlans
    }, options.dryRun);
    await saveState(paths, state, options.dryRun);
    printParallelRunSummary(options, state, processed, runDurationSeconds, outcomeSummary);
  } finally {
    await releaseRunLock(paths, options);
  }
}

async function runCommand(paths, options) {
  const config = await loadConfig(paths);
  Object.assign(options, resolveRuntimeExecutorOptions(options, config));
  if (asBoolean(options.allowDirty, false) && asBoolean(options.commit, config.git.atomicCommits !== false)) {
    throw new Error('Refusing --allow-dirty true with --commit true. Disable commits or start from a clean worktree.');
  }
  const modeResolution = resolveEffectiveMode(options.mode);
  const runId = options.runId || randomRunId();
  const previousPersisted = await readJsonIfExists(paths.runStatePath, null);
  const previousState =
    previousPersisted && typeof previousPersisted === 'object' && previousPersisted.runId
      ? normalizePersistedState(previousPersisted)
      : null;

  const state = createInitialState(runId, modeResolution.requestedMode, modeResolution.effectiveMode);
  if (previousState?.implementationState && typeof previousState.implementationState === 'object') {
    state.implementationState = previousState.implementationState;
  }
  state.capabilities = await detectCapabilities();

  if (
    !asBoolean(options.allowDirty, false) &&
    gitAvailable(paths.rootDir) &&
    gitDirty(paths.rootDir, { ignoreTransientAutomationArtifacts: true })
  ) {
    throw new Error('Refusing to start with a dirty git worktree. Use --allow-dirty true to override.');
  }

  assertExecutorConfigured(options, config);
  assertValidationConfigured(options, config, paths);

  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);
  await saveState(paths, state, options.dryRun);

  try {
    const roleConfig = resolveRoleOrchestration(config);
    await logEvent(paths, state, 'run_started', {
      requestedMode: modeResolution.requestedMode,
      effectiveMode: modeResolution.effectiveMode,
      downgraded: modeResolution.downgraded,
      downgradeReason: modeResolution.reason,
      capabilities: state.capabilities,
        sessionPolicy: {
          contextThreshold: options.contextThreshold,
          contextAbsoluteFloor: options.contextAbsoluteFloor,
          contextSoftUsedRatio: options.contextSoftUsedRatio,
          contextHardUsedRatio: options.contextHardUsedRatio,
          requireResultPayload: options.requireResultPayload,
        touchScan: {
          mode: options.touchScanMode,
          minHeartbeats: options.touchScanMinHeartbeats,
          maxHeartbeats: options.touchScanMaxHeartbeats,
          backoffUnchanged: options.touchScanBackoffUnchanged
        },
        liveActivity: {
          mode: options.liveActivityMode,
          maxChars: options.liveActivityMaxChars,
          sampleSeconds: options.liveActivitySampleSeconds,
          emitEventLines: options.liveActivityEmitEventLines
        },
        workerProgressGuards: {
          firstTouchDeadlineSeconds: options.workerFirstTouchDeadlineSeconds,
          retryFirstTouchDeadlineSeconds: options.workerRetryFirstTouchDeadlineSeconds,
          noTouchRetryLimit: options.workerNoTouchRetryLimit,
          pendingStreakLimit: options.workerPendingStreakLimit,
          stallFailSeconds: options.workerStallFailSeconds
        },
        evidenceSessionMaintenance: {
          indexRefreshMode: options.evidenceSessionIndexRefreshMode,
          curationMode: options.evidenceSessionCurationMode
        },
        contactPacks: {
          enabled: options.contactPackEnabled,
          maxPolicyBullets: options.contactPackMaxPolicyBullets,
          includeRecentEvidence: options.contactPackIncludeRecentEvidence,
          maxRecentEvidenceItems: options.contactPackMaxRecentEvidenceItems,
          includeLatestState: options.contactPackIncludeLatestState,
          maxRecentCheckpointItems: options.contactPackMaxRecentCheckpointItems,
          maxStateListItems: options.contactPackMaxStateListItems,
          cacheMode: options.contactPackCacheMode
        }
      },
      roleOrchestration: {
        enabled: roleConfig.enabled,
        mode: roleConfig.mode,
        pipelines: roleConfig.pipelines,
        stageBudgetsSeconds: roleConfig.stageBudgetsSeconds,
        stageReuse: roleConfig.stageReuse
      }
    }, options.dryRun);

    if (modeResolution.downgraded) {
      progressLog(options, `full mode downgraded to guarded: ${modeResolution.reason}`);
    }
    progressLog(
      options,
      `run started runId=${state.runId} mode=${state.effectiveMode} output=${options.outputMode} failureTailLines=${options.failureTailLines}`
    );

    let processed = await runLoop(paths, state, options, config, 'run');

    if (!asBoolean(options.skipPromotion, false)) {
      const promoted = await promoteFuturePlans(paths, state, options);
      if (promoted > 0) {
        progressLog(options, `promoted ${promoted} future plan(s) into docs/exec-plans/active.`);
        const processedAfterPromotion = await runLoop(paths, state, options, config, 'run');
        processed += processedAfterPromotion;
      }
    }

    const runDurationSeconds = durationSeconds(state.startedAt);
    await logEvent(paths, state, 'run_finished', {
      processedPlans: processed,
      completedPlans: state.completedPlanIds.length,
      blockedPlans: state.blockedPlanIds.length,
      failedPlans: state.failedPlanIds.length,
      promotions: state.stats.promotions,
      handoffs: state.stats.handoffs,
      commits: state.stats.commits,
      validationFailures: state.stats.validationFailures,
      durationSeconds: runDurationSeconds
    }, options.dryRun);

    await saveState(paths, state, options.dryRun);

    printRunSummary(options, 'run', state, processed, runDurationSeconds);
  } finally {
    await releaseRunLock(paths, options);
  }
}

async function resumeCommand(paths, options) {
  const config = await loadConfig(paths);
  Object.assign(options, resolveRuntimeExecutorOptions(options, config));
  if (asBoolean(options.allowDirty, false) && asBoolean(options.commit, config.git.atomicCommits !== false)) {
    throw new Error('Refusing --allow-dirty true with --commit true. Disable commits or start from a clean worktree.');
  }
  const persisted = await readJsonIfExists(paths.runStatePath, null);

  if (!persisted || !persisted.runId) {
    throw new Error('No existing run-state found. Start with `run` first.');
  }

  if (options.runId && options.runId !== persisted.runId) {
    throw new Error(`Requested run-id '${options.runId}' does not match persisted run '${persisted.runId}'.`);
  }

  const state = normalizePersistedState(persisted);
  if (state.inProgress && typeof state.inProgress === 'object') {
    progressLog(
      options,
      `clearing stale in-progress session plan=${safeDisplayToken(state.inProgress.planId, 'unknown')} role=${safeDisplayToken(state.inProgress.role, 'n/a')} startedAt=${safeDisplayToken(state.inProgress.startedAt, 'n/a')}`
    );
    state.inProgress = null;
  }
  await hydrateSessionStateFromRunEvents(paths, state);
  state.capabilities = await detectCapabilities();
  if (
    !asBoolean(options.allowDirty, false) &&
    gitAvailable(paths.rootDir) &&
    gitDirty(paths.rootDir, { ignoreTransientAutomationArtifacts: true })
  ) {
    throw new Error('Refusing to resume with a dirty git worktree. Use --allow-dirty true to override.');
  }
  assertExecutorConfigured(options, config);
  assertValidationConfigured(options, config, paths);
  await ensureDirectories(paths, options.dryRun);
  await acquireRunLock(paths, state, options);

  try {
    const roleConfig = resolveRoleOrchestration(config);
    await logEvent(paths, state, 'run_resumed', {
      requestedMode: options.mode ?? state.requestedMode,
      effectiveMode: state.effectiveMode,
      capabilities: state.capabilities,
      sessionPolicy: {
        contextThreshold: options.contextThreshold,
        contextAbsoluteFloor: options.contextAbsoluteFloor,
        contextSoftUsedRatio: options.contextSoftUsedRatio,
        contextHardUsedRatio: options.contextHardUsedRatio,
        requireResultPayload: options.requireResultPayload,
        touchScan: {
          mode: options.touchScanMode,
          minHeartbeats: options.touchScanMinHeartbeats,
          maxHeartbeats: options.touchScanMaxHeartbeats,
          backoffUnchanged: options.touchScanBackoffUnchanged
        },
        liveActivity: {
          mode: options.liveActivityMode,
          maxChars: options.liveActivityMaxChars,
          sampleSeconds: options.liveActivitySampleSeconds,
          emitEventLines: options.liveActivityEmitEventLines
        },
        workerProgressGuards: {
          firstTouchDeadlineSeconds: options.workerFirstTouchDeadlineSeconds,
          retryFirstTouchDeadlineSeconds: options.workerRetryFirstTouchDeadlineSeconds,
          noTouchRetryLimit: options.workerNoTouchRetryLimit,
          pendingStreakLimit: options.workerPendingStreakLimit,
          stallFailSeconds: options.workerStallFailSeconds
        },
        evidenceSessionMaintenance: {
          indexRefreshMode: options.evidenceSessionIndexRefreshMode,
          curationMode: options.evidenceSessionCurationMode
        },
        contactPacks: {
          enabled: options.contactPackEnabled,
          maxPolicyBullets: options.contactPackMaxPolicyBullets,
          includeRecentEvidence: options.contactPackIncludeRecentEvidence,
          maxRecentEvidenceItems: options.contactPackMaxRecentEvidenceItems,
          includeLatestState: options.contactPackIncludeLatestState,
          maxRecentCheckpointItems: options.contactPackMaxRecentCheckpointItems,
          maxStateListItems: options.contactPackMaxStateListItems,
          cacheMode: options.contactPackCacheMode
        }
      },
      roleOrchestration: {
        enabled: roleConfig.enabled,
        mode: roleConfig.mode,
        pipelines: roleConfig.pipelines,
        stageBudgetsSeconds: roleConfig.stageBudgetsSeconds,
        stageReuse: roleConfig.stageReuse
      }
    }, options.dryRun);
    progressLog(
      options,
      `run resumed runId=${state.runId} mode=${state.effectiveMode} output=${options.outputMode} failureTailLines=${options.failureTailLines}`
    );

    const processed = await runLoop(paths, state, options, config, 'resume');

    const runDurationSeconds = durationSeconds(state.startedAt);
    await logEvent(paths, state, 'run_finished', {
      processedPlans: processed,
      completedPlans: state.completedPlanIds.length,
      blockedPlans: state.blockedPlanIds.length,
      failedPlans: state.failedPlanIds.length,
      promotions: state.stats?.promotions ?? 0,
      handoffs: state.stats?.handoffs ?? 0,
      commits: state.stats?.commits ?? 0,
      validationFailures: state.stats?.validationFailures ?? 0,
      durationSeconds: runDurationSeconds
    }, options.dryRun);

    await saveState(paths, state, options.dryRun);

    printRunSummary(options, 'resume', state, processed, runDurationSeconds);
  } finally {
    await releaseRunLock(paths, options);
  }
}

function parseEventLines(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines to keep audit resilient.
    }
  }
  return events;
}

async function auditCommand(paths, options) {
  if (!(await exists(paths.runEventsPath))) {
    console.log('[orchestrator] no run events found.');
    return;
  }

  const raw = await fs.readFile(paths.runEventsPath, 'utf8');
  const events = parseEventLines(raw);
  const filtered = options.runId ? events.filter((event) => event.runId === options.runId) : events;

  const countsByType = new Map();
  const latestPerPlan = new Map();
  const runIds = new Set();

  for (const event of filtered) {
    runIds.add(event.runId);
    countsByType.set(event.type, (countsByType.get(event.type) ?? 0) + 1);

    const planId = event.details?.planId || event.taskId;
    if (planId) {
      latestPerPlan.set(planId, {
        planId,
        type: event.type,
        timestamp: event.timestamp,
        reason: event.details?.reason ?? null
      });
    }
  }

  const payload = {
    runs: [...runIds].sort(),
    eventCount: filtered.length,
    countsByType: Object.fromEntries([...countsByType.entries()].sort(([a], [b]) => a.localeCompare(b))),
    planStatuses: [...latestPerPlan.values()].sort((a, b) => a.planId.localeCompare(b.planId))
  };

  if (asBoolean(options.json, false)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('[orchestrator] audit summary');
  console.log(`- runs: ${payload.runs.join(', ') || 'none'}`);
  console.log(`- events: ${payload.eventCount}`);
  console.log('- counts by type:');
  for (const [type, count] of Object.entries(payload.countsByType)) {
    console.log(`  - ${type}: ${count}`);
  }

  console.log('- latest status by plan:');
  for (const status of payload.planStatuses) {
    const reasonSuffix = status.reason ? ` (${status.reason})` : '';
    console.log(`  - ${status.planId}: ${status.type} @ ${status.timestamp}${reasonSuffix}`);
  }
}

async function curateEvidenceCommand(paths, options) {
  const config = await loadConfig(paths);
  await ensureDirectories(paths, options.dryRun);

  const scope = normalizeCurationScope(options.scope);
  const directories = [];
  if (scope === 'active' || scope === 'all') {
    directories.push(...(await collectAllActiveEvidenceDirectories(paths, options.planId ?? null)));
  }
  if (scope === 'completed' || scope === 'all') {
    directories.push(...(await collectAllCompletedEvidenceDirectories(paths, options.planId ?? null)));
  }

  const summary = await curateEvidenceDirectories(paths, directories, options, config);
  const completedSummary =
    scope === 'completed' || scope === 'all'
      ? await canonicalizeCompletedPlansEvidence(paths, options, config, options.planId ?? null)
      : { plansVisited: 0, plansUpdated: 0, plansIndexed: 0 };
  await writeEvidenceIndexReadme(paths, options);

  if (asBoolean(options.json, false)) {
    console.log(
      JSON.stringify(
        {
          command: 'curate-evidence',
          scope,
          directories: [...new Set(directories)].length,
          ...summary,
          ...completedSummary
        },
        null,
        2
      )
    );
    return;
  }

  console.log('[orchestrator] evidence curation complete.');
  console.log(`- scope: ${scope}`);
  console.log(`- directories: ${[...new Set(directories)].length}`);
  console.log(`- files pruned: ${summary.filesPruned}`);
  console.log(`- files kept: ${summary.filesKept}`);
  console.log(`- docs updated: ${summary.filesUpdated}`);
  console.log(`- path replacements: ${summary.replacementsApplied}`);
  console.log(`- completed plans visited: ${completedSummary.plansVisited}`);
  console.log(`- completed plans updated: ${completedSummary.plansUpdated}`);
  console.log(`- completed plans indexed: ${completedSummary.plansIndexed}`);
}

async function main() {
  const { command, options: rawOptions } = parseArgs(process.argv.slice(2));

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (rawOptions.executor != null || rawOptions['executor-command'] != null) {
    throw new Error(
      'Executor CLI override is disabled. Set docs/ops/automation/orchestrator.config.json executor.command.'
    );
  }

  const options = {
    ...rawOptions,
    mode: rawOptions.mode ?? 'guarded',
    maxPlans: asInteger(rawOptions['max-plans'] ?? rawOptions.maxPlans, Number.MAX_SAFE_INTEGER),
    parallelPlans: asInteger(rawOptions['parallel-plans'] ?? rawOptions.parallelPlans, DEFAULT_PARALLEL_PLANS),
    baseRef: rawOptions['base-ref'] ?? rawOptions.baseRef,
    branchPrefix: rawOptions['branch-prefix'] ?? rawOptions.branchPrefix,
    gitRemote: rawOptions['git-remote'] ?? rawOptions.gitRemote,
    contextThreshold: asInteger(
      rawOptions['context-threshold'] ??
        rawOptions.contextThreshold ??
        rawOptions['context-absolute-floor'] ??
        rawOptions.contextAbsoluteFloor,
      null
    ),
    contextAbsoluteFloor: asInteger(
      rawOptions['context-absolute-floor'] ??
        rawOptions.contextAbsoluteFloor ??
        rawOptions['context-threshold'] ??
        rawOptions.contextThreshold,
      null
    ),
    contextSoftUsedRatio: asRatio(
      rawOptions['context-soft-used-ratio'] ?? rawOptions.contextSoftUsedRatio,
      null
    ),
    contextHardUsedRatio: asRatio(
      rawOptions['context-hard-used-ratio'] ?? rawOptions.contextHardUsedRatio,
      null
    ),
    requireResultPayload: rawOptions['require-result-payload'] ?? rawOptions.requireResultPayload,
    handoffTokenBudget: asInteger(rawOptions['handoff-token-budget'] ?? rawOptions.handoffTokenBudget, DEFAULT_HANDOFF_TOKEN_BUDGET),
    maxRollovers: asInteger(rawOptions['max-rollovers'] ?? rawOptions.maxRollovers, DEFAULT_MAX_ROLLOVERS),
    maxSessionsPerPlan: asInteger(
      rawOptions['max-sessions-per-plan'] ?? rawOptions.maxSessionsPerPlan,
      DEFAULT_MAX_SESSIONS_PER_PLAN
    ),
    validationCommands: rawOptions.validation ?? rawOptions['validation-commands'] ?? '',
    commit: asBoolean(rawOptions.commit, true),
    skipPromotion: asBoolean(rawOptions['skip-promotion'] ?? rawOptions.skipPromotion, false),
    allowDirty: asBoolean(rawOptions['allow-dirty'] ?? rawOptions.allowDirty, false),
    dryRun: asBoolean(rawOptions['dry-run'] ?? rawOptions.dryRun, false),
    json: asBoolean(rawOptions.json, false),
    runId: rawOptions['run-id'] ?? rawOptions.runId,
    planId: rawOptions['plan-id'] ?? rawOptions.planId,
    scope: rawOptions.scope ?? 'all',
    handoffExitCode: asInteger(rawOptions['handoff-exit-code'] ?? rawOptions.handoffExitCode, DEFAULT_HANDOFF_EXIT_CODE),
    outputMode: rawOptions.output ?? rawOptions['output-mode'],
    failureTailLines: rawOptions['failure-tail-lines'] ?? rawOptions.failureTailLines,
    heartbeatSeconds: rawOptions['heartbeat-seconds'] ?? rawOptions.heartbeatSeconds,
    stallWarnSeconds: rawOptions['stall-warn-seconds'] ?? rawOptions.stallWarnSeconds,
    touchSummary: rawOptions['touch-summary'] ?? rawOptions.touchSummary,
    touchSampleSize: rawOptions['touch-sample-size'] ?? rawOptions.touchSampleSize,
    liveActivityMode: rawOptions['live-activity-mode'] ?? rawOptions.liveActivityMode,
    liveActivityMaxChars: rawOptions['live-activity-max-chars'] ?? rawOptions.liveActivityMaxChars,
    liveActivitySampleSeconds:
      rawOptions['live-activity-sample-seconds'] ?? rawOptions.liveActivitySampleSeconds,
    liveActivityEmitEventLines:
      rawOptions['live-activity-emit-event-lines'] ?? rawOptions.liveActivityEmitEventLines,
    liveActivityRedactPatterns:
      rawOptions['live-activity-redact-patterns'] ?? rawOptions.liveActivityRedactPatterns,
    workerFirstTouchDeadlineSeconds:
      rawOptions['worker-first-touch-deadline-seconds'] ?? rawOptions.workerFirstTouchDeadlineSeconds,
    workerRetryFirstTouchDeadlineSeconds:
      rawOptions['worker-retry-first-touch-deadline-seconds'] ?? rawOptions.workerRetryFirstTouchDeadlineSeconds,
    workerNoTouchRetryLimit:
      rawOptions['worker-no-touch-retry-limit'] ?? rawOptions.workerNoTouchRetryLimit,
    workerPendingStreakLimit:
      rawOptions['worker-pending-streak-limit'] ?? rawOptions.workerPendingStreakLimit,
    workerStallFailSeconds:
      rawOptions['worker-stall-fail-seconds'] ?? rawOptions.workerStallFailSeconds
  };

  const rootDir = process.cwd();
  const paths = buildPaths(rootDir);

  if (command === 'run') {
    if (asInteger(options.parallelPlans, DEFAULT_PARALLEL_PLANS) > 1) {
      await runParallelCommand(paths, options);
      return;
    }
    await runCommand(paths, options);
    return;
  }

  if (command === 'run-parallel') {
    await runParallelCommand(paths, options);
    return;
  }

  if (command === 'resume-parallel') {
    options.resumeParallel = true;
    if (rawOptions['skip-promotion'] == null && rawOptions.skipPromotion == null) {
      options.skipPromotion = true;
    }
    await runParallelCommand(paths, options);
    return;
  }

  if (command === 'resume') {
    if (asInteger(options.parallelPlans, DEFAULT_PARALLEL_PLANS) > 1) {
      options.resumeParallel = true;
      if (rawOptions['skip-promotion'] == null && rawOptions.skipPromotion == null) {
        options.skipPromotion = true;
      }
      await runParallelCommand(paths, options);
      return;
    }
    await resumeCommand(paths, options);
    return;
  }

  if (command === 'audit') {
    await auditCommand(paths, options);
    return;
  }

  if (command === 'curate-evidence') {
    await curateEvidenceCommand(paths, options);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error('[orchestrator] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
