#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const sourceManifestPath = path.join(rootDir, 'distribution', 'harness-ownership-manifest.json');
const sourceManifestId = toPosix(path.relative(rootDir, sourceManifestPath));
const defaultDownstreamManifestRel = path.join('docs', 'ops', 'automation', 'harness-manifest.json');

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
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

function usage() {
  process.stderr.write(
    'Usage: node ./scripts/harness-sync.mjs <install|update|drift> --target <path> [--json true|false]\n'
  );
}

function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function walkFiles(baseDir, currentDir = baseDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(baseDir, absPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push(absPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function normalizePattern(value) {
  return toPosix(String(value ?? '').trim()).replace(/^\.?\//, '');
}

function matchesExcludePattern(relativePath, pattern) {
  const normalizedPath = normalizePattern(relativePath);
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern === '**' || normalizedPattern === '**/*') {
    return true;
  }
  if (typeof path.posix.matchesGlob === 'function') {
    return path.posix.matchesGlob(normalizedPath, normalizedPattern);
  }
  return normalizedPath === normalizedPattern || normalizedPath.endsWith(`/${normalizedPattern}`);
}

function matchesManagedPattern(relativePath, pattern) {
  return matchesExcludePattern(relativePath, pattern);
}

function isExcluded(relativePath, manifest) {
  const patterns = Array.isArray(manifest?.excludeGlobs) ? manifest.excludeGlobs : [];
  return patterns.some((pattern) => matchesExcludePattern(relativePath, pattern));
}

function isManaged(relativePath, manifest) {
  const patterns = Array.isArray(manifest?.managedGlobs) && manifest.managedGlobs.length > 0
    ? manifest.managedGlobs
    : ['**/*'];
  return patterns.some((pattern) => matchesManagedPattern(relativePath, pattern));
}

async function sha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

function gitHeadRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) {
    return null;
  }
  const value = String(result.stdout ?? '').trim();
  return value || null;
}

async function collectSourceFiles(manifest) {
  const sourceRoot = path.join(rootDir, manifest.sourceRoot);
  const targetRoot = String(manifest.targetRoot ?? '.').trim() || '.';
  const files = await walkFiles(sourceRoot);
  const entries = [];
  for (const absPath of files) {
    const relFromSource = toPosix(path.relative(sourceRoot, absPath));
    if (!isManaged(relFromSource, manifest)) {
      continue;
    }
    if (isExcluded(relFromSource, manifest)) {
      continue;
    }
    const stat = await fs.stat(absPath);
    entries.push({
      sourcePath: toPosix(path.relative(rootDir, absPath)),
      targetPath: toPosix(path.join(targetRoot, relFromSource)),
      sha256: await sha256(absPath),
      size: stat.size
    });
  }
  return entries;
}

function downstreamManifestRel(manifest) {
  return String(manifest?.downstreamManifestPath ?? defaultDownstreamManifestRel).trim() || defaultDownstreamManifestRel;
}

async function loadDownstreamManifest(targetDir, manifest) {
  const filePath = path.join(targetDir, downstreamManifestRel(manifest));
  try {
    return {
      exists: true,
      valid: true,
      filePath,
      manifest: await readJson(filePath)
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        valid: false,
        filePath,
        manifest: null,
        errorCode: 'ENOENT',
        error
      };
    }
    return {
      exists: true,
      valid: false,
      filePath,
      manifest: null,
      errorCode: error?.code ?? 'INVALID_JSON',
      error
    };
  }
}

function isCompatibleSourceManifestRef(value) {
  const normalized = toPosix(String(value ?? '').trim());
  if (!normalized) {
    return false;
  }
  return normalized === sourceManifestId || normalized.endsWith(`/${sourceManifestId}`);
}

function validateDownstreamManifest(manifestState, sourceManifest) {
  if (!manifestState?.exists) {
    return {
      ok: false,
      code: 'DOWNSTREAM_MANIFEST_MISSING',
      message: `Missing downstream harness manifest at ${downstreamManifestRel(sourceManifest)}.`
    };
  }
  if (!manifestState.valid) {
    return {
      ok: false,
      code: 'DOWNSTREAM_MANIFEST_INVALID',
      message: `Invalid downstream harness manifest at ${downstreamManifestRel(sourceManifest)}.`
    };
  }

  const payload = manifestState.manifest;
  if (payload?.schemaVersion !== 1) {
    return {
      ok: false,
      code: 'DOWNSTREAM_MANIFEST_SCHEMA_MISMATCH',
      message: `Unsupported downstream harness manifest schema '${payload?.schemaVersion ?? 'unknown'}'.`
    };
  }
  if (payload?.ownershipMode !== sourceManifest.ownershipMode) {
    return {
      ok: false,
      code: 'DOWNSTREAM_MANIFEST_OWNERSHIP_MISMATCH',
      message: `Downstream harness manifest ownershipMode '${payload?.ownershipMode ?? 'unknown'}' does not match expected '${sourceManifest.ownershipMode}'.`
    };
  }
  if (!Array.isArray(payload?.managedFiles)) {
    return {
      ok: false,
      code: 'DOWNSTREAM_MANIFEST_MANAGED_FILES_INVALID',
      message: 'Downstream harness manifest must include a managedFiles array.'
    };
  }
  if (payload.sourceManifest && !isCompatibleSourceManifestRef(payload.sourceManifest)) {
    return {
      ok: false,
      code: 'DOWNSTREAM_MANIFEST_SOURCE_MISMATCH',
      message: `Downstream harness manifest source '${payload.sourceManifest}' does not reference '${sourceManifestId}'.`
    };
  }
  return { ok: true, manifest: payload };
}

async function compareTarget(targetDir, sourceEntries, installedManifest = null) {
  const missing = [];
  const modified = [];
  const managedSet = new Set();

  for (const entry of sourceEntries) {
    managedSet.add(entry.targetPath);
    const targetPath = path.join(targetDir, entry.targetPath);
    try {
      const targetHash = await sha256(targetPath);
      if (targetHash !== entry.sha256) {
        modified.push(entry.targetPath);
      }
    } catch {
      missing.push(entry.targetPath);
    }
  }

  const unexpectedManaged = [];
  for (const entry of installedManifest?.managedFiles ?? []) {
    const targetPath = String(entry?.targetPath ?? '').trim();
    if (!targetPath || managedSet.has(targetPath)) {
      continue;
    }
    unexpectedManaged.push(targetPath);
  }

  return {
    missing: missing.sort((left, right) => left.localeCompare(right)),
    modified: modified.sort((left, right) => left.localeCompare(right)),
    unexpectedManaged: unexpectedManaged.sort((left, right) => left.localeCompare(right))
  };
}

async function writeDownstreamManifest(targetDir, manifest, sourceEntries) {
  const downstreamManifestPath = path.join(targetDir, downstreamManifestRel(manifest));
  const payload = {
    schemaVersion: 1,
    ownershipMode: manifest.ownershipMode,
    sourceManifest: sourceManifestId,
    sourceManifestSha256: await sha256(sourceManifestPath),
    sourceRevision: gitHeadRevision(),
    installedAt: new Date().toISOString(),
    managedFiles: sourceEntries
  };
  await fs.mkdir(path.dirname(downstreamManifestPath), { recursive: true });
  await fs.writeFile(downstreamManifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function pruneEmptyDirectories(baseDir, directoryPath) {
  const normalizedBase = path.resolve(baseDir);
  let current = directoryPath;
  while (current.startsWith(normalizedBase) && current !== normalizedBase) {
    let entries = [];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    await fs.rmdir(current).catch(() => {});
    current = path.dirname(current);
  }
}

async function removeRetiredManagedFiles(targetDir, sourceEntries, installedManifest) {
  const currentManaged = new Set(sourceEntries.map((entry) => entry.targetPath));
  const removed = [];
  for (const entry of installedManifest?.managedFiles ?? []) {
    const targetPathRel = toPosix(String(entry?.targetPath ?? '').trim());
    if (!targetPathRel || currentManaged.has(targetPathRel)) {
      continue;
    }
    const targetPathAbs = path.join(targetDir, targetPathRel);
    await fs.rm(targetPathAbs, { force: true }).catch(() => {});
    await pruneEmptyDirectories(targetDir, path.dirname(targetPathAbs));
    removed.push(targetPathRel);
  }
  return removed.sort((left, right) => left.localeCompare(right));
}

async function installOrUpdate(targetDir, manifest, sourceEntries, installedManifest = null) {
  const removed = await removeRetiredManagedFiles(targetDir, sourceEntries, installedManifest);
  const copied = [];
  for (const entry of sourceEntries) {
    const sourcePath = path.join(rootDir, entry.sourcePath);
    const targetPath = path.join(targetDir, entry.targetPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    copied.push(entry.targetPath);
  }
  await writeDownstreamManifest(targetDir, manifest, sourceEntries);
  return { copied, removed };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!['install', 'update', 'drift'].includes(command)) {
    usage();
    process.exit(1);
  }

  const targetDirRaw = String(options.target ?? '').trim();
  if (!targetDirRaw) {
    usage();
    process.exit(1);
  }

  const targetDir = path.resolve(targetDirRaw);
  const jsonOutput = asBoolean(options.json, false);
  const sourceManifest = await readJson(sourceManifestPath);
  const sourceEntries = await collectSourceFiles(sourceManifest);
  const manifestState = await loadDownstreamManifest(targetDir, sourceManifest);
  const installedManifest = manifestState.valid ? manifestState.manifest : null;
  const drift = await compareTarget(targetDir, sourceEntries, installedManifest);

  if (command === 'drift') {
    const payload = {
      command,
      target: targetDir,
      missing: drift.missing,
      modified: drift.modified,
      unexpectedManaged: drift.unexpectedManaged,
      driftDetected: drift.missing.length > 0 || drift.modified.length > 0 || drift.unexpectedManaged.length > 0
    };
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`[harness-sync] target=${payload.target}\n`);
      process.stdout.write(`[harness-sync] missing=${payload.missing.length} modified=${payload.modified.length} unexpectedManaged=${payload.unexpectedManaged.length}\n`);
    }
    process.exit(payload.driftDetected ? 2 : 0);
  }

  if (command === 'update') {
    const manifestValidation = validateDownstreamManifest(manifestState, sourceManifest);
    if (!manifestValidation.ok) {
      throw new Error(`[${manifestValidation.code}] ${manifestValidation.message}`);
    }
  }

  await fs.mkdir(targetDir, { recursive: true });
  const writeResult = await installOrUpdate(targetDir, sourceManifest, sourceEntries, installedManifest);
  const payload = {
    command,
    target: targetDir,
    filesCopied: writeResult.copied.length,
    filesRemoved: writeResult.removed.length,
    manifestPath: toPosix(path.join(targetDir, downstreamManifestRel(sourceManifest)))
  };
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[harness-sync] ${command} target=${payload.target} filesCopied=${payload.filesCopied} filesRemoved=${payload.filesRemoved}\n`
    );
  }
}

main().catch((error) => {
  process.stderr.write(`[harness-sync] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
