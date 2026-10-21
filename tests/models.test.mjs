import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { repo, run, tempHome, writeJson } from './helpers.mjs';

const modelsScript = join(repo, 'skills/opencode-dispatch/scripts/oc-models.mjs');

test('oc-models --probe: a fresh probed cache is reused before any network call', () => {
  const home = tempHome();
  const cachePath = join(home, 'inventory.json');
  writeJson(cachePath, {
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    probed: true,
    models: [{ id: 'opencode/free', cost: 'free', live: true, probe: { ok: true, seconds: 5 } }, { id: 'vendor/known' }],
  });

  const r = run(modelsScript, ['--probe'], home, { OC_DISPATCH_CACHE: cachePath });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /inventory cache is fresh \(0\.0h, 2 models\) — skipped; use --force to re-probe/);
});
