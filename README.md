# opencode-dispatch

A [Claude Code](https://claude.com/claude-code) skill that turns Claude into a dispatcher for the local [opencode](https://opencode.ai) CLI: Claude splits the work, picks a model per task, sends it to opencode, reviews the result, and sends it back until it meets the spec. Cheaper or free models (DeepSeek, Qwen, GLM, Kimi, OpenCode Zen / Go models …) do the implementation; Claude keeps the judgment.

## What it does

- **Safe wrapper around `opencode run`** (`oc-run.mjs`): closes stdin (opencode hangs otherwise), sets `PWD` so the right project is used, requires an explicit model, streams the raw JSONL to a log, and prints a compact JSON summary.
- **Official-first model inventory** (`oc-models.mjs`): reads the OpenCode Zen / Go docs and live model lists, adds API-key providers from the local catalog, and probes the models that can actually be ranked. The inventory is cached in `~/.cache/opencode-dispatch/` and reused for 12 hours, so most sessions start without probing.
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
install.sh                  links the skill and benchmark table into place
tests/                      node:test suite (node --test tests/)
```

Personal data stays out of the repository, in `~/.config/opencode-dispatch/` (override with `OC_DISPATCH_HOME`): `track.jsonl` (raw dispatch history), `internal.json` (scores derived from it) and `limits.json` (usage-limit blocks).

## Requirements

- Node.js 18+ (scripts use only built-in modules)
- opencode CLI (tested with 2.0.32), with the providers you want to use already authenticated
- Claude Code (or another agent that loads skills from `~/.agents/skills` / `~/.claude/skills`)
- Optional: TokenBar, for `oc-quota.mjs`

## Install

```bash
git clone https://github.com/Vik1n9/opencode-dispatch.git
cd opencode-dispatch
./install.sh
```

`install.sh` symlinks `skills/opencode-dispatch` into `~/.agents/skills/` (and `~/.claude/skills/` if missing) and `config/benchmarks.json` into `~/.config/opencode-dispatch/`. Anything already in the way (including a pre-v2 `scores.json`) is moved to `~/.config/opencode-dispatch/backups/<timestamp>/`. Dispatching never writes to the repository.

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

## Notes

- The plan-specific rules (Qwen token plan via `bailian-token-plan-personal`, OpenCode Go subscription, Zen free models only) reflect the author's setup; adjust `plan()` and `estimateReset()` in `lib.mjs` and the rules in `SKILL.md` for yours.
- Dispatching is not always cheaper: for a change about as small as its spec, Claude doing it directly used fewer tokens in a measured comparison. `SKILL.md` says when to dispatch.
- Never put API keys in task descriptions: opencode stores sessions and may send them to third-party providers.

## License

MIT
