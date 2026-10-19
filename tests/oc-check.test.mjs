import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, runScript, writeShim, SHIM_OK } from './helpers.mjs';

const ok = (t, extra = {}) => {
  const sb = makeSandbox();
  writeShim(sb);
  return { sb, env: { ...SHIM_OK, ...extra } };
};

test('oc-check: ok with opencode 2.x and one credential', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok/);
  assert.match(r.stdout, /opencode 2\.0\.32/);
  assert.match(r.stdout, /1 credentials/);
});

test('oc-check: blocked when CLAUDE_CODE_REMOTE=true', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^blocked/);
  assert.match(r.stdout, /cloud session/);
});

test('oc-check: blocked when CLAUDE_CODE_REMOTE=1', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, CLAUDE_CODE_REMOTE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^blocked/);
});

test('oc-check: blocked when CODESPACES=true', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, CODESPACES: 'true' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^blocked/);
  assert.match(r.stdout, /CODESPACES/);
});

test('oc-check: blocked when container=podman', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, container: 'podman' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^blocked/);
  assert.match(r.stdout, /container/);
});

test('oc-check: blocked on a wrong major version', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, OC_SHIM_VERSION: '1.9.0' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^blocked/);
  assert.match(r.stdout, /1\.9\.0 is not supported/);
});

test('oc-check: DEVCONTAINER=false is ok', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, DEVCONTAINER: 'false' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok/);
});

test('oc-check: missing when opencode is not on PATH', (t) => {
  const sb = makeSandbox(); // no shim
  const r = runScript(sb, 'oc-check.mjs', [], { env: SHIM_OK });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^missing/);
  assert.match(r.stdout, /not installed/);
});

test('oc-check: missing when auth list is empty', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, OC_SHIM_AUTH_OUT: '' } });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^missing/);
  assert.match(r.stdout, /no logged-in provider/);
});

test('oc-check: missing when auth list exits 1', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, OC_SHIM_AUTH_EXIT: '1' } });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^missing/);
  assert.match(r.stdout, /auth list exited 1/);
});

test('oc-check: env credentials count as logged in', (t) => {
  const { sb, env } = ok(t);
  const r = runScript(sb, 'oc-check.mjs', [], { env: { ...env, OC_SHIM_AUTH_OUT: 'OpenAI  API key  env' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok/);
  assert.match(r.stdout, /1 credentials/);
});
