#!/usr/bin/env node
// Check that the installed opencode CLI is a supported major version.
// The scripts depend on opencode 2.x behavior (`run --format json` event shapes, `-s` / `--fork`,
// $PWD project selection, `models` output), so any other major version is refused.
//
// Usage:
//   node oc-version.mjs           prints the result; exit 0 when supported, 1 otherwise
//   import { checkOpencode } from './oc-version.mjs'
//     -> { ok, version, error }

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_MAJOR = 2;

export function checkOpencode() {
  const r = spawnSync('opencode', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, version: null, error: `cannot run opencode: ${r.error.message}` };
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
  if (!m) return { ok: false, version: null, error: `cannot read the opencode version from: ${(r.stdout || r.stderr).trim()}` };
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (Number(m[1]) !== SUPPORTED_MAJOR) {
    return { ok: false, version, error: `opencode ${version} is not supported; only opencode ${SUPPORTED_MAJOR}.x works with these scripts` };
  }
  return { ok: true, version, error: null };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = checkOpencode();
  console.log(r.ok ? `ok       opencode ${r.version}` : `error    ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
