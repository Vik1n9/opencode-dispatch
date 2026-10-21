import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { repo } from './helpers.mjs';

const libScript = join(repo, 'skills/opencode-dispatch/scripts/lib.mjs');
let imports = 0;

// lib.mjs resolves the data folder and cache at import time, so every test that touches files imports a
// fresh module instance after pointing the environment at its own temp folder.
async function freshLib(home, env = {}) {
  process.env.OC_DISPATCH_HOME = home;
  if (env.OC_DISPATCH_CACHE === undefined) delete process.env.OC_DISPATCH_CACHE;
  Object.assign(process.env, env);
  return import(`${pathToFileURL(libScript).href}?t=${imports++}`);
}

const tempHome = () => mkdtempSync(join(tmpdir(), 'oc-lib-test-'));

test('LIMIT_RE matches limit and quota errors, not ordinary failures', async () => {
  const { LIMIT_RE } = await freshLib(tempHome());
  const positives = [
    'rate limit exceeded',
    'Rate-Limited',
    'too many requests',
    'HTTP 429 Too Many Requests',
    'quota exceeded for this model',
    'usage limit reached',
    'limit reached',
    'limit exceeded',
    'You have exceeded your monthly allowance',
    'insufficient balance',
    'insufficient credit',
    'insufficient funds',
    'resource exhausted',
    'RESOURCE_EXHAUSTED',
    'credit balance is empty',
  ];
  for (const text of positives) assert.match(text, LIMIT_RE, text);
  const negatives = ['model not found', 'invalid api key', 'request timed out', 'context length exceeded'];
  for (const text of negatives) assert.doesNotMatch(text, LIMIT_RE, text);
});

test('parseReset: Retry-After in seconds', async () => {
  const { parseReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  for (const msg of ['Retry-After: 120', 'retry after 120 seconds', '{"retry_after": 120}']) {
    assert.equal(parseReset(msg, now).toISOString(), '2026-10-20T10:02:00.000Z', msg);
  }
});

test('parseReset: relative durations', async () => {
  const { parseReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(parseReset('try again in 1h 2m 3s', now).toISOString(), '2026-10-20T11:02:03.000Z');
  assert.equal(parseReset('please try again in 45 minutes', now).toISOString(), '2026-10-20T10:45:00.000Z');
  assert.equal(parseReset('retry in 30s', now).toISOString(), '2026-10-20T10:00:30.000Z');
});

test('parseReset: ISO time in a reset message', async () => {
  const { parseReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(parseReset('quota resets at 2026-10-21T00:00:00Z', now).toISOString(), '2026-10-21T00:00:00.000Z');
  assert.equal(parseReset('reset at 2026-10-21T08:30:00+08:00', now).toISOString(), '2026-10-21T00:30:00.000Z');
  assert.equal(parseReset('window closed; reset 2026-10-21T00:00:00.500Z', now).toISOString(), '2026-10-21T00:00:00.500Z');
});

test('parseReset: unix reset in seconds and milliseconds', async () => {
  const { parseReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  const seconds = Math.floor(now.getTime() / 1000) + 600;
  assert.equal(parseReset(`"reset": ${seconds}`, now).toISOString(), '2026-10-20T10:10:00.000Z');
  const ms = now.getTime() + 900e3;
  assert.equal(parseReset(`"reset": ${ms}`, now).toISOString(), '2026-10-20T10:15:00.000Z');
});

test('parseReset: unparsable or past -> null', async () => {
  const { parseReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(parseReset('rate limit reached, try later', now), null);
  assert.equal(parseReset('resets at 2026-10-19T00:00:00Z', now), null);
  assert.equal(parseReset('"reset": 0', now), null);
  assert.equal(parseReset('', now), null);
});

test('estimateReset: free / go / paid ladders', async () => {
  const { estimateReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  const at = (mins) => new Date(now.getTime() + mins * 60e3).toISOString();
  const free = [15, 60, 300, 300];
  const go = [60, 300, 1440, 1440];
  const paid = [1, 15, 60, 60];
  for (const [i, hits] of [1, 2, 3, 9].entries()) {
    assert.deepEqual(estimateReset('opencode/free', hits, now, ''), { until: new Date(at(free[i])), source: 'estimate' });
    assert.deepEqual(estimateReset('opencode-go/anything', hits, now, ''), { until: new Date(at(go[i])), source: 'estimate' });
    assert.deepEqual(estimateReset('deepseek/chat', hits, now, 'rate limit'), { until: new Date(at(paid[i])), source: 'estimate' });
  }
});

test('estimateReset: paid with an empty balance has no reset', async () => {
  const { estimateReset } = await freshLib(tempHome());
  const now = new Date('2026-10-20T10:00:00Z');
  assert.deepEqual(estimateReset('deepseek/chat', 2, now, 'Insufficient Balance'), { until: null, source: 'no-reset' });
  assert.deepEqual(estimateReset('deepseek/chat', 2, now, 'insufficient credit'), { until: null, source: 'no-reset' });
});

test('estimateReset: token plan uses the earliest exhausted window TokenBar knows', async () => {
  const home = tempHome();
  const now = new Date('2026-10-20T10:00:00Z');
  const status = join(home, 'status.json');
  writeFileSync(status, JSON.stringify({
    qwen: {
      windows: [
        { label: 'daily', percentLeft: 50, resetsAt: '2026-10-20T11:00:00Z' },
        { label: 'weekly', percentLeft: 0, resetsAt: '2026-10-19T11:00:00Z' },
        { label: 'monthly', percentLeft: 0, resetsAt: '2026-11-01T00:00:00Z' },
        { label: 'extra', percentLeft: -2, resetsAt: '2026-10-25T00:00:00Z' },
      ],
    },
  }));
  const { estimateReset } = await freshLib(home, { OC_TOKENBAR_STATUS: status });
  // The weekly window is in the past, so the earliest usable exhausted window is "extra" (2026-10-25).
  assert.deepEqual(estimateReset('bailian-token-plan-personal/qwen', 1, now, 'quota'), {
    until: new Date('2026-10-25T00:00:00Z'), source: 'estimate',
  });

  // No exhausted window -> the Go ladder.
  writeFileSync(status, JSON.stringify({ qwen: { windows: [{ percentLeft: 40, resetsAt: '2026-10-25T00:00:00Z' }] } }));
  assert.deepEqual(estimateReset('bailian-token-plan-personal/qwen', 2, now, 'quota'), {
    until: new Date('2026-10-20T15:00:00Z'), source: 'estimate',
  });

  // Missing status.json -> the Go ladder too.
  const { estimateReset: second } = await freshLib(home, { OC_TOKENBAR_STATUS: join(home, 'absent.json') });
  assert.deepEqual(second('bailian-token-plan-personal/qwen', 3, now, 'quota'), {
    until: new Date('2026-10-21T10:00:00Z'), source: 'estimate',
  });
});

test('recordLimit: consecutive hits climb, a gap over 24 h starts over, message is capped', async () => {
  const home = tempHome();
  const { recordLimit, loadLimits } = await freshLib(home);
  const t0 = new Date('2026-10-20T10:00:00Z');
  let e = recordLimit('opencode/free', { until: new Date(t0.getTime() + 900e3), source: 'estimate', message: 'x'.repeat(300) }, t0);
  assert.equal(e.hits, 1);
  assert.equal(e.until, '2026-10-20T10:15:00.000Z');
  assert.equal(e.at, '2026-10-20T10:00:00.000Z');
  assert.equal(e.message.length, 200);

  e = recordLimit('opencode/free', { until: null, source: 'no-reset', message: 'still blocked' }, new Date(t0.getTime() + 3600e3));
  assert.equal(e.hits, 2);
  assert.equal(e.source, 'no-reset');
  assert.equal(e.until, null);

  // 25 h after the previous hit: a new streak.
  e = recordLimit('opencode/free', { until: null, source: 'estimate', message: 'again' }, new Date(t0.getTime() + 26 * 3600e3));
  assert.equal(e.hits, 1);

  assert.deepEqual(Object.keys(loadLimits()), ['opencode/free']);
  assert.equal(JSON.parse(readFileSync(join(home, 'limits.json'), 'utf8'))['opencode/free'].hits, 1);
});

test('clearLimit removes only that entry and is a no-op when absent', async () => {
  const home = tempHome();
  const { recordLimit, clearLimit, loadLimits } = await freshLib(home);
  const now = new Date('2026-10-20T10:00:00Z');
  recordLimit('a/one', { until: null, source: 'estimate', message: 'a' }, now);
  recordLimit('b/two', { until: null, source: 'estimate', message: 'b' }, now);
  clearLimit('a/one');
  assert.deepEqual(Object.keys(loadLimits()), ['b/two']);
  clearLimit('does/not-exist');
  assert.deepEqual(Object.keys(loadLimits()), ['b/two']);
});

test('blockedUntil honours a passed-in limits object', async () => {
  const home = tempHome(); // no limits.json on disk
  const { blockedUntil } = await freshLib(home);
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(blockedUntil('a/one', now, {}), null);
  assert.equal(blockedUntil('a/one', now, { 'a/one': { until: '2026-10-20T11:00:00Z', source: 'message' } }).toISOString(),
    '2026-10-20T11:00:00.000Z');
  assert.equal(blockedUntil('a/one', now, { 'a/one': { until: '2026-10-20T09:00:00Z', source: 'message' } }), null);
  const noReset = blockedUntil('a/one', now, { 'a/one': { until: null, source: 'no-reset' } });
  assert.ok(noReset > new Date('2100-01-01'));
});

test('CACHE: explicit env wins, otherwise the default inventory path', async () => {
  const explicit = join(tempHome(), 'inventory.json');
  let lib = await freshLib(tempHome(), { OC_DISPATCH_CACHE: explicit });
  assert.equal(lib.CACHE, explicit);
  lib = await freshLib(tempHome());
  assert.equal(lib.CACHE, join(homedir(), '.cache', 'opencode-dispatch', 'inventory.json'));
});

test('probeTargets: table aliases plus official free Zen models only', async () => {
  const { probeTargets } = await freshLib(tempHome());
  const table = { models: { known: { aliases: ['vendor/known', 'opencode/known-free'] } } };
  const models = [
    { id: 'vendor/known' },
    { id: 'vendor/unknown' },
    { id: 'opencode/known-free', cost: 'free', live: true },
    { id: 'opencode/new-free', cost: 'free', live: true },
    { id: 'opencode/retired-free', cost: 'free', live: false },
    { id: 'opencode/paid', cost: '$1/$2', live: true },
    { id: 'opencode-go/some', cost: 'Go $1/$2', live: true },
  ];
  assert.deepEqual(probeTargets(models, table).map((m) => m.id),
    ['vendor/known', 'opencode/known-free', 'opencode/new-free']);
});
