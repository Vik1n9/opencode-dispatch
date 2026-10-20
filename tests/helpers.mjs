// Shared fixtures for the oc-track / oc-rank tests. Every test gets its own temp data folder; the real
// ~/.config/opencode-dispatch and ~/.cache/opencode-dispatch are never touched.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('..', import.meta.url));
export const trackScript = join(repo, 'skills/opencode-dispatch/scripts/oc-track.mjs');
export const rankScript = join(repo, 'skills/opencode-dispatch/scripts/oc-rank.mjs');

export const tempHome = () => mkdtempSync(join(tmpdir(), 'oc-dispatch-test-'));

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function writeBenchmarks(home, table) {
  writeJson(join(home, 'benchmarks.json'), table);
}

export function run(script, args, home, env = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OC_DISPATCH_HOME: home, ...env },
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
    },
  };
}

export function writeCache(home, ids, { created = new Date().toISOString(), updated, probed = true } = {}) {
  const cache = {
    created,
    ...(updated ? { updated } : {}),
    probed,
    models: ids.map((id) => ({
      id,
      name: id,
      live: true,
      context: 200000,
      probe: { ok: true, seconds: id.startsWith('opencode/') ? 6 : 5 },
    })),
  };
  writeJson(join(home, 'cache.json'), cache);
  return cache;
}
