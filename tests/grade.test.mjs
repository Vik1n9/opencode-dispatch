import assert from 'node:assert/strict';
import test from 'node:test';
import { benchTable, record, run, tempHome, trackScript, writeBenchmarks } from './helpers.mjs';

async function grade(t, overrides) {
  const home = tempHome();
  writeBenchmarks(home, benchTable());
  const r = run(trackScript, ['grade', '--json', JSON.stringify(record(overrides))], home);
  t.diagnostic(`grade(${JSON.stringify(overrides)}) -> ${r.out.trim()}`);
  return r;
}

test('grade: no quality -> correctness only', async (t) => {
  const r = await grade(t, {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '100');
});

test('grade: quality 70 -> 85', async (t) => {
  const r = await grade(t, { quality: 70 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '85');
});

test('grade: quality 70 plus one major defect -> 78', async (t) => {
  // correctness 100 - 15 = 85; grade = round(0.5 * 85 + 0.5 * 70) = 77.5 -> 78
  const r = await grade(t, { quality: 70, defects: [{ severity: 'major', text: 'breaks the spec' }] });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '78');
});

test('grade: failed with quality 100 is capped at 40', async (t) => {
  const r = await grade(t, { result: 'failed', quality: 100 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '40');
});

for (const quality of [150, 'abc', null]) {
  test(`grade: invalid quality ${JSON.stringify(quality)} exits 2`, async (t) => {
    const r = await grade(t, { quality });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /quality must be a number 0–100/);
  });
}
