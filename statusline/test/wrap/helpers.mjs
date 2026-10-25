// Shared helpers: temp HOME inside the repo (never the real ~/.claude or ~/.cache),
// wrapper invocation as a child process, and a fake oc-run.mjs process for the ps scan.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const wrap = join(repo, 'statusline-wrap.sh');
export const fixture = join(repo, 'test', 'fixtures', 'fixture.json');

// Every temp HOME is tracked so nothing leaks even if a test dies before its t.after.
const homes = new Set();
process.on('exit', () => {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// Temp HOME inside the repo, preloaded with the three scripts in .claude/.
export function makeHome() {
  const home = mkdtempSync(join(repo, '.testhome-'));
  homes.add(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  cpSync(join(repo, 'test', 'fixtures', 'statusline.sh'), join(home, '.claude', 'statusline.sh'));
  for (const f of ['statusline-agents.mjs', 'statusline-wrap.sh']) {
    cpSync(join(repo, f), join(home, '.claude', f));
  }
  return home;
}

export function cleanupHome(home) {
  homes.delete(home);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}

// stdin payload: no transcript, so nothing is ever parsed from a real session.
export function stdinJson(extra = {}) {
  return JSON.stringify({ session_id: 'test', transcript_path: '/nonexistent.jsonl', ...extra });
}

// Run the wrapper as a child (absolute bash: PATH may be restricted by the test).
export function runWrap(home, input, { path, env } = {}) {
  const t0 = Date.now();
  const r = spawnSync('/bin/bash', [wrap], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, ...(env || {}), PATH: path ?? process.env.PATH },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - t0 };
}

// Non-empty output lines: trailing "\n" is fine, a trailing blank line is not.
export function lines(out) {
  return out.split('\n').filter((l) => l.length > 0);
}

// A harmless long-running process whose argv looks like "node … oc-run.mjs" to the ps scan.
// Needs no --log so the $TMPDIR/oc-run log-discovery branch is exercised too.
export function startFakeOcRun(t, home, { title = '冒煙測試', model = 'prov/test-model', log } = {}) {
  const dir = join(home, 'fake');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'oc-run.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const args = [script, '--title', title, '--model', model];
  if (log) args.push('--log', log);
  const child = spawn(process.execPath, args, { stdio: 'ignore' });
  const pid = child.pid;
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  process.once('exit', () => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  if (!waitForPs(script)) throw new Error('fake oc-run never showed up in ps');
  return { pid, script };
}

export function waitForPs(marker, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = spawnSync('/bin/ps', ['-axo', 'args='], { encoding: 'utf8' });
    if (r.stdout && r.stdout.includes(marker)) return true;
    spawnSync('/bin/sleep', ['0.1']);
  }
  return false;
}

// A dlwatch-style status file for an alive pid (the test process itself).
export function writeDlFile(home, label) {
  mkdirSync(join(home, '.cache', 'agent-status'), { recursive: true });
  const file = join(home, '.cache', 'agent-status', `dl-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ label, pid: process.pid, pct: 42, etaAt: Date.now() + 3600e3 }));
  return file;
}

// Failing `ps` stub first in PATH: agents() sees no processes deterministically
// (the machine really does have oc-run.mjs processes running).
export function psFailsDir(home) {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ps'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'ps'), 0o755);
  return dir;
}
