#!/usr/bin/env node
// Run one opencode task non-interactively and print a compact summary.
// Wraps `opencode run --format json`, closing stdin (opencode waits on stdin
// forever when it is not a TTY) and saving the raw JSONL event log to a file.
//
// Usage:
//   node oc-run.mjs --model <provider/model> [--agent build|plan] [--dir <path>]
//                   [--session <id>] [--fork] [--title <t>] [--log <file>]
//                   [--prompt-file <file> | <message...>]
//
// Prints JSON: { ok, exitCode, sessionID, title, agent, model, dir, seconds,
//                text, tools[], steps, cost, tokens, errors[], log, limited? }
//
// When the error text looks like a rate limit / quota ("rate limit", "429", "insufficient balance" …),
// the reset time is parsed from the message or estimated from the plan, the entry is written to
// limits.json (so oc-rank skips the model), and `limited: { until, source, message }` is added while
// ok stays false. A successful run without such a match clears the model's entry.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LIMIT_RE, clearLimit, estimateReset, loadLimits, parseReset, recordLimit } from './lib.mjs';

const argv = process.argv.slice(2);
const opts = { fork: false, agent: 'build', dir: process.cwd() };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) fail(`${a} needs a value`);
    return argv[++i];
  };
  if (a === '--model' || a === '-m') opts.model = next();
  else if (a === '--agent') opts.agent = next();
  else if (a === '--dir') opts.dir = resolve(next());
  else if (a === '--session' || a === '-s') opts.session = next();
  else if (a === '--fork') opts.fork = true;
  else if (a === '--title') opts.title = next();
  else if (a === '--log') opts.log = resolve(next());
  else if (a === '--prompt-file') opts.prompt = readFileSync(next(), 'utf8');
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

if (!opts.log) {
  const dir = join(tmpdir(), 'oc-run');
  mkdirSync(dir, { recursive: true });
  opts.log = join(dir, `${Date.now()}-${process.pid}.jsonl`);
}

const args = ['run', '--format', 'json', '-m', opts.model, '--agent', opts.agent];
if (opts.session) args.push('-s', opts.session);
if (opts.fork) args.push('--fork');
if (opts.title) args.push('--title', opts.title);
args.push(opts.prompt);

const started = Date.now();
// opencode picks its project from $PWD, not the process cwd, so set both
const child = spawn('opencode', args, {
  cwd: opts.dir,
  env: { ...process.env, PWD: opts.dir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let err = '';
writeFileSync(opts.log, '');
// Stream events to the log as they arrive so a long run can be watched (tail -f / read the log)
child.stdout.on('data', (d) => { out += d; appendFileSync(opts.log, d); });
child.stderr.on('data', (d) => (err += d));
child.on('error', (e) => fail(`cannot start opencode: ${e.message}`));
child.on('close', (code) => {

  const summary = {
    ok: code === 0,
    exitCode: code,
    sessionID: null,
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
      if (p.state?.status === 'error') summary.errors.push(String(p.state?.error ?? '').slice(0, 300));
    } else if (ev.type === 'step_finish') {
      summary.steps++;
      summary.cost += p.cost ?? 0;
      for (const k of ['input', 'output', 'reasoning']) summary.tokens[k] += p.tokens?.[k] ?? 0;
    } else if (ev.type === 'error') {
      summary.errors.push(JSON.stringify(ev.error ?? ev).slice(0, 300));
    }
  }
  // The final answer is the last text part; earlier ones are interim narration.
  summary.text = texts.at(-1) ?? '';
  summary.cost = Math.round(summary.cost * 1e6) / 1e6;
  if (err.trim()) summary.errors.push(`stderr: ${err.trim().slice(0, 500)}`);
  if (code === 0 && !summary.sessionID) summary.ok = false;
  // Rate limit / quota: record when the model comes back so oc-rank skips it until then.
  const limitText = [...summary.errors, err].join('\n');
  if (LIMIT_RE.test(limitText)) {
    const now = new Date();
    const prev = loadLimits()[opts.model];
    const prevAt = prev?.at ? new Date(prev.at).getTime() : NaN;
    const hits = Number.isNaN(prevAt) || now.getTime() - prevAt > 24 * 3600e3 ? 1 : (Number(prev.hits) || 0) + 1;
    const parsed = parseReset(limitText, now);
    const est = parsed ? { until: parsed, source: 'message' } : estimateReset(opts.model, hits, now, limitText);
    recordLimit(opts.model, { until: est.until, source: est.source, message: limitText }, now);
    summary.limited = {
      until: est.until ? est.until.toISOString() : null,
      source: est.source,
      message: limitText.trim(),
    };
  } else if (summary.ok) {
    clearLimit(opts.model);
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(code ?? 1);
});
