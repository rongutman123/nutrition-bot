// Nutrition AGENT bot — webhook route, runs in parallel to api/telegram.js.
// Every text message goes through the Claude agent loop (lib/agent-core.js).
// Every write action replies with what was done + an inline undo button.

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { dayKey, lastDayKeys, getMealsRange, createDashSession } from '../lib/db.js';
import { getContext, runAgent, undoAction, estimateSplit, getDay, logChatTurn, logUsage } from '../lib/agent-core.js';
import { caloriesChart, proteinChart, weightChart, accuracyChart, renderChart, isOver } from '../lib/charts.js';

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

/* Model-authored text may use Telegram formatting, but only from a whitelist:
   escape everything first, then restore the allowed tags. Injection-proof, and
   an unbalanced tag can't take the message down (sendRich falls back to plain). */
const ALLOWED = ['b', 'i', 'u', 's', 'code'];

function safeHtml(raw = '') {
  let out = esc(raw);
  for (const tag of ALLOWED) {
    out = out
      .replaceAll(`&lt;${tag}&gt;`, `<${tag}>`)
      .replaceAll(`&lt;/${tag}&gt;`, `</${tag}>`);
  }
  out = out
    .replaceAll('&lt;blockquote&gt;', '<blockquote>')
    .replaceAll('&lt;blockquote expandable&gt;', '<blockquote expandable>')
    .replaceAll('&lt;/blockquote&gt;', '</blockquote>');
  return out;
}

/* Sends formatted text; if Telegram rejects the markup, resends it plain
   rather than losing the answer. */
async function sendRich(chatId, html, extra = {}) {
  const res = await send(chatId, html, extra);
  if (res?.ok) return res;
  const plain = html.replace(/<[^>]+>/g, '');
  return tg('sendMessage', { chat_id: chatId, text: plain, ...extra });
}

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
  if (a.kind === 'save_recipe') {
    const lines = [`📖 <b>"${esc(a.name)}" ${a.isNew ? 'נשמר כמתכון' : 'עודכן'}</b>`, ''];
    lines.push(`סה"כ  <b>${n(a.totals.calories)}</b> קק"ל · ${a.ingredientCount} רכיבים`);
    if (a.perServing) lines.push(`למנה  <b>${n(a.perServing.calories)}</b> קק"ל · 🥩 ${r1(a.perServing.protein)} ג`);
    if (a.per100g) lines.push(`ל-100 ג  <b>${n(a.per100g.calories)}</b> קק"ל · 🥩 ${r1(a.per100g.protein)} ג`);
    return lines.join(String.fromCharCode(10));
  }
  if (a.kind === 'save_meal') {
    return (
      `⭐ <b>"${esc(a.name)}" ${a.isNew ? 'נשמרה' : 'עודכנה'}</b>

` +
      `<b>${n(a.totals.calories)}</b> קק"ל · 🥩 ${r1(a.totals.protein)} ג
` +
      `<i>מעכשיו אפשר לרשום אותה בשם, או מ-/saved</i>`
    );
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
  if (a.kind === 'save_recipe') {
    const lines = [];
    if (a.totalGrams) lines.push(`משקל מוכן: ${a.totalGrams} גרם`);
    if (a.servings) lines.push(`מנות: ${a.servings}`);
    lines.push(`מאקרו סה"כ: חלבון ${r1(a.totals.protein)} ג · פחמ' ${r1(a.totals.carbs)} ג · שומן ${r1(a.totals.fat)} ג`);
    return lines;
  }
  if (a.kind === 'save_meal') {
    return [a.items.map((i) => `${esc(i.name)} ${Math.round(i.calories || 0)}`).join(' · ')];
  }
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

  // Keyboard taps arrive as ordinary text — route them before the agent so a
  // tap is instant and costs no API call.
  const cmd =
    text === '/today' || text === BTN.left ? ['today', cmdToday]
    : text === '/trends' || text === BTN.trends ? ['trends', cmdTrends]
    : text === '/saved' || text === BTN.saved ? ['saved', cmdSaved]
    : text === '/foods' ? ['foods', cmdFoods]
    : text === '/dashboard' ? ['dashboard', cmdDashboard]
    : text === '/export' ? ['export', cmdExport]
    : text === '/cost' ? ['cost', cmdCost]
    : null;
  if (cmd) {
    await logUsage({ chat_id: chatId, route: 'command', kind: cmd[0] });
    return cmd[1](chatId);
  }

  if (text === '/start') {
    await tg('setMyCommands', { commands: COMMANDS });
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
        '• <i>"מתכון לפנקייק: 2 ביצים, 60 גרם שיבולת שועל…"</i> — מתכונים\n' +
        '• <i>"תשמור את זה בשם השייק שלי"</i> — ארוחות חוזרות\n' +
        '• 📷 תמונה של אוכל, תווית או <b>ברקוד</b>\n\n' +
        '📋 /saved · /foods · /dashboard · /export\n\n' +
        'כל רישום מגיע עם כפתור <b>בטל</b> — טעות מתקנים בלחיצה.',
      { reply_markup: MAIN_KEYBOARD }
    );
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  return processWithAgent(chatId, text, text);
}

/* Shared agent flow for text and photos: run, then confirm/answer. */
async function processWithAgent(chatId, userContent, rawText) {
  const t0 = Date.now();
  const snippet = String(rawText || '').slice(0, 80);
  let result;
  try {
    const ctx = await getContext(chatId);
    result = await runAgent(chatId, userContent, ctx, rawText);
  } catch (err) {
    console.error('agent error:', err);
    await logUsage({ chat_id: chatId, route: 'claude', kind: 'error', latency_ms: Date.now() - t0, snippet, ok: false });
    return sendRich(
      chatId,
      '⚠️ <b>נפלתי באמצע</b>\n\nנסה לשלוח שוב.\n' +
        `<blockquote expandable>${esc(String(err.message || err).slice(0, 400))}</blockquote>`
    );
  }

  const { actions, text: agentText, diag } = result;

  // Cost accounting — tokens exactly as the API reported them, per message.
  const u = result.usage || {};
  await logUsage({
    chat_id: chatId, route: 'claude',
    kind: actions[0]?.kind || 'answer',
    model: u.model,
    input_tokens: u.input, output_tokens: u.output,
    cache_write_tokens: u.cacheWrite, cache_read_tokens: u.cacheRead,
    rounds: diag?.rounds, latency_ms: Date.now() - t0, snippet,
  });

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
    if (agentText) return sendRich(chatId, safeHtml(agentText));
    // Nothing written and nothing said. That is a bug on my side, not a message
    // the user phrased badly — say so, and carry the reason so it is debuggable
    // from the chat instead of from the server logs.
    console.error('empty turn:', JSON.stringify(diag));
    const d = diag || {};
    return sendRich(
      chatId,
      '⚠️ <b>לא הצלחתי לענות</b>\n\nזו תקלה אצלי, לא בניסוח שלך.\nנסה לשלוח שוב.\n' +
        `<blockquote expandable>stop=${esc(String(d.stop))} · rounds=${d.rounds} · pauses=${d.pauses} · ${d.ms}ms` +
        `${(d.toolErrors || []).length ? `\n${esc(d.toolErrors.join('\n')).slice(0, 500)}` : ''}</blockquote>`
    );
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
  if (agentText && agentText.length >= 25 && agentText.length <= 200) body += `\n\n💬 <i>${safeHtml(agentText)}</i>`;

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

  return sendRich(chatId, body, { reply_markup: { inline_keyboard: [undoRow] } });
}

/* ---------------- saved meals & recipes menu ---------------- */

async function cmdSaved(chatId) {
  const [{ data: meals }, { data: recipes }] = await Promise.all([
    sb.from('saved_meals').select('*').eq('chat_id', chatId).order('use_count', { ascending: false }),
    sb.from('recipes').select('*').eq('chat_id', chatId).order('name'),
  ]);

  if (!meals?.length && !recipes?.length) {
    return send(
      chatId,
      '⭐ <b>אין עדיין ארוחות או מתכונים שמורים</b>\n\n' +
        'אחרי שתרשום ארוחה, אמור לי:\n<i>"תשמור את זה בשם ארוחת בוקר קבועה"</i>\n\n' +
        'ולמתכון — פשוט שלח לי אותו:\n<i>"מתכון לפנקייק חלבון: 2 ביצים, 60 גרם שיבולת שועל..."</i>'
    );
  }

  const rows = [];
  let body = '';

  if (meals?.length) {
    body += `⭐ <b>ארוחות שמורות</b>\n`;
    const byCat = new Map();
    for (const m of meals) {
      const c = m.category || 'ללא קטגוריה';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(m);
    }
    for (const [cat, list] of byCat) {
      body += `\n<u>${esc(cat)}</u>\n`;
      for (const m of list) {
        body += `• ${esc(m.name)} — ${n(m.totals?.calories)} קק"ל${m.use_count ? ` <i>(${m.use_count}×)</i>` : ''}\n`;
        rows.push([{ text: `⭐ ${m.name}`, callback_data: `logsaved:m:${m.id}` }]);
      }
    }
  }

  if (recipes?.length) {
    body += `\n📖 <b>מתכונים</b>\n`;
    for (const r of recipes) {
      const per = r.servings ? Math.round((r.totals?.calories || 0) / r.servings) : null;
      body += `• ${esc(r.name)} — ${n(r.totals?.calories)} קק"ל סה"כ${per ? ` · ${n(per)} למנה` : ''}\n`;
      rows.push([{ text: `📖 ${r.name} — מנה אחת`, callback_data: `logsaved:r:${r.id}` }]);
    }
  }

  body += `\n<i>לחיצה רושמת מנה אחת. לכמות אחרת פשוט כתוב לי — "שתי מנות מהפנקייק".</i>`;

  return send(chatId, body, { reply_markup: { inline_keyboard: rows.slice(0, 20) } });
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

/* ---------------- persistent keyboard ----------------
   Only three buttons earn permanent screen space: the decision moment,
   the one that saves typing, and trends. Everything else lives in the
   Telegram commands menu, which costs nothing. */

const BTN = { left: '⚡ כמה נשאר לי', saved: '⭐ שמורים', trends: '📊 מגמות' };

const MAIN_KEYBOARD = {
  keyboard: [[{ text: BTN.left }, { text: BTN.saved }, { text: BTN.trends }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'מה אכלת?',
};

const COMMANDS = [
  { command: 'today', description: 'כמה נשאר לי היום' },
  { command: 'trends', description: 'גרף מגמות' },
  { command: 'saved', description: 'ארוחות ומתכונים שמורים' },
  { command: 'foods', description: 'המילון האישי שלי' },
  { command: 'dashboard', description: 'דשבורד מלא בדפדפן' },
  { command: 'export', description: 'ייצוא נתונים לניתוח' },
  { command: 'cost', description: 'כמה הבוט עולה לי' },
];

/* ---------------- /cost — where the tokens went ---------------- */

// USD per million tokens, standard list prices (not the intro discount) — a
// deliberately conservative estimate. Stored rows keep raw tokens, so a price
// change here re-prices history correctly.
const PRICES = [
  { match: /haiku/, in: 1, out: 5, cw: 1.25, cr: 0.1 },
  { match: /./, in: 3, out: 15, cw: 3.75, cr: 0.3 }, // sonnet-5 and default
];
const ILS_RATE = 3.7;

function rowCostIls(r) {
  if (!r.model) return 0;
  const p = PRICES.find((x) => x.match.test(r.model));
  const usd =
    ((r.input_tokens || 0) * p.in + (r.output_tokens || 0) * p.out +
     (r.cache_write_tokens || 0) * p.cw + (r.cache_read_tokens || 0) * p.cr) / 1e6;
  return usd * ILS_RATE;
}

const money = (ils) =>
  ils >= 1 ? `${(Math.round(ils * 100) / 100).toLocaleString('he-IL')} ₪` : `${Math.round(ils * 100)} אג׳`;

async function cmdCost(chatId) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data, error } = await sb
    .from('agent_usage').select('*')
    .eq('chat_id', chatId).gte('ts', since)
    .order('ts', { ascending: false }).limit(2000);
  if (error) return send(chatId, 'לא הצלחתי לקרוא את נתוני השימוש.');

  const rows = data || [];
  if (!rows.length) return send(chatId, 'אין עדיין נתוני שימוש — הם נאספים מעכשיו על כל הודעה.');

  const today = dayKey();
  const weekAgo = Date.now() - 7 * 864e5;
  const inToday = rows.filter((r) => dayKey(new Date(r.ts)) === today);
  const inWeek = rows.filter((r) => new Date(r.ts).getTime() >= weekAgo);
  const cost = (rs) => rs.reduce((a, r) => a + rowCostIls(r), 0);

  const claude = rows.filter((r) => r.route === 'claude');
  const free = rows.length - claude.length;
  const freePct = Math.round((free / rows.length) * 100);
  const tok = (f) => claude.reduce((a, r) => a + (r[f] || 0), 0);
  const avgMs = (rs) => (rs.length ? Math.round(rs.reduce((a, r) => a + (r.latency_ms || 0), 0) / rs.length / 100) / 10 : 0);

  const top = [...claude].sort((a, b) => rowCostIls(b) - rowCostIls(a)).slice(0, 3)
    .map((r) => `· "${esc(r.snippet || '?')}" — ${money(rowCostIls(r))}`);

  const details = [
    `טוקנים ב-30 יום: קלט ${n(tok('input_tokens'))} · פלט ${n(tok('output_tokens'))}`,
    `מטמון: כתיבה ${n(tok('cache_write_tokens'))} · קריאה ${n(tok('cache_read_tokens'))}`,
    ...(top.length ? ['', 'ההודעות היקרות ביותר:', ...top] : []),
    '',
    `לפי מחירון מלא (לא מבצע ההשקה) · שער ${ILS_RATE} ₪/$`,
  ];

  return sendRich(
    chatId,
    `💰 <b>${money(cost(rows))}</b> ב-30 הימים האחרונים\n\n` +
      `📅 היום: <b>${money(cost(inToday))}</b>\n` +
      `🗓️ השבוע: <b>${money(cost(inWeek))}</b>\n\n` +
      `🆓 טופלו בחינם: <b>${freePct}%</b> (${free} מתוך ${rows.length} הודעות)\n` +
      `🤖 הגיעו ל-Claude: ${claude.length}\n\n` +
      `⏱️ זמן תשובה ממוצע: Claude ${avgMs(claude)} שנ׳\n` +
      `<blockquote expandable>${details.join('\n')}</blockquote>`
  );
}

/* Instant, Claude-free answer to "what's left" — the most frequent question. */
async function cmdToday(chatId) {
  const [goalsRow, rows] = await Promise.all([
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
    getDay(chatId),
  ]);
  const goals = goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 };
  if (!rows.length) {
    return send(chatId, 'עוד לא נרשם כלום היום 🙂\nכתוב לי מה אכלת.', { reply_markup: MAIN_KEYBOARD });
  }

  const list = rows.map((r) => {
    const t = new Date(r.ts).toLocaleTimeString('he-IL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem',
    });
    const names = (r.items || []).map((i) => `${i.emoji || ''}${esc(i.name)}`).join(', ');
    return `${t}  ${names} — <b>${n(r.totals?.calories)}</b>`;
  }).join('\n');

  const details = dayDetailLines(rows);
  return send(
    chatId,
    `${dayStatus(rows, goals)}\n\n🍽 <b>הארוחות</b>\n${list}` +
      (details.length ? `\n<blockquote expandable>${details.join('\n')}</blockquote>` : '')
  );
}

/* ---------------- trend charts ---------------- */

async function sendChartPhoto(chatId, png, caption, markup) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
  if (markup) form.append('reply_markup', JSON.stringify(markup));
  const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) console.error('sendPhoto error:', data);
  return data;
}

/* Daily aggregates for a window, oldest -> newest, skipping untracked days. */
async function dailySeries(chatId, nDays) {
  const keys = lastDayKeys(nDays);
  const rows = await getMealsRange(chatId, keys);
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day_key)) byDay.set(r.day_key, []);
    byDay.get(r.day_key).push(r);
  }
  const days = [];
  for (const k of keys) {
    const list = byDay.get(k);
    if (!list) continue;
    const t = sumTotals(list);
    const split = estimateSplit(list);
    days.push({
      day: k,
      calories: Math.round(t.calories),
      protein: Math.round(t.protein),
      carbs: Math.round(t.carbs),
      fat: Math.round(t.fat),
      measuredPct: split ? split.measuredPct : 0,
    });
  }
  return days;
}

const RANGE_LABEL = (n) => (n <= 7 ? '7 ימים אחרונים' : n <= 14 ? 'שבועיים אחרונים' : n <= 31 ? '30 ימים אחרונים' : `${n} ימים אחרונים`);

/* metric: calories | protein | weight | accuracy */
async function sendTrend(chatId, metric = 'calories', nDays = 30) {
  const goalsRow = await sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle();
  const goals = goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 };

  let chart, caption;

  if (metric === 'weight') {
    const { data: rows } = await sb
      .from('measurements').select('*').eq('chat_id', chatId).order('measured_on', { ascending: true });
    if (!rows?.length) {
      return send(chatId, '⚖️ אין עדיין מדידות.\nשלח לי <i>"נשקלתי 95.8, מותן 105"</i> ואתחיל לעקוב.');
    }
    chart = weightChart(rows);
    const first = rows.find((r) => r.weight_kg != null);
    const last = [...rows].reverse().find((r) => r.weight_kg != null);
    caption = first && last && first !== last
      ? `⚖️ <b>${(last.weight_kg - first.weight_kg > 0 ? '+' : '')}${r1(last.weight_kg - first.weight_kg)} ק"ג</b> מאז ${first.measured_on.slice(5).split('-').reverse().join('.')}`
      : '⚖️ מדידות גוף';
  } else {
    const days = await dailySeries(chatId, nDays);
    if (!days.length) return send(chatId, '📊 אין עדיין נתונים בטווח הזה.');
    const label = RANGE_LABEL(nDays);
    const avg = (f) => Math.round(days.reduce((s, d) => s + d[f], 0) / days.length);

    // Captions lead with the average against the goal — a single day is noise,
    // the average is the thing that actually moves the scale.
    const gap = (avgVal, goal, unit) => {
      const d = avgVal - goal;
      if (d === 0) return 'בול על היעד';
      return `<b>${d > 0 ? '+' : ''}${n(d)}</b> ${unit} ${d > 0 ? 'מעל' : 'מתחת ל'}יעד ${n(goal)}`;
    };

    if (metric === 'protein') {
      chart = proteinChart(days, goals.protein, label);
      const hit = days.filter((d) => d.protein >= goals.protein * 0.9).length;
      caption =
        `🥩 ממוצע <b>${avg('protein')}</b> ג ליום\n` +
        `🎯 ${gap(avg('protein'), goals.protein, 'ג')}\n\n` +
        `<i>${hit} מתוך ${days.length} ימים קרובים ליעד</i>`;
    } else if (metric === 'accuracy') {
      chart = accuracyChart(days, label);
      caption =
        `🎯 ממוצע דיוק <b>${avg('measuredPct')}%</b>\n\n` +
        `<i>ככל שהמילון האישי גדל, החלק המשוער קטן</i>`;
    } else {
      chart = caloriesChart(days, goals.calories, label);
      const over = days.filter((d) => isOver(d.calories, goals.calories)).length;
      caption =
        `🔥 ממוצע <b>${n(avg('calories'))}</b> קק"ל ליום\n` +
        `🎯 ${gap(avg('calories'), goals.calories, 'קק"ל')}\n\n` +
        `<i>${over} ימים חרגו ביותר מ-10%, מתוך ${days.length}</i>`;
    }
  }

  const png = await renderChart(chart);
  if (!png) return send(chatId, 'לא הצלחתי לייצר את הגרף כרגע 😕 נסה שוב בעוד רגע.');
  return sendChartPhoto(chatId, png, caption, otherCharts(metric));
}

const CHART_MENU = [
  ['calories', '🔥 קלוריות'],
  ['protein', '🥩 חלבון'],
  ['weight', '⚖️ משקל והיקף'],
  ['accuracy', '🎯 איכות הנתונים'],
];

/* The 📊 button opens a menu rather than guessing which view is wanted. */
async function cmdTrends(chatId) {
  const rows = [];
  for (let i = 0; i < CHART_MENU.length; i += 2) {
    rows.push(CHART_MENU.slice(i, i + 2).map(([k, label]) => ({ text: label, callback_data: 'chart:' + k })));
  }
  return send(chatId, '📊 <b>מה להציג?</b>', { reply_markup: { inline_keyboard: rows } });
}

/* Under every chart: one tap to any other view. */
const otherCharts = (current) => ({
  inline_keyboard: [
    CHART_MENU.filter(([k]) => k !== current).map(([k, label]) => ({ text: label, callback_data: 'chart:' + k })),
  ],
});

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

  if (!chatId) return ack();

  // Chart menu selection
  if (data.startsWith('chart:')) {
    const metric = data.slice(6);
    await ack('מכין…');
    await logUsage({ chat_id: chatId, route: 'menu', kind: `chart:${metric}` });
    return sendTrend(chatId, metric, 30);
  }

  // One-tap log from the /saved menu
  if (data.startsWith('logsaved:')) {
    const [, kind, id] = data.split(':');
    const table = kind === 'm' ? 'saved_meals' : 'recipes';
    const { data: row } = await sb.from(table).select('name').eq('id', Number(id)).eq('chat_id', chatId).maybeSingle();
    if (!row) return ack('לא נמצא');
    await ack('רושם…');
    return processWithAgent(chatId, `רשום ${row.name}`, row.name);
  }

  if (!data.startsWith('undo:')) return ack();

  let result;
  try {
    result = await undoAction(chatId, Number(data.slice(5)));
  } catch (err) {
    console.error('undo error:', err);
    return ack('הביטול נכשל — נסה שוב');
  }

  if (!result.ok) return ack('כבר בוטל');

  await ack('בוטל ✔️');
  await logUsage({ chat_id: chatId, route: 'menu', kind: 'undo' });

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
    : result.kind === 'save_recipe' ? 'המתכון שוחזר'
    : result.kind === 'save_meal' ? 'הארוחה השמורה שוחזרה'
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
