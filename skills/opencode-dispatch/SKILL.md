---
name: opencode-dispatch
description: Dispatch work to other models (DeepSeek, Qwen, GLM, Kimi, etc.) through the local opencode CLI (CLI mode, not MCP), with Claude Code as the dispatcher — pick the model and agent, continue sessions, run tasks in parallel, collect and verify results. Triggers — the user says "dispatch to opencode", "run it with opencode", "let other models do it", "orchestrate opencode", "opencode subagent", or wants to hand mechanical, parallelizable work to cheaper models.
---

# opencode dispatch (CLI mode)

Claude is the manager, opencode the worker. Claude cuts tasks, writes specs, picks models, reviews, merges, and keeps anything that needs overall judgment, credentials or external operations; every implementation that can be written as a standalone, verifiable spec is dispatched. Every call goes through `scripts/oc-run.mjs` — never `opencode run` directly (it hangs on open stdin, takes the project from `$PWD`, and falls back to an unpredictable default model).

**Do it yourself instead** when the spec would be about as long as the change (one small file, a few dozen lines): spec plus review then costs Claude more than writing it. Dispatching pays off from roughly 200 lines across files, for long test-fix loops and for parallel work; it is slower in wall time. If the user asks to dispatch, dispatch.

## Scripts and data

Scripts: `node ~/.agents/skills/opencode-dispatch/scripts/<name>`. Each file header documents its options and formats — read it only when you need a detail.

| Script | Does |
|---|---|
| `oc-models.mjs --probe` | Inventory (official Zen / Go lists first), probes rankable models; instant when the cache is < 12 h old (`--force`, `--only <id>`, `--probe-all`). A model that misses the 30 s probe timeout is not used until the next probe |
| `oc-rank.mjs --task <category>` | Pick + reasoning, shadow candidates, blocked models (`--min-context <tokens>`). Categories: `repo-coding` `terminal` `greenfield` `tools` `gui-vision` `reasoning` `security` `instruction` `long-context` `all` |
| `oc-quota.mjs` | DeepSeek balance, Qwen token plan (TokenBar), active limit blocks |
| `oc-run.mjs --model <id> --dir <dir> --title <t> "<task>"` | One run → JSON summary (`ok`, `sessionID`, `seconds`, `steps`, `tokens`, `cost`, `errors`, `limited`, `log`); `--session`, `--fork`, `--agent plan`, `--prompt-file`. Never read the log whole |
| `oc-track.mjs add --json '<record>'` | Record a reviewed run; also `show`, `compare --task-id`, `recompute`, `grade` |
| `oc-bench.mjs lint` | Check `benchmarks.json`; `add-model`, `add-alias`, `set-score` edit it safely |

Data `~/.config/opencode-dispatch/` (`$OC_DISPATCH_HOME` for sandboxes): `benchmarks.json` (curated, linked to the repo), `track.jsonl` (history, not read routinely), `internal.json` (derived, never edit), `limits.json`. Cache `~/.cache/opencode-dispatch/inventory.json` (`$OC_DISPATCH_CACHE`).

## Workflow

1. **Inventory**: `oc-models.mjs --probe`. Official lists are the truth; the local catalog lags. Plans: Zen — only models marked Free; Go — subscribed, counts against its allowance; Contributor models train on data; free / Contributor terms cover ordinary code only. `API key has expired` → the user makes a key in the OpenCode Console and runs `opencode auth login` (never enter keys).
2. **Rank**: `oc-rank.mjs --task <category>`. Models missing from `benchmarks.json` are listed last; add them with `oc-bench.mjs` (benchmark name with version, independent beats vendor; none found → `--stealth`) when one is a plausible pick or the user asks — not on every start.
3. **Allowance**: `oc-quota.mjs`. DeepSeek `low` (< $1) or Qwen `low` (< 10 %) → next model in the ranking; Qwen `unknown` → ask the user to glance at TokenBar before sending a lot, note "Qwen allowance not confirmed"; data older than 60 min is `stale` — use it, mention it. Zen free needs no check but is rate-limited.
4. **Cut the task**: one task does one thing. opencode cannot see this conversation: give the background, allowed / forbidden files, definition of done (tests, one commit), what the report must contain. Long specs via `--prompt-file`. Every spec carries the Safety lines below.
5. **Dispatch** in a branch or worktree. Long tasks: Bash `run_in_background: true`, wrapped as `(trap '' INT; node oc-run.mjs …)`; you are notified — do not poll. Parallel runs each get their own `--dir`; never two `build` runs on the same files. Progress: tail of the log, `git log` in the worktree.
6. **Review** every report as a claim, not evidence: `git diff` yourself (scope creep, forbidden files, loosened tests), run the tests yourself, tick off the definition of done, check that live data and the main checkout are untouched.
7. **Return** what falls short to the same `--session`: file:line, why, direction, this round's done. Claude does not fix it for the model; it takes over only if the user asks or several returns fail — and says why.
8. **Record** every reviewed run (formal and shadow) with `oc-track.mjs add`, then **wrap up**: rounds, problems and fixes, returns and why, model, `oc-rank` reasoning, total `cost`. Ask before merging, pushing or deploying.

## Allocation rules (implemented in `oc-rank.mjs`)

Defaults, not hard rules: a model the user names is used without re-arguing (mention once if clearly unsuitable — context, `low` allowance, much weaker). Borderline cases (gap ≈ 5 / 10, speed ≈ 30 %) may follow the task's nature; explain in the report.
- Capability first, per category, on shared benchmarks (same name and version); independent results beat vendor-reported ones. Gap ≤ 5 same, ≤ 10 close, > 10 clearly weaker. Internal score weighs 2× external.
- A Qwen token-plan model within 10 points wins (token plan beats speed).
- Otherwise, among models within 5: if every candidate has measured task speed, the fastest (within 30 % = equal, then free > Go > pay-as-you-go); if not, probe latency is too noisy to rank by — free first, then Go, then pay-as-you-go, unless the user names a model.
- Free before paid when within 10 (paid only on request). Pay-as-you-go only when no free / Go model is within 10. Never a clearly weaker model because of its plan.

## Shadow runs (on by default)

Every usable `stealth` model `oc-rank` lists runs the formal task alongside (same spec, same `taskId`) when: context fits; isolated from the same base (own worktree, branch, port); no external effects and done verifiable locally; not a small read-only query. Otherwise say which failed. Same review, record, never merge (better than formal → ask about switching); delete the worktree, keep the branch. `oc-track.mjs compare --task-id <id>` shows runs side by side.

## Grading (`oc-track.mjs` header has the full field list)

Three dimensions: **correctness** (deductions for returns, major / minor defects, scope, failed rerun; `failed` caps 40), **quality** (0–100, Claude's judgment beyond defects: 90+ mergeable as-is, 75–89 good, 60–74 mediocre, 40–59 needs rework), **speed** (`speedRatio` vs the fastest passing run of the same `taskId`; `speedComparable: false` when timing is unfair). `grade` = ½ correctness + ½ quality; internal score = mean of the last 10 by date. Only the model's own faults count — not spec ambiguity, interruptions or environment. Major = breaks production, loses data, weakens security, or violates the spec.

## Usage limits and resuming

`oc-run` detects rate-limit / quota errors: summary `limited: { until, source, message }`, model blocked in `limits.json` until then (`oc-rank` skips it; success clears it). `until` is parsed from the error (Retry-After, "try again in …", reset time) or estimated by consecutive hits: Zen free 15 min → 1 h → 5 h; Go 1 h → 5 h → 24 h (Go: 20 % of the monthly limit per 5 h, 50 % per week); Qwen from TokenBar; pay-as-you-go without balance = `no-reset` (ask the user to top up). On `limited`, keep the worktree as is, then:
- `until` within ~20 min: wait (background `sleep` or the loop's wakeup), continue the same `--session`, same model.
- Later: rank again, continue the **same `--session` with `--model <next>`** (context carries over): "the previous model hit a usage limit; continue from the existing changes, do not start over".
- Record the cut-off run `result: "limited"` (not scored), the finisher with `handoffFrom` and `speedComparable: false`. Shadow runs that hit a limit: record `limited`, do not switch.

## Safety

- `build` edits files and runs shell without asking; `plan` refuses edits but still runs shell (not a sandbox — copy files to a temp folder for real isolation). Never add `--auto`.
- Every spec says: work only inside the given folder; never touch the user's main checkout or `~/.config/opencode-dispatch` (no git commands outside the given folder); prefix manual script runs with `OC_DISPATCH_HOME=<sandbox>`; stop servers only via `lsof -ti tcp:<port> -sTCP:LISTEN`; never `kill -9` PIDs from a plain `lsof -i`; never `pkill node` / `pkill -f opencode` (it kills opencode itself). Back up live data before a batch and compare hashes after.
- After each batch kill leftover `wrangler dev` wrappers too (`lsof` kills only `workerd`): `pgrep -f "wrangler dev .*--port (<this batch's ports>)( |$)"`, `kill ${=pids}` in zsh. Never the user's own servers.
- After an interruption the worktree may hold uncommitted work: continue the same session, say what happened, carry on from the changes.
- **Sensitive content never goes to a model under data-collection terms**: personal, customer, non-public business or financial data, or anything called confidential → only models the official Zen / Go privacy tables list as no training and 0-day retention (check each session — they change); if none fits, ask first.
- Never put secrets in task descriptions (opencode stores sessions and sends them to providers). `~/.config/opencode/opencode.json` holds API keys in plain text — filter key / token / secret fields when reading it.

Also: `opencode session list -n 20 --format json` (in the project), `opencode session export <id>`, `opencode service status` (web UI to watch).
