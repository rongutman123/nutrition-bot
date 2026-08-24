// Agent core — context building, Claude tool loop, tool execution.
// Used only by api/agent.js. Does not touch the old bot's code paths.

import { createClient } from '@supabase/supabase-js';
import { dayKey } from './db.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-5';
const MAX_ROUNDS = 3;        // Claude calls per message (Hobby: 60s hard cap)
const DEADLINE_MS = 40_000;  // stop starting new rounds after this

/* ---------------- time (Israel) ---------------- */

function tzOffsetStr(dateStr) {
  // Israel offset for a given calendar date, e.g. "+03:00" (IDT) / "+02:00" (IST)
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', timeZoneName: 'shortOffset',
  }).formatToParts(probe).find((p) => p.type === 'timeZoneName').value; // "GMT+3"
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '+02:00';
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}`;
}

function israelNowHM() {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

/* ts for a meal: explicit date/time win, otherwise now. */
function mealTs(date, meal_time) {
  if (!date && !meal_time) return new Date().toISOString();
  const d = date || dayKey();
  const t = meal_time || '12:00';
  return `${d}T${t}:00${tzOffsetStr(d)}`;
}

/* ---------------- macros ---------------- */

export function sumItems(items) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 };
  for (const i of items || []) for (const k of Object.keys(t)) t[k] += Number(i[k]) || 0;
  return t;
}

/* % of today's calories that come from measured sources (dictionary/label)
   vs AI estimates. Old-bot rows have no per-item source_type — fall back to
   the meal-level confidence ("high" = label read = measured). */
export function estimateSplit(rows) {
  let measured = 0, estimated = 0;
  for (const r of rows) {
    for (const it of r.items || []) {
      const cal = Number(it.calories) || 0;
      const src = it.source_type || (r.confidence === 'high' ? 'label' : 'ai_estimate');
      if (src === 'personal_food' || src === 'label') measured += cal;
      else estimated += cal;
    }
  }
  const total = measured + estimated;
  if (!total) return null;
  return {
    measuredPct: Math.round((measured / total) * 100),
    estimatedPct: Math.round((estimated / total) * 100),
  };
}

/* ---------------- context ---------------- */

export async function getContext(chatId) {
  const [foods, meals, goalsRow] = await Promise.all([
    sb.from('my_foods').select('*').eq('chat_id', chatId).order('alias'),
    sb.from('meals').select('id, ts, raw_text, items, totals, confidence')
      .eq('chat_id', chatId).eq('day_key', dayKey()).order('ts', { ascending: true }),
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
  ]);
  if (foods.error) throw foods.error;
  if (meals.error) throw meals.error;
  return {
    foods: foods.data || [],
    todayMeals: meals.data || [],
    goals: goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 },
  };
}

function foodsBlock(foods) {
  if (!foods.length) return '(המילון ריק עדיין)';
  return foods.map((f) => {
    let s = `- "${f.alias}"`;
    if (f.product) s += ` = ${f.product}`;
    if (f.serving_grams) s += ` · מנה ${f.serving_grams} גרם`;
    if (f.kcal_per_100g != null) {
      s += ` · ל-100 גרם: ${f.kcal_per_100g} קק"ל`;
      if (f.protein_per_100g != null) s += `, חלבון ${f.protein_per_100g}`;
      if (f.carbs_per_100g != null) s += `, פחמימות ${f.carbs_per_100g}`;
      if (f.fat_per_100g != null) s += `, שומן ${f.fat_per_100g}`;
    }
    if (f.variants) s += ` · וריאציות: ${JSON.stringify(f.variants)}`;
    return s;
  }).join('\n');
}

function mealsBlock(meals) {
  if (!meals.length) return '(עוד לא נרשם כלום היום)';
  return meals.map((m) => {
    const t = new Date(m.ts).toLocaleTimeString('he-IL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem',
    });
    const names = (m.items || []).map((i) => i.name).join(', ');
    return `- id=${m.id} · ${t} · ${names} · ${Math.round(m.totals?.calories || 0)} קק"ל`;
  }).join('\n');
}

function buildSystem(ctx) {
  return `אתה סוכן יומן התזונה האישי של המשתמש בטלגרם (משתמש יחיד). כל הודעה היא אחת מאלה: רישום אוכל, תיקון/הוספה לרישום קיים, שאלה, או שיחה. החלט ופעל.

הכלים שלך:
- log_meal — רישום ארוחה חדשה. תומך ברישום לאחור (date / meal_time).
- update_meal — תיקון או הוספת פריטים לארוחה קיימת. שולחים את הפירוק המלא אחרי השינוי.

חוקים מחייבים:
1. שאלות עונים בטקסט, לא רושמים. אם לא ברור אם זה רישום או שאלה — שאל, אל תכתוב.
2. קיבוץ ארוחות: אם עברו פחות מ-15 דקות מהארוחה האחרונה והמשתמש שולח עוד אוכל — זו אותה ארוחה: update_meal עם כל הפריטים (הקיימים + החדשים), אלא אם אמר שזו ארוחה נפרדת.
3. מילון קודם להערכה: בדוק את המילון האישי לפני כל הערכה. התאמת כינוי גוברת על ניחוש. serving_grams מהמילון היא הכמות כשלא צוינה כמות. יש ערכים ל-100 גרם? השתמש בהם, source_type="personal_food".
4. החמרה מכוונת: כשאתה מעריך בלי תווית ובלי מילון — בחר את הקצה הגבוה של טווח הקלוריות הסביר. העדפה מפורשת של המשתמש.
5. תיקון ("היה 90 גרם", "בעצם בלי הגבינה") מכוון לארוחה האחרונה אלא אם צוין אחרת — update_meal, חשב מחדש פרופורציונלית.
6. source_type לכל פריט: personal_food (מהמילון) / label (המשתמש ציין ערכים מפורשים מתווית) / ai_estimate. quantity_source: user_explicit / default / estimated.
7. ציין ב-assumptions כל הנחה מהותית, בקצרה ובעברית.
8. אחרי קריאת כלי מוצלחת ענה במשפט קצר אחד לכל היותר או כלום — הקוד כבר מציג את הפירוט למשתמש. אל תחזור על רשימת הפריטים.
9. מוצר ישראלי מוכר — השתמש בערכים האופייניים שלו. confidence: high רק כשהערכים ממקור מדויק.

--- המילון האישי (my_foods) ---
${foodsBlock(ctx.foods)}

--- הארוחות של היום ---
${mealsBlock(ctx.todayMeals)}

--- יעדים יומיים ---
קלוריות ${ctx.goals.calories} · חלבון ${ctx.goals.protein} · פחמימות ${ctx.goals.carbs} · שומן ${ctx.goals.fat}

עכשיו: ${dayKey()} ${israelNowHM()} (שעון ישראל).`;
}

/* ---------------- tool schemas ---------------- */

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'שם הפריט בעברית' },
    portion: { type: 'string', description: 'תיאור כמות קריא, למשל "2 פרוסות"' },
    grams: { type: 'number' },
    calories: { type: 'number' },
    protein: { type: 'number' },
    carbs: { type: 'number' },
    fat: { type: 'number' },
    fiber: { type: 'number' },
    sugar: { type: 'number' },
    sodium_mg: { type: 'number' },
    source_type: { type: 'string', enum: ['personal_food', 'label', 'ai_estimate'] },
    quantity_source: { type: 'string', enum: ['user_explicit', 'default', 'estimated'] },
  },
  required: ['name', 'grams', 'calories', 'protein', 'carbs', 'fat', 'source_type', 'quantity_source'],
};

const TOOLS = [
  {
    name: 'log_meal',
    description: 'רישום ארוחה חדשה ליומן. הערכים עבור הכמות שנאכלה בפועל, לא ל-100 גרם.',
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: ITEM_SCHEMA, minItems: 1 },
        meal_time: { type: 'string', description: 'HH:MM שעון ישראל — רק אם המשתמש ציין זמן שאינו עכשיו' },
        date: { type: 'string', description: 'YYYY-MM-DD — רק אם לא היום' },
        assumptions: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['items', 'confidence'],
    },
  },
  {
    name: 'update_meal',
    description: 'עדכון ארוחה קיימת: תיקון כמויות, הסרה או הוספת פריטים. שלח את מערך הפריטים המלא כפי שצריך להיות אחרי השינוי.',
    input_schema: {
      type: 'object',
      properties: {
        meal_id: { type: 'string', description: 'id של הארוחה מרשימת הארוחות של היום' },
        items: { type: 'array', items: ITEM_SCHEMA, minItems: 1 },
        assumptions: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['meal_id', 'items', 'confidence'],
    },
  },
];

/* ---------------- tool execution ---------------- */

async function recordAction(chatId, kind, payload) {
  const { data, error } = await sb
    .from('agent_actions')
    .insert({ chat_id: chatId, kind, payload })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function execLogMeal(chatId, rawText, input) {
  const totals = sumItems(input.items);
  const ts = mealTs(input.date, input.meal_time);
  const day = input.date || dayKey();
  const { data, error } = await sb
    .from('meals')
    .insert({
      chat_id: chatId, ts, day_key: day, raw_text: rawText,
      items: input.items, totals,
      assumptions: input.assumptions || '', confidence: input.confidence, source: 'agent',
    })
    .select('id')
    .single();
  if (error) throw error;
  const actionId = await recordAction(chatId, 'log_meal', { meal_id: data.id });
  return {
    ok: true, kind: 'log_meal', mealId: data.id, actionId,
    items: input.items, totals, assumptions: input.assumptions || '',
    confidence: input.confidence, dayKeyUsed: day,
  };
}

async function execUpdateMeal(chatId, input) {
  const { data: meal, error: e1 } = await sb
    .from('meals').select('*').eq('id', input.meal_id).eq('chat_id', chatId).maybeSingle();
  if (e1) throw e1;
  if (!meal) return { ok: false, error: 'meal not found' };

  const totals = sumItems(input.items);
  const prev = {
    items: meal.items, totals: meal.totals,
    assumptions: meal.assumptions, confidence: meal.confidence,
  };
  const { error: e2 } = await sb
    .from('meals')
    .update({ items: input.items, totals, assumptions: input.assumptions || '', confidence: input.confidence })
    .eq('id', meal.id).eq('chat_id', chatId);
  if (e2) throw e2;
  const actionId = await recordAction(chatId, 'update_meal', { meal_id: meal.id, prev });
  return {
    ok: true, kind: 'update_meal', mealId: meal.id, actionId,
    items: input.items, totals, assumptions: input.assumptions || '',
    confidence: input.confidence, dayKeyUsed: meal.day_key,
  };
}

/* ---------------- undo ---------------- */

export async function undoAction(chatId, actionId) {
  const { data: action, error } = await sb
    .from('agent_actions').select('*')
    .eq('id', actionId).eq('chat_id', chatId).eq('undone', false).maybeSingle();
  if (error) throw error;
  if (!action) return { ok: false, reason: 'already' };

  if (action.kind === 'log_meal') {
    await sb.from('meals').delete().eq('id', action.payload.meal_id).eq('chat_id', chatId);
  } else if (action.kind === 'update_meal') {
    await sb.from('meals').update(action.payload.prev)
      .eq('id', action.payload.meal_id).eq('chat_id', chatId);
  } else {
    return { ok: false, reason: 'unknown kind' };
  }
  await sb.from('agent_actions').update({ undone: true }).eq('id', action.id);
  return { ok: true, kind: action.kind };
}

/* ---------------- claude ---------------- */

async function callClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    // Note: no temperature — the sampling params were removed on Sonnet 5 (400 if sent).
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000,
      system, messages, tools: TOOLS,
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ---------------- agent loop ----------------
   Returns { actions: [execution results], text: final model text }. */
export async function runAgent(chatId, userText, ctx) {
  const started = Date.now();
  const system = buildSystem(ctx);
  const messages = [{ role: 'user', content: userText }];
  const actions = [];
  let finalText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > DEADLINE_MS) break;
    const resp = await callClaude(system, messages);

    const textBlocks = (resp.content || []).filter((b) => b.type === 'text');
    finalText = textBlocks.map((b) => b.text).join('\n').trim();

    if (resp.stop_reason !== 'tool_use') break;

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: resp.content });

    const results = [];
    for (const tu of toolUses) {
      let result;
      try {
        if (tu.name === 'log_meal') result = await execLogMeal(chatId, userText, tu.input);
        else if (tu.name === 'update_meal') result = await execUpdateMeal(chatId, tu.input);
        else result = { ok: false, error: `unknown tool ${tu.name}` };
      } catch (err) {
        console.error('tool exec error:', tu.name, err);
        result = { ok: false, error: String(err.message || err) };
      }
      if (result.ok) actions.push(result);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result.ok
          ? { ok: true, meal_id: result.mealId, totals: result.totals }
          : { ok: false, error: result.error }),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return { actions, text: finalText };
}

/* ---------------- day summary data ---------------- */

export async function getDay(chatId, key = dayKey()) {
  const { data, error } = await sb
    .from('meals').select('id, ts, raw_text, items, totals, confidence')
    .eq('chat_id', chatId).eq('day_key', key).order('ts', { ascending: true });
  if (error) throw error;
  return data || [];
}
