import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeSandbox, runScript, spawnScript, waitFor, writeShim, SHIM_OK, writeEvents, writeJson,
} from './helpers.mjs';

const EVENTS = [
  { type: 'step_start', sessionID: 'ses_w' },
  { type: 'text', sessionID: 'ses_w', part: { text: 'reading the code' } },
  { type: 'tool_use', sessionID: 'ses_w', part: { tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } } },
  { type: 'tool_use', sessionID: 'ses_w', part: { tool: 'edit', state: { status: 'error', input: { filePath: 'a.js' }, error: 'no match' } } },
  { type: 'step_finish', sessionID: 'ses_w', part: { cost: 0.5, tokens: { input: 100, output: 20 } } },
];

// A fake `rex` that records its argv and answers `window new --json` like the real CLI.
function writeRex(sb, { exit = 0 } = {}) {
  const argv = join(sb.dir, 'rex-argv.txt');
  const path = join(sb.bin, 'rex');
  writeFileSync(path, `#!/bin/sh
printf '%s\\n' "$@" > "${argv}"
if [ ${exit} -ne 0 ]; then echo 'no such session' >&2; exit ${exit}; fi
echo '{"window_id":"window:w1","block_ids":["block:b1"],"revision":1}'
`);
  chmodSync(path, 0o755);
  return argv;
}

// A failed wait kills the viewer, so a regression fails the test instead of hanging the suite.
const stop = (child) => (e) => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  throw e;
};

function watch(sb, log) {
  return runScript(sb, 'oc-watch.mjs', [log, '--poll', '20'], { env: { NO_COLOR: '1' } });
}

test('oc-watch: renders the log and the final summary of a finished run', () => {
  const sb = makeSandbox();
  const log = writeEvents(sb, EVENTS);
  writeJson(`${log}.status.json`, {
    state: 'done', pid: 1, title: 'fix-x', model: 'opencode/m', agent: 'build', dir: sb.dir, base: null,
    summary: { ok: true, model: 'opencode/m', seconds: 3, steps: 1, cost: 0.5, sessionID: 'ses_w', handoffs: [], errors: [] },
  });
  const r = watch(sb, log);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /opencode fix-x/);
  assert.match(r.stdout, /reading the code/);
  assert.match(r.stdout, /▸ bash npm test/);
  assert.match(r.stdout, /✗ edit a\.js\n\s+no match/);
  assert.match(r.stdout, /step 1 {2}in 100 out 20 {2}\$0\.5000/);
  assert.match(r.stdout, /── done {2}opencode\/m {2}3s {2}1 steps/);
});

test('oc-watch: oc-run gone without a summary exits 1', () => {
  const sb = makeSandbox();
  const log = writeEvents(sb, EVENTS.slice(0, 2));
  const dead = 2 ** 22; // above macOS / Linux pid limits, so never a live process
  writeJson(`${log}.status.json`, { state: 'running', pid: dead, model: 'opencode/m', dir: sb.dir });
  const r = watch(sb, log);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /reading the code/);
  assert.match(r.stdout, /exited without a summary/);
});

test('oc-watch: lists commits and changes since the run started', () => {
  const sb = makeSandbox();
  const repo = join(sb.dir, 'repo');
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: sb.env });
  spawnSync('git', ['init', '-q', repo]);
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(repo, 'b.txt'), 'b\n'); g('add', '.'); g('commit', '-qm', 'feat: add b');
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  const log = writeEvents(sb, EVENTS.slice(0, 1));
  writeJson(`${log}.status.json`, {
    state: 'done', pid: 1, model: 'opencode/m', dir: repo, base,
    summary: { ok: false, model: 'opencode/m', seconds: 1, steps: 0, cost: 0, handoffs: [], errors: ['boom'] },
  });
  const r = watch(sb, log);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /── failed/);
  assert.match(r.stdout, /boom/);
  assert.match(r.stdout, /commits\n\w+ feat: add b/);
  assert.match(r.stdout, /git status\n M a\.txt/);
  assert.match(r.stdout, /diff --stat\n.*a\.txt/);
});

// A fake `opencode` whose `api` call prints the session context named by OC_SHIM_CONTEXT (exit 1 if unset).
function writeApiShim(sb) {
  const path = join(sb.bin, 'opencode');
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "api" ]; then
  printf '%s\\n' "$@" > "${join(sb.dir, 'api-argv.txt')}"
  [ -n "$OC_SHIM_CONTEXT" ] || exit 1
  cat "$OC_SHIM_CONTEXT"; exit 0
fi
exit 0
`);
  chmodSync(path, 0o755);
}

async function watchLive(sb, context) {
  writeApiShim(sb);
  const log = writeEvents(sb, EVENTS.slice(0, 2));
  const statusFile = `${log}.status.json`;
  writeJson(statusFile, { state: 'running', pid: process.pid, model: 'opencode/m', dir: sb.dir });
  const env = { NO_COLOR: '1', OC_WATCH_IDLE_MS: '100' };
  if (context) {
    env.OC_SHIM_CONTEXT = join(sb.dir, 'context.json');
    writeJson(env.OC_SHIM_CONTEXT, context);
  }
  const { child, done } = spawnScript(sb, 'oc-watch.mjs', [log, '--poll', '20'], { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await waitFor(() => /⋯ \S+ (?!starting)/.test(out), 8000).catch(stop(child));
  writeJson(statusFile, { state: 'done', pid: process.pid, model: 'opencode/m', dir: sb.dir,
    summary: { ok: true, model: 'opencode/m', seconds: 1, steps: 0, cost: 0, handoffs: [], errors: [] } });
  const r = await done;
  return { r, argv: readFileSync(join(sb.dir, 'api-argv.txt'), 'utf8').trim().split('\n') };
}

test('oc-watch: a quiet log shows the tool the opencode service reports as running', async () => {
  const now = Date.now();
  const { r, argv } = await watchLive(makeSandbox(), { data: [
    { type: 'user' },
    { type: 'assistant', time: { created: now - 90000 }, content: [
      { type: 'reasoning', text: 'run the suite' },
      { type: 'tool', name: 'shell', state: { status: 'running', input: { command: 'node --test statusline/test/' } },
        time: { created: now - 75000, ran: now - 75000 } },
    ] },
  ] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(argv, ['api', 'GET', '/api/session/ses_w/context']);
  assert.match(r.stdout, /⋯ 1m1\ds shell node --test statusline\/test\//);
});

test('oc-watch: reasoning in progress shows as thinking; no service shows waiting', async () => {
  const { r } = await watchLive(makeSandbox(), { data: [
    { type: 'assistant', time: { created: Date.now() }, content: [{ type: 'reasoning', text: 'maybe the tests\nneed a pty' }] },
  ] });
  assert.match(r.stdout, /⋯ \d+s thinking: maybe the tests need a pty/);
  const { r: r2 } = await watchLive(makeSandbox(), null);
  assert.match(r2.stdout, /⋯ \d+s waiting/);
  assert.match(r2.stdout, /── done/);
});

test('oc-run: inside Rex opens a background tab running oc-watch on the log', () => {
  const sb = makeSandbox();
  writeShim(sb);
  const argvFile = writeRex(sb);
  const events = writeEvents(sb, EVENTS.slice(0, 3));
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/m', '--title', 'fix-x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events, REX_SESSION: 'session:s1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.rex, { session: 'session:s1', window: 'window:w1', block: 'block:b1' });
  assert.match(r.stderr, /rex tab "oc fix-x" window window:w1 block block:b1/);
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.deepEqual(argv.slice(0, 5), ['window', 'new', '-s', 'session:s1', 'oc fix-x']);
  for (const flag of ['--keep-open', '--focus=false', '--json']) assert.ok(argv.includes(flag), flag);
  assert.ok(argv.at(-2).endsWith('oc-watch.mjs'));
  assert.equal(argv.at(-1), r.json.log);
  const status = JSON.parse(readFileSync(`${r.json.log}.status.json`, 'utf8'));
  assert.equal(status.state, 'done');
  assert.equal(status.summary.sessionID, 'ses_w');
});

test('oc-run: a failing rex is reported but does not stop the run', () => {
  const sb = makeSandbox();
  writeShim(sb);
  writeRex(sb, { exit: 1 });
  const events = writeEvents(sb, EVENTS.slice(0, 2));
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/m', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events, REX_SESSION: 'session:s1' } });
  assert.equal(r.status, 0);
  assert.match(r.json.rex.error, /no such session/);
});

test('oc-run: --no-rex and no REX_SESSION leave rex alone', () => {
  for (const [args, env] of [[['--no-rex'], { REX_SESSION: 'session:s1' }], [[], {}]]) {
    const sb = makeSandbox();
    writeShim(sb);
    const argvFile = writeRex(sb);
    const events = writeEvents(sb, EVENTS.slice(0, 2));
    const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/m', ...args, 'hi'],
      { env: { ...SHIM_OK, OC_SHIM_EVENTS: events, ...env } });
    assert.equal(r.status, 0);
    assert.equal(r.json.rex, undefined);
    assert.equal(existsSync(argvFile), false);
  }
});

test('oc-watch: follows a growing log, keeps a character cut between writes, shows an unterminated last line', async () => {
  const sb = makeSandbox();
  const log = join(sb.dir, 'live.jsonl');
  writeFileSync(log, '');
  const statusFile = `${log}.status.json`;
  writeJson(statusFile, { state: 'running', pid: process.pid, model: 'opencode/m', dir: sb.dir });
  const { child, done } = spawnScript(sb, 'oc-watch.mjs', [log, '--poll', '20'], { env: { NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const line = Buffer.from(JSON.stringify({ type: 'text', sessionID: 's', part: { text: '中文測試' } }) + '\n');
  const cut = line.indexOf(Buffer.from('中')) + 1; // inside the 3-byte character
  appendFileSync(log, line.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 150));
  appendFileSync(log, line.subarray(cut));
  await waitFor(() => out.includes('中文測試')).catch(stop(child));
  writeJson(statusFile, { state: 'running', pid: process.pid, model: 'opencode/y', dir: sb.dir });
  await waitFor(() => out.includes('── now opencode/y')).catch(stop(child));
  appendFileSync(log, JSON.stringify({ type: 'text', sessionID: 's', part: { text: 'LAST-NO-NEWLINE' } }));
  writeJson(statusFile, { state: 'done', pid: process.pid, model: 'opencode/y', dir: sb.dir,
    summary: { ok: true, model: 'opencode/y', seconds: 1, steps: 0, cost: 0, handoffs: [], errors: [] } });
  const r = await done;
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /�/);
  assert.match(r.stdout, /LAST-NO-NEWLINE/);
  assert.ok(r.stdout.indexOf('LAST-NO-NEWLINE') < r.stdout.indexOf('── done'));
});

test('oc-watch: without a status file it ends once the log stops growing', () => {
  const sb = makeSandbox();
  const log = writeEvents(sb, EVENTS.slice(0, 2));
  const r = runScript(sb, 'oc-watch.mjs', [log, '--poll', '20'], { env: { NO_COLOR: '1', OC_WATCH_IDLE_MS: '100' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /reading the code/);
  assert.match(r.stdout, /no status file and the log stopped growing/);
});

test('oc-watch: a large backlog starts from the last 8 MB', () => {
  const sb = makeSandbox();
  const log = join(sb.dir, 'big.jsonl');
  const filler = JSON.stringify({ type: 'step_start', pad: 'x'.repeat(1000) }) + '\n';
  writeFileSync(log, filler.repeat(9 * 1024) + JSON.stringify({ type: 'text', part: { text: 'tail event' } }) + '\n');
  writeJson(`${log}.status.json`, { state: 'done', pid: 1, model: 'opencode/m', dir: sb.dir,
    summary: { ok: true, model: 'opencode/m', seconds: 1, steps: 0, cost: 0, handoffs: [], errors: [] } });
  const r = watch(sb, log);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /… skipped 1 MB of earlier log/);
  assert.match(r.stdout, /tail event/);
});

test('oc-run: status records base and dirty; a failed start marks it done with the error', () => {
  const sb = makeSandbox(); // no opencode on PATH: the environment check only warns, the spawn fails
  const repo = join(sb.dir, 'repo');
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: sb.env });
  spawnSync('git', ['init', '-q', repo]);
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'base');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  const logFile = join(sb.dir, 'run.jsonl');
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/m', '--dir', repo, '--log', logFile, 'hi']);
  assert.equal(r.status, 2);
  assert.match(r.json.error, /cannot start opencode/);
  const status = JSON.parse(readFileSync(`${logFile}.status.json`, 'utf8'));
  assert.equal(status.base, g('rev-parse', 'HEAD').stdout.trim());
  assert.equal(status.dirty, true);
  assert.equal(status.state, 'done');
  assert.match(status.summary.errors[0], /cannot start opencode/);
  const v = watch(sb, logFile);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /── failed[\s\S]*cannot start opencode/);
  assert.match(v.stdout, /uncommitted changes before the run/);
});

test('oc-run: rex missing from PATH is reported and the run goes on', () => {
  const sb = makeSandbox();
  writeShim(sb);
  const events = writeEvents(sb, EVENTS.slice(0, 2));
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/m', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events, REX_SESSION: 'session:s1' } });
  assert.equal(r.status, 0);
  assert.match(r.json.rex.error, /ENOENT/);
});
