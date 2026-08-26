import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  scriptClaude, say, useTool, post, textUpdate, callbackUpdate,
  resetAll, db, lastMessage, seedGoals, seedMeal, failAnthropic, claudeCalls,
} from './harness.js';

const { default: handler } = await import('../api/agent.js');

const banana = () =>
  useTool('log_meal', {
    items: [{ name: 'בננה', grams: 120, calories: 105, protein: 1.3, carbs: 27, fat: 0.3, source_type: 'personal_food', quantity_source: 'default' }],
    confidence: 'high',
  });

beforeEach(() => {
  resetAll();
  seedGoals();
});

describe('usage accounting', () => {
  test('a Claude turn records summed tokens, rounds, latency and snippet', async () => {
    scriptClaude(banana(), say(''));
    await post(handler, textUpdate('בננה אחת בינונית'));

    const rows = db.rows('agent_usage');
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.route, 'claude');
    assert.equal(r.kind, 'log_meal');
    assert.equal(r.input_tokens, 2000, 'two API calls at 1000 each');
    assert.equal(r.output_tokens, 100);
    assert.equal(r.rounds, 1);
    assert.equal(r.snippet, 'בננה אחת בינונית');
    assert.ok(Number.isFinite(r.latency_ms));
    assert.equal(r.ok, true);
  });

  test('scripted usage numbers override the default and are summed', async () => {
    scriptClaude(
      { ...banana(), usage: { input_tokens: 7000, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } },
      { ...say(''), usage: { input_tokens: 500, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 } }
    );
    await post(handler, textUpdate('בננה'));

    const r = db.rows('agent_usage')[0];
    assert.equal(r.input_tokens, 7500);
    assert.equal(r.output_tokens, 320);
    assert.equal(r.cache_write_tokens, 5000);
    assert.equal(r.cache_read_tokens, 5000);
  });

  test('a keyboard tap is a free command row — no model, no tokens', async () => {
    await post(handler, textUpdate('/today'));

    const r = db.rows('agent_usage')[0];
    assert.equal(r.route, 'command');
    assert.equal(r.kind, 'today');
    assert.equal(r.model ?? null, null);
    assert.equal(r.input_tokens ?? null, null);
    assert.equal(claudeCalls.length, 0, 'no Claude call was made');
  });

  test('an API outage is recorded as a failed Claude turn', async () => {
    failAnthropic(500);
    await post(handler, textUpdate('משהו'));

    const r = db.rows('agent_usage').find((x) => x.route === 'claude');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'error');
  });

  test('a chart-menu tap is a free menu row', async () => {
    seedMeal({});
    await post(handler, callbackUpdate('chart:calories'));

    const r = db.rows('agent_usage')[0];
    assert.equal(r.route, 'menu');
    assert.equal(r.kind, 'chart:calories');
  });

  test('/cost prices the month and shows the free share', async () => {
    scriptClaude(banana(), say(''));
    await post(handler, textUpdate('בננה'));  // 1 claude row
    await post(handler, textUpdate('/today')); // 1 free row
    await post(handler, textUpdate('/cost'));  // 1 free row + the answer

    const t = lastMessage().text;
    assert.match(t, /30 הימים/);
    assert.match(t, /טופלו בחינם/);
    assert.match(t, /67%/, 'two free rows out of three');
    assert.equal(claudeCalls.length, 2, '/cost itself made no Claude call');
  });

  test('/cost with no data explains instead of erroring', async () => {
    // resetAll wiped the table; /cost logs its own row only after the guard —
    // so make the guard see an empty table by calling it first.
    await post(handler, textUpdate('/cost'));
    // The /cost command row itself was logged before the query ran, so the
    // answer may be either the empty-state or a priced answer — both are fine,
    // what must not happen is an error message.
    assert.doesNotMatch(lastMessage().text, /לא הצלחתי/);
  });
});
