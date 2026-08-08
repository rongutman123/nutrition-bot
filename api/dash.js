// Dashboard API — the security boundary between the browser and Supabase.
// The service_role key never leaves the server; the browser only ever holds
// an opaque session token that maps to one chat_id.

import crypto from 'node:crypto';
import { parseMealEdit, sumItems } from '../lib/claude.js';
import {
  redeemDashCode, activateDashToken, resolveSession,
  getMealsRange, getGoals, setGoals, getMeal, updateMeal, deleteMeal,
  listFavorites, dayKey, lastDayKeys,
} from '../lib/db.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const json = (res, code, body) => res.status(code).json(body);

/* ---- Telegram Mini App auth ----
   Telegram signs initData with a key derived from the bot token, so we can
   verify the user without any login step at all.
   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function verifyTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;

    // Reject anything older than 24h
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86_400) return null;

    const user = JSON.parse(params.get('user') || '{}');
    return user?.id ? Number(user.id) : null;
  } catch {
    return null;
  }
}

/* Resolve the caller to a chat_id, via Mini App signature or session token. */
async function authenticate(req) {
  const initData = req.headers['x-telegram-init-data'];
  if (initData) {
    const id = verifyTelegramInitData(initData);
    if (id) return id;
  }
  const token = req.headers['x-dash-token'];
  if (token) return resolveSession(token);
  return null;
}

/* ---------------- analytics shaping ---------------- */

function buildPayload(meals, goals, days) {
  const keys = lastDayKeys(days);
  const empty = () => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 });

  // Daily totals for the trend chart
  const byDay = Object.fromEntries(keys.map((k) => [k, empty()]));
  for (const m of meals) {
    if (!byDay[m.day_key]) continue;
    for (const k of Object.keys(empty())) byDay[m.day_key][k] += Number(m.totals?.[k]) || 0;
  }
  const trend = keys.map((k) => ({ day: k, ...byDay[k] }));

  // Habits: most frequent items across the range
  const itemCount = new Map();
  for (const m of meals) {
    for (const it of m.items || []) {
      const name = (it.name || '').trim();
      if (!name) continue;
      const prev = itemCount.get(name) || { name, count: 0, calories: 0 };
      prev.count += 1;
      prev.calories += Number(it.calories) || 0;
      itemCount.set(name, prev);
    }
  }
  const topItems = [...itemCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map((x) => ({ ...x, avgCalories: Math.round(x.calories / x.count) }));

  // Weekday averages — which days run high
  const dow = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (const t of trend) {
    if (t.calories <= 0) continue;
    const d = new Date(t.day + 'T12:00:00Z').getUTCDay();
    dow[d].total += t.calories;
    dow[d].days += 1;
  }
  const weekday = dow.map((x, i) => ({
    dow: i,
    avg: x.days ? Math.round(x.total / x.days) : 0,
  }));

  const logged = trend.filter((t) => t.calories > 0);
  const avg = (field) =>
    logged.length ? Math.round(logged.reduce((s, t) => s + t[field], 0) / logged.length) : 0;

  return {
    goals,
    today: byDay[dayKey()] || empty(),
    trend,
    meals: meals.map((m) => ({
      id: m.id,
      ts: m.ts,
      day: m.day_key,
      text: m.raw_text,
      items: m.items,
      totals: m.totals,
      confidence: m.confidence,
      source: m.source,
    })),
    topItems,
    weekday,
    stats: {
      loggedDays: logged.length,
      totalDays: days,
      avgCalories: avg('calories'),
      avgProtein: avg('protein'),
      avgCarbs: avg('carbs'),
      avgFat: avg('fat'),
      overDays: logged.filter((t) => t.calories > goals.calories).length,
    },
  };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  const action = req.query?.action || req.body?.action;

  try {
    /* --- login: exchange the 6-digit code from the bot for a token --- */
    if (action === 'redeem_code') {
      const code = String(req.body?.code || '').trim();
      if (!/^\d{6}$/.test(code)) return json(res, 400, { error: 'קוד לא תקין' });
      const result = await redeemDashCode(code);
      if (!result) return json(res, 401, { error: 'קוד שגוי או שפג תוקפו' });
      return json(res, 200, { token: result.token });
    }

    /* --- login: one-tap link from the bot --- */
    if (action === 'activate') {
      const token = String(req.body?.token || '').trim();
      if (!token) return json(res, 400, { error: 'missing token' });
      const chatId = await activateDashToken(token);
      if (!chatId) return json(res, 401, { error: 'הקישור אינו תקף' });
      return json(res, 200, { ok: true });
    }

    /* --- everything below requires auth --- */
    const chatId = await authenticate(req);
    if (!chatId) return json(res, 401, { error: 'unauthorized' });

    if (action === 'data') {
      const days = Math.min(365, Math.max(1, Number(req.query?.days) || 30));
      const keys = lastDayKeys(days);
      const [meals, goals] = await Promise.all([getMealsRange(chatId, keys), getGoals(chatId)]);
      const payload = buildPayload(meals, goals, days);
      payload.favorites = await listFavorites(chatId, 20);
      return json(res, 200, payload);
    }

    if (action === 'delete_meal') {
      const { id } = req.body || {};
      if (!id) return json(res, 400, { error: 'missing id' });
      const deleted = await deleteMeal(chatId, id);
      return json(res, 200, { ok: !!deleted });
    }

    if (action === 'edit_meal') {
      const { id, instruction } = req.body || {};
      if (!id || !instruction) return json(res, 400, { error: 'missing id or instruction' });

      const meal = await getMeal(chatId, id);
      if (!meal) return json(res, 404, { error: 'not found' });

      const parsed = await parseMealEdit(meal.items, instruction);
      if (!parsed.items?.length) return json(res, 400, { error: 'התיקון מרוקן את הארוחה' });

      const totals = sumItems(parsed.items);
      await updateMeal(chatId, id, parsed, totals);
      return json(res, 200, { ok: true, items: parsed.items, totals });
    }

    if (action === 'set_goals') {
      const { calories, protein, carbs, fat } = req.body || {};
      const nums = [calories, protein, carbs, fat].map(Number);
      if (nums.some((x) => !Number.isFinite(x) || x < 0)) {
        return json(res, 400, { error: 'invalid goals' });
      }
      await setGoals(chatId, {
        calories: nums[0], protein: nums[1], carbs: nums[2], fat: nums[3],
      });
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: 'unknown action' });
  } catch (err) {
    console.error('dash error:', err);
    return json(res, 500, { error: 'server error' });
  }
}
