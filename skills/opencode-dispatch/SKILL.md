---
name: opencode-dispatch
description: Dispatch work to other models (DeepSeek, Qwen, GLM, Kimi, etc.) through the local opencode CLI (CLI mode, not MCP), with Claude Code as the dispatcher — pick the model and agent, continue sessions, run tasks in parallel, collect and verify results. Triggers — the user says "dispatch to opencode", "run it with opencode", "let other models do it", "orchestrate opencode", "opencode subagent", or wants to hand mechanical, parallelizable work to cheaper models.
---

# opencode dispatch (CLI mode)

Claude Code is the dispatcher; opencode is the worker. Every call goes through `scripts/oc-run.mjs` — never run `opencode run` directly in Bash.

## Why the wrapper script is mandatory

Pitfalls found in practice (opencode 2.0.32), all handled by the script:

- **It hangs forever if stdin stays open**: outside a terminal, `opencode run` waits for stdin to end. The script uses `stdio: ignore`; when running by hand always add `< /dev/null`.
- **The working directory comes from `$PWD`**, not the process cwd: setting only one of `cd` / cwd lands in the wrong project. The script's `--dir` sets both cwd and `PWD`.
- **Without a model it uses opencode's own default**, which is unpredictable. The script requires `--model`.
- **Raw output is line-by-line JSON events**, long and noisy. The script saves it to a file and prints a compact summary.

## Usage

```bash
node ~/.agents/skills/opencode-dispatch/scripts/oc-run.mjs \
  --model <provider/model> --agent <build|plan> --dir <work folder> \
  --title <recognizable title> "<task description>"
```

| Option | Meaning |
|---|---|
| `--model` | Required. `opencode models` lists what is available; format `provider/model` |
| `--agent` | `build` (default; edits files, runs shell) or `plan` (no edits — see the safety rules) |
| `--dir` | opencode's working folder; defaults to the current directory |
| `--session` / `-s` | Continue an existing session (multi-turn) |
| `--fork` | With `--session`: branch a new session off it |
| `--title` | Session title, to find it later with `opencode session list` |
| `--prompt-file` | Read a long task description from a file |
| `--log` | Where to store the raw JSONL; defaults to `$TMPDIR/oc-run/` |

The output is a JSON summary: `ok`, `exitCode`, `sessionID`, `seconds` (elapsed), `text` (last reply), `tools` (tools used, with argument summaries), `steps`, `cost`, `tokens` (`input` / `output` / `reasoning`), `errors`, `log`, plus `title`, `agent`, `model`, `dir`. Read the `log` file only for details, and never read the whole log into the conversation.

## Choosing a model: score table + session cache

opencode's free models change often, and anonymous (stealth) models appear from time to time. **The skill keeps no model list**; the work is split across these files:

| Data | Location | Contents | Lifetime |
|---|---|---|---|
| **Score table** | `~/.config/opencode-dispatch/scores.json` | External benchmark scores per model version (with source: vendor-reported or independent), the **internal score** (`internal.<category>`: score, count, per-entry task speed), and which benchmarks belong to which task category | Scores belong to a model version and **never expire**; only added to |
| **Track record** | `~/.config/opencode-dispatch/track.jsonl` | One line per dispatch: task, time, review result, returns, defects, grade | Append only. **Not read routinely** (saves context); query with `oc-track.mjs show` only when judging how a model did on this kind of task before |
| **Inventory cache** | This session's scratchpad: `<scratchpad>/oc-inventory.json` | Which models are usable right now, probe latency, context length, plan | **Valid only within the same session** |

### Workflow

1. **Take inventory once, the first time you dispatch in a session** (never again in that session):
   `node ~/.agents/skills/opencode-dispatch/scripts/oc-models.mjs --probe --cache <scratchpad>/oc-inventory.json`
   - **Official information is the source of truth; the local machine only confirms.** The script first reads official sources — the Zen docs pricing table and model ID table (https://opencode.ai/docs/zen/; only models marked Free are free), the Zen / Go live lists (`/zen/v1/models`, `/zen/go/v1/models`), and the Go pricing table (https://opencode.ai/docs/go/) — then calls each candidate on this machine. The local catalog often lags behind and must never be the source.
   - The user's plans: **Zen — only models officially marked Free** (no paid balance); **Go — subscribed**, every model usable, counted against the monthly allowance; Contributor models' data is used for training (accepted). API-key providers (Qwen's `bailian-token-plan-personal`, `deepseek`) have no public list without a key: the script lists the local catalog, and scores must come from the vendor's docs.
   - Common failures: `not in local opencode yet` (official has it, local not updated), `API key has expired` (ask the user to create a new key in the OpenCode Console and switch to it with `opencode auth login`; Claude must not enter keys), timeout (too slow).
2. **Fill in the score table after the inventory**: for model versions that are usable but missing from the table (`oc-rank.mjs` lists them last under "not in the score table yet"; each category's "no scores in this category" also includes models that are in the table but lack benchmarks for that category), look up specs and benchmarks online and add them to `scores.json`: one entry per model version, `aliases` = every opencode ID that points to it, benchmark names in full with version (Terminal-Bench 2.0 and 2.1 are not comparable), `source` (vendor / independent), `ref` (URL). If an independent result exists for a benchmark, it wins. Put any new benchmark under one of the `categories` first. For anonymous models with no data, leave `scores` empty and set `stealth: true`; shadow runs measure them.
3. **Every allocation: rank from the cache, never re-take inventory**:
   `node ~/.agents/skills/opencode-dispatch/scripts/oc-rank.mjs --cache <scratchpad>/oc-inventory.json --task <category>`
   - Categories (defined in the score table): `repo-coding` (fix bugs / add features in an existing codebase), `terminal` (terminal work, running tests, scripts), `greenfield` (new projects, large refactors), `tools` (multi-step tool calling), `gui-vision` (screenshots, GUIs), `reasoning` (reasoning, planning), `security` (security review), `instruction` (format-following rewrites, translation, data cleanup), `long-context`; `--task all` lists every category.
   - When continuing a long session or reading many files, add `--min-context <tokens>` to drop entries whose context is too small (e.g. free entries have only 200k).
   - Models the official live list no longer has (inventory shows "not on live list") are excluded from ranking and shadow runs. The output ends with the shadow-run candidates (one entry per model, the cheapest plan); with `--json` they are in the `shadow` field.
4. **Check allowance before dispatching** (user, 2026-10-19): `node ~/.agents/skills/opencode-dispatch/scripts/oc-quota.mjs`. The numbers come from `status.json` exported by the user's TokenBar menu-bar app; no API keys are touched. Data older than 60 minutes is `stale`: use it, but mention it in the report.
   - DeepSeek: reads `deepseek.<currency>` from `status.json` (falls back to `deepseek-ledger.json`). `low` (under $1) → do not dispatch pay-as-you-go DeepSeek; use the next model in the ranking.
   - Qwen token plan: reads `qwen.percentLeft` from `status.json` (with the reset date); under 10% is `low` → use the next model in the ranking. When `unknown` (TokenBar not running or not exporting), ask the user to glance at the menu bar before sending a lot of work to Qwen, and note "Qwen allowance not confirmed" in the report.
   - Zen free models need no allowance check, but they are rate-limited; too much parallelism gets blocked.
5. **A model fails at dispatch time** (cannot be called, expired key): re-probe just that one and update the cache — `oc-models.mjs --probe --cache <scratchpad>/oc-inventory.json --only <model ID>` — then rank again. No full re-inventory.

### Allocation rules (set by the user on 2026-10-19; implemented by `oc-rank.mjs`)

**These are defaults, not hard rules.** If the user names a model (for example the paid entry when in a hurry), use it without re-applying the rules or asking back; only mention it once if the model is clearly unsuitable (context too small, allowance `low`, clearly weaker on benchmarks), and the user's decision stands. Without a named model, follow the rules below; borderline cases (gap right around 5 / 10 points, speed difference around 30%) may be judged by the nature of the task — explain the reasoning in the report.

- **Capability first, compared per category**: decide which category the task belongs to and compare only that category's benchmarks. The primary benchmark is the one in that category that the most usable models have; the top scorer on it leads. Every other model is compared with the leader by the mean difference on **shared benchmarks** (same name and version). Discount vendor-reported numbers; an independent result wins when one exists.
- **Gap definitions**: ≤5 points = same capability; 5–10 points = close; >10 points = clearly weaker (pick the stronger one). Mixed wins and losses count as close.
- **If a Qwen token-plan model is within 10 points, use it** (flat monthly fee, allowance usually left over; the user decided **token plan beats speed**): highest score first, speed breaks ties.
- If no token-plan model is within 10 points: **among models within 5 points, pick the fastest** (within 30% counts as equally fast; when equally fast, free > Go > pay-as-you-go). Pay-as-you-go is used only when no free / Go model is within 10 points; otherwise apply the same rule again among the free / Go models (within 5 first, then within 10).
- **Free before paid** (user, restated 2026-10-19): when the free and paid entries are close (≤10 points), use the free one; do not switch to the paid entry just because it is faster. Paid is used only when the user asks for it. Example: DeepSeek V4.1 Flash free and paid gave the same quality (both passed review first try); the paid entry was about 2.8× faster, and the free one is still the default.
- **Never use a clearly weaker model because of its plan** (e.g. the free DeepSeek V4.1 Flash is well ahead of Qwen 3.7).
- Anonymous models with no shared benchmarks: run the same representative small task on both and let Claude review — both pass = same; one fails = clearly weaker.
- **Shadow runs of anonymous models: on by default** (user, 2026-10-19). Whenever a task is dispatched for execution and the conditions hold, every usable anonymous model runs it alongside and the result is recorded — no need to ask the user.
  - **Which models are anonymous**: models marked `stealth: true` in `scores.json`. A new usable model that the table does not have yet goes through step 2 of the workflow first; only if no external benchmark can be found does it get an entry with `stealth: true` and count as anonymous. When one model has several entries (Zen free, Go), only one shadow-runs — the cheapest (`oc-rank.mjs` picks it).
  - **Conditions** (all must hold; explain in the report when one does not):
    1. Enough context: the task's estimated usage (files to read, test output, length of the continued session) fits the model's limit.
    2. Isolation: it can run from the same clean base in its own worktree (or folder), branch and port, without touching the formal run or the user's environment.
    3. No external effects: the task itself needs no push, deploy, production database write, outgoing message or secret, and its definition of done can be verified locally.
    4. Not a small read-only query (find a file, answer a question) — those produce nothing comparable.
  - **How**: the shadow run gets the same spec as the formal run (merge spec changes made midway, drop parts that only matter for production) and the same `taskId`. Claude reviews it by the same standard and re-runs the tests; when possible, the formal run's tests are used to cross-check the shadow result. Record it with `oc-track.mjs add` (see "Internal score" below).
  - Shadow results are never merged; they are scoring records only. If one is better than the formal run, consider switching (ask the user first). After review, delete the worktree, keep the branch, and clean up leftover processes.
  - Anonymous models have no external benchmarks, so the internal score is their only basis.
- **Internal score** (user, 2026-10-19): graded from this setup's own dispatch history, **weighted 2× external benchmarks** (`INTERNAL_WEIGHT` in `oc-rank.mjs`). Gap = (mean shared external gap + 2 × internal gap) ÷ 3; if only one side has an internal score, compare external only; with no shared external benchmark, compare internal only. If the blended gap shows anyone stronger than the primary-benchmark leader, that model leads instead.
  - **Record every dispatch after review** (formal or shadow): `node ~/.agents/skills/opencode-dispatch/scripts/oc-track.mjs add --json '<record>'` (or `--file <file>`; dry-run with `grade --json`). It grades the run and updates `internal` in `scores.json`. `model` must be one of the `aliases` of an entry in `scores.json`; add an entry first if needed. Fields and grading are documented in the `oc-track.mjs` header:
    - Fields: `date`, `project`, `task`, `category`, `model` (the entry ID actually used), `seconds` / `steps` / `inputTokens` (from the `oc-run` summary's `seconds`, `steps`, `tokens.input`; for interrupted-and-resumed runs, sum them and explain in `remarks`), `result` (`passed` / `passed-after-return` / `failed` / `aborted`, optionally followed by `, merged` or `, not merged (shadow)`), `returns`, `defects` (`{severity: major|minor, text}`, including what Claude fixed itself), `scope` (number of edits outside the allowed files), `rerunFail`, `taskId`, `speedComparable`, `remarks`, `reconstructed` (true when rebuilt after the fact). Required: `date`, `task`, `category`, `model`, `result`.
    - Grade: 100 − 10×returns − 15×major defects − 5×minor defects − 5×scope − 10×(Claude's test rerun failed); `failed` or `aborted` caps it at 40. Speed is not part of the grade (the rules compare speed separately). Internal score = mean of the last 10 records in the category.
    - Returns count only the model's own faults; spec changes, user interruptions and environment problems do not. Major defect = would break production, lose data, weaken security, or violate the spec.
  - **Task completion speed** (user, 2026-10-19): response latency (the probe seconds) does not predict how fast a model actually finishes work, so completion time is recorded separately. When several models do the same task (formal + shadow, A/B), give them the same `taskId`; `oc-track.mjs` computes each run's `speedRatio` (÷ the fastest passing run of that task, 1.0 = fastest) and aggregates it per model entry into `internal.<category>.speed.<entry>` (median ratio, number of comparisons, median seconds). Runs whose time is not comparable (spec changed midway, waited on the user) get `speedComparable: false`. When `oc-rank.mjs` compares speed, it uses task speed if every candidate has it, otherwise falls back to probe latency and says so in the reasoning.
    - Speed ratios are approximations merged across tasks; treat them as a hint while comparisons are few. **Anonymous models especially need shadow runs** to build this up — they have no external data.
  - `oc-track.mjs show [--model <ID or key>] [--category c] [--last N]` lists past records, one line each; `recompute` rebuilds every internal score from `track.jsonl` (run it after changing the grading rules).
- In parallel dispatch, a provider may limit concurrent connections; when you hit it, spread work across providers.
- When reporting an allocation, include: task category, the model used, `oc-rank.mjs`'s reasoning, and the cost (`cost`).

## Dispatch mode: subagent loop (user's choice)

opencode is the subagent, Claude is the manager. **Split tasks and dispatch them to opencode first; Claude does only what cannot be split off** (user, 2026-10-19): Claude cuts tasks, writes specs, picks models, reviews and merges, and handles parts that need overall judgment or involve credentials / external operations; any implementation that can be written as a standalone, verifiable spec is dispatched. **Dispatch → monitor → review → return with directions → repeat until the result meets the goal.** Claude does not fix the code for it; problems go back to the same session as concrete directions so the model fixes them itself. Claude takes over only when the user asks, or after several returns still fail — and tells the user why.

1. **Cut the task**: one task does one thing. State the scope, which files may / may not change, the definition of done (e.g. "all tests pass, one commit per round"), and what the final report must contain. opencode cannot see this conversation, so put the background in the task description. Use `--prompt-file` for long descriptions.
2. **Pick the model**: use the user's model if named. Otherwise follow "Choosing a model" above — rank with `oc-rank.mjs` and apply the allocation rules (capability first, not simply cheap and fast); parts that need overall judgment and cannot be written as a spec stay with Claude. When unsure, try a small run with the `plan` agent first. Schedule shadow runs of anonymous models when the conditions hold.
3. **Dispatch**:
   - Short tasks (under a minute): run directly.
   - Long tasks: Bash with `run_in_background: true`; you are notified on completion — do not poll.
   - Parallel: several background calls, **each with its own `--dir`** (separate folders or git worktrees); never let two `build` tasks edit the same files.
4. **Monitor**: the log (`--log`) is written live; to check progress, read the last few tool calls in it — never the whole file. `git log` in the worktree shows what it has committed.
5. **Review** (every time it reports done):
   - Read its report, but do not treat it as evidence.
   - Look at `git log` and `git diff` yourself: scope creep, forbidden files touched, cosmetic-only changes, deleted or loosened tests.
   - Run the build and tests yourself.
   - Tick off the definition of done item by item.
6. **Return**: if it falls short, continue the same `--session` and state: what does not meet the spec (file:line), why, the direction to change, and this round's definition of done. Each return covers only what needs changing; do not repeat the whole background.
7. **Wrap up**: once it meets the goal, report to the user: number of rounds, each round's problems and fixes, how many returns and why, the model used, total `cost`. Ask the user before merging, pushing or deploying.

## Safety rules

- **The `build` agent runs shell commands and edits files without asking** (observed: it edited files even without `--auto`). Run it only in folders it is allowed to touch; before touching the user's repo, create a branch or worktree.
- **The `plan` agent is not a sandbox**: it refuses to edit files but still runs shell commands (observed running `wc -l`). For real isolation, copy the files to a temporary folder and dispatch there.
- Do not add `--auto` (it auto-approves every "ask" permission); the script does not support it.
- **Every task description must say: find servers to stop only with `lsof -ti tcp:<port> -sTCP:LISTEN`; never `kill -9` PIDs from a plain `lsof -i`; never `pkill node` / `pkill -f opencode`.** Observed: opencode ran `kill -9` on the output of `lsof` without `-sTCP:LISTEN` and killed its own process (the list includes clients connected to the port).
- **Clean up leftover processes at the end**: `lsof … -sTCP:LISTEN | xargs kill` stops only the `workerd` listening on the port; the outer `npm exec wrangler dev` / `node …wrangler` processes linger (one shadow-run batch on 2026-10-19 left 45 of them). After reviewing each batch, Claude finds them with `pgrep -f "wrangler dev .*--port (<ports used by this batch>)( |$)"` and kills them; in zsh the PID list must be written `kill ${=pids}` or it is not split. Clean only this batch's ports; never touch the user's own dev servers.
- Wrap long tasks as `(trap '' INT; node oc-run.mjs …)`: background runs were interrupted by SIGINT twice; with SIGINT ignored they finish.
- After an interruption: the worktree may hold uncommitted changes. Continue the same `--session`, explain the interruption, and ask it to carry on from the existing changes instead of starting over.
- Never put secrets (API keys, passwords, tokens) in task descriptions. opencode stores sessions in its database and may send them to third-party model providers.
- `~/.config/opencode/opencode.json` holds API keys in plain text; filter out key / token / secret fields when reading the config.

## Common commands

```bash
opencode models                                   # available models
opencode session list -n 20 --format json         # recent sessions (run in the matching folder)
opencode session export <sessionID>               # export a full conversation
opencode service status                           # background service address
```

The background service's web UI is at the address `opencode service status` prints; open it when the user wants to see what opencode is doing.
