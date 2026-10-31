# opencode-dispatch

A [Claude Code](https://claude.com/claude-code) skill that turns Claude into a dispatcher for the local [opencode](https://opencode.ai) CLI: Claude splits the work, picks a model per task, sends it to opencode, reviews the result, and sends it back until it meets the spec. Cheaper or free models (DeepSeek, Qwen, GLM, Kimi, OpenCode Zen / Go models …) do the implementation; Claude keeps the judgment.

## What it does

- **Local-only environment check** (`oc-check.mjs`): verifies this is the local machine (no cloud session / container), opencode 2.x is installed, and at least one provider is logged in; the dispatch scripts and `install.sh` run it first.
- **Safe wrapper around `opencode run`** (`oc-run.mjs`): closes stdin (opencode hangs otherwise), sets `PWD` so the right project is used, requires an explicit model, streams the raw JSONL to a log, and prints a compact JSON summary. opencode runs in its own process group, so a SIGINT to the caller never kills the run; sending SIGTERM to the wrapper stops it cleanly.
- **Live view in Rex** (`oc-watch.mjs`): when `oc-run.mjs` runs inside a [Rex](https://www.superlogical.com/rex) terminal (`REX_SESSION` set), it opens a background tab `oc <title>` that shows the model's text, tool calls, step tokens / cost and errors as they arrive, then the outcome and the commits, `git status` and `git diff --stat` since the run started. The tab ids go to stderr at start and to `rex` in the summary, so Claude can read progress with `rex capture`; `--no-rex` turns it off, and a failing `rex` never stops the run. Outside Rex, `node oc-watch.mjs <log>` shows the same view in any terminal (oc-run writes `<log>.status.json` beside the log).
- **Official-first model inventory** (`oc-models.mjs`): reads the OpenCode Zen / Go docs and live model lists, adds API-key providers from the local catalog, and optionally probes every model on this machine. Results are cached per session.
- **Capability-first ranking** (`oc-rank.mjs`): compares models only on the benchmarks of the task's category (repo coding, terminal, greenfield, tools, GUI / vision, reasoning, security, instruction following, long context), blends in an internal score from your own dispatch history, then applies plan and speed rules (flat-rate token plan first, free before paid, pay-as-you-go only when nothing close is cheaper).
- **Benchmark table upkeep** (`oc-bench.mjs`): `lint` checks `benchmarks.json`; `add-model`, `add-alias`, `set-score` edit it and refuse any change that would break the lint rules.
- **Track record and internal score** (`oc-track.mjs`): every reviewed dispatch is scored on three dimensions — correctness (returns, major / minor defects, scope violations, failed test reruns), output quality (the reviewer's 0–100 rating), and completion speed (compared across models that ran the same task; `compare --task-id` shows them side by side). Internal scores are derived from the raw history only, so they can always be rebuilt.
- **Usage limits** (`oc-run.mjs`): rate-limit / quota errors are detected, the reset time is parsed from the error or estimated per plan, and the model is skipped by the ranking until then; unfinished work continues in the same opencode session, with the same or the next model.
- **Shadow runs**: anonymous (stealth) models run the same task in isolation alongside the formal run, so they get an internal score even without public benchmarks.
- **Allowance check** (`oc-quota.mjs`): reads balances exported by the TokenBar menu-bar app (DeepSeek balance, Qwen token-plan allowance) and lists models currently blocked by usage limits.

The full operating rules for Claude are in [`skills/opencode-dispatch/SKILL.md`](skills/opencode-dispatch/SKILL.md).

## Layout

```
skills/opencode-dispatch/   the skill (SKILL.md + scripts/)
config/benchmarks.json      curated table: external benchmarks per model version, task categories
install.sh                  links the skill and benchmark table into place (--statusline: also the status line)
tests/                      node:test suite (node --test tests/)
statusline/                 optional companion Claude Code status line (see below)
```

Personal data stays out of the repository, in `~/.config/opencode-dispatch/` (override with `OC_DISPATCH_HOME`): `track.jsonl` (raw dispatch history), `internal.json` (scores derived from it) and `limits.json` (usage-limit blocks).

## Requirements

- Node.js 18+ (scripts use only built-in modules)
- **opencode CLI 2.x only** (tested with 2.0.32), **logged in** (`opencode auth login`) for the providers you want to use. `oc-run.mjs` and `oc-models.mjs` run `scripts/oc-check.mjs` and refuse to start unless it prints `ok`; `install.sh` stops only in a cloud session / container or on a wrong opencode major version, and only warns (still linking everything) when opencode is missing or no provider is logged in. Check by hand with `node skills/opencode-dispatch/scripts/oc-check.mjs`
- Claude Code (or another agent that loads skills from `~/.agents/skills` / `~/.claude/skills`)
- Optional: TokenBar, for `oc-quota.mjs`

## Local machine only

The skill refuses to run in Claude Code cloud sessions, containers / devcontainers / Codespaces, and on machines where opencode is missing, not 2.x, or not logged in (`scripts/oc-check.mjs`; `oc-run.mjs` and `oc-models.mjs` repeat the check, and `install.sh` stops or warns). Cloud and Cowork sessions do not read `~/.claude/skills`, so the skill is not loaded there as long as you do not enable it for your claude.ai account and do not copy it into a repository's `.claude/skills/`. Once the skill is loaded and the environment check passes, dispatch mode is on by default until you ask Claude to stop.

## Install

```bash
git clone https://github.com/Vik1n9/opencode-dispatch.git
cd opencode-dispatch
./install.sh
```

`install.sh` first runs `scripts/oc-check.mjs`: in a cloud session / container or on opencode other than 2.x it stops (exit 1) before linking anything; a missing opencode or no logged-in provider only prints a warning and the install continues. It then symlinks `skills/opencode-dispatch` into `~/.agents/skills/` (and `~/.claude/skills/` if missing) and `config/benchmarks.json` into `~/.config/opencode-dispatch/`. Anything already in the way is moved to `~/.config/opencode-dispatch/backups/<timestamp>/`. Because `benchmarks.json` is a symlink, edits made with `oc-bench.mjs` show up as changes in this repository; the internal scores derived by `oc-track.mjs` are written to `internal.json`, which stays in `~/.config/opencode-dispatch/` and is never linked.

### Optional: companion status line

```bash
./install.sh --statusline
```

Adds a second status line row in Claude Code that shows what is running, and only appears when something is:

```
⚙ 錄製清單 qwen3.8-max 12m·21步 │ ⏳ 狀態列測試 1m │ ⬇ 參考影片 45% 預計19:18
```

- `⚙` running opencode dispatches (`oc-run.mjs` processes): the `--title` label (use a short label, e.g. 4–6 CJK characters), model, elapsed time and steps from the run log.
- `⏳` Claude Code background work of the current session (background Bash, subagents), parsed incrementally from the transcript.
- `⬇` downloads started through `~/.claude/bin/dlwatch <label> -- <command>`: percent and estimated finish time. dlwatch runs the command under a pseudo-terminal so tools print progress (yt-dlp, curl, wget, git), and for Homebrew, which holds its progress back, it reads the size of the growing download against the URL's content length.

`--statusline` links `statusline/` files into `~/.claude/` and points `settings.json` `statusLine` at `statusline-wrap.sh` with `refreshInterval: 3`, after a backup. Your first line stays: `~/.claude/statusline.sh` if present, otherwise the previous `statusLine` command, saved to `~/.config/opencode-dispatch/statusline-base`. Tests: `cd statusline && node --test test/ test/wrap/ test/dlwatch/` (temp `HOME`, fake processes, no network).

## Quick start

```bash
D=~/.agents/skills/opencode-dispatch/scripts
node $D/oc-models.mjs --probe            # instant when the cached inventory is < 12 h old
node $D/oc-rank.mjs --task repo-coding
node $D/oc-quota.mjs
node $D/oc-run.mjs --model <provider/model> --dir <project> --title "fix-x" "<task description>"
node $D/oc-track.mjs add --json '<review record>'
```

In practice you just ask Claude Code to "dispatch this to opencode" and the skill drives these steps.

## Tests

`node --test tests/` runs the test suite: no network, no real opencode (fake shims on `PATH`), and a temp `HOME`, so nothing touches your real config or score table.

## Notes

- The plan-specific rules (Qwen token plan via `bailian-token-plan-personal`, OpenCode Go subscription, Zen free models only) reflect the author's setup; adjust `plan()` and `estimateReset()` in `lib.mjs` and the rules in `SKILL.md` for yours.
- Dispatching is not always cheaper: for a change about as small as its spec, Claude doing it directly used fewer tokens in a measured comparison. `SKILL.md` says when to dispatch.
- Never put API keys in task descriptions: opencode stores sessions and may send them to third-party providers.

## License

MIT
