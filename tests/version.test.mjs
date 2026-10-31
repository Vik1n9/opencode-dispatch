import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repo, tempHome } from './helpers.mjs';

const version = readFileSync(join(repo, 'skills/opencode-dispatch/VERSION'), 'utf8').trim();
const scripts = ['oc-bench', 'oc-models', 'oc-quota', 'oc-rank', 'oc-run', 'oc-track', 'oc-watch'];

test('VERSION is a semantic version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

for (const name of scripts) {
  test(`${name} --version prints the VERSION file and exits before doing any work`, () => {
    const home = tempHome(); // empty data folder: any real work would fail
    const r = spawnSync('node', [join(repo, 'skills/opencode-dispatch/scripts', `${name}.mjs`), '--version'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, OC_DISPATCH_HOME: home, OC_DISPATCH_CACHE: join(home, 'none.json'), HTTPS_PROXY: 'http://127.0.0.1:9' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `opencode-dispatch ${version}`);
  });
}
