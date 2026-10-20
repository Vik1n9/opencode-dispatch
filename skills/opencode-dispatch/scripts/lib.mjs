// Shared data-folder plumbing for oc-track.mjs and oc-rank.mjs. No CLI of its own.
//
// Data folder: $OC_DISPATCH_HOME, else ~/.config/opencode-dispatch. Every data file is read/written there:
//   benchmarks.json  curated, version-controlled table (install.sh links it to the repo's config/benchmarks.json)
//   track.jsonl      raw dispatch history, one JSON record per line (append only)
//   internal.json    derived scores, rebuilt from track.jsonl by oc-track.mjs (never hand-edited)
//   limits.json      rate-limit / quota state, written by a separate script and only read here
//
// keyOf() resolves an opencode model ID (an alias) to its key in benchmarks.json; plan() derives the
// billing plan from the provider prefix.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DIR = process.env.OC_DISPATCH_HOME || join(homedir(), '.config', 'opencode-dispatch');
export const BENCHMARKS = join(DIR, 'benchmarks.json');
export const TRACK = join(DIR, 'track.jsonl');
export const INTERNAL = join(DIR, 'internal.json');
export const LIMITS = join(DIR, 'limits.json');

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
// limit expired and the model is usable again.
export function blockedUntil(id, now = new Date()) {
  const limit = loadLimits()[id];
  if (!limit) return null;
  if (limit.source === 'no-reset') return NO_RESET;
  if (!limit.until) return null;
  const until = new Date(limit.until);
  return Number.isNaN(until.getTime()) || until <= now ? null : until;
}
