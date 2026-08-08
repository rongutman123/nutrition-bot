// Supabase data layer. Runs server-side only with the service_role key.

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* Calendar date in Israel, e.g. "2026-07-02".
   Stored on every row so "today" is a simple equality — no timezone math in SQL. */
export function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}

export function lastDayKeys(nDays) {
  const keys = [];
  for (let i = nDays - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }
  return keys; // oldest → newest
}

/* ---------------- meals ---------------- */

export async function saveMeal(chatId, rawText, parsed, totals, source = 'ai') {
  const { data, error } = await sb
    .from('meals')
    .insert({
      chat_id: chatId,
      day_key: dayKey(),
      raw_text: rawText,
      items: parsed.items,
      totals,
      assumptions: parsed.assumptions || '',
      confidence: parsed.confidence || 'medium',
      source,
    })
    .select('id, day_key')
    .single();
  if (error) throw error;
  return data;
}

export async function getMeal(chatId, id) {
  const { data, error } = await sb
    .from('meals')
    .select('*')
    .eq('id', id)
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateMeal(chatId, id, parsed, totals) {
  const { data, error } = await sb
    .from('meals')
    .update({
      items: parsed.items,
      totals,
      assumptions: parsed.assumptions || '',
      confidence: parsed.confidence || 'medium',
    })
    .eq('id', id)
    .eq('chat_id', chatId)
    .select('id, day_key, raw_text')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function deleteMeal(chatId, id) {
  const { data, error } = await sb
    .from('meals')
    .delete()
    .eq('id', id)
    .eq('chat_id', chatId) // never delete across chats
    .select('raw_text, day_key')
    .maybeSingle();
  if (error) throw error;
  return data; // null if it was already gone
}

// key: a single day_key string or an array of them
export async function getDayMeals(chatId, key) {
  const keys = Array.isArray(key) ? key : [key];
  const { data, error } = await sb
    .from('meals')
    .select('id, ts, raw_text, totals, day_key')
    .eq('chat_id', chatId)
    .in('day_key', keys)
    .order('ts', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ---------------- goals ---------------- */

const DEFAULT_GOALS = { calories: 2000, protein: 130, carbs: 200, fat: 65 };

export async function getGoals(chatId) {
  const { data, error } = await sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle();
  if (error) throw error;
  return data || DEFAULT_GOALS;
}

export async function setGoals(chatId, g) {
  const { error } = await sb
    .from('goals')
    .upsert({ chat_id: chatId, ...g, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/* ---------------- favorites (recurring meals) ---------------- */

export async function addFavorite(chatId, label, items, totals) {
  const { data, error } = await sb
    .from('favorites')
    .upsert(
      { chat_id: chatId, label, items, totals, last_used: new Date().toISOString() },
      { onConflict: 'chat_id,label' }
    )
    .select('id, label')
    .single();
  if (error) throw error;
  return data;
}

export async function listFavorites(chatId, limit = 12) {
  const { data, error } = await sb
    .from('favorites')
    .select('id, label, totals, use_count')
    .eq('chat_id', chatId)
    .order('use_count', { ascending: false })
    .order('last_used', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getFavorite(chatId, id) {
  const { data, error } = await sb
    .from('favorites')
    .select('*')
    .eq('id', id)
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function bumpFavorite(chatId, id, currentCount) {
  const { error } = await sb
    .from('favorites')
    .update({ use_count: (currentCount || 0) + 1, last_used: new Date().toISOString() })
    .eq('id', id)
    .eq('chat_id', chatId);
  if (error) console.error('bumpFavorite:', error);
}

export async function deleteFavorite(chatId, id) {
  const { data, error } = await sb
    .from('favorites')
    .delete()
    .eq('id', id)
    .eq('chat_id', chatId)
    .select('label')
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------------- pattern tracking (auto-detect repeats) ---------------- */

const normalize = (s = '') => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);

/* Counts how often a meal text repeats. Returns the row so the caller can
   decide whether to offer saving it as a favorite. */
export async function trackPattern(chatId, rawText) {
  const norm_text = normalize(rawText);
  if (!norm_text || norm_text.length < 3) return null;

  const { data: existing } = await sb
    .from('meal_patterns')
    .select('*')
    .eq('chat_id', chatId)
    .eq('norm_text', norm_text)
    .maybeSingle();

  if (!existing) {
    await sb.from('meal_patterns').insert({ chat_id: chatId, norm_text, seen_count: 1 });
    return { seen_count: 1, offered: false };
  }

  const seen_count = existing.seen_count + 1;
  await sb
    .from('meal_patterns')
    .update({ seen_count, last_seen: new Date().toISOString() })
    .eq('chat_id', chatId)
    .eq('norm_text', norm_text);

  return { seen_count, offered: existing.offered };
}

export async function markPatternOffered(chatId, rawText) {
  await sb
    .from('meal_patterns')
    .update({ offered: true })
    .eq('chat_id', chatId)
    .eq('norm_text', normalize(rawText));
}

/* ---------------- dashboard sessions ---------------- */

/* Login flow, driven from the bot side so the browser never needs a chat id:
   1. User sends /dashboard → bot creates a session (token + 6-digit code)
      and shows both: a one-tap link, and the code for typing on a desktop.
   2. Browser submits the code → session is marked verified and the token
      is handed to the browser to store. */

export async function createDashSession(chatId, token, code, minutes = 15) {
  const expires_at = new Date(Date.now() + minutes * 60_000).toISOString();
  // One active login attempt per chat keeps the code space clean.
  await sb.from('dash_sessions').delete().eq('chat_id', chatId).eq('verified', false);
  const { error } = await sb
    .from('dash_sessions')
    .insert({ token, chat_id: chatId, code, verified: false, expires_at });
  if (error) throw error;
}

/* Exchange a 6-digit code for a long-lived session token. */
export async function redeemDashCode(code, days = 30) {
  const { data, error } = await sb
    .from('dash_sessions')
    .select('*')
    .eq('code', String(code).trim())
    .eq('verified', false)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  const expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
  await sb
    .from('dash_sessions')
    .update({ verified: true, code: null, expires_at })
    .eq('token', data.token);
  return { token: data.token, chatId: data.chat_id };
}

/* Mark a token verified directly — used by the one-tap link from the bot. */
export async function activateDashToken(token, days = 30) {
  const { data, error } = await sb
    .from('dash_sessions')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (!data.verified && new Date(data.expires_at) < new Date()) return null;

  const expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
  await sb
    .from('dash_sessions')
    .update({ verified: true, code: null, expires_at })
    .eq('token', token);
  return data.chat_id;
}

/* Returns the chat_id for a verified, unexpired session — or null. */
export async function resolveSession(token) {
  if (!token) return null;
  const { data, error } = await sb
    .from('dash_sessions')
    .select('chat_id, verified, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.verified) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data.chat_id;
}

/* ---------------- dashboard queries ---------------- */

/* All meals in a day range, newest last. Used for trends + daily breakdown. */
export async function getMealsRange(chatId, dayKeys) {
  const { data, error } = await sb
    .from('meals')
    .select('id, ts, day_key, raw_text, items, totals, confidence, source')
    .eq('chat_id', chatId)
    .in('day_key', dayKeys)
    .order('ts', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ---------------- weekly digest ---------------- */

/* All chat_ids that logged anything in the given day range — used by the cron job. */
export async function getActiveChats(dayKeys) {
  const { data, error } = await sb.from('meals').select('chat_id').in('day_key', dayKeys);
  if (error) throw error;
  return [...new Set((data || []).map((r) => r.chat_id))];
}
