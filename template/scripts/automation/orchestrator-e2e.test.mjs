import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { createTemplateRepo, loadJson, runNode } from './test-helpers.mjs';

function directFuturePlan({
  planId,
  status = 'ready-for-promotion',
  riskTier = 'medium',
  securityApproval = 'not-required',
  validationLanes = 'always'
}) {
  return `# ${planId}

Status: ${status}

## Metadata

- Plan-ID: ${planId}
- Status: ${status}
- Priority: p1
- Owner: fixture
- Acceptance-Criteria: Deliver ${planId}.
- Delivery-Class: product
- Dependencies: none
- Spec-Targets: docs/spec.md
- Implementation-Targets: src/${planId}.js
- Risk-Tier: ${riskTier}
- Validation-Lanes: ${validationLanes}
- Security-Approval: ${securityApproval}
- Done-Evidence: pending

## Already-True Baseline

- Baseline exists.

## Must-Land Checklist

- [ ] \`ml-${planId}\` Deliver ${planId}.

## Deferred Follow-Ons

- None.
`;
}

async function configureFixtureRepo(rootDir, scenario) {
  await fs.mkdir(path.join(rootDir, 'docs', 'future'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'docs', 'product-specs'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'docs', 'spec.md'), '# Spec\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'docs', 'product-specs', 'CURRENT-STATE.md'), '# Current State\n', 'utf8');

  const configPath = path.join(rootDir, 'docs', 'ops', 'automation', 'orchestrator.config.json');
  const config = await loadJson(configPath);
  config.executor.command =
    'node ./scripts/automation/fixtures/stub-provider.mjs --result-path {result_path} --plan-file {plan_file} --plan-id {plan_id} --role {role}';
  config.executor.roles.worker.model = 'fixture-worker';
  config.executor.roles.reviewer.model = 'fixture-reviewer';
  if (scenario?.contextBudget && typeof scenario.contextBudget === 'object') {
    config.executor.contextBudget = {
      ...(config.executor.contextBudget ?? {}),
      ...scenario.contextBudget
    };
  }
  config.validation.always = [
    {
      id: 'fixture:always',
      command: 'node ./scripts/automation/fixtures/stub-validation-command.mjs --lane always',
      type: 'always'
    }
  ];
  config.validation.hostRequired = [
    {
      id: 'fixture:host',
      command: 'node ./scripts/automation/fixtures/stub-validation-command.mjs --lane host-required',
      type: 'host-required'
    }
  ];
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'fixture-scenario.json'),
    `${JSON.stringify(scenario, null, 2)}\n`,
    'utf8'
  );
  spawnSync('git', ['add', '.'], { cwd: rootDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'chore: seed orchestrator fixture'], { cwd: rootDir, stdio: 'pipe' });
}

async function writeActiveEvidence(rootDir, planSlug) {
  await fs.mkdir(path.join(rootDir, 'docs', 'exec-plans', 'active', 'evidence'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', 'evidence', `${planSlug}.md`),
    [
      `# Active Evidence: ${planSlug}`,
      '',
      `- Plan-ID: ${planSlug}`,
      `- Source Plan: \`docs/exec-plans/active/2026-03-17-${planSlug}.md\``,
      `- Canonical Index: \`docs/exec-plans/evidence-index/${planSlug}.md\``
    ].join('\n'),
    'utf8'
  );
}

function commitFixtureChanges(rootDir, message) {
  spawnSync('git', ['add', '.'], { cwd: rootDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', message], { cwd: rootDir, stdio: 'pipe' });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForPath(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test('orchestrator promotes a medium-risk future, runs worker and reviewer, then completes it', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'red-inbox': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker delivered red inbox.',
            writeFiles: [{ path: 'src/red-inbox.js', content: 'export const color = "red";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ],
        reviewer: [
          {
            status: 'completed',
            summary: 'Reviewer approved red inbox.'
          }
        ]
      }
    },
    validation: {
      'always:red-inbox': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-red-inbox.md'),
    directFuturePlan({ planId: 'red-inbox', riskTier: 'medium' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed red inbox plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'medium', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const completedPlanPath = path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-17-red-inbox.md');
  const completedPlan = await fs.readFile(completedPlanPath, 'utf8');
  assert.match(completedPlan, /^Status: completed$/m);
  assert.match(completedPlan, /^- Done-Evidence: docs\/exec-plans\/evidence-index\/red-inbox\.md$/m);

  const evidenceIndex = await fs.readFile(path.join(rootDir, 'docs', 'exec-plans', 'evidence-index', 'red-inbox.md'), 'utf8');
  assert.match(evidenceIndex, /fixture:always/);

  const runState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  const workerLog = await fs.readFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', runState.runId, 'red-inbox', 'logs', '01-worker.log'),
    'utf8'
  );
  assert.match(workerLog, /touchSummary=1 file\(s\)/);
  assert.match(workerLog, /touchedFiles=src\/red-inbox\.js/);
  assert.match(workerLog, /liveActivity=worker working on red-inbox/);
  assert.match(workerLog, /liveActivityTrail=1/);
  assert.match(workerLog, /# Recent Activity/);

  const events = await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-events.jsonl'), 'utf8');
  assert.match(events, /future_promoted/);
  assert.match(events, /plan_completed/);
  assert.match(events, /plan_committed/);
  assert.match(events, /"role":"reviewer"/);

  const latestCommit = spawnSync('git', ['log', '--oneline', '--max-count', '1'], { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' });
  assert.equal(latestCommit.status, 0);
  assert.match(String(latestCommit.stdout), /complete red-inbox/);
});

test('orchestrator ticker output keeps timestamped lifecycle lines', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'ticker-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker delivered ticker plan.',
            writeFiles: [{ path: 'src/ticker-plan.js', content: 'export const mode = "ticker";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:ticker-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-ticker-plan.md'),
    directFuturePlan({ planId: 'ticker-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed ticker output plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'ticker'],
    rootDir
  );

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} grind runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} grind overview runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} queue focus runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} plan start plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} session start plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} working plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} file activity phase=session plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} session artifacts plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} grind summary runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} finished runId=/);
});

test('orchestrator pretty output keeps readable lifecycle tags in non-tty mode', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'pretty-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker delivered pretty plan.',
            writeFiles: [{ path: 'src/pretty-plan.js', content: 'export const mode = "pretty";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:pretty-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-pretty-plan.md'),
    directFuturePlan({ planId: 'pretty-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed pretty output plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'pretty'],
    rootDir
  );

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /\d{2}:\d{2}:\d{2} \. RUN  grind/);
  assert.match(String(result.stdout), /GRIND OVERVIEW/);
  assert.match(String(result.stdout), /queue focus/);
  assert.match(String(result.stdout), /plan start/);
  assert.match(String(result.stdout), /runId\s+=\s+run-/);
  assert.match(String(result.stdout), /session start/);
  assert.match(String(result.stdout), /plan\s+=\s+pretty-plan/);
  assert.match(String(result.stdout), /WORKING \(\d{2}:\d{2}\)/);
  assert.match(String(result.stdout), /worker working on pretty-plan/);
  assert.match(String(result.stdout), /file activity/);
  assert.match(String(result.stdout), /session artifacts/);
  assert.match(String(result.stdout), /phase\s+=\s+session/);
  assert.match(String(result.stdout), /GRIND SUMMARY/);
  assert.match(String(result.stdout), /\d{2}:\d{2}:\d{2} \. OK\s+finished/);
  assert.match(String(result.stdout), /runId\s+=\s+run-/);
});

test('orchestrator forces a handoff when a worker returns too close to the context threshold', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    contextBudget: {
      minRemaining: 20000,
      minRemainingPercent: 0.2
    },
    providerActions: {
      'context-threshold-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker paused before context edge.',
            contextRemaining: 15000,
            contextWindow: 100000,
            currentSubtask: 'Summarize remaining implementation work',
            nextAction: 'Resume with a fresh worker session and complete must-land items',
            pendingActions: ['Finish the remaining must-land implementation'],
            writeFiles: [{ path: 'src/context-threshold-wip.js', content: 'export const phase = "handoff";\n' }]
          },
          {
            status: 'completed',
            summary: 'Worker completed the plan after handoff.',
            contextRemaining: 64000,
            contextWindow: 100000,
            writeFiles: [{ path: 'src/context-threshold-plan.js', content: 'export const status = "done";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ],
        reviewer: [
          {
            status: 'completed',
            summary: 'Reviewer approved the resumed plan.'
          }
        ]
      }
    },
    validation: {
      'always:context-threshold-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  const contextThresholdPlan = directFuturePlan({ planId: 'context-threshold-plan', riskTier: 'medium' }).replace(
    '- Implementation-Targets: src/context-threshold-plan.js',
    '- Implementation-Targets: src/context-threshold-plan.js, src/context-threshold-wip.js'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-context-threshold-plan.md'),
    contextThresholdPlan,
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed context threshold plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'medium', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const completedPlanPath = path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-17-context-threshold-plan.md');
  const completedPlan = await fs.readFile(completedPlanPath, 'utf8');
  assert.match(completedPlan, /^Status: completed$/m);

  const handoff = await fs.readFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'handoffs', 'context-threshold-plan.md'),
    'utf8'
  );
  assert.match(handoff, /Context Remaining:/);
  assert.match(handoff, /## Recent Activity/);
  assert.match(handoff, /Touched Files:/);
  assert.match(handoff, /src\/context-threshold-wip\.js/);

  const runState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  const firstWorkerLog = await fs.readFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', runState.runId, 'context-threshold-plan', 'logs', '01-worker.log'),
    'utf8'
  );
  assert.match(firstWorkerLog, /touchedFiles=src\/context-threshold-wip\.js/);
  assert.match(firstWorkerLog, /liveActivity=worker working on context-threshold-plan/);
  assert.match(firstWorkerLog, /liveActivityTrail=1/);

  const events = await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-events.jsonl'), 'utf8');
  assert.match(events, /context_budget_low/);
  assert.match(events, /"status":"handoff_required"/);
});

test('orchestrator blocks high-risk work without explicit security approval', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, { providerActions: {}, validation: {} });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-payments-cutover.md'),
    directFuturePlan({
      planId: 'payments-cutover',
      riskTier: 'high',
      securityApproval: 'pending'
    }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed payments cutover plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'high', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const blockedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-17-payments-cutover.md'),
    'utf8'
  );
  assert.match(blockedPlan, /^Status: blocked$/m);
  assert.match(blockedPlan, /Security-Approval must be approved/);
});

test('orchestrator pauses on session budget exhaustion and resume continues only after a higher limit', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'budget-loop': {
        worker: [
          {
            status: 'pending',
            summary: 'Need another worker pass.',
            reason: 'implementation slice still open',
            nextAction: 'Resume the worker to finish the plan',
            writeFiles: [{ path: 'src/budget-loop-pass-1.js', content: 'export const pass = 1;\n' }]
          },
          {
            status: 'completed',
            summary: 'Worker finished after resume.',
            writeFiles: [{ path: 'src/budget-loop.js', content: 'export const status = "done";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:budget-loop': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  const budgetLoopPlan = directFuturePlan({ planId: 'budget-loop', riskTier: 'low' }).replace(
    '- Implementation-Targets: src/budget-loop.js',
    '- Implementation-Targets: src/budget-loop.js, src/budget-loop-pass-1.js'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-budget-loop.md'),
    budgetLoopPlan,
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed budget loop plan');

  const firstRun = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--max-sessions-per-plan', '1', '--output', 'minimal'],
    rootDir
  );
  assert.equal(firstRun.status, 0, String(firstRun.stderr));

  const activePlanPath = path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-17-budget-loop.md');
  const pausedPlan = await fs.readFile(activePlanPath, 'utf8');
  assert.match(pausedPlan, /^Status: budget-exhausted$/m);
  assert.match(pausedPlan, /Resume with --max-sessions-per-plan 2 or higher\./);

  const firstRunState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  assert.equal(firstRunState.planSessions['budget-loop'], 1);
  assert.deepEqual(firstRunState.budgetExhaustedPlanIds, ['budget-loop']);

  const sameLimitResume = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['resume', '--max-risk', 'low', '--max-sessions-per-plan', '1', '--output', 'minimal'],
    rootDir
  );
  assert.equal(sameLimitResume.status, 0, String(sameLimitResume.stderr));
  assert.match(String(sameLimitResume.stdout), /active budget-exhausted=1/);
  assert.match(String(sameLimitResume.stdout), /resume with -- --max-sessions-per-plan 2 to continue budget-loop/);

  const stillPausedPlan = await fs.readFile(activePlanPath, 'utf8');
  assert.match(stillPausedPlan, /^Status: budget-exhausted$/m);

  const resumedRun = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['resume', '--max-risk', 'low', '--max-sessions-per-plan', '2', '--output', 'minimal'],
    rootDir
  );
  assert.equal(resumedRun.status, 0, String(resumedRun.stderr));

  const completedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-17-budget-loop.md'),
    'utf8'
  );
  assert.match(completedPlan, /^Status: completed$/m);

  const finalRunState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  assert.equal(finalRunState.runId, firstRunState.runId);
  assert.equal(finalRunState.planSessions['budget-loop'], 2);

  const secondWorkerLog = await fs.readFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', finalRunState.runId, 'budget-loop', 'logs', '02-worker.log'),
    'utf8'
  );
  assert.match(secondWorkerLog, /touchedFiles=src\/budget-loop\.js/);

  const events = await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-events.jsonl'), 'utf8');
  assert.match(events, /plan_budget_exhausted/);
  assert.doesNotMatch(events, /"type":"plan_blocked".*"budget-loop"/);
});

test('resume normalizes legacy session-budget blockers and continues the existing run', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'legacy-budget': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker finished after legacy normalization.',
            writeFiles: [{ path: 'src/legacy-budget.js', content: 'export const status = "done";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:legacy-budget': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  const legacyPlan = `${directFuturePlan({ planId: 'legacy-budget', status: 'blocked', riskTier: 'low' })}

## Blockers

- Session budget exhausted after 1 sessions.
`;
  await fs.mkdir(path.join(rootDir, 'docs', 'exec-plans', 'active'), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-17-legacy-budget.md'),
    legacyPlan,
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: 'run-legacy-budget',
      maxRisk: 'low',
      startedAt: '2026-03-17T00:00:00.000Z',
      lastUpdatedAt: '2026-03-17T00:00:00.000Z',
      queue: [],
      activePlanId: null,
      completedPlanIds: [],
      budgetExhaustedPlanIds: [],
      blockedPlanIds: ['legacy-budget'],
      failedPlanIds: [],
      planSessions: { 'legacy-budget': 1 },
      stats: {
        promotions: 0,
        sessions: 1,
        validations: 0,
        completed: 0,
        budgetExhausted: 0,
        blocked: 1,
        commits: 0
      }
    }, null, 2)}\n`,
    'utf8'
  );

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['resume', '--max-risk', 'low', '--max-sessions-per-plan', '2', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const completedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-17-legacy-budget.md'),
    'utf8'
  );
  assert.match(completedPlan, /^Status: completed$/m);

  const finalRunState = JSON.parse(await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-state.json'), 'utf8'));
  assert.equal(finalRunState.runId, 'run-legacy-budget');
  assert.equal(finalRunState.planSessions['legacy-budget'], 2);

  const events = await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-events.jsonl'), 'utf8');
  assert.match(events, /run_resumed/);
});

test('orchestrator reports an explicit executor protocol error when a worker exits without a result payload', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'missing-worker-result': {
        worker: [
          {
            skipResultWrite: true,
            summary: 'This summary should never be used.'
          }
        ]
      }
    },
    validation: {}
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-missing-worker-result.md'),
    directFuturePlan({ planId: 'missing-worker-result', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed missing worker result plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const blockedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-17-missing-worker-result.md'),
    'utf8'
  );
  assert.match(blockedPlan, /^Status: blocked$/m);
  assert.match(blockedPlan, /did not write ORCH_RESULT_PATH/);
  assert.doesNotMatch(blockedPlan, /No summary provided\./);

  const checkpoint = JSON.parse(await fs.readFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'state', 'missing-worker-result', 'latest.json'),
    'utf8'
  ));
  assert.equal(checkpoint.summary, 'Executor protocol error.');
  assert.match(String(checkpoint.reason), /did not write ORCH_RESULT_PATH/);

  const events = await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-events.jsonl'), 'utf8');
  assert.match(events, /session_protocol_error/);
});

test('orchestrator blocks a session when worker exits non-zero even with a valid result payload', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'worker-non-zero': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker finished with side-effects.',
            reason: 'Worker reported completion but command failed.',
            writeFiles: [{ path: 'src/worker-non-zero.js', content: 'export const value = 1;\n' }],
            exitCode: 3
          }
        ]
      }
    },
    validation: {}
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-worker-non-zero.md'),
    directFuturePlan({ planId: 'worker-non-zero', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed worker non-zero exit result plan');

  const result = runNode(
    path.join(rootDir, 'scripts/automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const blockedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-17-worker-non-zero.md'),
    'utf8'
  );
  assert.match(blockedPlan, /^Status: blocked$/m);

  const checkpoint = JSON.parse(await fs.readFile(
    path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'state', 'worker-non-zero', 'latest.json'),
    'utf8'
  ));
  assert.equal(checkpoint.status, 'blocked');
  assert.match(String(checkpoint.reason), /Executor exited 3/);
});

test('orchestrator fails validation explicitly when a validation command exits without a result payload', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'missing-validation-result': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker completed the slice.',
            writeFiles: [{ path: 'src/missing-validation-result.js', content: 'export const ready = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:missing-validation-result': [
        {
          skipResultWrite: true,
          status: 'passed',
          summary: 'This summary should never be used.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-missing-validation-result.md'),
    directFuturePlan({ planId: 'missing-validation-result', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed missing validation result plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const blockedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', '2026-03-17-missing-validation-result.md'),
    'utf8'
  );
  assert.match(blockedPlan, /^Status: blocked$/m);
  assert.match(blockedPlan, /did not write ORCH_VALIDATION_RESULT_PATH/);

  const events = await fs.readFile(path.join(rootDir, 'docs', 'ops', 'automation', 'run-events.jsonl'), 'utf8');
  assert.match(events, /validation_protocol_error/);
});

test('orchestrator refuses a second concurrent run in the same repository', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'locked-plan': {
        worker: [
          {
            delayMs: 1500,
            status: 'completed',
            summary: 'Worker finished after lock contention.',
            writeFiles: [{ path: 'src/locked-plan.js', content: 'export const locked = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:locked-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-locked-plan.md'),
    directFuturePlan({ planId: 'locked-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed lock contention plan');

  const scriptPath = path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs');
  const firstRun = spawn('node', [scriptPath, 'grind', '--max-risk', 'low', '--output', 'minimal'], {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const firstRunDone = waitForChild(firstRun);
  await waitForPath(path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'orchestrator.lock.json'));

  const secondRun = runNode(scriptPath, ['resume', '--max-risk', 'low', '--output', 'minimal'], rootDir);
  assert.notEqual(secondRun.status, 0);
  assert.match(String(secondRun.stderr), /Another orchestrator run is already active/);

  const firstResult = await firstRunDone;
  assert.equal(firstResult.code, 0, String(firstResult.stderr));

  await assert.rejects(
    fs.access(path.join(rootDir, 'docs', 'ops', 'automation', 'runtime', 'orchestrator.lock.json'))
  );
});

test('orchestrator still validates and completes when must-land work finishes on the last allowed session', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'last-session-validation': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker finished must-land scope on the last allowed session.',
            writeFiles: [{ path: 'src/last-session-validation.js', content: 'export const status = "done";\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:last-session-validation': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-last-session-validation.md'),
    directFuturePlan({ planId: 'last-session-validation', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed last-session-validation plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--max-sessions-per-plan', '1', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const completedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-17-last-session-validation.md'),
    'utf8'
  );
  assert.match(completedPlan, /^Status: completed$/m);
  assert.doesNotMatch(completedPlan, /^Status: budget-exhausted$/m);
});

test('orchestrator atomic commits include same-slice touched files outside declared roots', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'atomic-touched-files': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker delivered the slice plus adjacent regression coverage.',
            writeFiles: [
              { path: 'src/atomic-touched-files.js', content: 'export const delivered = true;\n' },
              { path: 'tests/atomic-touched-files.test.js', content: 'export const covered = true;\n' }
            ],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:atomic-touched-files': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-atomic-touched-files.md'),
    directFuturePlan({ planId: 'atomic-touched-files', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed atomic touched-files plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const completedPlan = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'completed', '2026-03-17-atomic-touched-files.md'),
    'utf8'
  );
  assert.match(completedPlan, /^Status: completed$/m);

  const cleanStatus = spawnSync('git', ['status', '--short'], { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' });
  assert.equal(cleanStatus.status, 0);
  assert.equal(String(cleanStatus.stdout).trim(), '');

  const latestCommit = spawnSync('git', ['show', '--stat', '--oneline', '--max-count', '1'], {
    cwd: rootDir,
    stdio: 'pipe',
    encoding: 'utf8'
  });
  assert.equal(latestCommit.status, 0);
  assert.match(String(latestCommit.stdout), /complete atomic-touched-files/);
  assert.match(String(latestCommit.stdout), /tests\/atomic-touched-files\.test\.js/);
});

test('orchestrator commits per-plan active evidence without leaking it into the next slice', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'first-slice': {
        worker: [
          {
            status: 'completed',
            summary: 'First slice delivered.',
            writeFiles: [{ path: 'src/first-slice.js', content: 'export const first = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      },
      'second-slice': {
        worker: [
          {
            status: 'completed',
            summary: 'Second slice delivered.',
            writeFiles: [{ path: 'src/second-slice.js', content: 'export const second = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:first-slice': [
        {
          status: 'passed',
          summary: 'Always validation passed for first slice.'
        }
      ],
      'always:second-slice': [
        {
          status: 'passed',
          summary: 'Always validation passed for second slice.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-first-slice.md'),
    directFuturePlan({ planId: 'first-slice', riskTier: 'low' }),
    'utf8'
  );
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-second-slice.md'),
    directFuturePlan({ planId: 'second-slice', riskTier: 'low' }),
    'utf8'
  );
  await writeActiveEvidence(rootDir, 'first-slice');
  spawnSync('git', ['add', '.'], { cwd: rootDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'docs: seed sequential-slice fixture'], { cwd: rootDir, stdio: 'pipe' });

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'minimal'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));

  const evidence = await fs.readFile(
    path.join(rootDir, 'docs', 'exec-plans', 'active', 'evidence', 'first-slice.md'),
    'utf8'
  );
  assert.match(evidence, /docs\/exec-plans\/completed\/2026-03-17-first-slice\.md/);

  const history = spawnSync('git', ['log', '--oneline', '--max-count', '3'], { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' });
  assert.equal(history.status, 0);
  assert.match(String(history.stdout), /complete first-slice/);
  assert.match(String(history.stdout), /complete second-slice/);
});

test('orchestrator pretty output keeps readable lifecycle lines', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'pretty-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Pretty output plan delivered.',
            writeFiles: [{ path: 'src/pretty-plan.js', content: 'export const pretty = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:pretty-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed for pretty plan.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-pretty-plan.md'),
    directFuturePlan({ planId: 'pretty-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed pretty lifecycle plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'pretty'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), / RUN /);
  assert.match(String(result.stdout), /GRIND OVERVIEW/);
  assert.match(String(result.stdout), /plan start/);
  assert.match(String(result.stdout), /promoted pretty-plan/);
  assert.match(String(result.stdout), /session start/);
  assert.match(String(result.stdout), /plan\s+=\s+pretty-plan/);
  assert.match(String(result.stdout), /file activity/);
  assert.match(String(result.stdout), /session artifacts/);
  assert.match(String(result.stdout), /phase\s+=\s+session/);
  assert.match(String(result.stdout), /GRIND SUMMARY/);
});

test('orchestrator ticker output keeps compact lifecycle lines', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'ticker-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Ticker output plan delivered.',
            writeFiles: [{ path: 'src/ticker-plan.js', content: 'export const ticker = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:ticker-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed for ticker plan.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-ticker-plan.md'),
    directFuturePlan({ planId: 'ticker-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed ticker lifecycle plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'ticker'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} grind runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} grind overview runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} plan start plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} session start plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} file activity phase=session plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} session artifacts plan=ticker-plan/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} grind summary runId=/);
  assert.match(String(result.stdout), /\[ticker\] \d{2}:\d{2}:\d{2} committed ticker-plan/);
});

test('orchestrator ticker output keeps compact lifecycle logs visible', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'ticker-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker delivered ticker plan.',
            writeFiles: [{ path: 'src/ticker-plan.js', content: 'export const ticker = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:ticker-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-ticker-plan.md'),
    directFuturePlan({ planId: 'ticker-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed ticker visible lifecycle plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'ticker'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /\[ticker\]/);
  assert.match(String(result.stdout), /queue focus runId=/);
  assert.match(String(result.stdout), /plan start plan=ticker-plan/);
  assert.match(String(result.stdout), /promoted ticker-plan/);
  assert.match(String(result.stdout), /session start plan=ticker-plan/);
});

test('orchestrator pretty output keeps readable tagged lifecycle logs in non-tty runs', async () => {
  const rootDir = await createTemplateRepo();
  await configureFixtureRepo(rootDir, {
    providerActions: {
      'pretty-plan': {
        worker: [
          {
            status: 'completed',
            summary: 'Worker delivered pretty plan.',
            writeFiles: [{ path: 'src/pretty-plan.js', content: 'export const pretty = true;\n' }],
            plan: {
              checkMustLand: true
            }
          }
        ]
      }
    },
    validation: {
      'always:pretty-plan': [
        {
          status: 'passed',
          summary: 'Always validation passed.'
        }
      ]
    }
  });
  await fs.writeFile(
    path.join(rootDir, 'docs', 'future', '2026-03-17-pretty-plan.md'),
    directFuturePlan({ planId: 'pretty-plan', riskTier: 'low' }),
    'utf8'
  );
  commitFixtureChanges(rootDir, 'docs: seed pretty tagged lifecycle plan');

  const result = runNode(
    path.join(rootDir, 'scripts', 'automation', 'orchestrator.mjs'),
    ['grind', '--max-risk', 'low', '--output', 'pretty'],
    rootDir
  );
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), / RUN /);
  assert.match(String(result.stdout), /GRIND OVERVIEW/);
  assert.match(String(result.stdout), /plan start/);
  assert.match(String(result.stdout), /session start/);
  assert.match(String(result.stdout), /plan\s+=\s+pretty-plan/);
  assert.match(String(result.stdout), /file activity/);
  assert.match(String(result.stdout), /session artifacts/);
  assert.match(String(result.stdout), /phase\s+=\s+session/);
  assert.match(String(result.stdout), /GRIND SUMMARY/);
});
