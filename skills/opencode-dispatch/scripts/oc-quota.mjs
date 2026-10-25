#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfVersion, blockedUntil, loadLimits } from './lib.mjs';

exitIfVersion();

const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const STALE_MIN = 60;
const FUTURE_MIN = 5;
const DEEPSEEK_LOW_USD = 1;
const QWEN_LOW_PCT = 10;

const toDate = (at) => {
  if (at === undefined || at === null || at === '') return null;
  const d = typeof at === 'number' ? new Date(APPLE_EPOCH + at * 1000) : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
};
const ageMin = (d) => Math.round((Date.now() - d.getTime()) / 60000);
const staleOf = (age) => age === null || age > STALE_MIN || age < -FUTURE_MIN;
const timeNotes = (age) => age === null ? ['no sample time'] : age < -FUTURE_MIN ? ['sample time is in the future'] : [];
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function tokenbarDir() {
  return process.env.OC_TOKENBAR_DIR || join(homedir(), 'Library', 'Application Support', 'TokenBar');
}

function readStatus() {
  const dir = tokenbarDir();
  const status = join(dir, 'status.json');
  let st = null, stError = null;
  if (existsSync(status)) {
    try { st = JSON.parse(readFileSync(status, 'utf8')); } catch { stError = 'status.json is malformed'; }
  } else {
    stError = 'TokenBar status.json not found (TokenBar not running, or a build without the export)';
  }
  return { dir, st, stError };
}

export function allowance(modelId) {
  const { dir, st } = readStatus();
  if (modelId.startsWith('deepseek/')) {
    let verdict = 'unknown';
    if (st?.deepseek && Object.keys(st.deepseek).length) {
      const s = st.deepseek.USD;
      if (s) {
        const at = toDate(s.at);
        const age = at ? ageMin(at) : null;
        const low = typeof s.total === 'number' && s.total < DEEPSEEK_LOW_USD;
        verdict = low ? 'low' : staleOf(age) ? 'stale' : 'ok';
      }
    } else {
      try {
        const ledger = JSON.parse(readFileSync(join(dir, 'deepseek-ledger.json'), 'utf8'));
        const s = ledger.lastSamples?.USD;
        if (s) {
          const at = toDate(s.at);
          const age = at ? ageMin(at) : null;
          const low = typeof s.total === 'number' && s.total < DEEPSEEK_LOW_USD;
          verdict = low ? 'low' : staleOf(age) ? 'stale' : 'ok';
        }
      } catch {}
    }
    const allowed = verdict !== 'low';
    const warning = (verdict === 'unknown' || verdict === 'stale') ? `deepseek allowance ${verdict}` : null;
    return { allowed, verdict, warning, provider: 'deepseek' };
  }
  if (modelId.startsWith('bailian-token-plan-personal/')) {
    let verdict = 'unknown';
    if (st) {
      const q = st.qwen || st.qwenTokenPlan || null;
      if (q && typeof q.percentLeft === 'number') {
        const at = toDate(q.at);
        const age = at ? ageMin(at) : null;
        verdict = q.percentLeft < QWEN_LOW_PCT ? 'low' : staleOf(age) ? 'stale' : 'ok';
      }
    }
    const allowed = verdict !== 'low';
    const warning = (verdict === 'unknown' || verdict === 'stale') ? `qwen-token-plan allowance ${verdict}` : null;
    return { allowed, verdict, warning, provider: 'qwen-token-plan' };
  }
  return { allowed: true, verdict: 'ok', warning: null, provider: modelId.split('/')[0] };
}

export const checkAllowance = allowance;
export const modelAllowance = allowance;
export const quotaCheck = allowance;
export const isAllowed = (id) => allowance(id).allowed;
export const allowances = allowance;

function main() {
  const DIR = tokenbarDir();
  const out = [];
  let st = null, stError = null;
  const status = join(DIR, 'status.json');
  if (existsSync(status)) {
    try { st = JSON.parse(readFileSync(status, 'utf8')); } catch { stError = 'status.json is malformed'; }
  } else {
    stError = 'TokenBar status.json not found (TokenBar not running, or a build without the export)';
  }

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
      const staleMark = o.stale && o.verdict === 'low' && o.sampledAt ? '(stale)' : '';
      console.log([o.provider.padEnd(16), o.verdict.padEnd(8), amt, when, staleMark, o.note ?? ''].filter(Boolean).join(' '));
    }
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
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
