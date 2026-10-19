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
//                   same session read it via oc-rank.mjs instead of re-running this script
//   --only <id>     probe just this model and merge the result into --cache (use when a cached model fails
//                   at dispatch time)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvironment } from './oc-check.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const concurrency = Number(val('--concurrency', 6));
const timeoutS = Number(val('--timeout', 120));
const ZEN_DOCS = 'https://opencode.ai/docs/zen/';
const ZEN_LIVE = 'https://opencode.ai/zen/v1/models';
const GO_DOCS = 'https://opencode.ai/docs/go/';
const GO_LIVE = 'https://opencode.ai/zen/go/v1/models';
const HOSTED = new Set(['opencode', 'opencode-go']); // OpenCode's own (Zen / Go): official information wins

const env = checkEnvironment();
if (!env.ok) { console.error(env.error); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), 'oc-models-'));
const oc = (args) => spawnSync('opencode', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PWD: dir } }).stdout || '';

/* ---------- 1–2. Official: Zen pricing + model IDs, checked against the live list ---------- */
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/g, ' ').trim();
let official = [], officialError = null;
try {
  const html = await (await fetch(ZEN_DOCS)).text();
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])));
  const idOf = new Map(rows.filter((r) => r.length === 4 && r[1] && r[1] !== 'Model ID').map((r) => [r[0], r[1]]));
  const live = new Set(((await (await fetch(ZEN_LIVE)).json()).data || []).map((m) => m.id));
  const seen = new Set();
  for (const r of rows) {
    if (r.length !== 5 || r[1] !== 'Free' || r[2] !== 'Free' || seen.has(r[0])) continue;
    seen.add(r[0]);
    const id = idOf.get(r[0]) ?? null;
    official.push({ id: id ? `opencode/${id}` : null, name: r[0], source: 'official', cost: 'free', live: id ? live.has(id) : null });
  }
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
try { localCatalog = JSON.parse(oc(['api', 'GET', '/api/model'])).data || []; } catch { /* background service not running */ }
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
const only = val('--only', null);
if (only) models = models.filter((m) => m.id === only);

/* ---------- 4. Local probe ---------- */
async function probeOne(m) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('opencode', ['run', '--format', 'json', '-m', m.id, '--agent', 'plan', '--title', 'oc-models-probe',
      'Read n.txt and reply with only the number in it.'], { cwd: dir, env: { ...process.env, PWD: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutS * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      let reply = '', error = '';
      for (const line of out.split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'text' && ev.part?.text) reply = ev.part.text;
          if (ev.type === 'error') error = ev.error?.message || JSON.stringify(ev.error);
        } catch { /* not json */ }
      }
      if (seconds >= timeoutS) error ||= `timeout ${timeoutS}s`;
      if (/no-route|unavailable/i.test(error)) error = 'not in local opencode yet (official list has it)';
      resolve({ ok: code === 0 && /42/.test(reply), seconds, error: error.slice(0, 160) });
    });
  });
}
if (has('--probe')) {
  writeFileSync(join(dir, 'n.txt'), '42\n');
  const queue = models.filter((m) => m.id);
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) m.probe = await probeOne(m);
  }));
  try {
    for (const s of JSON.parse(oc(['session', 'list', '-n', '500', '--format', 'json']) || '[]')) {
      if (s.title === 'oc-models-probe') oc(['session', 'delete', s.id]);
    }
  } catch { /* the title is recognizable; leave it if it cannot be deleted */ }
}
rmSync(dir, { recursive: true, force: true });

/* ---------- Write the session cache ---------- */
const cachePath = val('--cache', null);
if (cachePath) {
  let cache = { created: new Date().toISOString(), officialError, models: [] };
  if (only && existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* broken file: rebuild */ }
    cache.models = cache.models.filter((m) => m.id !== only).concat(models);
    cache.updated = new Date().toISOString();
  } else {
    cache.models = models;
    cache.probed = has('--probe');
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/* ---------- Output ---------- */
// Zen / Go models in the local catalog but not in the official lists: retired or no longer free — do not dispatch
const retired = localCatalog.filter((m) => HOSTED.has(m.providerID) && !(has('--no-go') && m.providerID === 'opencode-go')
  && !official.some((o) => o.id === `${m.providerID}/${m.modelID}`)).map((m) => `${m.providerID}/${m.modelID}`);
if (has('--json')) {
  console.log(JSON.stringify({ officialError, models, notOfficialFreeButLocal: retired }, null, 2));
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
