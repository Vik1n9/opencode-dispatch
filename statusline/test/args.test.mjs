// Pure parsers: ps etime formats and process argument scanning.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { makeHome } from './helpers.mjs';

const HOME = makeHome();
process.env.HOME = HOME;
process.env.TMPDIR = `${HOME}/tmp`;
const m = await import('../statusline-agents.mjs');
after(() => rmSync(HOME, { recursive: true, force: true }));

test('elapsed parses every ps etime format', () => {
  const cases = {
    '00:05': '5s', '00:59': '59s', '01:00': '1m', '12:34': '12m', '59:59': '59m',
    '01:00:00': '1h00m', '01:05:59': '1h05m', '1-00:00:00': '24h00m', '2-03:04:05': '51h04m',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(m.elapsed(input), expected, input);
  assert.equal(m.elapsed('garbage'), '');
  assert.equal(m.elapsed(''), '');
});

test('argOf: quoted title may contain flags; trailing prompt is not swallowed', () => {
  const args = 'node /x/oc-run.mjs --title "fix --model bug" --model openai/gpt-5 --log /tmp/l "do it"';
  assert.equal(m.argOf(args, '--title', true), 'fix --model bug');
  assert.equal(m.argOf(args, '--model'), 'openai/gpt-5');
  assert.equal(m.argOf(args, '--log'), '/tmp/l');
});

test('argOf: --title= and unquoted multi-word titles', () => {
  assert.equal(m.argOf('node x.mjs --title=Hello World --log /l', '--title', true), 'Hello World');
  assert.equal(m.argOf('node x.mjs --title Hello World --log /l', '--title', true), 'Hello World');
  assert.equal(m.argOf('node x.mjs --title Hello World --model q', '--model'), 'q');
  assert.equal(m.argOf('node x.mjs --log "/a b/c.jsonl" --title t', '--log'), '/a b/c.jsonl');
});

test('argOf: missing or empty title stays empty', () => {
  assert.equal(m.argOf('node x.mjs --title= --model q', '--title', true), '');
  assert.equal(m.argOf('node x.mjs --title "" --model q', '--title', true), '');
  assert.equal(m.argOf('node x.mjs --model q', '--title', true), '');
});
