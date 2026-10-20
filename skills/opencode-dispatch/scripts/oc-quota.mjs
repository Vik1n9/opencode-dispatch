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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { blockedUntil, loadLimits } from './lib.mjs';

const DIR = process.env.OC_TOKENBAR_DIR || join(homedir(), 'Library', 'Application Support', 'TokenBar');
const APPLE_EPOCH = Date.UTC(2001, 0, 1); // Swift Date reference point (used by the ledger)
const STALE_MIN = 60;      // older than 60 minutes = not trustworthy
const DEEPSEEK_LOW_USD = 1; // warn below this balance
const QWEN_LOW_PCT = 10;    // warn below this percentage left

const toDate = (at) => typeof at === 'number' ? new Date(APPLE_EPOCH + at * 1000) : new Date(at);
const ageMin = (d) => Math.round((Date.now() - d.getTime()) / 60000);
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
    const age = ageMin(at);
    const low = cur === 'USD' ? s.total < DEEPSEEK_LOW_USD : false;
    out.push({ provider: 'deepseek', unit: cur, remaining: s.total, sampledAt: at.toISOString(), ageMin: age, source,
      verdict: age > STALE_MIN ? 'stale' : low ? 'low' : 'ok' });
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
    const at = q.at ? new Date(q.at) : null;
    const age = at ? ageMin(at) : null;
    out.push({ provider: 'qwen-token-plan', unit: '%', remaining: q.percentLeft,
      resetsAt: q.resetsAt ?? q.windows?.[0]?.resetsAt ?? null,
      sampledAt: at?.toISOString() ?? null, ageMin: age,
      verdict: age === null || age > STALE_MIN ? 'stale' : q.percentLeft < QWEN_LOW_PCT ? 'low' : 'ok' });
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
    const when = o.sampledAt ? `(${o.ageMin} min ago${o.resetsAt ? `, resets ${o.resetsAt.slice(0, 10)}` : ''})` : '';
    console.log(`${o.provider.padEnd(16)} ${o.verdict.padEnd(8)} ${amt} ${when} ${o.note ?? ''}`.trimEnd());
  }
  // Models blocked in limits.json (written by oc-run.mjs on a rate limit / quota error). Expired entries
  // are not shown: the model is usable again.
  const limits = loadLimits();
  const now = new Date();
  for (const [id, limit] of Object.entries(limits)) {
    if (!blockedUntil(id, now, limits)) continue;
    if (limit.source === 'no-reset' || !limit.until) {
      console.log(`limited  ${id}  needs owner action (${limit.message ?? ''})`);
    } else {
      console.log(`limited  ${id}  until ${new Date(limit.until).toLocaleString()} (${limit.source}, hits ${limit.hits ?? 1})`);
    }
  }
}
