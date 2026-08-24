// Nutrition AGENT bot — new webhook route, runs in parallel to api/telegram.js.
// Phase: skeleton — verify secret, dedupe by update_id, reply once.
// The agent loop (Claude + tools) is added in the next phase.

import { createClient } from '@supabase/supabase-js';

const TOKEN = process.env.AGENT_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ---------------- telegram helpers ---------------- */

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

/* ---------------- dedupe ----------------
   Telegram re-sends an update if it doesn't get a 200 fast enough.
   Serverless memory doesn't survive between invocations, so the guard
   lives in the DB: primary-key insert — second attempt hits a conflict
   and we ack without processing. This kills the old bot's duplicate-reply bug. */

async function firstTimeSeen(updateId) {
  const { error } = await sb.from('agent_updates').insert({ update_id: updateId });
  if (!error) return true;
  if (error.code === '23505') return false; // duplicate — already handled
  console.error('dedupe insert error:', error);
  return true; // fail open: better a rare duplicate than a dropped meal
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
    if (update.message) await onMessage(update.message);
  } catch (err) {
    console.error('handler error:', err);
  }
  return res.status(200).send('ok');
}

/* ---------------- routing (skeleton) ---------------- */

async function onMessage(msg) {
  const chatId = msg.chat.id;

  if (msg.text === '/start') {
    return send(
      chatId,
      '🤖 <b>היי! אני הסוכן החדש</b>\n' +
        'עוד רגע אני לומד לתעד, לתקן ולזכור.\n' +
        'בינתיים — כל הודעה שתשלח תקבל אישור שקיבלתי אותה, פעם אחת בדיוק.'
    );
  }

  return send(chatId, `📩 קיבלתי: <i>${(msg.text || '[לא טקסט]').slice(0, 100)}</i>\n(שלד — הסוכן עצמו מגיע בשלב הבא)`);
}
