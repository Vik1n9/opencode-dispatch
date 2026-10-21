import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeSandbox, runScript, writeShim, writeStatus, writeJson, SHIM_OK } from './helpers.mjs';

const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const now = () => new Date();
const iso = (minAgo) => new Date(now().getTime() - minAgo * 60000).toISOString();
const apple = (minAgo) => (now().getTime() - minAgo * 60000 - APPLE_EPOCH) / 1000;

function box(t) {
  const sb = makeSandbox();
  writeShim(sb);
  return sb;
}

const quota = (sb) => runScript(sb, 'oc-quota.mjs', ['--json'], { env: SHIM_OK });
const text = (sb) => runScript(sb, 'oc-quota.mjs', [], { env: SHIM_OK });
const rows = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.json;
};
const byProvider = (r, p) => rows(r).find((x) => x.provider === p);

test('oc-quota: ok verdicts for a fresh DeepSeek balance and Qwen allowance', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 5.5, granted: 0, toppedUp: 5.5, at: iso(2) } },
    qwen: { percentLeft: 55, at: iso(3) },
  });
  const r = quota(sb);
  assert.equal(r.status, 0);
  const ds = byProvider(r, 'deepseek');
  assert.equal(ds.verdict, 'ok');
  assert.equal(ds.remaining, 5.5);
  assert.equal(ds.unit, 'USD');
  assert.equal(ds.stale, false);
  assert.equal(ds.source, 'status.json');
  const q = byProvider(r, 'qwen-token-plan');
  assert.equal(q.verdict, 'ok');
  assert.equal(q.remaining, 55);
  assert.equal(q.unit, '%');
  const shown = text(sb);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /deepseek\s+ok/);
  assert.match(shown.stdout, /55% left/);
});

test('oc-quota: low verdicts below the thresholds', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 0.4, at: iso(1) } },
    qwen: { percentLeft: 4, at: iso(1) },
  });
  const r = quota(sb);
  assert.equal(byProvider(r, 'deepseek').verdict, 'low');
  assert.equal(byProvider(r, 'qwen-token-plan').verdict, 'low');
  const shown = text(sb);
  assert.match(shown.stdout, /deepseek\s+low/);
  assert.match(shown.stdout, /qwen-token-plan\s+low/);
});

test('oc-quota: stale verdicts for old samples', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 5, at: iso(120) } },
    qwen: { percentLeft: 50, at: iso(61) },
  });
  const r = quota(sb);
  const ds = byProvider(r, 'deepseek');
  assert.equal(ds.verdict, 'stale');
  assert.equal(ds.stale, true);
  assert.equal(ds.ageMin, 120);
  assert.equal(byProvider(r, 'qwen-token-plan').verdict, 'stale');
});

test('oc-quota: low beats stale, and the text output still marks the old sample', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 0.2, at: iso(180) } },
    qwen: { percentLeft: 2, at: iso(180) },
  });
  const r = quota(sb);
  const ds = byProvider(r, 'deepseek');
  assert.equal(ds.verdict, 'low');
  assert.equal(ds.stale, true);
  assert.match(text(sb).stdout, /low .*\(stale\)/);
});

test('oc-quota: unknown when TokenBar is not exporting', (t) => {
  const sb = box(t); // no status.json
  const r = quota(sb);
  const ds = byProvider(r, 'deepseek');
  const q = byProvider(r, 'qwen-token-plan');
  assert.equal(ds.verdict, 'unknown');
  assert.match(ds.note, /cannot read TokenBar status\.json/);
  assert.equal(q.verdict, 'unknown');
  assert.match(q.note, /not found/);
  assert.match(text(sb).stdout, /unknown/);
});

test('oc-quota: unknown Qwen when status.json has no percentLeft', (t) => {
  const sb = box(t);
  writeStatus(sb, { deepseek: { USD: { total: 5, at: iso(1) } }, qwen: { percentLeft: null } });
  const q = byProvider(quota(sb), 'qwen-token-plan');
  assert.equal(q.verdict, 'unknown');
  assert.match(q.note, /no qwen\.percentLeft/);
});

test('oc-quota: a missing sample time makes the verdict stale', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 5 } },
    qwen: { percentLeft: 50 },
  });
  const r = quota(sb);
  const ds = byProvider(r, 'deepseek');
  assert.equal(ds.verdict, 'stale');
  assert.equal(ds.sampledAt, null);
  assert.equal(ds.ageMin, null);
  assert.match(ds.note, /no sample time/);
  assert.equal(byProvider(r, 'qwen-token-plan').verdict, 'stale');
});

test('oc-quota: a sample time in the future is stale and noted', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 5, at: iso(-30) } },
    qwen: { percentLeft: 50, at: iso(-30) },
  });
  const r = quota(sb);
  const ds = byProvider(r, 'deepseek');
  assert.equal(ds.verdict, 'stale');
  assert.match(ds.note, /in the future/);
});

test('oc-quota: numeric Apple-epoch at and resetsAt are converted', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 5, at: apple(2) } },
    qwen: { percentLeft: 50, at: apple(2), resetsAt: apple(-60 * 24) },
  });
  const r = quota(sb);
  const ds = byProvider(r, 'deepseek');
  assert.equal(ds.verdict, 'ok');
  assert.ok(Math.abs(ds.ageMin - 2) <= 1);
  assert.ok(ds.sampledAt.startsWith('20'));
  const q = byProvider(r, 'qwen-token-plan');
  assert.equal(q.verdict, 'ok');
  assert.match(q.resetsAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(text(sb).stdout, /resets \d{4}-\d{2}-\d{2}/);
});

test('oc-quota: a non-USD currency gets the note and no USD low verdict', (t) => {
  const sb = box(t);
  writeStatus(sb, { deepseek: { CNY: { total: 0.5, at: iso(1) } }, qwen: { percentLeft: 50, at: iso(1) } });
  const ds = byProvider(quota(sb), 'deepseek');
  assert.equal(ds.unit, 'CNY');
  assert.equal(ds.verdict, 'ok');
  assert.match(ds.note, /USD only/);
});

test('oc-quota: falls back to deepseek-ledger.json without a status.json deepseek entry', (t) => {
  const sb = box(t);
  writeStatus(sb, { qwen: { percentLeft: 50, at: iso(1) } });
  writeJson(join(sb.home, 'Library', 'Application Support', 'TokenBar', 'deepseek-ledger.json'),
    { lastSamples: { USD: { total: 7.25, at: apple(3) }, CNY: { total: 20, at: apple(3) } } });
  const r = quota(sb);
  const all = rows(r).filter((x) => x.provider === 'deepseek');
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.unit === 'USD').remaining, 7.25);
  assert.equal(all.find((x) => x.unit === 'USD').source, 'deepseek-ledger.json');
  assert.equal(all.find((x) => x.unit === 'USD').verdict, 'ok');
  assert.match(all.find((x) => x.unit === 'CNY').note, /USD only/);
});

test('oc-quota: malformed status.json is unknown with a note', (t) => {
  const sb = box(t);
  const p = join(sb.home, 'Library', 'Application Support', 'TokenBar', 'status.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{nope');
  const r = quota(sb);
  assert.equal(byProvider(r, 'qwen-token-plan').verdict, 'unknown');
  assert.match(byProvider(r, 'qwen-token-plan').note, /malformed/);
});

test('oc-quota: --json shape carries provider, verdict, stale, age and notes', (t) => {
  const sb = box(t);
  writeStatus(sb, {
    deepseek: { USD: { total: 5, at: iso(1) } },
    qwen: { percentLeft: 50, at: iso(1), windows: [{ label: 'weekly', percentLeft: 50, resetsAt: iso(-1440) }] },
  });
  const r = quota(sb);
  assert.equal(r.status, 0);
  const data = rows(r);
  assert.ok(Array.isArray(data));
  for (const row of data) {
    assert.ok('provider' in row);
    assert.ok('verdict' in row);
    assert.ok('stale' in row);
  }
  const q = data.find((x) => x.provider === 'qwen-token-plan');
  assert.equal(q.unit, '%');
  assert.equal(q.remaining, 50);
  assert.ok('ageMin' in q);
  assert.ok('sampledAt' in q);
  assert.ok('resetsAt' in q);
});
