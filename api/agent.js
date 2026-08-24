// Nutrition AGENT bot — webhook route, runs in parallel to api/telegram.js.
// Every text message goes through the Claude agent loop (lib/agent-core.js).
// Every write action replies with what was done + an inline undo button.

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { dayKey, lastDayKeys, getMealsRange, createDashSession } from '../lib/db.js';
import { getContext, runAgent, undoAction, estimateSplit, getDay, logChatTurn } from '../lib/agent-core.js';

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

function bar(val, goal, width = 8) {
  const pct = goal > 0 ? Math.min(1, val / goal) : 0;
  const filled = Math.round(pct * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function sumTotals(rows) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r.totals?.[k]) || 0;
  return t;
}

/* ADHD-friendly: the decision-driving number first, one idea per line,
   blank lines between groups. Secondary data goes to one expandable at
   the message end (dayDetailLines). */
function dayStatus(rows, goals) {
  const day = sumTotals(rows);
  const rem = goals.calories - day.calories;
  const remLine = rem >= 0
    ? `⚡ נותרו <b>${n(rem)}</b> קק"ל היום`
    : `🔺 חריגה של <b>${n(-rem)}</b> קק"ל היום`;
  // "X מתוך Y" ולא "X / Y" — לוכסן בין מספרים מתהפך ויזואלית ב-RTL.
  return (
    `${remLine}\n` +
    `<code>${bar(day.calories, goals.calories)}</code>  ${n(day.calories)} מתוך ${n(goals.calories)}\n` +
    `🥩 חלבון  <b>${r1(day.protein)}</b> מתוך ${goals.protein}\n` +
    `🍚 פחמימות  <b>${r1(day.carbs)}</b> מתוך ${goals.carbs}\n` +
    `🧈 שומן  <b>${r1(day.fat)}</b> מתוך ${goals.fat}`
  );
}

function dayDetailLines(rows) {
  const split = estimateSplit(rows);
  return split ? [`מדויק ${split.measuredPct}% · הערכה ${split.estimatedPct}% (מהקלוריות)`] : [];
}

const CONF_ICON = { high: '🎯', medium: '〰️', low: '❔' };
const ddmm = (iso) => iso.slice(5).split('-').reverse().join('.');

/* Main (always-visible) part of an action. Secondary data comes from
   actionDetailLines and lands in the single expandable at message end. */
function actionMain(a) {
  if (a.kind === 'set_goals') {
    const g = a.goals;
    const mark = (f) => (a.changed.includes(f) ? ' ←' : '');
    return (
      `🎯 <b>היעדים עודכנו</b>\n\n` +
      `🔥 קלוריות  <b>${n(g.calories)}</b>${mark('calories')}\n` +
      `🥩 חלבון  <b>${g.protein}</b> ג${mark('protein')}\n` +
      `🍚 פחמימות  <b>${g.carbs}</b> ג${mark('carbs')}\n` +
      `🧈 שומן  <b>${g.fat}</b> ג${mark('fat')}`
    );
  }
  if (a.kind === 'remember_food') {
    return `🧠 <b>"${esc(a.alias)}" ${a.isNew ? 'נשמר במילון' : 'עודכן במילון'}</b>`;
  }
  if (a.kind === 'log_measurement') {
    const s = a.saved || {};
    const d = a.deltas || {};
    const delta = (v) => (v == null ? '' : v.diff === 0 ? '  (ללא שינוי)' : `  (${v.diff > 0 ? '+' : ''}${v.diff} מאז ${ddmm(v.since)})`);
    const lines = [`✅ <b>נרשמה מדידה</b> · ${ddmm(a.measuredOn)}`, ''];
    if (s.weight_kg != null) lines.push(`משקל  <b>${s.weight_kg}</b> ק"ג${delta(d.weight_kg)}`);
    if (s.waist_cm != null) lines.push(`מותן  <b>${s.waist_cm}</b> ס"מ${delta(d.waist_cm)}`);
    if (a.navyPct != null) lines.push(`שומן גוף  <b>${a.navyPct}%</b>`);
    return lines.join('\n');
  }

  const head =
    a.kind === 'log_meal' ? '✅ <b>נרשם</b>'
    : a.kind === 'delete_meal' ? '🗑 <b>נמחק</b>'
    : '✏️ <b>עודכן</b>';
  const conf = CONF_ICON[a.confidence] || '〰️';
  const single = a.items.length === 1;

  const macroLine = `🥩 <b>${r1(a.totals.protein)}</b> · 🍚 <b>${r1(a.totals.carbs)}</b> · 🧈 <b>${r1(a.totals.fat)}</b> ג`;
  let out;
  if (single) {
    const it = a.items[0];
    out =
      `${head} · ${esc(it.name)} ${conf}\n\n` +
      `🔥 <b>${n(a.totals.calories)}</b> קק"ל\n${macroLine}`;
  } else {
    out =
      `${head} · <b>${n(a.totals.calories)}</b> קק"ל ${conf}\n\n` +
      a.items.map((it) => `${it.emoji || '🍽'} ${esc(it.name)} — <b>${n(it.calories)}</b>`).join('\n') +
      `\n\n${macroLine}`;
  }
  if (a.dayKeyUsed && a.dayKeyUsed !== dayKey() && a.kind === 'log_meal') {
    out += `\n🗓 נרשם לתאריך ${ddmm(a.dayKeyUsed)}`;
  }
  return out;
}

function actionDetailLines(a) {
  if (a.kind === 'set_goals') return [];
  if (a.kind === 'remember_food') {
    const s = a.saved || {};
    const lines = [];
    if (s.product) lines.push(`מוצר: ${esc(s.product)}`);
    if (s.serving_grams) lines.push(`מנה: ${s.serving_grams} גרם`);
    if (s.kcal_per_100g != null) {
      let m = `ל-100 גרם: ${s.kcal_per_100g} קק"ל`;
      if (s.protein_per_100g != null) m += ` · חלבון ${s.protein_per_100g}`;
      if (s.carbs_per_100g != null) m += ` · פחמ' ${s.carbs_per_100g}`;
      if (s.fat_per_100g != null) m += ` · שומן ${s.fat_per_100g}`;
      lines.push(m);
    }
    if (s.variants) lines.push(`וריאציות: ${esc(Object.entries(s.variants).map(([k, v]) => `${k}=${v} גרם`).join(', '))}`);
    return lines;
  }
  if (a.kind === 'log_measurement') {
    const s = a.saved || {};
    const lines = [];
    if (s.neck_cm != null) lines.push(`צוואר: ${s.neck_cm} ס"מ`);
    if (s.steps_avg != null) lines.push(`צעדים (ממוצע): ${n(s.steps_avg)}`);
    if (s.notes) lines.push(`הערה: ${esc(s.notes)}`);
    return lines;
  }
  const lines = [];
  const portions = a.items
    .map((it) => {
      const q = it.portion || (Number.isFinite(Number(it.grams)) ? `${it.grams} גרם` : null);
      return q ? `${esc(it.name)}: ${esc(q)}` : esc(it.name);
    })
    .join(' · ');
  if (portions) lines.push(`כמויות — ${portions}`);
  lines.push(`סיבים ${r1(a.totals.fiber)} ג · סוכר ${r1(a.totals.sugar)} ג · נתרן ${n(a.totals.sodium_mg)} מ"ג`);
  if (a.assumptions) lines.push(`הנחות: ${esc(a.assumptions)}`);
  return lines;
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

  if (text === '/export' || text === 'ייצוא') return cmdExport(chatId);
  if (text === '/dashboard' || text === 'דשבורד') return cmdDashboard(chatId);
  if (text === '/foods' || text === 'המילון שלי') return cmdFoods(chatId);

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
        '• <i>"נשקלתי 95.8, מותן 105"</i> — מדידות + אחוז שומן\n' +
        '• <i>"כמה חלבון אכלתי היום?"</i> — שאלה (גם על ימים קודמים)\n' +
        '• <i>"תעדכן יעד חלבון ל-150"</i> — יעדים\n' +
        '• /dashboard — גרפים ומגמות · /export — ייצוא לניתוח\n\n' +
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

  // Rolling conversation log — lets the next message continue this exchange.
  const actionSummary = actions.map((a) =>
    a.kind === 'log_meal' ? `נרשם: ${(a.items || []).map((i) => i.name).join(', ')} (${Math.round(a.totals.calories)} קק"ל)`
    : a.kind === 'update_meal' ? `עודכן: ${(a.items || []).map((i) => i.name).join(', ')} (${Math.round(a.totals.calories)} קק"ל)`
    : a.kind === 'delete_meal' ? `נמחק: ${(a.items || []).map((i) => i.name).join(', ')}`
    : a.kind === 'remember_food' ? `נשמר במילון: ${a.alias}`
    : a.kind === 'log_measurement' ? `נרשמה מדידה ${a.measuredOn}`
    : a.kind
  ).join(' · ');
  await logChatTurn(chatId, 'user', rawText);
  await logChatTurn(chatId, 'assistant', [actionSummary, agentText].filter(Boolean).join(' · '));

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

  let body = actions.map(actionMain).join('\n\n');
  const mealWrite = actions.some((a) => a.kind === 'log_meal' || a.kind === 'update_meal' || a.kind === 'delete_meal');
  if (mealWrite) body += `\n\n${dayStatus(rows, goals)}`;
  // Drop trivial echoes ("נרשם 👍") — show only comments that add information.
  if (agentText && agentText.length >= 25 && agentText.length <= 200) body += `\n\n💬 <i>${esc(agentText)}</i>`;

  // One expandable at the end for everything secondary.
  const details = [
    ...actions.flatMap(actionDetailLines),
    ...(mealWrite ? dayDetailLines(rows, goals) : []),
  ];
  if (details.length) body += `\n<blockquote expandable>${details.join('\n')}</blockquote>`;

  const undoRow = actions.map((a, i) => ({
    text: actions.length > 1 ? `↩️ בטל ${i + 1}` : '↩️ בטל',
    callback_data: `undo:${a.actionId}`,
  }));

  return send(chatId, body, { reply_markup: { inline_keyboard: [undoRow] } });
}

/* ---------------- personal dictionary listing ---------------- */

async function cmdFoods(chatId) {
  const { data: foods } = await sb
    .from('my_foods').select('*').eq('chat_id', chatId).order('alias');

  if (!foods?.length) {
    return send(
      chatId,
      '🧠 <b>המילון שלך ריק</b>\n\nכל תיקון שתעשה נשמר אוטומטית. אפשר גם לומר לי ישירות:\n<i>"זכור שלחמניה היא 90 גרם"</i>'
    );
  }

  const done = foods.filter((f) => f.kcal_per_100g != null);
  const partial = foods.filter((f) => f.kcal_per_100g == null);

  const line = (f) => {
    let s = `• <b>${esc(f.alias)}</b>`;
    if (f.serving_grams) s += ` · ${f.serving_grams} ג`;
    if (f.kcal_per_100g != null) s += ` · ${f.kcal_per_100g} קק"ל/100`;
    return s;
  };

  let body = `🧠 <b>המילון שלי</b> · ${foods.length} מאכלים\n`;
  if (done.length) body += `\n✅ <b>מלאים</b>\n${done.map(line).join('\n')}\n`;
  if (partial.length) {
    body +=
      `\n⚠️ <b>חסרים ערכים תזונתיים</b> (${partial.length})\n` +
      `${partial.map(line).join('\n')}\n` +
      `\n<i>לאלה אני יודע את הכמות אבל מנחש את הקלוריות. שלח לי תמונת תווית או תגיד לי את הערכים — למשל "לחמניה: 280 קלוריות ל-100 גרם" — ומאותו רגע זו מדידה ולא הערכה.</i>`;
  }

  return send(chatId, body);
}

/* ---------------- dashboard access ---------------- */

const DASH_URL = (process.env.DASH_URL || '').replace(/\/$/, '');

async function cmdDashboard(chatId) {
  if (!DASH_URL) {
    return send(chatId, '📈 הדשבורד לא מוגדר עדיין.\n<i>צריך משתנה סביבה DASH_URL ב-Vercel.</i>');
  }
  const token = crypto.randomBytes(24).toString('hex');
  const code = String(crypto.randomInt(100_000, 999_999));
  try {
    await createDashSession(chatId, token, code);
  } catch (err) {
    console.error('dash session error:', err);
    return send(chatId, 'לא הצלחתי לפתוח גישה לדשבורד. נסה שוב.');
  }

  return send(
    chatId,
    `📈 <b>הדשבורד שלך</b>\n\n` +
      `בטלפון — הכפתור למטה.\n\n` +
      `במחשב — פתח <code>${DASH_URL}/dashboard.html</code>\nוהזן את הקוד:\n\n<code>${code}</code>\n\n` +
      `<i>הקוד תקף ל-15 דקות · אחרי הכניסה נשארים מחוברים 30 יום</i>`,
    { reply_markup: { inline_keyboard: [[{ text: '📈 פתח דשבורד', url: `${DASH_URL}/dashboard.html#t=${token}` }]] } }
  );
}

/* ---------------- export (paste-ready block for analysis) ---------------- */

async function cmdExport(chatId) {
  const keys = lastDayKeys(30);
  const [meas, foods, goalsRow, meals] = await Promise.all([
    sb.from('measurements').select('*').eq('chat_id', chatId).order('measured_on', { ascending: true }),
    sb.from('my_foods').select('*').eq('chat_id', chatId).order('alias'),
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
    getMealsRange(chatId, keys),
  ]);
  const g = goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 };

  const lines = [];
  lines.push(`EXPORT ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`GOALS: ${g.calories} kcal / P${g.protein} / C${g.carbs} / F${g.fat}`);

  lines.push('', 'MEASUREMENTS (date | weight kg | waist cm | neck cm | steps):');
  for (const m of meas.data || []) {
    lines.push(`${m.measured_on} | ${m.weight_kg ?? '-'} | ${m.waist_cm ?? '-'} | ${m.neck_cm ?? '-'} | ${m.steps_avg ?? '-'}${m.notes ? ` | ${m.notes}` : ''}`);
  }

  lines.push('', 'DAYS last 30 (date | kcal | P | C | F | meals | %measured):');
  const byDay = new Map();
  for (const r of meals) {
    if (!byDay.has(r.day_key)) byDay.set(r.day_key, []);
    byDay.get(r.day_key).push(r);
  }
  for (const k of keys) {
    const rows = byDay.get(k);
    if (!rows) continue;
    const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    for (const r of rows) for (const f of Object.keys(t)) t[f] += Number(r.totals?.[f]) || 0;
    const split = estimateSplit(rows);
    lines.push(`${k} | ${Math.round(t.calories)} | ${Math.round(t.protein)} | ${Math.round(t.carbs)} | ${Math.round(t.fat)} | ${rows.length} | ${split ? split.measuredPct + '%' : '-'}`);
  }

  lines.push('', 'MY_FOODS:');
  for (const f of foods.data || []) {
    let s = `${f.alias}`;
    if (f.product) s += ` = ${f.product}`;
    if (f.serving_grams) s += ` | serving ${f.serving_grams}g`;
    if (f.kcal_per_100g != null) s += ` | per100g: ${f.kcal_per_100g}kcal P${f.protein_per_100g ?? '-'} C${f.carbs_per_100g ?? '-'} F${f.fat_per_100g ?? '-'}`;
    if (f.variants) s += ` | variants ${JSON.stringify(f.variants)}`;
    lines.push(s);
  }

  const block = lines.join('\n');
  // Telegram hard limit is 4096 chars per message — split if needed.
  for (let i = 0; i < block.length; i += 3800) {
    await send(chatId, `<pre>${esc(block.slice(i, i + 3800))}</pre>`);
  }
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
    : result.kind === 'log_measurement' ? 'המדידה שוחזרה'
    : 'העדכון שוחזר';

  // Keep the conversation log truthful — the next message must know this was undone.
  await logChatTurn(chatId, 'assistant', `[המשתמש לחץ על כפתור ביטול: ${verb}]`);

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: cb.message.message_id,
    parse_mode: 'HTML',
    text:
      `↩️ <b>בוטל</b> — ${verb}.\n\n` +
      `<b>היום:</b> ${n(day.calories)} מתוך ${n(goals.calories)} קק"ל · חלבון ${r1(day.protein)} ג`,
  });
}
