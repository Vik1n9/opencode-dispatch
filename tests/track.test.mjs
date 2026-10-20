import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { benchTable, readInternal, record, run, tempHome, trackScript, writeBenchmarks, writeJson } from './helpers.mjs';

const trackPath = (home) => join(home, 'track.jsonl');
const benchText = (home) => readFileSync(join(home, 'benchmarks.json'), 'utf8');
const trackRecords = (home) => readFileSync(trackPath(home), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const seedTrack = (home, records) => writeFileSync(trackPath(home), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('add + recompute: internal fields, 10-record window, speed ratio, untouched benchmarks', (t) => {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  const before = benchText(home);

  // 12 alpha records: the first two grade 100, the next nine grade 80, the last one has no quality (grade 100).
  // Only the last 10 count, so score = (9 * 80 + 100) / 10 = 82; quality = 60 over the 9 that have it.
  const alpha = Array.from({ length: 12 }, (_, i) => record({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    seconds: undefined,
    ...(i < 2 ? { quality: 100 } : i === 11 ? {} : { quality: 60 }),
  }));
  seedTrack(home, alpha);

  let r = run(trackScript, ['recompute'], home);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), 'recomputed 12 records');
  assert.equal(benchText(home), before, 'recompute must never write benchmarks.json');

  let internal = readInternal(home);
  assert.ok(internal.generated && !Number.isNaN(Date.parse(internal.generated)));
  assert.deepEqual(internal.models.alpha['repo-coding'], {
    score: 82, correctness: 100, quality: 64, qn: 10, n: 12, updated: '2026-10-12', speed: {},
  });
  assert.equal(internal.models.gamma, undefined, 'a model with no records stays out of internal.json');
  assert.equal(internal.models.alpha.terminal, undefined, 'a category with no records stays out');

  // One speed task with three beta runs: 7s / 10s / 23s -> ratios 1 / 1.43 / 3.29, median 1.43.
  const speedRuns = [
    { date: '2026-10-13', seconds: 7 },
    { date: '2026-10-14', seconds: 10 },
    { date: '2026-10-15', seconds: 23 },
  ];
  for (const [i, run0] of speedRuns.entries()) {
    r = run(trackScript, ['add', '--json', JSON.stringify(record({
      date: run0.date, category: 'terminal', model: 'beta/two', taskId: 'speed-task', seconds: run0.seconds,
    }))], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /recorded: beta \/ terminal graded 100/);
    assert.equal(benchText(home), before, 'add must never write benchmarks.json');
    if (i === 0) assert.match(r.stdout, /internal score 100 \(1 records\)/);
  }

  internal = readInternal(home);
  assert.deepEqual(internal.models.alpha['repo-coding'], {
    score: 82, correctness: 100, quality: 64, qn: 10, n: 12, updated: '2026-10-12', speed: {},
  }, 'adding another model must not change an existing aggregate');
  assert.deepEqual(internal.models.beta.terminal, {
    score: 100,
    correctness: 100,
    quality: null,
    qn: 0,
    n: 3,
    updated: '2026-10-15',
    speed: { 'beta/two': { ratio: 1.43, n: 3, medianSeconds: 10 } },
  });

  const stored = trackRecords(home).filter((x) => x.model === 'beta/two');
  assert.deepEqual(stored.map((x) => x.speedRatio), [1, 1.43, 3.29]);
});

test('limited: stays in the track but changes no aggregate', (t) => {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  seedTrack(home, [
    record({ date: '2026-10-01', category: 'terminal', model: 'beta/two', taskId: 'speed-task', seconds: 10 }),
    record({ date: '2026-10-02', category: 'terminal', model: 'beta/two', taskId: 'speed-task', seconds: 12 }),
    record({ date: '2026-10-03', category: 'terminal', model: 'beta/two', taskId: 'speed-task', seconds: 20 }),
  ]);

  let r = run(trackScript, ['recompute'], home);
  assert.equal(r.code, 0, r.out);
  const before = readInternal(home).models.beta.terminal;
  assert.deepEqual(before.speed['beta/two'], { ratio: 1.2, n: 3, medianSeconds: 12 });

  // The fastest run of the task, but it was cut off by a rate limit: it must not touch score, n or speed.
  r = run(trackScript, ['add', '--json', JSON.stringify(record({
    date: '2026-10-04', category: 'terminal', model: 'beta/two', taskId: 'speed-task', seconds: 1,
    result: 'limited', quality: 0, returns: 5, handoffFrom: 'vendor/nowhere',
  }))], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /limited, not counted/);

  assert.deepEqual(readInternal(home).models.beta.terminal, before);

  const stored = trackRecords(home);
  assert.equal(stored.length, 4, 'the limited record is still in track.jsonl');
  const last = stored.at(-1);
  assert.equal(last.result, 'limited');
  assert.equal(last.handoffFrom, 'vendor/nowhere');
  assert.equal(typeof last.correctness, 'number');
  assert.equal(typeof last.grade, 'number');
  assert.equal(last.speedRatio, undefined);

  r = run(trackScript, ['show', '--last', '1'], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /c:50 q:0 limited/);
});

test('recompute: rebuilds internal.json from scratch and keeps show in the new format', (t) => {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  seedTrack(home, [record({ date: '2026-10-09', quality: 70 })]);
  writeJson(join(home, 'internal.json'), { generated: 'stale', models: { ghost: { 'repo-coding': { score: 1 } } } });

  const r = run(trackScript, ['recompute'], home);
  assert.equal(r.code, 0, r.out);
  const internal = readInternal(home);
  assert.equal(internal.models.ghost, undefined, 'hand-written internal data is discarded');
  assert.equal(internal.models.alpha['repo-coding'].score, 85);
  assert.equal(internal.models.alpha['repo-coding'].quality, 70);
  assert.equal(internal.models.alpha['repo-coding'].qn, 1);

  const shown = run(trackScript, ['show'], home);
  assert.match(shown.stdout, /85pts c:100 q:70 passed/);
});
