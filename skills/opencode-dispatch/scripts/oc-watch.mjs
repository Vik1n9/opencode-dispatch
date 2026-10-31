#!/usr/bin/env node
// Live, human-readable view of one oc-run.mjs dispatch. oc-run opens it in a Rex tab on its own when it
// runs inside Rex (REX_SESSION set, `rex` on PATH); it can also be started by hand in any terminal.
//
// Usage:
//   node oc-watch.mjs <log.jsonl> [--poll <ms>]
//
// Reads two files oc-run writes:
//   <log>               raw opencode JSONL (followed from the start, like tail -f)
//   <log>.status.json   { state: running|done, pid, title, model, agent, dir, base, segment, handoffs,
//                         summary }  — model changes on a handoff; summary is the final oc-run JSON
// Prints model text, tool calls, step tokens / cost and errors as they arrive. When the run is done it
// prints the outcome and what changed in the folder since the run started (commits since `base`,
// `git status --short`, `git diff --stat base`). Exit codes: 0 run finished ok, 1 run failed or oc-run
// exited without a summary, 2 bad usage.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { exitIfVersion } from './lib.mjs';

exitIfVersion();

const argv = process.argv.slice(2);
let log = null;
let poll = 250;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--poll') poll = Number(argv[++i]);
  else if (argv[i].startsWith('-')) usage(`unknown option: ${argv[i]}`);
  else if (!log) log = argv[i];
  else usage('only one log file');
}
if (!log) usage('missing <log.jsonl>');
if (!Number.isFinite(poll) || poll <= 0) usage('--poll must be a positive number of milliseconds');

function usage(msg) {
  console.error(`oc-watch: ${msg}\nusage: node oc-watch.mjs <log.jsonl> [--poll <ms>]`);
  process.exit(2);
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const statusFile = `${log}.status.json`;
function readStatus() {
  try { return JSON.parse(readFileSync(statusFile, 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const clock = (ms) => new Date(ms ?? Date.now()).toTimeString().slice(0, 8);
const oneLine = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

let steps = 0;
let cost = 0;
const tokens = { input: 0, output: 0 };

function render(ev) {
  const p = ev.part ?? {};
  const t = dim(clock(ev.timestamp));
  if (ev.type === 'text' && p.text) {
    console.log(`${t} ${p.text.trim()}`);
  } else if (ev.type === 'tool_use') {
    const input = p.state?.input ?? {};
    const brief = input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.url ?? input.description ?? '';
    const status = p.state?.status ?? '?';
    const mark = status === 'error' ? red('✗') : status === 'completed' ? green('▸') : yellow('▸');
    console.log(`${t} ${mark} ${cyan(p.tool ?? '?')} ${oneLine(brief)}`);
    if (status === 'error') console.log(`         ${red(oneLine(p.state?.error, 300))}`);
  } else if (ev.type === 'step_finish') {
    steps++;
    cost += p.cost ?? 0;
    tokens.input += p.tokens?.input ?? 0;
    tokens.output += p.tokens?.output ?? 0;
    console.log(dim(`${clock(ev.timestamp)} · step ${steps}  in ${tokens.input} out ${tokens.output}  $${cost.toFixed(4)}`));
  } else if (ev.type === 'error') {
    console.log(`${t} ${red('error')} ${oneLine(JSON.stringify(ev.error ?? ev), 300)}`);
  }
}

// Follows the log from byte 0; a partial last line waits for the next read.
let offset = 0;
let rest = '';
function drain() {
  let size;
  try { size = statSync(log).size; } catch { return; }
  if (size < offset) { offset = 0; rest = ''; }
  if (size === offset) return;
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(log, 'r');
  try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
  offset = size;
  rest += buf.toString('utf8');
  const lines = rest.split('\n');
  rest = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    render(ev);
  }
}

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

function section(title, text, max = 40) {
  if (!text) return;
  const lines = text.split('\n');
  console.log(bold(title));
  console.log(lines.slice(0, max).join('\n'));
  if (lines.length > max) console.log(dim(`… ${lines.length - max} more lines`));
}

function footer(status) {
  const s = status?.summary;
  console.log('');
  if (!s) {
    console.log(red(`oc-run (pid ${status?.pid ?? '?'}) exited without a summary`));
    return 1;
  }
  const head = s.ok ? green('done') : red(s.stalled ? 'stalled' : s.limited || s.rateLimited ? 'limited' : 'failed');
  console.log(`${bold('──')} ${head}  ${s.model}  ${s.seconds}s  ${s.steps} steps  $${s.cost}  ${dim(s.sessionID ?? '')}`);
  for (const h of s.handoffs ?? []) console.log(yellow(`handoff ${h.from} → ${h.to} (${h.reason})`));
  for (const e of (s.errors ?? []).slice(0, 5)) console.log(red(oneLine(e, 300)));
  const dir = status.dir;
  if (dir && git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true') {
    if (status.base) section('commits', git(dir, ['log', '--oneline', `${status.base}..HEAD`]));
    section('git status', git(dir, ['status', '--short']));
    section('diff --stat', git(dir, ['diff', '--stat', ...(status.base ? [status.base] : [])]));
  }
  return s.ok ? 0 : 1;
}

const first = readStatus();
console.log(bold(`opencode ${first?.title ?? ''}`.trim()));
if (first) console.log(dim(`${first.model}  ${first.agent}  ${first.dir}`));
console.log(dim(`log ${log}`));
console.log('');

let model = first?.model;
let missingSince = null;
const timer = setInterval(() => {
  drain();
  const status = readStatus();
  if (status?.model && status.model !== model) {
    model = status.model;
    console.log(yellow(`── now ${model}`));
  }
  if (status?.state === 'done') return finish(status);
  if (status && !alive(status.pid)) return finish(status);
  if (!status && !existsSync(log)) {
    missingSince ??= Date.now();
    if (Date.now() - missingSince > 10000) return finish(null);
  }
}, poll);

function finish(status) {
  clearInterval(timer);
  drain();
  process.exitCode = footer(status);
}
