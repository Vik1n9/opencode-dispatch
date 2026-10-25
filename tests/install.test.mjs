import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
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
  const benchmarks = join(sb.home, '.config', 'opencode-dispatch', 'benchmarks.json');
  assert.equal(lstatSync(agents).isSymbolicLink(), true);
  assert.equal(readlinkSync(agents), join(ROOT, 'skills', 'opencode-dispatch'));
  assert.equal(lstatSync(claude).isSymbolicLink(), true);
  assert.equal(readlinkSync(claude), '../../.agents/skills/opencode-dispatch');
  assert.equal(lstatSync(benchmarks).isSymbolicLink(), true);
  assert.equal(readlinkSync(benchmarks), join(ROOT, 'config', 'benchmarks.json'));
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
  assert.match(second.stdout, /ok       .*benchmarks\.json/);
});

test('install.sh: a missing credential (exit 3) still installs with a warning', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const r = runBash(sb, [INSTALL], { env: { ...SHIM_OK, OC_SHIM_AUTH_OUT: '' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^missing/m);
  assert.ok(existsSync(join(sb.home, '.agents', 'skills', 'opencode-dispatch')));
});

test('install.sh: an unknown option exits 2 and creates no links', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const r = runBash(sb, [INSTALL, '--bogus'], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: install\.sh \[--statusline\]/);
  assert.ok(!existsSync(join(sb.home, '.agents')));
});

test('install.sh --statusline: links the companion, keeps the old first line, backs up settings', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const settings = join(sb.home, '.claude', 'settings.json');
  mkdirSync(join(sb.home, '.claude'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'my-line --fancy' } }));

  const first = runBash(sb, [INSTALL, '--statusline'], { env: SHIM_OK });
  assert.equal(first.status, 0, first.stderr);
  for (const [name, target] of [
    ['statusline-wrap.sh', 'statusline-wrap.sh'],
    ['statusline-agents.mjs', 'statusline-agents.mjs'],
    [join('bin', 'dlwatch'), join('bin', 'dlwatch')],
  ]) {
    const p = join(sb.home, '.claude', name);
    assert.equal(lstatSync(p).isSymbolicLink(), true, name);
    assert.equal(readlinkSync(p), join(ROOT, 'statusline', target));
  }
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.theme, 'dark', 'other settings are kept');
  assert.deepEqual(s.statusLine, { type: 'command', command: 'bash ~/.claude/statusline-wrap.sh', refreshInterval: 3 });
  assert.equal(readFileSync(join(sb.home, '.config', 'opencode-dispatch', 'statusline-base'), 'utf8'), 'my-line --fancy\n');
  assert.match(first.stdout, /^backup   .*settings\.json/m);

  const second = runBash(sb, [INSTALL, '--statusline'], { env: SHIM_OK });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /^ok       .*statusLine$/m);
  assert.match(second.stdout, /^ok       .*statusline-wrap\.sh/m);
});

test('install.sh without --statusline leaves settings.json alone', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const r = runBash(sb, [INSTALL], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(sb.home, '.claude', 'settings.json')));
  assert.ok(!existsSync(join(sb.home, '.claude', 'statusline-wrap.sh')));
});
