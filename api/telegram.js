// Telegram nutrition bot — Vercel serverless webhook
// Text / photo → Claude parses → Supabase → visual reply with daily progress.
// Features: favorites (recurring meals), free-text meal editing, weekly digest.

import crypto from 'node:crypto';
import { parseMeal, parseMealImage, parseMealEdit, sumItems } from '../lib/claude.js';
import {
  saveMeal, getMeal, updateMeal, deleteMeal, getDayMeals, getGoals, setGoals,
  addFavorite, listFavorites, getFavorite, bumpFavorite, deleteFavorite,
  trackPattern, markPatternOffered, createDashSession,
  dayKey, lastDayKeys,
} from '../lib/db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
// Set DASH_URL in Vercel to your deployment, e.g. https://your-app.vercel.app
const DASH_URL = (process.env.DASH_URL || '').replace(/\/$/, '');

/* ---------------- helpers ---------------- */

const esc = (s = '') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (x) => Math.round(x || 0).toLocaleString('he-IL');
const r1 = (x) => Math.round((x || 0) * 10) / 10;
const short = (s = '', len = 34) => (s.length > len ? s.slice(0, len - 1) + '…' : s);
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

// Persistent shortcut keyboard — always available, never blocks typing.
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 היום' }, { text: '🔁 המאכלים שלי' }],
    [{ text: '📅 השבוע' }, { text: '🎯 יעדים' }],
    [{ text: '📈 דשבורד' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function sumTotals(rows) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r.totals?.[k]) || 0;
  return t;
}

function bar(val, goal, width = 10) {
  const pct = goal > 0 ? Math.min(1, val / goal) : 0;
  const filled = Math.round(pct * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
const pctTxt = (val, goal) => (goal > 0 ? Math.round((val / goal) * 100) + '%' : '—');

function daySummary(day, goals, title = '📊 היום עד עכשיו') {
  const rem = goals.calories - day.calories;
  const remLine = rem >= 0 ? `נותרו <b>${n(rem)}</b>` : `חריגה <b>${n(-rem)}</b> 🔺`;
  return (
    `${title}\n\n` +
    `🔥 <b>קלוריות</b>\n` +
    `<code>${bar(day.calories, goals.calories)}</code> ${pctTxt(day.calories, goals.calories)}\n` +
    `<b>${n(day.calories)}</b> / ${n(goals.calories)}  ·  ${remLine}\n\n` +
    `🥩 <b>חלבון</b>  <code>${bar(day.protein, goals.protein)}</code> ${r1(day.protein)}/${goals.protein} ג\n` +
    `🍚 <b>פחמימות</b>  <code>${bar(day.carbs, goals.carbs)}</code> ${r1(day.carbs)}/${goals.carbs} ג\n` +
    `🧈 <b>שומן</b>  <code>${bar(day.fat, goals.fat)}</code> ${r1(day.fat)}/${goals.fat} ג`
  );
}

function dayLine(day, goals, label = 'היום') {
  const rem = goals.calories - day.calories;
  return (
    `<b>${label}:</b> ${n(day.calories)} / ${n(goals.calories)} קק"ל · ` +
    (rem >= 0 ? `נותרו ${n(rem)}` : `חריגה ${n(-rem)} 🔺`)
  );
}

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

/* ---------------- pending state (edit / save-as-favorite) ----------------
   Kept in the meals row itself would be overkill; we use a tiny in-memory map
   keyed by chat. Serverless instances are short-lived, so we also accept the
   plain-text fallback: if state is lost the user just re-taps the button. */
const pending = new Map(); // chatId -> { kind: 'edit'|'name_fav', mealId }
const setPending = (chatId, v) => pending.set(String(chatId), v);
const takePending = (chatId) => {
  const k = String(chatId);
  const v = pending.get(k);
  pending.delete(k);
  return v;
};

/* ---------------- entry point ---------------- */

export default async function handler(req, res) {
  // Cron trigger for the weekly digest (Vercel calls this with GET)
  if (req.method === 'GET' && req.query?.cron === 'weekly') {
    if (process.env.CRON_SECRET && req.query.key !== process.env.CRON_SECRET) {
      return res.status(401).send('unauthorized');
    }
    try {
      const count = await sendWeeklyDigests();
      return res.status(200).send(`weekly digest sent to ${count} chats`);
    } catch (err) {
      console.error('cron error:', err);
      return res.status(500).send('cron failed');
    }
  }

  if (req.method !== 'POST') return res.status(200).send('nutrition bot is up');

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
  return res.status(200).send('ok');
}

/* ---------------- routing ---------------- */

async function onMessage(msg) {
  const chatId = msg.chat.id;

  if (msg.voice || msg.audio) {
    return send(chatId, 'בגרסה הזו אני קורא טקסט ותמונות. תיאור קולי — בשלב הבא 🎙️');
  }

  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    return onPhoto(chatId, fileId, msg.caption);
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  // A pending action (edit instruction / favorite name) takes priority
  const p = takePending(chatId);
  if (p && !text.startsWith('/')) {
    if (p.kind === 'edit') return applyEdit(chatId, p.mealId, text);
    if (p.kind === 'name_fav') return saveFavoriteNamed(chatId, p.mealId, text);
  }

  // Keyboard shortcuts
  switch (text) {
    case '📊 היום': return cmdToday(chatId);
    case '🔁 המאכלים שלי': return cmdFavorites(chatId);
    case '📅 השבוע': return cmdWeek(chatId);
    case '🎯 יעדים': return cmdGoals(chatId, []);
    case '📈 דשבורד': return cmdDashboard(chatId);
  }

  if (text.startsWith('/')) return onCommand(chatId, text);
  return onMeal(chatId, text);
}

async function onCommand(chatId, text) {
  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd.split('@')[0]) {
    case '/start':
      return send(
        chatId,
        '👋 <b>היי! אני יומן התזונה שלך</b>\n' +
          `${RULE}\n` +
          'פשוט כתוב מה אכלת, בשפה חופשית:\n' +
          '<i>"חזה עוף 200 גרם, כוס אורז וסלט"</i>\n\n' +
          '📷 או שלח <b>תמונה</b> — של טבלת ערכים על אריזה (מדויק) או של הצלחת (הערכה).\n\n' +
          '🔁 מאכלים שאתה אוכל שוב ושוב — שמור אותם בלחיצה ורשום אותם מיד בפעם הבאה.\n' +
          '✏️ טעית בכמות? יש כפתור עריכה מתחת לכל רישום.\n\n' +
          '<b>פקודות</b>\n' +
          '/today · סיכום היום\n' +
          '/week · 7 ימים אחרונים\n' +
          '/favorites · המאכלים השמורים\n' +
          '/dashboard · דשבורד גרפים ומגמות\n' +
          '/goals · צפייה ביעדים\n' +
          '<code>/goals 2000 180 200 65</code> · עדכון יעדים',
        { reply_markup: MAIN_KEYBOARD }
      );
    case '/today': return cmdToday(chatId);
    case '/week': return cmdWeek(chatId);
    case '/favorites': return cmdFavorites(chatId);
    case '/goals': return cmdGoals(chatId, args);
    case '/dashboard': return cmdDashboard(chatId);
    default:
      return send(chatId, 'לא מכיר את הפקודה הזו. נסה /start');
  }
}

/* ---------------- logging a parsed result ---------------- */

function mealBlock(parsed, totals) {
  const confIcon =
    { high: '🎯 דיוק גבוה', medium: '〰️ הערכה', low: '❔ הערכה גסה' }[parsed.confidence] || '〰️ הערכה';
  const lines = parsed.items.map(
    (it) => `   • ${esc(it.name)} — <b>${n(it.calories)}</b> קק"ל  <i>(${esc(it.portion || '')})</i>`
  );
  let s =
    `✅ <b>נוסף ליומן</b>  ·  ${confIcon}\n${RULE}\n` +
    lines.join('\n') +
    `\n\n🍽 <b>סה"כ הארוחה: ${n(totals.calories)} קק"ל</b>\n` +
    `   🥩 ${r1(totals.protein)}  ·  🍚 ${r1(totals.carbs)}  ·  🧈 ${r1(totals.fat)}  ·  🌾 ${r1(totals.fiber)}`;
  if (parsed.assumptions) s += `\n<i>ℹ️ ${esc(parsed.assumptions)}</i>`;
  return s;
}

const mealButtons = (mealId, offerFav) => {
  const row1 = [
    { text: '✏️ ערוך', callback_data: `edit:${mealId}` },
    { text: '🗑 מחק', callback_data: `del:${mealId}` },
  ];
  const rows = [row1];
  if (offerFav) rows.push([{ text: '🔁 שמור כמאכל קבוע', callback_data: `fav:${mealId}` }]);
  return { inline_keyboard: rows };
};

async function logParsed(chatId, sourceText, parsed, source = 'ai') {
  if (!parsed.items?.length) {
    return send(chatId, 'לא זיהיתי כאן אוכל 🤔 נסה לתאר במילים, למשל: "קערת יוגורט עם גרנולה ובננה".');
  }

  const totals = sumItems(parsed.items);
  const head = mealBlock(parsed, totals);

  let saved = null;
  try {
    saved = await saveMeal(chatId, sourceText, parsed, totals, source);
  } catch (err) {
    console.error('save error:', err);
    return send(chatId, head + '\n\n⚠️ הניתוח הצליח אבל השמירה נכשלה — נסה לשלוח שוב.');
  }

  const [goals, dayMeals] = await Promise.all([getGoals(chatId), getDayMeals(chatId, dayKey())]);
  const day = sumTotals(dayMeals);

  await send(chatId, `${head}\n\n${RULE}\n${daySummary(day, goals)}`, {
    reply_markup: mealButtons(saved.id, source === 'ai'),
  });

  // Auto-detect repeats: after the 3rd identical entry, offer to save it.
  if (source === 'ai') {
    try {
      const pat = await trackPattern(chatId, sourceText);
      if (pat && pat.seen_count >= 3 && !pat.offered) {
        await markPatternOffered(chatId, sourceText);
        await send(
          chatId,
          `🔁 שמתי לב שרשמת את זה <b>${pat.seen_count} פעמים</b>.\nרוצה לשמור אותו כמאכל קבוע כדי לרשום בלחיצה אחת?`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: '🔁 כן, שמור', callback_data: `fav:${saved.id}` }]],
            },
          }
        );
      }
    } catch (err) {
      console.error('pattern error:', err);
    }
  }
}

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
  return logParsed(chatId, text, parsed);
}

async function onPhoto(chatId, fileId, caption) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  let img;
  try {
    img = await downloadPhotoBase64(fileId);
  } catch (err) {
    console.error('photo download error:', err);
    return send(chatId, 'לא הצלחתי להוריד את התמונה. נסה לשלוח אותה שוב.');
  }

  let parsed;
  try {
    parsed = await parseMealImage(img.base64, img.mediaType, caption);
  } catch (err) {
    console.error('image parse error:', err);
    return send(
      chatId,
      'לא הצלחתי לנתח את התמונה. נסה תמונה ברורה יותר של טבלת הערכים או של הצלחת — או פשוט תאר לי במילים.'
    );
  }

  return logParsed(chatId, caption?.trim() || '📷 תמונה', parsed, 'photo');
}

/* ---------------- editing ---------------- */

async function applyEdit(chatId, mealId, instruction) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  const meal = await getMeal(chatId, mealId);
  if (!meal) return send(chatId, 'הרישום הזה לא נמצא — אולי נמחק. נסה לרשום מחדש.');

  let parsed;
  try {
    parsed = await parseMealEdit(meal.items, instruction);
  } catch (err) {
    console.error('edit parse error:', err);
    return send(chatId, 'לא הבנתי את התיקון. נסה למשל: "רק חצי", "150 גרם", "בלי הדבש".');
  }

  if (!parsed.items?.length) {
    return send(chatId, 'התיקון הזה מרוקן את הארוחה. אם רצית למחוק אותה — יש כפתור 🗑 מחק.');
  }

  const totals = sumItems(parsed.items);
  const updated = await updateMeal(chatId, mealId, parsed, totals);
  if (!updated) return send(chatId, 'לא הצלחתי לעדכן את הרישום. נסה שוב.');

  const [goals, dayMeals] = await Promise.all([getGoals(chatId), getDayMeals(chatId, dayKey())]);
  const day = sumTotals(dayMeals);

  const lines = parsed.items.map(
    (it) => `   • ${esc(it.name)} — <b>${n(it.calories)}</b> קק"ל  <i>(${esc(it.portion || '')})</i>`
  );

  return send(
    chatId,
    `✏️ <b>הרישום עודכן</b>\n${RULE}\n${lines.join('\n')}\n\n` +
      `🍽 <b>סה"כ: ${n(totals.calories)} קק"ל</b>\n` +
      `   🥩 ${r1(totals.protein)}  ·  🍚 ${r1(totals.carbs)}  ·  🧈 ${r1(totals.fat)}\n` +
      (parsed.assumptions ? `<i>ℹ️ ${esc(parsed.assumptions)}</i>\n` : '') +
      `\n${RULE}\n${daySummary(day, goals)}`,
    { reply_markup: mealButtons(mealId, false) }
  );
}

/* ---------------- favorites ---------------- */

async function saveFavoriteNamed(chatId, mealId, label) {
  const meal = await getMeal(chatId, mealId);
  if (!meal) return send(chatId, 'הרישום לא נמצא — אולי נמחק.');

  const clean = label.trim().slice(0, 60);
  try {
    await addFavorite(chatId, clean, meal.items, meal.totals);
  } catch (err) {
    console.error('addFavorite error:', err);
    return send(chatId, 'לא הצלחתי לשמור. נסה שם אחר.');
  }

  return send(
    chatId,
    `🔁 <b>"${esc(clean)}"</b> נשמר כמאכל קבוע!\n` +
      `${n(meal.totals.calories)} קק"ל · חלבון ${r1(meal.totals.protein)}\n\n` +
      `מעכשיו תוכל לרשום אותו בלחיצה מ-🔁 המאכלים שלי.`
  );
}

async function cmdFavorites(chatId) {
  const favs = await listFavorites(chatId);
  if (!favs.length) {
    return send(
      chatId,
      '🔁 <b>המאכלים שלי</b>\n' +
        `${RULE}\n` +
        'עוד אין מאכלים שמורים.\n\n' +
        'כשתרשום ארוחה, לחץ על <b>🔁 שמור כמאכל קבוע</b> — ואז תוכל לרשום אותה בלחיצה אחת בפעם הבאה.'
    );
  }

  const rows = favs.map((f) => [
    { text: `${f.label} · ${n(f.totals?.calories)} קק"ל`, callback_data: `use:${f.id}` },
  ]);

  return send(
    chatId,
    `🔁 <b>המאכלים שלי</b>\n${RULE}\nלחץ על מאכל כדי לרשום אותו עכשיו:`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

async function useFavorite(chatId, favId) {
  const fav = await getFavorite(chatId, favId);
  if (!fav) return send(chatId, 'המאכל השמור לא נמצא.');

  await bumpFavorite(chatId, favId, fav.use_count);

  const parsed = { items: fav.items, assumptions: '', confidence: 'high' };
  return logParsed(chatId, fav.label, parsed, 'favorite');
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
      return `   ${t} · ${esc(short(r.raw_text))} — <b>${n(r.totals?.calories)}</b>`;
    })
    .join('\n');

  return send(
    chatId,
    `🍽 <b>ארוחות היום</b>\n${RULE}\n${list}\n\n${RULE}\n${daySummary(day, goals)}\n\n` +
      `<i>🌾 סיבים ${r1(day.fiber)} · 🍬 סוכר ${r1(day.sugar)} · 🧂 נתרן ${n(day.sodium_mg)} מ"ג</i>`
  );
}

async function cmdWeek(chatId) {
  const goals = await getGoals(chatId);
  const keys = lastDayKeys(7);
  const rows = await getDayMeals(chatId, keys);

  const byDay = Object.fromEntries(keys.map((k) => [k, { calories: 0, protein: 0 }]));
  for (const r of rows) {
    byDay[r.day_key].calories += Number(r.totals?.calories) || 0;
    byDay[r.day_key].protein += Number(r.totals?.protein) || 0;
  }

  const DAY = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const lines = keys.map((k) => {
    const name = DAY[new Date(k + 'T12:00:00Z').getUTCDay()];
    const cals = Math.round(byDay[k].calories);
    const pct = goals.calories ? cals / goals.calories : 0;
    const flag = cals === 0 ? '  —' : pct > 1 ? ' 🔺' : '';
    return `${name}  <code>${bar(cals, goals.calories, 12)}</code> ${n(cals)}${flag}`;
  });

  const logged = keys.filter((k) => byDay[k].calories > 0);
  const avgCal = logged.length
    ? Math.round(logged.reduce((s, k) => s + byDay[k].calories, 0) / logged.length)
    : 0;
  const avgPro = logged.length
    ? Math.round(logged.reduce((s, k) => s + byDay[k].protein, 0) / logged.length)
    : 0;

  return send(
    chatId,
    `📅 <b>7 ימים אחרונים</b>\n${RULE}\n${lines.join('\n')}\n\n${RULE}\n` +
      `🔥 ממוצע קלוריות: <b>${n(avgCal)}</b> / ${n(goals.calories)}\n` +
      `🥩 ממוצע חלבון: <b>${n(avgPro)}</b> / ${goals.protein} ג\n` +
      `📝 ימים עם רישום: <b>${logged.length}</b> מתוך 7`
  );
}

async function cmdGoals(chatId, args) {
  if (args.length === 4 && args.every((a) => /^\d+$/.test(a))) {
    const [calories, protein, carbs, fat] = args.map(Number);
    await setGoals(chatId, { calories, protein, carbs, fat });
    return send(
      chatId,
      `🎯 <b>היעדים עודכנו</b>\n${RULE}\n` +
        `🔥 קלוריות: <b>${n(calories)}</b>\n🥩 חלבון: <b>${protein}</b> ג\n` +
        `🍚 פחמימות: <b>${carbs}</b> ג\n🧈 שומן: <b>${fat}</b> ג`
    );
  }
  const g = await getGoals(chatId);
  return send(
    chatId,
    `🎯 <b>היעדים שלך</b>\n${RULE}\n` +
      `🔥 קלוריות: <b>${n(g.calories)}</b>\n🥩 חלבון: <b>${g.protein}</b> ג\n` +
      `🍚 פחמימות: <b>${g.carbs}</b> ג\n🧈 שומן: <b>${g.fat}</b> ג\n\n` +
      `לעדכון שלח:\n<code>/goals ${g.calories} ${g.protein} ${g.carbs} ${g.fat}</code>\n` +
      `<i>(קלוריות, חלבון, פחמימות, שומן)</i>`
  );
}

/* ---------------- dashboard access ---------------- */

async function cmdDashboard(chatId) {
  if (!DASH_URL) {
    return send(
      chatId,
      '📈 הדשבורד לא מוגדר עדיין.\n<i>צריך להוסיף משתנה סביבה DASH_URL ב-Vercel.</i>'
    );
  }

  const token = crypto.randomBytes(24).toString('hex');
  const code = String(crypto.randomInt(100_000, 999_999));

  try {
    await createDashSession(chatId, token, code);
  } catch (err) {
    console.error('dash session error:', err);
    return send(chatId, 'לא הצלחתי לפתוח גישה לדשבורד. נסה שוב.');
  }

  const link = `${DASH_URL}/dashboard.html#t=${token}`;

  return send(
    chatId,
    `📈 <b>הדשבורד שלך</b>\n${RULE}\n` +
      `<b>בטלפון</b> — לחץ על הכפתור למטה.\n\n` +
      `<b>במחשב</b> — פתח את הכתובת:\n<code>${DASH_URL}/dashboard.html</code>\n` +
      `והזן את הקוד:\n\n<code>${code}</code>\n\n` +
      `<i>הקוד תקף ל-15 דקות. אחרי הכניסה תישאר מחובר 30 יום.</i>`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '📈 פתח דשבורד', url: link }]],
      },
    }
  );
}

/* ---------------- weekly digest (cron) ---------------- */

async function sendWeeklyDigests() {
  const { getActiveChats } = await import('../lib/db.js');
  const keys = lastDayKeys(7);
  const chats = await getActiveChats(keys);

  for (const chatId of chats) {
    try {
      const [goals, rows] = await Promise.all([getGoals(chatId), getDayMeals(chatId, keys)]);
      if (!rows.length) continue;

      const byDay = Object.fromEntries(keys.map((k) => [k, { calories: 0, protein: 0 }]));
      for (const r of rows) {
        byDay[r.day_key].calories += Number(r.totals?.calories) || 0;
        byDay[r.day_key].protein += Number(r.totals?.protein) || 0;
      }

      const logged = keys.filter((k) => byDay[k].calories > 0);
      const avgCal = Math.round(logged.reduce((s, k) => s + byDay[k].calories, 0) / logged.length);
      const avgPro = Math.round(logged.reduce((s, k) => s + byDay[k].protein, 0) / logged.length);
      const overDays = logged.filter((k) => byDay[k].calories > goals.calories).length;

      const DAY = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
      const lines = keys.map((k) => {
        const name = DAY[new Date(k + 'T12:00:00Z').getUTCDay()];
        const cals = Math.round(byDay[k].calories);
        return `${name}  <code>${bar(cals, goals.calories, 12)}</code> ${n(cals)}${
          cals === 0 ? '  —' : cals > goals.calories ? ' 🔺' : ''
        }`;
      });

      // A short, honest read on the week
      const insights = [];
      insights.push(
        logged.length >= 6
          ? `📝 עקביות מצוינת — רשמת ${logged.length} מתוך 7 ימים.`
          : `📝 רשמת ${logged.length} מתוך 7 ימים. עקביות ברישום היא מה שהופך את הנתונים לשימושיים.`
      );
      if (avgPro < goals.protein * 0.85) {
        insights.push(`🥩 החלבון בממוצע ${n(avgPro)} מול יעד ${goals.protein} — יש פער.`);
      } else {
        insights.push(`🥩 החלבון בממוצע ${n(avgPro)} — קרוב ליעד. 👌`);
      }
      if (overDays > 0) insights.push(`🔺 ${overDays} ימים מעל יעד הקלוריות.`);

      await send(
        chatId,
        `📅 <b>סיכום השבוע</b>\n${RULE}\n${lines.join('\n')}\n\n${RULE}\n` +
          `🔥 ממוצע קלוריות: <b>${n(avgCal)}</b> / ${n(goals.calories)}\n` +
          `🥩 ממוצע חלבון: <b>${n(avgPro)}</b> / ${goals.protein} ג\n\n` +
          insights.join('\n') +
          `\n\n<i>שבוע חדש מתחיל — בהצלחה! 💪</i>`
      );
    } catch (err) {
      console.error('digest error for chat', chatId, err);
    }
  }
  return chats.length;
}

/* ---------------- inline buttons ---------------- */

async function onCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text && { text }) });

  if (!chatId) return ack();

  // Delete
  if (data.startsWith('del:')) {
    const deleted = await deleteMeal(chatId, data.slice(4));
    await ack(deleted ? 'נמחק ✔️' : 'הרישום כבר נמחק');
    if (deleted) {
      const goals = await getGoals(chatId);
      const rows = await getDayMeals(chatId, deleted.day_key);
      const day = sumTotals(rows);
      const label = deleted.day_key === dayKey() ? 'היום' : `סה"כ ל-${deleted.day_key}`;
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        parse_mode: 'HTML',
        text: `🗑 <s>${esc(short(deleted.raw_text))}</s> — נמחק\n\n${dayLine(day, goals, label)}`,
      });
    }
    return;
  }

  // Edit — ask for a free-text correction
  if (data.startsWith('edit:')) {
    setPending(chatId, { kind: 'edit', mealId: data.slice(5) });
    await ack();
    return send(
      chatId,
      '✏️ <b>מה לתקן?</b>\nכתוב בשפה חופשית, למשל:\n' +
        '<i>"רק חצי"</i> · <i>"150 גרם במקום 200"</i> · <i>"בלי הדבש"</i> · <i>"תוסיף כף שמן זית"</i>'
    );
  }

  // Save as favorite — ask for a name
  if (data.startsWith('fav:')) {
    setPending(chatId, { kind: 'name_fav', mealId: data.slice(4) });
    await ack();
    return send(
      chatId,
      '🔁 <b>איך לקרוא למאכל הזה?</b>\nלמשל: <i>"השייק שלי"</i> · <i>"ארוחת בוקר קבועה"</i>'
    );
  }

  // Log a favorite
  if (data.startsWith('use:')) {
    await ack('רושם…');
    return useFavorite(chatId, data.slice(4));
  }

  return ack();
}
