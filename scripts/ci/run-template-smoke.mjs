#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const templateDir = path.join(rootDir, 'template');
const placeholderPattern = /\{\{([A-Z0-9_]+)\}\}/g;

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

async function collectFiles(baseDir) {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function replacementForToken(token) {
  const today = nowIsoDate();
  const specific = {
    PRODUCT: 'Smoke Harness',
    SUMMARY: 'Smoke-test fixture repository for the harness template.',
    DOC_OWNER: 'automation-smoke',
    LAST_UPDATED_ISO_DATE: today,
    CURRENT_STATE_DATE: today,
    FRONTEND_STACK: 'not applicable',
    BACKEND_STACK: 'node',
    DATA_STACK: 'json-files',
    SHARED_CONTRACT_STRATEGY: 'versioned json contracts',
    CRITICAL_DOMAIN_SET: 'automation state, plan transitions, validation outputs',
    SERVER_AUTHORITY_BOUNDARY_SET: 'orchestrator state mutation, validation gating',
    MONEY_AND_NUMERIC_RULE: 'not applicable',
    CODEOWNERS_DEFAULT_TEAM: '@smoke/platform',
    CODEOWNERS_SECURITY_TEAM: '@smoke/security',
    ESLINT_CONFIG_PATH: 'package.json',
    PROJECT_JSON_PATH_1: 'package.json',
    PROJECT_JSON_PATH_2: 'package.json',
    PROJECT_REQUIRED_TAG_1: 'scope:smoke',
    PROJECT_REQUIRED_TAG_2: 'type:app',
    SOURCE_TAG_1: 'scope:smoke',
    SOURCE_TAG_2: 'type:app',
    ALLOWED_TARGET_TAG_1A: 'scope:smoke',
    ALLOWED_TARGET_TAG_1B: 'type:shared',
    ALLOWED_TARGET_TAG_2A: 'scope:smoke',
    ALLOWED_TARGET_TAG_2B: 'type:app',
    GENERATED_AT_UTC_ISO: `${today}T00:00:00.000Z`,
    CONFORMANCE_SOURCE: 'scripts/ci/run-template-smoke.mjs',
    REPOSITORY_PROFILE_SNAKE_CASE: 'smoke_harness',
    CONFORMANCE_PURPOSE: 'template smoke verification',
    CI_WORKFLOW_PATH: '.github/workflows/ci.yml',
    EVAL_PROVIDER: 'stub',
    EVAL_MODEL_ID: 'smoke-model',
    EVAL_EVIDENCE_PATH_1: 'docs/generated/evals-report.json'
  };
  if (specific[token]) {
    return specific[token];
  }
  if (/^SCOPE\d+$/.test(token)) {
    return `smoke-scope-${token.slice(-1)}`;
  }
  if (/^(FRONTEND_ENTRYPOINT|BACKEND_ENTRYPOINT)_\d+$/.test(token)) {
    return 'src/index.js';
  }
  if (/^DOMAIN_INVARIANT_AREA_\d+$/.test(token)) {
    return `smoke invariant area ${token.slice(-1)}`;
  }
  if (/^DOMAIN_INVARIANT_\d+[A-Z]$/.test(token)) {
    return `smoke invariant ${token.toLowerCase()}`;
  }
  if (/^CRITICAL_FLOW_\d+$/.test(token)) {
    return `smoke critical flow ${token.slice(-1)}`;
  }
  if (/^SCORE_/.test(token)) {
    return '4';
  }
  if (/^QUALITY_GAP_\d+$/.test(token)) {
    return 'none';
  }
  if (/^OUT_OF_SCOPE_ITEM_\d+$/.test(token)) {
    return 'none';
  }
  return token.toLowerCase().replaceAll('_', '-');
}

async function replaceTemplatePlaceholders(repoDir) {
  const files = await collectFiles(repoDir);
  for (const filePath of files) {
    if (path.basename(filePath) === 'PLACEHOLDERS.md') {
      continue;
    }
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    if (!raw.includes('{{')) {
      continue;
    }
    const replaced = raw.replaceAll(placeholderPattern, (_, token) => replacementForToken(token));
    await fs.writeFile(filePath, replaced, 'utf8');
  }
}

async function writePackageJson(repoDir) {
  const fragmentPath = path.join(repoDir, 'package.scripts.fragment.json');
  const fragment = JSON.parse(await fs.readFile(fragmentPath, 'utf8'));
  const payload = {
    name: 'harness-template-smoke',
    private: true,
    version: '0.0.0-smoke',
    type: 'module',
    engines: {
      node: '>=24 <25'
    },
    scripts: {
      ...fragment.scripts
    }
  };
  await fs.writeFile(path.join(repoDir, 'package.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function assertPackageJsonDriftFails(repoDir) {
  const packageJsonPath = path.join(repoDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  packageJson.scripts['automation:run:parallel'] =
    'node ./scripts/automation/orchestrator.mjs run-parallel';
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const result = spawnSync('npm run harness:verify', {
    cwd: repoDir,
    shell: true,
    stdio: 'pipe',
    env: { ...process.env, CI: '1' }
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) === 0) {
    throw new Error('Expected harness:verify to fail when package.json contains retired scripts.');
  }
}

function runCommand(repoDir, command, extraEnv = {}) {
  console.log(`[template-smoke] ${command}`);
  const result = spawnSync(command, {
    cwd: repoDir,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Command failed (${result.status ?? 1}): ${command}`);
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-template-smoke-'));
  const repoDir = path.join(tempRoot, 'repo');
  await fs.cp(templateDir, repoDir, { recursive: true });
  await replaceTemplatePlaceholders(repoDir);
  await writePackageJson(repoDir);

  const commands = [
    'npm run harness:verify',
    'npm run plans:verify',
    'npm run context:compile',
    'npm run verify:fast'
  ];

  for (const command of commands) {
    runCommand(repoDir, command, { CI: '1' });
  }
  await assertPackageJsonDriftFails(repoDir);

  console.log(`[template-smoke] passed (${toPosix(repoDir)})`);
}

main().catch((error) => {
  console.error('[template-smoke] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
