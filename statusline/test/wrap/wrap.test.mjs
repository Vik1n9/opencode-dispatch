// End-to-end tests for statusline-wrap.sh: missing node in PATH, children failing or
// leaking to stderr, hostile labels, empty/huge stdin, and the "nothing runs" contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { cleanupHome, fixture, lines, makeHome, psFailsDir, runWrap, startFakeOcRun, stdinJson, writeDlFile } from './helpers.mjs';

// P-F: Claude Code may run the status line with a minimal PATH that has no node.
test('wrapper finds node when PATH has none and prints the second line', (t) => {
  const inPath = spawnHasNode();
  if (inPath) return t.skip('node lives in /usr/bin or /bin on this machine');
  const home = makeHome();
  t.after(() => cleanupHome(home));
  startFakeOcRun(t, home);
  const r = runWrap(home, stdinJson(), { path: '/usr/bin:/bin' });
  assert.equal(r.status, 0);
  assert.ok(lines(r.stdout).length >= 2, `expected a second line, got: ${JSON.stringify(r.stdout)}`);
  assert.match(r.stdout, /冒煙測試/); // the fake dispatch is visible
});

function spawnHasNode() {
  const r = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  return Boolean(r.stdout && r.stdout.trim());
}

// P-A: bash's own "No such file or directory" used to leak to stderr on every render.
test('missing statusline.sh: exit 0, silent stderr', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  rmSync(`${home}/.claude/statusline.sh`);
  const r = runWrap(home, stdinJson());
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

// P-B: statusline.sh stderr (and bash-level errors before its exec-2 redirect) leaked.
test('statusline.sh stderr is swallowed; WAZA_STATUSLINE_DEBUG=1 still surfaces it', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  writeFileSync(`${home}/.claude/statusline.sh`, '#!/bin/bash\necho "boom-error" >&2\necho "LINE1"\nexit 1\n');
  const r = runWrap(home, stdinJson());
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.ok(lines(r.stdout)[0] === 'LINE1', `first line should still print, got: ${JSON.stringify(r.stdout)}`);
  const dbg = runWrap(home, stdinJson(), { env: { WAZA_STATUSLINE_DEBUG: '1' } });
  assert.match(dbg.stderr, /boom-error/);
});

// P-C: a crashing statusline-agents.mjs may have written partial stdout; that junk
// used to be printed as the second line (the exit status was ignored).
test('crashed agents script: partial stdout is not printed as the second line', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  writeFileSync(`${home}/.claude/statusline-agents.mjs`, 'process.stdout.write("JUNK-GARBAGE\\n"); throw new Error("boom");\n');
  const r = runWrap(home, stdinJson());
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(lines(r.stdout).length, 1, `only the first line expected, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes('JUNK-GARBAGE'));
});

test('missing agents script: no second line, no stderr, exit 0', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  rmSync(`${home}/.claude/statusline-agents.mjs`);
  const r = runWrap(home, stdinJson());
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(lines(r.stdout).length, 1);
});

// P-E: a dl label carrying a newline and an ANSI sequence split the second line into
// two lines and injected raw escape codes (the wrapper prints mjs output verbatim).
test('label with newline and ANSI: still exactly two clean lines', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  writeDlFile(home, 'evil\nline2\x1b[999mX');
  const r = runWrap(home, stdinJson());
  assert.equal(r.status, 0);
  assert.equal(lines(r.stdout).length, 2, `expected 2 lines, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes('\x1b[999m'), 'label ANSI must be stripped');
  assert.ok(!r.stdout.includes('\n\n'), 'no trailing blank line');
  assert.match(r.stdout.split('\n')[1], /⬇.*evil line2X/);
});

// Contract: nothing runs -> no second line. A failing ps stub makes the ps scan empty
// deterministically (this machine really has oc-run.mjs processes running).
test('nothing running: exactly one line out', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const bin = psFailsDir(home);
  const r = runWrap(home, stdinJson(), { path: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(lines(r.stdout).length, 1, `expected only line 1, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes('\n\n'));
});

test('empty stdin: exit 0, one line, no stderr', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const bin = psFailsDir(home);
  const r = runWrap(home, '', { path: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(lines(r.stdout).length, 1);
});

// Huge stdin must neither hang nor blow up (Claude Code pipes a JSON blob every 3 s).
test('huge stdin (8 MB): completes fast with clean output', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const input = JSON.stringify({ pad: 'x'.repeat(8 * 1024 * 1024), session_id: 'big', transcript_path: '/nonexistent.jsonl' });
  const r = runWrap(home, input);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.ok(lines(r.stdout).length <= 2, `at most 2 lines, got ${lines(r.stdout).length}`);
  assert.ok(r.ms < 5000, `took ${r.ms}ms`);
});

// Whole pipeline against the 3 s refresh: generous bound, guards against hangs.
test('full wrapper run stays well under the refresh interval', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  const r = runWrap(home, readFileSync(fixture, 'utf8'));
  assert.equal(r.status, 0);
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
});

// install.sh --statusline saves a previous statusLine command; without statusline.sh it is line 1.
test('wrapper runs the saved previous status line command when statusline.sh is absent', (t) => {
  const home = makeHome();
  t.after(() => cleanupHome(home));
  rmSync(join(home, '.claude', 'statusline.sh'));
  mkdirSync(join(home, '.config', 'opencode-dispatch'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode-dispatch', 'statusline-base'), "cat >/dev/null; echo 'my own line'\n");
  const r = runWrap(home, stdinJson());
  assert.equal(r.status, 0);
  assert.equal(lines(r.stdout)[0], 'my own line');
});
