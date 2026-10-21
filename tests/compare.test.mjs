import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { benchTable, record, run, tempHome, trackScript, writeBenchmarks } from './helpers.mjs';

// One task run by three models (one failed, one without quality) plus an unrelated record.
function seeded() {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  const records = [
    record({ taskId: 'ab-1', task: 'add compare view', model: 'alpha/one', seconds: 40, steps: 6, quality: 100 }),
    record({ taskId: 'other', task: 'unrelated', model: 'alpha/one', seconds: 5 }),
    record({ taskId: 'ab-1', task: 'later wording', model: 'beta/two', result: 'passed, merged', seconds: 20, steps: 4, returns: 1,
      defects: [{ severity: 'minor', text: 'naming' }] }),
    record({ taskId: 'ab-1', task: 'later wording', model: 'vendor/weak', result: 'failed', seconds: 10, steps: 3, quality: 50,
      defects: [{ severity: 'major', text: 'breaks spec' }, { severity: 'minor', text: 'typo' }] }),
  ];
  writeFileSync(join(home, 'track.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = run(trackScript, ['recompute'], home);
  assert.equal(r.code, 0, r.out);
  return home;
}

test('compare: one aligned row per run of the task, in file order, plus fastest / best line', (t) => {
  const home = seeded();
  const r = run(trackScript, ['compare', '--task-id', 'ab-1'], home);
  assert.equal(r.code, 0, r.out);
  t.diagnostic(r.stdout);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'ab-1 — add compare view');

  const rows = lines.slice(1, 4).map((l) => l.split(/\s{2,}/));
  assert.deepEqual(rows, [
    ['alpha/one', 'passed', '100pts', 'c:100', 'q:100', '40s', '6 steps', 'x2', 'returns:0', '0M/0m'],
    ['beta/two', 'passed', '85pts', 'c:85', '–', '20s', '4 steps', 'x1', 'returns:1', '0M/1m'],
    ['vendor/weak', 'failed', '40pts', 'c:40', 'q:50', '10s', '3 steps', '–', 'returns:0', '1M/1m'],
  ]);
  // Aligned: every column starts at the same offset on every row.
  const starts = (l) => [...l.matchAll(/(?:^|\s{2,})(\S)/g)].map((m) => m.index + m[0].length - 1);
  assert.deepEqual(starts(lines[2]), starts(lines[1]));
  assert.deepEqual(starts(lines[3]), starts(lines[1]));

  // The failed run is faster but does not count; alpha has the best grade.
  assert.equal(lines[4], 'fastest passing: beta/two (20s) · highest grade: alpha/one (100pts)');
});

test('compare: unknown task id exits 1', () => {
  const r = run(trackScript, ['compare', '--task-id', 'nope'], seeded());
  assert.equal(r.code, 1);
  assert.match(r.out, /no records for taskId nope/);
});

test('compare: missing --task-id prints usage and exits 2', () => {
  const r = run(trackScript, ['compare'], seeded());
  assert.equal(r.code, 2);
  assert.match(r.out, /usage: oc-track\.mjs compare --task-id <id>/);
});

test('show --task-id: filters, and combines with --model', () => {
  const home = seeded();
  let r = run(trackScript, ['show', '--task-id', 'ab-1'], home);
  assert.equal(r.code, 0, r.out);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !l.includes('unrelated')));

  r = run(trackScript, ['show', '--task-id', 'ab-1', '--model', 'beta'], home);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1);
  assert.match(r.stdout, /beta \[repo-coding\] 85pts/);

  r = run(trackScript, ['show', '--task-id', 'nope'], home);
  assert.equal(r.stdout.trim(), 'no matching records');
});
