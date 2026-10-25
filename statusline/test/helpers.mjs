// Shared fixtures for the tests. Every temp HOME lives inside the repo so the real ~/.cache and
// ~/.claude are never touched.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function makeHome(prefix = '.testhome-') {
  const dir = mkdtempSync(join(ROOT, prefix));
  mkdirSync(join(dir, '.cache', 'agent-status'), { recursive: true });
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  return dir;
}

// Fake `ps` on PATH: it prints the lines we wrote, so the process scan can be tested end to end.
export function installFakePs(home, lines) {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, 'ps.out'), lines.length ? `${lines.join('\n')}\n` : '');
  const ps = join(bin, 'ps');
  writeFileSync(ps, '#!/bin/sh\ncat "$FAKE_PS"\n', { mode: 0o755 });
  return bin;
}

export function runCli(home, { input = '{}\n', bin = '', timeout = 8000 } = {}) {
  const env = { ...process.env, HOME: home, TMPDIR: join(home, 'tmp'), FAKE_PS: join(home, 'ps.out') };
  delete env.NODE_TEST_CONTEXT; // do not turn the child into a test-runner worker
  delete env.NODE_V8_COVERAGE;
  if (bin) env.PATH = `${bin}:${process.env.PATH}`;
  return spawnSync(process.execPath, [join(ROOT, 'statusline-agents.mjs')], {
    cwd: ROOT, env, input, encoding: 'utf8', timeout,
  });
}

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
