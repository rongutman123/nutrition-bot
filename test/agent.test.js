import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT, sent, tgCalls, claudeCalls, scriptClaude, failAnthropic,
  say, useTool, useTools, pauseTurn,
  post, textUpdate, photoUpdate, callbackUpdate,
  resetAll, db, lastMessage, lastText, undoIdFrom,
  seedGoals, seedMeal, todayKey,
} from './harness.js';

const { default: handler } = await import('../api/agent.js');
const core = await import('../lib/agent-core.js');

const ITEM = (over = {}) => ({
  name: 'חזה עוף', emoji: '🍗', portion: '200 גרם', grams: 200,
  calories: 330, protein: 62, carbs: 0, fat: 7, fiber: 0, sugar: 0, sodium_mg: 90,
  source_type: 'ai_estimate', quantity_source: 'user_explicit', ...over,
});

beforeEach(() => {
  resetAll();
  seedGoals();
});

/* ============ webhook plumbing ============ */

describe('webhook', () => {
  test('rejects a wrong secret token without touching the DB', async () => {
    const res = await post(handler, textUpdate('ביצה'), { secret: 'wrong' });
    assert.equal(res.statusCode, 401);
    assert.equal(sent.length, 0);
    assert.equal(db.rows('agent_updates').length, 0);
  });

  test('deduplicates a repeated update_id (the old bot\'s duplicate-reply bug)', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }));
    const upd = textUpdate('חזה עוף', { id: 7777 });

    await post(handler, upd);
    const after1 = sent.length;
    const r2 = await post(handler, upd); // Telegram retry

    assert.equal(r2.body, 'dup');
    assert.equal(sent.length, after1, 'no second reply');
    assert.equal(db.rows('meals').length, 1, 'no duplicate meal');
  });

  test('always answers 200 so Telegram stops retrying, even on internal failure', async () => {
    failAnthropic(500);
    const res = await post(handler, textUpdate('ביצה'));
    assert.equal(res.statusCode, 200);
    assert.match(lastText(), /נפלתי באמצע/);
  });

  test('GET returns a health string', async () => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; } };
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /agent is up/);
  });

  test('voice notes get a polite unsupported message, no write', async () => {
    await post(handler, { update_id: 91, message: { chat: { id: CHAT }, voice: { file_id: 'v' } } });
    assert.match(lastText(), /קול/);
    assert.equal(db.rows('meals').length, 0);
  });
});

/* ============ logging ============ */

describe('log_meal', () => {
  test('stores a macro snapshot with provenance per item', async () => {
    scriptClaude(useTool('log_meal', {
      items: [ITEM({ source_type: 'personal_food', quantity_source: 'user_explicit' })],
      confidence: 'high', assumptions: 'מהמילון',
    }), say(''));

    await post(handler, textUpdate('חזה עוף 200 גרם'));

    const [meal] = db.rows('meals');
    assert.equal(meal.chat_id, CHAT);
    assert.equal(meal.items[0].source_type, 'personal_food');
    assert.equal(meal.items[0].quantity_source, 'user_explicit');
    assert.equal(meal.totals.calories, 330);
    assert.equal(meal.totals.protein, 62);
    assert.equal(meal.day_key, todayKey());
    assert.equal(meal.source, 'agent');
  });

  test('reply carries an undo button and the day status', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(''));
    await post(handler, textUpdate('חזה עוף'));

    const msg = lastMessage();
    assert.match(msg.text, /נרשם/);
    assert.match(msg.text, /נותרו/);
    assert.equal(undoIdFrom(msg).length, 1);
    assert.match(undoIdFrom(msg)[0], /^undo:\d+$/);
  });

  test('totals are summed from items, not trusted from the model', async () => {
    scriptClaude(useTool('log_meal', {
      items: [ITEM({ calories: 100, protein: 10 }), ITEM({ name: 'אורז', calories: 200, protein: 4 })],
      confidence: 'medium',
    }), say(''));
    await post(handler, textUpdate('עוף ואורז'));

    const [meal] = db.rows('meals');
    assert.equal(meal.totals.calories, 300);
    assert.equal(meal.totals.protein, 14);
  });

  test('backdated log lands on the given day, not today', async () => {
    scriptClaude(useTool('log_meal', {
      items: [ITEM()], confidence: 'medium', date: '2026-08-20', meal_time: '13:30',
    }), say(''));
    await post(handler, textUpdate('אכלתי בצהריים ושכחתי'));

    const [meal] = db.rows('meals');
    assert.equal(meal.day_key, '2026-08-20');
    assert.match(meal.ts, /^2026-08-20T13:30:00\+03:00$/, 'Israel summer offset');
    assert.match(lastText(), /נרשם לתאריך 20\.08/, 'user is told it went to another date');
  });

  test('winter dates use +02:00, not a hardcoded summer offset', async () => {
    scriptClaude(useTool('log_meal', {
      items: [ITEM()], confidence: 'medium', date: '2026-01-15', meal_time: '08:00',
    }), say(''));
    // The message has to name the date — an unrequested one is stripped now.
    await post(handler, textUpdate('רישום לאחור בחורף — 15.1 בבוקר'));

    const [meal] = db.rows('meals');
    assert.match(meal.ts, /\+02:00$/);
  });

  test('two tool calls in one turn produce two undo buttons with distinct ids', async () => {
    scriptClaude(useTools([
      { name: 'log_meal', input: { items: [ITEM()], confidence: 'medium' } },
      { name: 'remember_food', input: { alias: 'לחמניה', serving_grams: 90 } },
    ]), say(''));
    await post(handler, textUpdate('חזה עוף, וזכור שלחמניה 90 גרם'));

    const ids = undoIdFrom(lastMessage());
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  test('a question writes nothing and shows no undo button', async () => {
    scriptClaude(say('אכלת היום 1,200 קלוריות.'));
    await post(handler, textUpdate('כמה אכלתי היום?'));

    assert.equal(db.rows('meals').length, 0);
    assert.equal(lastMessage().reply_markup, undefined);
    assert.match(lastText(), /1,200/);
  });
});

/* ============ update / delete ============ */

describe('update_meal + delete_meal', () => {
  test('update replaces items and journals the previous state', async () => {
    const meal = seedMeal();
    scriptClaude(useTool('update_meal', {
      meal_id: meal.id, items: [ITEM({ calories: 500 })], confidence: 'medium',
    }), say(''));

    await post(handler, textUpdate('בעצם 500 קלוריות'));

    assert.equal(db.rows('meals')[0].totals.calories, 500);
    const action = db.rows('agent_actions').at(-1);
    assert.equal(action.kind, 'update_meal');
    assert.equal(action.payload.prev.totals.calories, 78, 'previous totals preserved for undo');
  });

  test('update against a missing meal reports an error instead of crashing', async () => {
    scriptClaude(
      useTool('update_meal', { meal_id: 'nope', items: [ITEM()], confidence: 'medium' }),
      say('לא מצאתי את הרישום')
    );
    const res = await post(handler, textUpdate('תקן את מה שאין'));

    assert.equal(res.statusCode, 200);
    const toolResult = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
    assert.match(lastText(), /לא מצאתי/);
  });

  test('delete removes the row and keeps the full record for undo', async () => {
    const meal = seedMeal();
    scriptClaude(useTool('delete_meal', { meal_id: meal.id }), say(''));

    await post(handler, textUpdate('תמחק את הביצה'));

    assert.equal(db.rows('meals').length, 0);
    const action = db.rows('agent_actions').at(-1);
    assert.equal(action.kind, 'delete_meal');
    assert.equal(action.payload.meal.id, meal.id);
    assert.match(lastText(), /נמחק/);
  });
});

/* ============ undo ============ */

describe('undo', () => {
  test('undo of a log deletes the meal and marks the action', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(''));
    await post(handler, textUpdate('חזה עוף'));
    const [undoData] = undoIdFrom(lastMessage());

    await post(handler, callbackUpdate(undoData));

    assert.equal(db.rows('meals').length, 0);
    assert.equal(db.rows('agent_actions').at(-1).undone, true);
    const edit = tgCalls.filter((c) => c.method === 'editMessageText').at(-1);
    assert.match(edit.body.text, /בוטל/);
  });

  test('undo twice is safe and says so', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(''));
    await post(handler, textUpdate('חזה עוף'));
    const [undoData] = undoIdFrom(lastMessage());

    await post(handler, callbackUpdate(undoData));
    const editsAfterFirst = tgCalls.filter((c) => c.method === 'editMessageText').length;
    await post(handler, callbackUpdate(undoData, { id: 9999 }));

    const ack = tgCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    assert.match(ack.body.text, /כבר בוטל/);
    assert.equal(tgCalls.filter((c) => c.method === 'editMessageText').length, editsAfterFirst);
  });

  test('undo of an update restores the exact previous items', async () => {
    const meal = seedMeal();
    const before = JSON.stringify(db.rows('meals')[0].items);
    scriptClaude(useTool('update_meal', {
      meal_id: meal.id, items: [ITEM({ calories: 999 })], confidence: 'low',
    }), say(''));
    await post(handler, textUpdate('שנה'));
    const [undoData] = undoIdFrom(lastMessage());

    await post(handler, callbackUpdate(undoData));

    const row = db.rows('meals')[0];
    assert.equal(JSON.stringify(row.items), before);
    assert.equal(row.totals.calories, 78);
    assert.equal(row.confidence, 'medium');
  });

  test('undo of a delete restores the row with its original id and date', async () => {
    const meal = seedMeal(CHAT, { day_key: '2026-08-19', ts: '2026-08-19T18:00:00+03:00' });
    scriptClaude(useTool('delete_meal', { meal_id: meal.id }), say(''));
    await post(handler, textUpdate('תמחק'));
    const [undoData] = undoIdFrom(lastMessage());

    await post(handler, callbackUpdate(undoData));

    const [row] = db.rows('meals');
    assert.equal(row.id, meal.id);
    assert.equal(row.day_key, '2026-08-19');
    assert.equal(row.ts, '2026-08-19T18:00:00+03:00');
  });

  test('undo is recorded in the chat log so the next message knows', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(''));
    await post(handler, textUpdate('חזה עוף'));
    const [undoData] = undoIdFrom(lastMessage());
    await post(handler, callbackUpdate(undoData));

    const log = db.rows('agent_chat_log').map((r) => r.content).join('\n');
    assert.match(log, /ביטול/);
  });

  test('a stray callback payload is ignored quietly', async () => {
    await post(handler, callbackUpdate('garbage:1'));
    assert.equal(sent.length, 0);
  });
});

/* ============ dictionary ============ */

describe('remember_food', () => {
  test('creates a dictionary entry; undo deletes it', async () => {
    scriptClaude(useTool('remember_food', {
      alias: 'קוטג\'', product: 'תנובה 5%', serving_grams: 250,
      kcal_per_100g: 121, variants: { 'חצי': 125, 'שלם': 250 },
    }), say(''));
    await post(handler, textUpdate('זכור קוטג\''));

    const [row] = db.rows('my_foods');
    assert.equal(row.alias, "קוטג'");
    assert.equal(row.serving_grams, 250);
    assert.deepEqual(row.variants, { 'חצי': 125, 'שלם': 250 });

    const [undoData] = undoIdFrom(lastMessage());
    await post(handler, callbackUpdate(undoData));
    assert.equal(db.rows('my_foods').length, 0);
  });

  test('merges into an existing alias without wiping unsent fields', async () => {
    db.insert('my_foods', {
      id: 1, chat_id: CHAT, alias: 'לחמניה', product: 'לחמניה מחיטה מלאה',
      serving_grams: 90, kcal_per_100g: 260,
    });
    scriptClaude(useTool('remember_food', { alias: 'לחמניה', serving_grams: 100 }), say(''));
    await post(handler, textUpdate('לחמניה 100 גרם'));

    const [row] = db.rows('my_foods');
    assert.equal(row.serving_grams, 100, 'updated');
    assert.equal(row.product, 'לחמניה מחיטה מלאה', 'preserved');
    assert.equal(row.kcal_per_100g, 260, 'preserved');
  });

  test('undo restores the previous values of an overwritten alias', async () => {
    db.insert('my_foods', { id: 1, chat_id: CHAT, alias: 'לחמניה', serving_grams: 90, kcal_per_100g: 260 });
    scriptClaude(useTool('remember_food', { alias: 'לחמניה', serving_grams: 100, kcal_per_100g: 300 }), say(''));
    await post(handler, textUpdate('שנה לחמניה'));
    const [undoData] = undoIdFrom(lastMessage());

    await post(handler, callbackUpdate(undoData));

    const [row] = db.rows('my_foods');
    assert.equal(row.serving_grams, 90);
    assert.equal(row.kcal_per_100g, 260);
  });

  test('dictionary is injected into the prompt before estimating', async () => {
    db.insert('my_foods', { id: 1, chat_id: CHAT, alias: 'לחמניה', serving_grams: 90, variants: { 'חצי': 45 } });
    scriptClaude(say('בסדר'));
    await post(handler, textUpdate('לחמניה'));

    const system = claudeCalls[0].system;
    assert.match(system, /לחמניה/);
    assert.match(system, /90 גרם/);
    assert.match(system, /וריאציות/);
  });

  test('a dictionary-only action shows no day summary', async () => {
    scriptClaude(useTool('remember_food', { alias: 'טונה', serving_grams: 100 }), say(''));
    await post(handler, textUpdate('זכור טונה'));

    assert.doesNotMatch(lastText(), /נותרו/);
    assert.match(lastText(), /מילון/);
  });
});

/* ============ measurements ============ */

describe('measurements', () => {
  test('Navy body fat is computed in code, not taken from the model', () => {
    // waist 105.5, neck 41, height 172 -> 29.3%
    assert.equal(core.navyBodyFat(105.5, 41, 172), 29.3);
    assert.equal(core.navyBodyFat(106, 41, 172), 29.6);
  });

  test('Navy returns null instead of NaN for impossible input', () => {
    assert.equal(core.navyBodyFat(40, 41, 172), null);
    assert.equal(core.navyBodyFat(null, 41, 172), null);
    assert.equal(core.navyBodyFat(105, null, 172), null);
  });

  test('neck falls back to the last known measurement', async () => {
    db.insert('measurements', { id: 1, chat_id: CHAT, measured_on: '2026-08-22', weight_kg: 96, waist_cm: 106, neck_cm: 41 });
    scriptClaude(useTool('log_measurement', { weight_kg: 95.8, waist_cm: 105.5 }), say(''));
    await post(handler, textUpdate('נשקלתי 95.8 מותן 105.5'));

    assert.match(lastText(), /29\.3%/);
    assert.match(lastText(), /-0\.2/, 'weight delta');
    assert.match(lastText(), /-0\.5/, 'waist delta');
  });

  test('same-day measurement merges and undo restores it', async () => {
    db.insert('measurements', { id: 1, chat_id: CHAT, measured_on: todayKey(), weight_kg: 96, neck_cm: 41 });
    scriptClaude(useTool('log_measurement', { waist_cm: 104 }), say(''));
    await post(handler, textUpdate('מותן 104'));

    let [row] = db.rows('measurements');
    assert.equal(row.waist_cm, 104);
    assert.equal(row.weight_kg, 96, 'weight untouched');

    const [undoData] = undoIdFrom(lastMessage());
    await post(handler, callbackUpdate(undoData));
    [row] = db.rows('measurements');
    assert.equal(row.waist_cm, undefined);
    assert.equal(row.weight_kg, 96);
  });

  test('an empty measurement call is rejected as a tool error', async () => {
    scriptClaude(useTool('log_measurement', {}), say('לא הבנתי מה נמדד'));
    await post(handler, textUpdate('מדדתי'));

    assert.equal(db.rows('measurements').length, 0);
    const toolResult = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
  });
});

/* ============ history + accuracy ============ */

describe('query_log and accuracy split', () => {
  test('aggregates by day and is read-only (no undo button)', async () => {
    seedMeal(CHAT, { id: 'm1', day_key: '2026-08-20', items: [ITEM({ calories: 500, protein: 40 })] });
    seedMeal(CHAT, { id: 'm2', day_key: '2026-08-20', items: [ITEM({ calories: 300, protein: 20 })] });
    seedMeal(CHAT, { id: 'm3', day_key: '2026-08-21', items: [ITEM({ calories: 700, protein: 50 })] });

    scriptClaude(
      useTool('query_log', { start_date: '2026-08-20', end_date: '2026-08-21' }),
      say('ממוצע 750 קלוריות')
    );
    await post(handler, textUpdate('כמה אכלתי בממוצע?'));

    const result = JSON.parse(claudeCalls.at(-1).messages.at(-1).content[0].content);
    assert.equal(result.days.length, 2);
    assert.equal(result.days[0].calories, 800);
    assert.equal(result.days[0].meals, 2);
    assert.equal(result.days[1].calories, 700);
    assert.equal(lastMessage().reply_markup, undefined, 'read-only: no undo');
  });

  test('rejects malformed dates', async () => {
    scriptClaude(useTool('query_log', { start_date: 'אתמול', end_date: 'היום' }), say('נסה שוב'));
    await post(handler, textUpdate('כמה אכלתי אתמול?'));
    const toolResult = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
  });

  test('accuracy split weights by calories and uses per-item provenance', () => {
    const rows = [{
      confidence: 'medium',
      items: [
        { calories: 300, source_type: 'personal_food' },
        { calories: 100, source_type: 'ai_estimate' },
      ],
    }];
    assert.deepEqual(core.estimateSplit(rows), { measuredPct: 75, estimatedPct: 25 });
  });

  test('legacy rows without source_type fall back to meal confidence', () => {
    const rows = [
      { confidence: 'high', items: [{ calories: 200 }] },
      { confidence: 'low', items: [{ calories: 200 }] },
    ];
    assert.deepEqual(core.estimateSplit(rows), { measuredPct: 50, estimatedPct: 50 });
  });

  test('no calories logged yields null rather than a divide-by-zero', () => {
    assert.equal(core.estimateSplit([]), null);
    assert.equal(core.estimateSplit([{ confidence: 'high', items: [] }]), null);
  });
});

/* ============ conversation memory ============ */

describe('conversation memory', () => {
  test('previous turns are replayed as alternating roles starting with user', async () => {
    db.insert('agent_chat_log', [
      { id: 1, chat_id: CHAT, role: 'user', content: 'אכלתי יוגורט', created_at: new Date().toISOString() },
      { id: 2, chat_id: CHAT, role: 'assistant', content: 'איזה יוגורט?', created_at: new Date().toISOString() },
    ]);
    scriptClaude(say('הבנתי'));
    await post(handler, textUpdate('התות חלבון'));

    const msgs = claudeCalls[0].messages;
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'אכלתי יוגורט');
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs.at(-1).content, 'התות חלבון');
    for (let i = 1; i < msgs.length; i++) {
      assert.notEqual(msgs[i].role, msgs[i - 1].role, 'roles must alternate');
    }
  });

  test('a log starting with an assistant turn is trimmed, not sent as-is', async () => {
    db.insert('agent_chat_log', [
      { id: 1, chat_id: CHAT, role: 'assistant', content: 'שלום', created_at: new Date().toISOString() },
      { id: 2, chat_id: CHAT, role: 'user', content: 'היי', created_at: new Date().toISOString() },
      { id: 3, chat_id: CHAT, role: 'assistant', content: 'מה אכלת?', created_at: new Date().toISOString() },
    ]);
    scriptClaude(say('ok'));
    await post(handler, textUpdate('תפוח'));

    const msgs = claudeCalls[0].messages;
    assert.equal(msgs[0].role, 'user');
    for (let i = 1; i < msgs.length; i++) {
      assert.notEqual(msgs[i].role, msgs[i - 1].role);
    }
  });

  test('consecutive same-role entries are coalesced', async () => {
    db.insert('agent_chat_log', [
      { id: 1, chat_id: CHAT, role: 'user', content: 'שורה א', created_at: new Date().toISOString() },
      { id: 2, chat_id: CHAT, role: 'user', content: 'שורה ב', created_at: new Date().toISOString() },
      { id: 3, chat_id: CHAT, role: 'assistant', content: 'הבנתי', created_at: new Date().toISOString() },
    ]);
    scriptClaude(say('ok'));
    await post(handler, textUpdate('עוד'));

    const msgs = claudeCalls[0].messages;
    assert.match(msgs[0].content, /שורה א/);
    assert.match(msgs[0].content, /שורה ב/);
    for (let i = 1; i < msgs.length; i++) {
      assert.notEqual(msgs[i].role, msgs[i - 1].role);
    }
  });

  test('stale turns beyond the window are not replayed', async () => {
    const old = new Date(Date.now() - 5 * 3600_000).toISOString();
    db.insert('agent_chat_log', [{ id: 1, chat_id: CHAT, role: 'user', content: 'ישן מאוד', created_at: old }]);
    scriptClaude(say('ok'));
    await post(handler, textUpdate('חדש'));

    assert.equal(claudeCalls[0].messages.length, 1);
  });

  test('another chat\'s history never leaks in', async () => {
    db.insert('agent_chat_log', [{ id: 1, chat_id: 999, role: 'user', content: 'של מישהו אחר', created_at: new Date().toISOString() }]);
    scriptClaude(say('ok'));
    await post(handler, textUpdate('שלי'));

    assert.equal(claudeCalls[0].messages.length, 1);
  });
});

/* ============ photos ============ */

describe('photos', () => {
  test('a photo reaches Claude as an image block with the caption as a hint', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'high' }), say(''));
    await post(handler, photoUpdate('זה 150 גרם'));

    const content = claudeCalls[0].messages.at(-1).content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.type, 'base64');
    assert.match(content[1].text, /150 גרם/);
    assert.equal(db.rows('meals')[0].raw_text, 'זה 150 גרם');
  });

  test('a photo without a caption still logs, with a placeholder raw_text', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'low' }), say(''));
    await post(handler, photoUpdate(null));

    assert.equal(db.rows('meals').length, 1);
    assert.match(db.rows('meals')[0].raw_text, /תמונה/);
  });
});

/* ============ formatting / safety ============ */

describe('rendering', () => {
  test('HTML in a food name is escaped, not injected', async () => {
    scriptClaude(useTool('log_meal', {
      items: [ITEM({ name: '<b>עוגה</b> & סוכר' })], confidence: 'low',
    }), say(''));
    await post(handler, textUpdate('עוגה'));

    assert.match(lastText(), /&lt;b&gt;עוגה&lt;\/b&gt; &amp; סוכר/);
  });

  test('assumptions text is escaped too', async () => {
    scriptClaude(useTool('log_meal', {
      items: [ITEM()], confidence: 'low', assumptions: 'הנחתי <100 גרם',
    }), say(''));
    await post(handler, textUpdate('משהו'));
    assert.match(lastText(), /&lt;100/);
  });

  test('numbers never render as "X / Y" (flips visually in RTL)', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(''));
    await post(handler, textUpdate('חזה עוף'));

    assert.doesNotMatch(lastText(), /\d\s*\/\s*\d/, 'use "מתוך" instead of a slash');
    assert.match(lastText(), /מתוך/);
  });

  test('all three macros are visible without expanding', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(''));
    await post(handler, textUpdate('חזה עוף'));

    const visible = lastText().split('<blockquote')[0];
    assert.match(visible, /חלבון/);
    assert.match(visible, /פחמימות/);
    assert.match(visible, /שומן/);
  });

  test('a long multi-item meal stays under the Telegram 4096-char limit', async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      ITEM({ name: `מנה מספר ${i} עם שם ארוך במיוחד לבדיקה`, calories: 100 }));
    scriptClaude(useTool('log_meal', { items, confidence: 'low', assumptions: 'הנחה '.repeat(40) }), say(''));
    await post(handler, textUpdate('ארוחה גדולה'));

    assert.ok(lastText().length < 4096, `message was ${lastText().length} chars`);
  });

  test('a trivial model echo is dropped, a substantive note is kept', async () => {
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }, { text: '' }), say('נרשם 👍'));
    await post(handler, textUpdate('חזה עוף'));
    assert.doesNotMatch(lastText(), /נרשם 👍/);

    resetAll();
    seedGoals();
    const note = 'שים לב שהערכתי לפי מנה גדולה, אם זו מנה קטנה תקן אותי בבקשה';
    scriptClaude(useTool('log_meal', { items: [ITEM()], confidence: 'medium' }), say(note));
    await post(handler, textUpdate('חזה עוף'));
    assert.match(lastText(), /שים לב/);
  });
});

/* ============ agent loop control ============ */

describe('agent loop', () => {
  test('stops after the round cap instead of looping forever', async () => {
    scriptClaude(
      useTool('log_meal', { items: [ITEM()], confidence: 'medium' }),
      useTool('log_meal', { items: [ITEM()], confidence: 'medium' }),
      useTool('log_meal', { items: [ITEM()], confidence: 'medium' }),
      useTool('log_meal', { items: [ITEM()], confidence: 'medium' })
    );
    await post(handler, textUpdate('לולאה'));

    assert.ok(claudeCalls.length <= 3, `called ${claudeCalls.length} times`);
  });

  test('a paused server-tool turn (web search) is resumed', async () => {
    scriptClaude(
      pauseTurn(),
      useTool('log_meal', { items: [ITEM({ name: 'נאגטס', calories: 458 })], confidence: 'medium' }),
      say('')
    );
    await post(handler, textUpdate('11 נאגטס במקדונלדס'));

    assert.equal(db.rows('meals').length, 1);
    assert.equal(db.rows('meals')[0].totals.calories, 458);
    assert.equal(claudeCalls[1].messages.at(-1).role, 'assistant', 'paused turn pushed back');
  });

  test('web search is offered to the model as a server tool', async () => {
    scriptClaude(say('ok'));
    await post(handler, textUpdate('שאלה'));

    const tools = claudeCalls[0].tools.map((t) => t.name);
    assert.ok(tools.includes('web_search'));
    assert.ok(tools.includes('log_meal'));
    assert.equal(claudeCalls[0].temperature, undefined, 'temperature is rejected on Sonnet 5');
  });

  test('today\'s meals are injected with full item JSON so updates copy verbatim', async () => {
    seedMeal(CHAT, { items: [ITEM({ name: 'מעדן', calories: 130, source_type: 'label' })] });
    scriptClaude(say('ok'));
    await post(handler, textUpdate('שאלה'));

    const system = claudeCalls[0].system;
    assert.match(system, /items=/);
    assert.match(system, /"calories":130/);
    assert.match(system, /"source_type":"label"/);
  });
});

/* ============ export ============ */

describe('/export', () => {
  test('includes goals, measurements, days and the dictionary', async () => {
    db.insert('measurements', { id: 1, chat_id: CHAT, measured_on: '2026-08-22', weight_kg: 96, waist_cm: 106, neck_cm: 41 });
    db.insert('my_foods', { id: 1, chat_id: CHAT, alias: 'לחמניה', serving_grams: 90 });
    seedMeal(CHAT, { day_key: todayKey() });

    await post(handler, textUpdate('/export'));

    const all = sent.map((s) => s.text).join('\n');
    assert.match(all, /GOALS: 2100/);
    assert.match(all, /2026-08-22 \| 96 \| 106 \| 41/);
    assert.match(all, /MY_FOODS/);
    assert.match(all, /לחמניה/);
    assert.equal(db.rows('meals').length, 1, 'export writes nothing');
  });

  test('splits into multiple messages beyond the Telegram limit', async () => {
    for (let i = 0; i < 200; i++) {
      db.insert('my_foods', { id: i + 1, chat_id: CHAT, alias: `מאכל ארוך מספר ${i}`, product: 'מוצר עם שם ארוך מאוד לבדיקה', serving_grams: 100 });
    }
    await post(handler, textUpdate('/export'));

    assert.ok(sent.length > 1, 'should split');
    for (const m of sent) assert.ok(m.text.length < 4096);
  });
});

/* ============ multi-user isolation ============ */

describe('isolation', () => {
  test('one chat cannot read or undo another chat\'s data', async () => {
    const other = seedMeal(777888, { id: 'other-meal' });
    db.insert('agent_actions', { id: 5000, chat_id: 777888, kind: 'log_meal', payload: { meal_id: other.id }, undone: false });

    await post(handler, callbackUpdate('undo:5000'));

    assert.equal(db.rows('meals').length, 1, "other chat's meal survived");
    const ack = tgCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    assert.match(ack.body.text, /כבר בוטל/);
  });

  test('context only contains the current chat\'s meals and foods', async () => {
    seedMeal(777888, { id: 'theirs', raw_text: 'סודי' });
    db.insert('my_foods', { id: 9, chat_id: 777888, alias: 'שלהם', serving_grams: 1 });
    scriptClaude(say('ok'));
    await post(handler, textUpdate('שאלה'));

    assert.doesNotMatch(claudeCalls[0].system, /שלהם/);
    assert.doesNotMatch(claudeCalls[0].system, /theirs/);
  });
});

/* ============ goals + dashboard (parity with the old bot) ============ */

describe('set_goals', () => {
  test('merges a partial change and marks what moved', async () => {
    scriptClaude(useTool('set_goals', { protein: 150 }), say(''));
    await post(handler, textUpdate('תעדכן יעד חלבון ל-150'));

    const [g] = db.rows('goals');
    assert.equal(g.protein, 150);
    assert.equal(g.calories, 2100, 'other goals preserved');
    assert.match(lastText(), /150/);
    assert.doesNotMatch(lastText(), /נותרו/, 'goal change is not a meal write');
  });

  test('undo restores the previous goals exactly', async () => {
    scriptClaude(useTool('set_goals', { calories: 1800, protein: 160 }), say(''));
    await post(handler, textUpdate('שנה יעדים'));
    const [undoData] = undoIdFrom(lastMessage());

    await post(handler, callbackUpdate(undoData));

    const [g] = db.rows('goals');
    assert.equal(g.calories, 2100);
    assert.equal(g.protein, 140);
  });

  test('rejects nonsense values instead of storing them', async () => {
    scriptClaude(useTool('set_goals', { calories: -500 }), say('יעד חייב להיות חיובי'));
    await post(handler, textUpdate('יעד מינוס'));

    assert.equal(db.rows('goals')[0].calories, 2100);
    const toolResult = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
  });

  test('an empty call is refused', async () => {
    scriptClaude(useTool('set_goals', {}), say('מה לשנות?'));
    await post(handler, textUpdate('שנה יעד'));
    const toolResult = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
  });
});

describe('/dashboard', () => {
  test('creates a login session and returns a code plus a one-tap link', async () => {
    process.env.DASH_URL = 'https://nutrition-bot-fawn.vercel.app';
    const { default: freshHandler } = await import('../api/agent.js?dash=1');

    await post(freshHandler, textUpdate('/dashboard'));

    const msg = lastMessage();
    assert.match(msg.text, /\d{6}/, 'six-digit code shown');
    const url = msg.reply_markup.inline_keyboard[0][0].url;
    assert.match(url, /dashboard\.html#t=[0-9a-f]{48}/);
    assert.equal(db.rows('dash_sessions').length, 1);
    assert.equal(db.rows('dash_sessions')[0].chat_id, CHAT);
    assert.equal(db.rows('dash_sessions')[0].verified, false);
  });
});

/* ============ dictionary quality ============ */

describe('/foods and dictionary completeness', () => {
  test('separates complete entries from ones missing macros', async () => {
    db.insert('my_foods', [
      { id: 1, chat_id: CHAT, alias: 'קוטג\'', serving_grams: 250, kcal_per_100g: 121 },
      { id: 2, chat_id: CHAT, alias: 'לחמניה', serving_grams: 90 },
    ]);
    await post(handler, textUpdate('/foods'));

    const t = lastText();
    assert.match(t, /מלאים/);
    assert.match(t, /חסרים ערכים/);
    assert.ok(t.indexOf('קוטג') < t.indexOf('חסרים ערכים'), 'complete entries listed first');
  });

  test('an empty dictionary explains how to fill it', async () => {
    await post(handler, textUpdate('/foods'));
    assert.match(lastText(), /ריק/);
  });

  test('incomplete entries are flagged to the model in context', async () => {
    db.insert('my_foods', [
      { id: 1, chat_id: CHAT, alias: 'לחמניה', serving_grams: 90 },
      { id: 2, chat_id: CHAT, alias: 'קוטג\'', serving_grams: 250, kcal_per_100g: 121 },
    ]);
    scriptClaude(say('ok'));
    await post(handler, textUpdate('שאלה'));

    const system = claudeCalls[0].system;
    assert.match(system, /"לחמניה" ⚠️חסרים ערכים/);
    assert.doesNotMatch(system, /"קוטג'" ⚠️/);
  });
});

/* ============ barcode ============ */

describe('lookup_barcode', () => {
  test('personal dictionary wins over the external database', async () => {
    db.insert('my_foods', {
      id: 1, chat_id: CHAT, alias: 'החלבון שלי', product: 'אבקת חלבון',
      barcode: '7290004131074', serving_grams: 33, kcal_per_100g: 380, protein_per_100g: 78,
    });
    scriptClaude(useTool('lookup_barcode', { barcode: '7290004131074' }), say('זיהיתי'));
    await post(handler, textUpdate('ברקוד'));

    const r = JSON.parse(claudeCalls.at(-1).messages.at(-1).content[0].content);
    assert.equal(r.found, true);
    assert.equal(r.source, 'personal', 'no network call needed');
    assert.equal(r.per100g.kcal, 380);
  });

  test('a barcode miss is a normal answer, not an error', async () => {
    globalThis.__offStatus = 0;
    scriptClaude(useTool('lookup_barcode', { barcode: '7290000042886' }), say('לא מצאתי, שלח תמונת תווית'));
    await post(handler, textUpdate('ברקוד לא מוכר'));

    const block = claudeCalls.at(-1).messages.at(-1).content[0];
    assert.notEqual(block.is_error, true);
    const r = JSON.parse(block.content);
    assert.equal(r.found, false);
    assert.match(lastText(), /תווית/);
  });

  test('a malformed barcode is rejected before any lookup', async () => {
    scriptClaude(useTool('lookup_barcode', { barcode: '12' }), say('הברקוד לא תקין'));
    await post(handler, textUpdate('ברקוד'));
    assert.equal(claudeCalls.at(-1).messages.at(-1).content[0].is_error, true);
  });

  test('a barcode saved via remember_food makes the next scan instant', async () => {
    scriptClaude(useTool('remember_food', {
      alias: 'במבה', product: 'אוסם במבה', barcode: '7290000066127',
      serving_grams: 60, kcal_per_100g: 526, protein_per_100g: 15,
    }), say(''));
    await post(handler, textUpdate('הנה התווית'));

    assert.equal(db.rows('my_foods')[0].barcode, '7290000066127');

    scriptClaude(useTool('lookup_barcode', { barcode: '7290000066127' }), say('במבה'));
    await post(handler, textUpdate('ברקוד שוב'));
    const r = JSON.parse(claudeCalls.at(-1).messages.at(-1).content[0].content);
    assert.equal(r.source, 'personal');
    assert.equal(r.per100g.kcal, 526);
  });

  test('lookup is a read: no undo button, nothing written', async () => {
    db.insert('my_foods', { id: 1, chat_id: CHAT, alias: 'x', barcode: '1234567890', kcal_per_100g: 100 });
    scriptClaude(useTool('lookup_barcode', { barcode: '1234567890' }), say('זה המוצר, כמה אכלת?'));
    await post(handler, textUpdate('ברקוד'));

    assert.equal(lastMessage().reply_markup, undefined);
    assert.equal(db.rows('meals').length, 0);
  });
});
