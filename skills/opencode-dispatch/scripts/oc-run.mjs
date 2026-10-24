#!/usr/bin/env node
// Run one opencode task non-interactively and print a compact summary.
// Wraps `opencode run --format json`, closing stdin (opencode waits on stdin
// forever when it is not a TTY) and saving the raw JSONL event log to a file.
// opencode runs in its own process group, so signals sent to the caller's group
// never reach it. oc-run ignores SIGINT; `kill <oc-run pid>` (SIGTERM) stops the
// run cleanly. The `trap '' INT` wrapper is no longer needed.
//
// Usage:
//   node oc-run.mjs --model <provider/model> [--agent build|plan] [--dir <path>]
//                   [--session <id>] [--fork] [--title <t>] [--log <file>]
//                   [--prompt-file <file> | <message...>]
//
// Prints JSON: { ok, exitCode, sessionID, rateLimited, limit, title, agent, model, dir, seconds,
//                text, tools[], steps, cost, tokens, errors[], log, limited? }
//   rateLimited is true when an error event, a failed tool or stderr shows a quota / rate-limit
//   failure (provider.quota, status 429, FreeUsageLimitError, "rate limit exceeded");
//   limit then holds { type, message } (message <= 200 chars), otherwise null. ok stays false.
//
// When the error text looks like a rate limit / quota ("rate limit", "429", "insufficient balance" …),
// the reset time is parsed from the message or estimated from the plan, the entry is written to
// limits.json (so oc-rank skips the model), and `limited: { until, source, message }` is added while
// ok stays false. The same hit also records the per-model re-probe pause (oc-limits.mjs backoff);
// a successful run clears the model's entry.
//
// Exit codes: 0 run ok, 1 run failed (summary.ok is false), 2 bad arguments or
// a cloud session / container. A missing or unsupported opencode only warns (oc-check.mjs reports it).

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exitIfVersion, LIMIT_RE, estimateReset, parseReset } from './lib.mjs';
import { checkEnvironment, cloudSignal } from './oc-check.mjs';
import { recordHit, recordSuccess, readLimits } from './oc-limits.mjs';

exitIfVersion();

const argv = process.argv.slice(2);
const opts = { fork: false, agent: 'build', dir: process.cwd() };
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
  else if (a === '--prompt-file') {
    const file = next();
    try { opts.prompt = readFileSync(file, 'utf8'); }
    catch (e) { fail(`cannot read --prompt-file ${file}: ${e.message}`); }
  } else if (a.startsWith('-')) fail(`unknown option: ${a}`);
  else words.push(a);
}
if (!opts.prompt) opts.prompt = words.join(' ');

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(2);
}
if (!opts.model) fail('--model is required (provider/model, see `opencode models`); the opencode default is unpredictable');
if (!opts.prompt.trim()) fail('empty prompt');
if (opts.fork && !opts.session) fail('--fork needs --session');
if (opts.agent !== 'build' && opts.agent !== 'plan') fail(`unknown agent: ${opts.agent} (expected build or plan)`);
// Local machine only: a cloud session or container is refused; a missing / unsupported opencode or a
// missing credential only warns — the run itself will fail with a clearer error, and install.sh fixes it.
const cloud = cloudSignal();
if (cloud) fail(cloud);
const envCheck = checkEnvironment();
if (!envCheck.ok) console.error(`warning: ${envCheck.error}`);
readLimits(); // surface a corrupt limits.json once, before the run records anything

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

const args = ['run', '--format', 'json', '-m', opts.model, '--agent', opts.agent];
if (opts.session) args.push('-s', opts.session);
if (opts.fork) args.push('--fork');
if (opts.title) args.push('--title', opts.title);
args.push(opts.prompt);

const LIMIT_TEXT = /freeusagelimiterror|rate limit exceeded/i;
const LIMIT_EVENT = /"status"\s*:\s*429\b|"type"\s*:\s*"provider\.quota"/;
// Return { type, message } for a quota / rate-limit failure, or null; value may be an event
// error object, a failed tool's error, or raw stderr text.
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

const started = Date.now();
// opencode picks its project from $PWD, not the process cwd, so set both
const child = spawn('opencode', args, {
  cwd: opts.dir,
  env: { ...process.env, PWD: opts.dir },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let out = '';
let err = '';
let logError = null;
let closed = false;
let stoppedBy = null;
let intIgnored = false;
let killTimer = null;

const killGroup = (signal) => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
};

// A group SIGINT must neither kill the run nor orphan opencode, so ignore it.
process.on('SIGINT', () => { intIgnored = true; });
const stop = (signal) => {
  if (closed || stoppedBy) return;
  stoppedBy = signal;
  killGroup('SIGTERM');
  killTimer = setTimeout(() => killGroup('SIGKILL'), 10_000);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGHUP', () => stop('SIGHUP'));
// Never leave an orphan behind if oc-run exits for any other reason.
process.on('exit', () => { if (!closed) killGroup('SIGKILL'); });
// Stream events to the log as they arrive so a long run can be watched (tail -f / read the log).
// A log write must never orphan the child or lose collected output.
child.stdout.on('data', (d) => {
  out += d;
  if (logError) return;
  try { appendFileSync(opts.log, d); }
  catch (e) { logError = e; }
});
child.stderr.on('data', (d) => (err += d));
child.on('error', (e) => {
  if (!closed) killGroup('SIGTERM');
  fail(`cannot start opencode: ${e.message}`);
});
child.on('close', (code) => {
  closed = true;
  if (killTimer) clearTimeout(killTimer);

  const summary = {
    ok: code === 0 && !stoppedBy,
    exitCode: code,
    sessionID: null,
    rateLimited: false,
    limit: null,
    title: opts.title ?? null,
    agent: opts.agent,
    model: opts.model,
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
  for (const line of out.split('\n')) {
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
  // The final answer is the last text part; earlier ones are interim narration.
  summary.text = texts.at(-1) ?? '';
  summary.cost = Math.round(summary.cost * 1e6) / 1e6;
  if (err.trim()) {
    summary.errors.push(`stderr: ${err.trim().slice(0, 500)}`);
    summary.limit ??= rateLimit(err.trim());
  }
  if (summary.limit) {
    summary.rateLimited = true;
    summary.ok = false; // a quota failure never counts as a usable run
  }
  if (logError) summary.errors.push(`log write failed: ${logError.message}`);
  if (intIgnored) summary.errors.push('ignored SIGINT');
  if (stoppedBy) summary.errors.push(`stopped by ${stoppedBy}`);
  if (code === 0 && !summary.sessionID) summary.ok = false;
  // Rate limit / quota: record when the model comes back so oc-rank skips it until then. The reset is
  // parsed from the message or estimated from the plan (lib.mjs); the same hit feeds the oc-limits.mjs
  // re-probe backoff, so one record carries both the block time and the schedule.
  const limitText = [...summary.errors, err].join('\n');
  const limited = LIMIT_RE.test(limitText);
  let limitNow = null;
  if (limited) {
    limitNow = new Date();
    const prev = readLimits()[opts.model];
    const prevAt = prev?.at ? new Date(prev.at).getTime() : NaN;
    const hits = Number.isNaN(prevAt) || limitNow.getTime() - prevAt > 24 * 3600e3 ? 1 : (Number(prev.hits) || 0) + 1;
    const parsed = parseReset(limitText, limitNow);
    const est = parsed ? { until: parsed, source: 'message' } : estimateReset(opts.model, hits, limitNow, limitText);
    summary.limited = {
      until: est.until ? est.until.toISOString() : null,
      source: est.source,
      message: limitText.trim(),
    };
    summary.ok = false;
  }
  // Bookkeeping is best-effort: a read-only HOME must not lose the run's result.
  try {
    if (summary.limited) {
      recordHit(opts.model, summary.limit?.message || summary.limited.message, limitNow,
        { until: summary.limited.until, source: summary.limited.source });
    } else if (summary.rateLimited) {
      recordHit(opts.model, summary.limit.message);
    } else if (summary.ok) {
      recordSuccess(opts.model);
    }
  } catch (e) {
    summary.errors.push(`limits write failed: ${e.message}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
});
