import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT, sent, tgCalls, claudeCalls, scriptClaude,
  say, useTool,
  post, textUpdate, callbackUpdate,
  resetAll, db, lastMessage, lastText, undoIdFrom,
  seedGoals,
} from './harness.js';

const { default: handler } = await import('../api/agent.js');

const ITEM = (over = {}) => ({
  name: 'פריט', emoji: '🍽', portion: '100 גרם', grams: 100,
  calories: 100, protein: 10, carbs: 5, fat: 2, fiber: 0, sugar: 0, sodium_mg: 0,
  source_type: 'ai_estimate', quantity_source: 'estimated', ...over,
});

beforeEach(() => {
  resetAll();
  seedGoals();
});

describe('save_recipe', () => {
  test('computes per-serving and per-100g from the finished weight', async () => {
    scriptClaude(useTool('save_recipe', {
      name: 'פנקייק חלבון',
      ingredients: [
        { name: 'ביצים', grams: 100, calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5 },
        { name: 'שיבולת שועל', grams: 60, calories: 233, protein: 8.4, carbs: 40, fat: 4 },
        { name: 'אבקת חלבון', grams: 33, calories: 124, protein: 25, carbs: 2, fat: 1.5 },
      ],
      total_grams: 400, servings: 2,
    }), say(''));
    await post(handler, textUpdate('מתכון לפנקייק'));

    const [r] = db.rows('recipes');
    assert.equal(r.name, 'פנקייק חלבון');
    assert.equal(r.totals.calories, 500);
    assert.equal(r.total_grams, 400);
    assert.equal(r.servings, 2);
    assert.match(lastText(), /250/, 'per-serving calories');
    assert.match(lastText(), /125/, 'per-100g calories');
    assert.equal(db.rows('meals').length, 0, 'saving a recipe is not eating it');
  });

  test('falls back to summed ingredient weight when no finished weight given', async () => {
    scriptClaude(useTool('save_recipe', {
      name: 'סלט',
      ingredients: [{ name: 'עגבניה', grams: 150, calories: 27, protein: 1.3, carbs: 5.8, fat: 0.3 }],
    }), say(''));
    await post(handler, textUpdate('מתכון'));
    assert.equal(db.rows('recipes')[0].total_grams, 150);
  });

  test('an empty ingredient list is refused', async () => {
    scriptClaude(useTool('save_recipe', { name: 'ריק', ingredients: [] }), say('חסרים רכיבים'));
    await post(handler, textUpdate('מתכון ריק'));
    assert.equal(db.rows('recipes').length, 0);
    assert.equal(claudeCalls.at(-1).messages.at(-1).content[0].is_error, true);
  });

  test('undo removes a new recipe and restores an overwritten one', async () => {
    scriptClaude(useTool('save_recipe', {
      name: 'תבשיל', ingredients: [{ name: 'x', grams: 100, calories: 100, protein: 5, carbs: 5, fat: 5 }],
    }), say(''));
    await post(handler, textUpdate('מתכון'));
    let [undoData] = undoIdFrom(lastMessage());
    await post(handler, callbackUpdate(undoData));
    assert.equal(db.rows('recipes').length, 0);

    db.insert('recipes', {
      id: 9, chat_id: CHAT, name: 'ישן', ingredients: [], totals: { calories: 111 }, total_grams: 100,
    });
    scriptClaude(useTool('save_recipe', {
      name: 'ישן', ingredients: [{ name: 'y', grams: 200, calories: 999, protein: 1, carbs: 1, fat: 1 }],
    }), say(''));
    await post(handler, textUpdate('עדכן מתכון'));
    [undoData] = undoIdFrom(lastMessage());
    await post(handler, callbackUpdate(undoData));
    assert.equal(db.rows('recipes')[0].totals.calories, 111);
  });
});

describe('save_meal and log_saved', () => {
  test('saving then logging by name reproduces the macros', async () => {
    scriptClaude(useTool('save_meal', {
      name: 'ארוחת בוקר קבועה', category: 'ארוחת בוקר',
      items: [ITEM({ calories: 300, protein: 30 })],
    }), say(''));
    await post(handler, textUpdate('תשמור בשם ארוחת בוקר קבועה'));
    assert.equal(db.rows('saved_meals')[0].totals.calories, 300);
    assert.equal(db.rows('meals').length, 0, 'saving is not logging');

    scriptClaude(useTool('log_saved', { name: 'ארוחת בוקר קבועה' }), say(''));
    await post(handler, textUpdate('ארוחת בוקר קבועה'));

    assert.equal(db.rows('meals')[0].totals.calories, 300);
    assert.equal(db.rows('saved_meals')[0].use_count, 1, 'usage counted');
  });

  test('portions scale a saved meal in code', async () => {
    db.insert('saved_meals', {
      id: 1, chat_id: CHAT, name: 'שייק',
      items: [ITEM({ calories: 200, protein: 20, grams: 300 })],
      totals: { calories: 200, protein: 20 }, use_count: 0,
    });
    scriptClaude(useTool('log_saved', { name: 'שייק', portions: 2 }), say(''));
    await post(handler, textUpdate('שני שייקים'));

    const [meal] = db.rows('meals');
    assert.equal(meal.totals.calories, 400);
    assert.equal(meal.totals.protein, 40);
    assert.equal(meal.items[0].grams, 600);
  });

  test('grams of a recipe scale against its finished weight', async () => {
    db.insert('recipes', {
      id: 1, chat_id: CHAT, name: 'תבשיל', ingredients: [],
      totals: { calories: 1000, protein: 80, carbs: 100, fat: 30 },
      total_grams: 1000, servings: 4,
    });
    scriptClaude(useTool('log_saved', { name: 'תבשיל', grams: 250 }), say(''));
    await post(handler, textUpdate('250 גרם מהתבשיל'));

    const [meal] = db.rows('meals');
    assert.equal(meal.totals.calories, 250);
    assert.equal(meal.totals.protein, 20);
    assert.equal(meal.items[0].source_type, 'personal_food');
    assert.equal(meal.confidence, 'high');
  });

  test('servings of a recipe scale correctly', async () => {
    db.insert('recipes', {
      id: 1, chat_id: CHAT, name: 'פנקייק', ingredients: [],
      totals: { calories: 500, protein: 46 }, total_grams: 400, servings: 2,
    });
    scriptClaude(useTool('log_saved', { name: 'פנקייק', portions: 1 }), say(''));
    await post(handler, textUpdate('מנה מהפנקייק'));

    assert.equal(db.rows('meals')[0].totals.calories, 250);
  });

  test('an unknown name is a clean error, not a crash', async () => {
    scriptClaude(useTool('log_saved', { name: 'לא קיים' }), say('לא מצאתי ארוחה כזו'));
    await post(handler, textUpdate('לא קיים'));

    assert.equal(db.rows('meals').length, 0);
    assert.equal(claudeCalls.at(-1).messages.at(-1).content[0].is_error, true);
  });

  test('saved names are listed in the model context', async () => {
    db.insert('saved_meals', {
      id: 1, chat_id: CHAT, name: 'השייק שלי', items: [], totals: { calories: 300 }, use_count: 3,
    });
    db.insert('recipes', {
      id: 1, chat_id: CHAT, name: 'פנקייק', ingredients: [], totals: { calories: 500 }, servings: 2,
    });
    scriptClaude(say('ok'));
    await post(handler, textUpdate('שאלה'));

    assert.match(claudeCalls[0].system, /השייק שלי/);
    assert.match(claudeCalls[0].system, /פנקייק/);
  });

  test('another chat\'s saved meal is invisible and unusable', async () => {
    db.insert('saved_meals', {
      id: 1, chat_id: 999999, name: 'שלהם', items: [], totals: { calories: 100 }, use_count: 0,
    });
    scriptClaude(useTool('log_saved', { name: 'שלהם' }), say('לא מצאתי'));
    await post(handler, textUpdate('שלהם'));

    assert.equal(db.rows('meals').length, 0);
    assert.equal(claudeCalls.at(-1).messages.at(-1).content[0].is_error, true);
  });
});

describe('/saved menu', () => {
  test('groups meals by category and offers one-tap logging', async () => {
    db.insert('saved_meals', [
      { id: 1, chat_id: CHAT, name: 'שייק בוקר', category: 'ארוחת בוקר', items: [], totals: { calories: 300 }, use_count: 5 },
      { id: 2, chat_id: CHAT, name: 'חטיף', items: [], totals: { calories: 150 }, use_count: 0 },
    ]);
    db.insert('recipes', {
      id: 1, chat_id: CHAT, name: 'תבשיל', ingredients: [], totals: { calories: 1000 }, servings: 4,
    });

    await post(handler, textUpdate('/saved'));

    const t = lastText();
    assert.match(t, /ארוחת בוקר/);
    assert.match(t, /מתכונים/);
    assert.match(t, /250 למנה/);
    const buttons = lastMessage().reply_markup.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    assert.ok(buttons.some((b) => b.callback_data === 'logsaved:m:1'));
    assert.ok(buttons.some((b) => b.callback_data === 'logsaved:r:1'));
  });

  test('tapping a saved meal logs it', async () => {
    db.insert('saved_meals', {
      id: 1, chat_id: CHAT, name: 'שייק', items: [ITEM({ calories: 250 })],
      totals: { calories: 250 }, use_count: 0,
    });
    scriptClaude(useTool('log_saved', { name: 'שייק' }), say(''));

    await post(handler, callbackUpdate('logsaved:m:1'));

    assert.equal(db.rows('meals').length, 1);
    assert.equal(db.rows('meals')[0].totals.calories, 250);
  });

  test('another chat cannot tap-log your saved meal', async () => {
    db.insert('saved_meals', {
      id: 1, chat_id: 999999, name: 'שלהם', items: [], totals: { calories: 100 }, use_count: 0,
    });
    await post(handler, callbackUpdate('logsaved:m:1'));

    assert.equal(db.rows('meals').length, 0);
    const ack = tgCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    assert.match(ack.body.text, /לא נמצא/);
  });

  test('an empty menu explains how to fill it', async () => {
    await post(handler, textUpdate('/saved'));
    assert.match(lastText(), /אין עדיין/);
  });
});
