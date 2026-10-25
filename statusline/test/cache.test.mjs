// Cache writes must be atomic: two status line renders can run at the same moment.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, makeHome } from './helpers.mjs';

const HOME = makeHome();
process.env.HOME = HOME;
const STATE = join(HOME, '.cache', 'agent-status');
const m = await import('../statusline-agents.mjs');
after(() => rmSync(HOME, { recursive: true, force: true }));

test('stepsIn remembers its offset and counts only new steps', () => {
  const log = join(HOME, 'steps.jsonl');
  writeFileSync(log, '{"type":"step_finish"}\n'.repeat(5));
  assert.equal(m.stepsIn(log), 5);
  const cache = readdirSync(STATE).find((n) => n.startsWith('steps-'));
  assert.ok(cache, 'no step cache written');
  assert.equal(JSON.parse(readFileSync(join(STATE, cache), 'utf8')).offset, statSync(log).size);
  appendFileSync(log, '{"type":"step_finish"}\n');
  assert.equal(m.stepsIn(log), 6);
});

test('saveJson writes atomically (new inode, no temp file left)', () => {
  const file = join(STATE, 'atomic.json');
  assert.equal(m.saveJson(file, { a: 1 }), true);
  const first = statSync(file).ino;
  assert.equal(m.saveJson(file, { a: 2 }), true);
  assert.notEqual(statSync(file).ino, first);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
  assert.deepEqual(readdirSync(STATE).filter((n) => n.endsWith('.tmp')), []);
});

test('concurrent readers never see a half-written cache', async () => {
  const file = join(STATE, 'atomic-race.json');
  const payload = (i) => ({ path: 'p', offset: i, pending: {}, pad: 'x'.repeat(64 * 1024) });
  assert.equal(m.saveJson(file, payload(0)), true);
  const code = `import { saveJson } from ${JSON.stringify(pathToFileURL(join(ROOT, 'statusline-agents.mjs')).href)};
    const file = process.env.TARGET;
    for (let i = 0; i < 300; i++) saveJson(file, { path: 'p', offset: i, pending: {}, pad: 'x'.repeat(65536) });`;
  const env = { ...process.env, HOME, TARGET: file };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: 'ignore' });
  let closed = false;
  child.on('close', () => { closed = true; });
  let bad = 0;
  let reads = 0;
  while (!closed && reads < 5000) {
    try { JSON.parse(readFileSync(file, 'utf8')); } catch { bad++; }
    reads++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!closed) await new Promise((resolve) => child.once('close', resolve));
  assert.ok(reads > 0);
  assert.equal(bad, 0, `${bad}/${reads} reads saw a partial cache`);
});
