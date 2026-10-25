import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const DLWATCH = path.join(ROOT, 'bin', 'dlwatch');
const NODE = process.execPath;

function makeHome() {
  return fs.mkdtempSync(path.join(ROOT, '.th-'));
}

function cacheDir(home) {
  return path.join(home, '.cache', 'agent-status');
}

function statusFiles(home) {
  const d = cacheDir(home);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /^dl-\d+\.json$/.test(f));
}

function readStatus(home) {
  const files = statusFiles(home);
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(cacheDir(home), files[0]), 'utf8'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFake(home, name, code) {
  const p = path.join(home, name);
  fs.writeFileSync(p, code);
  return p;
}

function cleanupHome(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

test('yt-dlp progress with ETA', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stdout.write('[download]  45.3% of ~ 50.00MiB at 2.00MiB/s ETA 00:31\\n'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'yt', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    assert.ok(st, 'status file should exist');
    assert.equal(st.label, 'yt');
    assert.equal(st.pct, 45.3);
    assert.ok(st.etaAt > Date.now() + 20000, 'eta should be ~31s out');
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    assert.equal(statusFiles(home).length, 0, 'status file removed');
  } finally {
    cleanupHome(home);
  }
});

test('yt-dlp carriage-return update', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stdout.write('[download]  45.3% of ~ 50.00MiB at 2.00MiB/s ETA 00:31\\r[download]  50.0% of ~ 50.00MiB at 2.00MiB/s ETA 00:28\\r'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'yt', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 50);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('curl progress-bar', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stderr.write('####   45.3%\\n'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'curl', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 45.3);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('wget with eta 12s', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stderr.write('45% [===>   ] 1.2M 3.4MB/s eta 12s\\n'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'wget', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 45);
    assert.ok(st.etaAt > Date.now() + 5000 && st.etaAt < Date.now() + 20000, 'eta ~12s');
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('wget with eta 1m 3s', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stderr.write('45% [===>   ] 1.2M 3.4MB/s eta 1m 3s\\n'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'wget', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    assert.ok(st);
    assert.ok(st.etaAt > Date.now() + 55000 && st.etaAt < Date.now() + 75000, 'eta ~63s');
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('git clone progress', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stderr.write('Receiving objects:  45% (60/133)\\n'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'git', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 45);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('progress split across chunks', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stdout.write('45.'); setTimeout(()=>{ process.stdout.write('3% of ~ 10MiB ETA 00:'); setTimeout(()=>{ process.stdout.write('31\\n'); }, 100); }, 100); setTimeout(()=>{}, 2000);");
    const child = spawn(NODE, [DLWATCH, 'split', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(1500);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 45.3);
    assert.ok(st.etaAt > Date.now() + 20000);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('unrelated percentage is not captured', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stdout.write('100% done\\n'); setTimeout(()=>{ process.stdout.write(' 45.3% of ~ 10MiB ETA 00:31\\n'); }, 300); setTimeout(()=>{}, 2000);");
    const child = spawn(NODE, [DLWATCH, 'unrel', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(150);
    const early = readStatus(home);
    assert.ok(early);
    assert.notEqual(early.pct, 100, 'early unrelated 100% must not be captured');
    await delay(500);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 45.3);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('normal exit removes status file', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stdout.write('45.3% of x ETA 00:10\\n'); process.exit(0);");
    const r = spawnSync(NODE, [DLWATCH, 'n', '--', NODE, fake], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0);
    assert.equal(statusFiles(home).length, 0);
  } finally {
    cleanupHome(home);
  }
});

test('error exit removes status file', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stderr.write('boom\\n'); process.exit(3);");
    const r = spawnSync(NODE, [DLWATCH, 'e', '--', NODE, fake], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 3);
    assert.equal(statusFiles(home).length, 0);
  } finally {
    cleanupHome(home);
  }
});

test('command not found removes status file and exits 127', async () => {
  const home = makeHome();
  try {
    const r = spawnSync(NODE, [DLWATCH, '--no-pty', 'nf', '--', '/no/such/binary', 'x'], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 127);
    assert.match(r.stderr.toString(), /dlwatch:/);
    assert.equal(statusFiles(home).length, 0);
  } finally {
    cleanupHome(home);
  }
});

test('SIGINT removes status file', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "setInterval(()=>{}, 1000);");
    const child = spawn(NODE, [DLWATCH, 'sigi', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(500);
    assert.ok(statusFiles(home).length > 0);
    child.kill('SIGINT');
    await new Promise((r) => child.on('close', r));
    assert.equal(statusFiles(home).length, 0);
  } finally {
    cleanupHome(home);
  }
});

test('SIGTERM removes status file', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "setInterval(()=>{}, 1000);");
    const child = spawn(NODE, [DLWATCH, 'sigt', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(500);
    assert.ok(statusFiles(home).length > 0);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    assert.equal(statusFiles(home).length, 0);
  } finally {
    cleanupHome(home);
  }
});

test('exit code passthrough', async () => {
  const home = makeHome();
  try {
    const r = spawnSync(NODE, [DLWATCH, 'ec', '--', NODE, '-e', 'process.exit(42)'], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 42);
  } finally {
    cleanupHome(home);
  }
});

test('stdin passthrough', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ process.stdout.write('got:'+d+'\\n'); process.exit(0); });");
    const r = spawnSync(NODE, [DLWATCH, '--no-pty', 'si', '--', NODE, fake], { input: 'hello-stdin', env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString(), 'got:hello-stdin\n');
  } finally {
    cleanupHome(home);
  }
});

test('write throttling does not crash under rapid updates', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "for (let i=0;i<50;i++) process.stdout.write(' 45.3% of ~ 10MiB ETA 00:31\\n'); setTimeout(()=>{}, 1200);");
    const child = spawn(NODE, [DLWATCH, 'thr', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(900);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 45.3);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('curl default meter without % is not supported (no crash)', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'fake.mjs', "process.stderr.write(' 45  50.0M  45 22.5M 0 0 2.00M 0 0:00:25 0:00:12 0:00:13 2.00M\\n'); setTimeout(()=>{}, 1200);");
    const child = spawn(NODE, [DLWATCH, 'curldef', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(800);
    const st = readStatus(home);
    // no % sign => no pct captured; status file may still have pct null
    assert.ok(st === null || st.pct === null, 'default meter without % should not set pct');
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});
test('PTY: command sees a TTY by default', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'tty.mjs', "process.stdout.write(process.stdout.isTTY ? 'TTY' : 'PIPE'); process.exit(0);");
    const r = spawnSync(NODE, [DLWATCH, 'tty', '--', NODE, fake], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /TTY/);
    assert.doesNotMatch(r.stdout.toString(), /PIPE/);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: --no-pty command sees a pipe', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'pipe.mjs', "process.stdout.write(process.stdout.isTTY ? 'TTY' : 'PIPE'); process.exit(0);");
    const r = spawnSync(NODE, [DLWATCH, '--no-pty', 'pipe', '--', NODE, fake], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /PIPE/);
    assert.doesNotMatch(r.stdout.toString(), /TTY/);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: ANSI-wrapped progress with CR updates and leading ^D is parsed', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'ansi.mjs', "process.stdout.write('\\x04\\x1b[32m 45.3% \\x1b[0m\\r\\x1b[32m 50.0% \\x1b[0m\\n'); setTimeout(()=>{}, 1500);");
    const child = spawn(NODE, [DLWATCH, 'ansi', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(900);
    const st = readStatus(home);
    assert.ok(st);
    assert.equal(st.pct, 50);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  } finally {
    cleanupHome(home);
  }
});

test('PTY: non-TTY passthrough strips escapes and intermediate CR frames', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'frames.mjs', "process.stdout.write('\\x1b[31m 10% \\x1b[0m\\r'); process.stdout.write('\\x1b[31m 90% \\x1b[0m\\r'); process.stdout.write('\\x1b[31m done \\x1b[0m\\n'); process.exit(0);");
    const r = spawnSync(NODE, [DLWATCH, 'frames', '--', NODE, fake], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0);
    const out = r.stdout.toString();
    assert.doesNotMatch(out, /\x1b/);
    assert.match(out, /done/);
    assert.doesNotMatch(out, /10%/);
    assert.doesNotMatch(out, /90%/);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: exit code 0 passes through', async () => {
  const home = makeHome();
  try {
    const r = spawnSync(NODE, [DLWATCH, 'ec0', '--', NODE, '-e', 'process.exit(0)'], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: exit code 1 passes through', async () => {
  const home = makeHome();
  try {
    const r = spawnSync(NODE, [DLWATCH, 'ec1', '--', NODE, '-e', 'process.exit(1)'], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 1);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: exit code 3 passes through', async () => {
  const home = makeHome();
  try {
    const r = spawnSync(NODE, [DLWATCH, 'ec3', '--', NODE, '-e', 'process.exit(3)'], { env: { ...process.env, HOME: home } });
    assert.equal(r.status, 3);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: SIGTERM removes status file', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'long.mjs', "setInterval(()=>{}, 1000);");
    const child = spawn(NODE, [DLWATCH, 'pterm', '--', NODE, fake], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    await delay(700);
    assert.ok(statusFiles(home).length > 0);
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    assert.equal(statusFiles(home).length, 0);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: HOMEBREW_DOWNLOAD_CONCURRENCY defaults to 1', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'brewenv.mjs', "process.stdout.write('HBDC=' + process.env.HOMEBREW_DOWNLOAD_CONCURRENCY + '\\n'); process.exit(0);");
    const env = { ...process.env, HOME: home };
    delete env.HOMEBREW_DOWNLOAD_CONCURRENCY;
    const r = spawnSync(NODE, [DLWATCH, 'brewenv', '--', NODE, fake], { env });
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /HBDC=1/);
  } finally {
    cleanupHome(home);
  }
});

test('PTY: HOMEBREW_DOWNLOAD_CONCURRENCY is not overridden when set', async () => {
  const home = makeHome();
  try {
    const fake = writeFake(home, 'brewenv2.mjs', "process.stdout.write('HBDC=' + process.env.HOMEBREW_DOWNLOAD_CONCURRENCY + '\\n'); process.exit(0);");
    const env = { ...process.env, HOME: home, HOMEBREW_DOWNLOAD_CONCURRENCY: '7' };
    const r = spawnSync(NODE, [DLWATCH, 'brewenv2', '--', NODE, fake], { env });
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /HBDC=7/);
  } finally {
    cleanupHome(home);
  }
});

test('brew progress from growing download file', async () => {
  const home = makeHome();
  const cache = path.join(home, 'brewcache');
  fs.mkdirSync(path.join(cache, 'downloads'), { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.setHeader('content-length', '1000');
      res.end();
    } else {
      res.end(Buffer.alloc(100));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const fakeBrew = path.join(home, 'brew');
  const code = [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    'const cache = process.env.DLWATCH_BREW_CACHE;',
    'const dir = cache + "/downloads";',
    'const file = dir + "/x--file.incomplete";',
    'let n = 0;',
    'console.log("\\x04\\b\\b\\x1b[34m==>" + "\\x1b[0m \\x1b[1mDownloading http://127.0.0.1:' + port + '/file\\x1b[0m");',
    'const iv = setInterval(() => {',
    '  fs.appendFileSync(file, Buffer.alloc(100));',
    '  n++;',
    '  if (n >= 10) { clearInterval(iv); console.log("#### 100.0%"); process.exit(0); }',
    '}, 200);',
  ].join('\n');
  fs.writeFileSync(fakeBrew, code + '\n');
  fs.chmodSync(fakeBrew, 0o755);

  const env = { ...process.env, HOME: home, DLWATCH_BREW_CACHE: cache, PATH: home + ':' + process.env.PATH };
  const child = spawn(NODE, [DLWATCH, 'brewprog', '--', 'brew', 'fetch', '--cask', '--force', 'claude'], { env, stdio: 'ignore' });
  let exited = false;
  child.on('close', () => { exited = true; });

  let lastPct = null;
  let seenIncreasing = false;
  let sawEta = false;
  const started = Date.now();
  while (Date.now() - started < 5000 && !exited) {
    await delay(250);
    const st = readStatus(home);
    if (st && st.pct != null) {
      if (lastPct != null && st.pct > lastPct) seenIncreasing = true;
      lastPct = st.pct;
      if (st.etaAt && st.etaAt > Date.now()) sawEta = true;
    }
  }
  if (!exited) {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  }
  server.close();

  assert.ok(lastPct != null, 'brew progress pct should be published');
  assert.ok(lastPct < 100, 'pct should stay below 100 during run');
  assert.ok(seenIncreasing, 'pct should increase');
  assert.ok(sawEta, 'etaAt should be in the future');
  cleanupHome(home);
});
