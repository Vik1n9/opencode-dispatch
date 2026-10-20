#!/usr/bin/env node
// Track record of every dispatch (formal or shadow run) and the internal scores derived from it.
//
// Data folder: $OC_DISPATCH_HOME, else ~/.config/opencode-dispatch.
//   benchmarks.json   the curated benchmark table (install.sh links it to the repo; this script never writes it)
//   track.jsonl       one JSON record per line — the raw history, append only
//   internal.json     derived { generated, models: { <key>: { <category>: { … } } } } — rewritten completely
//                     from track.jsonl by every add / recompute; never hand-edit it
//   limits.json       rate-limit / quota state written by another script (only oc-rank reads it)
//
// Usage:
//   node oc-track.mjs add --file <record.json> | --json '<record>'   append one record, rebuild internal scores
//   node oc-track.mjs recompute                                       rebuild internal.json from track.jsonl
//   node oc-track.mjs show [--model <key|alias>] [--category <c>] [--task-id <id>] [--last N]   one line per record
//   node oc-track.mjs compare --task-id <id>                          side by side: every run of one task
//   node oc-track.mjs grade --json '<record>'                         print the grade only (dry run)
//
// compare columns (file order): model entry id, result (first word), grade, correctness, quality, seconds,
//   steps, speedRatio, returns, defects (<major>M/<minor>m); '–' = no quality / no speed ratio. Last line: the
//   fastest passing run (comparable, not limited) and the highest-grade run (not limited; first one on ties).
//
// Record fields (Claude fills these in after reviewing the work):
//   date, project, task, category (a benchmarks.json category), model (the entry ID actually used),
//   seconds, steps, inputTokens (from the oc-run summary; resumed runs: sum, explain in remarks),
//   result: 'passed' | 'passed-after-return' | 'failed' | 'aborted' | 'limited'
//           (add ', merged' / ', not merged (shadow)' after it)
//           legacy Chinese values (一次通過 / 退回後通過 / 未通過 / 中止) are still accepted
//           'limited' = the run was cut off by a rate limit / quota, not by the model's work; the record
//           stays in track.jsonl but is excluded from every internal aggregate (score, correctness,
//           quality, n, speed ratios)
//   handoffFrom (optional): the model ID that hit the limit when the record belongs to the model that
//           finished the handed-off work (with result 'limited' it names the model that was cut off)
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
// Scoring dimensions (0–100, deterministic so every model is scored the same way):
//   correctness = 100 − 10 × returns − 15 × major − 5 × minor − 5 × scope − (rerunFail ? 10 : 0), floored at 0;
//                 'failed' / 'aborted' cap it at 40. How well the work held up under review.
//   quality     = the optional 0–100 field above (how good the output is beyond defects).
//   grade       = with quality: round(½ × correctness + ½ × quality); without: correctness.
//                 'failed' / 'aborted' cap the grade at 40; speed is not part of it.
//
// Task speed (separate from the grade; token latency from the probe does NOT predict it):
//   for every taskId, each comparable passing run gets speedRatio = its seconds / the fastest passing run's
//   seconds (1.0 = fastest). 'limited' runs never take part. Per model ENTRY (free / paid / Go entries of
//   one model differ) and category: internal.<cat>.speed.<entry id> = { ratio: median speedRatio rounded
//   to 2 decimals, n, medianSeconds }. oc-rank prefers this over probe latency when comparing speed.
//
// Internal score per (model key, category), from that pair's non-limited records:
//   score       = mean grade of the last 10 records (one decimal) — what oc-rank compares
//   correctness = mean correctness of the same last 10 (one decimal)
//   quality     = mean quality of the last 10 records that have it (one decimal), null if none; qn = how many
//   n           = record count          updated = newest record's date
//   speed       = { <entry id>: { ratio, n, medianSeconds } } as above

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { INTERNAL, TRACK, keyOf, loadBenchmarks } from './lib.mjs';

const WINDOW = 10;

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const table = loadBenchmarks();
const readTrack = () => existsSync(TRACK)
  ? readFileSync(TRACK, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];

export function correctness(r) {
  const defects = r.defects || [];
  const major = defects.filter((d) => d.severity === 'major').length;
  const minor = defects.length - major;
  const base = Math.max(0, 100 - 10 * (r.returns || 0) - 15 * major - 5 * minor - 5 * (r.scope || 0) - (r.rerunFail ? 10 : 0));
  return passed(r) ? base : Math.min(base, 40);
}

export function grade(r) {
  const c = correctness(r);
  let g = typeof r.quality === 'number' ? Math.round(0.5 * c + 0.5 * r.quality) : c;
  if (!passed(r)) g = Math.min(g, 40);
  return Math.max(0, g);
}

const FAILED = /^(failed|aborted|未通過|中止)/i; // legacy Chinese values from older records
const passed = (r) => !FAILED.test(r.result || '');
const isLimited = (r) => /^limited/i.test(r.result || '');
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const mean1 = (xs) => (xs.length ? round1(xs.reduce((t, x) => t + x, 0) / xs.length) : null);
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Runs with the same taskId are compared with each other: the fastest passing run = 1.0. Limited runs are
// not the model's performance and take no part. Stored on every record so oc-rank can read the track cheaply.
function speedRatios(records) {
  const byTask = new Map();
  for (const r of records) {
    delete r.speedRatio;
    if (!r.taskId || !r.seconds || r.speedComparable === false || !passed(r) || isLimited(r)) continue;
    (byTask.get(r.taskId) || byTask.set(r.taskId, []).get(r.taskId)).push(r);
  }
  for (const rs of byTask.values()) {
    if (rs.length < 2) continue;
    const fastest = Math.min(...rs.map((r) => r.seconds));
    for (const r of rs) r.speedRatio = round2(r.seconds / fastest);
  }
}

function summarize(rs) {
  // The window follows the record date, not file order: records migrated later with old dates are not
  // "newest". Stable sort keeps equal dates in file order; the file itself is never reordered.
  const byDate = [...rs].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = byDate.slice(-WINDOW);
  const quality = byDate.filter((r) => typeof r.quality === 'number').slice(-WINDOW);
  const speed = {};
  for (const id of new Set(rs.map((r) => r.model))) {
    const sr = rs.filter((r) => r.model === id && r.speedRatio !== undefined);
    const secs = rs.filter((r) => r.model === id && r.seconds && passed(r)).map((r) => r.seconds);
    if (sr.length || secs.length) {
      speed[id] = {
        ratio: sr.length ? round2(median(sr.map((r) => r.speedRatio))) : null,
        n: sr.length,
        medianSeconds: secs.length ? Math.round(median(secs)) : null,
      };
    }
  }
  return {
    score: mean1(last.map((r) => r.grade)),
    correctness: mean1(last.map((r) => r.correctness)),
    quality: mean1(quality.map((r) => r.quality)),
    qn: quality.length,
    n: rs.length,
    updated: rs.reduce((mx, r) => (r.date > mx ? r.date : mx), rs[0].date),
    speed,
  };
}

function buildInternal(records) {
  const grouped = {};
  for (const r of records) {
    if (isLimited(r) || !r.modelKey) continue; // limited: in the track, out of every aggregate
    const cats = (grouped[r.modelKey] ||= {});
    (cats[r.category] ||= []).push(r);
  }
  const models = {};
  for (const [key, cats] of Object.entries(grouped)) {
    models[key] = {};
    for (const [cat, rs] of Object.entries(cats)) models[key][cat] = summarize(rs);
  }
  return models;
}

// Rebuild internal.json (and the derived fields on every track line) from track.jsonl, from scratch.
function rebuild() {
  const records = readTrack();
  for (const r of records) {
    r.modelKey = keyOf(r.model, table) ?? r.modelKey;
    r.correctness = correctness(r);
    r.grade = grade(r);
  }
  speedRatios(records);
  writeFileSync(TRACK, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  const models = buildInternal(records);
  writeFileSync(INTERNAL, JSON.stringify({ generated: new Date().toISOString(), models }, null, 2) + '\n');
  return { records, models };
}

function load() {
  const raw = val('--json', null) ?? (val('--file', null) && readFileSync(val('--file'), 'utf8'));
  if (!raw) { console.error('needs --json or --file'); process.exit(2); }
  const r = JSON.parse(raw);
  for (const f of ['date', 'task', 'category', 'model', 'result']) if (r[f] === undefined) { console.error(`missing field: ${f}`); process.exit(2); }
  if (r.quality !== undefined && (typeof r.quality !== 'number' || !Number.isFinite(r.quality) || r.quality < 0 || r.quality > 100)) { console.error('quality must be a number 0–100'); process.exit(2); }
  if (!table.categories[r.category]) { console.error(`unknown category: ${r.category}`); process.exit(2); }
  r.modelKey = keyOf(r.model, table);
  if (!r.modelKey) { console.error(`model not in benchmarks.json: ${r.model} (add an entry under models with this ID in aliases first)`); process.exit(2); }
  r.correctness = correctness(r);
  r.grade = grade(r);
  return r;
}

if (cmd === 'add') {
  const r = load();
  appendFileSync(TRACK, JSON.stringify(r) + '\n');
  // Speed ratios span models: rebuild everything so other runs of the same taskId are updated too.
  const { models } = rebuild();
  const i = models[r.modelKey]?.[r.category];
  const q = r.quality !== undefined ? `, quality ${r.quality}` : '';
  if (isLimited(r) || !i) {
    console.log(`recorded: ${r.modelKey} / ${r.category} graded ${r.grade} (correctness ${r.correctness}${q}) — limited, not counted${r.handoffFrom ? ` (handed off from ${r.handoffFrom})` : ''}`);
  } else {
    const sp = i.speed?.[r.model];
    console.log(`recorded: ${r.modelKey} / ${r.category} graded ${r.grade} (correctness ${r.correctness}${q}) -> internal score ${i.score} (${i.n} records)${sp?.ratio ? `, task speed x${sp.ratio} (${sp.n} comparisons)` : ''}`);
  }
} else if (cmd === 'grade') {
  console.log(load().grade);
} else if (cmd === 'recompute') {
  const { records } = rebuild();
  console.log(`recomputed ${records.length} records`);
} else if (cmd === 'show') {
  const mk = val('--model', null) && keyOf(val('--model'), table);
  if (val('--model', null) && !mk) { console.error(`model not in benchmarks.json: ${val('--model')}`); process.exit(2); }
  const cat = val('--category', null);
  const tid = val('--task-id', null);
  const last = Number(val('--last', 0));
  let rs = readTrack().filter((r) => (!mk || r.modelKey === mk) && (!cat || r.category === cat) && (!tid || r.taskId === tid));
  if (last) rs = rs.slice(-last);
  for (const r of rs) {
    const d = (r.defects || []).map((x) => `${x.severity === 'major' ? 'MAJOR' : 'minor'}: ${x.text}`).join('; ');
    const c = r.correctness ?? correctness(r);
    const g = r.grade ?? grade(r);
    console.log(`${r.date} ${r.modelKey} [${r.category}] ${g}pts c:${c}${r.quality !== undefined ? ` q:${r.quality}` : ''} ${r.result} returns:${r.returns || 0} ${r.seconds ?? '?'}s/${r.steps ?? '?'} steps${r.speedRatio !== undefined ? ` (speed x${r.speedRatio})` : ''} — ${r.task}${d ? ` | defects: ${d}` : ''}${r.reconstructed ? ' (reconstructed)' : ''}`);
  }
  if (!rs.length) console.log('no matching records');
} else if (cmd === 'compare') {
  const tid = val('--task-id', null);
  if (!tid) { console.error('usage: oc-track.mjs compare --task-id <id>'); process.exit(2); }
  const rs = readTrack().filter((r) => r.taskId === tid);
  if (!rs.length) { console.error(`no records for taskId ${tid}`); process.exit(1); }
  for (const r of rs) { r.correctness ??= correctness(r); r.grade ??= grade(r); }
  const rows = rs.map((r) => {
    const major = (r.defects || []).filter((d) => d.severity === 'major').length;
    return [r.model, (r.result || '?').split(/[\s,]+/)[0], `${r.grade}pts`, `c:${r.correctness}`,
      r.quality !== undefined ? `q:${r.quality}` : '–', `${r.seconds ?? '?'}s`, `${r.steps ?? '?'} steps`,
      r.speedRatio !== undefined ? `x${r.speedRatio}` : '–', `returns:${r.returns || 0}`,
      `${major}M/${(r.defects || []).length - major}m`];
  });
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  console.log(`${tid} — ${rs[0].task}`);
  for (const row of rows) console.log(row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
  const counted = rs.filter((r) => !isLimited(r));
  const fast = counted.filter((r) => passed(r) && r.seconds && r.speedComparable !== false)
    .reduce((b, r) => (!b || r.seconds < b.seconds ? r : b), null);
  const best = counted.reduce((b, r) => (!b || r.grade > b.grade ? r : b), null);
  console.log(`fastest passing: ${fast ? `${fast.model} (${fast.seconds}s)` : 'none'} · highest grade: ${best ? `${best.model} (${best.grade}pts)` : 'none'}`);
} else {
  console.error('usage: oc-track.mjs add|grade|recompute|show|compare … (see the file header)');
  process.exit(2);
}
