import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, makeSandbox, runBash, writeShim, SHIM_OK } from './helpers.mjs';

const INSTALL = join(ROOT, 'install.sh');

test('install.sh: a cloud environment exits 1 and creates no links', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const r = runBash(sb, [INSTALL], { env: { ...SHIM_OK, CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(sb.home, '.agents')));
  assert.ok(!existsSync(join(sb.home, '.config', 'opencode-dispatch')));
  assert.ok(!existsSync(join(sb.home, '.claude')));
});

test('install.sh: a container environment exits 1 and creates no links', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const r = runBash(sb, [INSTALL], { env: { ...SHIM_OK, container: 'podman' } });
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(sb.home, '.agents')));
});

test('install.sh: opencode missing warns, exits 0 and creates the links', (t) => {
  const sb = makeSandbox(); // no shim
  const r = runBash(sb, [INSTALL], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^missing/m);
  assert.match(r.stdout, /warning  dispatching will not work/);

  const agents = join(sb.home, '.agents', 'skills', 'opencode-dispatch');
  const claude = join(sb.home, '.claude', 'skills', 'opencode-dispatch');
  const scores = join(sb.home, '.config', 'opencode-dispatch', 'scores.json');
  assert.equal(lstatSync(agents).isSymbolicLink(), true);
  assert.equal(readlinkSync(agents), join(ROOT, 'skills', 'opencode-dispatch'));
  assert.equal(lstatSync(claude).isSymbolicLink(), true);
  assert.equal(readlinkSync(claude), '../../.agents/skills/opencode-dispatch');
  assert.equal(lstatSync(scores).isSymbolicLink(), true);
  assert.equal(readlinkSync(scores), join(ROOT, 'config', 'scores.json'));
});

test('install.sh: with opencode logged in it exits 0 and reports ok on a second run', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const first = runBash(sb, [INSTALL], { env: SHIM_OK });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^ok/);
  assert.match(first.stdout, /linked/);

  const second = runBash(sb, [INSTALL], { env: SHIM_OK });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /ok       .*opencode-dispatch/);
  assert.match(second.stdout, /ok       .*scores\.json/);
});

test('install.sh: a missing credential (exit 3) still installs with a warning', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const r = runBash(sb, [INSTALL], { env: { ...SHIM_OK, OC_SHIM_AUTH_OUT: '' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^missing/m);
  assert.ok(existsSync(join(sb.home, '.agents', 'skills', 'opencode-dispatch')));
});
