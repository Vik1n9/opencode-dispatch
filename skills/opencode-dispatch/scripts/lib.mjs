// Shared plumbing for the dispatch scripts. No CLI of its own.
//
// Data folder: $OC_DISPATCH_HOME, else ~/.config/opencode-dispatch. Every data file is read/written there:
//   benchmarks.json  curated, version-controlled table (install.sh links it to the repo's config/benchmarks.json)
//   track.jsonl      raw dispatch history, one JSON record per line (append only)
//   internal.json    derived scores, rebuilt from track.jsonl by oc-track.mjs (never hand-edited)
//   limits.json      rate-limit / quota state, written by oc-run.mjs and read by oc-rank / oc-quota
//
// Inventory cache: $OC_DISPATCH_CACHE, else ~/.cache/opencode-dispatch/inventory.json (see CACHE).
//
// keyOf() resolves an opencode model ID (an alias) to its key in benchmarks.json; plan() derives the
// billing plan from the provider prefix.
//
// VERSION comes from ../VERSION (the skill folder install.sh links into place); every script calls
// exitIfVersion() first, so `<script> --version` shows which version runs locally.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DIR = process.env.OC_DISPATCH_HOME || join(homedir(), '.config', 'opencode-dispatch');
export const BENCHMARKS = join(DIR, 'benchmarks.json');
export const TRACK = join(DIR, 'track.jsonl');
export const INTERNAL = join(DIR, 'internal.json');
export const LIMITS = join(DIR, 'limits.json');
export const VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();

export function exitIfVersion() {
  if (!process.argv.includes('--version')) return;
  console.log(`opencode-dispatch ${VERSION}`);
  process.exit(0);
}

export const CACHE = process.env.OC_DISPATCH_CACHE || join(homedir(), '.cache', 'opencode-dispatch', 'inventory.json');
// How long a probed inventory stays valid: oc-models skips probing below it, oc-rank warns above it.
export const CACHE_MAX_AGE_H = 12;

export function loadBenchmarks() {
  return JSON.parse(readFileSync(BENCHMARKS, 'utf8'));
}

// Derived file: absent until the first add / recompute.
export function loadInternal() {
  return existsSync(INTERNAL) ? JSON.parse(readFileSync(INTERNAL, 'utf8')) : { models: {} };
}

// Written by another script (rate-limit / quota detector): { '<model id>': { until, source, message, hits, at } }.
export function loadLimits() {
  return existsSync(LIMITS) ? JSON.parse(readFileSync(LIMITS, 'utf8')) : {};
}

export function keyOf(idOrKey, table = loadBenchmarks()) {
  const models = table.models || {};
  if (models[idOrKey]) return idOrKey;
  for (const [k, m] of Object.entries(models)) if ((m.aliases || []).includes(idOrKey)) return k;
  return null;
}

export function plan(id) {
  return id.startsWith('bailian-token-plan-personal/') ? 'token'
    : id.startsWith('opencode/') ? 'free'
    : id.startsWith('opencode-go/') ? 'go'
    : 'paid';
}

// A "no-reset" limit has no until time: blocked until the owner acts (e.g. tops up). Return a far-future
// Date so callers can treat every truthy result the same way; the source says why.
const NO_RESET = new Date(8640000000000000);

// The Date a model stays blocked until, or null when it is not blocked. `until` in the past means the
// limit expired and the model is usable again. Callers that already loaded limits.json pass `limits` so
// the file is not read again.
export function blockedUntil(id, now = new Date(), limits = loadLimits()) {
  const limit = limits[id];
  if (!limit) return null;
  if (limit.source === 'no-reset') return NO_RESET;
  if (!limit.until) return null;
  const until = new Date(limit.until);
  return Number.isNaN(until.getTime()) || until <= now ? null : until;
}

/* ---------- Limit detection, reset estimation, limits.json ---------- */

// Error text that means "stop until the allowance comes back" rather than "the model cannot do the task".
// The vendors do not document their wording, so this errs on the side of matching.
export const LIMIT_RE = /rate[ _-]?limit|too many requests|\b429\b|quota|usage[ _-]?limit|limit[ _-]?(?:reached|exceeded)|exceeded your|insufficient (?:balance|credits?|funds)|resource[ _-]?exhausted|credit balance/i;

const future = (d, now) => (d instanceof Date && !Number.isNaN(d.getTime()) && d > now ? d : null);
const UNIT_MS = { h: 3600e3, m: 60e3, s: 1e3 };

// Pull a reset time out of an error message: Retry-After / retry_after seconds, "try again in 1h 2m 3s",
// "in 45 minutes", "resets at <ISO>", or "reset": <unix seconds | unix ms>. Returns null when nothing
// parses or the result is not in the future.
export function parseReset(message, now = new Date()) {
  if (typeof message !== 'string' || !message) return null;

  // 120 seconds: Retry-After: 120 / retry after 120 seconds / "retry_after": 120
  let m = message.match(/retry[-_ ]?after["']?\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (m) return future(new Date(now.getTime() + Number(m[1]) * 1000), now);

  // Relative durations: "try again in 1h 2m 3s", "in 45 minutes", "in 30s"
  m = message.match(/\bin\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i);
  if (m) {
    let ms = 0;
    for (const part of m[1].matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi)) {
      ms += Number(part[1]) * UNIT_MS[part[2][0].toLowerCase()];
    }
    if (ms > 0) return future(new Date(now.getTime() + ms), now);
  }

  // Unix reset: "reset": 1761091200 (seconds) or 1761091200000 (milliseconds)
  m = message.match(/"?(?:resets?|reset)"?\s*[:=]\s*(\d{9,13})/i);
  if (m) {
    const n = Number(m[1]);
    return future(new Date(n >= 1e12 ? n : n * 1000), now);
  }

  // ISO time after the word reset: "resets at 2026-10-21T12:00:00Z", "reset at …"
  m = message.match(/(?:resets?|reset)\b[\s\S]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (m) return future(new Date(m[1]), now);

  return null;
}

const TOKENBAR_STATUS = () => process.env.OC_TOKENBAR_STATUS
  || join(homedir(), 'Library', 'Application Support', 'TokenBar', 'status.json');

// TokenBar exports times either as ISO strings or as epoch numbers (seconds or milliseconds).
const toDate = (v) => {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v >= 1e12 ? v : v * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Ladder by consecutive hits (1, 2, 3+); the vendors do not document their windows, these are estimates.
const LADDERS = {
  free: [15 * 60e3, 3600e3, 5 * 3600e3],   // Zen free: 15 min, 1 h, 5 h
  go: [3600e3, 5 * 3600e3, 24 * 3600e3],   // Go: 1 h, 5 h, 24 h
  paid: [60e3, 15 * 60e3, 3600e3],         // pay-as-you-go: 1 min, 15 min, 1 h
};
const ladder = (name, hits, now) => {
  const steps = LADDERS[name];
  const i = Math.min(steps.length - 1, Math.max(0, (Number(hits) || 1) - 1));
  return { until: new Date(now.getTime() + steps[i]), source: 'estimate' };
};

// Estimate when a limited model becomes usable again. The Qwen token plan resets when TokenBar says so
// (earliest exhausted window in the future); without that, fall back to the Go ladder. An empty paid
// balance never resets by itself — the owner has to top up.
export function estimateReset(id, hits, now = new Date(), message = '') {
  const p = plan(id);
  if (p === 'paid' && /insufficient (?:balance|credits?|funds)|credit balance/i.test(message)) {
    return { until: null, source: 'no-reset' };
  }
  if (p === 'token') {
    try {
      const st = JSON.parse(readFileSync(TOKENBAR_STATUS(), 'utf8'));
      const q = st.qwen || st.qwenTokenPlan;
      const times = (q?.windows || [])
        .filter((w) => typeof w.percentLeft === 'number' && w.percentLeft <= 0)
        .map((w) => toDate(w.resetsAt))
        .filter((d) => d && d > now);
      if (times.length) return { until: new Date(Math.min(...times.map((d) => d.getTime()))), source: 'estimate' };
    } catch { /* no TokenBar status: use the Go ladder */ }
    return ladder('go', hits, now);
  }
  if (p === 'free' || p === 'go') return ladder(p, hits, now);
  return ladder('paid', hits, now);
}

// Write one entry into limits.json. Consecutive hits (within 24 h) climb the reset ladder; a hit after a
// longer gap starts over at 1. `until` is stored as ISO or null; the message is capped at 200 chars.
export function recordLimit(id, { until = null, source = 'estimate', message = '' } = {}, now = new Date()) {
  const limits = loadLimits();
  const prev = limits[id];
  const prevAt = prev?.at ? new Date(prev.at) : null;
  const recent = prevAt && !Number.isNaN(prevAt.getTime()) && now.getTime() - prevAt.getTime() <= 24 * 3600e3;
  const entry = {
    until: until instanceof Date ? until.toISOString() : until ?? null,
    source,
    message: String(message ?? '').slice(0, 200),
    hits: recent ? (Number(prev.hits) || 0) + 1 : 1,
    at: now.toISOString(),
  };
  limits[id] = entry;
  mkdirSync(dirname(LIMITS), { recursive: true });
  writeFileSync(LIMITS, JSON.stringify(limits, null, 2) + '\n');
  return entry;
}

// Remove a model's entry. No-op when absent; nothing else in the file changes.
export function clearLimit(id) {
  if (!existsSync(LIMITS)) return;
  const limits = loadLimits();
  if (!Object.hasOwn(limits, id)) return;
  delete limits[id];
  writeFileSync(LIMITS, JSON.stringify(limits, null, 2) + '\n');
}

// Inventory models worth probing by default: everything the benchmark table knows (its IDs are aliases),
// plus official Zen free models that are not in the table yet. Probes cost one model session each, so
// models that cannot be ranked (no benchmarks, not free) are not probed.
export function probeTargets(models, table = loadBenchmarks()) {
  const aliases = new Set();
  for (const entry of Object.values(table.models || {})) for (const a of entry.aliases || []) aliases.add(a);
  return models.filter((m) => m?.id && (aliases.has(m.id)
    || (m.id.startsWith('opencode/') && m.cost === 'free' && m.live !== false)));
}
