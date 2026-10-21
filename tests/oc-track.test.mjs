import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeSandbox, runScript, writeShim, writeJson, writeScores, writeTrack, configDir, readJson, SHIM_OK,
} from './helpers.mjs';

const CAT = 'repo-coding';
const A = 'opencode/model-a-free';
const B = 'opencode-go/model-b';
const C = 'deepseek/model-c';

function scores() {
  return {
    categories: {
      [CAT]: { label: 'Fix bugs', benchmarks: ['SWE-bench Verified'] },
      terminal: { label: 'Terminal', benchmarks: ['Terminal-Bench 2.1'] },
    },
    models: {
      a: { name: 'A', aliases: [A], scores: {} },
      b: { name: 'B', aliases: [B], scores: {} },
      c: { name: 'C', aliases: [C], scores: {} },
    },
  };
}

function sb(t) {
  const box = makeSandbox();
  writeShim(box);
  writeScores(box, scores());
  return box;
}

const rec = (over = {}) => ({
  date: '2026-10-19',
  task: 'test task',
  category: CAT,
  model: A,
  result: 'passed',
  ...over,
});

const grade = (box, record) => {
  const r = runScript(box, 'oc-track.mjs', ['grade', '--json', JSON.stringify(record)], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
};

test('oc-track: grade subtracts returns, defects, scope and rerunFail', (t) => {
  const box = sb(t);
  assert.equal(grade(box, rec()), 100);
  assert.equal(grade(box, rec({ returns: 3 })), 70);
  assert.equal(grade(box, rec({ defects: [{ severity: 'major', text: 'x' }, { severity: 'major', text: 'y' }] })), 70);
  assert.equal(grade(box, rec({ defects: [{ severity: 'minor', text: 'x' }, { severity: 'minor', text: 'y' }] })), 90);
  assert.equal(grade(box, rec({ scope: 2 })), 90);
  assert.equal(grade(box, rec({ rerunFail: true })), 90);
  assert.equal(grade(box, rec({ returns: 1, defects: [{ severity: 'major', text: 'x' }, { severity: 'minor', text: 'y' }], scope: 1, rerunFail: true })), 55);
});

test('oc-track: failed and aborted cap the grade at 40', (t) => {
  const box = sb(t);
  assert.equal(grade(box, rec({ result: 'failed' })), 40);
  assert.equal(grade(box, rec({ result: 'aborted' })), 40);
  assert.equal(grade(box, rec({ result: 'failed, not merged (shadow)', returns: 2 })), 40);
  // a low score stays low under the cap
  assert.equal(grade(box, rec({ result: 'failed', returns: 5 })), 40);
});

test('oc-track: the grade floor is 0', (t) => {
  const box = sb(t);
  assert.equal(grade(box, rec({ returns: 10 })), 0);
  assert.equal(grade(box, rec({ returns: 20, scope: 5 })), 0);
});

test('oc-track: internal score is the mean of the last 10 records in the category', (t) => {
  const box = sb(t);
  // returns 0..11 -> grades 100,90,…,10,0,0; the last 10 average 36
  for (let i = 0; i < 12; i++) {
    const r = runScript(box, 'oc-track.mjs',
      ['add', '--json', JSON.stringify(rec({ returns: i, task: `t${i}` }))], { env: SHIM_OK });
    assert.equal(r.status, 0, r.stderr);
  }
  const saved = readJson(join(configDir(box), 'scores.json'));
  assert.equal(saved.models.a.internal[CAT].score, 36);
  assert.equal(saved.models.a.internal[CAT].n, 12);
});

test('oc-track: a separate category keeps a separate internal score', (t) => {
  const box = sb(t);
  const add = (record) => {
    const r = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(record)], { env: SHIM_OK });
    assert.equal(r.status, 0, r.stderr);
  };
  add(rec({ returns: 1 }));
  add(rec({ category: 'terminal', returns: 4 }));
  const saved = readJson(join(configDir(box), 'scores.json'));
  assert.equal(saved.models.a.internal[CAT].score, 90);
  assert.equal(saved.models.a.internal.terminal.score, 60);
});

test('oc-track: speed ratios per taskId use the fastest passing run and skip non-comparable runs', (t) => {
  const box = sb(t);
  const add = (record) => {
    const r = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(record)], { env: SHIM_OK });
    assert.equal(r.status, 0, r.stderr);
  };
  add(rec({ model: A, seconds: 100, taskId: 'task-1' }));
  add(rec({ model: B, seconds: 200, taskId: 'task-1' }));
  add(rec({ model: C, seconds: 50, taskId: 'task-1', speedComparable: false }));
  const saved = readJson(join(configDir(box), 'scores.json'));
  assert.deepEqual(saved.models.a.internal[CAT].speed[A], { ratio: 1, n: 1, medianSeconds: 100 });
  assert.deepEqual(saved.models.b.internal[CAT].speed[B], { ratio: 2, n: 1, medianSeconds: 200 });
  // C excluded from the comparison, but its median seconds still record the run
  assert.equal(saved.models.c.internal[CAT].speed[C].ratio, null);
  assert.equal(saved.models.c.internal[CAT].speed[C].n, 0);
});

test('oc-track: speed ratios ignore failed runs when finding the fastest', (t) => {
  const box = sb(t);
  const add = (record) => {
    const r = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(record)], { env: SHIM_OK });
    assert.equal(r.status, 0, r.stderr);
  };
  add(rec({ model: A, seconds: 100, taskId: 'task-2' }));
  add(rec({ model: B, seconds: 200, taskId: 'task-2' }));
  add(rec({ model: C, seconds: 10, taskId: 'task-2', result: 'failed' }));
  const saved = readJson(join(configDir(box), 'scores.json'));
  assert.deepEqual(saved.models.a.internal[CAT].speed[A], { ratio: 1, n: 1, medianSeconds: 100 });
  assert.deepEqual(saved.models.b.internal[CAT].speed[B], { ratio: 2, n: 1, medianSeconds: 200 });
});

test('oc-track: validation errors exit 2', (t) => {
  const box = sb(t);
  const run = (args) => runScript(box, 'oc-track.mjs', args, { env: SHIM_OK });
  const cases = [
    { args: ['grade', '--json', JSON.stringify(rec({ date: undefined }))], why: /missing field: date/ },
    { args: ['grade', '--json', JSON.stringify(rec({ category: 'nope' }))], why: /unknown category: nope/ },
    { args: ['grade', '--json', JSON.stringify(rec({ defects: [{ severity: 'huge', text: 'x' }] }))], why: /invalid defects/ },
    { args: ['grade', '--json', JSON.stringify(rec({ defects: 'nope' }))], why: /invalid defects/ },
    { args: ['grade', '--json', JSON.stringify(rec({ result: 'maybe' }))], why: /invalid result: maybe/ },
    { args: ['grade', '--json', JSON.stringify(rec({ returns: -1 }))], why: /invalid returns: -1/ },
    { args: ['grade', '--json', JSON.stringify(rec({ returns: 1.5 }))], why: /invalid returns: 1.5/ },
    { args: ['grade', '--json', JSON.stringify(rec({ scope: -2 }))], why: /invalid scope: -2/ },
    { args: ['grade', '--json', JSON.stringify(rec({ seconds: -1 }))], why: /invalid seconds: -1/ },
    { args: ['grade', '--json', JSON.stringify(rec({ model: 'nope/nope' }))], why: /model not in scores\.json/ },
    { args: ['grade', '--json', '{not json'], why: /invalid JSON/ },
    { args: ['grade', '--json', '[]'], why: /not a JSON object/ },
    { args: ['grade'], why: /needs --json or --file/ },
    { args: ['grade', '--file', join(box.dir, 'missing.json')], why: /cannot read .*file not found/ },
    { args: ['show', '--model', 'nope/nope'], why: /model not in scores\.json/ },
    { args: [], why: /usage: oc-track\.mjs/ },
  ];
  for (const c of cases) {
    const r = run(c.args);
    assert.equal(r.status, 2, c.args.join(' '));
    assert.match(r.stderr, c.why);
  }
});

test('oc-track: legacy Chinese results are accepted', (t) => {
  const box = sb(t);
  assert.equal(grade(box, rec({ result: '一次通過' })), 100);
  assert.equal(grade(box, rec({ result: '退回後通過', returns: 1 })), 90);
  assert.equal(grade(box, rec({ result: '未通過' })), 40);
  assert.equal(grade(box, rec({ result: '中止' })), 40);
});

test('oc-track: show skips a corrupt track line; add and recompute refuse and write nothing', (t) => {
  const box = sb(t);
  const trackPath = writeTrack(box, [JSON.stringify(rec({ returns: 1 })), '{corrupt']);
  const scoresPath = join(configDir(box), 'scores.json');
  const trackBefore = readFileSync(trackPath);
  const scoresBefore = readFileSync(scoresPath);

  const show = runScript(box, 'oc-track.mjs', ['show'], { env: SHIM_OK });
  assert.equal(show.status, 0);
  assert.match(show.stderr, /line 2 is not valid JSON; skipped/);
  assert.match(show.stdout, /test task/);

  const add = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(rec({ task: 'new' }))], { env: SHIM_OK });
  assert.equal(add.status, 2);
  assert.match(add.stderr, /line 2 is not valid JSON; fix or remove it first/);
  assert.deepEqual(readFileSync(trackPath), trackBefore);
  assert.deepEqual(readFileSync(scoresPath), scoresBefore);

  const recompute = runScript(box, 'oc-track.mjs', ['recompute'], { env: SHIM_OK });
  assert.equal(recompute.status, 2);
  assert.match(recompute.stderr, /line 2 is not valid JSON; fix or remove it first/);
  assert.deepEqual(readFileSync(trackPath), trackBefore);
  assert.deepEqual(readFileSync(scoresPath), scoresBefore);
});

test('oc-track: a symlinked scores.json stays a symlink after add', (t) => {
  const box = sb(t);
  const real = join(box.dir, 'real-scores.json');
  writeJson(real, scores());
  const link = join(configDir(box), 'scores.json');
  rmSync(link);
  symlinkSync(real, link);

  const r = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(rec())], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(realpathSync(link), realpathSync(real));
  const saved = readJson(real);
  assert.equal(saved.models.a.internal[CAT].score, 100);
});

test('oc-track: recompute rebuilds every internal score from the track record', (t) => {
  const box = sb(t);
  const add = (record) => {
    const r = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(record)], { env: SHIM_OK });
    assert.equal(r.status, 0, r.stderr);
  };
  add(rec({ returns: 1 }));
  add(rec({ model: B, returns: 3 }));

  // Wipe the derived scores, then rebuild them from track.jsonl.
  const scoresPath = join(configDir(box), 'scores.json');
  const data = readJson(scoresPath);
  data.models.a.internal = { score: 1, n: 99 };
  writeFileSync(scoresPath, JSON.stringify(data, null, 2) + '\n');

  const r = runScript(box, 'oc-track.mjs', ['recompute'], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recomputed 2 records/);
  const saved = readJson(scoresPath);
  assert.equal(saved.models.a.internal[CAT].score, 90);
  assert.equal(saved.models.a.internal[CAT].n, 1);
  assert.equal(saved.models.b.internal[CAT].score, 70);
});

test('oc-track: show filters by model, category and --last', (t) => {
  const box = sb(t);
  const add = (record) => {
    const r = runScript(box, 'oc-track.mjs', ['add', '--json', JSON.stringify(record)], { env: SHIM_OK });
    assert.equal(r.status, 0, r.stderr);
  };
  add(rec({ task: 'first', returns: 1 }));
  add(rec({ task: 'second' }));
  add(rec({ model: B, task: 'other model' }));
  add(rec({ category: 'terminal', task: 'other category' }));

  const run = (args) => runScript(box, 'oc-track.mjs', ['show', ...args], { env: SHIM_OK });
  const last = run(['--last', '1']);
  assert.equal(last.status, 0);
  assert.equal(last.stdout.trim().split('\n').length, 1);
  assert.match(last.stdout, /other category/);

  const model = run(['--model', A]);
  assert.equal(model.stdout.trim().split('\n').length, 3);
  assert.ok(!model.stdout.includes('other model'));

  const cat = run(['--category', CAT]);
  assert.equal(cat.stdout.trim().split('\n').length, 3);
  assert.ok(!cat.stdout.includes('other category'));

  const none = run(['--model', C]);
  assert.match(none.stdout, /no matching records/);
});

test('oc-track: add --file appends one record and prints the graded summary', (t) => {
  const box = sb(t);
  const file = join(box.dir, 'record.json');
  writeFileSync(file, JSON.stringify(rec({ seconds: 12, steps: 3 })));
  const r = runScript(box, 'oc-track.mjs', ['add', '--file', file], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recorded: a \/ repo-coding graded 100 -> internal score 100 \(1 records\)/);
  const lines = readFileSync(join(configDir(box), 'track.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const saved = JSON.parse(lines[0]);
  assert.equal(saved.grade, 100);
  assert.equal(saved.modelKey, 'a');
});

test('oc-track: a missing score table exits 2', (t) => {
  const box = makeSandbox();
  writeShim(box);
  const r = runScript(box, 'oc-track.mjs', ['show'], { env: SHIM_OK });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read the score table .*file not found/);
});
