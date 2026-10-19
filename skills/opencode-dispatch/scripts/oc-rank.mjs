#!/usr/bin/env node
// Rank models for one kind of task, from the session inventory cache + the persistent score table.
// No probing, no network: run oc-models.mjs --probe --cache <file> once per session, then call this
// for every dispatch decision.
//
// Usage: node oc-rank.mjs --cache <file> --task <category|all> [--min-context <tokens>] [--scores <file>] [--json]
//                        [--no-free]
//   --min-context  drop entries whose context window is smaller (e.g. continuing a long session: 400000); must be a
//                  finite number >= 0. A usable model whose context is unknown is dropped too, but reported
//                  (text: one "dropped (context unknown, --min-context N)" line; JSON: droppedUnknownContext)
//   --no-free      drop every Zen free entry (plan free, ids starting opencode/) before ranking, for while the free
//                  usage limit lasts: only token plan / Go / pay-as-you-go entries are ranked; shadow runs are
//                  paused (text says so, JSON shadow is empty and noFree is true); notInTable is filtered too
//   categories are defined in the score table (repo-coding, terminal, greenfield, tools, gui-vision,
//   reasoning, security, instruction, long-context)
//
// Exit codes: 2 (one lower-case line on stderr) when --cache/--task are missing, --min-context is invalid, or
//   <cache>/<scores> cannot be read, cannot be parsed, or lack their expected shape (models array; models + categories).
//
// Allocation rules (user, 2026-10-19; SKILL.md "Allocation rules"), applied in order:
//   1. capability first — compare only the benchmarks of this task's category, on benchmarks both
//      models have (same name and version); gap = (mean external diff + INTERNAL_WEIGHT × internal diff)
//      / (1 + INTERNAL_WEIGHT). Internal score = graded dispatch history (oc-track.mjs). Leader = best on
//      the primary benchmark, replaced by anyone the blended gap says is stronger; when those gaps cycle
//      (not transitive across differing shared benchmarks), the best primary-benchmark score in the cycle leads.
//      gap ≤ 5 same, ≤ 10 close, > 10 clearly weaker
//   2. within 10 points, a Qwen token-plan model wins (token plan beats speed — user's call); best score first
//   3. otherwise, among models within 5 points (same capability), the fastest (within 30% counts as equal
//      speed; then free > Go > pay-as-you-go). Speed = task-completion speed (internal.<cat>.speed, same
//      taskId compared) when every candidate has it, else probe latency
//   4. pay-as-you-go is used only when no free / Go model is within 10 points — even when the paid entry is
//      faster (user: free first whenever the gap is small); rule 3 is re-applied to the free / Go models
//
// Also lists shadow-run candidates: usable models marked stealth in the score table, and models the table
// does not know yet (fill the table first — only models without any public benchmark get stealth: true).
// JSON: shadow holds only the stealth entries, notInTable the unknown ones. One entry per model (the cheapest
// plan). Models the official live list no longer has are skipped.
// Models paused in limits.json (oc-limits.mjs) are dropped from ranking and shadow runs until a probe or a
// normal run on that id succeeds; text lists them, JSON adds paused.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { due, paused } from './oc-limits.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const cachePath = val('--cache', null);
const task = val('--task', null);
const scoresPath = val('--scores', join(homedir(), '.config', 'opencode-dispatch', 'scores.json'));
const noFree = argv.includes('--no-free');
const USAGE = 'usage: oc-rank.mjs --cache <file> --task <category|all> [--min-context <tokens>] [--scores <file>] [--json] [--no-free]';
if (!cachePath || !task) {
  console.error(USAGE);
  process.exit(2);
}
const SAME = 5, CLOSE = 10, SPEED_EQUAL = 1.3;

const minContextRaw = val('--min-context', '0');
const minContext = Number(minContextRaw);
if (!Number.isFinite(minContext) || minContext < 0) {
  console.error(`usage: --min-context must be a finite number >= 0, got ${minContextRaw}`);
  process.exit(2);
}

// Read + parse + shape-check a JSON input: any failure is one lower-case line and exit 2, never a raw stack
const loadJson = (path, shapeError) => {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { console.error(`cannot read ${path}: ${e.code || e.message}`); process.exit(2); }
  let data;
  try { data = JSON.parse(text); } catch (e) { console.error(`cannot read ${path}: ${e.message}`); process.exit(2); }
  const why = shapeError(data);
  if (why) { console.error(`${path} ${why}`); process.exit(2); }
  return data;
};
const isObj = (x) => x !== null && typeof x === 'object';
const cache = loadJson(cachePath, (d) => (isObj(d) && Array.isArray(d.models) ? null : 'has no models array'));
const table = loadJson(scoresPath, (d) => (isObj(d) && isObj(d.models) && isObj(d.categories) ? null : 'has no models or categories'));
const byAlias = new Map();
for (const [key, m] of Object.entries(table.models)) for (const a of m.aliases || []) byAlias.set(a, { key, ...m });

const now = new Date();
const pausedMap = paused(now);
const pausedList = [...pausedMap.entries()];
const dueSet = new Set(due(now));

const plan = (id) => id.startsWith('bailian-token-plan-personal/') ? 'token'
  : id.startsWith('opencode/') ? 'free'
  : id.startsWith('opencode-go/') ? 'go'
  : 'paid';
const PLAN_LABEL = { token: 'Qwen token plan', free: 'Zen free', go: 'Go plan', paid: 'pay-as-you-go' };

// Usable: probe result when probed; without a probe (cache built without --probe) every model is a candidate, with a warning.
// Models the official live list no longer has (live === false) are never dispatched. --min-context drops models whose
// context is too small, and usable models whose context is unknown (they cannot be judged) — the latter are reported.
const droppedUnknown = [];
const usable = cache.models.filter((m) => {
  if (!m.id || m.live === false || (m.probe && !m.probe.ok)) return false;
  if (pausedMap.has(m.id)) return false; // rate limited: out of ranking and shadow runs
  if (noFree && m.id.startsWith('opencode/')) return false; // Zen free: suppressed while the free limit lasts
  if (!minContext) return true;
  if (m.context == null) { droppedUnknown.push(m.id); return false; }
  return m.context >= minContext;
});
const COST = { token: 0, free: 1, go: 2, paid: 3 };

// Internal score (internal[category] of each model in scores.json, computed by oc-track.mjs from the track record) weighs
// INTERNAL_WEIGHT times the external benchmarks: the mean gap on shared benchmarks counts once, the internal gap
// INTERNAL_WEIGHT times, and the weighted mean is the gap. With an internal score on one side only, compare external only;
// with no shared external benchmark, compare internal only (anonymous models rely on this).
const INTERNAL_WEIGHT = 2;

function rankCategory(cat) {
  const benches = new Set(table.categories[cat].benchmarks);
  const rows = usable.map((m) => {
    const entry = byAlias.get(m.id);
    const scores = {};
    for (const [b, s] of Object.entries(entry?.scores || {})) if (benches.has(b)) scores[b] = s.value;
    return { id: m.id, model: entry?.name ?? m.name ?? m.id, key: entry?.key ?? null, plan: plan(m.id),
      seconds: m.probe?.seconds ?? null, scores, sources: entry?.scores || {}, internal: entry?.internal?.[cat] ?? null,
      taskSpeed: entry?.internal?.[cat]?.speed?.[m.id]?.ratio ?? null };
  });
  const scored = rows.filter((r) => Object.keys(r.scores).length || r.internal);
  const diff = (a, b) => {
    const common = Object.keys(a.scores).filter((k) => k in b.scores);
    const ext = common.length ? common.reduce((t, k) => t + a.scores[k] - b.scores[k], 0) / common.length : null;
    const int = a.internal && b.internal ? a.internal.score - b.internal.score : null;
    if (ext === null && int === null) return null;
    if (int === null) return ext;
    if (ext === null) return int;
    return (ext + INTERNAL_WEIGHT * int) / (1 + INTERNAL_WEIGHT);
  };
  // Leader: find the primary benchmark (the one the most usable models in this category have; ties follow the category's
  // order); the top scorer on it leads. Not "mean gap against everyone" — different benchmark versions (e.g. Terminal-Bench
  // 2.0 vs 2.1) form separate groups, and mixing them picks the wrong leader.
  const order = table.categories[cat].benchmarks;
  const coverage = order.map((b) => ({ b, n: scored.filter((r) => b in r.scores).length })).filter((x) => x.n > 0);
  coverage.sort((x, y) => y.n - x.n || order.indexOf(x.b) - order.indexOf(y.b));
  const primary = coverage[0]?.b ?? null;
  scored.sort((a, b) => ((b.scores[primary] ?? -1e9) - (a.scores[primary] ?? -1e9)) || Object.keys(b.scores).length - Object.keys(a.scores).length);
  // The primary benchmark only sets the start; if the blended gap shows anyone stronger (negative gap), it leads instead, until nobody is.
  // Gaps need not be transitive (A beats B, B beats C, C beats A when the shared benchmarks differ): on revisiting a leader
  // the walk has entered a cycle, and the best primary-benchmark score in that cycle leads (ties: the one visited first)
  let leader = scored[0];
  let cycle = null;
  const visited = [];
  const seenIds = new Set();
  while (leader) {
    seenIds.add(leader.id);
    visited.push(leader);
    const better = scored.map((r) => ({ r, d: r === leader ? null : diff(leader, r) }))
      .filter((x) => x.d !== null && x.d < 0).sort((x, y) => x.d - y.d)[0];
    if (!better) break;
    if (seenIds.has(better.r.id)) {
      cycle = visited.slice(visited.findIndex((r) => r.id === better.r.id));
      leader = cycle.reduce((best, r) => ((r.scores[primary] ?? -1e9) > (best.scores[primary] ?? -1e9) ? r : best), cycle[0]);
      break;
    }
    leader = better.r;
  }
  for (const r of scored) {
    r.gap = r === leader ? 0 : diff(leader, r);
    r.tier = r.gap === null ? 'no-common' : r.gap <= SAME ? 'same' : r.gap <= CLOSE ? 'close' : 'weaker';
  }
  // One model version may have several entries (e.g. API and Zen free): same scores, so rules 2–4 choose by plan and speed
  const trail = [];
  if (cycle) trail.push(`gaps are not transitive among ${cycle.map((r) => r.id).join(', ')}; leader chosen by ${primary ?? 'no primary benchmark'}`);
  let pick = leader;
  if (pick) {
    trail.push(`strongest: ${leader.model} (${leader.id}, ${primary && leader.scores[primary] !== undefined ? `${primary} ${leader.scores[primary]}` : 'no primary external benchmark'}${leader.internal ? `, internal score ${leader.internal.score} (${leader.internal.n} records)` : ''})`);
    const within = (x, lim) => x.gap !== null && x.gap <= lim;
    // Rule 3: the fastest candidate (within 30% counts as equally fast; then free > Go > pay-as-you-go).
    // Speed: task speed (completion-time ratio on the same task, oc-track.mjs) when every candidate has it; response latency
    // does not predict completion speed, so it is only the fallback
    const quickest = (cands) => {
      const byTask = cands.length > 1 && cands.every((x) => x.taskSpeed !== null);
      const sp = (x) => (byTask ? x.taskSpeed : x.seconds) ?? 1e9;
      const fastest = Math.min(...cands.map(sp));
      const quick = cands.filter((x) => sp(x) <= fastest * SPEED_EQUAL).sort((a, b) => (COST[a.plan] - COST[b.plan]) || (sp(a) - sp(b)));
      const how = cands.length < 2 ? '' : byTask ? 'speed compared by measured task speed' : fastest < 1e9 ? 'speed compared by response latency (some candidates lack task speed; latency does not predict completion speed)' : 'no speed data; chosen by plan';
      const speed = (x) => byTask ? `task speed x${x.taskSpeed}` : x.seconds !== null ? `${x.seconds}s` : 'latency not probed';
      return { pick: quick[0], tie: quick.length > 1, how, speed };
    };
    // Rule 2 (user's call: token plan beats speed): a token-plan model within 10 points wins; best score first, equal
    // gaps resolved by the same speed rule as rule 3 (task speed when every tied candidate has it, else latency)
    const tokens = scored.filter((x) => x.plan === 'token' && within(x, CLOSE)).sort((a, b) => a.gap - b.gap);
    if (tokens.length) {
      const tied = tokens.filter((x) => x.gap === tokens[0].gap);
      const t = quickest(tied);
      pick = t.pick;
      if (pick !== leader) trail.push(`Qwen token plan within ${CLOSE} -> ${pick.id} (gap ${pick.gap.toFixed(1)}; token plan beats speed${tied.length > 1 ? `; equal gaps: ${t.how}` : ''})`);
    } else {
      const q = quickest(scored.filter((x) => within(x, SAME)));
      if (q.how) trail.push(`same capability (gap <= ${SAME}): ${q.how}`);
      if (q.pick !== leader) trail.push(`fastest with same capability${q.tie ? ' (similar speed: cheaper plan)' : ''} -> ${q.pick.id} (${q.speed(q.pick)})`);
      pick = q.pick;
      // Rule 4: pay-as-you-go only when no free / Go model is within 10 points; otherwise re-apply rule 3 among them (within 5 first, then 10)
      if (pick.plan === 'paid') {
        const cheap = (lim) => scored.filter((x) => (x.plan === 'free' || x.plan === 'go') && within(x, lim));
        const pool = cheap(SAME).length ? cheap(SAME) : cheap(CLOSE);
        if (pool.length) {
          const c = quickest(pool);
          pick = c.pick;
          trail.push(`pay-as-you-go only when no free / Go model is within ${CLOSE} -> ${pick.id} (gap ${pick.gap.toFixed(1)}, ${c.speed(pick)})`);
        }
      }
    }
  }
  const unscored = rows.filter((r) => !Object.keys(r.scores).length && !r.internal).map((r) => r.id);
  return { category: cat, label: table.categories[cat].label, primary, pick: pick?.id ?? null, trail, ranking: scored, unscored };
}

const cats = task === 'all' ? Object.keys(table.categories) : [task];
for (const c of cats) if (!table.categories[c]) { console.error(`unknown task category: ${c}`); process.exit(2); }
const results = cats.map(rankCategory);

// Shadow-run candidates (SKILL.md "Shadow runs"): usable anonymous models — marked stealth in scores.json — plus models the
// table does not have yet (fill the table first; only models without external benchmarks get stealth). One entry per model,
// the cheapest plan (free > Go > pay-as-you-go), so a model never shadow-runs twice. Only the stealth entries are shadow
// candidates (JSON `shadow`); a model the table does not know yet is not anonymous until it is added and marked, so it is
// listed separately (JSON `notInTable`).
const shadowKey = (id) => byAlias.get(id)?.key ?? id.split('/').pop().replace(/-free$/, '');
const pausedKeys = new Set([...pausedMap.keys()].map(shadowKey));
const shadowMap = new Map();
for (const m of usable) {
  const e = byAlias.get(m.id);
  if (e && !e.stealth) continue;
  const k = shadowKey(m.id), cur = shadowMap.get(k);
  if (pausedKeys.has(k)) continue; // any entry paused: the anonymous model waits for the reset
  if (!cur || COST[plan(m.id)] < COST[plan(cur.id)]) shadowMap.set(k, { id: m.id, context: m.context ?? null, known: !!e });
}
const listed = [...shadowMap.values()];
const shadow = noFree ? [] : listed.filter((m) => m.known);
const notInTable = listed.filter((m) => !m.known);

if (argv.includes('--json')) {
  const pausedJson = pausedList.map(([id, e]) => ({ id, hitAt: e.hitAt, nextProbe: e.nextProbe, due: dueSet.has(id) }));
  console.log(JSON.stringify({ cache: { created: cache.created, probed: cache.probed }, ...(noFree ? { noFree: true } : {}), results, ...(pausedJson.length ? { paused: pausedJson } : {}), shadow, notInTable, droppedUnknownContext: droppedUnknown }, null, 2));
} else {
  if (!cache.probed) console.log('!! the cache has no probe results (built without --probe); availability not confirmed');
  for (const r of results) {
    console.log(`\n## ${r.label} (${r.category})`);
    if (!r.ranking.length) { console.log('no scores in this category -> compare with a small trial task'); continue; }
    console.log(`primary benchmark: ${r.primary}   pick: ${r.pick}`);
    for (const t of r.trail) console.log(`  - ${t}`);
    for (const x of r.ranking) {
      const gap = x.gap === null ? 'no shared' : x.gap === 0 ? 'leader' : `gap ${x.gap.toFixed(1)}`;
      const sc = Object.entries(x.scores).map(([b, v]) => `${b} ${v}${x.sources[b]?.source === 'vendor' ? '*' : ''}`).join(', ');
      console.log(`  ${x.id.padEnd(44)} ${gap.padEnd(10)} ${PLAN_LABEL[x.plan].padEnd(14)} ${x.seconds === null ? '   ?' : String(x.seconds).padStart(5) + 's'}  ${x.internal ? `internal ${x.internal.score} (${x.internal.n})${sc ? ', ' : ''}` : ''}${sc}${x.taskSpeed !== null ? `  task speed x${x.taskSpeed}` : ''}`);
    }
    if (r.unscored.length) console.log(`  no scores in this category (needs a trial to compare): ${r.unscored.join(', ')}`);
  }
  const fmt = (m) => `${m.id} (context ${m.context ? Math.round(m.context / 1000) + 'k' : '?'})`;
  if (droppedUnknown.length) console.log(`\ndropped (context unknown, --min-context ${minContext}): ${droppedUnknown.join(', ')}`);
  if (pausedList.length) {
    const clock = (v) => {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const list = pausedList.map(([id, e]) => `${id} (next probe ${clock(e.nextProbe)}${dueSet.has(id) ? ', DUE' : ''})`);
    console.log(`\npaused (rate limited): ${list.join(', ')}`);
  }
  if (noFree) console.log('\nshadow runs paused (--no-free: free usage limit)');
  else if (shadow.length) console.log(`\nshadow-run candidates (anonymous models marked stealth; run all when the conditions hold): ${shadow.map(fmt).join(', ')}`);
  if (notInTable.length) console.log(`\nnot in the score table yet (look up benchmarks and add them to scores.json; mark stealth and shadow-run if none exist): ${notInTable.map(fmt).join(', ')}`);
  console.log(`\n* vendor-reported. Gap = weighted mean of the shared external benchmark gap (same name and version) and the internal score gap (internal weighs ${INTERNAL_WEIGHT}x); internal scores and past records: oc-track.mjs.`);
}
