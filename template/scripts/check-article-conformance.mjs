#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const conformancePath = path.join(rootDir, 'docs', 'generated', 'article-conformance.json');

const fail = (message) => {
  console.error(`[conformance-verify] ${message}`);
  process.exit(1);
};

if (!fs.existsSync(conformancePath)) {
  fail(`Missing conformance file: ${conformancePath}`);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(conformancePath, 'utf8'));
} catch (error) {
  fail(`Invalid JSON in ${conformancePath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (typeof parsed !== 'object' || parsed === null) {
  fail('Conformance payload must be a JSON object.');
}

const { generatedAtUtc, source, repositoryProfile, purpose, outOfScope, coreCapabilities } = parsed;

if (typeof generatedAtUtc !== 'string' || generatedAtUtc.length < 20 || Number.isNaN(Date.parse(generatedAtUtc))) {
  fail("'generatedAtUtc' must be an ISO datetime string.");
}

if (typeof source !== 'string' || source.trim().length === 0) {
  fail("'source' must be a non-empty string.");
}

if (typeof repositoryProfile !== 'string' || !/^[a-z0-9_]+$/.test(repositoryProfile)) {
  fail("'repositoryProfile' must be a snake_case string.");
}

if (typeof purpose !== 'string' || purpose.trim().length === 0) {
  fail("'purpose' must be a non-empty string.");
}

if (!Array.isArray(outOfScope) || outOfScope.length === 0) {
  fail("'outOfScope' must be a non-empty array.");
}

const seenOutOfScope = new Set();
for (const item of outOfScope) {
  if (typeof item !== 'string' || !/^[a-z0-9_]+$/.test(item)) {
    fail(`Out-of-scope item must be snake_case: ${String(item)}`);
  }

  if (seenOutOfScope.has(item)) {
    fail(`Duplicate out-of-scope item: ${item}`);
  }
  seenOutOfScope.add(item);
}

if (!Array.isArray(coreCapabilities) || coreCapabilities.length === 0) {
  fail("'coreCapabilities' must be a non-empty array.");
}

const allowedStatus = new Set(['implemented', 'partial']);
const seenIds = new Set();
let evidenceCount = 0;

for (const capability of coreCapabilities) {
  if (typeof capability !== 'object' || capability === null) {
    fail('Each core capability entry must be an object.');
  }

  const { id, status, evidence } = capability;

  if (typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id)) {
    fail(`Capability id must be snake_case: ${String(id)}`);
  }

  if (seenIds.has(id)) {
    fail(`Duplicate capability id: ${id}`);
  }
  seenIds.add(id);

  if (typeof status !== 'string' || !allowedStatus.has(status)) {
    fail(`Capability '${id}' has invalid status: ${String(status)}. Allowed: implemented, partial.`);
  }

  if (!Array.isArray(evidence) || evidence.length === 0) {
    fail(`Capability '${id}' must include at least one evidence path.`);
  }

  for (const evidencePath of evidence) {
    if (typeof evidencePath !== 'string' || evidencePath.trim().length === 0) {
      fail(`Capability '${id}' contains invalid evidence path value.`);
    }

    const absolutePath = path.resolve(rootDir, evidencePath);
    if (!absolutePath.startsWith(rootDir)) {
      fail(`Capability '${id}' has out-of-repo evidence path: ${evidencePath}`);
    }

    if (!fs.existsSync(absolutePath)) {
      fail(`Capability '${id}' references missing evidence file: ${evidencePath}`);
    }

    evidenceCount += 1;
  }
}

console.log(`[conformance-verify] passed (${coreCapabilities.length} capabilities, ${evidenceCount} evidence references).`);
