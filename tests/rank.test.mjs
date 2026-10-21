import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { benchTable, rankScript, run, tempHome, writeBenchmarks, writeCache, writeJson } from './helpers.mjs';

function homeWith(ids, cacheOptions) {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  writeCache(home, ids, cacheOptions);
  return home;
}

const rank = (home, ...args) => run(rankScript, ['--task', 'repo-coding', ...args], home,
  { OC_DISPATCH_CACHE: join(home, 'cache.json') });
const pickOf = (out) => out.match(/pick: (\S+)/)?.[1] ?? null;

test('rank: clear leader wins', () => {
  const home = homeWith(['vendor/strong', 'vendor/weak']);
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.equal(pickOf(r.stdout), 'vendor/strong');
});

test('rank: a Qwen token-plan model within 10 points wins', () => {
  const home = homeWith(['vendor/strong', 'bailian-token-plan-personal/qwen-good', 'opencode/free-good']);
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  // Strong 90, Qwen 82 -> gap 8 (close); the token plan beats the free / paid entries.
  assert.equal(pickOf(r.stdout), 'bailian-token-plan-personal/qwen-good');
});

test('rank: free beats paid when capability is close', () => {
  const home = homeWith(['vendor/strong', 'opencode/free-good']);
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  // Strong 90 vs free 85 -> gap 5 (same capability); equal-enough speed, so the free plan wins.
  assert.equal(pickOf(r.stdout), 'opencode/free-good');
});

test('rank: missing inventory cache exits 2', () => {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  const r = rank(home);
  assert.equal(r.code, 2);
  assert.match(r.out, /no inventory cache — run: node oc-models\.mjs --probe/);
});

test('rank: stale inventory cache warns and continues', () => {
  const home = homeWith(['vendor/strong', 'vendor/weak'], { created: new Date(Date.now() - 48 * 3600e3).toISOString() });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /inventory cache is 4[78]h old — re-run oc-models\.mjs --probe/);
  assert.equal(pickOf(r.stdout), 'vendor/strong');
});

test('rank: a model blocked until later is excluded and listed', () => {
  const home = homeWith(['vendor/strong', 'bailian-token-plan-personal/qwen-good']);
  writeJson(join(home, 'limits.json'), {
    'bailian-token-plan-personal/qwen-good': {
      until: new Date(Date.now() + 3600e3).toISOString(), source: 'message', message: 'rate limited', hits: 1,
      at: new Date().toISOString(),
    },
  });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /limited: bailian-token-plan-personal\/qwen-good until .+ \(message\)/);
  assert.equal(pickOf(r.stdout), 'vendor/strong');
  assert.ok(!r.stdout.split('\n').some((l) => l.startsWith('  bailian-token-plan-personal/qwen-good')),
    'the blocked model must not be ranked');
});

test('rank: an expired limit is ranked normally', () => {
  const home = homeWith(['vendor/strong', 'bailian-token-plan-personal/qwen-good']);
  writeJson(join(home, 'limits.json'), {
    'bailian-token-plan-personal/qwen-good': {
      until: new Date(Date.now() - 3600e3).toISOString(), source: 'estimate', message: 'rate limited', hits: 1,
      at: new Date(Date.now() - 7200e3).toISOString(),
    },
  });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.equal(pickOf(r.stdout), 'bailian-token-plan-personal/qwen-good');
  assert.doesNotMatch(r.stdout, /limited:/);
});

test('rank: a no-reset limit needs owner action', () => {
  const home = homeWith(['vendor/strong', 'bailian-token-plan-personal/qwen-good']);
  writeJson(join(home, 'limits.json'), {
    'bailian-token-plan-personal/qwen-good': {
      until: null, source: 'no-reset', message: 'quota exhausted', hits: 2, at: new Date().toISOString(),
    },
  });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /limited: bailian-token-plan-personal\/qwen-good — needs owner action/);
  assert.equal(pickOf(r.stdout), 'vendor/strong');
});

test('rank: internal score line shows correctness, quality and count', () => {
  const home = homeWith(['alpha/one', 'vendor/weak']);
  writeJson(join(home, 'internal.json'), {
    generated: new Date().toISOString(),
    models: {
      alpha: {
        'repo-coding': {
          score: 82, correctness: 100, quality: null, qn: 0, n: 12,
          updated: '2026-10-12', speed: { 'alpha/one': { ratio: 1.5, n: 3, medianSeconds: 20 } },
        },
      },
    },
  });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /internal 82 \(c 100 \/ q –, 12\)/);
  assert.match(r.stdout, /task speed x1\.5/);
});

test('rank: without task speed, a slower free entry beats a faster Go entry of the same model', () => {
  const home = homeWith(['opencode-go/dup', 'opencode/dup-free'], { seconds: { 'opencode-go/dup': 2, 'opencode/dup-free': 20 } });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.equal(pickOf(r.stdout), 'opencode/dup-free');
  assert.match(r.stdout, /chosen by plan \(free first\)/);
});

test('rank: without task speed, a slow free model within 5 points beats a fast paid one', () => {
  const home = homeWith(['vendor/strong', 'opencode/free-good'], { seconds: { 'vendor/strong': 1, 'opencode/free-good': 29 } });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.equal(pickOf(r.stdout), 'opencode/free-good');
});

test('rank: measured task speed for every candidate still decides', () => {
  const home = homeWith(['opencode-go/dup', 'opencode/dup-free'], { seconds: { 'opencode-go/dup': 9, 'opencode/dup-free': 1 } });
  writeJson(join(home, 'internal.json'), { generated: 'test', models: { dup: { 'repo-coding': {
    score: 90, correctness: 90, quality: null, qn: 0, n: 2, updated: '2026-10-21',
    speed: { 'opencode/dup-free': { ratio: 3, n: 1, medianSeconds: 300 }, 'opencode-go/dup': { ratio: 1, n: 1, medianSeconds: 100 } },
  } } } });
  const r = rank(home);
  assert.equal(r.code, 0, r.out);
  assert.equal(pickOf(r.stdout), 'opencode-go/dup');
  assert.match(r.stdout, /speed compared by measured task speed/);
});
