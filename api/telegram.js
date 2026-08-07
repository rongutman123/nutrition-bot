// Telegram nutrition bot — Vercel serverless webhook
// Flow: incoming message → Claude parses the meal → saved to Supabase → reply
// with a full breakdown + rolling daily totals. Inline button deletes a log.

import { parseMeal, sumItems } from '../lib/claude.js';
import {
  saveMeal, deleteMeal, getDayMeals, getGoals, setGoals, dayKey, lastDayKeys,
} from '../lib/db.js';

const API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/* ---------------- small helpers ---------------- */

const esc = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (x) => Math.round(x || 0).toLocaleString('he-IL');
const r1 = (x) => Math.round((x || 0) * 10) / 10;
const short = (s = '') => (s.length > 36 ? s.slice(0, 35) + '…' : s);

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

function sumTotals(rows) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r.totals?.[k]) || 0;
  return t;
}

function dayLine(day, goals, label = 'היום') {
  const over = day.calories > goals.calories;
  return (
    `<b>${label}:</b> ${n(day.calories)} / ${n(goals.calories)} קק"ל${over ? ' 🔺' : ''}\n` +
    `חלבון ${r1(day.protein)}/${goals.protein} · פחמ' ${r1(day.carbs)}/${goals.carbs} · שומן ${r1(day.fat)}/${goals.fat}`
  );
}

/* ---------------- entry point ---------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('nutrition bot is up');

  // Reject anything that didn't come from Telegram (secret set at setWebhook time)
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('unauthorized');
  }

  try {
    const update = req.body || {};
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (err) {
    console.error('handler error:', err);
  }
  // Always 200 so Telegram doesn't retry-storm the function
  return res.status(200).send('ok');
}

/* ---------------- message routing ---------------- */

async function onMessage(msg) {
  const chatId = msg.chat.id;

  if (msg.voice || msg.audio) {
    return send(chatId, 'בגרסה הזו אני קורא טקסט בלבד. תיאור קולי — בשלב הבא 🎙️');
  }
  if (msg.photo) {
    return send(chatId, 'זיהוי ברקוד מתמונה עוד לא כאן. בינתיים כתוב לי מה אכלת 📝');
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/')) return onCommand(chatId, text);
  return onMeal(chatId, text);
}

async function onCommand(chatId, text) {
  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd.split('@')[0]) {
    case '/start':
      return send(
        chatId,
        'היי! אני יומן התזונה שלך 🥗\n\n' +
          'פשוט כתוב לי מה אכלת, בשפה חופשית:\n' +
          '<i>"חזה עוף 200 גרם, כוס אורז וסלט עם כף שמן זית"</i>\n\n' +
          'אני אפרק לפריטים, אחשב ערכים תזונתיים ואעדכן את הסיכום היומי.\n\n' +
          '<b>פקודות</b>\n' +
          '/today — סיכום היום\n' +
          '/week — 7 ימים אחרונים\n' +
          '/goals — צפייה ביעדים\n' +
          '<code>/goals 1800 140 170 60</code> — עדכון (קלוריות, חלבון, פחמימות, שומן)'
      );
    case '/today':
      return cmdToday(chatId);
    case '/week':
      return cmdWeek(chatId);
    case '/goals':
      return cmdGoals(chatId, args);
    default:
      return send(chatId, 'לא מכיר את הפקודה הזו. נסה /start');
  }
}

/* ---------------- meal logging ---------------- */

async function onMeal(chatId, text) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  let parsed;
  try {
    parsed = await parseMeal(text);
  } catch (err) {
    console.error('parse error:', err);
    return send(
      chatId,
      'לא הצלחתי לנתח את זה כרגע. נסה שוב, או פרט קצת יותר — למשל: "2 ביצים, פרוסת לחם מלא, כף חמאת בוטנים".'
    );
  }

  if (!parsed.items?.length) {
    return send(chatId, 'לא זיהיתי כאן אוכל 🤔 כתוב לי מה אכלת — למשל: "קערת יוגורט עם גרנולה ובננה".');
  }

  const totals = sumItems(parsed.items);

  const confIcon =
    { high: '🎯 דיוק גבוה', medium: '〰️ הערכה', low: '❔ הערכה גסה' }[parsed.confidence] || '〰️ הערכה';

  const lines = parsed.items.map(
    (it) => `• ${esc(it.name)} <i>(${esc(it.portion || '')})</i> — ${n(it.calories)} קק"ל`
  );

  let head =
    `✅ נרשם · <b>${n(totals.calories)} קק"ל</b> · ${confIcon}\n\n` +
    lines.join('\n') +
    `\n\n<b>הארוחה:</b> חלבון ${r1(totals.protein)} · פחמ' ${r1(totals.carbs)} · שומן ${r1(totals.fat)} · סיבים ${r1(totals.fiber)}`;

  if (parsed.assumptions) head += `\n<i>הנחות: ${esc(parsed.assumptions)}</i>`;

  // Save; if the DB hiccups the user still gets the breakdown
  let saved = null;
  try {
    saved = await saveMeal(chatId, text, parsed, totals);
  } catch (err) {
    console.error('save error:', err);
    return send(chatId, head + '\n\n⚠️ הניתוח הצליח אבל השמירה נכשלה — נסה לשלוח שוב.');
  }

  const [goals, dayMeals] = await Promise.all([getGoals(chatId), getDayMeals(chatId, dayKey())]);
  const day = sumTotals(dayMeals);

  return send(chatId, head + '\n\n' + dayLine(day, goals), {
    reply_markup: { inline_keyboard: [[{ text: '🗑 מחק רישום', callback_data: `del:${saved.id}` }]] },
  });
}

/* ---------------- commands ---------------- */

async function cmdToday(chatId) {
  const [goals, rows] = await Promise.all([getGoals(chatId), getDayMeals(chatId, dayKey())]);
  if (!rows.length) return send(chatId, 'עוד לא נרשם כלום היום. כתוב לי מה אכלת 🙂');

  const day = sumTotals(rows);
  const list = rows
    .map((r) => {
      const t = new Date(r.ts).toLocaleTimeString('he-IL', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem',
      });
      return `${t} · ${esc(short(r.raw_text))} — ${n(r.totals?.calories)}`;
    })
    .join('\n');

  return send(
    chatId,
    `📊 <b>סיכום היום</b>\n\n${list}\n\n${dayLine(day, goals)}\n` +
      `סיבים ${r1(day.fiber)} ג' · סוכר ${r1(day.sugar)} ג' · נתרן ${n(day.sodium_mg)} מ"ג`
  );
}

async function cmdWeek(chatId) {
  const goals = await getGoals(chatId);
  const keys = lastDayKeys(7); // oldest → newest
  const rows = await getDayMeals(chatId, keys);

  const byDay = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) byDay[r.day_key] += Number(r.totals?.calories) || 0;

  const DAY = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const lines = keys.map((k) => {
    const name = DAY[new Date(k + 'T12:00:00Z').getUTCDay()];
    const cals = Math.round(byDay[k]);
    const pct = goals.calories ? cals / goals.calories : 0;
    const filled = Math.max(0, Math.min(8, Math.round(pct * 8)));
    const bar = '▓'.repeat(filled) + '░'.repeat(8 - filled);
    return `${name} <code>${bar}</code> ${n(cals)}${pct > 1 ? ' 🔺' : ''}`;
  });

  const logged = keys.filter((k) => byDay[k] > 0);
  const avg = logged.length
    ? Math.round(logged.reduce((s, k) => s + byDay[k], 0) / logged.length)
    : 0;

  return send(
    chatId,
    `📅 <b>7 ימים אחרונים</b> · יעד ${n(goals.calories)}\n\n${lines.join('\n')}\n\n` +
      `ממוצע בימים עם רישום: <b>${n(avg)}</b> קק"ל`
  );
}

async function cmdGoals(chatId, args) {
  if (args.length === 4 && args.every((a) => /^\d+$/.test(a))) {
    const [calories, protein, carbs, fat] = args.map(Number);
    await setGoals(chatId, { calories, protein, carbs, fat });
    return send(
      chatId,
      `✔️ היעדים עודכנו:\nקלוריות ${n(calories)} · חלבון ${protein} · פחמ' ${carbs} · שומן ${fat}`
    );
  }
  const g = await getGoals(chatId);
  return send(
    chatId,
    `<b>היעדים שלך</b>\nקלוריות ${n(g.calories)} · חלבון ${g.protein} · פחמ' ${g.carbs} · שומן ${g.fat}\n\n` +
      `לעדכון: <code>/goals 1800 140 170 60</code>\n(קלוריות, חלבון, פחמימות, שומן)`
  );
}

/* ---------------- inline buttons ---------------- */

async function onCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';

  if (chatId && data.startsWith('del:')) {
    const deleted = await deleteMeal(chatId, data.slice(4));
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: deleted ? 'נמחק ✔️' : 'הרישום כבר נמחק',
    });

    if (deleted) {
      const goals = await getGoals(chatId);
      const rows = await getDayMeals(chatId, deleted.day_key);
      const day = sumTotals(rows);
      const label = deleted.day_key === dayKey() ? 'היום' : `סה"כ ל-${deleted.day_key}`;
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        parse_mode: 'HTML',
        text: `🗑 <s>${esc(short(deleted.raw_text))}</s> — הרישום נמחק\n\n${dayLine(day, goals, label)}`,
      });
    }
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: cb.id });
}
