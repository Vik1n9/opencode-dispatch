# TODO

## TokenBar measurements
- [ ] Export OpenCode Go usage per model from TokenBar into `status.json` (5-hour, weekly and monthly windows with `percentLeft` and `resetsAt`, like `qwen.windows`), so `estimateReset()` can use real reset times for Go instead of the 1 h → 5 h → 24 h ladder, and `oc-quota.mjs` can warn before a Go model runs out.
- [ ] If Zen free usage becomes visible anywhere (console or API), export it the same way.
- [ ] Once exported: read it in `lib.mjs` `estimateReset()` (plan `go`) and `oc-quota.mjs`, with tests on a fixture `status.json`.

## Limits
- [ ] Record the first real rate-limit / quota error text seen from Zen free and Go models and add it to the `LIMIT_RE` / `parseReset` tests.

## Benchmark table
- [ ] Add the usable models that `oc-rank.mjs` lists as "not in the benchmark table yet" with `oc-bench.mjs` (benchmark name with version, independent beats vendor; none found → `--stealth`).
