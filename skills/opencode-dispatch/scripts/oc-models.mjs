#!/usr/bin/env node
// Which models can be dispatched right now — official information first, local opencode second.
//
// The local opencode model catalog often lags behind (new free / stealth models missing, retired
// ones still listed), so it is never the source of truth. This script:
//   1. reads OpenCode's official Zen docs (pricing table + model ID table) → models priced Free
//   2. checks them against the official live list (https://opencode.ai/zen/v1/models)
//   3. lists the user's API-key providers from the local catalog (no public list without a key —
//      verify those against the vendor's own docs before relying on them)
//   4. --probe: calls each candidate on this machine to confirm it really answers
// Go (opencode-go/…): the user has a Go subscription and accepts "Contributor" models (data used for
// training). All models on the official Go live list (https://opencode.ai/zen/go/v1/models) are listed, priced
// from the Go docs table (https://opencode.ai/docs/go/); usage counts toward the Go monthly allowance. --no-go skips.
//
// Usage: node oc-models.mjs [--probe] [--no-go] [--concurrency 6] [--timeout 120] [--json]
//                           [--cache <file>] [--only <model-id>]
//   --cache <file>  write the inventory (with probe results) to a session cache file; later dispatches in the
//                   same session read it via oc-rank.mjs instead of re-running this script; a missing parent
//                   folder is created
//   --only <id>     probe just this model and merge the result into --cache (use when a cached model fails
//                   at dispatch time); needs a cache from a full run
//
// Warnings (official page unreadable or empty, local catalog unavailable) go to stderr and into the cache.
// Exit codes: 0 ok, 2 blocked environment or bad usage (--concurrency / --timeout not a positive integer,
// --only unknown or with a missing / unparseable cache).

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEnvironment } from './oc-check.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
// An explicit flag with no value is invalid too, so read the raw slot instead of falling back to the default.
const positiveInt = (flag, d) => {
  const i = argv.indexOf(flag);
  const raw = i < 0 ? d : argv[i + 1];
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) {
    console.error(`usage: ${flag} must be a positive integer`);
    process.exit(2);
  }
  return Number(raw);
};
const concurrency = positiveInt('--concurrency', 6);
const timeoutS = positiveInt('--timeout', 120);
const probeTitle = `oc-models-probe-${process.pid}-${Date.now()}`;
const only = val('--only', null);
const cachePath = val('--cache', null);
const ZEN_DOCS = 'https://opencode.ai/docs/zen/';
const ZEN_LIVE = 'https://opencode.ai/zen/v1/models';
const GO_DOCS = 'https://opencode.ai/docs/go/';
const GO_LIVE = 'https://opencode.ai/zen/go/v1/models';
const HOSTED = new Set(['opencode', 'opencode-go']); // OpenCode's own (Zen / Go): official information wins
const warnings = [];

const env = checkEnvironment();
if (!env.ok) { console.error(env.error); process.exit(2); }

// --only merges into a cache from a full run; refuse before probing when that cache is missing or unreadable.
let priorCache = null;
if (only && cachePath) {
  try { priorCache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { priorCache = null; }
  if (!priorCache || !Array.isArray(priorCache.models)) {
    console.error(`--only needs an existing cache from a full run: ${cachePath}`);
    process.exit(2);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'oc-models-'));
// 60 s: a hung background service must not block the inventory forever; failures surface as warnings.
const oc = (args) => {
  const r = spawnSync('opencode', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000, env: { ...process.env, PWD: dir } });
  return r.error || r.status !== 0 ? '' : r.stdout || '';
};

/* ---------- 1–2. Official: Zen pricing + model IDs, checked against the live list ---------- */
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/g, ' ').trim();
let official = [], officialError = null;
try {
  const html = await (await fetch(ZEN_DOCS)).text();
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])));
  const idOf = new Map(rows.filter((r) => r.length === 4 && r[1] && r[1] !== 'Model ID').map((r) => [r[0], r[1]]));
  const liveIds = ((await (await fetch(ZEN_LIVE)).json()).data || []).map((m) => m.id);
  if (!liveIds.length) throw new Error('Zen live list returned no models');
  const live = new Set(liveIds);
  const seen = new Set();
  for (const r of rows) {
    if (r.length !== 5 || r[1] !== 'Free' || r[2] !== 'Free' || seen.has(r[0])) continue;
    seen.add(r[0]);
    const id = idOf.get(r[0]) ?? null;
    official.push({ id: id ? `opencode/${id}` : null, name: r[0], source: 'official', cost: 'free', live: id ? live.has(id) : null });
  }
  // No Free rows: the page layout changed or the table is rendered client-side. Without an error every local
  // Zen model would be reported as retired below, so fail loudly instead.
  if (!official.length) officialError = 'Zen docs page has no Free model rows (layout changed or table is JS-only)';
} catch (e) {
  officialError = String(e.message || e);
}

/* ---------- 2b. Official: Go live list + pricing (the price table has names only; match IDs by normalized name) ---------- */
if (!has('--no-go')) {
  try {
    const html = await (await fetch(GO_DOCS)).text();
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])));
    const norm = (x) => x.toLowerCase().replace(/[\s.]+/g, '-').replace(/-+/g, '-');
    const price = new Map();
    for (const r of rows) if (r.length === 6 && r[0] !== 'Model' && !price.has(norm(r[0].replace(/\s*\(.*\)$/, '')))) price.set(norm(r[0].replace(/\s*\(.*\)$/, '')), r);
    const ids = ((await (await fetch(GO_LIVE)).json()).data || []).map((m) => m.id);
    // The live list is authoritative; zero IDs means the endpoint changed and every Go model would vanish silently.
    if (!ids.length) throw new Error('Go live list returned no models');
    // The price table is matched by normalized name, so a missing table only downgrades prices to "Go(no price)";
    // say so, because every model then looks equally priced.
    if (!price.size) warnings.push('Go docs page has no price rows (layout changed); Go models show Go(no price)');
    for (const id of ids) {
      const r = price.get(norm(id));
      const cost = !r ? 'Go(no price)' : r[1] === 'Free' && r[2] === 'Free' ? 'Go free' : `Go ${r[1]}/${r[2]}`;
      official.push({ id: `opencode-go/${id}`, name: r?.[0] ?? id, source: 'official(Go)', cost, live: true,
        contributor: /contributor/i.test(id), monthlyLimit: r?.[5] ?? null });
    }
  } catch (e) {
    officialError = `${officialError ? officialError + '; ' : ''}Go: ${String(e.message || e)}`;
  }
}

/* ---------- 3. Local catalog: only providers the user registered with an API key; Zen entries are only compared ---------- */
let localCatalog = [];
{
  const raw = oc(['api', 'GET', '/api/model']);
  let why = raw ? '' : 'opencode api GET /api/model failed or timed out';
  if (!why) {
    try {
      localCatalog = JSON.parse(raw).data || [];
      if (!Array.isArray(localCatalog)) { localCatalog = []; why = 'local catalog has no data array'; }
      else if (!localCatalog.length) why = 'local catalog returned no models';
    } catch { why = 'local catalog returned invalid JSON'; }
  }
  if (why) warnings.push(`${why}; API-key providers and context lengths are missing`);
}
const localIds = new Set(localCatalog.map((m) => `${m.providerID}/${m.modelID}`));
for (const m of official) m.inLocalCatalog = m.id ? localIds.has(m.id) : false;
const keyed = localCatalog.filter((m) => !HOSTED.has(m.providerID)).map((m) => {
  const c = (m.cost || [])[0] || {};
  return {
    id: `${m.providerID}/${m.modelID}`, name: m.name, source: 'local-catalog (verify with vendor docs)',
    cost: c.input === undefined ? 'plan' : `$${c.input}/${c.output}`, live: null, inLocalCatalog: true,
    context: m.limit?.context ?? null, image: (m.capabilities?.input || []).includes('image'),
  };
});
// Context length and image input of official models: not in the official tables, so taken from the local catalog
for (const m of official) {
  const l = localCatalog.find((x) => `${x.providerID}/${x.modelID}` === m.id);
  if (l) { m.context = l.limit?.context ?? null; m.image = (l.capabilities?.input || []).includes('image'); }
}
let models = [...official, ...keyed].sort((a, b) => String(a.id).localeCompare(String(b.id)));
if (only) {
  if (!models.some((m) => m.id === only)) {
    console.error(`model not in the official lists or the local catalog: ${only}; cache left unchanged`);
    process.exit(2);
  }
  models = models.filter((m) => m.id === only);
}

/* ---------- 4. Local probe ---------- */
// Settles exactly once: on close, on a spawn error, or after the SIGKILL deadline. A child that ignores SIGTERM,
// or a grandchild holding the stdout pipe open, therefore cannot hang Promise.all.
async function probeOne(m) {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const timers = [];
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      // Drop the pipes: a surviving grandchild may still hold stdout open and would keep Node alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      let reply = '', error = '';
      for (const line of out.split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'text' && ev.part?.text) reply = ev.part.text;
          if (ev.type === 'error') error = ev.error?.message || JSON.stringify(ev.error);
        } catch { /* not json */ }
      }
      if (spawnError) error = `cannot start opencode: ${spawnError.code || spawnError.message}`;
      else if (seconds >= timeoutS) error ||= `timeout ${timeoutS}s`;
      if (/no-route|unavailable/i.test(error)) error = 'not in local opencode yet (official list has it)';
      resolve({ ok: code === 0 && /42/.test(reply), seconds, error: error.slice(0, 160) });
    };
    const child = spawn('opencode', ['run', '--format', 'json', '-m', m.id, '--agent', 'plan', '--title', probeTitle,
      'Read n.txt and reply with only the number in it.'], { cwd: dir, env: { ...process.env, PWD: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', (e) => finish(null, e));
    child.stdout?.on('data', (d) => (out += d));
    child.on('close', (code) => finish(code));
    timers.push(setTimeout(() => {
      child.kill('SIGTERM');
      timers.push(setTimeout(() => {
        child.kill('SIGKILL');
        timers.push(setTimeout(() => finish(null), 5000));
      }, 5000));
    }, timeoutS * 1000));
  });
}
if (has('--probe')) {
  writeFileSync(join(dir, 'n.txt'), '42\n');
  const queue = models.filter((m) => m.id);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) m.probe = await probeOne(m);
  }));
  try {
    // Only this run's sessions: a concurrent oc-models run keeps its own title.
    for (const s of JSON.parse(oc(['session', 'list', '-n', '500', '--format', 'json']) || '[]')) {
      if (s.title === probeTitle) oc(['session', 'delete', s.id]);
    }
  } catch { /* the title is recognizable; leave it if it cannot be deleted */ }
}
rmSync(dir, { recursive: true, force: true });

/* ---------- Write the session cache ---------- */
if (cachePath) {
  let cache = { created: new Date().toISOString(), officialError, warnings, models: [] };
  if (only) {
    cache = priorCache;
    cache.models = cache.models.filter((m) => m.id !== only).concat(models);
    cache.officialError = officialError;
    cache.warnings = warnings;
    cache.updated = new Date().toISOString();
  } else {
    cache.models = models;
    cache.probed = has('--probe');
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/* ---------- Output ---------- */
for (const w of warnings) console.error(`warning: ${w}`);
// Zen / Go models in the local catalog but not in the official lists: retired or no longer free — do not dispatch
const retired = localCatalog.filter((m) => HOSTED.has(m.providerID) && !(has('--no-go') && m.providerID === 'opencode-go')
  && !official.some((o) => o.id === `${m.providerID}/${m.modelID}`)).map((m) => `${m.providerID}/${m.modelID}`);
if (has('--json')) {
  console.log(JSON.stringify({ officialError, warnings, models, notOfficialFreeButLocal: retired }, null, 2));
} else {
  if (officialError) console.log(`!! cannot read official information (${officialError}) — do not dispatch from the local catalog alone`);
  for (const m of models) {
    const tag = m.source.startsWith('official')
      ? `${m.source}${m.live === false ? '(not on live list)' : ''}${m.contributor ? '[data used for training]' : ''}`
      : 'local -> check vendor docs';
    const p = m.probe ? (m.probe.ok ? `OK ${m.probe.seconds}s` : `FAIL ${m.probe.error || m.probe.seconds + 's'}`) : '';
    console.log([String(m.id ?? `(${m.name}: no official ID)`).padEnd(46), m.cost.padEnd(12), tag.padEnd(22),
      m.context ? `${Math.round(m.context / 1000)}k`.padStart(6) : '     ?', m.image ? 'img' : '   ', p].join('  '));
  }
  if (retired.length) console.log(`\nIn the local catalog but not in the official lists (retired or no longer free — do not dispatch): ${retired.join(', ')}`);
  console.log('\nGo usage counts toward the Go plan\'s monthly allowance (prices show how fast it is used up, not extra charges); [data used for training] marks Contributor models.');
}
