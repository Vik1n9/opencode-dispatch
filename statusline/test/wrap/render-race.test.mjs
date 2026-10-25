// Two renders at once (Claude Code starts the next render before the last finished):
// transcript cache writes must be atomic, the dl files must stay readable while they are
// replaced, and one odd log dir must never take the whole second line down.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cleanupHome, makeHome, runWrap, startFakeOcRun, stdinJson } from './helpers.mjs';

const toolUseLine = JSON.stringify({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: { content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: { command: 'sleep 999', run_in_background: true, description: 'bg task' } }] },
}) + '\n';

// Samples the cache file in tight slices and reports any snapshot that is not one complete
// JSON object (empty or truncated). Prints one JSON line on SIGTERM.
const readerSrc = `
const fs = require('fs');
const file = process.env.CACHE_FILE;
let reads = 0, invalid = 0, done = false;
function finish() {
  if (done) return;
  done = true;
  console.log(JSON.stringify({ reads, invalid }));
  process.exit(0);
}
process.on('SIGTERM', finish);
setTimeout(finish, 30000); // safety net
function slice() {
  if (done) return;
  const end = Date.now() + 50;
  while (Date.now() < end) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { invalid++; continue; }
    reads++;
    const t = raw.trim();
    if (!t || t[0] !== '{' || t[t.length - 1] !== '}') invalid++;
  }
  setTimeout(slice, 0);
}
slice();
`;

function mjsChild(home, input, env = {}) {
  return new Promise((resolve) => {
    const k = spawn(process.execPath, [join(home, '.claude', 'statusline-agents.mjs')], {
      env: { ...process.env, HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    k.stdout.on('data', (d) => (stdout += d));
    k.stderr.on('data', (d) => (stderr += d));
    k.stdin.end(input);
    k.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

test('concurrent renders never expose a torn transcript cache file', async (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const transcript = join(home, 'transcript.jsonl');
  appendFileSync(transcript, toolUseLine);
  const cache = join(home, '.cache', 'agent-status', 'transcript-race.json');
  mkdirSync(join(home, '.cache', 'agent-status'), { recursive: true });
  // Seed a big pending map so every cache rewrite is a few hundred KB wide.
  const pending = {};
  for (let i = 0; i < 3500; i++) pending[`toolu_seed${i}`] = { label: `seed-task-${i}-padding-padding`, at: Date.now() };
  writeFileSync(cache, JSON.stringify({ path: transcript, offset: 0, pending }));
  const stdin = JSON.stringify({ session_id: 'race', transcript_path: transcript });

  const reader = spawn(process.execPath, ['-e', readerSrc], {
    env: { ...process.env, CACHE_FILE: cache },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  reader.stdout.on('data', (d) => (out += d));
  const readerDone = new Promise((resolve) => reader.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the reader start sampling

  // Six waves: each appends to the transcript, so every concurrent render rewrites the cache.
  for (let w = 0; w < 6; w++) {
    appendFileSync(transcript, toolUseLine);
    await Promise.all(Array.from({ length: 8 }, () => mjsChild(home, stdin)));
  }

  reader.kill('SIGTERM');
  await readerDone;
  const { reads, invalid } = JSON.parse(out.trim().split('\n').at(-1));
  assert.ok(reads > 1000, `reader barely sampled: ${reads} reads`);
  assert.equal(invalid, 0, `${invalid} torn cache snapshots observed across ${reads} reads`);
});

// P-G: the log-discovery dir ($TMPDIR/oc-run) exists but is a regular file -> readdirSync
// threw ENOTDIR, the whole script crashed and the second line (including downloads) vanished.
test('log dir is not a directory: second line still prints', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const tmp = join(home, 'tmpdir');
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'oc-run'), ''); // a FILE, not a dir
  startFakeOcRun(t, home);                // no --log -> triggers log discovery
  const dl = join(home, '.cache', 'agent-status', `dl-${process.pid}.json`);
  mkdirSync(join(home, '.cache', 'agent-status'), { recursive: true });
  writeFileSync(dl, JSON.stringify({ label: 'dl-entry', pid: process.pid, pct: 50, etaAt: Date.now() + 60000 }));
  t.after(() => { try { rmSync(dl, { force: true }); } catch { /* best effort */ } });

  const r = runWrap(home, stdinJson(), { env: { TMPDIR: tmp } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dl-entry/, `downloads entry lost, got: ${JSON.stringify(r.stdout)}`);
  assert.match(r.stdout, /冒煙測試/, `fake dispatch lost, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!/冒煙測試[^│]*步/.test(r.stdout), 'steps must be omitted when the log dir is unusable');
});

// dl files are replaced atomically by dlwatch while renders read them: no crash, no
// malformed line.
test('renders racing a dl file replacement all succeed', async (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const dl = join(home, '.cache', 'agent-status', `dl-${process.pid}.json`);
  mkdirSync(join(home, '.cache', 'agent-status'), { recursive: true });
  const writerSrc = `
const fs = require('fs');
const file = process.env.DL_FILE;
const end = Date.now() + 2000;
let i = 0;
while (Date.now() < end) {
  const st = { label: 'dl-loop', pid: Number(process.env.DL_PID), pct: i++ % 100, etaAt: Date.now() + 60000 };
  fs.writeFileSync(file + '.tmp', JSON.stringify(st));
  fs.renameSync(file + '.tmp', file);
}
`;
  const writer = spawn(process.execPath, ['-e', writerSrc], {
    env: { ...process.env, DL_FILE: dl, DL_PID: String(process.pid) },
    stdio: 'ignore',
  });
  t.after(() => { try { process.kill(writer.pid, 'SIGTERM'); } catch { /* done */ } });

  const stdin = stdinJson();
  const results = await Promise.all(Array.from({ length: 6 }, () => mjsChild(home, stdin)));
  for (const r of results) {
    assert.equal(r.status, 0, `mjs failed: ${r.stderr}`);
    assert.ok(r.stdout.split('\n').filter(Boolean).length <= 1, `not a single line: ${JSON.stringify(r.stdout)}`);
    assert.match(r.stdout, /dl-loop/);
    assert.ok(!r.stdout.includes('\n\n'));
  }
  writer.kill('SIGTERM');
});

// The sanitizer behind the output guarantee, called through a child process so the test
// works even when the module still runs its CLI code on import.
test('clean() strips ANSI sequences and control characters', async (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const mjs = fileURLToPath(new URL('../../statusline-agents.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['-e', `
    import(process.env.MJS).then((m) => {
      const samples = ['evil\\nline2\\u001b[999mX', '\\u001b]0;title\\u0007label', 'a\\r\\tb'];
      console.log(JSON.stringify({ has: typeof m.clean === 'function', out: samples.map((s) => (m.clean ? m.clean(s) : null)) }));
    });
  `], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MJS: mjs, HOME: home },
  });
  const line = child.stdout.trim().split('\n').at(-1);
  const { has, out } = JSON.parse(line);
  assert.equal(has, true, 'statusline-agents.mjs must export clean()');
  assert.equal(out[0], 'evil line2X');
  assert.equal(out[1], 'label');
  assert.equal(out[2], 'a b');
  for (const s of out) assert.ok(!/[\n\r\x00-\x1f]/.test(s), `control chars survived: ${JSON.stringify(s)}`);
});
