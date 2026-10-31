#!/usr/bin/env node
// Live, human-readable view of one oc-run.mjs dispatch. oc-run opens it in a Rex tab on its own when it
// runs inside Rex (REX_SESSION set, `rex` on PATH); it can also be started by hand in any terminal.
//
// Usage:
//   node oc-watch.mjs <log.jsonl> [--poll <ms>]
//
// Reads two files oc-run writes:
//   <log>               raw opencode JSONL, followed like tail -f from the start (or from the last 8 MB when
//                       more is waiting, with a note); read in bounded chunks, split into lines as bytes so a
//                       character cut between two reads stays whole
//   <log>.status.json   { state: running|done, pid, title, model, agent, dir, base, dirty, segment, handoffs,
//                         summary }  — model changes on a handoff; summary is the final oc-run JSON
// Prints model text, tool calls, step tokens / cost and errors as they arrive. `opencode run --format json`
// reports a tool only once it has finished, so while the log is quiet (>= 5 s) the viewer asks the opencode
// service (`opencode api GET /api/session/<id>/context`, at most every 5 s) what is in progress and shows it
// in a footer line: `⋯ <elapsed> <tool> <input>`, `⋯ <elapsed> thinking: <reasoning>`, or `⋯ <idle> waiting`
// when the service cannot tell. On a terminal the footer is cut to the width and redrawn in place; otherwise
// each change (ignoring the timer) is one line.
// The view ends when the status says done, when the oc-run pid is gone, or — without a status file (a log
// from before oc-watch, or copied elsewhere) — after the log has not grown for 10 s. It then prints the
// outcome and the folder's state: commits since `base`, `git status --short` and `git diff --stat base`
// (both show the folder now, so they include changes made before the run; `dirty` flags that case).
// Exit codes: 0 run finished ok, 1 run failed or no summary, 2 bad usage.

import { execFile, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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
const brief = (input = {}) =>
  input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.url ?? input.description ?? '';
const elapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

// Footer: one status line below the event stream. print() clears it first so events never mix with it.
let footer = '';
function print(line) {
  if (footer && process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  console.log(line);
  if (footer && process.stdout.isTTY) process.stdout.write(footer);
}
let shownFooter = '';
function setFooter(text) {
  if (process.stdout.isTTY) {
    // A footer wider than the terminal would wrap, and \r\x1b[K clears only its last row.
    const width = Math.max(10, (process.stdout.columns || 80) - 1);
    const next = text ? dim(text.slice(0, width)) : '';
    if (next === footer) return;
    footer = next;
    process.stdout.write(`\r\x1b[K${footer}`);
  } else if (!text) {
    shownFooter = '';
  } else if (text.replace(/^⋯ \S+/, '⋯') !== shownFooter) {
    // Without a terminal, print a footer only when it changes beyond its timer.
    shownFooter = text.replace(/^⋯ \S+/, '⋯');
    console.log(text);
  }
}

let steps = 0;
let cost = 0;
let tokens = { input: 0, output: 0 };

let sessionID = null;
let lastEvent = Date.now();
function render(ev) {
  sessionID = ev.sessionID ?? sessionID;
  lastEvent = Date.now();
  const p = ev.part ?? {};
  const t = dim(clock(ev.timestamp));
  if (ev.type === 'text' && p.text) {
    print(`${t} ${p.text.trim()}`);
  } else if (ev.type === 'tool_use') {
    const input = p.state?.input ?? {};
    const status = p.state?.status ?? '?';
    const mark = status === 'error' ? red('✗') : status === 'completed' ? green('▸') : yellow('▸');
    print(`${t} ${mark} ${cyan(p.tool ?? '?')} ${oneLine(brief(input))}`);
    if (status === 'error') print(`         ${red(oneLine(p.state?.error, 300))}`);
  } else if (ev.type === 'step_finish') {
    steps++;
    cost += p.cost ?? 0;
    tokens.input += p.tokens?.input ?? 0;
    tokens.output += p.tokens?.output ?? 0;
    print(dim(`${clock(ev.timestamp)} · step ${steps}  in ${tokens.input} out ${tokens.output}  $${cost.toFixed(4)}`));
  } else if (ev.type === 'error') {
    print(`${t} ${red('error')} ${oneLine(JSON.stringify(ev.error ?? ev), 300)}`);
  }
}

// Follows the log as bytes; `pending` holds the bytes after the last newline until the line completes.
const CHUNK = 1024 * 1024;
const BACKLOG = 8 * 1024 * 1024;
let offset = 0;
let pending = Buffer.alloc(0);
let skipPartial = false;
let lastGrowth = Date.now();
function line(bytes) {
  const text = bytes.toString('utf8');
  if (!text.trim()) return;
  let ev;
  try { ev = JSON.parse(text); } catch { return; }
  render(ev);
}
function drain() {
  let fd;
  try {
    const size = statSync(log).size;
    if (size < offset) {
      // Truncated or replaced: start over, counters included.
      offset = 0; pending = Buffer.alloc(0); steps = 0; cost = 0; tokens = { input: 0, output: 0 };
      print(yellow('── log restarted'));
    }
    if (size === offset) return;
    lastGrowth = Date.now();
    if (size - offset > BACKLOG) {
      print(dim(`… skipped ${Math.round((size - BACKLOG - offset) / 1048576)} MB of earlier log`));
      offset = size - BACKLOG;
      pending = Buffer.alloc(0);
      skipPartial = true;
    }
    fd = openSync(log, 'r');
    while (offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      let data = Buffer.concat([pending, buf.subarray(0, n)]);
      let nl;
      while ((nl = data.indexOf(0x0a)) >= 0) {
        if (skipPartial) skipPartial = false;
        else line(data.subarray(0, nl));
        data = data.subarray(nl + 1);
      }
      pending = Buffer.from(data);
    }
  } catch {
    // Deleted or unreadable for now: try again on the next poll.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// What the newest assistant message is doing now, from the opencode service's session context.
function liveState(context, now = Date.now()) {
  const entries = Array.isArray(context?.data) ? context.data : [];
  const last = entries.findLast((e) => e?.type === 'assistant');
  if (!last || last.time?.completed) return null;
  const parts = Array.isArray(last.content) ? last.content : [];
  const tool = parts.findLast((c) => c?.type === 'tool' && ['running', 'pending'].includes(c.state?.status));
  if (tool) {
    const since = tool.time?.ran ?? tool.time?.created ?? now;
    return `⋯ ${elapsed(now - since)} ${tool.name ?? tool.tool ?? 'tool'} ${oneLine(brief(tool.state?.input), 200)}`;
  }
  const thought = parts.findLast((c) => c?.type === 'reasoning' && c.text);
  const since = last.time?.created ?? now;
  return `⋯ ${elapsed(now - since)} thinking${thought ? `: ${oneLine(thought.text, 200)}` : ''}`;
}

// OC_WATCH_IDLE_MS (tests only) shortens the 5 s idle threshold and ask interval (and the 10 s no-status end).
const IDLE_MS = Number(process.env.OC_WATCH_IDLE_MS) || 5000;
let asking = false;
let lastAsk = 0;
function updateFooter(status) {
  const idle = Date.now() - lastEvent;
  if (idle < IDLE_MS) return setFooter('');
  if (!sessionID || asking || Date.now() - lastAsk < IDLE_MS) {
    if (!sessionID) setFooter(`⋯ ${elapsed(idle)} starting`);
    return;
  }
  asking = true;
  lastAsk = Date.now();
  execFile('opencode', ['api', 'GET', `/api/session/${sessionID}/context`],
    { cwd: status?.dir, timeout: 10000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      asking = false;
      if (done) return;
      let text = null;
      if (!err) { try { text = liveState(JSON.parse(stdout)); } catch {} }
      setFooter(text ?? `⋯ ${elapsed(Date.now() - lastEvent)} waiting`);
    });
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

function outcome(status) {
  const s = status?.summary;
  console.log('');
  if (!s) {
    console.log(red(status ? `oc-run (pid ${status.pid ?? '?'}) exited without a summary`
      : 'no status file and the log stopped growing; the output above may be complete'));
    return 1;
  }
  const head = s.ok ? green('done') : red(s.stalled ? 'stalled' : s.limited || s.rateLimited ? 'limited' : 'failed');
  console.log(`${bold('──')} ${head}  ${s.model}  ${s.seconds}s  ${s.steps} steps  $${s.cost}  ${dim(s.sessionID ?? '')}`);
  for (const h of s.handoffs ?? []) console.log(yellow(`handoff ${h.from} → ${h.to} (${h.reason})`));
  for (const e of (s.errors ?? []).slice(0, 5)) console.log(red(oneLine(e, 300)));
  const dir = status.dir;
  if (dir && git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true') {
    if (status.base) section('commits', git(dir, ['log', '--oneline', `${status.base}..HEAD`]));
    if (status.dirty) console.log(dim('the folder had uncommitted changes before the run; they show below too'));
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
let done = false;
const timer = setInterval(() => {
  drain();
  const status = readStatus();
  if (status?.model && status.model !== model) {
    model = status.model;
    print(yellow(`── now ${model}`));
  }
  if (status?.state === 'running') updateFooter(status);
  if (status?.state === 'done') return finish(status);
  if (status && !alive(status.pid)) return finish(status);
  if (!status && Date.now() - lastGrowth > 2 * IDLE_MS) return finish(null);
}, poll);

function finish(status) {
  clearInterval(timer);
  done = true;
  drain();
  if (!skipPartial) line(pending);
  setFooter('');
  process.exitCode = outcome(status);
}
