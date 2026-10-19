#!/usr/bin/env node
// Per-model pauses for the Zen free usage limit. OpenCode does not expose the reset time, so the only
// way to learn that a model works again is to try it: each hit is recorded and re-probed on a backoff.
// The limit applies per model id; a success clears that model's entry.
//
// File: ~/.config/opencode-dispatch/limits.json
//   { "models": { "<id>": { hitAt, message, probes, lastProbe, nextProbe } } }   (ISO timestamps)
//   nextProbe after the k-th failed probe = hitAt + [1h, 3h, 6h, 24h][k], then lastProbe + 24h.
//   A corrupt file is ignored with one stderr warning per process.
//
// Usage:
//   node oc-limits.mjs status [--json] [--now <iso>]   paused models, probes, next probe, DUE
//   node oc-limits.mjs clear <id>
//   --now is for tests only.
//
// Output (status): one line per paused model, or `no paused models`; --json prints { models } with a
// `due` flag per entry. Exit codes: 0 ok, 2 bad usage.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(homedir(), '.config', 'opencode-dispatch', 'limits.json');
const HOUR = 3_600_000;
const SCHEDULE = [1, 3, 6, 24]; // hours after hitAt, indexed by the number of failed probes

// Missing or unreadable file means no pauses; a corrupt file must not block dispatching, but say so once.
let warnedCorrupt = false;
const warnCorrupt = () => {
  if (warnedCorrupt) return;
  warnedCorrupt = true;
  console.error('limits.json is not valid JSON; ignoring it');
};

export function readLimits() {
  let text;
  try {
    text = readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') warnCorrupt();
    return { models: {} };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    warnCorrupt();
    return { models: {} };
  }
  if (data && data.models && typeof data.models === 'object' && !Array.isArray(data.models)) return { models: data.models };
  warnCorrupt();
  return { models: {} };
}

// Same folder: rename is atomic there, so a reader never sees a half-written file.
function writeLimits(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, FILE);
}

const iso = (date) => date.toISOString();
const asDate = (value, fallback) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
};

// A hit on a model already paused counts as a failed probe and moves nextProbe down the backoff.
export function recordHit(id, message, now = new Date()) {
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error(`invalid time: ${now}`);
  const data = readLimits();
  const prev = data.models[id];
  const msg = String(message ?? '').slice(0, 200);
  let entry;
  if (!prev) {
    entry = { hitAt: iso(at), message: msg, probes: 0, lastProbe: iso(at), nextProbe: iso(new Date(at.getTime() + SCHEDULE[0] * HOUR)) };
  } else {
    const probes = (Number.isFinite(prev.probes) ? prev.probes : 0) + 1;
    const hit = asDate(prev.hitAt, at);
    const next = probes < SCHEDULE.length
      ? new Date(hit.getTime() + SCHEDULE[probes] * HOUR)
      : new Date(at.getTime() + 24 * HOUR);
    entry = { hitAt: iso(hit), message: msg || prev.message || '', probes, lastProbe: iso(at), nextProbe: iso(next) };
  }
  data.models[id] = entry;
  writeLimits(data);
  return entry;
}

export function recordSuccess(id) {
  const data = readLimits();
  if (!(id in data.models)) return false;
  delete data.models[id];
  writeLimits(data);
  return true;
}

// Every recorded model is paused until a success clears it, even after nextProbe has passed.
export function paused(now = new Date()) {
  return new Map(Object.entries(readLimits().models));
}

export function due(now = new Date()) {
  const at = new Date(now).getTime();
  return Object.entries(readLimits().models)
    .filter(([, e]) => {
      const t = new Date(e.nextProbe).getTime();
      return Number.isFinite(t) && t <= at;
    })
    .map(([id]) => id);
}

/* ---------- CLI ---------- */
const USAGE = 'usage: oc-limits.mjs status [--json] [--now <iso>] | clear <id>';
const fail = (msg) => {
  console.error(msg);
  process.exit(2);
};
const pad = (n) => String(n).padStart(2, '0');
const local = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '?';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'status') {
    let json = false;
    let nowRaw = null;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--json') json = true;
      else if (argv[i] === '--now') {
        if (i + 1 >= argv.length) fail(USAGE);
        nowRaw = argv[++i];
      } else fail(`unknown option: ${argv[i]}\n${USAGE}`);
    }
    const now = nowRaw === null ? new Date() : new Date(nowRaw);
    if (Number.isNaN(now.getTime())) fail(`invalid --now: ${nowRaw}`);
    const entries = Object.entries(readLimits().models);
    const dueSet = new Set(due(now));
    if (json) {
      const models = {};
      for (const [id, e] of entries) models[id] = { ...e, due: dueSet.has(id) };
      console.log(JSON.stringify({ models }, null, 2));
    } else if (!entries.length) {
      console.log('no paused models');
    } else {
      for (const [id, e] of entries) {
        console.log(`${id}  hit ${local(e.hitAt)}  probes ${e.probes ?? 0}  next probe ${local(e.nextProbe)}${dueSet.has(id) ? '  DUE' : ''}`);
      }
    }
  } else if (cmd === 'clear') {
    if (argv.length !== 2) fail(USAGE);
    recordSuccess(argv[1]);
    console.log(`cleared ${argv[1]}`);
  } else {
    fail(USAGE);
  }
}
