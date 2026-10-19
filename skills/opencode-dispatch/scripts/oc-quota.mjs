#!/usr/bin/env node
// Check remaining allowance / balance before dispatching, from what the user's TokenBar app (menu bar)
// has already fetched. Read-only; never touches API keys.
//
//   ~/Library/Application Support/TokenBar/status.json (exported by TokenBar since 2026-10-19):
//     deepseek.<currency> = { total, granted, toppedUp, at }   current balance(s)
//     qwen = { percentLeft, at, windows: [{ label, percentLeft, resetsAt }] }   Qwen token plan
//   ~/Library/Application Support/TokenBar/deepseek-ledger.json: fallback for DeepSeek when status.json has
//     no deepseek entry (lastSamples per currency; keeps old currencies the account no longer uses)
//
// Usage: node oc-quota.mjs [--json]
// Prints each provider's remaining amount, when it was sampled, and a verdict (ok / low / unknown / stale).
// Precedence is low > stale > ok; `stale` is also a separate JSON field, so a low balance sampled long ago
// (or more than 5 minutes in the future, or with no usable time) stays `low` and text output adds `(stale)`.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'Library', 'Application Support', 'TokenBar');
const APPLE_EPOCH = Date.UTC(2001, 0, 1); // Swift Date reference point (used by the ledger)
const STALE_MIN = 60;       // older than 60 minutes = not trustworthy
const FUTURE_MIN = 5;       // sampled more than this far ahead = clock or data problem
const DEEPSEEK_LOW_USD = 1; // warn below this balance
const QWEN_LOW_PCT = 10;    // warn below this percentage left

// Missing / unparseable values are null, never an Invalid Date (which crashes toISOString()).
const toDate = (at) => {
  if (at === undefined || at === null || at === '') return null;
  const d = typeof at === 'number' ? new Date(APPLE_EPOCH + at * 1000) : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
};
const ageMin = (d) => Math.round((Date.now() - d.getTime()) / 60000);
// The reset day is what the user sees on the clock, so format it in local time (toISOString would
// shift it a day for e.g. 2026-11-02T00:00:00+08:00 on a UTC+8 machine).
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const staleOf = (age) => age === null || age > STALE_MIN || age < -FUTURE_MIN;
const timeNotes = (age) => age === null ? ['no sample time'] : age < -FUTURE_MIN ? ['sample time is in the future'] : [];
const out = [];

let st = null, stError = null;
const status = join(DIR, 'status.json');
if (existsSync(status)) {
  try { st = JSON.parse(readFileSync(status, 'utf8')); } catch { stError = 'status.json is malformed'; }
} else {
  stError = 'TokenBar status.json not found (TokenBar not running, or a build without the export)';
}

// DeepSeek: status.json holds TokenBar's current balance; fall back to the ledger only without it (the ledger keeps old samples of currencies the account no longer uses)
const deepseek = (samples, source) => {
  for (const [cur, s] of Object.entries(samples)) {
    const at = toDate(s.at);
    const age = at ? ageMin(at) : null;
    const low = cur === 'USD' && s.total < DEEPSEEK_LOW_USD;
    const notes = timeNotes(age);
    if (cur !== 'USD') notes.push('low threshold is defined for USD only');
    out.push({ provider: 'deepseek', unit: cur, remaining: s.total, sampledAt: at?.toISOString() ?? null, ageMin: age, source,
      stale: staleOf(age), verdict: low ? 'low' : staleOf(age) ? 'stale' : 'ok',
      ...(notes.length ? { note: notes.join('; ') } : {}) });
  }
};
if (st?.deepseek && Object.keys(st.deepseek).length) {
  deepseek(st.deepseek, 'status.json');
} else {
  try {
    deepseek(JSON.parse(readFileSync(join(DIR, 'deepseek-ledger.json'), 'utf8')).lastSamples || {}, 'deepseek-ledger.json');
  } catch {
    out.push({ provider: 'deepseek', verdict: 'unknown', note: 'cannot read TokenBar status.json or deepseek-ledger.json' });
  }
}

// Qwen token plan
if (st) {
  const q = st.qwen || st.qwenTokenPlan || null;
  if (q && typeof q.percentLeft === 'number') {
    const at = toDate(q.at);
    const age = at ? ageMin(at) : null;
    const resets = toDate(q.resetsAt ?? q.windows?.[0]?.resetsAt ?? null);
    const notes = timeNotes(age);
    out.push({ provider: 'qwen-token-plan', unit: '%', remaining: q.percentLeft,
      ...(resets ? { resetsAt: day(resets) } : {}),
      sampledAt: at?.toISOString() ?? null, ageMin: age,
      stale: staleOf(age), verdict: q.percentLeft < QWEN_LOW_PCT ? 'low' : staleOf(age) ? 'stale' : 'ok',
      ...(notes.length ? { note: notes.join('; ') } : {}) });
  } else {
    out.push({ provider: 'qwen-token-plan', verdict: 'unknown', note: 'status.json has no qwen.percentLeft' });
  }
} else {
  out.push({ provider: 'qwen-token-plan', verdict: 'unknown', note: `${stError}; ask the user to check the menu bar` });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const o of out) {
    const amt = o.remaining === undefined ? '' : o.unit === '%' ? `${o.remaining}% left` : `${o.unit} ${o.remaining}`;
    const when = o.sampledAt ? `(${o.ageMin} min ago${o.resetsAt ? `, resets ${o.resetsAt}` : ''})` : '';
    const staleMark = o.stale && o.verdict === 'low' && o.sampledAt ? '(stale)' : ''; // low wins, but old data is still flagged after the age
    console.log([o.provider.padEnd(16), o.verdict.padEnd(8), amt, when, staleMark, o.note ?? ''].filter(Boolean).join(' '));
  }
}
