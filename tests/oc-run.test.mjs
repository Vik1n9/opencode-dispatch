import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeSandbox, runScript, writeShim, SHIM_OK, writeEvents, spawnScript, waitFor, isAlive,
  configDir, readJson,
} from './helpers.mjs';

const base = () => {
  const sb = makeSandbox();
  writeShim(sb);
  return sb;
};

const EVENTS = [
  { type: 'step_start', sessionID: 'ses_abc' },
  { type: 'text', sessionID: 'ses_abc', part: { text: 'looking around' } },
  { type: 'tool_use', sessionID: 'ses_abc', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls -la' } } } },
  { type: 'step_finish', sessionID: 'ses_abc', part: { cost: 0.0123456, tokens: { input: 100, output: 20, reasoning: 5 } } },
  { type: 'text', sessionID: 'ses_abc', part: { text: 'all done' } },
  { type: 'step_finish', sessionID: 'ses_abc', part: { cost: 0.0000044, tokens: { input: 10, output: 2, reasoning: 1 } } },
];

test('oc-run: --model is required', (t) => {
  const sb = base();
  const r = runScript(sb, 'oc-run.mjs', ['hello'], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /--model is required/);
});

test('oc-run: unknown option exits 2', (t) => {
  const sb = base();
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--bogus', 'hi'], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.match(r.json.error, /unknown option: --bogus/);
});

test('oc-run: bad --agent exits 2', (t) => {
  const sb = base();
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--agent', 'yolo', 'hi'], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.match(r.json.error, /unknown agent: yolo/);
});

test('oc-run: missing --prompt-file exits 2', (t) => {
  const sb = base();
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--prompt-file', join(sb.dir, 'nope.txt')], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.match(r.json.error, /cannot read --prompt-file/);
});

test('oc-run: -- separator reaches the shim as literal prompt text', (t) => {
  const sb = base();
  const argvFile = join(sb.dir, 'argv.txt');
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_1', part: { text: 'ok' } }]);
  const r = runScript(sb, 'oc-run.mjs',
    ['--model', 'opencode/x', '--', '--model', 'literal', '--weird'], { env: { ...SHIM_OK, OC_SHIM_ARGV: argvFile, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0);
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.equal(argv.at(-1), '--model literal --weird');
  assert.ok(!argv.includes('--weird'));
});

test('oc-run: --log creates a new folder and reports it', (t) => {
  const sb = base();
  const log = join(sb.dir, 'deep', 'nested', 'run.jsonl');
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_1', part: { text: 'ok' } }]);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--log', log, 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0);
  assert.equal(r.json.log, log);
  assert.ok(existsSync(log));
  assert.match(readFileSync(log, 'utf8'), /"ses_1"/);
});

test('oc-run: exits 1 when the run produced no sessionID', (t) => {
  const sb = base();
  const events = writeEvents(sb, [{ type: 'text', part: { text: 'no session' } }]);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.sessionID, null);
});

test('oc-run: normal run summary fields', (t) => {
  const sb = base();
  const events = writeEvents(sb, EVENTS);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--agent', 'plan', '--title', 'T', 'do it'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0);
  const s = r.json;
  assert.equal(s.ok, true);
  assert.equal(s.sessionID, 'ses_abc');
  assert.equal(s.text, 'all done');
  assert.equal(s.steps, 2);
  assert.equal(s.cost, 0.01235);
  assert.deepEqual(s.tokens, { input: 110, output: 22, reasoning: 6 });
  assert.deepEqual(s.tools, ['bash:completed ls -la']);
  assert.equal(s.title, 'T');
  assert.equal(s.agent, 'plan');
  assert.equal(s.model, 'opencode/x');
  assert.ok(s.seconds >= 0);
});

test('oc-run: group SIGINT does not stop the run', { skip: process.platform === 'win32' && 'needs POSIX process groups' }, async () => {
  const sb = base();
  const pidFile = join(sb.dir, 'shim.pid');
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_int', part: { text: 'finished' } }]);
  const { child, done } = spawnScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_PID: pidFile, OC_SHIM_EVENTS: events, OC_SHIM_SLEEP: '1.2' } });
  await waitFor(() => existsSync(pidFile));
  process.kill(-child.pid, 'SIGINT');
  const r = await done;
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.text, 'finished');
  assert.ok(r.json.errors.includes('ignored SIGINT'));
});

test('oc-run: SIGTERM stops the run and leaves no shim process', { skip: process.platform === 'win32' && 'needs POSIX process groups' }, async () => {
  const sb = base();
  const pidFile = join(sb.dir, 'shim.pid');
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_term', part: { text: 'never' } }]);
  const { child, done } = spawnScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_PID: pidFile, OC_SHIM_EVENTS: events, OC_SHIM_SLEEP: '30' } });
  const shimPid = Number(await waitFor(() => {
    if (!existsSync(pidFile)) return null;
    const v = readFileSync(pidFile, 'utf8').trim();
    return v ? v : null;
  }));
  process.kill(child.pid, 'SIGTERM');
  const r = await done;
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.errors.includes('stopped by SIGTERM'));
  await waitFor(() => !isAlive(shimPid), 5000);
  assert.equal(isAlive(shimPid), false);
});

test('oc-run: --fork without --session exits 2', (t) => {
  const sb = base();
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fork', 'hi'], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.match(r.json.error, /--fork needs --session/);
});

test('oc-run: --prompt-file, --session, --fork and --title reach the shim', (t) => {
  const sb = base();
  const argvFile = join(sb.dir, 'argv.txt');
  const promptFile = join(sb.dir, 'prompt.txt');
  writeFileSync(promptFile, 'long task from a file');
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_1', part: { text: 'ok' } }]);
  const r = runScript(sb, 'oc-run.mjs',
    ['--model', 'opencode/x', '--session', 'ses_old', '--fork', '--title', 'T', '--prompt-file', promptFile],
    { env: { ...SHIM_OK, OC_SHIM_ARGV: argvFile, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.deepEqual(argv, ['--format', 'json', '-m', 'opencode/x', '--agent', 'build',
    '-s', 'ses_old', '--fork', '--title', 'T', 'long task from a file']);
});

test('oc-run: a non-zero opencode exit is a failed run with exit 1', (t) => {
  const sb = base();
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_1', part: { text: 'partial' } }]);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events, OC_SHIM_RUN_EXIT: '3' } });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.exitCode, 3);
  assert.equal(r.json.text, 'partial');
  assert.equal(r.status, 1);
});

test('oc-run: the default log lives under $TMPDIR/oc-run', (t) => {
  const sb = base();
  const events = writeEvents(sb, [{ type: 'text', sessionID: 'ses_1', part: { text: 'ok' } }]);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'], { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0);
  assert.equal(r.json.log.startsWith(join(sb.tmp, 'oc-run')), true);
  assert.ok(existsSync(r.json.log));
});

test('oc-run: a failed environment check exits 2', (t) => {
  const sb = base();
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'], { env: { ...SHIM_OK, CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /cloud session/);
});

const QUOTA_EVENT = {
  type: 'error',
  sessionID: 'ses_q',
  error: {
    type: 'provider.quota',
    message: 'Rate limit exceeded. Please try again later.',
    status: 429,
    response: { body: '{"type":"error","error":{"type":"FreeUsageLimitError"}}' },
  },
};
const limitsPath = (sb) => join(configDir(sb), 'limits.json');

test('oc-run: a quota event sets rateLimited and records the hit at hit + 1 h', (t) => {
  const sb = base();
  const events = writeEvents(sb, [QUOTA_EVENT]);
  const started = Date.now();
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'], { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.rateLimited, true);
  assert.deepEqual(r.json.limit, { type: 'provider.quota', message: 'Rate limit exceeded. Please try again later.' });

  const entry = readJson(limitsPath(sb)).models['opencode/x'];
  assert.equal(entry.probes, 0);
  assert.equal(entry.message, 'Rate limit exceeded. Please try again later.');
  const hit = new Date(entry.hitAt).getTime();
  const next = new Date(entry.nextProbe).getTime();
  assert.equal(next - hit, 60 * 60 * 1000);
  assert.ok(hit >= started - 5000 && hit <= Date.now() + 5000, `hitAt ${entry.hitAt}`);
});

test('oc-run: a normal run is not rate limited', (t) => {
  const sb = base();
  const events = writeEvents(sb, EVENTS);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'], { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.rateLimited, false);
  assert.equal(r.json.limit, null);
  assert.equal(existsSync(limitsPath(sb)), false);
});

test('oc-run: a later successful run clears the pause', (t) => {
  const sb = base();
  const limited = writeEvents(sb, [QUOTA_EVENT]);
  const failed = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: limited } });
  assert.equal(failed.status, 1);
  assert.ok(readJson(limitsPath(sb)).models['opencode/x']);

  const ok = writeEvents(sb, EVENTS);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: ok } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.rateLimited, false);
  assert.equal('opencode/x' in readJson(limitsPath(sb)).models, false);
});
