// Nutrition AGENT bot — webhook route, runs in parallel to api/telegram.js.
// Every text message goes through the Claude agent loop (lib/agent-core.js).
// Every write action replies with what was done + an inline undo button.

import { createClient } from '@supabase/supabase-js';
import { getContext, runAgent, undoAction, estimateSplit, getDay } from '../lib/agent-core.js';

const TOKEN = process.env.AGENT_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ---------------- telegram helpers ---------------- */

const esc = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (x) => Math.round(x || 0).toLocaleString('he-IL');
const r1 = (x) => Math.round((x || 0) * 10) / 10;
const RULE = '━━━━━━━━━━━━━';

async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.error('telegram error:', method, data);
  return data;
}

const send = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

/* ---------------- dedupe (DB-backed, survives cold starts) ---------------- */

async function firstTimeSeen(updateId) {
  const { error } = await sb.from('agent_updates').insert({ update_id: updateId });
  if (!error) return true;
  if (error.code === '23505') return false; // duplicate — already handled
  console.error('dedupe insert error:', error);
  return true; // fail open: better a rare duplicate than a dropped meal
}

/* ---------------- formatting ---------------- */

function bar(val, goal, width = 10) {
  const pct = goal > 0 ? Math.min(1, val / goal) : 0;
  const filled = Math.round(pct * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
const pctTxt = (val, goal) => (goal > 0 ? Math.round((val / goal) * 100) + '%' : '—');

function sumTotals(rows) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r.totals?.[k]) || 0;
  return t;
}

function daySummary(rows, goals) {
  const day = sumTotals(rows);
  const rem = goals.calories - day.calories;
  const remLine = rem >= 0 ? `נותרו <b>${n(rem)}</b>` : `חריגה <b>${n(-rem)}</b> 🔺`;
  let s =
    `📊 <b>היום עד עכשיו</b>\n\n` +
    `🔥 <b>קלוריות</b>\n` +
    `<code>${bar(day.calories, goals.calories)}</code> ${pctTxt(day.calories, goals.calories)}\n` +
    `<b>${n(day.calories)}</b> / ${n(goals.calories)}  ·  ${remLine}\n\n` +
    `🥩 <b>חלבון</b>  <code>${bar(day.protein, goals.protein)}</code> ${r1(day.protein)}/${goals.protein} ג\n` +
    `🍚 <b>פחמימות</b>  <code>${bar(day.carbs, goals.carbs)}</code> ${r1(day.carbs)}/${goals.carbs} ג\n` +
    `🧈 <b>שומן</b>  <code>${bar(day.fat, goals.fat)}</code> ${r1(day.fat)}/${goals.fat} ג`;
  const split = estimateSplit(rows);
  if (split) s += `\n\n🎯 מדויק ${split.measuredPct}% · 〰️ הערכה ${split.estimatedPct}% <i>(מהקלוריות)</i>`;
  return s;
}

const CONF_ICON = { high: '🎯 דיוק גבוה', medium: '〰️ הערכה', low: '❔ הערכה גסה' };

function rememberBlock(a) {
  const s = a.saved || {};
  const lines = [];
  if (s.product) lines.push(`   מוצר: ${esc(s.product)}`);
  if (s.serving_grams) lines.push(`   מנה: ${s.serving_grams} גרם`);
  if (s.kcal_per_100g != null) {
    let m = `   ל-100 גרם: ${s.kcal_per_100g} קק"ל`;
    if (s.protein_per_100g != null) m += ` · חלבון ${s.protein_per_100g}`;
    if (s.carbs_per_100g != null) m += ` · פחמ' ${s.carbs_per_100g}`;
    if (s.fat_per_100g != null) m += ` · שומן ${s.fat_per_100g}`;
    lines.push(m);
  }
  if (s.variants) {
    lines.push(`   וריאציות: ${esc(Object.entries(s.variants).map(([k, v]) => `${k}=${v} גרם`).join(', '))}`);
  }
  const head = a.isNew ? '🧠 <b>נשמר במילון</b>' : '🧠 <b>המילון עודכן</b>';
  return `${head}  ·  "${esc(a.alias)}"\n${RULE}\n${lines.join('\n') || '   (עודכן)'}`;
}

function actionBlock(a) {
  if (a.kind === 'remember_food') return rememberBlock(a);
  const head =
    a.kind === 'log_meal' ? '✅ <b>נוסף ליומן</b>'
    : a.kind === 'delete_meal' ? '🗑 <b>נמחק מהיומן</b>'
    : '✏️ <b>הרישום עודכן</b>';
  const conf = CONF_ICON[a.confidence] || '〰️ הערכה';
  const lines = a.items.map(
    (it) => `   • ${esc(it.name)} — <b>${n(it.calories)}</b> קק"ל  <i>(${esc(it.portion || `${it.grams} גרם`)})</i>`
  );
  let s =
    `${head}  ·  ${conf}\n${RULE}\n` +
    lines.join('\n') +
    `\n\n🍽 <b>סה"כ הארוחה: ${n(a.totals.calories)} קק"ל</b>\n` +
    `   🥩 ${r1(a.totals.protein)}  ·  🍚 ${r1(a.totals.carbs)}  ·  🧈 ${r1(a.totals.fat)}`;
  if (a.assumptions) s += `\n<i>ℹ️ ${esc(a.assumptions)}</i>`;
  return s;
}

/* ---------------- entry point ---------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('nutrition agent is up');

  const secret = process.env.AGENT_SECRET_TOKEN;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('unauthorized');
  }

  try {
    const update = req.body || {};
    if (update.update_id && !(await firstTimeSeen(update.update_id))) {
      return res.status(200).send('dup');
    }
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (err) {
    console.error('handler error:', err);
  }
  return res.status(200).send('ok');
}

/* ---------------- routing ---------------- */

async function downloadPhotoBase64(fileId) {
  const info = await tg('getFile', { file_id: fileId });
  const path = info?.result?.file_path;
  if (!path) throw new Error('no file_path from telegram');
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`);
  if (!res.ok) throw new Error(`file download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    base64: buf.toString('base64'),
    mediaType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
  };
}

async function onMessage(msg) {
  const chatId = msg.chat.id;

  if (msg.voice || msg.audio) {
    return send(chatId, 'קול עוד לא נתמך — כתוב לי בטקסט 🙂');
  }

  // What goes into the agent: plain text, or image block + text hint for photos.
  let userContent, rawText;

  if (msg.photo) {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    let img;
    try {
      img = await downloadPhotoBase64(msg.photo[msg.photo.length - 1].file_id);
    } catch (err) {
      console.error('photo download error:', err);
      return send(chatId, 'לא הצלחתי להוריד את התמונה. נסה לשלוח אותה שוב.');
    }
    const caption = (msg.caption || '').trim();
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
      { type: 'text', text: caption ? `רמז מהמשתמש: ${caption}` : 'נתח את התמונה. אם זה אוכל — רשום את הארוחה.' },
    ];
    rawText = caption || '📷 תמונה';
    return processWithAgent(chatId, userContent, rawText);
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/start') {
    return send(
      chatId,
      '🤖 <b>היי! אני סוכן התזונה שלך</b>\n' +
        `${RULE}\n` +
        'פשוט כתוב בשפה חופשית:\n' +
        '• <i>"חזה עוף 200 גרם עם אורז"</i> — רישום\n' +
        '• <i>"הלחמנייה הייתה 90 גרם"</i> — תיקון\n' +
        '• <i>"אכלתי בצהריים טונה ושכחתי לרשום"</i> — רישום לאחור\n' +
        '• <i>"זכור שכף אבקת חלבון היא 33 גרם"</i> — המילון האישי\n' +
        '• <i>"כמה חלבון אכלתי היום?"</i> — שאלה\n\n' +
        'כל רישום מגיע עם כפתור <b>בטל</b> — טעות מתקנים בלחיצה.'
    );
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  return processWithAgent(chatId, text, text);
}

/* Shared agent flow for text and photos: run, then confirm/answer. */
async function processWithAgent(chatId, userContent, rawText) {
  let result;
  try {
    const ctx = await getContext(chatId);
    result = await runAgent(chatId, userContent, ctx, rawText);
  } catch (err) {
    console.error('agent error:', err);
    return send(chatId, 'לא הצלחתי לעבד את זה כרגע 😕 נסה לשלוח שוב.');
  }

  const { actions, text: agentText } = result;

  // No write — plain answer / clarification question
  if (!actions.length) {
    return send(chatId, esc(agentText || 'לא הבנתי — נסה לנסח שוב.'));
  }

  // Writes happened — confirmation block(s) + day summary + undo button(s)
  const [goalsRow, rows] = await Promise.all([
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
    getDay(chatId),
  ]);
  const goals = goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 };

  const blocks = actions.map(actionBlock);
  let body = blocks.join(`\n\n${RULE}\n`);
  if (agentText) body += `\n\n💬 <i>${esc(agentText)}</i>`;
  // Day summary only when a meal was written — a dictionary-only action doesn't need it.
  if (actions.some((a) => a.kind === 'log_meal' || a.kind === 'update_meal' || a.kind === 'delete_meal')) {
    body += `\n\n${RULE}\n${daySummary(rows, goals)}`;
  }

  const undoRow = actions.map((a, i) => ({
    text: actions.length > 1 ? `↩️ בטל ${i + 1}` : '↩️ בטל',
    callback_data: `undo:${a.actionId}`,
  }));

  return send(chatId, body, { reply_markup: { inline_keyboard: [undoRow] } });
}

/* ---------------- undo callback ---------------- */

async function onCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text && { text }) });

  if (!chatId || !data.startsWith('undo:')) return ack();

  let result;
  try {
    result = await undoAction(chatId, Number(data.slice(5)));
  } catch (err) {
    console.error('undo error:', err);
    return ack('הביטול נכשל — נסה שוב');
  }

  if (!result.ok) return ack('כבר בוטל');

  await ack('בוטל ✔️');

  const [goalsRow, rows] = await Promise.all([
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
    getDay(chatId),
  ]);
  const goals = goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 };
  const day = sumTotals(rows);
  const verb =
    result.kind === 'log_meal' ? 'הרישום נמחק'
    : result.kind === 'delete_meal' ? 'הרישום שוחזר'
    : result.kind === 'remember_food' ? 'המילון שוחזר'
    : 'העדכון שוחזר';

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: cb.message.message_id,
    parse_mode: 'HTML',
    text:
      `↩️ <b>בוטל</b> — ${verb}.\n\n` +
      `<b>היום:</b> ${n(day.calories)} / ${n(goals.calories)} קק"ל · חלבון ${r1(day.protein)} ג`,
  });
}
