// Supabase data layer. Runs server-side only with the service_role key.

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}

export function lastDayKeys(nDays) {
  const keys = [];
  for (let i = nDays - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }
  return keys;
}

export async function saveMeal(chatId, rawText, parsed, totals) {
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
    })
    .select('id, day_key')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteMeal(chatId, id) {
  const { data, error } = await sb
    .from('meals')
    .delete()
    .eq('id', id)
    .eq('chat_id', chatId)
    .select('raw_text, day_key')
    .maybeSingle();
  if (error) throw error;
  return data;
}

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
