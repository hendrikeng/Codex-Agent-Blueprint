#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const configPath = path.join(rootDir, 'docs/governance/architecture-rules.json');

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?/gm;
const EXPORT_RE = /^\s*export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?/gm;

function fail(message) {
  console.error(`[architecture-verify] ${message}`);
  process.exit(1);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(relPath) {
  const abs = path.join(rootDir, relPath);
  const raw = await fs.readFile(abs, 'utf8');
  return JSON.parse(raw);
}

function findBoundaryRule(eslintConfig) {
  for (const override of eslintConfig.overrides ?? []) {
    const rule = override?.rules?.['@nx/enforce-module-boundaries'];
    if (Array.isArray(rule) && rule.length >= 2 && typeof rule[1] === 'object') {
      return rule[1];
    }
  }

  return null;
}

function runRg(pattern, absDir, globs = ['*.ts', '*.tsx']) {
  const args = ['-n', '--pcre2'];
  for (const glob of globs) {
    args.push('--glob', glob);
  }
  args.push(pattern, absDir);

  const result = spawnSync('rg', args, { encoding: 'utf8' });

  if (result.status === 1) {
    return '';
  }

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `rg failed with exit code ${result.status}`);
  }

  return result.stdout.trim();
}

async function checkNxDependencyConstraints(check, violations) {
  const eslintConfig = await readJson(check.eslintConfigPath ?? '.eslintrc.base.json');
  const boundaryRule = findBoundaryRule(eslintConfig);

  if (!boundaryRule) {
    violations.push({
      code: 'ARCH_MISSING_NX_BOUNDARY_RULE',
      message: `Could not find '@nx/enforce-module-boundaries' in ${check.eslintConfigPath ?? '.eslintrc.base.json'}`,
      file: check.eslintConfigPath ?? '.eslintrc.base.json'
    });
    return;
  }

  const depConstraints = boundaryRule.depConstraints;
  if (!Array.isArray(depConstraints) || depConstraints.length === 0) {
    violations.push({
      code: 'ARCH_EMPTY_NX_DEP_CONSTRAINTS',
      message: 'No dependency constraints found for @nx/enforce-module-boundaries',
      file: check.eslintConfigPath ?? '.eslintrc.base.json'
    });
    return;
  }

  const bySourceTag = new Map();
  for (const constraint of depConstraints) {
    if (constraint?.sourceTag && Array.isArray(constraint.onlyDependOnLibsWithTags)) {
      bySourceTag.set(constraint.sourceTag, new Set(constraint.onlyDependOnLibsWithTags));
    }
  }

  for (const required of check.requiredConstraints ?? []) {
    const sourceTag = required.sourceTag;
    const allowed = bySourceTag.get(sourceTag);
    if (!allowed) {
      violations.push({
        code: 'ARCH_MISSING_REQUIRED_CONSTRAINT',
        message: `Missing dep constraint for source tag '${sourceTag}'`,
        file: check.eslintConfigPath ?? '.eslintrc.base.json'
      });
      continue;
    }

    for (const targetTag of required.allow ?? []) {
      if (!allowed.has(targetTag)) {
        violations.push({
          code: 'ARCH_MISSING_ALLOWED_TAG',
          message: `Constraint '${sourceTag}' must allow '${targetTag}'`,
          file: check.eslintConfigPath ?? '.eslintrc.base.json'
        });
      }
    }
  }
}

async function checkRequiredProjectTags(check, violations) {
  for (const project of check.projects ?? []) {
    const relPath = project.path;
    const absPath = path.join(rootDir, relPath);

    if (!(await exists(absPath))) {
      violations.push({
        code: 'ARCH_MISSING_PROJECT_FILE',
        message: `Missing project file: ${relPath}`,
        file: relPath
      });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(absPath, 'utf8'));
    } catch (error) {
      violations.push({
        code: 'ARCH_INVALID_PROJECT_JSON',
        message: `Invalid JSON in ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
        file: relPath
      });
      continue;
    }

    const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    for (const requiredTag of project.requiredTags ?? []) {
      if (!tags.includes(requiredTag)) {
        violations.push({
          code: 'ARCH_MISSING_PROJECT_TAG',
          message: `Project '${relPath}' must include tag '${requiredTag}'`,
          file: relPath
        });
      }
    }
  }
}

async function walkTsFiles(baseDir) {
  const files = [];

  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') {
        continue;
      }

      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(nextPath);
      }
    }
  }

  await walk(baseDir);
  return files;
}

function collectImportSpecifiers(content) {
  const values = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    values.push(match[1]);
  }
  for (const match of content.matchAll(EXPORT_RE)) {
    values.push(match[1]);
  }
  return values;
}

async function resolveRelativeImport(sourceAbs, specifier) {
  const sourceDir = path.dirname(sourceAbs);
  const initial = path.resolve(sourceDir, specifier);
  const candidateBases = [];

  if (path.extname(initial)) {
    candidateBases.push(initial);
    if (initial.endsWith('.js')) {
      candidateBases.push(initial.slice(0, -3));
    }
  } else {
    candidateBases.push(initial);
  }

  const candidates = [];
  for (const base of candidateBases) {
    candidates.push(base);
    candidates.push(`${base}.ts`);
    candidates.push(`${base}.tsx`);
    candidates.push(path.join(base, 'index.ts'));
    candidates.push(path.join(base, 'index.tsx'));
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function layerOf(fileRel) {
  if (fileRel.includes('/dto/') || fileRel.endsWith('.dto.ts')) {
    return 'dto';
  }
  if (fileRel.endsWith('.controller.ts') || fileRel.endsWith('.module.ts')) {
    return 'runtime';
  }
  if (
    fileRel.endsWith('.repo.ts') ||
    fileRel.endsWith('.repository.ts') ||
    fileRel.includes('/repo/') ||
    fileRel.includes('/repositories/')
  ) {
    return 'repo';
  }
  if (fileRel.endsWith('.config.ts') || fileRel.includes('/config/')) {
    return 'config';
  }
  if (fileRel.endsWith('.types.ts') || fileRel.includes('/types/')) {
    return 'types';
  }
  if (fileRel.endsWith('.service.ts')) {
    return 'service';
  }
  return 'service';
}

function moduleNameOf(fileRel, moduleRootPrefix) {
  if (!fileRel.startsWith(moduleRootPrefix)) {
    return null;
  }

  const rest = fileRel.slice(moduleRootPrefix.length);
  return rest.split('/')[0] ?? null;
}

function domainLookup(domainModules) {
  const lookup = new Map();
  for (const [domain, modules] of Object.entries(domainModules)) {
    for (const moduleName of modules) {
      lookup.set(moduleName, domain);
    }
  }
  return lookup;
}

function isAllowedPrefix(targetRel, prefixes) {
  return prefixes.some((prefix) => targetRel.startsWith(prefix));
}

function addLayerCoverage(map, moduleName, layer) {
  const existing = map.get(moduleName) ?? new Set();
  existing.add(layer);
  map.set(moduleName, existing);
}

function isDomainImportAllowed(sourceDomain, targetDomain, allowDomainImports) {
  if (sourceDomain === targetDomain) {
    return true;
  }

  const explicit = allowDomainImports[sourceDomain] ?? [];
  return explicit.includes(targetDomain);
}

function isLayerImportAllowed(sourceLayer, targetLayer, allowLayerImports) {
  const allowed = allowLayerImports[sourceLayer] ?? [];
  return allowed.includes(targetLayer);
}

async function checkRelativeImportGraph(check, violations, info) {
  const sourceRoot = check.sourceRoot;
  const sourceRootAbs = path.join(rootDir, sourceRoot);

  if (!(await exists(sourceRootAbs))) {
    violations.push({
      code: 'ARCH_MISSING_SOURCE_ROOT',
      message: `Missing sourceRoot for relative import graph: ${sourceRoot}`,
      file: sourceRoot
    });
    return;
  }

  const files = await walkTsFiles(sourceRootAbs);
  const moduleRootPrefix = `${toPosix(sourceRoot).replace(/\/$/, '')}/`;
  const domainByModule = domainLookup(check.domainModules ?? {});
  const moduleLayerCoverage = new Map();
  let checkedImports = 0;

  for (const sourceAbs of files) {
    const sourceRel = toPosix(path.relative(rootDir, sourceAbs));
    const sourceModule = moduleNameOf(sourceRel, moduleRootPrefix);
    const sourceDomain = sourceModule ? domainByModule.get(sourceModule) : null;
    const sourceLayer = layerOf(sourceRel);

    if (sourceModule) {
      addLayerCoverage(moduleLayerCoverage, sourceModule, sourceLayer);
    }

    const content = await fs.readFile(sourceAbs, 'utf8');
    const specifiers = collectImportSpecifiers(content).filter((value) => value.startsWith('.'));

    for (const specifier of specifiers) {
      checkedImports += 1;
      const targetAbs = await resolveRelativeImport(sourceAbs, specifier);
      if (!targetAbs) {
        violations.push({
          code: 'ARCH_UNRESOLVED_IMPORT',
          message: `Unresolved relative import '${specifier}'`,
          file: sourceRel
        });
        continue;
      }

      const targetRel = toPosix(path.relative(rootDir, targetAbs));

      if (!targetRel.startsWith(moduleRootPrefix)) {
        if (!isAllowedPrefix(targetRel, check.allowCrossCuttingPrefixes ?? [])) {
          violations.push({
            code: 'ARCH_OUT_OF_BOUNDARY_IMPORT',
            message: `Import exits module boundary without allowlist: ${specifier} -> ${targetRel}`,
            file: sourceRel
          });
        }
        continue;
      }

      const targetModule = moduleNameOf(targetRel, moduleRootPrefix);
      const targetDomain = targetModule ? domainByModule.get(targetModule) : null;
      const targetLayer = layerOf(targetRel);

      if (!sourceDomain || !targetDomain) {
        violations.push({
          code: 'ARCH_UNKNOWN_DOMAIN',
          message: `Unknown domain mapping for import ${specifier} -> ${targetRel}`,
          file: sourceRel
        });
        continue;
      }

      if (!isDomainImportAllowed(sourceDomain, targetDomain, check.allowDomainImports ?? {})) {
        violations.push({
          code: 'ARCH_CROSS_DOMAIN_IMPORT',
          message: `Disallowed cross-domain import ${sourceDomain} -> ${targetDomain}: ${targetRel}`,
          file: sourceRel
        });
      }

      if (!isLayerImportAllowed(sourceLayer, targetLayer, check.allowLayerImports ?? {})) {
        violations.push({
          code: 'ARCH_LAYER_IMPORT',
          message: `Disallowed layer import ${sourceLayer} -> ${targetLayer}: ${targetRel}`,
          file: sourceRel
        });
      }
    }
  }

  for (const [domain, requiredLayers] of Object.entries(check.requiredLayerCoverageByDomain ?? {})) {
    const domainModules = (check.domainModules ?? {})[domain] ?? [];
    const covered = new Set();

    for (const moduleName of domainModules) {
      const moduleCoverage = moduleLayerCoverage.get(moduleName) ?? new Set();
      for (const layer of moduleCoverage) {
        covered.add(layer);
      }
    }

    for (const layer of requiredLayers) {
      if (!covered.has(layer)) {
        violations.push({
          code: 'ARCH_MISSING_DOMAIN_LAYER',
          message: `Domain '${domain}' is missing required layer '${layer}'`,
          file: sourceRoot
        });
      }
    }
  }

  info.push(`Relative import graph files analyzed: ${files.length}`);
  info.push(`Relative import graph imports analyzed: ${checkedImports}`);
}

async function checkForbiddenImportPatterns(check, violations) {
  for (const rule of check.checks ?? []) {
    const absDir = path.join(rootDir, rule.sourceDir);
    if (!fsSync.existsSync(absDir) || !fsSync.statSync(absDir).isDirectory()) {
      continue;
    }

    const matches = runRg(rule.pattern, absDir, rule.globs ?? ['*.ts', '*.tsx']);
    if (matches) {
      violations.push({
        code: 'ARCH_FORBIDDEN_IMPORT_PATTERN',
        message: `${rule.label}\n${matches}`,
        file: rule.sourceDir
      });
    }
  }
}

async function checkCommandHook(check, violations) {
  const command = Array.isArray(check.command) ? [...check.command] : [];
  if (command.length === 0) {
    violations.push({
      code: 'ARCH_INVALID_COMMAND_HOOK',
      message: 'command_hook requires a non-empty command array',
      file: configPath
    });
    return;
  }

  if (command[0] === '$NODE') {
    command[0] = process.execPath;
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    violations.push({
      code: 'ARCH_COMMAND_HOOK_FAILED',
      message: `Command hook failed: ${command.join(' ')}`,
      file: check.label ?? 'command_hook'
    });
  }
}

function formatViolation(violation) {
  return `- [${violation.code}] ${violation.message} (${violation.file})`;
}

try {
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  const violations = [];
  const info = [];

  for (const check of config.checks ?? []) {
    if (!check || typeof check !== 'object') {
      continue;
    }

    if (check.type === 'nx_dep_constraints') {
      await checkNxDependencyConstraints(check, violations);
      continue;
    }

    if (check.type === 'required_project_tags') {
      await checkRequiredProjectTags(check, violations);
      continue;
    }

    if (check.type === 'relative_import_graph') {
      await checkRelativeImportGraph(check, violations, info);
      continue;
    }

    if (check.type === 'forbidden_import_patterns_rg') {
      await checkForbiddenImportPatterns(check, violations);
      continue;
    }

    if (check.type === 'command_hook') {
      await checkCommandHook(check, violations);
      continue;
    }

    violations.push({
      code: 'ARCH_UNKNOWN_CHECK_TYPE',
      message: `Unknown architecture check type: ${String(check.type)}`,
      file: configPath
    });
  }

  console.log('[architecture-verify] Architecture dependency check');
  for (const line of info) {
    console.log(`- ${line}`);
  }

  if (violations.length > 0) {
    console.error(`\nViolations (${violations.length}):`);
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    process.exit(1);
  }

  console.log('\n[architecture-verify] passed');
} catch (error) {
  fail(error instanceof Error ? error.stack : String(error));
}
