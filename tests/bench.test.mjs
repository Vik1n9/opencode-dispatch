import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repo, run, tempHome, writeJson } from './helpers.mjs';

const script = join(repo, 'skills/opencode-dispatch/scripts/oc-bench.mjs');

const score = (value, source = 'vendor', ref = 'https://example.invalid/ref') => ({ value, source, ref });

// Two categories, both scored, so a clean fixture also exercises the "every benchmark has a score" path.
function baseTable() {
  return {
    _about: 'fixture',
    categories: {
      terminal: { label: 'Terminal', benchmarks: ['Bench A'] },
      coding: { label: 'Coding', benchmarks: ['Bench B'] },
    },
    models: {
      alpha: { name: 'Alpha', aliases: ['alpha/one'], scores: { 'Bench A': score(80) } },
      beta: { name: 'Beta', aliases: ['beta/two'], scores: { 'Bench B': score(70) } },
    },
  };
}

function setup(table = baseTable()) {
  const home = tempHome();
  const file = join(home, 'benchmarks.json');
  writeJson(file, table);
  return { home, file };
}

const bench = (file, args, home) => run(script, [...args, '--file', file], home);
const read = (file) => readFileSync(file, 'utf8');

test('lint: clean table exits 0 and prints only the ok line', () => {
  const { home, file } = setup();
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), 'ok (2 models, 2 categories)');
});

test('lint error: category without a label', () => {
  const table = baseTable();
  delete table.categories.terminal.label;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error categories\.terminal: missing label$/m);
  assert.match(r.stdout, /^1 errors$/m);
});

test('lint error: category with empty benchmarks', () => {
  const table = baseTable();
  table.categories.terminal.benchmarks = [];
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error categories\.terminal: missing or empty benchmarks$/m);
});

test('lint error: category with missing benchmarks', () => {
  const table = baseTable();
  delete table.categories.terminal.benchmarks;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error categories\.terminal: missing or empty benchmarks$/m);
});

test('lint error: benchmark listed twice in one category', () => {
  const table = baseTable();
  table.categories.terminal.benchmarks.push('Bench A');
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error categories\.terminal: benchmark "Bench A" listed twice$/m);
});

test('lint error: model without a name', () => {
  const table = baseTable();
  delete table.models.beta.name;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.beta: missing name$/m);
});

test('lint error: model with empty aliases', () => {
  const table = baseTable();
  table.models.beta.aliases = [];
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.beta: missing or empty aliases$/m);
});

test('lint error: model with missing aliases', () => {
  const table = baseTable();
  delete table.models.beta.aliases;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.beta: missing or empty aliases$/m);
});

test('lint error: alias used by two models names both keys', () => {
  const table = baseTable();
  table.models.beta.aliases.push('alpha/one');
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.aliases: alias "alpha\/one" is also used by beta$/m);
});

test('lint error: score whose benchmark is in no category', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench Z'] = score(50);
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench Z: benchmark "Bench Z" is in no category$/m);
});

test('lint error: non-numeric score value', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench A'].value = '80';
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench A: value must be a number 0–100$/m);
});

test('lint error: score value above 100', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench A'].value = 150;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench A: value must be a number 0–100$/m);
});

test('lint error: negative score value', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench A'].value = -1;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench A: value must be a number 0–100$/m);
});

test('lint error: unknown score source', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench A'].source = 'blog';
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench A: source must be vendor or independent$/m);
});

test('lint error: score ref missing', () => {
  const table = baseTable();
  delete table.models.alpha.scores['Bench A'].ref;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench A: ref must be an http\(s\) URL$/m);
});

test('lint error: score ref is not an http(s) URL', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench A'].ref = 'ftp://example.invalid/ref';
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^error models\.alpha\.scores\.Bench A: ref must be an http\(s\) URL$/m);
});

test('lint warning: stealth model with scores still exits 0', () => {
  const table = baseTable();
  table.models.alpha.stealth = true;
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^warn models\.alpha: stealth model has scores$/m);
  assert.match(r.stdout, /^ok \(2 models, 2 categories\)$/m);
});

test('lint warning: benchmark in a category with no scores', () => {
  const table = baseTable();
  table.categories.coding.benchmarks.push('Bench C');
  const { home, file } = setup(table);
  const r = bench(file, ['lint'], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^warn categories\.coding: benchmark "Bench C" has no scores$/m);
  assert.match(r.stdout, /^ok \(2 models, 2 categories\)$/m);
});

test('add-model: appends the model, keeps key order, stores stealth and notes', () => {
  const { home, file } = setup();
  const before = JSON.parse(read(file));
  const r = bench(file, ['add-model', '--key', 'gamma', '--name', 'Gamma', '--alias', 'gamma/one',
    '--alias', 'gamma/two', '--stealth', '--note', 'anonymous model'], home);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), 'added model gamma');

  const after = JSON.parse(read(file));
  assert.deepEqual(after.models.gamma, {
    name: 'Gamma', aliases: ['gamma/one', 'gamma/two'], scores: {}, notes: 'anonymous model', stealth: true,
  });
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(Object.keys(after.models), [...Object.keys(before.models), 'gamma']);
  assert.equal(read(file), JSON.stringify(after, null, 2) + '\n');
});

test('add-model: refuses an existing key and leaves the file unchanged', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['add-model', '--key', 'alpha', '--name', 'Alpha 2', '--alias', 'alpha/two'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /model key already exists: alpha/);
  assert.equal(read(file), before);
});

test('add-model: refuses an alias used by another model and leaves the file unchanged', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['add-model', '--key', 'gamma', '--name', 'Gamma', '--alias', 'beta/two'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /alias already used by beta: beta\/two/);
  assert.equal(read(file), before);
});

test('add-alias: appends one alias and keeps key order', () => {
  const { home, file } = setup();
  const before = JSON.parse(read(file));
  const r = bench(file, ['add-alias', '--key', 'alpha', '--alias', 'alpha/uno'], home);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), 'added alias alpha/uno to alpha');

  const after = JSON.parse(read(file));
  assert.deepEqual(after.models.alpha.aliases, ['alpha/one', 'alpha/uno']);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(Object.keys(after.models), Object.keys(before.models));
  assert.equal(read(file), JSON.stringify(after, null, 2) + '\n');
});

test('add-alias: refuses an unknown key', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['add-alias', '--key', 'nope', '--alias', 'nope/one'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown model key: nope/);
  assert.equal(read(file), before);
});

test('add-alias: refuses an already used alias', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['add-alias', '--key', 'alpha', '--alias', 'beta/two'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /alias already used by beta: beta\/two/);
  assert.equal(read(file), before);
});

test('set-score: overwrites a score in place and keeps key order', () => {
  const table = baseTable();
  table.models.alpha.scores['Bench B'] = score(60);
  const { home, file } = setup(table);
  const before = JSON.parse(read(file));

  const r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench A', '--value', '91.5',
    '--source', 'independent', '--ref', 'https://example.com/a'], home);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim(), 'set alpha.scores["Bench A"] = 91.5');

  const after = JSON.parse(read(file));
  assert.deepEqual(after.models.alpha.scores['Bench A'], {
    value: 91.5, source: 'independent', ref: 'https://example.com/a',
  });
  assert.deepEqual(Object.keys(after.models.alpha.scores), Object.keys(before.models.alpha.scores));
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.equal(read(file), JSON.stringify(after, null, 2) + '\n');
});

test('set-score --category: adds the benchmark to the category without duplicating it', () => {
  const { home, file } = setup();
  const args = ['set-score', '--key', 'alpha', '--bench', 'Bench C', '--value', '55',
    '--source', 'vendor', '--ref', 'https://example.com/c', '--category', 'terminal'];

  let r = bench(file, args, home);
  assert.equal(r.code, 0, r.out);
  let after = JSON.parse(read(file));
  assert.deepEqual(after.categories.terminal.benchmarks, ['Bench A', 'Bench C']);
  assert.deepEqual(after.models.alpha.scores['Bench C'], {
    value: 55, source: 'vendor', ref: 'https://example.com/c',
  });

  // Re-running the same command overwrites the score and must not append the benchmark again.
  r = bench(file, args, home);
  assert.equal(r.code, 0, r.out);
  after = JSON.parse(read(file));
  assert.deepEqual(after.categories.terminal.benchmarks, ['Bench A', 'Bench C']);
});

test('set-score: refuses a benchmark in no category without --category', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench Z', '--value', '50',
    '--source', 'vendor', '--ref', 'https://example.com/z'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /benchmark is in no category/);
  assert.equal(read(file), before);
});

test('set-score: refuses an unknown category', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench C', '--value', '50',
    '--source', 'vendor', '--ref', 'https://example.com/c', '--category', 'nope'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown category: nope/);
  assert.equal(read(file), before);
});

test('set-score: refuses an unknown model key', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['set-score', '--key', 'nope', '--bench', 'Bench A', '--value', '50',
    '--source', 'vendor', '--ref', 'https://example.com/a'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown model key: nope/);
  assert.equal(read(file), before);
});

test('set-score: a value that would break lint exits 1 and leaves the file byte-identical', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench A', '--value', '150',
    '--source', 'vendor', '--ref', 'https://example.com/a'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^error models\.alpha\.scores\.Bench A: value must be a number 0–100$/m);
  assert.equal(read(file), before);
});

test('set-score: a ref that is not an http(s) URL exits 1 and leaves the file byte-identical', () => {
  const { home, file } = setup();
  const before = read(file);
  const r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench A', '--value', '70',
    '--source', 'vendor', '--ref', 'not-a-url'], home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^error models\.alpha\.scores\.Bench A: ref must be an http\(s\) URL$/m);
  assert.equal(read(file), before);
});

test('set-score: a non-decimal --value exits 2 and leaves the file byte-identical', () => {
  const { home, file } = setup();
  const before = read(file);
  for (const bad of ['', ' ', '0x50', '1e2']) {
    const r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench A', '--value', bad,
      '--source', 'vendor', '--ref', 'https://example.com/a'], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.stderr, /--value must be a number:/);
    assert.equal(read(file), before);
  }
});

test('missing required options print usage and exit 2 without touching the file', () => {
  const { home, file } = setup();
  const before = read(file);

  let r = bench(file, ['add-model', '--key', 'gamma', '--name', 'Gamma'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: oc-bench\.mjs/);

  r = bench(file, ['set-score', '--key', 'alpha', '--bench', 'Bench A', '--value', '70', '--source', 'vendor'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: oc-bench\.mjs/);

  assert.equal(read(file), before);
});

test('unknown command prints usage and exits 2', () => {
  const { home, file } = setup();
  const r = bench(file, ['frobnicate'], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: oc-bench\.mjs/);
});
