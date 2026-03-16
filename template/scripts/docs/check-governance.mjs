#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runGovernanceAnalysis } from './lib/governance-core.mjs';
import { resolveRepoOrAbsolutePath } from '../automation/lib/orchestrator-shared.mjs';

const rootDir = process.cwd();
const configPath = path.join(rootDir, 'docs/governance/doc-checks.config.json');
const staleDays = process.env.DOC_STALE_DAYS ? Number(process.env.DOC_STALE_DAYS) : null;
const resultPath = String(process.env.ORCH_VALIDATION_RESULT_PATH ?? '').trim();

if (staleDays !== null && (!Number.isInteger(staleDays) || staleDays <= 0)) {
  console.error('[docs-verify] DOC_STALE_DAYS must be a positive integer.');
  process.exit(1);
}

function formatFinding(finding) {
  if (finding.file) {
    return `- [${finding.code}] ${finding.message} (${finding.file})`;
  }
  return `- [${finding.code}] ${finding.message}`;
}

async function writeValidationResult(payload) {
  if (!resultPath) {
    return;
  }
  const absPath = resolveRepoOrAbsolutePath(rootDir, resultPath)?.abs;
  if (!absPath) {
    return;
  }
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true }).catch(() => {});
  await fs.promises.writeFile(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

try {
  const result = await runGovernanceAnalysis({
    rootDir,
    configPath,
    now: new Date(),
    staleDaysOverride: staleDays
  });

  console.log('[docs-verify] Doc governance check');
  console.log(`- Markdown files analyzed: ${result.stats.markdownFilesAnalyzed}`);
  console.log(`- Docs files analyzed: ${result.stats.docFilesAnalyzed}`);
  console.log(`- Active plans analyzed: ${result.stats.activePlansAnalyzed}`);

  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    for (const warning of result.warnings) {
      console.log(formatFinding(warning));
    }
  }

  if (result.errors.length > 0) {
    await writeValidationResult({
      validationId: process.env.ORCH_VALIDATION_ID || 'docs:governance',
      type: process.env.ORCH_VALIDATION_TYPE || 'contract',
      status: 'failed',
      summary: `Doc governance failed with ${result.errors.length} error(s).`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      findingFiles: result.errors.map((entry) => entry.file).filter(Boolean),
      evidenceRefs: [],
      artifactRefs: []
    });
    console.error(`\nErrors (${result.errors.length}):`);
    for (const error of result.errors) {
      console.error(formatFinding(error));
    }
    process.exit(1);
  }

  await writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'docs:governance',
    type: process.env.ORCH_VALIDATION_TYPE || 'contract',
    status: 'passed',
    summary: 'Doc governance passed.',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  });
  console.log('\n[docs-verify] passed');
} catch (error) {
  await writeValidationResult({
    validationId: process.env.ORCH_VALIDATION_ID || 'docs:governance',
    type: process.env.ORCH_VALIDATION_TYPE || 'contract',
    status: 'failed',
    summary: error instanceof Error ? error.message : String(error),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findingFiles: [],
    evidenceRefs: [],
    artifactRefs: []
  });
  console.error('[docs-verify] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
