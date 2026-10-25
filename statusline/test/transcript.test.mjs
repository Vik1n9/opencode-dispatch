// ⏳ transcript parser (CLI level): partial lines, UTF-8 offsets, notifications, rotation, cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, installFakePs, runCli, stripAnsi } from './helpers.mjs';

const setup = (t) => {
  const dir = makeHome();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = installFakePs(dir, []);
  return { dir, bin, file: join(dir, 'transcript.jsonl') };
};

const render = ({ dir, bin, file }, session = 's1') => {
  const r = runCli(dir, { bin, input: JSON.stringify({ transcript_path: file, session_id: session }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return stripAnsi(r.stdout);
};

const tasks = (out) => (out.match(/⏳/g) || []).length;

const open = (id, { name = 'Bash', desc = 'build', ts = new Date().toISOString(), bg = true, command = 'make' } = {}) => `${JSON.stringify({
  type: 'assistant',
  timestamp: ts,
  message: { content: [{ type: 'tool_use', id, name, input: { run_in_background: bg, description: desc, command } }] },
})}\n`;

const note = (id, status, order = 'id-first') => (order === 'id-first'
  ? `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status><summary>done</summary></task-notification>`
  : `<task-notification><status>${status}</status><tool-use-id>${id}</tool-use-id><summary>done</summary></task-notification>`);

const notified = (...blocks) => `${JSON.stringify({ type: 'user', message: { content: blocks.join('') } })}\n`;

const cacheFile = (dir, session = 's1') => join(dir, '.cache', 'agent-status', `transcript-${session}.json`);

test('opens background Bash and Agent tasks and prints compact labels', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A', { desc: '建置 專案' }) + open('toolu_B', { name: 'Agent', desc: 'research' }));
  const out = render(s);
  assert.equal(tasks(out), 2);
  assert.match(out, /⏳ 建置 專案 0m/);
  assert.match(out, /⏳ research 0m/);
});

test('failed and killed notifications close tasks', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + open('toolu_B') + notified(note('toolu_A', 'failed'), note('toolu_B', 'killed')));
  assert.equal(tasks(render(s)), 0);
});

test('running notifications keep a task open', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + notified(note('toolu_A', 'running')));
  assert.equal(tasks(render(s)), 1);
});

test('several notifications in one JSONL line all apply', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + open('toolu_B')
    + notified(note('toolu_A', 'completed'), note('toolu_B', 'failed')));
  assert.equal(tasks(render(s)), 0);
});

test('notification with the status before the tool-use id still closes the task', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + notified(note('toolu_A', 'completed', 'status-first')));
  assert.equal(tasks(render(s)), 0);
});

test('tool-use ids containing a dash close normally', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_01A-b') + notified(note('toolu_01A-b', 'completed')));
  assert.equal(tasks(render(s)), 0);
});

test('a notification for an unknown id does not close anything', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + notified(note('toolu_ZZZ', 'completed')));
  assert.equal(tasks(render(s)), 1);
});

test('a partial last line is left for the next render', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A')
    + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_B","name":"Agent","input":{"description":"lat');
  assert.equal(tasks(render(s)), 1);
  writeFileSync(s.file, 'er"}}]}}\n', { flag: 'a' });
  const out = render(s);
  assert.equal(tasks(out), 2);
  assert.match(out, /⏳ later 0m/);
});

test('a multi-byte character split across renders does not shift the offset', (t) => {
  const s = setup(t);
  const prefix = Buffer.from('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_B","name":"Agent","input":{"description":"');
  // 建 (U+5EFA) is E5 BB BA; write the first two bytes, then finish the character later.
  writeFileSync(s.file, Buffer.concat([Buffer.from(open('toolu_A')), prefix, Buffer.from([0xe5, 0xbb])]));
  assert.equal(tasks(render(s)), 1);
  writeFileSync(s.file, Buffer.concat([Buffer.from([0xba]), Buffer.from('置"}}]}}\n')]), { flag: 'a' });
  const out = render(s);
  assert.equal(tasks(out), 2);
  assert.match(out, /⏳ 建置 0m/);
});

test('repeated renders of an unchanged transcript do not duplicate tasks', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A'));
  assert.equal(tasks(render(s)), 1);
  assert.equal(tasks(render(s)), 1);
});

test('a rotated transcript is detected even when the new file is larger', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A'));
  assert.equal(tasks(render(s)), 1);
  const oldSize = statSync(s.file).size;
  const replaced = notified(note('toolu_A', 'completed')) + `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(600) } })}\n`;
  assert.ok(Buffer.byteLength(replaced) > oldSize);
  writeFileSync(`${s.file}.new`, replaced);
  renameSync(`${s.file}.new`, s.file);
  assert.equal(tasks(render(s)), 0);
});

test('a shrunk transcript is replayed from the start', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + open('toolu_B'));
  assert.equal(tasks(render(s)), 2);
  writeFileSync(s.file, open('toolu_C'));
  const out = render(s);
  assert.equal(tasks(out), 1);
  assert.match(out, /⏳ build 0m/);
});

test('tasks older than a day are dropped even when the transcript stops growing', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A'));
  assert.equal(tasks(render(s)), 1);
  const saved = JSON.parse(readFileSync(cacheFile(s.dir), 'utf8'));
  saved.pending.toolu_A.at = Date.now() - 2 * 86400e3;
  writeFileSync(cacheFile(s.dir), JSON.stringify(saved));
  assert.equal(tasks(render(s)), 0);
});

test('a corrupt cache (pending: null) does not throw', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A'));
  assert.equal(tasks(render(s)), 1);
  writeFileSync(cacheFile(s.dir), JSON.stringify({
    path: s.file, ino: statSync(s.file).ino, offset: statSync(s.file).size, pending: null,
  }));
  assert.equal(tasks(render(s)), 1);
});

test('a non-array message content does not crash the parser', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A') + '{"type":"assistant","message":{"content":{"type":"tool_use","name":"Agent"}}}\n');
  const out = render(s);
  assert.equal(tasks(out), 1);
  assert.match(out, /⏳ build 0m/);
});

test('control characters in a task label cannot break the line', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A', { desc: 'a\nb\u001b[2Jc' }));
  const out = render(s);
  assert.equal(tasks(out), 1);
  assert.ok(!out.includes('\x1b[2J'));
  assert.equal(out.trim().split('\n').length, 1);
  assert.match(out, /⏳ a bc 0m/);
});

test('plain Bash and oc-run dispatches are not counted as background tasks', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A', { bg: false })
    + open('toolu_B', { command: 'node /opt/oc-run.mjs --title deploy --model q' }));
  assert.equal(tasks(render(s)), 0);
});

test('an ancient opener is pruned on the first parse', (t) => {
  const s = setup(t);
  writeFileSync(s.file, open('toolu_A', { ts: new Date(Date.now() - 2 * 86400e3).toISOString() }));
  assert.equal(tasks(render(s)), 0);
});

test('a session id cannot escape ~/.cache/agent-status', (t) => {
  const dir = makeHome();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = installFakePs(dir, []);
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, open('toolu_A'));
  const r = runCli(dir, {
    bin,
    input: JSON.stringify({ transcript_path: file, session_id: 'x/../../../pwn' }),
  });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(dir, 'pwn.json')), 'cache escaped the agent-status directory');
  assert.ok(readdirSync(join(dir, '.cache', 'agent-status')).some((n) => n.startsWith('transcript-')));
});
