# opencode-dispatch

A [Claude Code](https://claude.com/claude-code) skill that turns Claude into a dispatcher for the local [opencode](https://opencode.ai) CLI: Claude splits the work, picks a model per task, sends it to opencode, reviews the result, and sends it back until it meets the spec. Cheaper or free models (DeepSeek, Qwen, GLM, Kimi, OpenCode Zen / Go models …) do the implementation; Claude keeps the judgment.

## What it does

- **Safe wrapper around `opencode run`** (`oc-run.mjs`): closes stdin (opencode hangs otherwise), sets `PWD` so the right project is used, requires an explicit model, streams the raw JSONL to a log, and prints a compact JSON summary.
- **Official-first model inventory** (`oc-models.mjs`): reads the OpenCode Zen / Go docs and live model lists, adds API-key providers from the local catalog, and optionally probes every model on this machine. Results are cached per session.
- **Capability-first ranking** (`oc-rank.mjs`): compares models only on the benchmarks of the task's category (repo coding, terminal, greenfield, tools, GUI / vision, reasoning, security, instruction following, long context), blends in an internal score from your own dispatch history, then applies plan and speed rules (flat-rate token plan first, free before paid, pay-as-you-go only when nothing close is cheaper).
- **Track record and internal score** (`oc-track.mjs`): every reviewed dispatch is graded with a fixed formula (returns, major / minor defects, scope violations, failed test reruns) and task completion speed is compared across models that ran the same task.
- **Shadow runs**: anonymous (stealth) models run the same task in isolation alongside the formal run, so they get an internal score even without public benchmarks.
- **Allowance check** (`oc-quota.mjs`): reads balances exported by the TokenBar menu-bar app (DeepSeek balance, Qwen token-plan allowance) before dispatching.

The full operating rules for Claude are in [`skills/opencode-dispatch/SKILL.md`](skills/opencode-dispatch/SKILL.md).

## Layout

```
skills/opencode-dispatch/   the skill (SKILL.md + scripts/)
config/scores.json          score table: external benchmarks per model version, task categories, internal scores
install.sh                  links the skill and score table into place
```

`track.jsonl` (the raw dispatch history) is personal data: it lives in `~/.config/opencode-dispatch/` and is not part of this repository.

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

`install.sh` symlinks `skills/opencode-dispatch` into `~/.agents/skills/` (and `~/.claude/skills/` if missing) and `config/scores.json` into `~/.config/opencode-dispatch/`. Anything already in the way is moved to `~/.config/opencode-dispatch/backups/<timestamp>/`. Because the score table is a symlink, internal scores written by `oc-track.mjs` show up as changes in this repository.

## Quick start

```bash
S=/tmp/oc-session   # any per-session scratch folder
mkdir -p $S
node ~/.agents/skills/opencode-dispatch/scripts/oc-models.mjs --probe --cache $S/oc-inventory.json
node ~/.agents/skills/opencode-dispatch/scripts/oc-rank.mjs --cache $S/oc-inventory.json --task repo-coding
node ~/.agents/skills/opencode-dispatch/scripts/oc-quota.mjs
node ~/.agents/skills/opencode-dispatch/scripts/oc-run.mjs --model <provider/model> --dir <project> --title "fix-x" "<task description>"
```

In practice you just ask Claude Code to "dispatch this to opencode" and the skill drives these steps.

## Notes

- The plan-specific rules (Qwen token plan via `bailian-token-plan-personal`, OpenCode Go subscription, Zen free models only) reflect the author's setup; adjust `plan()` in `oc-rank.mjs` and the rules in `SKILL.md` for yours.
- Never put API keys in task descriptions: opencode stores sessions and may send them to third-party providers.

## License

MIT
