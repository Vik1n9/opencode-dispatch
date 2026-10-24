#!/usr/bin/env node
// Rank models for one kind of task, from the session inventory cache + the curated benchmark table + the
// derived internal scores. No probing, no network: run oc-models.mjs --probe --cache <file> once per session,
// then call this for every dispatch decision.
//
// Data folder: $OC_DISPATCH_HOME, else ~/.config/opencode-dispatch (benchmarks.json and internal.json are
// read from there; see lib.mjs). internal.json is derived from track.jsonl by oc-track.mjs and holds the
// dispatch history scores; benchmarks.json holds the curated external benchmarks.
//
// Usage: node oc-rank.mjs --task <category|all> [--cache <file>] [--min-context <tokens>]
//                         [--scores <file>] [--json] [--no-free]
//   --cache        session inventory written by oc-models.mjs; default $OC_DISPATCH_CACHE or
//                  ~/.cache/opencode-dispatch/inventory.json. Missing -> exit 2; older than 12 hours -> warn.
//   --min-context  drop entries whose context window is smaller (e.g. continuing a long session: 400000);
//                  must be a finite number >= 0. A usable model whose context is unknown is dropped too,
//                  but reported (text: one "dropped (context unknown, --min-context N)" line; JSON:
//                  droppedUnknownContext)
//   --scores       benchmark table to rank from; default $OC_DISPATCH_HOME/benchmarks.json
//   --no-free      drop every Zen free entry (plan free, ids starting opencode/) before ranking, for while
//                  the free usage limit lasts: only token plan / Go / pay-as-you-go entries are ranked;
//                  shadow runs are paused (text says so, JSON shadow is empty and noFree is true);
//                  notInTable is filtered too
//   categories are defined in benchmarks.json (repo-coding, terminal, greenfield, tools, gui-vision,
//   reasoning, security, instruction, long-context)
//
// Exit codes: 2 (one lower-case line on stderr) when --task is missing, the inventory cache is missing,
//   --min-context is invalid, or <cache>/<scores> cannot be read, cannot be parsed, or lack their expected
//   shape (models array; models + categories).
//
// Allocation rules (user, 2026-10-19; SKILL.md "Allocation rules"), applied in order:
//   1. capability first — compare only the benchmarks of this task's category, on benchmarks both
//      models have (same name and version); gap = (mean external diff + INTERNAL_WEIGHT × internal diff)
//      / (1 + INTERNAL_WEIGHT). Internal score = graded dispatch history (oc-track.mjs, internal.json).
//      Leader = best on the primary benchmark, replaced by anyone the blended gap says is stronger;
//      when those gaps cycle (not transitive across differing shared benchmarks), the best
//      primary-benchmark score in the cycle leads. gap ≤ 5 same, ≤ 10 close, > 10 clearly weaker
//   2. within 10 points, a Qwen token-plan model wins (token plan beats speed — user's call); best score first
//   3. otherwise, among models within 5 points (same capability), the fastest by task-completion speed
//      (internal.<cat>.speed, same taskId compared; within 30% counts as equal, then free > Go > pay-as-you-go)
//      when every candidate has it. Without it, probe latency is one noisy sample (entries of the same model
//      swap order between probes), so the plan decides: free > Go > pay-as-you-go, latency only breaks ties
//   4. pay-as-you-go is used only when no free / Go model is within 10 points — even when the paid entry is
//      faster (user: free first whenever the gap is small); rule 3 is re-applied to the free / Go models
//
// Also lists shadow-run candidates: usable models marked stealth in benchmarks.json, and models the table
// does not know yet (fill the table first — only models without any public benchmark get stealth: true).
// JSON: shadow holds only the stealth entries, notInTable the unknown ones. One entry per model (the
// cheapest plan). Models the official live list no longer has are skipped.
// Models blocked in limits.json in either way are dropped from ranking and shadow runs, and listed:
//   - until-based entries (rate limit / quota, future until or source "no-reset"; written by oc-run.mjs
//     via lib.mjs) as `limited:` lines (JSON limited)
//   - re-probe pauses (entries with a nextProbe schedule, written by oc-limits.mjs / the probes) in the
//     `paused (rate limited):` section (JSON paused); they wait for a successful probe or run on that id

import { existsSync, readFileSync } from 'node:fs';
import { exitIfVersion, BENCHMARKS, CACHE, CACHE_MAX_AGE_H, blockedUntil, loadInternal, plan } from './lib.mjs';
import { due, paused, readLimits } from './oc-limits.mjs';

exitIfVersion();

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const cachePath = val('--cache', null);
const task = val('--task', null);
const scoresPath = val('--scores', BENCHMARKS);
const noFree = argv.includes('--no-free');
const USAGE = 'usage: oc-rank.mjs --task <category|all> [--cache <file>] [--min-context <tokens>] [--scores <file>] [--json] [--no-free]';
if (!task) {
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

// The default cache has its own "run oc-models first" hint; an explicit --cache that cannot be read is
// a plain input error like every other file argument.
let cache;
if (cachePath === null) {
  if (!existsSync(CACHE)) {
    console.error('no inventory cache — run: node oc-models.mjs --probe');
    console.error(USAGE);
    process.exit(2);
  }
  cache = loadJson(CACHE, (d) => (isObj(d) && Array.isArray(d.models) ? null : 'has no models array'));
} else {
  cache = loadJson(cachePath, (d) => (isObj(d) && Array.isArray(d.models) ? null : 'has no models array'));
}
const table = loadJson(scoresPath, (d) => (isObj(d) && isObj(d.models) && isObj(d.categories) ? null : 'has no models or categories'));
const internalTable = loadInternal();

const refreshed = Math.max(Date.parse(cache.created || '') || 0, Date.parse(cache.updated || '') || 0);
const ageHours = refreshed ? (Date.now() - refreshed) / 36e5 : 0;
const stale = ageHours > CACHE_MAX_AGE_H;

const byAlias = new Map();
for (const [key, m] of Object.entries(table.models)) for (const a of m.aliases || []) byAlias.set(a, { key, ...m });

const PLAN_LABEL = { token: 'Qwen token plan', free: 'Zen free', go: 'Go plan', paid: 'pay-as-you-go' };

// Limits: one tolerant read feeds both mechanisms — the until-based blocks (lib.mjs blockedUntil) and the
// re-probe pauses (oc-limits.mjs). A corrupt file only warns (readLimits) and ranks everything.
const now = new Date();
const limits = readLimits();
const blocked = Object.entries(limits)
  .map(([id, limit]) => ({ id, limit, until: blockedUntil(id, now, limits) }))
  .filter((x) => x.until);
const blockedIds = new Set(blocked.map((x) => x.id));
const blockedLines = blocked.map(({ id, limit, until }) => limit.source === 'no-reset'
  ? `limited: ${id} — needs owner action`
  : `limited: ${id} until ${until.toLocaleString()} (${limit.source})`);
const pausedMap = paused(now);
const pausedList = [...pausedMap.entries()];
const dueSet = new Set(due(now));

// Usable: probe result when probed; without a probe (cache built without --probe) every model is a candidate, with a warning.
// Models the official live list no longer has (live === false) are never dispatched. Blocked or paused models are excluded
// exactly like failed probes; they are listed below. --min-context drops models whose context is too small, and usable
// models whose context is unknown (they cannot be judged) — the latter are reported.
const droppedUnknown = [];
const usable = cache.models.filter((m) => {
  if (!m.id || m.live === false || (m.probe && !m.probe.ok)) return false;
  if (blockedIds.has(m.id) || pausedMap.has(m.id)) return false; // rate limited: out of ranking and shadow runs
  if (noFree && m.id.startsWith('opencode/')) return false; // Zen free: suppressed while the free limit lasts
  if (!minContext) return true;
  if (m.context == null) { droppedUnknown.push(m.id); return false; }
  return m.context >= minContext;
});
const COST = { token: 0, free: 1, go: 2, paid: 3 };

// Internal score (internal.json → models.<key>.<category>, computed by oc-track.mjs from the track record) weighs
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
    const internal = entry?.key ? internalTable.models?.[entry.key]?.[cat] ?? null : null;
    return { id: m.id, model: entry?.name ?? m.name ?? m.id, key: entry?.key ?? null, plan: plan(m.id),
      seconds: m.probe?.seconds ?? null, scores, sources: entry?.scores || {}, internal,
      taskSpeed: internal?.speed?.[m.id]?.ratio ?? null };
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
    trail.push(`strongest: ${leader.model} (${leader.id}, ${primary && leader.scores[primary] !== undefined ? `${primary} ${leader.scores[primary]}` : 'no primary external benchmark'}${leader.internal ? `, internal score ${leader.internal.score} (c ${leader.internal.correctness ?? '–'} / q ${leader.internal.quality ?? '–'}, ${leader.internal.n} records)` : ''})`);
    const within = (x, lim) => x.gap !== null && x.gap <= lim;
    // Rule 3: with task speed for every candidate, the fastest (within 30% counts as equally fast; then free > Go >
    // pay-as-you-go). Without it the plan decides — probe latency is too noisy to rank by — and latency breaks ties
    const quickest = (cands) => {
      const byTask = cands.length > 1 && cands.every((x) => x.taskSpeed !== null);
      const sp = (x) => (byTask ? x.taskSpeed : x.seconds) ?? 1e9;
      const fastest = Math.min(...cands.map(sp));
      const quick = (byTask ? cands.filter((x) => sp(x) <= fastest * SPEED_EQUAL) : cands).sort((a, b) => (COST[a.plan] - COST[b.plan]) || (sp(a) - sp(b)));
      const how = cands.length < 2 ? '' : byTask ? 'speed compared by measured task speed' : 'some candidates lack task speed; chosen by plan (free first), latency only breaks ties';
      const speed = (x) => byTask ? `task speed x${x.taskSpeed}` : x.seconds !== null ? `${x.seconds}s` : 'latency not probed';
      return { pick: quick[0], tie: quick.length > 1, how, speed, byTask };
    };
    // Rule 2 (user's call: token plan beats speed): a token-plan model within 10 points wins; best score first, speed breaks ties
    const tokens = scored.filter((x) => x.plan === 'token' && within(x, CLOSE))
      .sort((a, b) => (a.gap - b.gap) || ((a.seconds ?? 1e9) - (b.seconds ?? 1e9)));
    if (tokens.length) {
      pick = tokens[0];
      if (pick !== leader) trail.push(`Qwen token plan within ${CLOSE} -> ${pick.id} (gap ${pick.gap.toFixed(1)}; token plan beats speed)`);
    } else {
      const q = quickest(scored.filter((x) => within(x, SAME)));
      if (q.how) trail.push(`same capability (gap <= ${SAME}): ${q.how}`);
      if (q.pick !== leader) trail.push(`${q.byTask ? `fastest with same capability${q.tie ? ' (similar speed: cheaper plan)' : ''}` : 'cheapest plan with same capability'} -> ${q.pick.id} (${q.speed(q.pick)})`);
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

// Shadow-run candidates (SKILL.md "Shadow runs"): usable anonymous models — marked stealth in benchmarks.json — plus models the
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

if (stale) console.error(`!! inventory cache is ${Math.floor(ageHours)}h old — re-run oc-models.mjs --probe`);

if (argv.includes('--json')) {
  const pausedJson = pausedList.map(([id, e]) => ({ id, hitAt: e.hitAt, nextProbe: e.nextProbe, due: dueSet.has(id) }));
  console.log(JSON.stringify({ cache: { created: cache.created, updated: cache.updated, probed: cache.probed }, ...(noFree ? { noFree: true } : {}), limited: blockedLines, results, ...(pausedJson.length ? { paused: pausedJson } : {}), shadow, notInTable, droppedUnknownContext: droppedUnknown }, null, 2));
} else {
  for (const line of blockedLines) console.log(line);
  if (!cache.probed) console.log('!! the cache has no probe results (built without --probe); availability not confirmed');
  for (const r of results) {
    console.log(`\n## ${r.label} (${r.category})`);
    if (!r.ranking.length) { console.log('no scores in this category -> compare with a small trial task'); continue; }
    console.log(`primary benchmark: ${r.primary}   pick: ${r.pick}`);
    for (const t of r.trail) console.log(`  - ${t}`);
    for (const x of r.ranking) {
      const gap = x.gap === null ? 'no shared' : x.gap === 0 ? 'leader' : `gap ${x.gap.toFixed(1)}`;
      const sc = Object.entries(x.scores).map(([b, v]) => `${b} ${v}${x.sources[b]?.source === 'vendor' ? '*' : ''}`).join(', ');
      const int = x.internal ? `internal ${x.internal.score} (c ${x.internal.correctness ?? '–'} / q ${x.internal.quality ?? '–'}, ${x.internal.n})${sc ? ', ' : ''}` : '';
      console.log(`  ${x.id.padEnd(44)} ${gap.padEnd(10)} ${PLAN_LABEL[x.plan].padEnd(14)} ${x.seconds === null ? '   ?' : String(x.seconds).padStart(5) + 's'}  ${int}${sc}${x.taskSpeed !== null ? `  task speed x${x.taskSpeed}` : ''}`);
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
  if (notInTable.length) console.log(`\nnot in the benchmark table yet (look up benchmarks and add them to benchmarks.json; mark stealth and shadow-run if none exist): ${notInTable.map(fmt).join(', ')}`);
  console.log(`\n* vendor-reported. Gap = weighted mean of the shared external benchmark gap (same name and version) and the internal score gap (internal weighs ${INTERNAL_WEIGHT}x); internal scores and past records: oc-track.mjs (internal.json).`);
}
