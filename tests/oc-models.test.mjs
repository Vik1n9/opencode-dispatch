import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, runScript, writeShim, SHIM_OK } from './helpers.mjs';

const network = process.env.OC_TEST_NETWORK === '1';

function box(t) {
  const sb = makeSandbox();
  writeShim(sb);
  return sb;
}

const models = (sb, args, env = SHIM_OK) => runScript(sb, 'oc-models.mjs', args, { env, timeout: 30000 });

// --concurrency / --timeout are validated before the environment check and before any fetch.
test('oc-models: invalid --concurrency exits 2 before anything else', (t) => {
  const sb = box(t);
  for (const value of ['0', '-1', 'abc', '1.5']) {
    const r = models(sb, ['--concurrency', value]);
    assert.equal(r.status, 2, value);
    assert.match(r.stderr, /--concurrency must be a positive integer/);
  }
  const missing = models(sb, ['--concurrency']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--concurrency must be a positive integer/);
});

test('oc-models: invalid --timeout exits 2 before anything else', (t) => {
  const sb = box(t);
  for (const value of ['0', '-5', 'soon']) {
    const r = models(sb, ['--timeout', value]);
    assert.equal(r.status, 2, value);
    assert.match(r.stderr, /--timeout must be a positive integer/);
  }
  const missing = models(sb, ['--timeout']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--timeout must be a positive integer/);
});

test('oc-models: blocked environment exits 2 before the docs fetch', (t) => {
  const sb = box(t);
  const r = models(sb, [], { ...SHIM_OK, CODESPACES: 'true' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cloud session/);
});

test('oc-models: --only with a missing cache exits 2 and creates nothing', (t) => {
  const sb = box(t);
  const cache = join(sb.dir, 'no-such', 'inventory.json');
  const r = models(sb, ['--probe', '--cache', cache, '--only', 'opencode/some-model']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--only needs an existing cache from a full run/);
  assert.throws(() => readFileSync(cache, 'utf8'), /ENOENT/);
});

test('oc-models: --only with an unparseable cache leaves it byte-identical', (t) => {
  const sb = box(t);
  const cache = join(sb.dir, 'inventory.json');
  writeFileSync(cache, '{not json');
  const before = readFileSync(cache);
  const r = models(sb, ['--probe', '--cache', cache, '--only', 'opencode/some-model']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--only needs an existing cache from a full run/);
  assert.deepEqual(readFileSync(cache), before);
});

test('oc-models: --only with a cache that has no models array is refused', (t) => {
  const sb = box(t);
  const cache = join(sb.dir, 'inventory.json');
  writeFileSync(cache, JSON.stringify({ models: 'nope' }));
  const before = readFileSync(cache);
  const r = models(sb, ['--probe', '--cache', cache, '--only', 'opencode/some-model']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--only needs an existing cache from a full run/);
  assert.deepEqual(readFileSync(cache), before);
});

// Network-dependent paths: opt in with OC_TEST_NETWORK=1.
test('oc-models: --only with an unknown id leaves the cache byte-identical', { skip: !network && 'needs network: set OC_TEST_NETWORK=1' }, (t) => {
  const sb = box(t);
  const cache = join(sb.dir, 'inventory.json');
  writeFileSync(cache, JSON.stringify({ created: 'x', models: [{ id: 'opencode/known', live: true }] }));
  const before = readFileSync(cache);
  const r = models(sb, ['--probe', '--cache', cache, '--only', 'opencode/definitely-not-a-model']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cache left unchanged/);
  assert.deepEqual(readFileSync(cache), before);
});

test('oc-models: a full run writes the cache and lists official models', { skip: !network && 'needs network: set OC_TEST_NETWORK=1' }, (t) => {
  const sb = box(t);
  const cache = join(sb.dir, 'nested', 'inventory.json');
  const r = models(sb, ['--no-go', '--cache', cache], { ...SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(readFileSync(cache, 'utf8'));
  assert.ok(Array.isArray(data.models));
  assert.ok(data.models.some((m) => m.source === 'official'));
  assert.equal(data.probed, false);
});
