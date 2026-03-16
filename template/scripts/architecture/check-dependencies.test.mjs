import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { walkTsFiles } from './check-dependencies.mjs';

test('walkTsFiles includes tsx sources and excludes test files', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-dependencies-'));
  await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'src', 'view.tsx'), 'export const View = () => null;\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'src', 'logic.ts'), 'export const logic = 1;\n', 'utf8');
  await fs.writeFile(path.join(rootDir, 'src', 'logic.test.tsx'), 'test("x", () => {});\n', 'utf8');

  const files = (await walkTsFiles(rootDir)).map((filePath) => path.basename(filePath)).sort();
  assert.deepEqual(files, ['logic.ts', 'view.tsx']);
});
