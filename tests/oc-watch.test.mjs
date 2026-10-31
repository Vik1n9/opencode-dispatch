import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, runScript, writeShim, SHIM_OK, writeEvents, writeJson } from './helpers.mjs';

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
  const dead = spawnSync('true').pid;
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
