import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT, claudeCalls, scriptClaude, say, useTool, useTools,
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

  test('the AI tap runs the lite brain: small prompt, web search available', async () => {
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
    assert.match(call.model, /sonnet/);
    assert.equal(call.tools.length, 5, 'four tools + web search');
    assert.ok(call.tools.some((t) => t.name === 'web_search'), 'restaurant values need the web');
    assert.ok(call.system.length < 4500, 'the lite prompt, not the full 18-rule one');
    assert.equal(db.rows('meals').length, 1);
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

describe('code-first: live-bug regressions (2026-08-26)', () => {
  test('an answer to an open AI question goes back to the AI, not to the parser', async () => {
    // the user's live transcript: AI asked "כמה מ"ל?", the answer "שלם" got
    // routed to the database search and produced nonsense buttons
    await post(handler, textUpdate('משקה חלבון מולר אפס אחוז'));
    scriptClaude(say('כמה מ"ל שתית?'));
    await post(handler, callbackUpdate('ai'));
    assert.equal(claudeCalls.length, 1);

    scriptClaude(
      useTool('log_meal', {
        items: [{ name: 'משקה חלבון מולר', grams: 250, calories: 110, protein: 20, carbs: 3, fat: 0.2, source_type: 'ai_estimate', quantity_source: 'user_explicit' }],
        confidence: 'medium',
      }),
      say('')
    );
    await post(handler, textUpdate('שלם'));

    assert.ok(claudeCalls.length >= 2, 'the answer reached the AI');
    assert.equal(db.rows('meals').length, 1, 'the meal got logged');
    assert.doesNotMatch(lastMessage().text, /עוד לא במילון/);
  });

  test('an open AI question hijacks even correction-looking answers', async () => {
    seedMeal(CHAT, {});
    await post(handler, textUpdate('משהו מוזר לגמרי שאין במילון'));
    scriptClaude(say('כמה גרם בערך?'));
    await post(handler, callbackUpdate('ai'));

    scriptClaude(say('הבנתי, רשמתי חצי'));
    await post(handler, textUpdate('חצי'));

    // "חצי" was an ANSWER — the seeded meal must not get scaled
    assert.equal(Math.round(db.rows('meals')[0].totals.calories), 78);
    assert.equal(claudeCalls.length, 2);
  });

  test('after the AI writes, the conversation closes and the parser is back', async () => {
    seedFood();
    await post(handler, textUpdate('משהו מוזר לגמרי שאין במילון'));
    scriptClaude(
      useTool('log_meal', {
        items: [{ name: 'משהו', grams: 100, calories: 200, protein: 5, carbs: 20, fat: 10, source_type: 'ai_estimate', quantity_source: 'estimated' }],
        confidence: 'low',
      }),
      say('')
    );
    await post(handler, callbackUpdate('ai'));
    assert.equal(db.rows('meals').length, 1);

    await post(handler, textUpdate('בננה'));
    assert.equal(db.rows('meals').length, 2, 'parsed without the AI');
    assert.equal(claudeCalls.length, 2, 'no extra AI call');
  });

  test('a database miss says so explicitly instead of repeating "לא זיהיתי"', async () => {
    setCkan({ foods: [], measures: {}, units: {} });
    await post(handler, textUpdate('פלאפל'));
    assert.match(lastMessage().text, /לא נמצא גם במאגר/);
    assert.doesNotMatch(lastMessage().text, /לא זיהיתי/);
    assert.ok(lastMessage().reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'ai'));
  });

  test('the /foods value syntax actually completes a partial entry', async () => {
    seedFood({ alias: 'לחמניה', serving_grams: 90, kcal_per_100g: null, protein_per_100g: null, carbs_per_100g: null, fat_per_100g: null });
    await post(handler, textUpdate('לחמניה: 280 קלוריות ל-100 גרם, חלבון 9, פחמימות 50, שומן 3'));

    const f = db.rows('my_foods').find((x) => x.alias === 'לחמניה');
    assert.equal(f.kcal_per_100g, 280);
    assert.equal(f.protein_per_100g, 9);
    assert.equal(claudeCalls.length, 0);

    // and from now on it parses as a full food
    await post(handler, textUpdate('לחמנייה'));
    const meal = db.rows('meals').at(-1);
    assert.equal(meal.items[0].calories, Math.round(280 * 0.9));
  });

  test('"שמור אותו לאתמול" backdates the last meal, and undo restores it', async () => {
    seedMeal(CHAT, {});
    await post(handler, textUpdate('שמור אותו לאתמול'));

    const meal = db.rows('meals')[0];
    const today = meal.day_key !== undefined;
    assert.ok(today);
    assert.notEqual(meal.day_key, db.rows('agent_actions')[0].payload.prev.day_key, 'day changed');
    assert.match(lastMessage().text, /נרשם לתאריך/);
    assert.equal(claudeCalls.length, 0);

    const undoBtn = lastMessage().reply_markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('undo:'));
    await post(handler, callbackUpdate(undoBtn.callback_data));
    assert.equal(db.rows('meals')[0].day_key, db.rows('agent_actions')[0].payload.prev.day_key, 'undo restored the date');
  });

  test('markdown bold from the small model renders as HTML, not asterisks', async () => {
    await post(handler, textUpdate('משהו מוזר לגמרי שאין במילון'));
    scriptClaude(say('חסר לי **הכמות** כדי לרשום'));
    await post(handler, callbackUpdate('ai'));

    assert.match(lastMessage().text, /<b>הכמות<\/b>/);
    assert.doesNotMatch(lastMessage().text, /\*\*/);
  });
});

describe('learning: the AI teaches the parser', () => {
  test('a food the AI logs is remembered with alternative names, then parsed free', async () => {
    await post(handler, textUpdate('מק דאבל'));
    assert.equal(claudeCalls.length, 0, 'unknown food does not call the AI on its own');

    scriptClaude(
      useTools([
        {
          name: 'log_meal',
          input: {
            items: [{ name: 'מק דאבל', grams: 150, calories: 400, protein: 22, carbs: 33, fat: 20, source_type: 'label', quantity_source: 'default' }],
            confidence: 'high',
          },
        },
        {
          name: 'remember_food',
          input: {
            alias: 'מק דאבל', product: "McDonald's Mc Double",
            aliases: ['מקדונלדס דאבל', 'דאבל', 'מק-דאבל'],
            serving_grams: 150, kcal_per_100g: 267, protein_per_100g: 14.7, carbs_per_100g: 22, fat_per_100g: 13.3,
          },
        },
      ]),
      say('')
    );
    await post(handler, callbackUpdate('ai'));

    const learned = db.rows('my_foods').find((f) => f.alias === 'מק דאבל');
    assert.ok(learned, 'saved to the dictionary');
    assert.deepEqual(learned.aliases, ['מקדונלדס דאבל', 'דאבל', 'מק-דאבל']);

    // the whole point: the next mention — by ANY name — costs nothing
    const before = claudeCalls.length;
    await post(handler, textUpdate('דאבל'));
    assert.equal(claudeCalls.length, before, 'no AI call the second time');
    const meal = db.rows('meals').at(-1);
    assert.equal(meal.items[0].name, 'מק דאבל');
    assert.equal(meal.items[0].source_type, 'personal_food');
    const u = db.rows('agent_usage').at(-1);
    assert.equal(u.route, 'parser', 'handled for free');
  });

  test('later alternative names accumulate instead of replacing', async () => {
    seedFood({ alias: 'שייק', aliases: ['שייק חלבון'] });
    scriptClaude(useTool('remember_food', { alias: 'שייק', aliases: ['מילקשייק', 'שייק חלבון'] }), say(''));
    await post(handler, textUpdate('משהו שלא נפרסר בכלל בשום צורה'));
    await post(handler, callbackUpdate('ai'));

    const f = db.rows('my_foods').find((x) => x.alias === 'שייק');
    assert.deepEqual(f.aliases, ['שייק חלבון', 'מילקשייק'], 'merged, deduped, old kept');
  });

  test('an alternative name equal to the alias itself is dropped', async () => {
    scriptClaude(useTool('remember_food', { alias: 'טונה', aliases: ['טונה', 'קופסת טונה'] }), say(''));
    await post(handler, textUpdate('משהו שלא נפרסר בכלל בשום צורה'));
    await post(handler, callbackUpdate('ai'));

    const f = db.rows('my_foods').find((x) => x.alias === 'טונה');
    assert.deepEqual(f.aliases, ['קופסת טונה']);
  });
});

describe('the conversation log must not leak into a new log entry', () => {
  const backdatedMeal = (date) => useTool('log_meal', {
    items: [{ name: 'מק דאבל', grams: 150, calories: 488, protein: 43, carbs: 37, fat: 18, source_type: 'label', quantity_source: 'default' }],
    confidence: 'high', date, meal_time: '22:00',
  });

  test('a date the user did not ask for is stripped — the meal lands today', async () => {
    await post(handler, textUpdate('מק דאבל'));
    scriptClaude(backdatedMeal('2026-08-25'), say(''));
    await post(handler, callbackUpdate('ai'));

    const meal = db.rows('meals')[0];
    const today = new Date().toISOString().slice(0, 10);
    assert.notEqual(meal.day_key, '2026-08-25', 'the stale date was refused');
    assert.equal(meal.day_key, today);
    assert.doesNotMatch(lastMessage().text, /נרשם לתאריך/);
  });

  test('a date the user DID ask for is honoured', async () => {
    await post(handler, textUpdate('אכלתי מק דאבל אתמול'));
    const yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    scriptClaude(backdatedMeal(yday), say(''));
    await post(handler, callbackUpdate('ai'));

    assert.equal(db.rows('meals')[0].day_key, yday);
    assert.match(lastMessage().text, /נרשם לתאריך/);
  });

  test('the lite prompt forbids reusing numbers from the conversation', async () => {
    await post(handler, textUpdate('משהו שלא נפרסר בכלל בשום צורה'));
    scriptClaude(say('שאלה'));
    await post(handler, callbackUpdate('ai'));

    const sys = claudeCalls[0].system;
    assert.match(sys, /היסטוריית השיחה אינה מקור לערכים/);
    assert.match(sys, /תאריך: תמיד היום ועכשיו/);
  });
});

describe('never silent', () => {
  test('a crash anywhere in processing still answers the user', async () => {
    // text as a non-string blows up early in onMessage — any unexpected
    // throw must produce a visible error, not swallowed silence
    await post(handler, {
      update_id: 987001,
      message: { message_id: 1, chat: { id: CHAT }, text: { boom: true } },
    });
    assert.match(lastMessage().text, /נשבר/);
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
