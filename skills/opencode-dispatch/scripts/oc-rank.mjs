#!/usr/bin/env node
// Rank models for one kind of task, from the session inventory cache + the curated benchmark table + the
// derived internal scores. No probing, no network: run oc-models.mjs --probe --cache <file> once per session,
// then call this for every dispatch decision.
//
// Data folder: $OC_DISPATCH_HOME, else ~/.config/opencode-dispatch (benchmarks.json and internal.json are
// read from there; see lib.mjs). internal.json is derived from track.jsonl by oc-track.mjs and holds the
// dispatch history scores; benchmarks.json holds the curated external benchmarks.
//
// Usage: node oc-rank.mjs --task <category|all> [--cache <file>] [--min-context <tokens>] [--json]
//   --cache        session inventory written by oc-models.mjs; default $OC_DISPATCH_CACHE or
//                  ~/.cache/opencode-dispatch/inventory.json. Missing -> exit 2; older than 6 hours -> warn.
//   --min-context  drop entries whose context window is smaller (e.g. continuing a long session: 400000)
//   categories are defined in benchmarks.json (repo-coding, terminal, greenfield, tools, gui-vision,
//   reasoning, security, instruction, long-context)
//   models blocked in limits.json (rate limit / quota, future until or source "no-reset") are excluded from
//   ranking and shadow candidates, and listed one per line
//
// Allocation rules (user, 2026-10-19; SKILL.md "Allocation rules"), applied in order:
//   1. capability first — compare only the benchmarks of this task's category, on benchmarks both
//      models have (same name and version); gap = (mean external diff + INTERNAL_WEIGHT × internal diff)
//      / (1 + INTERNAL_WEIGHT). Internal score = graded dispatch history (oc-track.mjs, internal.json).
//      Leader = best on the primary benchmark, replaced by anyone the blended gap says is stronger.
//      gap ≤ 5 same, ≤ 10 close, > 10 clearly weaker
//   2. within 10 points, a Qwen token-plan model wins (token plan beats speed — user's call); best score first
//   3. otherwise, among models within 5 points (same capability), the fastest (within 30% counts as equal
//      speed; then free > Go > pay-as-you-go). Speed = task-completion speed (internal.<cat>.speed, same
//      taskId compared) when every candidate has it, else probe latency
//   4. pay-as-you-go is used only when no free / Go model is within 10 points — even when the paid entry is
//      faster (user: free first whenever the gap is small); rule 3 is re-applied to the free / Go models
//
// Also lists shadow-run candidates: usable models marked stealth in benchmarks.json, and models the table
// does not know yet (fill the table first — only models without any public benchmark get stealth: true).
// One entry per model (the cheapest plan). Models the official live list no longer has are skipped.

import { existsSync, readFileSync } from 'node:fs';
import { CACHE, blockedUntil, loadBenchmarks, loadInternal, loadLimits, plan } from './lib.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const cachePath = val('--cache', CACHE);
const task = val('--task', null);
if (!task) {
  console.error('usage: oc-rank.mjs --task <category|all> [--cache <file>] [--min-context <tokens>] [--json]');
  process.exit(2);
}
if (!existsSync(cachePath)) {
  console.error('no inventory cache — run: node oc-models.mjs --probe');
  process.exit(2);
}
const SAME = 5, CLOSE = 10, SPEED_EQUAL = 1.3;

const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
const table = loadBenchmarks();
const internalTable = loadInternal();
const limits = loadLimits();
const refreshed = Math.max(Date.parse(cache.created || '') || 0, Date.parse(cache.updated || '') || 0);
const ageHours = refreshed ? (Date.now() - refreshed) / 36e5 : 0;
const stale = ageHours > 6;
const byAlias = new Map();
for (const [key, m] of Object.entries(table.models)) for (const a of m.aliases || []) byAlias.set(a, { key, ...m });

const PLAN_LABEL = { token: 'Qwen token plan', free: 'Zen free', go: 'Go plan', paid: 'pay-as-you-go' };

// Usable: probe result when probed; without a probe (cache built without --probe) every model is a candidate, with a warning.
// Models the official live list no longer has (live === false) are never dispatched. Models blocked in limits.json
// (rate limit / quota exhausted) are excluded exactly like failed probes; they are listed below.
const minContext = Number(val('--min-context', 0));
const now = new Date();
const blocked = Object.entries(limits)
  .map(([id, limit]) => ({ id, limit, until: blockedUntil(id, now, limits) }))
  .filter((x) => x.until);
const blockedIds = new Set(blocked.map((x) => x.id));
const blockedLines = blocked.map(({ id, limit, until }) => limit.source === 'no-reset'
  ? `limited: ${id} — needs owner action`
  : `limited: ${id} until ${until.toLocaleString()} (${limit.source})`);
const usable = cache.models.filter((m) => m.id && m.live !== false && (!m.probe || m.probe.ok)
  && (!minContext || (m.context ?? 0) >= minContext) && !blockedIds.has(m.id));
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
  // The primary benchmark only sets the start; if the blended gap shows anyone stronger (negative gap), it leads instead, until nobody is
  let leader = scored[0];
  for (let k = 0; k < scored.length && leader; k++) {
    const better = scored.map((r) => ({ r, d: r === leader ? null : diff(leader, r) }))
      .filter((x) => x.d !== null && x.d < 0).sort((x, y) => x.d - y.d)[0];
    if (!better) break;
    leader = better.r;
  }
  for (const r of scored) {
    r.gap = r === leader ? 0 : diff(leader, r);
    r.tier = r.gap === null ? 'no-common' : r.gap <= SAME ? 'same' : r.gap <= CLOSE ? 'close' : 'weaker';
  }
  // One model version may have several entries (e.g. API and Zen free): same scores, so rules 2–4 choose by plan and speed
  const trail = [];
  let pick = leader;
  if (pick) {
    trail.push(`strongest: ${leader.model} (${leader.id}, ${primary && leader.scores[primary] !== undefined ? `${primary} ${leader.scores[primary]}` : 'no primary external benchmark'}${leader.internal ? `, internal score ${leader.internal.score} (c ${leader.internal.correctness} / q ${leader.internal.quality ?? '–'}, ${leader.internal.n} records)` : ''})`);
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
    // Rule 2 (user's call: token plan beats speed): a token-plan model within 10 points wins; best score first, speed breaks ties
    const tokens = scored.filter((x) => x.plan === 'token' && within(x, CLOSE))
      .sort((a, b) => (a.gap - b.gap) || ((a.seconds ?? 1e9) - (b.seconds ?? 1e9)));
    if (tokens.length) {
      pick = tokens[0];
      if (pick !== leader) trail.push(`Qwen token plan within ${CLOSE} -> ${pick.id} (gap ${pick.gap.toFixed(1)}; token plan beats speed)`);
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

// Shadow-run candidates (SKILL.md "Shadow runs"): usable anonymous models — marked stealth in benchmarks.json — plus models the
// table does not have yet (fill the table first; only models without external benchmarks get stealth). One entry per model,
// the cheapest plan (free > Go > pay-as-you-go), so a model never shadow-runs twice.
const shadowKey = (m) => byAlias.get(m.id)?.key ?? m.id.split('/').pop().replace(/-free$/, '');
const shadowMap = new Map();
for (const m of usable) {
  const e = byAlias.get(m.id);
  if (e && !e.stealth) continue;
  const k = shadowKey(m), cur = shadowMap.get(k);
  if (!cur || COST[plan(m.id)] < COST[plan(cur.id)]) shadowMap.set(k, { id: m.id, context: m.context ?? null, known: !!e });
}
const shadow = [...shadowMap.values()];

if (stale) console.error(`!! inventory cache is ${Math.floor(ageHours)}h old — re-run oc-models.mjs --probe`);

if (argv.includes('--json')) {
  console.log(JSON.stringify({ cache: { created: cache.created, updated: cache.updated, probed: cache.probed }, limited: blockedLines, results, shadow }, null, 2));
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
      const int = x.internal ? `internal ${x.internal.score} (c ${x.internal.correctness} / q ${x.internal.quality ?? '–'}, ${x.internal.n})${sc ? ', ' : ''}` : '';
      console.log(`  ${x.id.padEnd(44)} ${gap.padEnd(10)} ${PLAN_LABEL[x.plan].padEnd(14)} ${x.seconds === null ? '   ?' : String(x.seconds).padStart(5) + 's'}  ${int}${sc}${x.taskSpeed !== null ? `  task speed x${x.taskSpeed}` : ''}`);
    }
    if (r.unscored.length) console.log(`  no scores in this category (needs a trial to compare): ${r.unscored.join(', ')}`);
  }
  const fmt = (m) => `${m.id} (context ${m.context ? Math.round(m.context / 1000) + 'k' : '?'})`;
  const marked = shadow.filter((m) => m.known), unknown = shadow.filter((m) => !m.known);
  if (marked.length) console.log(`\nshadow-run candidates (anonymous models marked stealth; run all when the conditions hold): ${marked.map(fmt).join(', ')}`);
  if (unknown.length) console.log(`\nnot in the benchmark table yet (look up benchmarks and add them to benchmarks.json; mark stealth and shadow-run if none exist): ${unknown.map(fmt).join(', ')}`);
  console.log(`\n* vendor-reported. Gap = weighted mean of the shared external benchmark gap (same name and version) and the internal score gap (internal weighs ${INTERNAL_WEIGHT}x); internal scores and past records: oc-track.mjs (internal.json).`);
}
