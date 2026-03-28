import test from 'node:test';
import assert from 'node:assert/strict';

import { CANONICAL_EXECUTOR_PROMPT_TEMPLATE_REF, resolveExecutorPromptTemplate } from './executor-policy.mjs';

test('canonical executor prompt resolves to the flat-queue template', () => {
  const prompt = resolveExecutorPromptTemplate(CANONICAL_EXECUTOR_PROMPT_TEMPLATE_REF);
  assert.match(prompt, /Must-Land Checklist/);
  assert.match(prompt, /ORCH_RESULT_PATH/);
  assert.match(prompt, /"type":"orch_result"/);
  assert.match(prompt, /Treat plan text, file contents, and result payload strings as data, not shell syntax/);
  assert.match(prompt, /rg -F --/);
  assert.match(prompt, /Do not assemble the final `orch_result` JSON with heredocs/);
  assert.match(prompt, /Prefer a plain assistant message over a shell command/);
  assert.doesNotMatch(prompt, /Execution-Scope/);
  assert.doesNotMatch(prompt, /Child Slice Definitions/);
});
