#!/usr/bin/env node
// Second status line: running opencode dispatches (oc-run.mjs), Claude Code background tasks and
// watched downloads.
//   ⚙ 錄製清單 qwen3.8-max 12m·21步 │ ⏳ 建置 3m │ ⬇ 參考影片 45% 預計14:32
// Agents: found by scanning processes for oc-run.mjs; the label is its --title when it contains CJK,
// else labels.json maps the title, else the title is shortened. Steps are counted in its JSONL log.
// Tasks: background Bash/Agent calls picked up from this session's transcript and closed by a
// <task-notification>. Parsed incrementally; byte offset and open tasks are cached.
// Downloads: status files written by ~/.claude/bin/dlwatch (one per running download).
// Prints nothing when nothing is running. Must stay fast: one ps call, small file reads.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';

const STATE = join(homedir(), '.cache', 'agent-status');
const DIM = '\x1b[2m', RESET = '\x1b[0m', CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m';
const CJK = /[㐀-鿿]/;
const DAY = 86400e3;
const READ_BUDGET = 4 * 1024 * 1024; // transcript bytes per render, so a huge file can never hang
const STEP_BUDGET = 8 * 1024 * 1024; // log bytes per render, same reason
const DL_STALE = 24 * 3600e3; // a live pid with an untouched status file is probably pid reuse
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]/g;  // OSC, then CSI
const CTRL = /[\x00-\x1f\x7f-\x9f]/g;

// Labels come from process arguments and files; never let them break the status line layout.
const clean = (s) => String(s ?? '').replace(ANSI, '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim();

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Writes ~/.cache/agent-status files atomically: concurrent renders must never read half a file.
function saveJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, file);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

// ps etime: [[dd-]hh:]mm:ss → "12m" / "1h05m"
function elapsed(etime) {
  const m = String(etime ?? '').match(/^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return '';
  const [, d, a, b, c] = m;
  const secs = c === undefined
    ? Number(a) * 60 + Number(b)
    : Number(a) * 3600 + Number(b) * 60 + Number(c);
  const s = Number(d || 0) * 86400 + secs;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// ps exposes one argument string. Quotes protect spaces and flag-looking text inside values.
function tokens(args) {
  const s = String(args ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let v = '', quoted = false, inQuote = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { quoted = true; inQuote = !inQuote; i++; continue; }
      if (!inQuote && /\s/.test(ch)) break;
      v += ch;
      i++;
    }
    out.push({ v, quoted });
  }
  return out;
}

const tokenize = (args) => tokens(args).map((t) => t.v);

// Only --title takes several unquoted words (titles are often passed unquoted); other flags take
// exactly one token, so a trailing positional prompt is never swallowed.
function argOf(args, flag, multiWord = false) {
  const toks = tokens(args);
  const more = (from) => {
    const parts = [];
    for (let j = from; j < toks.length && !toks[j].v.startsWith('--'); j++) parts.push(toks[j].v);
    return parts;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.v === flag) {
      const first = toks[i + 1];
      if (!first || first.v.startsWith('--')) return '';
      if (!multiWord || first.quoted) return first.v;
      return [first.v, ...more(i + 2)].join(' ');
    }
    if (t.v.startsWith(`${flag}=`)) {
      const val = t.v.slice(flag.length + 1);
      if (!multiWord || t.quoted || !val) return val;
      return [val, ...more(i + 1)].join(' ');
    }
  }
  return '';
}

// Steps live in a JSONL log that keeps growing. Count one line per "step_finish" and remember how
// far we got, so a large log is read once (in bounded chunks) instead of on every render.
function stepsIn(log) {
  let st;
  try { st = statSync(log); } catch { return null; }
  if (!st.isFile()) return null;
  const key = createHash('sha1').update(String(log)).digest('hex').slice(0, 16);
  const cache = join(STATE, `steps-${key}.json`);
  const old = readJson(cache, null);
  const cached = old && old.path === String(log) && old.ino === st.ino
    && Number.isFinite(old.offset) && old.offset >= 0 && old.offset <= st.size
    && Number.isFinite(old.count) && old.count >= 0;
  const state = cached ? old : { path: String(log), ino: st.ino, offset: 0, count: 0 };
  if (st.size > state.offset) {
    const want = Math.min(st.size - state.offset, STEP_BUDGET);
    try {
      const buf = Buffer.alloc(want);
      const fd = openSync(log, 'r');
      let n = 0;
      try {
        while (n < want) {
          const r = readSync(fd, buf, n, want - n, state.offset + n);
          if (!r) break;
          n += r;
        }
      } finally { closeSync(fd); }
      const text = buf.subarray(0, n).toString('utf8');
      const end = text.lastIndexOf('\n');
      // Only complete lines; a half-written step is counted on the next render.
      const whole = end >= 0 ? text.slice(0, end + 1) : (n < want ? text : '');
      if (whole) {
        state.count += (whole.match(/"type":\s*"step_finish"/g) || []).length;
        state.offset += Buffer.byteLength(whole);
        saveJson(cache, state);
      }
    } catch { /* keep the count we had */ }
  }
  return state.count;
}

function short(label) {
  const t = clean(label) || '背景工作';
  if (CJK.test(t)) return [...t].slice(0, 8).join('');
  return t.length > 16 ? `${t.slice(0, 15)}…` : t;
}

function labelFor(title, labels) {
  const t = clean(title);
  if (CJK.test(t)) return t;
  const mapped = labels && typeof labels === 'object' && typeof labels[t] === 'string' ? clean(labels[t]) : '';
  return mapped || [...t].slice(0, 12).join('').trim() || '派工';
}

function agents() {
  let ps = '';
  try {
    ps = execFileSync('ps', ['-axo', 'pid=,etime=,args='], { encoding: 'utf8', timeout: 1500, maxBuffer: 8 * 1024 * 1024 });
  } catch { return []; }
  const labels = readJson(join(STATE, 'labels.json'), {});
  const tmp = join(process.env.TMPDIR || tmpdir(), 'oc-run');
  let tmpFiles = null;
  const out = [];
  for (const line of ps.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    // The executable itself must be node (shell wrappers also carry "node … oc-run.mjs" in their args).
    if (!m || !/^(\S*\/)?node\s+\S*oc-run\.mjs\b/.test(m[3])) continue;
    const [, pid, etime, args] = m;
    const title = argOf(args, '--title', true);
    const model = (clean(argOf(args, '--model')).split('/').pop() || '?').replace(/-free$/, '');
    let log = clean(argOf(args, '--log'));
    if (!log) {
      if (tmpFiles === null) {
        try { tmpFiles = existsSync(tmp) ? readdirSync(tmp) : []; } catch { tmpFiles = []; }
      }
      const f = tmpFiles.find((n) => n.endsWith(`-${pid}.jsonl`));
      if (f) log = join(tmp, f);
    }
    const label = labelFor(title, labels);
    const steps = stepsIn(log);
    out.push(`${CYAN}⚙${RESET} ${label} ${DIM}${model} ${elapsed(etime)}${steps != null ? `·${steps}步` : ''}${RESET}`);
  }
  return out;
}

function clock(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function downloads() {
  let names;
  try { names = readdirSync(STATE); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const name of names.sort()) {
    if (!/^dl-\d+\.json$/.test(name)) continue;
    const file = join(STATE, name);
    let mtime;
    try { mtime = statSync(file).mtimeMs; } catch { continue; }
    const s = readJson(file, null);
    const pid = s && Number(s.pid);
    // A dead writer or a reused pid leaves a file behind; drop it instead of showing a ghost.
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid) || now - mtime > DL_STALE) {
      try { rmSync(file, { force: true }); } catch { /* best effort */ }
      continue;
    }
    const label = clean(s.label) || '下載';
    const pct = Number.isFinite(s.pct) ? `${s.pct.toFixed(s.pct < 10 ? 1 : 0)}%` : '…';
    const etaAt = Number.isFinite(s.etaAt) && s.etaAt > now ? clock(s.etaAt) : '';
    const eta = etaAt ? ` 預計${etaAt}` : '';
    const color = Number.isFinite(s.pct) && s.pct >= 100 ? GREEN : YELLOW;
    out.push(`${color}⬇${RESET} ${label} ${color}${pct}${RESET}${DIM}${eta}${RESET}`);
  }
  return out;
}

// Task notifications carry a tool-use-id and a status; accept either order and any id shape.
function notifications(line) {
  if (!line.includes('<task-notification>')) return [];
  const out = [];
  for (const block of line.split('<task-notification>').slice(1)) {
    const id = block.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    const status = block.match(/<status>\s*([^<]+?)\s*<\/status>/);
    if (id && status) out.push([id[1], status[1].toLowerCase()]);
  }
  return out;
}

function scanLine(state, line) {
  if (line.includes('"tool_use"')) {
    let e = null;
    try { e = JSON.parse(line); } catch { /* not a JSONL event */ }
    const content = e?.message?.content;
    for (const c of Array.isArray(content) ? content : []) {
      if (!c || typeof c !== 'object' || c.type !== 'tool_use') continue;
      const bg = (c.name === 'Bash' && c.input?.run_in_background) || c.name === 'Agent';
      if (!bg || /oc-run\.mjs/.test(c.input?.command || '')) continue;
      if (!c.id || !/^[A-Za-z0-9_-]+$/.test(c.id)) continue;
      state.pending[c.id] = { label: clean(c.input?.description || c.name), at: Date.parse(e.timestamp) || Date.now() };
    }
  }
  for (const [id, status] of notifications(line)) {
    if (status !== 'running') delete state.pending[id];
  }
}

// Read at most READ_BUDGET bytes from offset and return only complete lines.
function readChunk(path, offset, size) {
  const want = Math.min(size - offset, READ_BUDGET);
  if (want <= 0) return null;
  const buf = Buffer.alloc(want);
  const fd = openSync(path, 'r');
  let n = 0;
  try {
    while (n < want) {
      const r = readSync(fd, buf, n, want - n, offset + n);
      if (!r) break;
      n += r;
    }
  } finally { closeSync(fd); }
  // A trailing partial UTF-8 sequence is after the last newline, so it is never counted here.
  const text = buf.subarray(0, n).toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], next: offset };
  return { lines: text.slice(0, end).split('\n'), next: offset + Buffer.byteLength(text.slice(0, end + 1)) };
}

function transcriptCache(input) {
  const sid = typeof input?.session_id === 'string' ? input.session_id : '';
  // Session ids come from stdin; never let one escape ~/.cache/agent-status.
  const key = sid.replace(/[^\w-]/g, '').slice(0, 64)
    || createHash('sha1').update(String(input?.transcript_path || '')).digest('hex').slice(0, 16);
  return join(STATE, `transcript-${key}.json`);
}

function prune(pending, now) {
  let changed = false;
  for (const [id, t] of Object.entries(pending)) {
    if (!t || typeof t !== 'object' || !Number.isFinite(t.at) || now - t.at > DAY) {
      delete pending[id];
      changed = true;
    }
  }
  return changed;
}

// Claude Code background work of this session (background Bash, subagents): started in the transcript
// and not yet closed by a <task-notification>. Parsed incrementally from a saved byte offset.
function backgroundTasks(input) {
  const path = input && typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!path || !existsSync(path)) return [];
  let size;
  try { size = statSync(path); } catch { return []; }
  const cache = transcriptCache(input);
  const old = readJson(cache, null);
  // A different inode means the transcript was rotated, even if the new file is already larger.
  const usable = old && typeof old === 'object' && old.path === path && old.ino === size.ino
    && Number.isFinite(old.offset) && old.offset >= 0 && old.offset <= size.size
    && old.pending && typeof old.pending === 'object' && !Array.isArray(old.pending);
  const state = usable ? old : { path, ino: size.ino, offset: 0, pending: {} };
  let dirty = !usable;
  if (size.size > state.offset) {
    try {
      const chunk = readChunk(path, state.offset, size.size);
      if (chunk && chunk.lines.length) {
        for (const line of chunk.lines) scanLine(state, line);
        state.offset = chunk.next;
        dirty = true;
      }
    } catch { /* unreadable transcript: keep what we have */ }
  }
  if (prune(state.pending, Date.now())) dirty = true;
  if (dirty) saveJson(cache, state);
  const now = Date.now();
  return Object.values(state.pending)
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const mins = Math.max(0, Math.floor((now - (Number.isFinite(t.at) ? t.at : now)) / 60000));
      const age = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
      return `${GREEN}⏳${RESET} ${short(t.label)} ${DIM}${age}${RESET}`;
    });
}

function main() {
  let input = null;
  // A tty would block forever; Claude Code always pipes JSON.
  try {
    if (!isatty(0)) {
      const raw = readFileSync(0, 'utf8');
      if (raw.trim()) input = JSON.parse(raw);
    }
  } catch { /* no stdin, invalid JSON */ }
  if (!input || typeof input !== 'object') input = null;
  const parts = [...agents(), ...backgroundTasks(input), ...downloads()];
  if (parts.length) process.stdout.write(parts.join(` ${DIM}│${RESET} `) + '\n');
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

export { clean, elapsed, tokenize, argOf, stepsIn, agents, backgroundTasks, downloads, notifications, short, saveJson, transcriptCache };

if (isMain()) {
  try { main(); } catch { /* a status line must never print a stack trace */ }
}
