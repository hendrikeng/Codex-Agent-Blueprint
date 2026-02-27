#!/usr/bin/env node
import path from 'node:path';
import { runGovernanceAnalysis } from './lib/governance-core.mjs';

const rootDir = process.cwd();
const configPath = path.join(rootDir, 'docs/governance/doc-checks.config.json');
const staleDays = process.env.DOC_STALE_DAYS ? Number(process.env.DOC_STALE_DAYS) : null;

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
    console.error(`\nErrors (${result.errors.length}):`);
    for (const error of result.errors) {
      console.error(formatFinding(error));
    }
    process.exit(1);
  }

  console.log('\n[docs-verify] passed');
} catch (error) {
  console.error('[docs-verify] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
