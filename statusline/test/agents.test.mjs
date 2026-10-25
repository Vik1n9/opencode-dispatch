// ⚙ process scan (log discovery/step counting/labels), ⬇ downloads, stdin handling. Runs the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, makeHome, installFakePs, runCli, stripAnsi } from './helpers.mjs';

const home = (t) => {
  const dir = makeHome();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const scan = (dir, lines, input = '{}\n') => {
  const bin = installFakePs(dir, lines);
  return runCli(dir, { bin, input });
};

const dlFile = (dir, pid, value) => {
  const file = join(dir, '.cache', 'agent-status', `dl-${pid}.json`);
  mkdirSync(join(dir, '.cache', 'agent-status'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return file;
};

// ---------------------------------------------------------------- ⚙ end to end

test('agent line: flags after a quoted title and a trailing prompt', (t) => {
  const dir = home(t);
  const log = join(dir, 'steps.jsonl');
  writeFileSync(log, '{"type":"step_finish"}\n{"type":"step_finish"}\n');
  const r = scan(dir, [
    `4242 12:34 node /opt/oc-run.mjs --title "修正 --model 錯誤" --model openai/gpt-5 --log ${log} "do it"`,
  ]);
  assert.equal(r.status, 0);
  assert.match(stripAnsi(r.stdout), /⚙ 修正 --model 錯誤 gpt-5 12m·2步/);
});

test('agent line: the last flag before a positional prompt is parsed', (t) => {
  const dir = home(t);
  const log = join(dir, 'steps.jsonl');
  writeFileSync(log, '{"type":"step_finish"}\n');
  const r = scan(dir, [
    `4242 12:34 node /opt/oc-run.mjs --log ${log} --title deploy --model openai/gpt-5 "do the thing"`,
  ]);
  assert.equal(r.status, 0);
  assert.match(stripAnsi(r.stdout), /⚙ deploy gpt-5 12m·1步/);
});

test('agent line: --title= form and labels.json mapping', (t) => {
  const dir = home(t);
  const log = join(dir, 'steps.jsonl');
  writeFileSync(log, '{"type":"step_finish"}\n');
  writeFileSync(join(dir, '.cache', 'agent-status', 'labels.json'), JSON.stringify({ deploy: '部署' }));
  const r = scan(dir, [
    `4242 01:05:00 node /opt/oc-run.mjs --title=Hello World --model qwen/qwen3 --log=${log}`,
    `4343 00:30 node /opt/oc-run.mjs --title deploy --model qwen/qwen3-free`,
  ]);
  const out = stripAnsi(r.stdout);
  assert.match(out, /⚙ Hello World qwen3 1h05m·1步/);
  assert.match(out, /⚙ 部署 qwen3 30s/);
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), 'output must end with exactly one newline');
});

test('agent line: labels.json that is not an object must not crash', (t) => {
  const dir = home(t);
  writeFileSync(join(dir, '.cache', 'agent-status', 'labels.json'), 'null');
  const r = scan(dir, ['4242 00:30 node /opt/oc-run.mjs --title deploy --model q']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(stripAnsi(r.stdout), /⚙ deploy q 30s/);
});

test('agent line: a shortened label does not end in a space', (t) => {
  const dir = home(t);
  const r = scan(dir, ['4242 00:30 node /opt/oc-run.mjs --title abcdefghijk lmn --model q']);
  const out = stripAnsi(r.stdout);
  assert.match(out, /⚙ abcdefghijk q 30s/);
  assert.ok(!out.includes('abcdefghijk  '), 'shortened label kept a trailing space');
});

test('agent line: a title is shortened without splitting an emoji', (t) => {
  const dir = home(t);
  const r = scan(dir, ['4242 00:30 node /opt/oc-run.mjs --title abcdefghijk😀tail --model q']);
  const out = stripAnsi(r.stdout);
  assert.match(out, /⚙ abcdefghijk😀 q 30s/);
  assert.ok(!out.includes('\uFFFD'), 'label contains a broken surrogate');
});

test('agent line: control characters in a title cannot break the line', (t) => {
  const dir = home(t);
  const r = scan(dir, ['4242 00:30 node /opt/oc-run.mjs --title dep\u001b[2Jloy --model q']);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('\x1b[2J'), 'raw ANSI escape reached the status line');
  assert.match(stripAnsi(r.stdout), /⚙ deploy q 30s/);
});

test('steps: a log larger than 64 MB is still counted', (t) => {
  const dir = home(t);
  const log = join(dir, 'big.jsonl');
  writeFileSync(log, '{"type":"step_finish"}\n'.repeat(3));
  truncateSync(log, 66 * 1024 * 1024);
  const r = scan(dir, [`4242 12:34 node /opt/oc-run.mjs --title deploy --model q --log ${log}`]);
  assert.equal(r.status, 0);
  assert.match(stripAnsi(r.stdout), /⚙ deploy q 12m·3步/);
});

test('steps: log discovery under $TMPDIR/oc-run', (t) => {
  const dir = home(t);
  mkdirSync(join(dir, 'tmp', 'oc-run'), { recursive: true });
  writeFileSync(join(dir, 'tmp', 'oc-run', 'abc-4242.jsonl'), '{"type":"step_finish"}\n'.repeat(2));
  const r = scan(dir, ['4242 12:34 node /opt/oc-run.mjs --title deploy --model q']);
  assert.match(stripAnsi(r.stdout), /⚙ deploy q 12m·2步/);
});

// ---------------------------------------------------------------- ⬇ downloads

test('downloads: a live pid with an old status file is not shown and is removed', (t) => {
  const dir = home(t);
  const file = dlFile(dir, process.pid, { label: '舊下載', pid: process.pid, pct: 42, etaAt: Date.now() + 60000 });
  const old = new Date(Date.now() - 2 * 86400e3);
  utimesSync(file, old, old);
  const r = scan(dir, []);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('舊下載'), 'stale status file was rendered');
  assert.ok(!existsSync(file), 'stale status file was not cleaned up');
});

test('downloads: a dead pid is not shown and its file is removed', (t) => {
  const dir = home(t);
  const file = dlFile(dir, 999999, { label: 'ghost', pid: 999999, pct: 10 });
  const r = scan(dir, []);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('ghost'));
  assert.ok(!existsSync(file));
});

test('downloads: missing label and invalid eta do not print undefined/NaN', (t) => {
  const dir = home(t);
  dlFile(dir, process.pid, { pid: process.pid, pct: 42, etaAt: 9e15 });
  const r = scan(dir, []);
  const out = stripAnsi(r.stdout);
  assert.equal(r.status, 0);
  assert.ok(!out.includes('undefined'), out);
  assert.ok(!out.includes('NaN'), out);
  assert.match(out, /⬇ 下載 42%/);
});

test('downloads: a non-directory state path must not crash the line', (t) => {
  const dir = home(t);
  const state = join(dir, '.cache', 'agent-status');
  rmSync(state, { recursive: true, force: true });
  writeFileSync(state, 'not a directory');
  const r = scan(dir, ['4242 00:30 node /opt/oc-run.mjs --title deploy --model q']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(stripAnsi(r.stdout), /⚙ deploy q 30s/);
});

// ---------------------------------------------------------------- stdin

test('no stdin, invalid JSON and wrong field types still exit 0 silently', (t) => {
  const dir = home(t);
  const bin = installFakePs(dir, []);
  for (const input of ['', 'not json', '{"transcript_path":42,"session_id":{}}', 'null', '[]']) {
    const r = runCli(dir, { bin, input });
    assert.equal(r.status, 0, `input ${JSON.stringify(input)}`);
    assert.equal(r.stderr, '', `input ${JSON.stringify(input)}`);
    assert.equal(r.stdout, '', `input ${JSON.stringify(input)} printed a second line`);
  }
});

test('a tty on stdin does not block the status line', { skip: !existsSync('/usr/bin/python3') }, (t) => {
  const dir = home(t);
  const bin = installFakePs(dir, []);
  const py = join(dir, 'pty_run.py');
  writeFileSync(py, [
    'import os, pty, select, signal, sys, time',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '    os.execv(sys.argv[1], sys.argv[1:])',
    'end = time.time() + 2.0',
    'while time.time() < end:',
    '    r, _, _ = select.select([fd], [], [], 0.05)',
    '    if r:',
    '        try: os.read(fd, 4096)',
    '        except OSError: pass',
    '    done, st = os.waitpid(pid, os.WNOHANG)',
    '    if done:',
    '        os.close(fd)',
    '        sys.exit(os.waitstatus_to_exitcode(st))',
    'os.kill(pid, signal.SIGKILL)',
    'os.waitpid(pid, 0)',
    'sys.exit(2)',
    '',
  ].join('\n'));
  const env = { ...process.env, HOME: dir, TMPDIR: join(dir, 'tmp'), PATH: `${bin}:${process.env.PATH}`, FAKE_PS: join(dir, 'ps.out') };
  const child = spawnSync('/usr/bin/python3',
    [py, process.execPath, join(ROOT, 'statusline-agents.mjs')], { env, encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, `pty run hung (status ${child.status})`);
});
