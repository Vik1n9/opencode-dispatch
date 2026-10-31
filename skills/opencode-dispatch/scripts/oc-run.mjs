#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfVersion, LIMIT_RE, estimateReset, parseReset, CACHE, blockedUntil } from './lib.mjs';
import { checkEnvironment, cloudSignal } from './oc-check.mjs';
import { recordHit, recordSuccess, readLimits } from './oc-limits.mjs';
import { rankCandidates } from './oc-rank.mjs';
import { allowance } from './oc-quota.mjs';

exitIfVersion();

// Set once the log exists; a fail() after that also marks the status file done, so oc-watch shows the error.
let status = null;

const argv = process.argv.slice(2);
const opts = { fork: false, agent: 'build', dir: process.cwd(), stall: '10', rex: true };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) fail(`${a} needs a value`);
    return argv[++i];
  };
  if (a === '--') {
    words.push(...argv.slice(i + 1));
    break;
  } else if (a === '--model' || a === '-m') opts.model = next();
  else if (a === '--agent') opts.agent = next();
  else if (a === '--dir') opts.dir = resolve(next());
  else if (a === '--session' || a === '-s') opts.session = next();
  else if (a === '--fork') opts.fork = true;
  else if (a === '--title') opts.title = next();
  else if (a === '--log') opts.log = resolve(next());
  else if (a === '--stall') opts.stall = next();
  else if (a === '--fallback') opts.fallback = next();
  else if (a === '--task') opts.task = next();
  else if (a === '--cache') opts.cache = resolve(next());
  else if (a === '--no-rex') opts.rex = false;
  else if (a === '--prompt-file') {
    const file = next();
    try { opts.prompt = readFileSync(file, 'utf8'); }
    catch (e) { fail(`cannot read --prompt-file ${file}: ${e.message}`); }
  } else if (a.startsWith('-')) fail(`unknown option: ${a}`);
  else words.push(a);
}
if (!opts.prompt) opts.prompt = words.join(' ');

function fail(msg) {
  if (status) {
    writeStatus({ state: 'done', summary: {
      ok: false, exitCode: 2, error: msg, errors: [msg], model: status.model, sessionID: null,
      seconds: Math.round(process.uptime() * 10) / 10, steps: 0, cost: 0, handoffs: status.handoffs,
    } });
  }
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(2);
}
if (!opts.model) fail('--model is required (provider/model, see `opencode models`); the opencode default is unpredictable');
if (!opts.prompt.trim()) fail('empty prompt');
if (opts.fork && !opts.session) fail('--fork needs --session');
if (opts.agent !== 'build' && opts.agent !== 'plan') fail(`unknown agent: ${opts.agent} (expected build or plan)`);
if (!/^\d+$/.test(opts.stall)) fail('--stall must be a non-negative integer');
if (opts.fallback) {
  if (opts.fallback === 'default') {
    if (!opts.task) fail('--fallback default requires --task');
  } else {
    const parts = opts.fallback.split(',');
    if (parts.some((p) => p.trim() === '')) fail('empty fallback entry');
  }
}
const cloud = cloudSignal();
if (cloud) fail(cloud);
const envCheck = checkEnvironment();
if (!envCheck.ok) console.error(`warning: ${envCheck.error}`);
readLimits();

try {
  if (!opts.log) {
    const dir = join(tmpdir(), 'oc-run');
    mkdirSync(dir, { recursive: true });
    opts.log = join(dir, `${Date.now()}-${process.pid}.jsonl`);
  }
  mkdirSync(dirname(opts.log), { recursive: true });
  writeFileSync(opts.log, '');
} catch (e) {
  fail(`cannot open log file: ${e.message}`);
}

// <log>.status.json lets oc-watch.mjs follow the run: model per segment, handoffs, final summary.
// `base` (HEAD at start) and `dirty` (uncommitted changes at start) let it tell what the run changed.
const statusFile = `${opts.log}.status.json`;
status = {
  state: 'running', pid: process.pid, title: opts.title ?? null, model: opts.model, agent: opts.agent,
  dir: opts.dir, base: null, dirty: false, segment: 0, handoffs: [], summary: null,
};
try {
  const head = spawnSync('git', ['-C', opts.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  if (head.status === 0) {
    status.base = head.stdout.trim();
    const st = spawnSync('git', ['-C', opts.dir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
    status.dirty = st.status === 0 && st.stdout.trim() !== '';
  }
} catch {}
function writeStatus(patch) {
  Object.assign(status, patch);
  try {
    writeFileSync(`${statusFile}.tmp`, JSON.stringify(status, null, 2));
    renameSync(`${statusFile}.tmp`, statusFile);
  } catch {}
}
writeStatus({});

// Inside Rex (REX_SESSION set), open a background tab running oc-watch.mjs on this run's log, so the user
// and Claude can watch progress and the final diff there (`rex capture -s <session> -b <block>`). The tab's
// ids go to stderr right away (a background caller sees them before the summary) and to summary.rex.
// A missing, failing or slow (> 5 s) `rex` never stops the run; the reason goes to summary.rex.error.
let rex = null;
if (opts.rex && process.env.REX_SESSION) {
  const label = `oc ${opts.title ?? opts.model.split('/').pop()}`;
  const watcher = fileURLToPath(new URL('./oc-watch.mjs', import.meta.url));
  const r = spawnSync('rex', ['window', 'new', '-s', process.env.REX_SESSION, label, '-c', opts.dir,
    '--keep-open', '--focus=false', '--shell=none', '--json', '--', process.execPath, watcher, opts.log],
  { encoding: 'utf8', timeout: 5000 });
  try {
    if (r.error?.code === 'ETIMEDOUT') {
      throw new Error(`rex timed out after 5 s; the tab may exist without ids (rex window ls, label "${label}")`);
    }
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300));
    const out = JSON.parse(r.stdout);
    rex = { session: process.env.REX_SESSION, window: out.window_id ?? null, block: out.block_ids?.[0] ?? null };
    console.error(`oc-run: rex tab "${label}" window ${rex.window} block ${rex.block}`);
  } catch (e) {
    rex = { error: `rex tab not opened: ${e.message}` };
  }
}

const LIMIT_TEXT = /freeusagelimiterror|rate limit exceeded/i;
const LIMIT_EVENT = /"status"\s*:\s*429\b|"type"\s*:\s*"provider\.quota"/;
function rateLimit(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const hit = LIMIT_TEXT.test(raw) || LIMIT_EVENT.test(raw) || value?.type === 'provider.quota' || value?.status === 429;
  if (!hit) return null;
  let o = value;
  if (typeof value === 'string') {
    try { o = JSON.parse(value); } catch { o = null; }
  }
  const e = o?.error && typeof o.error === 'object' ? o.error : (o ?? {});
  const message = e.message ?? (typeof value === 'string' ? value : raw);
  return { type: String(e.type ?? e.status ?? 'rate limit'), message: String(message).slice(0, 200) };
}

function isLimitEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'error') {
    const msg = ev.error?.message ?? ev.message ?? JSON.stringify(ev.error ?? ev);
    if (LIMIT_RE.test(String(msg))) return true;
    return rateLimit(ev.error ?? ev) !== null;
  }
  const p = ev.part ?? {};
  if (ev.type === 'tool_use' && p.state?.status === 'error') {
    const msg = p.state?.error ?? '';
    if (LIMIT_RE.test(String(msg))) return true;
    return rateLimit(p.state?.error) !== null;
  }
  return false;
}

const stallMinutes = Number(opts.stall);
const stallThresholdMs = process.env.OC_RUN_STALL_MS ? Number(process.env.OC_RUN_STALL_MS) : stallMinutes * 60000;

let intIgnoredFlag = false;
let activeChild = null;
let activeTriggerStop = null;

process.on('SIGINT', () => { intIgnoredFlag = true; });
process.on('SIGTERM', () => { if (activeTriggerStop) activeTriggerStop(); });
process.on('SIGHUP', () => { if (activeTriggerStop) activeTriggerStop(); });
process.on('exit', () => { if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {} } });

function buildSummary(model, code, stdout, stderr, started, sessionID, stoppedBy, logErr, stalledFlag) {
  const summary = {
    ok: code === 0 && !stoppedBy,
    exitCode: code,
    sessionID: sessionID ?? null,
    rateLimited: false,
    limit: null,
    title: opts.title ?? null,
    agent: opts.agent,
    model,
    dir: opts.dir,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    text: '',
    tools: [],
    steps: 0,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    errors: [],
    log: opts.log,
  };
  const texts = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    summary.sessionID ??= ev.sessionID ?? null;
    const p = ev.part ?? {};
    if (ev.type === 'text' && p.text) texts.push(p.text);
    else if (ev.type === 'tool_use') {
      const input = p.state?.input ?? {};
      const brief = input.command ?? input.filePath ?? input.path ?? input.pattern ?? '';
      summary.tools.push(`${p.tool}:${p.state?.status ?? '?'}${brief ? ' ' + String(brief).slice(0, 120) : ''}`);
      if (p.state?.status === 'error') {
        summary.errors.push(String(p.state?.error ?? '').slice(0, 300));
        summary.limit ??= rateLimit(p.state?.error);
      }
    } else if (ev.type === 'step_finish') {
      summary.steps++;
      summary.cost += p.cost ?? 0;
      for (const k of ['input', 'output', 'reasoning']) summary.tokens[k] += p.tokens?.[k] ?? 0;
    } else if (ev.type === 'error') {
      summary.errors.push(JSON.stringify(ev.error ?? ev).slice(0, 300));
      summary.limit ??= rateLimit(ev.error ?? ev);
    }
  }
  summary.text = texts.at(-1) ?? '';
  summary.cost = Math.round(summary.cost * 1e6) / 1e6;
  if (stderr.trim()) {
    summary.errors.push(`stderr: ${stderr.trim().slice(0, 500)}`);
    summary.limit ??= rateLimit(stderr.trim());
  }
  if (summary.limit) {
    summary.rateLimited = true;
    summary.ok = false;
  }
  if (logErr) summary.errors.push(`log write failed: ${logErr.message}`);
  if (stoppedBy) summary.errors.push(`stopped by ${stoppedBy}`);
  if (code === 0 && !summary.sessionID) summary.ok = false;
  if (!summary.sessionID && sessionID) summary.sessionID = sessionID;
  if (stalledFlag) summary.stalled = { minutes: stallMinutes };
  return summary;
}

async function runSegment(model, prompt, session, isFirst) {
  const segStarted = Date.now();
  const args = ['run', '--format', 'json', '-m', model, '--agent', opts.agent];
  if (session) args.push('-s', session);
  if (isFirst && opts.fork) args.push('--fork');
  if (isFirst && opts.title) args.push('--title', opts.title);
  args.push(prompt);

  const child = spawn('opencode', args, {
    cwd: opts.dir,
    env: { ...process.env, PWD: opts.dir },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  activeChild = child;

  let stdout = '';
  let stderr = '';
  let closed = false;
  let stoppedBy = null;
  let liveLimit = false;
  let stalled = false;
  let lastEvent = Date.now();
  let sessionID = session;
  let killTimer = null;
  let stallTimer = null;
  let lineBuf = '';
  let logErr = null;

  const killGroup = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch {}
  };
  const triggerStop = () => {
    if (closed || stoppedBy) return;
    stoppedBy = 'SIGTERM';
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
  };
  activeTriggerStop = triggerStop;

  const exitPromise = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? (signal ? 1 : 0), signal });
    });
  });

  child.stdout.on('data', (d) => {
    stdout += d;
    lastEvent = Date.now();
    if (!logErr) { try { appendFileSync(opts.log, d); } catch (e) { logErr = e; } }
    lineBuf += d.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      lastEvent = Date.now();
      if (ev.sessionID) sessionID = ev.sessionID;
      if (isLimitEvent(ev)) { liveLimit = true; triggerStop(); }
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (LIMIT_RE.test(d.toString())) { liveLimit = true; triggerStop(); }
  });
  child.on('error', (e) => {
    if (!closed) killGroup('SIGTERM');
    fail(`cannot start opencode: ${e.message}`);
  });

  if (stallMinutes > 0 && stallThresholdMs > 0) {
    stallTimer = setInterval(() => {
      if (closed || liveLimit || stalled || stoppedBy) return;
      if (Date.now() - lastEvent >= stallThresholdMs) {
        stalled = true;
        triggerStop();
      }
    }, 50);
  }

  const { code } = await exitPromise;
  if (stallTimer) clearInterval(stallTimer);
  if (killTimer) clearTimeout(killTimer);

  const summary = buildSummary(model, code, stdout, stderr, segStarted, sessionID, stoppedBy, logErr, stalled);
  try {
    const limitText = [...summary.errors, stderr].join('\n');
    const limited = LIMIT_RE.test(limitText);
    let limitNow = null;
    if (limited) {
      limitNow = new Date();
      const prev = readLimits()[model];
      const prevAt = prev?.at ? new Date(prev.at).getTime() : NaN;
      const hits = Number.isNaN(prevAt) || limitNow.getTime() - prevAt > 24 * 3600e3 ? 1 : (Number(prev.hits) || 0) + 1;
      const parsed = parseReset(limitText, limitNow);
      const est = parsed ? { until: parsed, source: 'message' } : estimateReset(model, hits, limitNow, limitText);
      summary.limited = {
        until: est.until ? est.until.toISOString() : null,
        source: est.source,
        message: limitText.trim(),
      };
      summary.ok = false;
      summary.rateLimited = summary.rateLimited || true;
    }
    if (summary.limited) {
      recordHit(model, summary.limit?.message || summary.limited.message, limitNow,
        { until: summary.limited.until, source: summary.limited.source });
    } else if (summary.rateLimited) {
      recordHit(model, summary.limit?.message || 'rate limited');
    } else if (summary.ok) {
      recordSuccess(model);
    }
  } catch (e) {
    summary.errors.push(`limits write failed: ${e.message}`);
  }
  if (logErr) summary.errors.push(`log write failed: ${logErr.message}`);
  if (stalled) summary.stalled = { minutes: stallMinutes };

  activeTriggerStop = null;
  activeChild = null;
  return { summary, sessionID, ok: summary.ok, stalled, liveLimit, limited: summary.limited, rateLimited: summary.rateLimited };
}

const warnings = [];
function resolveCandidates(reason, failedModel) {
  let ids = [];
  if (opts.fallback === 'default') {
    try {
      const cachePath = opts.cache || CACHE;
      const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
      ids = rankCandidates(cache, opts.task, {});
    } catch (e) {
      ids = [];
    }
  } else if (opts.fallback) {
    ids = opts.fallback.split(',').map((s) => s.trim());
  } else {
    return [];
  }
  ids = ids.filter((id) => id !== failedModel);
  if (opts.fallback === 'default' && reason === 'limit') {
    let prefix = null;
    if (failedModel.startsWith('opencode-go/')) prefix = 'opencode-go/';
    else if (failedModel.startsWith('bailian-token-plan-personal/')) prefix = 'bailian-token-plan-personal/';
    else if (failedModel.startsWith('deepseek/')) prefix = 'deepseek/';
    if (prefix) ids = ids.filter((id) => !id.startsWith(prefix));
  }
  const filtered = [];
  for (const id of ids) {
    let blocked = null;
    try { blocked = blockedUntil(id); } catch {}
    if (blocked) continue;
    const a = allowance(id);
    if (!a.allowed) continue;
    if (a.warning) warnings.push(a.warning);
    filtered.push(id);
  }
  return filtered;
}

let currentModel = opts.model;
let currentSession = opts.session;
let currentPrompt = opts.prompt;
let isFirst = true;
let handoffs = [];
let segments = [];
let totalSeconds = 0;
let totalSteps = 0;
let totalCost = 0;
let totalTokens = { input: 0, output: 0, reasoning: 0 };
let allTools = [];
let allErrors = [];
let finalOk = false;
let finalExitCode = 1;
let finalModel = currentModel;
let finalLimited = null;
let finalStalled = null;
let finalRateLimited = false;
let finalLimit = null;
let finalText = '';
let finalSession = currentSession;

while (true) {
  writeStatus({ model: currentModel, segment: segments.length + 1, handoffs });
  const segResult = await runSegment(currentModel, currentPrompt, currentSession, isFirst);
  isFirst = false;
  const seg = segResult.summary;
  segments.push(seg);
  totalSeconds = Math.round((totalSeconds + (seg.seconds || 0)) * 10) / 10;
  totalSteps += seg.steps || 0;
  totalCost += seg.cost || 0;
  for (const k of ['input', 'output', 'reasoning']) totalTokens[k] += seg.tokens?.[k] ?? 0;
  allTools = allTools.concat(seg.tools || []);
  allErrors = allErrors.concat(seg.errors || []);
  finalText = seg.text || finalText;
  finalSession = seg.sessionID || finalSession;
  finalModel = currentModel;
  finalRateLimited = !!seg.rateLimited;
  finalLimit = seg.limit;
  if (seg.limited) finalLimited = seg.limited;
  if (seg.stalled) finalStalled = seg.stalled;

  if (seg.ok) {
    finalOk = true;
    finalExitCode = 0;
    break;
  }

  const reason = seg.stalled ? 'stall' : (seg.limited || seg.rateLimited) ? 'limit' : null;
  if (!reason) {
    finalOk = false;
    finalExitCode = seg.exitCode || 1;
    break;
  }

  const candidates = resolveCandidates(reason, currentModel);
  if (!candidates.length) {
    finalOk = false;
    finalExitCode = 1;
    break;
  }
  const next = candidates[0];
  const whyText = reason === 'limit' ? 'hit a usage limit' : `stalled for ${stallMinutes} minutes`;
  const message = `The previous model (${currentModel}) ${whyText}. Continue from the existing changes in this folder; do not start over. Original task follows: ${opts.prompt}`;
  handoffs.push({ from: currentModel, to: next, reason, at: new Date().toISOString(), message });
  currentModel = next;
  currentSession = finalSession;
  currentPrompt = message;
}

const summary = {
  ok: finalOk,
  exitCode: finalExitCode,
  sessionID: finalSession ?? null,
  rateLimited: finalRateLimited,
  limit: finalLimit,
  title: opts.title ?? null,
  agent: opts.agent,
  model: finalModel,
  dir: opts.dir,
  seconds: totalSeconds,
  text: finalText,
  tools: allTools,
  steps: totalSteps,
  cost: Math.round(totalCost * 1e6) / 1e6,
  tokens: totalTokens,
  errors: allErrors,
  log: opts.log,
  handoffs,
  segments,
  warnings,
};
if (finalLimited) summary.limited = finalLimited;
if (finalStalled) summary.stalled = finalStalled;
if (intIgnoredFlag) summary.errors.push('ignored SIGINT');
if (rex) summary.rex = rex;
writeStatus({ state: 'done', model: finalModel, handoffs, summary });
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
