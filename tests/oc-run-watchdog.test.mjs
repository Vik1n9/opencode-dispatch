import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  makeSandbox, runScript, writeShim, SHIM_OK, writeEvents, writeStatus, writeJson, configDir, readJson,
} from './helpers.mjs';
import { rankCandidates } from '../skills/opencode-dispatch/scripts/oc-rank.mjs';

const ROOT = '/private/tmp/claude-501/-Volumes-NAS-Projects/b325e749-62f5-45f8-b747-b10cc1096e70/scratchpad/wt-watch';

function writeEventsFile(sb, lines) {
  const p = join(sb.dir, `events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const FAIL_EVENTS = (sid = 'ses_abc') => [
  { type: 'step_start', sessionID: sid },
  { type: 'error', sessionID: sid, error: { message: 'Rate limit exceeded', status: 429 } },
];
const OK_EVENTS = (sid = 'ses_abc') => [
  { type: 'step_start', sessionID: sid },
  { type: 'text', sessionID: sid, part: { text: 'done' } },
  { type: 'step_finish', sessionID: sid, part: { cost: 0.001, tokens: { input: 5, output: 2, reasoning: 1 } } },
];

test('watchdog (a): live 429 then hang hands off with reason limit', async (t) => {
  const sb = makeSandbox();
  const failFile = writeEventsFile(sb, FAIL_EVENTS());
  const okFile = writeEventsFile(sb, OK_EVENTS());
  const counter = join(sb.dir, 'counter.txt');
  const argvFile = join(sb.dir, 'argv.txt');
  const shimBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.32"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "DeepSeek  API key  stored"; exit 0; fi
if [ "$1" = "run" ]; then
  shift
  echo "$@" >> "${argvFile}"
  n=0
  if [ -f "${counter}" ]; then n=$(cat "${counter}"); fi
  n=$((n+1))
  echo $n > "${counter}"
  if [ "$n" = "1" ]; then
    cat "${failFile}"
    sleep 30
  else
    cat "${okFile}"
  fi
  exit 0
fi
exit 0
`;
  writeFileSync(join(sb.bin, 'opencode'), shimBody);
  chmodSync(join(sb.bin, 'opencode'), 0o755);

  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fallback', 'opencode/y', '--stall', '10', 'do it'],
    { env: { ...SHIM_OK, OC_RUN_STALL_MS: '200', OC_DISPATCH_HOME: join(sb.home, '.config', 'opencode-dispatch') }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const s = r.json;
  assert.equal(s.ok, true);
  assert.equal(s.model, 'opencode/y');
  assert.equal(s.handoffs.length, 1);
  assert.equal(s.handoffs[0].reason, 'limit');
  assert.match(readFileSync(argvFile, 'utf8'), /-s\s+ses_abc/);
  const limits = readJson(join(configDir(sb), 'limits.json'));
  assert.ok(limits['opencode/x'], 'limits.json entry for first model');
});

test('watchdog (b): silent hang hands off with reason stall', async (t) => {
  const sb = makeSandbox();
  const okFile = writeEventsFile(sb, OK_EVENTS());
  const counter = join(sb.dir, 'counter.txt');
  const shimBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.32"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "DeepSeek  API key  stored"; exit 0; fi
if [ "$1" = "run" ]; then
  n=0
  if [ -f "${counter}" ]; then n=$(cat "${counter}"); fi
  n=$((n+1))
  echo $n > "${counter}"
  if [ "$n" = "1" ]; then
    sleep 30
  else
    cat "${okFile}"
  fi
  exit 0
fi
exit 0
`;
  writeFileSync(join(sb.bin, 'opencode'), shimBody);
  chmodSync(join(sb.bin, 'opencode'), 0o755);

  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fallback', 'opencode/y', '--stall', '10', 'do it'],
    { env: { ...SHIM_OK, OC_RUN_STALL_MS: '200', OC_DISPATCH_HOME: join(sb.home, '.config', 'opencode-dispatch') }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const s = r.json;
  assert.equal(s.handoffs.length, 1);
  assert.equal(s.handoffs[0].reason, 'stall');
});

test('watchdog (c): stall with no fallback stops with ok:false stalled:{minutes} exit 1', async (t) => {
  const sb = makeSandbox();
  const shimBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.32"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "DeepSeek  API key  stored"; exit 0; fi
if [ "$1" = "run" ]; then
  sleep 30
  exit 0
fi
exit 0
`;
  writeFileSync(join(sb.bin, 'opencode'), shimBody);
  chmodSync(join(sb.bin, 'opencode'), 0o755);

  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--stall', '10', 'do it'],
    { env: { ...SHIM_OK, OC_RUN_STALL_MS: '200', OC_DISPATCH_HOME: join(sb.home, '.config', 'opencode-dispatch') }, timeout: 30000 });
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.stalled, { minutes: 10 });
});

test('watchdog (d): exhausted fallback list exits 1 ok:false', async (t) => {
  const sb = makeSandbox();
  const failFile = writeEventsFile(sb, FAIL_EVENTS());
  const shimBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.32"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "DeepSeek  API key  stored"; exit 0; fi
if [ "$1" = "run" ]; then
  cat "${failFile}"
  sleep 30
  exit 0
fi
exit 0
`;
  writeFileSync(join(sb.bin, 'opencode'), shimBody);
  chmodSync(join(sb.bin, 'opencode'), 0o755);

  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fallback', 'opencode/y,opencode/z', '--stall', '10', 'do it'],
    { env: { ...SHIM_OK, OC_RUN_STALL_MS: '200', OC_DISPATCH_HOME: join(sb.home, '.config', 'opencode-dispatch') }, timeout: 30000 });
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
});

test('watchdog (e): fallback skipped on low DeepSeek balance', async (t) => {
  const sb = makeSandbox();
  const failFile = writeEventsFile(sb, FAIL_EVENTS());
  const okFile = writeEventsFile(sb, OK_EVENTS());
  const counter = join(sb.dir, 'counter.txt');
  const shimBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.32"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "DeepSeek  API key  stored"; exit 0; fi
if [ "$1" = "run" ]; then
  n=0
  if [ -f "${counter}" ]; then n=$(cat "${counter}"); fi
  n=$((n+1))
  echo $n > "${counter}"
  if [ "$n" = "1" ]; then
    cat "${failFile}"
    sleep 30
  else
    cat "${okFile}"
  fi
  exit 0
fi
exit 0
`;
  writeFileSync(join(sb.bin, 'opencode'), shimBody);
  chmodSync(join(sb.bin, 'opencode'), 0o755);

  writeStatus(sb, { deepseek: { USD: { total: 0.4, at: new Date().toISOString() } }, qwen: { percentLeft: 50, at: new Date().toISOString() } });

  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fallback', 'deepseek/paid,opencode/y', '--stall', '10', 'do it'],
    { env: { ...SHIM_OK, OC_RUN_STALL_MS: '200', OC_DISPATCH_HOME: join(sb.home, '.config', 'opencode-dispatch') }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const s = r.json;
  assert.equal(s.model, 'opencode/y');
  assert.equal(s.handoffs[0].to, 'opencode/y');
});

test('watchdog (f): default fallback follows oc-rank order', async (t) => {
  const sb = makeSandbox();
  const cache = {
    created: '2026-10-19T00:00:00.000Z', probed: true,
    models: [
      { id: 'opencode/x', live: true, context: 400000, probe: { ok: true, seconds: 10 } },
      { id: 'opencode-go/a', live: true, context: 400000, probe: { ok: true, seconds: 10 } },
      { id: 'opencode-go/b', live: true, context: 400000, probe: { ok: true, seconds: 10 } },
      { id: 'opencode/y', live: true, context: 400000, probe: { ok: true, seconds: 10 } },
    ],
  };
  const scores = {
    categories: { 'repo-coding': { label: 'Fix', benchmarks: ['B'] } },
    models: {
      x: { name: 'X', aliases: ['opencode/x'], scores: { B: { value: 50, source: 'vendor' } } },
      ga: { name: 'GA', aliases: ['opencode-go/a'], scores: { B: { value: 80, source: 'vendor' } } },
      gb: { name: 'GB', aliases: ['opencode-go/b'], scores: { B: { value: 79, source: 'vendor' } } },
      y: { name: 'Y', aliases: ['opencode/y'], scores: { B: { value: 70, source: 'vendor' } } },
    },
  };
  const cachePath = join(sb.dir, 'cache.json');
  const scoresPath = join(sb.dir, 'scores.json');
  writeJson(cachePath, cache);
  writeJson(scoresPath, scores);
  writeJson(join(configDir(sb), 'benchmarks.json'), scores);

  const expectedFirst = rankCandidates(cache, 'repo-coding', { table: scores })[0];

  const failFile = writeEventsFile(sb, FAIL_EVENTS());
  const okFile = writeEventsFile(sb, OK_EVENTS());
  const counter = join(sb.dir, 'counter.txt');
  const shimBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.32"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "DeepSeek  API key  stored"; exit 0; fi
if [ "$1" = "run" ]; then
  n=0
  if [ -f "${counter}" ]; then n=$(cat "${counter}"); fi
  n=$((n+1))
  echo $n > "${counter}"
  if [ "$n" = "1" ]; then
    cat "${failFile}"
    sleep 30
  elif [ "$n" = "2" ]; then
    cat "${failFile}"
    sleep 30
  else
    cat "${okFile}"
  fi
  exit 0
fi
exit 0
`;
  writeFileSync(join(sb.bin, 'opencode'), shimBody);
  chmodSync(join(sb.bin, 'opencode'), 0o755);

  const r = runScript(sb, 'oc-run.mjs',
    ['--model', 'opencode/x', '--fallback', 'default', '--task', 'repo-coding', '--cache', cachePath, '--stall', '10', 'do it'],
    { env: { ...SHIM_OK, OC_RUN_STALL_MS: '200', OC_DISPATCH_HOME: join(sb.home, '.config', 'opencode-dispatch') }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const s = r.json;
  assert.equal(s.handoffs[0].to, expectedFirst);
  assert.ok(s.handoffs.length >= 2, 'expected a second handoff');
  assert.notEqual(s.handoffs[1].to, 'opencode-go/b');
});

test('watchdog (g): validation exits 2', async (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  let r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fallback', 'default', 'hi'],
    { env: SHIM_OK });
  assert.equal(r.status, 2);
  r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--stall', '-1', 'hi'],
    { env: SHIM_OK });
  assert.equal(r.status, 2);
  r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--stall', 'abc', 'hi'],
    { env: SHIM_OK });
  assert.equal(r.status, 2);
  r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', '--fallback', 'opencode/y,', 'hi'],
    { env: SHIM_OK });
  assert.equal(r.status, 2);
});

test('watchdog (h): no flags normal run keeps new optional fields', async (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const events = writeEvents(sb, [
    { type: 'step_start', sessionID: 'ses_abc' },
    { type: 'text', sessionID: 'ses_abc', part: { text: 'all done' } },
    { type: 'step_finish', sessionID: 'ses_abc', part: { cost: 0.01, tokens: { input: 5, output: 2, reasoning: 1 } } },
  ]);
  const r = runScript(sb, 'oc-run.mjs', ['--model', 'opencode/x', 'hi'],
    { env: { ...SHIM_OK, OC_SHIM_EVENTS: events } });
  assert.equal(r.status, 0);
  const s = r.json;
  assert.equal(s.ok, true);
  assert.equal(s.text, 'all done');
  assert.deepEqual(s.handoffs, []);
  assert.equal(s.segments.length, 1);
  assert.deepEqual(s.warnings, []);
});
