// Test harness: env, fetch interception (Telegram + Anthropic), request helpers.
// Must be imported before api/agent.js so env vars are set at module-load time.

process.env.SUPABASE_URL ||= 'http://fake.supabase';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-key';
process.env.AGENT_BOT_TOKEN ||= 'TESTTOKEN';
process.env.AGENT_SECRET_TOKEN ||= 'test-secret';
process.env.ANTHROPIC_API_KEY ||= 'fake-anthropic';
process.env.AGENT_HEIGHT_CM ||= '172';

import { __reset, __db } from './fakes/supabase.js';

export const CHAT = 555001;

export const sent = [];        // telegram sendMessage payloads
export const tgCalls = [];     // every telegram method call
export const claudeCalls = []; // request bodies sent to the Messages API
let claudeQueue = [];
let anthropicFailure = null;

export function scriptClaude(...responses) { claudeQueue.push(...responses); }
export function failAnthropic(status = 500, body = 'boom') { anthropicFailure = { status, body }; }

/* Convenience builders for Anthropic responses */
export const say = (text) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});
export const useTool = (name, input, { text = '', id = `tu_${Math.random().toString(36).slice(2)}` } = {}) => ({
  stop_reason: 'tool_use',
  content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input }],
});
export const useTools = (calls, text = '') => ({
  stop_reason: 'tool_use',
  content: [
    ...(text ? [{ type: 'text', text }] : []),
    ...calls.map((c, i) => ({ type: 'tool_use', id: `tu_multi_${i}`, name: c.name, input: c.input })),
  ],
});
export const pauseTurn = () => ({
  stop_reason: 'pause_turn',
  content: [{ type: 'text', text: 'מחפש…' }],
});

const origFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);

  if (u.startsWith('https://api.telegram.org/file/')) {
    return new Response(Buffer.from('fake-image-bytes'), { status: 200 });
  }

  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop();
    const body = init.body ? JSON.parse(init.body) : {};
    tgCalls.push({ method, body });
    if (method === 'sendMessage') sent.push(body);
    if (method === 'getFile') {
      return jsonRes({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
    }
    return jsonRes({ ok: true, result: { message_id: tgCalls.length } });
  }

  if (u === 'https://api.anthropic.com/v1/messages') {
    claudeCalls.push(JSON.parse(init.body));
    if (anthropicFailure) {
      return new Response(anthropicFailure.body, { status: anthropicFailure.status });
    }
    const next = claudeQueue.shift();
    if (!next) throw new Error('claude called more times than scripted');
    return jsonRes(next);
  }

  if (origFetch) return origFetch(url, init);
  throw new Error(`unexpected fetch: ${u}`);
};

const jsonRes = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

/* ---------------- request plumbing ---------------- */

let updateId = 1000;

export function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

export function textUpdate(text, { chat = CHAT, id } = {}) {
  return {
    update_id: id ?? ++updateId,
    message: { message_id: 1, chat: { id: chat }, text },
  };
}

export function photoUpdate(caption, { chat = CHAT, id } = {}) {
  return {
    update_id: id ?? ++updateId,
    message: {
      message_id: 1, chat: { id: chat },
      photo: [{ file_id: 'small' }, { file_id: 'big' }],
      ...(caption ? { caption } : {}),
    },
  };
}

export function callbackUpdate(data, { chat = CHAT, id, messageId = 42 } = {}) {
  return {
    update_id: id ?? ++updateId,
    callback_query: { id: 'cb1', data, message: { message_id: messageId, chat: { id: chat } } },
  };
}

export async function post(handler, update, { secret = 'test-secret' } = {}) {
  const res = makeRes();
  await handler(
    { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: update },
    res
  );
  return res;
}

/* ---------------- state helpers ---------------- */

export function resetAll() {
  __reset();
  sent.length = 0;
  tgCalls.length = 0;
  claudeCalls.length = 0;
  claudeQueue = [];
  anthropicFailure = null;
}

export const db = __db;
export const lastMessage = () => sent[sent.length - 1];
export const lastText = () => (lastMessage() || {}).text || '';
export const undoIdFrom = (msg) => {
  const kb = msg?.reply_markup?.inline_keyboard?.[0] || [];
  return kb.map((b) => b.callback_data);
};

export function seedGoals(chat = CHAT, g = { calories: 2100, protein: 140, carbs: 200, fat: 100 }) {
  __db.insert('goals', { chat_id: chat, ...g });
}

export function seedMeal(chat = CHAT, over = {}) {
  const items = over.items || [
    { name: 'ביצה', grams: 50, calories: 78, protein: 6.3, carbs: 0.6, fat: 5.3, source_type: 'ai_estimate', quantity_source: 'default' },
  ];
  const totals = items.reduce(
    (t, i) => {
      for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium_mg']) t[k] += Number(i[k]) || 0;
      return t;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 }
  );
  const row = {
    id: over.id || 'meal-1',
    chat_id: chat,
    ts: over.ts || new Date().toISOString(),
    day_key: over.day_key || todayKey(),
    raw_text: over.raw_text || 'ביצה',
    items, totals,
    assumptions: over.assumptions || '',
    confidence: over.confidence || 'medium',
    source: 'agent',
  };
  __db.insert('meals', row);
  return row;
}

export const todayKey = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
