import test from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeSandbox, writeShim, SCRIPTS, SHIM_OK } from './helpers.mjs';

// install.sh links the skill into ~/.agents/skills, so scripts usually run through a symlink:
// each one must behave the same as when run from the repo.
const run = (sb, file, args) => spawnSync(process.execPath, [file, ...args], {
  encoding: 'utf8', env: { ...sb.env, ...SHIM_OK }, cwd: sb.dir, timeout: 20000,
});

for (const [name, args] of [['oc-rank.mjs', ['--task', 'repo-coding']], ['oc-quota.mjs', []], ['oc-limits.mjs', ['status']], ['oc-check.mjs', []]]) {
  test(`${name}: same output through a symlinked skill folder`, () => {
    const sb = makeSandbox();
    writeShim(sb);
    const link = join(sb.dir, 'linked-scripts');
    symlinkSync(SCRIPTS, link);
    const direct = run(sb, join(SCRIPTS, name), args);
    const linked = run(sb, join(link, name), args);
    assert.ok(direct.stdout.length + direct.stderr.length > 0, 'direct run printed nothing');
    assert.equal(linked.status, direct.status);
    assert.equal(linked.stdout, direct.stdout);
  });
}
