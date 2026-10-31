// Shared helpers: every test runs the real scripts as child processes with a temp HOME and a
// PATH whose first entry holds a fake `opencode`, so nothing touches the real HOME or the network.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const repo = ROOT;
export const SCRIPTS = join(ROOT, 'skills', 'opencode-dispatch', 'scripts');
export const trackScript = join(SCRIPTS, 'oc-track.mjs');
export const rankScript = join(SCRIPTS, 'oc-rank.mjs');

// The scripts refuse cloud sessions and containers; tests must not inherit the caller's markers.
// OC_DISPATCH_HOME / OC_DISPATCH_CACHE are stripped too: every test points them at its own temp folder,
// and an inherited value would redirect the scripts into the caller's data (or the suite's .testhome).
// REX_* is stripped so oc-run never opens a real Rex tab from a test run inside Rex.
const CLOUD_VARS = ['CLAUDE_CODE_REMOTE', 'CODESPACES', 'REMOTE_CONTAINERS', 'GITPOD_WORKSPACE_ID',
  'DEVCONTAINER', 'KUBERNETES_SERVICE_HOST', 'container', 'OC_DISPATCH_HOME', 'OC_DISPATCH_CACHE',
  'REX_SESSION', 'REX_BLOCK', 'REX_SERVER', 'REX_CLIENT'];

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of CLOUD_VARS) delete env[k];
  return env;
}

// Sandboxes and spawned children are cleaned up when the test process exits, so cleanup still
// happens on a failing test and works on Node 18.0 (no testContext.after).
const SANDBOXES = [];
const CHILDREN = [];
process.on('exit', () => {
  for (const child of CHILDREN) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true });
});

// A sandbox owns a temp dir with home/, bin/ and tmp/.
export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-dispatch-test-'));
  SANDBOXES.push(dir);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const tmp = join(dir, 'tmp');
  for (const p of [home, bin, tmp]) mkdirSync(p, { recursive: true });
  const env = {
    ...cleanEnv(),
    HOME: home,
    TMPDIR: tmp,
    // node must stay reachable (install.sh calls `node` by name); the shim comes first.
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  };
  return { dir, home, bin, tmp, env };
}

const SHIM = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "\${OC_SHIM_VERSION:-2.0.32}"
  exit "\${OC_SHIM_VERSION_EXIT:-0}"
fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then
  if [ -n "\${OC_SHIM_AUTH_OUT:-}" ]; then printf '%s\\n' "$OC_SHIM_AUTH_OUT"; fi
  exit "\${OC_SHIM_AUTH_EXIT:-0}"
fi
if [ "$1" = "run" ]; then
  shift
  if [ -n "\${OC_SHIM_ARGV:-}" ]; then printf '%s\\n' "$@" > "$OC_SHIM_ARGV"; fi
  if [ -n "\${OC_SHIM_PID:-}" ]; then printf '%s\\n' "$$" > "$OC_SHIM_PID"; fi
  if [ -n "\${OC_SHIM_SLEEP:-}" ]; then sleep "$OC_SHIM_SLEEP"; fi
  if [ -n "\${OC_SHIM_TOUCH:-}" ]; then : > "$OC_SHIM_TOUCH"; fi
  if [ -n "\${OC_SHIM_EVENTS:-}" ]; then cat "$OC_SHIM_EVENTS"; fi
  exit "\${OC_SHIM_RUN_EXIT:-0}"
fi
exit 0
`;

// Writes the fake opencode. It answers --version and `auth list` (one stored credential by
// default), records `run` argv, then prints the JSONL events named by OC_SHIM_EVENTS.
export function writeShim(sb) {
  const path = join(sb.bin, 'opencode');
  writeFileSync(path, SHIM);
  chmodSync(path, 0o755);
  return path;
}

// Env for a shim run that passes oc-check: version 2.0.32 and one stored credential.
export const SHIM_OK = { OC_SHIM_AUTH_OUT: 'DeepSeek  API key  stored' };

function finish(r) {
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not every script prints JSON */ }
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json, error: r.error };
}

// Run one script synchronously; env is merged over the sandbox env.
export function runScript(sb, name, args = [], { env = {}, cwd, timeout = 20000 } = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, name), ...args], {
    encoding: 'utf8', env: { ...sb.env, ...env }, cwd: cwd ?? sb.dir, timeout,
  });
  return finish(r);
}

// Run a shell command (install.sh) with the sandbox env.
export function runBash(sb, args = [], { env = {}, cwd } = {}) {
  const r = spawnSync('bash', args, {
    encoding: 'utf8', env: { ...sb.env, ...env }, cwd: cwd ?? ROOT, timeout: 30000,
  });
  return finish(r);
}

// Async variant for signal tests: the script becomes its own process group leader so the test
// can send group SIGINT without signalling itself.
export function spawnScript(sb, name, args = [], { env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [join(SCRIPTS, name), ...args], {
    env: { ...sb.env, ...env }, cwd: cwd ?? sb.dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  CHILDREN.push(child);
  const done = new Promise((resolve) => {
    child.on('close', (status, signal) => {
      CHILDREN.splice(CHILDREN.indexOf(child), 1);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* no summary */ }
      resolve({ status, signal, stdout, stderr, json });
    });
  });
  return { child, done };
}

export async function waitFor(fn, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function configDir(sb) {
  return join(sb.home, '.config', 'opencode-dispatch');
}

export function writeTrack(sb, lines) {
  const path = join(configDir(sb), 'track.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

export function writeStatus(sb, data) {
  writeJson(join(sb.home, 'Library', 'Application Support', 'TokenBar', 'status.json'), data);
}

export function writeEvents(sb, lines) {
  const path = join(sb.dir, `events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

/* ---------- Data-folder fixtures (the oc-track / oc-rank / compare suites) ---------- */

export const tempHome = () => mkdtempSync(join(tmpdir(), 'oc-dispatch-test-'));

export function writeBenchmarks(home, table) {
  writeJson(join(home, 'benchmarks.json'), table);
}

export function run(script, args, home, env = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...cleanEnv(), OC_DISPATCH_HOME: home, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr };
}

export function readInternal(home) {
  return JSON.parse(readFileSync(join(home, 'internal.json'), 'utf8'));
}

export function record(overrides = {}) {
  return {
    date: '2026-10-20',
    project: 'test',
    task: 'test task',
    category: 'repo-coding',
    model: 'alpha/one',
    result: 'passed',
    returns: 0,
    defects: [],
    scope: 0,
    seconds: 30,
    steps: 5,
    ...overrides,
  };
}

// Small curated table: one category with one comparable benchmark, four plans + a weak model.
export function benchTable() {
  const bench = (value) => ({ value, source: 'vendor', ref: 'https://example.invalid' });
  return {
    _about: 'test fixture',
    categories: {
      'repo-coding': { label: 'Coding', benchmarks: ['Bench A'] },
      terminal: { label: 'Terminal', benchmarks: ['Bench B'] },
    },
    models: {
      alpha: { name: 'Alpha', aliases: ['alpha/one'], scores: { 'Bench A': bench(80) } },
      beta: { name: 'Beta', aliases: ['beta/two'], scores: { 'Bench B': bench(70) } },
      strong: { name: 'Strong', aliases: ['vendor/strong'], scores: { 'Bench A': bench(90) } },
      second: { name: 'Second', aliases: ['vendor/second'], scores: { 'Bench A': bench(80) } },
      'free-good': { name: 'Free Good', aliases: ['opencode/free-good'], scores: { 'Bench A': bench(85) } },
      qwen: { name: 'Qwen', aliases: ['bailian-token-plan-personal/qwen-good'], scores: { 'Bench A': bench(82) } },
      weak: { name: 'Weak', aliases: ['vendor/weak'], scores: { 'Bench A': bench(60) } },
      dup: { name: 'Dup', aliases: ['opencode/dup-free', 'opencode-go/dup'], scores: { 'Bench A': bench(88) } },
    },
  };
}

export function writeCache(home, ids, { created = new Date().toISOString(), updated, probed = true, seconds = {} } = {}) {
  const cache = {
    created,
    ...(updated ? { updated } : {}),
    probed,
    models: ids.map((id) => ({
      id,
      name: id,
      live: true,
      context: 200000,
      probe: { ok: true, seconds: seconds[id] ?? (id.startsWith('opencode/') ? 6 : 5) },
    })),
  };
  writeJson(join(home, 'cache.json'), cache);
  return cache;
}
