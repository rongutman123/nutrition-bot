import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT, claudeCalls, scriptClaude, say, useTool,
  post, textUpdate, photoUpdate, callbackUpdate, resetAll, db, lastMessage,
  seedGoals, seedMeal, setOffProduct, setCkan,
} from './harness.js';

const { default: handler } = await import('../api/agent.js');

// This file tests the production default. The harness pins AGENT_MODE=agent
// for the legacy suites — flip it here (files run in separate processes).
process.env.AGENT_MODE = 'code-first';

const seedFood = (over = {}) =>
  db.insert('my_foods', {
    chat_id: CHAT, alias: 'בננה', serving_grams: 120,
    kcal_per_100g: 89, protein_per_100g: 1.1, carbs_per_100g: 23, fat_per_100g: 0.3,
    ...over,
  });

beforeEach(() => {
  resetAll();
  seedGoals();
});

describe('code-first: dictionary text', () => {
  test('a known food logs instantly with zero Claude calls', async () => {
    seedFood();
    await post(handler, textUpdate('בננה'));

    assert.equal(claudeCalls.length, 0);
    const meals = db.rows('meals');
    assert.equal(meals.length, 1);
    assert.equal(meals[0].items[0].source_type, 'personal_food');
    assert.match(lastMessage().text, /נרשם/);
    const kb = lastMessage().reply_markup.inline_keyboard.flat();
    assert.ok(kb.some((b) => b.callback_data.startsWith('undo:')), 'undo button present');
    const u = db.rows('agent_usage').find((r) => r.route === 'parser');
    assert.equal(u.kind, 'log_meal');
  });

  test('corrections work without Claude: half, then delete', async () => {
    seedMeal(CHAT, {});
    await post(handler, textUpdate('רק חצי'));
    assert.equal(Math.round(db.rows('meals')[0].totals.calories), 39);

    await post(handler, textUpdate('תמחק את זה'));
    assert.equal(db.rows('meals').length, 0);
    assert.equal(claudeCalls.length, 0);
  });

  test('a measurement logs through the template', async () => {
    await post(handler, textUpdate('נשקלתי 95.8 מותן 105'));
    const m = db.rows('measurements');
    assert.equal(m.length, 1);
    assert.equal(m[0].weight_kg, 95.8);
    assert.equal(claudeCalls.length, 0);
  });
});

describe('code-first: barcodes', () => {
  test('typed digits of a dictionary product log instantly', async () => {
    seedFood({ alias: 'קוטג', barcode: '7290004131074', serving_grams: 250, kcal_per_100g: 121 });
    await post(handler, textUpdate('7290004131074'));

    assert.equal(claudeCalls.length, 0);
    const meal = db.rows('meals')[0];
    assert.equal(meal.items[0].grams, 250);
    const kb = lastMessage().reply_markup.inline_keyboard.flat();
    assert.ok(kb.some((b) => b.callback_data.startsWith('qty:')), 'quantity buttons present');
  });

  test('an Open Food Facts hit is logged AND remembered with its barcode', async () => {
    setOffProduct({
      product_name: 'Cottage 5%', brands: 'Tnuva', serving_size: '250 g',
      nutriments: { 'energy-kcal_100g': 121, proteins_100g: 11.7, carbohydrates_100g: 3.7, fat_100g: 5 },
    });
    await post(handler, textUpdate('7290004131074'));

    const food = db.rows('my_foods').find((f) => f.barcode === '7290004131074');
    assert.ok(food, 'saved to the dictionary');
    assert.equal(food.kcal_per_100g, 121);
    assert.equal(db.rows('meals')[0].items[0].source_type, 'label');
    assert.equal(claudeCalls.length, 0);
  });

  test('a miss asks once (ForceReply) and the reply saves it forever', async () => {
    await post(handler, textUpdate('7299999999999'));
    assert.match(lastMessage().text, /לא נמצא/);
    assert.equal(lastMessage().reply_markup.force_reply, true);

    await post(handler, textUpdate('גבינת העמק, 350, 25, 1, 27, 30', { replyTo: lastMessage().text.replace(/<[^>]+>/g, '') }));
    const food = db.rows('my_foods').find((f) => f.barcode === '7299999999999');
    assert.ok(food);
    assert.equal(food.kcal_per_100g, 350);
    assert.equal(db.rows('meals').length, 1);
    assert.equal(claudeCalls.length, 0);
  });

  test('a photo with no readable barcode explains, without calling Claude', async () => {
    await post(handler, photoUpdate());
    assert.match(lastMessage().text, /לא זיהיתי ברקוד/);
    assert.equal(claudeCalls.length, 0);
  });

  test('the ½ button halves a just-logged meal', async () => {
    seedFood({ alias: 'קוטג', barcode: '7290004131074', serving_grams: 250, kcal_per_100g: 121 });
    await post(handler, textUpdate('7290004131074'));
    const mealId = db.rows('meals')[0].id;

    await post(handler, callbackUpdate(`qty:${mealId}:0.5`));
    assert.equal(db.rows('meals')[0].items[0].grams, 125);
    assert.equal(claudeCalls.length, 0);
  });
});

describe('code-first: the Israeli database with buttons', () => {
  const ckanFalafel = () =>
    setCkan({
      foods: [{ Code: 88, smlmitzrach: 88, shmmitzrach: 'פלאפל מטוגן', food_energy: 269, protein: 8, carbohydrates: 24, total_fat: 15 }],
      measures: { 88: [{ mida: '600', mishkal: '17' }] },
      units: { 600: 'יחידה' },
    });

  test('an unknown food shows database buttons, a tap logs and learns', async () => {
    ckanFalafel();
    await post(handler, textUpdate('פלאפל'));

    assert.equal(claudeCalls.length, 0);
    const kb = lastMessage().reply_markup.inline_keyboard;
    const pick = kb.flat().find((b) => b.callback_data.startsWith('tz:'));
    assert.ok(pick, 'database suggestion buttons');
    assert.ok(kb.flat().some((b) => b.callback_data === 'ai'), 'AI escape hatch');

    await post(handler, callbackUpdate(pick.callback_data));
    const meal = db.rows('meals')[0];
    assert.equal(meal.items[0].source_type, 'israeli_db');
    const learned = db.rows('my_foods').find((f) => f.alias === 'פלאפל');
    assert.ok(learned, 'alias learned for next time');
    assert.equal(learned.kcal_per_100g, 269);
  });

  test('explicit grams survive the button round-trip', async () => {
    ckanFalafel();
    await post(handler, textUpdate('פלאפל 150 גרם'));
    const pick = lastMessage().reply_markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('tz:'));
    await post(handler, callbackUpdate(pick.callback_data));
    assert.equal(db.rows('meals')[0].items[0].grams, 150);
    assert.equal(db.rows('meals')[0].items[0].quantity_source, 'user_explicit');
  });
});

describe('code-first: the AI button', () => {
  test('unparseable text gets buttons, not Claude', async () => {
    await post(handler, textUpdate('אכלתי משהו קטן אחרי האימון'));
    assert.equal(claudeCalls.length, 0);
    assert.match(lastMessage().text, /לא זיהיתי/);
    assert.ok(lastMessage().reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'ai'));
  });

  test('the AI tap runs the lite brain: Haiku, four tools, no web search', async () => {
    await post(handler, textUpdate('אכלתי משהו קטן אחרי האימון'));
    scriptClaude(
      useTool('log_meal', {
        items: [{ name: 'חטיף', grams: 30, calories: 150, protein: 2, carbs: 18, fat: 8, source_type: 'ai_estimate', quantity_source: 'estimated' }],
        confidence: 'low',
      }),
      say('')
    );
    await post(handler, callbackUpdate('ai'));

    assert.ok(claudeCalls.length >= 1);
    const call = claudeCalls[0];
    assert.match(call.model, /haiku/);
    assert.equal(call.tools.length, 4);
    assert.ok(!call.tools.some((t) => t.name === 'web_search'));
    assert.equal(db.rows('meals').length, 1);
    const u = db.rows('agent_usage').find((r) => r.route === 'claude');
    assert.match(u.model, /haiku/);
  });

  test('the monthly budget cap blocks the button and offers an override', async () => {
    // a month's worth of heavy Sonnet usage — well past ₪1
    db.insert('agent_usage', {
      chat_id: CHAT, route: 'claude', model: 'claude-sonnet-5',
      input_tokens: 2_000_000, output_tokens: 100_000,
      ts: new Date().toISOString(), // raw seed — DB defaults don't apply
    });
    await post(handler, textUpdate('אכלתי משהו מוזר מאוד'));
    await post(handler, callbackUpdate('ai'));

    assert.equal(claudeCalls.length, 0, 'blocked before any API call');
    assert.match(lastMessage().text, /תקציב/);
    const override = lastMessage().reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'ai!');
    assert.ok(override, 'explicit override offered');

    scriptClaude(say('בסדר'));
    await post(handler, callbackUpdate('ai!'));
    assert.equal(claudeCalls.length, 1, 'override goes through');
  });
});

describe('code-first: questions menu', () => {
  test('the menu opens and a question is answered from the DB', async () => {
    seedMeal(CHAT, {});
    await post(handler, textUpdate('❓ שאלות'));
    assert.ok(lastMessage().reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'q:avg7'));

    await post(handler, callbackUpdate('q:avg7'));
    assert.match(lastMessage().text, /ממוצע/);
    assert.equal(claudeCalls.length, 0);
  });
});
