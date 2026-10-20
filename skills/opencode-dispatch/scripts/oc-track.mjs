#!/usr/bin/env node
// Track record of every dispatch (formal or shadow run) and the internal score derived from it.
//
//   ~/.config/opencode-dispatch/track.jsonl   one JSON record per line — the raw history. Kept OUT of
//                                              scores.json so it never has to be read just to rank models.
//   scores.json → models.<key>.internal        { <category>: { score, n, updated, speed } } — what oc-rank reads.
//
// Usage:
//   node oc-track.mjs add --file <record.json> | --json '<record>'   append one record, recompute internal score
//   node oc-track.mjs recompute                                       rebuild every internal score from track.jsonl
//   node oc-track.mjs show [--model <key|alias>] [--category <c>] [--last N]   compact one line per record
//   node oc-track.mjs grade --json '<record>'                         print the grade only (dry run)
//
// Record fields (Claude fills these in after reviewing the work):
//   date, project, task, category (a scores.json category), model (the entry ID actually used),
//   seconds, steps, inputTokens (from the oc-run summary; resumed runs: sum, explain in remarks),
//   result: 'passed' | 'passed-after-return' | 'failed' | 'aborted'   (add ', merged' / ', not merged (shadow)' after it)
//           legacy Chinese values (一次通過 / 退回後通過 / 未通過 / 中止) are still accepted
//   returns: number of review rounds sent back for the model's own faults (not for spec changes / interruptions)
//   defects: [{ severity: 'major' | 'minor', text }]  everything review found, including what Claude fixed itself
//            major = would break production, lose data, weaken security, or break the spec; minor = the rest
//   scope: number of edits outside the allowed files     rerunFail: true if Claude's own test rerun failed
//                                                          because of the model's work
//   quality (optional, 0–100): how good the delivered output is, beyond what defects already capture — do not
//            double-count defects. 90–100 mergeable as-is / as good as the reviewer's own work, clear, complete,
//            idiomatic, well tested or evidenced; 75–89 good, minor polish only; 60–74 works but mediocre
//            (verbose, shallow, weak tests or thin evidence, inconsistent with the surrounding code);
//            40–59 meets the spec on paper but needs substantial rework; 0–39 little usable beyond the bare
//            requirement. Meaning depends on the category: code = readability, idiom, meaningful tests;
//            plans / reasoning / reviews = accuracy, depth, evidence; instruction tasks = fidelity to the
//            requested format and content.
//   remarks, reconstructed (true when rebuilt from memory/logs after the fact)
//   taskId: same value for runs of the SAME task by different models (formal run + shadow runs, A/B) —
//           the only fair way to compare how fast models actually finish work
//   speedComparable: false when the run time is not comparable (spec changed mid-run, waited on the user …)
//
// Task speed (separate from the grade; token latency from the probe does NOT predict it):
//   for every taskId, each comparable passing run gets speedRatio = its seconds / the fastest passing run's
//   seconds (1.0 = fastest). Per model ENTRY (free / paid / Go entries of one model differ) and category:
//   internal.<cat>.speed.<entry id> = { ratio: median speedRatio, n, medianSeconds }. oc-rank prefers this
//   over probe latency when comparing speed.
//
// Grade (0–100, deterministic so every model is graded the same way):
//   base = 100 − 10 × returns − 15 × major − 5 × minor − 5 × scope − (rerunFail ? 10 : 0), floored at 0.
//   With quality: grade = round(½ × base + ½ × quality); without it: grade = base (old records keep
//   their deduction-only grade). 'failed' or 'aborted' caps the grade at 40, floor 0. Speed is NOT part of
//   the grade (oc-rank weighs speed separately).
// Internal score of a model in a category = mean grade of its last WINDOW records in that category.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.config', 'opencode-dispatch');
const TRACK = join(DIR, 'track.jsonl');
const SCORES = join(DIR, 'scores.json');
const WINDOW = 10;

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const table = JSON.parse(readFileSync(SCORES, 'utf8'));
const keyOf = (idOrKey) => {
  if (table.models[idOrKey]) return idOrKey;
  for (const [k, m] of Object.entries(table.models)) if ((m.aliases || []).includes(idOrKey)) return k;
  return null;
};
const readTrack = () => existsSync(TRACK)
  ? readFileSync(TRACK, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];

export function grade(r) {
  const defects = r.defects || [];
  const major = defects.filter((d) => d.severity === 'major').length;
  const minor = defects.length - major;
  const base = Math.max(0, 100 - 10 * (r.returns || 0) - 15 * major - 5 * minor - 5 * (r.scope || 0) - (r.rerunFail ? 10 : 0));
  let g = r.quality !== undefined ? Math.round(0.5 * base + 0.5 * r.quality) : base;
  if (!passed(r)) g = Math.min(g, 40);
  return Math.max(0, g);
}

const FAILED = /^(failed|aborted|未通過|中止)/i; // legacy Chinese values from older records
const passed = (r) => !FAILED.test(r.result || '');
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
// Runs with the same taskId are compared with each other: the fastest passing run = 1.0
function speedRatios(records) {
  const byTask = new Map();
  for (const r of records) {
    delete r.speedRatio;
    if (!r.taskId || !r.seconds || r.speedComparable === false || !passed(r)) continue;
    (byTask.get(r.taskId) || byTask.set(r.taskId, []).get(r.taskId)).push(r);
  }
  for (const rs of byTask.values()) {
    if (rs.length < 2) continue;
    const fastest = Math.min(...rs.map((r) => r.seconds));
    for (const r of rs) r.speedRatio = Math.round((r.seconds / fastest) * 100) / 100;
  }
}

function recompute(records, onlyKey = null) {
  speedRatios(records);
  const groups = new Map();
  for (const r of records) {
    const k = r.modelKey;
    if (onlyKey && k !== onlyKey) continue;
    const g = groups.get(k) || {};
    (g[r.category] ||= []).push(r);
    groups.set(k, g);
  }
  for (const [k, cats] of groups) {
    const m = table.models[k];
    if (!m) continue;
    m.internal = {};
    for (const [c, rs] of Object.entries(cats)) {
      const last = rs.slice(-WINDOW);
      const score = Math.round((last.reduce((t, r) => t + r.grade, 0) / last.length) * 10) / 10;
      const speed = {};
      for (const id of new Set(rs.map((r) => r.model))) {
        const sr = rs.filter((r) => r.model === id && r.speedRatio !== undefined);
        const secs = rs.filter((r) => r.model === id && r.seconds && passed(r)).map((r) => r.seconds);
        if (sr.length || secs.length) speed[id] = { ratio: sr.length ? median(sr.map((r) => r.speedRatio)) : null, n: sr.length, medianSeconds: secs.length ? Math.round(median(secs)) : null };
      }
      m.internal[c] = { score, n: rs.length, updated: rs[rs.length - 1].date, speed };
    }
  }
  writeFileSync(SCORES, JSON.stringify(table, null, 2) + '\n');
}

function load() {
  const raw = val('--json', null) ?? (val('--file', null) && readFileSync(val('--file'), 'utf8'));
  if (!raw) { console.error('needs --json or --file'); process.exit(2); }
  const r = JSON.parse(raw);
  for (const f of ['date', 'task', 'category', 'model', 'result']) if (r[f] === undefined) { console.error(`missing field: ${f}`); process.exit(2); }
  if (r.quality !== undefined && (typeof r.quality !== 'number' || !Number.isFinite(r.quality) || r.quality < 0 || r.quality > 100)) { console.error('quality must be a number 0–100'); process.exit(2); }
  if (!table.categories[r.category]) { console.error(`unknown category: ${r.category}`); process.exit(2); }
  r.modelKey = keyOf(r.model);
  if (!r.modelKey) { console.error(`model not in scores.json: ${r.model} (add an entry under models with this ID in aliases first)`); process.exit(2); }
  r.grade = grade(r);
  return r;
}

if (cmd === 'add') {
  const r = load();
  appendFileSync(TRACK, JSON.stringify(r) + '\n');
  const all = readTrack();
  recompute(all); // speed ratios span models: other models with the same taskId must be updated too
  writeFileSync(TRACK, all.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const i = table.models[r.modelKey].internal[r.category];
  const sp = i.speed?.[r.model];
  console.log(`recorded: ${r.modelKey} / ${r.category} graded ${r.grade} -> internal score ${i.score} (${i.n} records)${sp?.ratio ? `, task speed x${sp.ratio} (${sp.n} comparisons)` : ''}`);
} else if (cmd === 'grade') {
  console.log(load().grade);
} else if (cmd === 'recompute') {
  const rs = readTrack();
  for (const r of rs) { r.modelKey = keyOf(r.model) ?? r.modelKey; r.grade = grade(r); }
  for (const m of Object.values(table.models)) delete m.internal;
  recompute(rs);
  writeFileSync(TRACK, rs.map((r) => JSON.stringify(r)).join('\n') + (rs.length ? '\n' : ''));
  console.log(`recomputed ${rs.length} records`);
} else if (cmd === 'show') {
  const mk = val('--model', null) && keyOf(val('--model'));
  if (val('--model', null) && !mk) { console.error(`model not in scores.json: ${val('--model')}`); process.exit(2); }
  const cat = val('--category', null);
  const last = Number(val('--last', 0));
  let rs = readTrack().filter((r) => (!mk || r.modelKey === mk) && (!cat || r.category === cat));
  if (last) rs = rs.slice(-last);
  for (const r of rs) {
    const d = (r.defects || []).map((x) => `${x.severity === 'major' ? 'MAJOR' : 'minor'}: ${x.text}`).join('; ');
    console.log(`${r.date} ${r.modelKey} [${r.category}] ${r.grade}pts${r.quality !== undefined ? ` q:${r.quality}` : ''} ${r.result} returns:${r.returns || 0} ${r.seconds ?? '?'}s/${r.steps ?? '?'} steps${r.speedRatio !== undefined ? ` (speed x${r.speedRatio})` : ''} — ${r.task}${d ? ` | defects: ${d}` : ''}${r.reconstructed ? ' (reconstructed)' : ''}`);
  }
  if (!rs.length) console.log('no matching records');
} else {
  console.error('usage: oc-track.mjs add|grade|recompute|show … (see the file header)');
  process.exit(2);
}
