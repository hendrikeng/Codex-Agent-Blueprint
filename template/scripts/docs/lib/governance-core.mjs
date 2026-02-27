import fs from 'node:fs/promises';
import path from 'node:path';

const DOC_REF_IN_CODE_REGEX = /`(AGENTS\.md|README\.md|ARCHITECTURE\.md|docs\/[A-Za-z0-9_./-]+\.(?:md|json|ya?ml))`/g;
const MD_LINK_REGEX = /\[[^\]]*\]\(([^)]+)\)/g;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function toDate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    return null;
  }
  return toDate(`${value}T00:00:00Z`);
}

function metadataValue(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escaped}:\\s+(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function normalizeRef(rawRef, sourceFile) {
  const trimmed = rawRef.trim();
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

  const sourceDir = path.dirname(sourceFile);
  return toPosix(path.normalize(path.join(sourceDir, noHash)));
}

function extractRefs(content, sourceFile) {
  const refs = new Set();

  for (const match of content.matchAll(DOC_REF_IN_CODE_REGEX)) {
    refs.add(match[1]);
  }

  for (const match of content.matchAll(MD_LINK_REGEX)) {
    const normalized = normalizeRef(match[1], sourceFile);
    if (normalized) {
      refs.add(normalized);
    }
  }

  return refs;
}

function parseDateByStrategy(content, strategy) {
  if (!strategy || typeof strategy !== 'object') {
    return null;
  }

  if (strategy.type === 'metadata_field') {
    const value = metadataValue(content, strategy.field);
    if (!value) {
      return null;
    }

    if (strategy.format === 'iso-date') {
      return parseIsoDate(value);
    }

    return toDate(value);
  }

  if (strategy.type === 'regex') {
    const regex = new RegExp(strategy.pattern, 'm');
    const match = content.match(regex);
    if (!match) {
      return null;
    }

    const capture = match[Number(strategy.group ?? 1)] ?? null;
    if (!capture) {
      return null;
    }

    if (strategy.format === 'iso-date') {
      return parseIsoDate(capture.trim());
    }

    return toDate(capture.trim());
  }

  return null;
}

function daysBetween(a, b) {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function makeFinding(level, code, message, file = null) {
  return { level, code, message, file };
}

function formatRefForExistence(ref) {
  return ref.endsWith('/') ? ref.slice(0, -1) : ref;
}

async function exists(absPath) {
  try {
    await fs.access(absPath);
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
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(nextPath);
      }
    }
  }

  await walk(baseDir);
  return results;
}

export async function loadGovernanceConfig(configPath) {
  const raw = await fs.readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

export async function runGovernanceAnalysis({
  rootDir,
  configPath,
  now = new Date(),
  staleDaysOverride = null
}) {
  const config = await loadGovernanceConfig(configPath);
  const errors = [];
  const warnings = [];

  const docsDir = path.join(rootDir, 'docs');
  const markdownFilesAbs = await walkMarkdownFiles(docsDir);

  const explicitScanFiles = [
    path.join(rootDir, 'AGENTS.md'),
    path.join(rootDir, 'README.md'),
    path.join(rootDir, 'ARCHITECTURE.md'),
    ...((config.scanFiles ?? []).map((rel) => path.join(rootDir, rel)))
  ];

  const sourceFiles = [...new Set([...explicitScanFiles, ...markdownFilesAbs])].filter(async () => true);

  const contents = new Map();
  const refsGraph = new Map();

  for (const fileAbs of sourceFiles) {
    if (!(await exists(fileAbs))) {
      continue;
    }

    const rel = toPosix(path.relative(rootDir, fileAbs));
    const content = await fs.readFile(fileAbs, 'utf8');
    contents.set(rel, content);
    refsGraph.set(rel, extractRefs(content, rel));
  }

  for (const rel of config.canonicalDocs ?? []) {
    const abs = path.join(rootDir, rel);
    if (!(await exists(abs))) {
      errors.push(makeFinding('error', 'MISSING_CANONICAL_DOC', `Missing canonical doc: ${rel}`, rel));
    }
  }

  for (const rel of config.requiredDirs ?? []) {
    const abs = path.join(rootDir, rel);
    let stat = null;
    try {
      stat = await fs.stat(abs);
    } catch {
      stat = null;
    }

    if (!stat?.isDirectory()) {
      errors.push(makeFinding('error', 'MISSING_REQUIRED_DIR', `Missing required docs directory: ${rel}`, rel));
    }
  }

  const docsIndexPath = config.docsIndexPath ?? 'docs/index.md';
  const docsIndexContent = contents.get(docsIndexPath);
  if (!docsIndexContent) {
    errors.push(makeFinding('error', 'MISSING_DOCS_INDEX', `Missing docs index: ${docsIndexPath}`, docsIndexPath));
  } else {
    for (const requiredEntry of config.requiredIndexEntries ?? []) {
      const backtickRef = `\`${requiredEntry}\``;
      const parenRef = `(${requiredEntry})`;
      if (!docsIndexContent.includes(backtickRef) && !docsIndexContent.includes(parenRef)) {
        errors.push(
          makeFinding(
            'error',
            'MISSING_INDEX_ENTRY',
            `${docsIndexPath} is missing required entry: ${requiredEntry}`,
            docsIndexPath
          )
        );
      }
    }
  }

  const requiredLinks = config.requiredLinks ?? {};
  for (const [sourceFile, links] of Object.entries(requiredLinks)) {
    const content = contents.get(sourceFile);
    if (!content) {
      errors.push(makeFinding('error', 'MISSING_REQUIRED_LINK_SOURCE', `Missing required link source: ${sourceFile}`, sourceFile));
      continue;
    }

    for (const link of links) {
      if (!content.includes(link)) {
        errors.push(
          makeFinding(
            'error',
            'MISSING_REQUIRED_LINK',
            `${sourceFile} is missing required reference: ${link}`,
            sourceFile
          )
        );
      }
    }
  }

  const requiredHeadings = config.requiredHeadings ?? {};
  for (const [sourceFile, headings] of Object.entries(requiredHeadings)) {
    const content = contents.get(sourceFile);
    if (!content) {
      errors.push(makeFinding('error', 'MISSING_HEADING_SOURCE', `Missing heading source file: ${sourceFile}`, sourceFile));
      continue;
    }

    for (const heading of headings) {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^##\\s+${escaped}\\s*$`, 'm');
      if (!regex.test(content)) {
        errors.push(
          makeFinding(
            'error',
            'MISSING_REQUIRED_HEADING',
            `Missing required heading \"## ${heading}\" in ${sourceFile}`,
            sourceFile
          )
        );
      }
    }
  }

  const metadataRules = config.metadataRules ?? [];
  for (const rule of metadataRules) {
    const content = contents.get(rule.path);
    if (!content) {
      errors.push(makeFinding('error', 'MISSING_METADATA_TARGET', `Missing metadata target: ${rule.path}`, rule.path));
      continue;
    }

    for (const field of rule.requiredFields ?? []) {
      if (!metadataValue(content, field)) {
        errors.push(
          makeFinding(
            'error',
            'MISSING_METADATA_FIELD',
            `Missing metadata field \"${field}:\" in ${rule.path}`,
            rule.path
          )
        );
      }
    }
  }

  const staleness = config.staleness ?? null;
  if (staleness) {
    const maxAgeDays = Number.isInteger(staleDaysOverride) && staleDaysOverride > 0
      ? staleDaysOverride
      : Number(staleness.maxAgeDays ?? 0);

    if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) {
      errors.push(makeFinding('error', 'INVALID_STALE_DAYS', 'staleness.maxAgeDays must be a positive integer.'));
    } else {
      for (const target of staleness.targets ?? []) {
        const entry = typeof target === 'string'
          ? { path: target, strategy: staleness.defaultStrategy }
          : target;

        const filePath = entry.path;
        const content = contents.get(filePath);
        if (!content) {
          errors.push(makeFinding('error', 'MISSING_STALENESS_TARGET', `Missing staleness target: ${filePath}`, filePath));
          continue;
        }

        const parsedDate = parseDateByStrategy(content, entry.strategy ?? staleness.defaultStrategy);
        if (!parsedDate) {
          errors.push(
            makeFinding(
              'error',
              'MISSING_STALENESS_TIMESTAMP',
              `Missing or invalid freshness timestamp in ${filePath}`,
              filePath
            )
          );
          continue;
        }

        const age = daysBetween(parsedDate, now);
        if (age > maxAgeDays) {
          errors.push(
            makeFinding(
              'error',
              'STALE_DOC',
              `Stale document (${age} days): ${filePath} (max ${maxAgeDays})`,
              filePath
            )
          );
        }
      }
    }
  }

  for (const [sourceFile, refs] of refsGraph.entries()) {
    for (const ref of refs) {
      const normalized = formatRefForExistence(ref);
      const abs = path.join(rootDir, normalized);
      if (!(await exists(abs))) {
        errors.push(
          makeFinding(
            'error',
            'BROKEN_DOC_REF',
            `Broken reference in ${sourceFile}: ${ref}`,
            sourceFile
          )
        );
      }
    }
  }

  const activePlansConfig = config.activePlans ?? null;
  if (activePlansConfig) {
    const activeDirRel = activePlansConfig.directory;
    const activeDirAbs = path.join(rootDir, activeDirRel);
    let activeEntries = [];
    try {
      activeEntries = await fs.readdir(activeDirAbs, { withFileTypes: true });
    } catch {
      errors.push(makeFinding('error', 'MISSING_ACTIVE_PLAN_DIR', `Missing active plans directory: ${activeDirRel}`, activeDirRel));
      activeEntries = [];
    }

    const exclude = new Set(activePlansConfig.excludeFiles ?? ['README.md']);
    const planFiles = activeEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !exclude.has(entry.name))
      .map((entry) => `${activeDirRel}/${entry.name}`)
      .sort((a, b) => a.localeCompare(b));

    for (const planFile of planFiles) {
      const content = contents.get(planFile) ?? (await fs.readFile(path.join(rootDir, planFile), 'utf8'));

      if (activePlansConfig.requireMetadataSection && !content.includes('## Metadata')) {
        errors.push(makeFinding('error', 'MISSING_PLAN_METADATA_SECTION', `Missing ## Metadata section: ${planFile}`, planFile));
      }

      for (const field of activePlansConfig.requiredMetadataFields ?? []) {
        if (!content.includes(`- ${field}:`)) {
          errors.push(
            makeFinding(
              'error',
              'MISSING_PLAN_METADATA_FIELD',
              `Missing metadata field \"${field}\" in ${planFile}`,
              planFile
            )
          );
        }
      }
    }
  }

  const completedPlansConfig = config.completedPlans ?? null;
  if (completedPlansConfig) {
    const completedDirRel = completedPlansConfig.directory;
    const completedDirAbs = path.join(rootDir, completedDirRel);
    let entries = [];
    try {
      entries = await fs.readdir(completedDirAbs, { withFileTypes: true });
    } catch {
      errors.push(makeFinding('error', 'MISSING_COMPLETED_PLAN_DIR', `Missing completed plans directory: ${completedDirRel}`, completedDirRel));
      entries = [];
    }

    const exclude = new Set(completedPlansConfig.excludeFiles ?? ['README.md']);
    const completedFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !exclude.has(entry.name))
      .map((entry) => `${completedDirRel}/${entry.name}`);

    for (const filePath of completedFiles) {
      const content = contents.get(filePath) ?? (await fs.readFile(path.join(rootDir, filePath), 'utf8'));
      for (const patternRule of completedPlansConfig.requiredPatterns ?? []) {
        const regex = new RegExp(patternRule.regex, 'm');
        if (!regex.test(content)) {
          errors.push(
            makeFinding(
              'error',
              'MISSING_COMPLETED_PLAN_FIELD',
              `${filePath} missing completed-plan requirement: ${patternRule.message}`,
              filePath
            )
          );
        }
      }
    }
  }

  const dateCoupling = config.currentStateDateCoupling ?? null;
  if (dateCoupling) {
    const readme = contents.get(dateCoupling.readmePath);
    const currentState = contents.get(dateCoupling.currentStatePath);

    if (!readme) {
      errors.push(makeFinding('error', 'MISSING_DATE_COUPLING_README', `Missing file: ${dateCoupling.readmePath}`, dateCoupling.readmePath));
    }
    if (!currentState) {
      errors.push(makeFinding('error', 'MISSING_DATE_COUPLING_STATE', `Missing file: ${dateCoupling.currentStatePath}`, dateCoupling.currentStatePath));
    }

    if (readme && currentState) {
      const field = dateCoupling.fieldName ?? 'Current State Date';
      const readmeDateRaw = metadataValue(readme, field);
      const stateDateRaw = metadataValue(currentState, field);

      const readmeDate = parseIsoDate(readmeDateRaw ?? '');
      const stateDate = parseIsoDate(stateDateRaw ?? '');

      if (!readmeDate) {
        errors.push(makeFinding('error', 'INVALID_README_STATE_DATE', `Invalid ${field} in ${dateCoupling.readmePath}`, dateCoupling.readmePath));
      }
      if (!stateDate) {
        errors.push(makeFinding('error', 'INVALID_PRODUCT_STATE_DATE', `Invalid ${field} in ${dateCoupling.currentStatePath}`, dateCoupling.currentStatePath));
      }
      if (readmeDate && stateDate && stateDate.getTime() < readmeDate.getTime()) {
        errors.push(
          makeFinding(
            'error',
            'PRODUCT_STATE_DATE_BEHIND_README',
            `${dateCoupling.currentStatePath} ${field} must be >= ${dateCoupling.readmePath}`,
            dateCoupling.currentStatePath
          )
        );
      }
    }
  }

  const techDebt = config.techDebtTracker ?? null;
  if (techDebt) {
    const content = contents.get(techDebt.path);
    if (!content) {
      errors.push(makeFinding('error', 'MISSING_TECH_DEBT_TRACKER', `Missing file: ${techDebt.path}`, techDebt.path));
    } else {
      const regex = new RegExp(techDebt.activePlanRegex, 'g');
      for (const match of content.matchAll(regex)) {
        const activePlanPath = match[1];
        if (!(await exists(path.join(rootDir, activePlanPath)))) {
          errors.push(
            makeFinding(
              'error',
              'MISSING_ACTIVE_PLAN_REF',
              `Tech debt tracker references missing active plan: ${activePlanPath}`,
              techDebt.path
            )
          );
        }
      }
    }
  }

  for (const artifact of config.generatedArtifacts ?? []) {
    const artifactAbs = path.join(rootDir, artifact.path);
    if (!(await exists(artifactAbs))) {
      errors.push(makeFinding('error', 'MISSING_GENERATED_ARTIFACT', `Missing generated artifact: ${artifact.path}`, artifact.path));
      continue;
    }

    const raw = await fs.readFile(artifactAbs, 'utf8');
    let parsedDate = null;

    if (artifact.timestampRegex) {
      const regex = new RegExp(artifact.timestampRegex, 'm');
      const match = raw.match(regex);
      const capture = match?.[Number(artifact.timestampGroup ?? 1)] ?? null;
      parsedDate = capture ? toDate(capture.trim()) : null;
    } else if (artifact.timestampJsonField) {
      try {
        const json = JSON.parse(raw);
        parsedDate = toDate(json[artifact.timestampJsonField]);
      } catch {
        parsedDate = null;
      }
    }

    if (!parsedDate) {
      errors.push(
        makeFinding(
          'error',
          'MISSING_GENERATED_ARTIFACT_TIMESTAMP',
          `Generated artifact missing parsable timestamp: ${artifact.path}`,
          artifact.path
        )
      );
      continue;
    }

    const maxAgeDays = Number(artifact.maxAgeDays ?? 0);
    if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) {
      errors.push(makeFinding('error', 'INVALID_GENERATED_ARTIFACT_MAX_AGE', `Invalid maxAgeDays for ${artifact.path}`, artifact.path));
      continue;
    }

    const age = daysBetween(parsedDate, now);
    if (age > maxAgeDays) {
      errors.push(
        makeFinding(
          'error',
          'STALE_GENERATED_ARTIFACT',
          `Stale generated artifact (${age} days): ${artifact.path} (max ${maxAgeDays})`,
          artifact.path
        )
      );
    }
  }

  const docFiles = [...contents.keys()].filter((file) => file.startsWith('docs/') && file.endsWith('.md'));
  const seeds = config.graphSeeds ?? ['AGENTS.md', 'README.md', docsIndexPath];
  const visited = new Set();
  const queue = [...seeds];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visited.has(next)) {
      continue;
    }

    visited.add(next);

    const refs = refsGraph.get(next);
    if (!refs) {
      continue;
    }

    for (const ref of refs) {
      if (contents.has(ref) && !visited.has(ref)) {
        queue.push(ref);
      }
    }
  }

  const unreachablePolicy = config.unreachablePolicy ?? { scope: 'all_docs', level: 'warning' };
  const unreachableLevel = unreachablePolicy.level === 'error' ? 'error' : 'warning';
  const canonicalDocSet = new Set(
    (config.canonicalDocs ?? []).filter((file) => file.startsWith('docs/') && file.endsWith('.md'))
  );

  const reachabilityScope = unreachablePolicy.scope ?? 'all_docs';
  const reachabilityTargets = reachabilityScope === 'canonical'
    ? docFiles.filter((file) => canonicalDocSet.has(file))
    : docFiles;

  const unreachable = reachabilityTargets
    .filter((file) => !visited.has(file))
    .sort((a, b) => a.localeCompare(b));

  const unreachableCollection = unreachableLevel === 'error' ? errors : warnings;
  for (const file of unreachable) {
    unreachableCollection.push(
      makeFinding(
        unreachableLevel,
        'UNREACHABLE_DOC',
        `Doc is not reachable from AGENTS/README/docs-index graph: ${file}`,
        file
      )
    );
  }

  return {
    config,
    errors,
    warnings,
    stats: {
      markdownFilesAnalyzed: sourceFiles.length,
      docFilesAnalyzed: docFiles.length,
      activePlansAnalyzed: config.activePlans?.directory ? (await fs.readdir(path.join(rootDir, config.activePlans.directory)).catch(() => [])).filter((name) => name.endsWith('.md')).length : 0,
      brokenRefCount: errors.filter((finding) => finding.code === 'BROKEN_DOC_REF').length
    }
  };
}
