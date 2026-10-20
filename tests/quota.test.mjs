import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { repo, run, tempHome, writeJson } from './helpers.mjs';

const quotaScript = join(repo, 'skills/opencode-dispatch/scripts/oc-quota.mjs');

test('oc-quota prints active limits.json blocks and hides expired ones', () => {
  const home = tempHome();
  const tokenbar = tempHome();
  writeJson(join(tokenbar, 'status.json'), {
    deepseek: { USD: { total: 5, at: new Date().toISOString() } },
    qwen: { percentLeft: 80, at: new Date().toISOString() },
  });
  const now = Date.now();
  writeJson(join(home, 'limits.json'), {
    'vendor/alpha': {
      until: new Date(now + 3600e3).toISOString(), source: 'message', message: 'rate limit exceeded', hits: 2,
      at: new Date(now).toISOString(),
    },
    'vendor/beta': {
      until: null, source: 'no-reset', message: 'insufficient balance', hits: 1, at: new Date(now).toISOString(),
    },
    'vendor/gamma': {
      until: new Date(now - 3600e3).toISOString(), source: 'estimate', message: 'expired', hits: 1,
      at: new Date(now - 7200e3).toISOString(),
    },
  });

  const r = run(quotaScript, [], home, { OC_TOKENBAR_DIR: tokenbar });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /limited {2}vendor\/alpha {2}until .+ \(message, hits 2\)/);
  assert.match(r.stdout, /limited {2}vendor\/beta {2}needs owner action \(insufficient balance\)/);
  assert.doesNotMatch(r.stdout, /vendor\/gamma/);
});
