#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inferPlanId,
  metadataValue,
  parseMetadata,
  parsePlanId
} from '../automation/lib/plan-metadata.mjs';

const LINK_REGEX = /\[[^\]]*\]\(([^)]+)\)/g;
const INLINE_CODE_REGEX = /`([^`]+)`/g;
const PLAN_PATH_REGEX = /^docs\/exec-plans\/(?:active|completed)\/.+\.md$/;
const RUNTIME_CONTACT_PATH_REGEX = /^docs\/ops\/automation\/runtime\/contacts\/run-[^/]+\/.+\.md$/;
const RUNTIME_ARTIFACT_PATH_REGEX = /^docs\/ops\/automation\/runtime\/run-[^/]+\/.+$/;
const RUNTIME_CONTACT_FALLBACK_PATH = 'docs/ops/automation/README.md';

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? '').trim();
    if (token === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

function normalizeRef(rawRef, sourceFile) {
  const trimmed = String(rawRef ?? '').trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) {
    return null;
  }

  const noHash = trimmed.split('#')[0]?.split('?')[0] ?? '';
  if (!noHash) {
    return null;
  }

  if (noHash.startsWith('/')) {
    return toPosix(noHash.slice(1));
  }

  if (/^(?:AGENTS\.md|README\.md|ARCHITECTURE\.md|docs\/)/.test(noHash)) {
    return toPosix(path.posix.normalize(noHash));
  }

  const sourceDir = path.posix.dirname(sourceFile);
  return toPosix(path.posix.normalize(path.posix.join(sourceDir, noHash)));
}

function splitRefSuffix(rawRef) {
  const value = String(rawRef ?? '');
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  let splitIndex = -1;

  if (hashIndex >= 0 && queryIndex >= 0) {
    splitIndex = Math.min(hashIndex, queryIndex);
  } else if (hashIndex >= 0) {
    splitIndex = hashIndex;
  } else if (queryIndex >= 0) {
    splitIndex = queryIndex;
  }

  if (splitIndex < 0) {
    return { base: value, suffix: '' };
  }

  return {
    base: value.slice(0, splitIndex),
    suffix: value.slice(splitIndex)
  };
}

function rewriteRawReference(rawRef, sourceFile, targetRef) {
  const { base, suffix } = splitRefSuffix(rawRef);
  if (base.startsWith('/')) {
    return `/${targetRef}${suffix}`;
  }
  if (base.startsWith('docs/')) {
    return `${targetRef}${suffix}`;
  }

  const sourceDir = path.posix.dirname(sourceFile);
  let relative = toPosix(path.posix.relative(sourceDir, targetRef));
  if (!relative.startsWith('.') && base.startsWith('./')) {
    relative = `./${relative}`;
  }
  return `${relative}${suffix}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkMarkdownFiles(baseDir) {
  const results = [];

  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') {
        continue;
      }

      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(nextPath);
      }
    }
  }

  await walk(baseDir);
  return results;
}

function inferPlanIdFromPlanPath(planPath) {
  let base = path.posix.basename(planPath, '.md');
  base = base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  base = base.replace(/-\d{11,}$/, '');
  return parsePlanId(base, null);
}

function classifyRepairableReference(normalizedRef) {
  if (PLAN_PATH_REGEX.test(normalizedRef)) {
    return 'plan';
  }
  if (RUNTIME_CONTACT_PATH_REGEX.test(normalizedRef)) {
    return 'runtime-contact';
  }
  if (RUNTIME_ARTIFACT_PATH_REGEX.test(normalizedRef)) {
    return 'runtime-artifact';
  }
  return null;
}

async function loadPlanCatalog(rootDir) {
  const activeDir = path.join(rootDir, 'docs/exec-plans/active');
  const completedDir = path.join(rootDir, 'docs/exec-plans/completed');
  const planById = new Map();
  const existingPaths = new Set();

  async function readPlanDirectory(directoryAbs, phase) {
    let entries = [];
    try {
      entries = await fs.readdir(directoryAbs, { withFileTypes: true });
    } catch {
      return [];
    }

    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'readme.md') {
        continue;
      }
      const abs = path.join(directoryAbs, entry.name);
      const rel = toPosix(path.relative(rootDir, abs));
      const content = await fs.readFile(abs, 'utf8');
      const metadata = parseMetadata(content);
      const parsedPlanId = parsePlanId(metadataValue(metadata, 'Plan-ID'), null) ?? inferPlanId(content, abs);
      if (!parsedPlanId) {
        continue;
      }

      const stat = await fs.stat(abs);
      records.push({
        phase,
        planId: parsedPlanId,
        relPath: rel,
        mtimeMs: stat.mtimeMs
      });
      existingPaths.add(rel);
    }

    return records;
  }

  const active = await readPlanDirectory(activeDir, 'active');
  const completed = await readPlanDirectory(completedDir, 'completed');
  const all = [...active, ...completed];
  all.sort((a, b) => {
    if (a.phase !== b.phase) {
      return a.phase === 'active' ? -1 : 1;
    }
    if (a.mtimeMs !== b.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return a.relPath.localeCompare(b.relPath);
  });

  for (const record of all) {
    if (!planById.has(record.planId)) {
      planById.set(record.planId, record.relPath);
    }
  }

  return { planById, existingPaths };
}

function collectReferenceTokens(content, sourceFile) {
  const collected = [];

  for (const match of content.matchAll(LINK_REGEX)) {
    const raw = match[1];
    const normalized = normalizeRef(raw, sourceFile);
    const kind = normalized ? classifyRepairableReference(normalized) : null;
    if (!normalized || !kind) {
      continue;
    }
    collected.push({ raw, normalized, kind });
  }

  for (const match of content.matchAll(INLINE_CODE_REGEX)) {
    const raw = match[1];
    const normalized = normalizeRef(raw, sourceFile);
    const kind = normalized ? classifyRepairableReference(normalized) : null;
    if (!normalized || !kind) {
      continue;
    }
    collected.push({ raw, normalized, kind });
  }

  return collected;
}

function applyRewrites(content, rewrites) {
  let replacements = 0;
  let planReplacements = 0;
  let runtimeContactReplacements = 0;
  let runtimeArtifactReplacements = 0;
  let updated = content.replace(LINK_REGEX, (fullMatch, rawRef) => {
    const rewrite = rewrites.get(rawRef);
    if (!rewrite || rewrite.target === rawRef) {
      return fullMatch;
    }
    replacements += 1;
    if (rewrite.kind === 'plan') {
      planReplacements += 1;
    } else if (rewrite.kind === 'runtime-contact') {
      runtimeContactReplacements += 1;
    } else if (rewrite.kind === 'runtime-artifact') {
      runtimeArtifactReplacements += 1;
    }
    return fullMatch.replace(`(${rawRef})`, `(${rewrite.target})`);
  });

  updated = updated.replace(INLINE_CODE_REGEX, (fullMatch, rawRef) => {
    const rewrite = rewrites.get(rawRef);
    if (!rewrite || rewrite.target === rawRef) {
      return fullMatch;
    }
    replacements += 1;
    if (rewrite.kind === 'plan') {
      planReplacements += 1;
    } else if (rewrite.kind === 'runtime-contact') {
      runtimeContactReplacements += 1;
    } else if (rewrite.kind === 'runtime-artifact') {
      runtimeArtifactReplacements += 1;
    }
    return `\`${rewrite.target}\``;
  });

  return {
    content: updated,
    replacements,
    planReplacements,
    runtimeContactReplacements,
    runtimeArtifactReplacements
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const docsDir = path.join(rootDir, 'docs');
  const { planById, existingPaths } = await loadPlanCatalog(rootDir);
  const rootMarkdownCandidates = ['AGENTS.md', 'README.md', 'ARCHITECTURE.md']
    .map((file) => path.join(rootDir, file));
  const existingRootMarkdown = [];
  for (const candidate of rootMarkdownCandidates) {
    if (await exists(candidate)) {
      existingRootMarkdown.push(candidate);
    }
  }

  const docsMarkdown = await walkMarkdownFiles(docsDir);
  const markdownFiles = [...new Set([...existingRootMarkdown, ...docsMarkdown])];

  let staleRefsFound = 0;
  let staleRuntimeContactRefsFound = 0;
  let staleRuntimeArtifactRefsFound = 0;
  let refsRepaired = 0;
  let planRefsRepaired = 0;
  let runtimeContactRefsRepaired = 0;
  let runtimeArtifactRefsRepaired = 0;
  let unresolvedRefs = 0;
  let unresolvedRuntimeContactRefs = 0;
  let unresolvedRuntimeArtifactRefs = 0;
  let filesUpdated = 0;
  const refExistsCache = new Map();
  const runtimeContactFallbackExists = await exists(path.join(rootDir, RUNTIME_CONTACT_FALLBACK_PATH));

  async function refExistsInRepo(normalizedRef) {
    if (refExistsCache.has(normalizedRef)) {
      return refExistsCache.get(normalizedRef);
    }
    const result = await exists(path.join(rootDir, normalizedRef));
    refExistsCache.set(normalizedRef, result);
    return result;
  }

  for (const filePath of markdownFiles) {
    const fileRel = toPosix(path.relative(rootDir, filePath));
    const original = await fs.readFile(filePath, 'utf8');
    const refs = collectReferenceTokens(original, fileRel);
    if (refs.length === 0) {
      continue;
    }

    const rewrites = new Map();
    for (const ref of refs) {
      let targetRef = null;

      if (ref.kind === 'plan') {
        if (existingPaths.has(ref.normalized)) {
          continue;
        }

        staleRefsFound += 1;
        const planId = inferPlanIdFromPlanPath(ref.normalized);
        targetRef = planId ? planById.get(planId) : null;
        if (!targetRef || targetRef === ref.normalized) {
          unresolvedRefs += 1;
          continue;
        }
      } else if (ref.kind === 'runtime-contact' || ref.kind === 'runtime-artifact') {
        if (await refExistsInRepo(ref.normalized)) {
          continue;
        }

        if (ref.kind === 'runtime-contact') {
          staleRuntimeContactRefsFound += 1;
        } else {
          staleRuntimeArtifactRefsFound += 1;
        }
        if (!runtimeContactFallbackExists) {
          if (ref.kind === 'runtime-contact') {
            unresolvedRuntimeContactRefs += 1;
          } else {
            unresolvedRuntimeArtifactRefs += 1;
          }
          continue;
        }
        targetRef = RUNTIME_CONTACT_FALLBACK_PATH;
      } else {
        continue;
      }

      const rewritten = rewriteRawReference(ref.raw, fileRel, targetRef);
      if (rewritten && rewritten !== ref.raw) {
        rewrites.set(ref.raw, { target: rewritten, kind: ref.kind });
      }
    }

    if (rewrites.size === 0) {
      continue;
    }

    const result = applyRewrites(original, rewrites);
    const updated = result.content;
    refsRepaired += result.replacements;
    planRefsRepaired += result.planReplacements;
    runtimeContactRefsRepaired += result.runtimeContactReplacements;
    runtimeArtifactRefsRepaired += result.runtimeArtifactReplacements;

    if (updated !== original) {
      filesUpdated += 1;
      if (!options.dryRun) {
        await fs.writeFile(filePath, updated, 'utf8');
      }
    }
  }

  console.log('[plan-ref-repair] scanned markdown files:', markdownFiles.length);
  console.log('[plan-ref-repair] stale plan refs found:', staleRefsFound);
  console.log('[plan-ref-repair] stale runtime contact refs found:', staleRuntimeContactRefsFound);
  console.log('[plan-ref-repair] stale runtime artifact refs found:', staleRuntimeArtifactRefsFound);
  console.log('[plan-ref-repair] stale plan refs repaired:', planRefsRepaired);
  console.log('[plan-ref-repair] stale runtime contact refs repaired:', runtimeContactRefsRepaired);
  console.log('[plan-ref-repair] stale runtime artifact refs repaired:', runtimeArtifactRefsRepaired);
  console.log('[plan-ref-repair] stale refs repaired total:', refsRepaired);
  console.log('[plan-ref-repair] unresolved stale refs:', unresolvedRefs);
  console.log('[plan-ref-repair] unresolved stale runtime contact refs:', unresolvedRuntimeContactRefs);
  console.log('[plan-ref-repair] unresolved stale runtime artifact refs:', unresolvedRuntimeArtifactRefs);
  console.log('[plan-ref-repair] files updated:', filesUpdated);
  if (options.dryRun) {
    console.log('[plan-ref-repair] dry-run mode; no files were written.');
  }
}

main().catch((error) => {
  console.error('[plan-ref-repair] failed.');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
