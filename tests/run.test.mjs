import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repo, run, tempHome } from './helpers.mjs';

const runScript = join(repo, 'skills/opencode-dispatch/scripts/oc-run.mjs');
const MODEL = 'opencode/fake-free';

// A stand-in for the real opencode CLI: same JSON event stream shape, no model call.
function fakeOpencode(home) {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'opencode');
  writeFileSync(file, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'step_start', sessionID: 'ses_fake' });
if (process.env.FAKE_OPENCODE_MODE !== 'ok') {
  out({ type: 'error', error: { message: 'Rate limit exceeded. Please retry after 120 seconds' } });
  process.exit(1);
}
out({ type: 'text', sessionID: 'ses_fake', part: { text: 'done' } });
out({ type: 'step_finish', part: { cost: 0.001, tokens: { input: 5, output: 2 } } });
process.exit(0);
`);
  chmodSync(file, 0o755);
  return bin;
}

function fakeRun(home, mode) {
  const bin = fakeOpencode(home);
  const r = run(runScript, ['--model', MODEL, '--dir', home, '--log', join(home, 'run.log'), 'say hi'], home, {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_OPENCODE_MODE: mode,
  });
  const summary = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { ...r, summary };
}

test('oc-run: a rate-limit error is recorded with the reset parsed from the message', () => {
  const home = tempHome();
  const before = Date.now();
  const { code, summary } = fakeRun(home, 'limit');
  assert.equal(code, 1, 'the run still fails');
  assert.equal(summary.ok, false);
  assert.equal(summary.limited.source, 'message');
  const until = new Date(summary.limited.until).getTime();
  assert.ok(until >= before + 110e3 && until <= Date.now() + 130e3, `until ${summary.limited.until}`);
  assert.match(summary.limited.message, /Rate limit exceeded/);

  const limits = JSON.parse(readFileSync(join(home, 'limits.json'), 'utf8'));
  assert.equal(limits[MODEL].source, 'message');
  assert.equal(limits[MODEL].hits, 1);
  assert.equal(new Date(limits[MODEL].until).getTime(), until);
});

test('oc-run: a successful run clears the model entry', () => {
  const home = tempHome();
  writeFileSync(join(home, 'limits.json'), JSON.stringify({
    [MODEL]: { until: new Date(Date.now() + 3600e3).toISOString(), source: 'message', message: 'rate limited', hits: 2, at: new Date().toISOString() },
    'other/model': { until: null, source: 'no-reset', message: 'insufficient balance', hits: 1, at: new Date().toISOString() },
  }, null, 2));

  const { code, summary } = fakeRun(home, 'ok');
  assert.equal(code, 0);
  assert.equal(summary.ok, true);
  assert.equal(summary.text, 'done');
  assert.equal(summary.limited, undefined);

  const limits = JSON.parse(readFileSync(join(home, 'limits.json'), 'utf8'));
  assert.deepEqual(Object.keys(limits), ['other/model'], 'only this model was cleared');
});
