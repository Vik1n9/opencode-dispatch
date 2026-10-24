#!/usr/bin/env node
// Check that this machine can run the dispatch scripts, before any of them touches opencode:
//   1. local machine only — cloud sessions and containers are refused (opencode is missing or
//      not logged in there, so the dispatch fails in confusing ways);
//   2. opencode is on PATH;
//   3. it is a supported major version (2.x) — the scripts depend on its behavior
//      (`run --format json` event shapes, `-s` / `--fork`, $PWD project selection,
//      `api GET /api/model`, `session list` / `session delete`, `auth list`);
//   4. at least one provider is logged in — without a credential every dispatch fails.
//
// Usage:
//   node oc-check.mjs                  prints the result; exit 0 ok, 1 blocked, 3 missing opencode/credential
//   import { checkEnvironment } from './oc-check.mjs'
//     -> { ok, code: 'ok'|'blocked'|'missing', version, credentials, error }
//
// Output lines: `ok ...` (exit 0), `blocked  <error>` (exit 1), `missing  <error>` (exit 3).
//
// The credential rows printed by `opencode auth list` are never returned or logged — only the count.
// A cold opencode start can exceed the normal timeout right after a reboot, so both commands retry
// once with a 45 s timeout.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_MAJOR = 2;

// Claude Code marks a cloud session; the rest mark containers / devcontainers / Codespaces.
const CLOUD_TRUE = ['CLAUDE_CODE_REMOTE', 'CODESPACES', 'REMOTE_CONTAINERS'];
const CLOUD_SET = ['GITPOD_WORKSPACE_ID', 'DEVCONTAINER', 'KUBERNETES_SERVICE_HOST', 'container'];
const CONTAINER_FILES = ['/.dockerenv', '/run/.containerenv'];

// Case-insensitive value sets: these variables must be present *and* on for a container/cloud.
const TRUE_VALUES = ['true', '1', 'yes'];
const OFF_VALUES = ['', '0', 'false', 'no'];
const isTrue = (v) => TRUE_VALUES.includes((v ?? '').trim().toLowerCase());
const isOff = (v) => OFF_VALUES.includes((v ?? '').trim().toLowerCase());

// Which signal says "not the local machine" (null when none does). Plain SSH is allowed.
// Exported so the dispatch scripts can refuse cloud sessions and containers before anything else,
// while treating a missing / unsupported opencode as a warning (install.sh fixes it later).
export function cloudSignal() {
  for (const name of CLOUD_TRUE) {
    const value = process.env[name];
    if (isTrue(value)) {
      return name === 'CLAUDE_CODE_REMOTE'
        ? `running in a cloud session (CLAUDE_CODE_REMOTE=${value}); this skill only works on the local machine`
        : `running in a cloud session or container (${name}=${value}); this skill only works on the local machine`;
    }
  }
  for (const name of CLOUD_SET) {
    const value = process.env[name];
    if (!isOff(value)) {
      return `running in a container (${name} is set); this skill only works on the local machine`;
    }
  }
  for (const file of CONTAINER_FILES) {
    try {
      if (existsSync(file)) return `running in a container (${file} exists); this skill only works on the local machine`;
    } catch { /* unreadable path: treat as absent */ }
  }
  if (process.platform === 'linux') {
    try {
      const m = /docker|kubepods|containerd|lxc|libpod/.exec(readFileSync('/proc/1/cgroup', 'utf8'));
      if (m) return `running in a container (/proc/1/cgroup matches ${m[0]}); this skill only works on the local machine`;
    } catch { /* no /proc/1/cgroup: not a container */ }
  }
  return null;
}

// One credential row, e.g. `DeepSeek   API key   stored`. Count rows ending in `stored` or `env*`.
function countCredentials(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const last = line.trim().split(/\s+/).at(-1).toLowerCase();
    if (last === 'stored' || last.startsWith('env')) n++;
  }
  return n;
}

// A cold opencode start can exceed the normal timeout; retry once with a longer one.
function runOpencode(args) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 };
  const first = spawnSync('opencode', args, options);
  if (first.error?.code !== 'ETIMEDOUT') return first;
  return spawnSync('opencode', args, { ...options, timeout: 45000 });
}

export function checkEnvironment() {
  const cloud = cloudSignal();
  if (cloud) return { ok: false, code: 'blocked', version: null, credentials: null, error: cloud };

  const v = runOpencode(['--version']);
  if (v.error) {
    if (v.error.code === 'ENOENT') {
      return { ok: false, code: 'missing', version: null, credentials: null, error: 'opencode is not installed on this machine; install opencode 2.x first' };
    }
    return { ok: false, code: 'missing', version: null, credentials: null, error: `cannot run opencode: ${v.error.message}` };
  }
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${v.stdout}${v.stderr}`);
  if (!m) return { ok: false, code: 'blocked', version: null, credentials: null, error: `cannot read the opencode version from: ${(v.stdout || v.stderr).trim()}` };
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (Number(m[1]) !== SUPPORTED_MAJOR) {
    return { ok: false, code: 'blocked', version, credentials: null, error: `opencode ${version} is not supported; only opencode ${SUPPORTED_MAJOR}.x works with these scripts` };
  }

  const a = runOpencode(['auth', 'list']);
  if (a.error || a.status !== 0) {
    const why = a.error
      ? (a.error.code === 'ETIMEDOUT' ? 'timed out' : a.error.message)
      : `exited ${a.status}`;
    return { ok: false, code: 'missing', version, credentials: 0, error: `cannot read the opencode credentials (opencode auth list ${why}); opencode may still be starting, run the check again` };
  }
  const credentials = countCredentials(`${a.stdout}\n${a.stderr}`);
  if (credentials === 0) {
    return { ok: false, code: 'missing', version, credentials: 0, error: 'opencode has no logged-in provider; run `opencode auth login` on this machine first' };
  }

  return { ok: true, code: 'ok', version, credentials, error: null };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = checkEnvironment();
  console.log(r.ok ? `ok       local machine, opencode ${r.version}, ${r.credentials} credentials` : `${r.code}  ${r.error}`);
  process.exit(r.ok ? 0 : r.code === 'missing' ? 3 : 1);
}
