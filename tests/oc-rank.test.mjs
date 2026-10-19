import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeSandbox, runScript, writeShim, writeJson, SHIM_OK } from './helpers.mjs';

const CAT = 'repo-coding';
const BENCH = 'SWE-bench Verified';

// Synthetic score table: one category, one benchmark unless stated.
function table(models, { benchmarks = [BENCH], category = CAT } = {}) {
  return {
    categories: { [category]: { label: 'Fix bugs', benchmarks } },
    models: Object.fromEntries(models.map((m) => [m.key, {
      name: m.name ?? m.key,
      aliases: m.aliases,
      scores: Object.fromEntries(Object.entries(m.scores ?? {}).map(([b, value]) => [b, { value, source: 'vendor' }])),
      ...(m.internal ? { internal: m.internal } : {}),
      ...(m.stealth ? { stealth: true } : {}),
    }])),
  };
}

function cache(models) {
  return {
    created: '2026-10-19T00:00:00.000Z',
    probed: true,
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      live: m.live ?? true,
      context: 'context' in m ? m.context : 400000,
      ...(m.noProbe ? {} : { probe: { ok: m.probeOk ?? true, seconds: m.seconds ?? 10 } }),
    })),
  };
}

function setup(t, { scores, inventory, category = CAT }) {
  const sb = makeSandbox();
  writeShim(sb);
  const scoresPath = join(sb.dir, 'scores.json');
  const cachePath = join(sb.dir, 'inventory.json');
  writeJson(scoresPath, scores);
  writeJson(cachePath, inventory);
  const rank = (extra = []) => runScript(sb, 'oc-rank.mjs',
    ['--cache', cachePath, '--task', category, '--scores', scoresPath, ...extra], { env: SHIM_OK });
  return { sb, scoresPath, cachePath, rank };
}

const json = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.json;
};

test('oc-rank: capability first — a clearly weaker token-plan model is never picked', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'strong', aliases: ['opencode/strong-free'], scores: { [BENCH]: 80 } },
      { key: 'weak-token', aliases: ['bailian-token-plan-personal/weak'], scores: { [BENCH]: 60 } },
    ]),
    inventory: cache([
      { id: 'opencode/strong-free', seconds: 20 },
      { id: 'bailian-token-plan-personal/weak', seconds: 1 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/strong-free');
  assert.ok(r.results[0].trail.some((x) => x.startsWith('strongest:')));
});

test('oc-rank: a token-plan model within 10 points wins (token plan beats speed)', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'strong', aliases: ['opencode/strong-free'], scores: { [BENCH]: 80 } },
      { key: 'token', aliases: ['bailian-token-plan-personal/token'], scores: { [BENCH]: 72 } },
    ]),
    inventory: cache([
      { id: 'opencode/strong-free', seconds: 1 },
      { id: 'bailian-token-plan-personal/token', seconds: 50 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'bailian-token-plan-personal/token');
  assert.ok(r.results[0].trail.some((x) => /Qwen token plan within 10/.test(x)));
});

test('oc-rank: a token-plan model more than 10 points behind is not used', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'strong', aliases: ['opencode/strong-free'], scores: { [BENCH]: 80 } },
      { key: 'token', aliases: ['bailian-token-plan-personal/token'], scores: { [BENCH]: 60 } },
    ]),
    inventory: cache([
      { id: 'opencode/strong-free', seconds: 1 },
      { id: 'bailian-token-plan-personal/token', seconds: 1 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/strong-free');
  assert.ok(!r.results[0].trail.some((x) => /Qwen token plan/.test(x)));
});

test('oc-rank: among models within 5 points the fastest wins, even over a cheaper plan', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'fast-go', aliases: ['opencode-go/fast'], scores: { [BENCH]: 80 } },
      { key: 'slow-free', aliases: ['opencode/slow-free'], scores: { [BENCH]: 79 } },
    ]),
    inventory: cache([
      { id: 'opencode-go/fast', seconds: 10 },
      { id: 'opencode/slow-free', seconds: 30 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode-go/fast');
});

test('oc-rank: within 30% counts as equally fast, then free beats Go', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'go', aliases: ['opencode-go/a'], scores: { [BENCH]: 80 } },
      { key: 'free', aliases: ['opencode/b-free'], scores: { [BENCH]: 79 } },
    ]),
    inventory: cache([
      { id: 'opencode-go/a', seconds: 10 },
      { id: 'opencode/b-free', seconds: 12 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/b-free');
  assert.ok(r.results[0].trail.some((x) => /similar speed: cheaper plan/.test(x)));
});

test('oc-rank: within 30% counts as equally fast, then Go beats pay-as-you-go', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'paid', aliases: ['deepseek/paid'], scores: { [BENCH]: 80 } },
      { key: 'go', aliases: ['opencode-go/a'], scores: { [BENCH]: 79 } },
    ]),
    inventory: cache([
      { id: 'deepseek/paid', seconds: 10 },
      { id: 'opencode-go/a', seconds: 12 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode-go/a');
});

test('oc-rank: pay-as-you-go is used only when no free / Go model is within 10 points', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'paid', aliases: ['deepseek/paid'], scores: { [BENCH]: 90 } },
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 70 } },
      { key: 'go', aliases: ['opencode-go/go'], scores: { [BENCH]: 65 } },
    ]),
    inventory: cache([
      { id: 'deepseek/paid', seconds: 10 },
      { id: 'opencode/free', seconds: 30 },
      { id: 'opencode-go/go', seconds: 5 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'deepseek/paid');
});

test('oc-rank: free within 10 points beats a faster paid leader', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'paid', aliases: ['deepseek/paid'], scores: { [BENCH]: 90 } },
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 82 } },
    ]),
    inventory: cache([
      { id: 'deepseek/paid', seconds: 1 },
      { id: 'opencode/free', seconds: 40 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/free');
  assert.ok(r.results[0].trail.some((x) => /pay-as-you-go only when no free \/ Go model is within 10/.test(x)));
});

test('oc-rank: task speed is preferred over probe latency when every candidate has it', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'latency-fast', aliases: ['opencode/latency-free'], scores: { [BENCH]: 80 },
        internal: { [CAT]: { score: 80, n: 2, speed: { 'opencode/latency-free': { ratio: 3, n: 2, medianSeconds: 300 } } } } },
      { key: 'task-fast', aliases: ['opencode/task-free'], scores: { [BENCH]: 79 },
        internal: { [CAT]: { score: 80, n: 2, speed: { 'opencode/task-free': { ratio: 1, n: 2, medianSeconds: 100 } } } } },
    ]),
    inventory: cache([
      { id: 'opencode/latency-free', seconds: 1 },
      { id: 'opencode/task-free', seconds: 9 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/task-free');
  assert.ok(r.results[0].trail.some((x) => /measured task speed/.test(x)));
});

test('oc-rank: the internal score weighs 2x in the gap formula', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'leader', aliases: ['opencode/leader-free'], scores: { [BENCH]: 80 },
        internal: { [CAT]: { score: 80, n: 2 } } },
      { key: 'low-internal', aliases: ['opencode/low-free'], scores: { [BENCH]: 70 },
        internal: { [CAT]: { score: 50, n: 2 } } },
      { key: 'equal-internal', aliases: ['opencode/equal-free'], scores: { [BENCH]: 70 },
        internal: { [CAT]: { score: 80, n: 2 } } },
    ]),
    inventory: cache([
      { id: 'opencode/leader-free' },
      { id: 'opencode/low-free' },
      { id: 'opencode/equal-free' },
    ]),
  });
  const r = json(rank(['--json']));
  const rows = new Map(r.results[0].ranking.map((x) => [x.id, x]));
  // (10 external + 2 x 30 internal) / 3
  assert.equal(rows.get('opencode/low-free').gap.toFixed(2), '23.33');
  // (10 external + 2 x 0 internal) / 3
  assert.equal(rows.get('opencode/equal-free').gap.toFixed(2), '3.33');
});

test('oc-rank: a blended gap can replace the primary-benchmark leader', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'ext-leader', aliases: ['opencode/ext-free'], scores: { [BENCH]: 80 },
        internal: { [CAT]: { score: 50, n: 2 } } },
      { key: 'internal-leader', aliases: ['opencode/int-free'], scores: { [BENCH]: 76 },
        internal: { [CAT]: { score: 90, n: 2 } } },
    ]),
    inventory: cache([{ id: 'opencode/ext-free' }, { id: 'opencode/int-free' }]),
  });
  const r = json(rank(['--json']));
  // (4 external + 2 x -40 internal) / 3 = -25.3: the internal leader leads
  assert.equal(r.results[0].pick, 'opencode/int-free');
});

test('oc-rank: live:false and failed probes are excluded', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'retired', aliases: ['opencode/retired-free'], scores: { [BENCH]: 99 } },
      { key: 'failing', aliases: ['opencode/failing-free'], scores: { [BENCH]: 98 } },
      { key: 'good', aliases: ['opencode/good-free'], scores: { [BENCH]: 70 } },
    ]),
    inventory: cache([
      { id: 'opencode/retired-free', live: false },
      { id: 'opencode/failing-free', probeOk: false },
      { id: 'opencode/good-free' },
    ]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/good-free');
  assert.deepEqual(r.results[0].ranking.map((x) => x.id), ['opencode/good-free']);
});

test('oc-rank: --min-context drops small and unknown contexts and reports the unknown ones', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'big', aliases: ['opencode/big-free'], scores: { [BENCH]: 80 } },
      { key: 'small', aliases: ['opencode/small-free'], scores: { [BENCH]: 79 } },
      { key: 'unknown', aliases: ['opencode/unknown-free'], scores: { [BENCH]: 78 } },
    ]),
    inventory: cache([
      { id: 'opencode/big-free', context: 400000 },
      { id: 'opencode/small-free', context: 100000 },
      { id: 'opencode/unknown-free', context: null },
    ]),
  });
  const r = json(rank(['--json', '--min-context', '200000']));
  assert.equal(r.results[0].pick, 'opencode/big-free');
  assert.deepEqual(r.results[0].ranking.map((x) => x.id), ['opencode/big-free']);
  assert.deepEqual(r.droppedUnknownContext, ['opencode/unknown-free']);

  const text = rank(['--min-context', '200000']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /dropped \(context unknown, --min-context 200000\): opencode\/unknown-free/);
});

test('oc-rank: non-transitive gaps pick the best primary score in the cycle', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'a', aliases: ['opencode/a-free'], scores: { Alpha: 90, Beta: 50 } },
      { key: 'b', aliases: ['opencode/b-free'], scores: { Alpha: 50, Gamma: 90 } },
      { key: 'c', aliases: ['opencode/c-free'], scores: { Beta: 90, Gamma: 50 } },
    ], { benchmarks: ['Alpha', 'Beta', 'Gamma'] }),
    inventory: cache([{ id: 'opencode/a-free' }, { id: 'opencode/b-free' }, { id: 'opencode/c-free' }]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, 'opencode/a-free');
  assert.ok(r.results[0].trail.some((x) => /gaps are not transitive among/.test(x)));
});

test('oc-rank: shadow holds stealth models once at the cheapest plan; unknown models go to notInTable', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'stealth', aliases: ['opencode/stealth-free', 'opencode-go/stealth'], stealth: true, scores: {} },
      { key: 'plain', aliases: ['opencode/plain-free'], scores: { [BENCH]: 80 } },
    ]),
    inventory: cache([
      { id: 'opencode-go/stealth', context: 200000 },
      { id: 'opencode/stealth-free', context: 400000 },
      { id: 'opencode/plain-free' },
      { id: 'opencode/unknown-free', context: 128000 },
    ]),
  });
  const r = json(rank(['--json']));
  assert.deepEqual(r.shadow, [{ id: 'opencode/stealth-free', context: 400000, known: true }]);
  assert.deepEqual(r.notInTable, [{ id: 'opencode/unknown-free', context: 128000, known: false }]);
  assert.ok(!r.shadow.some((m) => m.id === 'opencode/plain-free'));

  const text = rank();
  assert.equal(text.status, 0);
  assert.match(text.stdout, /shadow-run candidates .*opencode\/stealth-free \(context 400k\)/);
  assert.match(text.stdout, /not in the score table yet .*opencode\/unknown-free \(context 128k\)/);
});

test('oc-rank: bad input files and options exit 2 with one lower-case line', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const scoresPath = join(sb.dir, 'scores.json');
  const cachePath = join(sb.dir, 'inventory.json');
  writeJson(scoresPath, table([{ key: 'a', aliases: ['opencode/a-free'], scores: { [BENCH]: 80 } }]));
  writeJson(cachePath, cache([{ id: 'opencode/a-free' }]));

  const run = (args) => runScript(sb, 'oc-rank.mjs', args, { env: SHIM_OK });
  const cases = [
    { args: ['--task', CAT, '--scores', scoresPath], why: /usage: oc-rank\.mjs/ },
    { args: ['--cache', cachePath, '--scores', scoresPath], why: /usage: oc-rank\.mjs/ },
    { args: ['--cache', join(sb.dir, 'missing.json'), '--task', CAT, '--scores', scoresPath], why: /cannot read/ },
    { args: ['--cache', cachePath, '--task', CAT, '--scores', join(sb.dir, 'missing.json')], why: /cannot read/ },
    { args: ['--cache', cachePath, '--task', CAT, '--scores', scoresPath, '--min-context', 'nope'], why: /--min-context must be a finite number/ },
    { args: ['--cache', cachePath, '--task', CAT, '--scores', scoresPath, '--min-context', '-1'], why: /--min-context must be a finite number/ },
  ];
  for (const c of cases) {
    const r = run(c.args);
    assert.equal(r.status, 2, c.args.join(' '));
    assert.match(r.stderr, c.why);
  }

  const badCache = join(sb.dir, 'bad-cache.json');
  writeJson(badCache, { models: 'nope' });
  const r1 = run(['--cache', badCache, '--task', CAT, '--scores', scoresPath]);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /has no models array/);

  const badScores = join(sb.dir, 'bad-scores.json');
  writeJson(badScores, { models: {} });
  const r2 = run(['--cache', cachePath, '--task', CAT, '--scores', badScores]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /has no models or categories/);

  const r3 = run(['--cache', cachePath, '--task', 'nope', '--scores', scoresPath]);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /unknown task category: nope/);

  const broken = join(sb.dir, 'broken.json');
  writeJson(broken, {});
  const r4 = run(['--cache', broken, '--task', CAT, '--scores', scoresPath]);
  assert.equal(r4.status, 2);
  assert.match(r4.stderr, /has no models array/);
});

test('oc-rank: a category with no scores lists the models that need a trial', (t) => {
  const { rank } = setup(t, {
    scores: table([{ key: 'a', aliases: ['opencode/a-free'], scores: {} }]),
    inventory: cache([{ id: 'opencode/a-free' }]),
  });
  const r = json(rank(['--json']));
  assert.equal(r.results[0].pick, null);
  assert.deepEqual(r.results[0].unscored, ['opencode/a-free']);
  const text = rank();
  assert.match(text.stdout, /no scores in this category -> compare with a small trial task/);
});

test('oc-rank: a cache without probe results warns that availability is unconfirmed', (t) => {
  const { rank } = setup(t, {
    scores: table([{ key: 'a', aliases: ['opencode/a-free'], scores: { [BENCH]: 80 } }]),
    inventory: { created: 'x', models: [{ id: 'opencode/a-free', name: 'a', live: true, context: 400000 }] },
  });
  const r = rank();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the cache has no probe results \(built without --probe\); availability not confirmed/);
  assert.equal(r.json, null);
});

test('oc-rank: --task all ranks every category', (t) => {
  const sb = makeSandbox();
  writeShim(sb);
  const scoresPath = join(sb.dir, 'scores.json');
  const cachePath = join(sb.dir, 'inventory.json');
  const data = table([{ key: 'a', aliases: ['opencode/a-free'], scores: { [BENCH]: 80, 'Terminal-Bench 2.1': 70 } }]);
  data.categories.terminal = { label: 'Terminal', benchmarks: ['Terminal-Bench 2.1'] };
  writeJson(scoresPath, data);
  writeJson(cachePath, cache([{ id: 'opencode/a-free' }]));
  const r = runScript(sb, 'oc-rank.mjs', ['--cache', cachePath, '--task', 'all', '--scores', scoresPath, '--json'], { env: SHIM_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.results.map((x) => x.category), ['repo-coding', 'terminal']);
  assert.equal(r.json.results[1].pick, 'opencode/a-free');
});

test('oc-rank: SAME boundary — a gap of exactly 5 is same capability and may pick the faster model', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'leader', aliases: ['opencode/leader-free'], scores: { [BENCH]: 80 } },
      { key: 'faster', aliases: ['opencode/faster-free'], scores: { [BENCH]: 75 } },
    ]),
    inventory: cache([
      { id: 'opencode/leader-free', seconds: 10 },
      { id: 'opencode/faster-free', seconds: 1 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode/faster-free');
});

test('oc-rank: SAME boundary — a gap of 6 is not same capability', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'leader', aliases: ['opencode/leader-free'], scores: { [BENCH]: 80 } },
      { key: 'faster', aliases: ['opencode/faster-free'], scores: { [BENCH]: 74 } },
    ]),
    inventory: cache([
      { id: 'opencode/leader-free', seconds: 10 },
      { id: 'opencode/faster-free', seconds: 1 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode/leader-free');
});

test('oc-rank: CLOSE boundary — a token-plan model at gap exactly 10 wins', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 } },
      { key: 'token', aliases: ['bailian-token-plan-personal/token'], scores: { [BENCH]: 70 } },
    ]),
    inventory: cache([
      { id: 'opencode/free', seconds: 1 },
      { id: 'bailian-token-plan-personal/token', seconds: 100 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'bailian-token-plan-personal/token');
});

test('oc-rank: CLOSE boundary — a token-plan model at gap 11 loses', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 } },
      { key: 'token', aliases: ['bailian-token-plan-personal/token'], scores: { [BENCH]: 69 } },
    ]),
    inventory: cache([
      { id: 'opencode/free', seconds: 1 },
      { id: 'bailian-token-plan-personal/token', seconds: 100 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode/free');
});

test('oc-rank: CLOSE boundary — rule 4 falls back to a free model at gap exactly 10', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'paid', aliases: ['deepseek/paid'], scores: { [BENCH]: 90 } },
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 } },
    ]),
    inventory: cache([
      { id: 'deepseek/paid', seconds: 1 },
      { id: 'opencode/free', seconds: 100 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode/free');
});

test('oc-rank: CLOSE boundary — rule 4 keeps pay-as-you-go when the nearest free model is at gap 11', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'paid', aliases: ['deepseek/paid'], scores: { [BENCH]: 90 } },
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 79 } },
    ]),
    inventory: cache([
      { id: 'deepseek/paid', seconds: 1 },
      { id: 'opencode/free', seconds: 100 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'deepseek/paid');
});

test('oc-rank: SPEED_EQUAL latency — a 1.25x difference is equally fast, so the cheaper plan wins', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 } },
      { key: 'go', aliases: ['opencode-go/go'], scores: { [BENCH]: 79 } },
    ]),
    inventory: cache([
      { id: 'opencode/free', seconds: 12.5 },
      { id: 'opencode-go/go', seconds: 10 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode/free');
});

test('oc-rank: SPEED_EQUAL latency — a 1.4x difference wins on speed regardless of plan', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 } },
      { key: 'go', aliases: ['opencode-go/go'], scores: { [BENCH]: 79 } },
    ]),
    inventory: cache([
      { id: 'opencode/free', seconds: 14 },
      { id: 'opencode-go/go', seconds: 10 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode-go/go');
});

test('oc-rank: SPEED_EQUAL task speed — a 1.25x difference is equally fast, so the cheaper plan wins', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 },
        internal: { [CAT]: { score: 80, n: 2, speed: { 'opencode/free': { ratio: 1.25, n: 2, medianSeconds: 125 } } } } },
      { key: 'go', aliases: ['opencode-go/go'], scores: { [BENCH]: 79 },
        internal: { [CAT]: { score: 80, n: 2, speed: { 'opencode-go/go': { ratio: 1, n: 2, medianSeconds: 100 } } } } },
    ]),
    inventory: cache([
      { id: 'opencode/free', seconds: 1 },
      { id: 'opencode-go/go', seconds: 100 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode/free');
});

test('oc-rank: SPEED_EQUAL task speed — a 1.4x difference wins on speed regardless of plan', (t) => {
  const { rank } = setup(t, {
    scores: table([
      { key: 'free', aliases: ['opencode/free'], scores: { [BENCH]: 80 },
        internal: { [CAT]: { score: 80, n: 2, speed: { 'opencode/free': { ratio: 1.4, n: 2, medianSeconds: 140 } } } } },
      { key: 'go', aliases: ['opencode-go/go'], scores: { [BENCH]: 79 },
        internal: { [CAT]: { score: 80, n: 2, speed: { 'opencode-go/go': { ratio: 1, n: 2, medianSeconds: 100 } } } } },
    ]),
    inventory: cache([
      { id: 'opencode/free', seconds: 1 },
      { id: 'opencode-go/go', seconds: 100 },
    ]),
  });
  assert.equal(json(rank(['--json'])).results[0].pick, 'opencode-go/go');
});
