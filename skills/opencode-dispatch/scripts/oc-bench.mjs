#!/usr/bin/env node
// Lint and maintain the curated benchmark table (benchmarks.json).
//
// Data folder: $OC_DISPATCH_HOME, else ~/.config/opencode-dispatch (see lib.mjs). install.sh links that
// benchmarks.json to the repo's config/benchmarks.json, so a normal edit is also a repo edit.
//
// Usage:
//   node oc-bench.mjs lint [--file <path>]
//   node oc-bench.mjs add-model --key <k> --name <n> --alias <id> [--alias <id> …] [--stealth] [--note <text>] [--file <path>]
//   node oc-bench.mjs add-alias --key <k> --alias <id> [--file <path>]
//   node oc-bench.mjs set-score --key <k> --bench <name> --value <v> --source vendor|independent --ref <url>
//                               [--category <c>] [--file <path>]
//
// Table shape:
//   categories.<c> = { label, benchmarks: [name, …] }
//   models.<key>   = { name, aliases: [opencode id, …], scores: { <name>: { value, source, ref } }, stealth?, notes? }
//   Top-level keys other than categories / models (e.g. _about) are preserved as-is.
//
// Lint rules (benchmark names carry their version and are compared exactly — Terminal-Bench 2.1 ≠ 2.0):
//   errors   category without a label or with empty / missing benchmarks; a benchmark listed twice in one
//            category; model without a name or with empty / missing aliases; an alias used by two models;
//            a score whose benchmark is in no category; value not a number 0–100; source not vendor /
//            independent; ref missing or not an http(s) URL
//   warnings a stealth model that has scores; a benchmark in a category that no model has a score for
//
// Every write runs the lint rules on the result first: errors refuse the write (exit 1) and leave the file
// untouched. A clean write keeps the existing key order and is JSON.stringify(table, null, 2) + '\n'.
// Exit codes: 0 ok, 1 lint errors / refused write, 2 usage error or refused mutation (unknown key,
// duplicate key / alias, unknown category).

import { readFileSync, writeFileSync } from 'node:fs';
import { BENCHMARKS } from './lib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const vals = (f) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === f && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
};

const USAGE = `usage: oc-bench.mjs lint [--file <path>]
       oc-bench.mjs add-model --key <k> --name <n> --alias <id> [--alias <id> …] [--stealth] [--note <text>] [--file <path>]
       oc-bench.mjs add-alias --key <k> --alias <id> [--file <path>]
       oc-bench.mjs set-score --key <k> --bench <name> --value <v> --source vendor|independent --ref <url> [--category <c>] [--file <path>]`;
const usage = () => { console.error(USAGE); process.exit(2); };
const refuse = (message) => { console.error(message); process.exit(2); };

const file = val('--file', BENCHMARKS);

function load() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    refuse(`cannot read ${file}: ${err.message}`);
  }
}

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

// Return every problem, errors first as a group so a caller can refuse a write on errors alone.
function lint(table) {
  const problems = [];
  const add = (level, where, message) => problems.push({ level, where, message });
  const categories = table.categories && typeof table.categories === 'object' ? table.categories : {};
  const models = table.models && typeof table.models === 'object' ? table.models : {};

  const categoryBenchmarks = new Set();
  for (const [cat, entry] of Object.entries(categories)) {
    const where = `categories.${cat}`;
    if (!entry || typeof entry !== 'object') {
      add('error', where, 'missing label');
      add('error', where, 'missing or empty benchmarks');
      continue;
    }
    if (typeof entry.label !== 'string' || !entry.label.trim()) add('error', where, 'missing label');
    if (!Array.isArray(entry.benchmarks) || entry.benchmarks.length === 0) {
      add('error', where, 'missing or empty benchmarks');
    } else {
      const seen = new Set();
      for (const bench of entry.benchmarks) {
        if (seen.has(bench)) add('error', where, `benchmark ${JSON.stringify(bench)} listed twice`);
        seen.add(bench);
        categoryBenchmarks.add(bench);
      }
    }
  }

  const aliasOwners = new Map();
  for (const [key, model] of Object.entries(models)) {
    const where = `models.${key}`;
    if (!model || typeof model !== 'object') {
      add('error', where, 'missing name');
      add('error', where, 'missing or empty aliases');
      continue;
    }
    if (typeof model.name !== 'string' || !model.name.trim()) add('error', where, 'missing name');
    if (!Array.isArray(model.aliases) || model.aliases.length === 0) {
      add('error', where, 'missing or empty aliases');
    } else {
      for (const alias of model.aliases) {
        if (typeof alias !== 'string' || !alias) continue;
        if (!aliasOwners.has(alias)) aliasOwners.set(alias, []);
        if (!aliasOwners.get(alias).includes(key)) aliasOwners.get(alias).push(key);
      }
    }
  }

  for (const [alias, keys] of aliasOwners) {
    if (keys.length < 2) continue;
    add('error', `models.${keys[0]}.aliases`, `alias ${JSON.stringify(alias)} is also used by ${keys.slice(1).join(', ')}`);
  }

  const scoredBenchmarks = new Set();
  for (const [key, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') continue;
    const scores = model.scores && typeof model.scores === 'object' ? model.scores : {};
    if (model.stealth && Object.keys(scores).length) add('warn', `models.${key}`, 'stealth model has scores');
    for (const [bench, raw] of Object.entries(scores)) {
      const where = `models.${key}.scores.${bench}`;
      const score = raw && typeof raw === 'object' ? raw : {};
      scoredBenchmarks.add(bench);
      if (!categoryBenchmarks.has(bench)) add('error', where, `benchmark ${JSON.stringify(bench)} is in no category`);
      if (typeof score.value !== 'number' || !Number.isFinite(score.value) || score.value < 0 || score.value > 100) {
        add('error', where, 'value must be a number 0–100');
      }
      if (score.source !== 'vendor' && score.source !== 'independent') {
        add('error', where, 'source must be vendor or independent');
      }
      if (typeof score.ref !== 'string' || !score.ref || !isHttpUrl(score.ref)) {
        add('error', where, 'ref must be an http(s) URL');
      }
    }
  }

  for (const [cat, entry] of Object.entries(categories)) {
    if (!entry || !Array.isArray(entry.benchmarks)) continue;
    for (const bench of entry.benchmarks) {
      if (!scoredBenchmarks.has(bench)) add('warn', `categories.${cat}`, `benchmark ${JSON.stringify(bench)} has no scores`);
    }
  }

  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warn');
  return [...errors, ...warnings];
}

const printProblems = (problems, stream = console.log) => {
  for (const p of problems) stream(`${p.level} ${p.where}: ${p.message}`);
};

const errorsIn = (problems) => problems.filter((p) => p.level === 'error');

// Lint the mutated table first; only a table with no errors reaches disk. Key order is kept because the
// parsed object is mutated in place and stringified as-is.
function commit(table, message) {
  const errors = errorsIn(lint(table));
  if (errors.length) {
    printProblems(errors, console.error);
    process.exit(1);
  }
  writeFileSync(file, JSON.stringify(table, null, 2) + '\n');
  console.log(message);
}

function aliasOwner(table, alias) {
  for (const [key, model] of Object.entries(table.models || {})) {
    if (Array.isArray(model?.aliases) && model.aliases.includes(alias)) return key;
  }
  return null;
}

if (cmd === 'lint') {
  const table = load();
  const problems = lint(table);
  printProblems(problems);
  const errors = errorsIn(problems).length;
  if (errors) {
    console.log(`${errors} errors`);
    process.exit(1);
  }
  console.log(`ok (${Object.keys(table.models || {}).length} models, ${Object.keys(table.categories || {}).length} categories)`);
} else if (cmd === 'add-model') {
  const key = val('--key', null);
  const name = val('--name', null);
  const aliases = [...new Set(vals('--alias'))];
  if (!key || !name || !aliases.length) usage();

  const table = load();
  table.models ||= {};
  if (Object.hasOwn(table.models, key)) refuse(`model key already exists: ${key}`);
  for (const alias of aliases) {
    const owner = aliasOwner(table, alias);
    if (owner) refuse(`alias already used by ${owner}: ${alias}`);
  }

  const model = { name, aliases, scores: {} };
  const note = val('--note', null);
  if (note !== null) model.notes = note;
  if (argv.includes('--stealth')) model.stealth = true;
  table.models[key] = model;
  commit(table, `added model ${key}`);
} else if (cmd === 'add-alias') {
  const key = val('--key', null);
  const alias = val('--alias', null);
  if (!key || !alias) usage();

  const table = load();
  if (!table.models || !Object.hasOwn(table.models, key)) refuse(`unknown model key: ${key}`);
  const owner = aliasOwner(table, alias);
  if (owner) refuse(`alias already used by ${owner}: ${alias}`);

  (table.models[key].aliases ||= []).push(alias);
  commit(table, `added alias ${alias} to ${key}`);
} else if (cmd === 'set-score') {
  const key = val('--key', null);
  const bench = val('--bench', null);
  const rawValue = val('--value', null);
  const source = val('--source', null);
  const ref = val('--ref', null);
  const category = val('--category', null);
  if (!key || !bench || rawValue === null || !source || !ref) usage();
  // Number('') is 0 and Number('0x50') is 80: accept a plain decimal number only. The 0–100 range is
  // still the lint's job (exit 1).
  if (!/^-?\d+(\.\d+)?$/.test(rawValue)) refuse(`--value must be a number: ${rawValue}`);
  const value = Number(rawValue);

  const table = load();
  if (!table.models || !Object.hasOwn(table.models, key)) refuse(`unknown model key: ${key}`);

  const categories = table.categories || {};
  if (category !== null) {
    if (!Object.hasOwn(categories, category)) refuse(`unknown category: ${category}`);
    const list = categories[category].benchmarks ||= [];
    if (!list.includes(bench)) list.push(bench);
  } else {
    const known = Object.values(categories).some((c) => Array.isArray(c?.benchmarks) && c.benchmarks.includes(bench));
    if (!known) refuse(`benchmark is in no category (pass --category <c> to add it): ${bench}`);
  }

  (table.models[key].scores ||= {})[bench] = { value, source, ref };
  commit(table, `set ${key}.scores[${JSON.stringify(bench)}] = ${value}`);
} else {
  usage();
}
