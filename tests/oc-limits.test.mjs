import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  makeSandbox, runScript, writeJson, configDir, SCRIPTS,
} from './helpers.mjs';

const MODULE = pathToFileURL(join(SCRIPTS, 'oc-limits.mjs')).href;
const limitsPath = (sb) => join(configDir(sb), 'limits.json');
const status = (sb, args = []) => runScript(sb, 'oc-limits.mjs', ['status', ...args]);

// recordHit is not exposed on the CLI (only status/clear are), so call the module in a child
// process with the sandbox HOME to keep the clock under test control.
function recordHit(sb, id, now) {
  const code = `import { recordHit } from ${JSON.stringify(MODULE)};`
    + `recordHit(${JSON.stringify(id)}, 'Rate limit exceeded.', new Date(${JSON.stringify(now)}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: sb.env });
  assert.equal(r.status, 0, r.stderr);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const entry = (sb, id = 'opencode/a') => readJson(limitsPath(sb))[id];

const T0 = '2026-10-19T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const at = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();

// The schedule is hitAt + [1 h, 3 h, 6 h, 24 h] for failed probes 0..3, then lastProbe + 24 h.
test('oc-limits: each failed probe moves nextProbe down the backoff', (t) => {
  const sb = makeSandbox();
  const steps = [
    { now: T0, probes: 0, next: 1 * HOUR, last: T0 },
    { now: at(30 * 60 * 1000), probes: 1, next: 3 * HOUR, last: at(30 * 60 * 1000) },
    { now: at(2 * HOUR), probes: 2, next: 6 * HOUR, last: at(2 * HOUR) },
    { now: at(5 * HOUR), probes: 3, next: 24 * HOUR, last: at(5 * HOUR) },
    { now: at(20 * HOUR), probes: 4, next: 44 * HOUR, last: at(20 * HOUR) },
  ];
  for (const step of steps) {
    recordHit(sb, 'opencode/a', step.now);
    const e = entry(sb);
    assert.equal(e.probes, step.probes, `probes after hit at ${step.now}`);
    assert.equal(e.hitAt, T0);
    assert.equal(e.lastProbe, step.last);
    assert.equal(e.nextProbe, at(step.next));
  }
});

test('oc-limits: status text and --json report DUE at nextProbe, not before', (t) => {
  const sb = makeSandbox();
  recordHit(sb, 'opencode/a', T0);

  const early = status(sb, ['--now', at(HOUR - 1000)]);
  assert.equal(early.status, 0);
  assert.match(early.stdout, /opencode\/a\s+hit .* probes 0 .* next probe/);
  assert.doesNotMatch(early.stdout, /DUE/);
  assert.equal(early.json, null);

  const due = status(sb, ['--now', at(HOUR)]);
  assert.equal(due.status, 0);
  assert.match(due.stdout, /DUE/);

  const earlyJson = status(sb, ['--json', '--now', at(HOUR - 1000)]);
  assert.equal(earlyJson.status, 0);
  assert.deepEqual(Object.keys(earlyJson.json.models['opencode/a']).sort(),
    ['due', 'hitAt', 'lastProbe', 'message', 'nextProbe', 'probes']);
  assert.equal(earlyJson.json.models['opencode/a'].due, false);
  assert.equal(earlyJson.json.models['opencode/a'].hitAt, T0);
  assert.equal(earlyJson.json.models['opencode/a'].nextProbe, at(HOUR));
  assert.equal(status(sb, ['--json', '--now', at(HOUR)]).json.models['opencode/a'].due, true);
});

test('oc-limits: clear removes one model and reports it', (t) => {
  const sb = makeSandbox();
  recordHit(sb, 'opencode/a', T0);
  recordHit(sb, 'opencode/b', T0);

  const r = runScript(sb, 'oc-limits.mjs', ['clear', 'opencode/a']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'cleared opencode/a');
  assert.deepEqual(Object.keys(readJson(limitsPath(sb))), ['opencode/b']);

  const rest = status(sb, ['--json']);
  assert.deepEqual(Object.keys(rest.json.models), ['opencode/b']);

  const last = runScript(sb, 'oc-limits.mjs', ['clear', 'opencode/b']);
  assert.equal(last.status, 0);
  const empty = status(sb);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.trim(), 'no paused models');
});

test('oc-limits: --json with no pauses is an empty models object', (t) => {
  const sb = makeSandbox();
  const r = status(sb, ['--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { models: {} });
  assert.equal(status(sb).stdout.trim(), 'no paused models');
});

test('oc-limits: a corrupt file warns once, is treated as empty, and exits 0', (t) => {
  const sb = makeSandbox();
  writeJson(limitsPath(sb), {});
  writeFileSync(limitsPath(sb), '{not json');

  const text = status(sb);
  assert.equal(text.status, 0);
  assert.equal(text.stdout.trim(), 'no paused models');
  assert.match(text.stderr, /limits\.json is not valid JSON; ignoring it/);

  const json = status(sb, ['--json']);
  assert.equal(json.status, 0);
  assert.deepEqual(json.json, { models: {} });
  assert.match(json.stderr, /limits\.json is not valid JSON; ignoring it/);

  // One warning per process, however many reads happen.
  const code = `import { readLimits } from ${JSON.stringify(MODULE)}; readLimits(); readLimits(); readLimits();`;
  const one = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: sb.env });
  assert.equal(one.status, 0);
  assert.equal(one.stderr.match(/limits\.json is not valid JSON; ignoring it/g).length, 1);
});

// Legacy Mac mini shape: { models: { <id>: { hitAt, message, probes, lastProbe, nextProbe } } }.
const legacyFile = (sb) => writeJson(limitsPath(sb), {
  models: {
    'opencode/a': { hitAt: T0, message: 'Rate limit exceeded.', probes: 1, lastProbe: at(30 * 60 * 1000), nextProbe: at(3 * HOUR) },
    'opencode/b': { hitAt: T0, message: 'Rate limit exceeded.', probes: 0, lastProbe: T0, nextProbe: at(HOUR) },
  },
});

test('oc-limits: a legacy { models: ... } limits.json is read; status lists both paused models', (t) => {
  const sb = makeSandbox();
  legacyFile(sb);
  const r = status(sb, ['--now', at(2 * HOUR)]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /opencode\/a\s+hit .* probes 1 .* next probe/);
  assert.match(r.stdout, /opencode\/b\s+hit .* probes 0 .* next probe/);
  assert.doesNotMatch(r.stdout, /no paused models/);
  // opencode/b's nextProbe (hit + 1 h) has passed at now = hit + 2 h: it is DUE; a's (hit + 3 h) is not.
  assert.match(r.stdout, /opencode\/b .*DUE/);
  assert.doesNotMatch(r.stdout, /opencode\/a .*DUE/);

  const j = status(sb, ['--json', '--now', at(2 * HOUR)]);
  assert.equal(j.status, 0);
  assert.deepEqual(Object.keys(j.json.models).sort(), ['opencode/a', 'opencode/b']);
  assert.equal(j.json.models['opencode/a'].probes, 1);
  assert.equal(j.json.models['opencode/a'].nextProbe, at(3 * HOUR));
  assert.equal(j.json.models['opencode/a'].due, false);
  assert.equal(j.json.models['opencode/b'].due, true);
});

test('oc-limits: a legacy file becomes flat on the next write and keeps the other entry', (t) => {
  const sb = makeSandbox();
  legacyFile(sb);
  const r = runScript(sb, 'oc-limits.mjs', ['clear', 'opencode/a']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'cleared opencode/a');

  const data = readJson(limitsPath(sb));
  assert.equal(data.models, undefined, 'the legacy wrapper is gone');
  assert.equal('opencode/a' in data, false);
  const b = data['opencode/b'];
  // The schedule fields survive the conversion, and the entry gained the flat record fields.
  assert.equal(b.hitAt, T0);
  assert.equal(b.probes, 0);
  assert.equal(b.lastProbe, T0);
  assert.equal(b.nextProbe, at(HOUR));
  assert.equal(b.message, 'Rate limit exceeded.');
  assert.equal(b.until, null);
  assert.equal(b.source, 'probe');

  // The re-probe backoff continues from the converted entry: the next hit is probe 1 -> hitAt + 3 h.
  recordHit(sb, 'opencode/b', at(70 * 60 * 1000));
  const e = entry(sb, 'opencode/b');
  assert.equal(e.probes, 1);
  assert.equal(e.hitAt, T0);
  assert.equal(e.nextProbe, at(3 * HOUR));
});

test('oc-limits: bad usage exits 2 with the usage line', (t) => {
  const sb = makeSandbox();
  const cases = [
    [],
    ['bogus'],
    ['status', '--bogus'],
    ['status', '--now'],
    ['clear'],
    ['clear', 'opencode/a', 'extra'],
  ];
  for (const args of cases) {
    const r = runScript(sb, 'oc-limits.mjs', args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: oc-limits\.mjs status \[--json\] \[--now <iso>\] \| clear <id>/, args.join(' '));
  }
  const badNow = runScript(sb, 'oc-limits.mjs', ['status', '--now', 'not-a-date']);
  assert.equal(badNow.status, 2);
  assert.match(badNow.stderr, /invalid --now: not-a-date/);
});
