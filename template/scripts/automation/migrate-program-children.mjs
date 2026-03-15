#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  migrateLegacyProgramChildDefinitions,
  parseWriteMode,
  readValidationIdsFromConfig
} from './lib/program-child-migration.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function usage() {
  process.stderr.write(
    'Usage: node ./scripts/automation/migrate-program-children.mjs --plan-file <path> [--write true|false]\n'
  );
}

export function migrateProgramChildDefinitions(content, options = {}) {
  const validationIds = options.validationIds ?? {
    always: [],
    'host-required': []
  };
  const migration = migrateLegacyProgramChildDefinitions(content, {
    validationIds
  });
  if (!migration.changed) {
    throw new Error('No legacy child-unit headings found.');
  }
  return {
    declarations: migration.legacyUnits,
    content: migration.updatedContent,
    definitions: migration.definitions
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const planFile = String(options['plan-file'] ?? '').trim();
  if (!planFile) {
    usage();
    process.exit(1);
  }

  const rootDir = process.cwd();
  const absPath = path.resolve(planFile);
  const content = await fs.readFile(absPath, 'utf8');
  const validationIds = await readValidationIdsFromConfig(rootDir, fs);
  const migration = migrateProgramChildDefinitions(content, {
    validationIds
  });

  if (parseWriteMode(options.write, false)) {
    await fs.writeFile(absPath, migration.content, 'utf8');
    process.stderr.write(
      `[migrate-program-children] wrote ${path.relative(rootDir, absPath)} with ${migration.definitions.length} child definition(s).\n`
    );
    return;
  }

  process.stderr.write(
    `[migrate-program-children] preview generated ${migration.definitions.length} structured child definition(s) for ${path.relative(rootDir, absPath)}.\n`
  );
  process.stdout.write(`${migration.content}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[migrate-program-children] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
