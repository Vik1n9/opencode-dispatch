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
// Prints JSON: { ok, exitCode, sessionID, title, agent, model, dir, seconds,
//                text, tools[], steps, cost, tokens, errors[], log }
//
// Exit codes: 0 run ok, 1 run failed (summary.ok is false), 2 bad arguments or
// environment check failed.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkEnvironment } from './oc-check.mjs';

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
const env = checkEnvironment();
if (!env.ok) fail(env.error);

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
  if (logError) summary.errors.push(`log write failed: ${logError.message}`);
  if (intIgnored) summary.errors.push('ignored SIGINT');
  if (stoppedBy) summary.errors.push(`stopped by ${stoppedBy}`);
  if (code === 0 && !summary.sessionID) summary.ok = false;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? (code ?? 0) : (code || 1));
});
