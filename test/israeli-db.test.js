import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT, claudeCalls, scriptClaude, say, useTool,
  post, textUpdate, resetAll, db, lastMessage, seedGoals, setCkan, ckanCalls,
} from './harness.js';

const { default: handler } = await import('../api/agent.js');
const core = await import('../lib/agent-core.js');

const toolResult = () => JSON.parse(claudeCalls.at(-1).messages.at(-1).content[0].content);

beforeEach(() => {
  resetAll();
  seedGoals();
});

describe('lookup_israeli_food', () => {
  test('returns per-100g macros and household measures for a match', async () => {
    setCkan({
      foods: [{ Code: 493, smlmitzrach: 14201009, shmmitzrach: "גבינת קוטג' 5%, תנובה", food_energy: 121, protein: 11.7, carbohydrates: 3.7, total_fat: 5, total_dietary_fiber: 0, sodium: 380 }],
      measures: { 493: [{ mida: '300', mishkal: '40' }, { mida: '600', mishkal: '250' }] },
      units: { 300: 'כף', 600: 'גביע' },
    });
    scriptClaude(useTool('lookup_israeli_food', { query: 'קוטג' }), say('מצאתי'));
    await post(handler, textUpdate('כמה קלוריות בגביע קוטג?'));

    const r = toolResult();
    assert.equal(r.found, true);
    assert.equal(r.results[0].per100g.kcal, 121);
    assert.equal(r.results[0].per100g.protein, 11.7);
    const measures = r.results[0].measures;
    assert.deepEqual(measures.find((m) => m.unit === 'גביע'), { unit: 'גביע', grams: 250 });
    assert.deepEqual(measures.find((m) => m.unit === 'כף'), { unit: 'כף', grams: 40 });
  });

  test('trivial gram/kilogram rows are filtered out of the measures', async () => {
    setCkan({
      foods: [{ Code: 1, smlmitzrach: 1, shmmitzrach: 'משהו', food_energy: 100 }],
      measures: { 1: [{ mida: '900', mishkal: '1' }, { mida: '901', mishkal: '1000' }, { mida: '300', mishkal: '15' }] },
      units: { 900: 'גרמים', 901: 'קילוגרם', 300: 'כף' },
    });
    scriptClaude(useTool('lookup_israeli_food', { query: 'משהו' }), say('ok'));
    await post(handler, textUpdate('שאלה'));

    const m = toolResult().results[0].measures;
    assert.equal(m.length, 1);
    assert.equal(m[0].unit, 'כף');
  });

  test('no match is a normal answer, not an error', async () => {
    setCkan({ foods: [], measures: {}, units: {} });
    scriptClaude(useTool('lookup_israeli_food', { query: 'קוואקר חלל' }), say('לא מצאתי, אעריך'));
    await post(handler, textUpdate('משהו מוזר'));

    const block = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.notEqual(block.is_error, true);
    assert.equal(JSON.parse(block.content).found, false);
  });

  test('an API outage degrades to an estimate instead of breaking the log', async () => {
    setCkan({ fail: true });
    scriptClaude(
      useTool('lookup_israeli_food', { query: 'פלאפל' }),
      useTool('log_meal', {
        items: [{ name: 'פלאפל', grams: 100, calories: 300, protein: 8, carbs: 30, fat: 17, source_type: 'ai_estimate', quantity_source: 'estimated' }],
        confidence: 'low',
      }),
      say('')
    );
    await post(handler, textUpdate('5 כדורי פלאפל'));

    assert.equal(db.rows('meals').length, 1, 'still logged');
    assert.equal(db.rows('meals')[0].items[0].source_type, 'ai_estimate');
  });

  test('a too-short query is rejected before any network call', async () => {
    scriptClaude(useTool('lookup_israeli_food', { query: 'א' }), say('פרט יותר'));
    await post(handler, textUpdate('א'));

    assert.equal(claudeCalls.at(-1).messages.at(-1).content[0].is_error, true);
    assert.equal(ckanCalls.length, 0, 'no request was made');
  });

  test('lookup is read-only: no undo button, nothing written', async () => {
    setCkan({
      foods: [{ Code: 1, smlmitzrach: 1, shmmitzrach: 'פלאפל', food_energy: 269 }],
      measures: {}, units: {},
    });
    scriptClaude(useTool('lookup_israeli_food', { query: 'פלאפל' }), say('זה מה שמצאתי'));
    await post(handler, textUpdate('כמה קלוריות בפלאפל'));

    assert.equal(lastMessage().reply_markup, undefined);
    assert.equal(db.rows('meals').length, 0);
  });

  test('results without calorie data are dropped', async () => {
    setCkan({
      foods: [
        { Code: 1, smlmitzrach: 1, shmmitzrach: 'תקין', food_energy: 100 },
        { Code: 2, smlmitzrach: 2, shmmitzrach: 'חסר ערכים', food_energy: null },
      ],
      measures: {}, units: {},
    });
    scriptClaude(useTool('lookup_israeli_food', { query: 'משהו' }), say('ok'));
    await post(handler, textUpdate('שאלה'));

    const r = toolResult();
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].name, 'תקין');
  });
});

describe('accuracy accounting with the official database', () => {
  test('israeli_db counts as measured, not as an estimate', () => {
    const rows = [{
      confidence: 'medium',
      items: [
        { calories: 300, source_type: 'israeli_db' },
        { calories: 100, source_type: 'ai_estimate' },
      ],
    }];
    assert.deepEqual(core.estimateSplit(rows), { measuredPct: 75, estimatedPct: 25 });
  });

  test('a meal logged from the official database raises the accuracy line', async () => {
    scriptClaude(useTool('log_meal', {
      items: [{
        name: 'קוטג\'', grams: 250, calories: 303, protein: 29, carbs: 9, fat: 12.5,
        source_type: 'israeli_db', quantity_source: 'user_explicit', portion: 'גביע',
      }],
      confidence: 'high',
    }), say(''));
    await post(handler, textUpdate('גביע קוטג'));

    assert.match(lastMessage().text, /מדויק 100%/);
  });
});
