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
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const [foods, meals, goalsRow, chatLog] = await Promise.all([
    sb.from('my_foods').select('*').eq('chat_id', chatId).order('alias'),
    sb.from('meals').select('id, ts, raw_text, items, totals, confidence')
      .eq('chat_id', chatId).eq('day_key', dayKey()).order('ts', { ascending: true }),
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
    // Ordered by id, not created_at: two turns written in the same millisecond
    // tie on the timestamp and can come back in the wrong order.
    sb.from('agent_chat_log').select('id, role, content')
      .eq('chat_id', chatId).gte('created_at', since)
      .order('id', { ascending: false }).limit(10),
  ]);
  if (foods.error) throw foods.error;
  if (meals.error) throw meals.error;
  return {
    foods: foods.data || [],
    todayMeals: meals.data || [],
    goals: goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 },
    history: (chatLog.data || []).reverse(), // oldest → newest
  };
}

/* Append a turn to the rolling conversation log (best-effort). */
export async function logChatTurn(chatId, role, content) {
  const clean = String(content || '').slice(0, 600);
  if (!clean) return;
  const { error } = await sb
    .from('agent_chat_log')
    .insert({ chat_id: chatId, role, content: clean });
  if (error) console.error('chat log error:', error);
}

function foodsBlock(foods) {
  if (!foods.length) return '(המילון ריק עדיין)';
  return foods.map((f) => {
    const partial = f.kcal_per_100g == null;
    let s = `- "${f.alias}"${partial ? ' ⚠️חסרים ערכים' : ''}`;
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
  // Full item JSON, not just names — update_meal is full-replacement, so the
  // model must be able to copy untouched items verbatim instead of re-guessing.
  return meals.map((m) => {
    const t = new Date(m.ts).toLocaleTimeString('he-IL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem',
    });
    return `- id=${m.id} · ${t} · ${Math.round(m.totals?.calories || 0)} קק"ל\n  items=${JSON.stringify(m.items)}`;
  }).join('\n');
}

function buildSystem(ctx) {
  return `אתה סוכן יומן התזונה האישי של המשתמש בטלגרם (משתמש יחיד). כל הודעה היא אחת מאלה: רישום אוכל, תיקון/הוספה לרישום קיים, שאלה, או שיחה. החלט ופעל.

הכלים שלך:
- log_meal — רישום ארוחה חדשה. תומך ברישום לאחור (date / meal_time).
- update_meal — תיקון או הוספת פריטים לארוחה קיימת. שולחים את הפירוק המלא אחרי השינוי.
- remember_food — שמירה או עדכון של מאכל במילון האישי. שלח רק שדות שידועים.
- delete_meal — מחיקת ארוחה שלמה מהיומן ("תמחק את הקוטג'"). ניתנת לשחזור בכפתור ביטול.
- log_measurement — רישום מדידת גוף (משקל/מותן/צוואר/צעדים). אחוז שומן מחושב בקוד.
- set_goals — שינוי היעדים היומיים ("תעדכן יעד חלבון ל-150"). שלח רק את מה שמשתנה.
- query_log — נתונים היסטוריים מעבר להיום (סיכומים יומיים בטווח תאריכים). קרא אותו לפני שאתה עונה על שאלות היסטוריה.

חוקים מחייבים:
1. שאלות עונים בטקסט, לא רושמים. אם לא ברור אם זה רישום או שאלה — שאל, אל תכתוב.
2. קיבוץ ארוחות: אם עברו פחות מ-15 דקות מהארוחה האחרונה והמשתמש שולח עוד אוכל — זו אותה ארוחה: update_meal עם כל הפריטים (הקיימים + החדשים), אלא אם אמר שזו ארוחה נפרדת.
3. מילון קודם להערכה: בדוק את המילון האישי לפני כל הערכה. התאמת כינוי גוברת על ניחוש. serving_grams מהמילון היא הכמות כשלא צוינה כמות. יש ערכים ל-100 גרם? השתמש בהם, source_type="personal_food".
3א. ערך מסומן "⚠️חסרים ערכים" — הכמות ידועה אך הקלוריות לא. כשאתה רושם אותו והמשתמש נותן מידע חדש (תמונת תווית, שם מוצר מדויק, ערכים מפורשים) — קרא גם ל-remember_food עם הערכים ל-100 גרם, כדי שבפעם הבאה זה יהיה מדידה ולא ניחוש. אל תמציא ערכים רק כדי למלא את השדה.
4. החמרה מכוונת: כשאתה מעריך בלי תווית ובלי מילון — בחר את הקצה הגבוה של טווח הקלוריות הסביר. העדפה מפורשת של המשתמש.
5. תיקון ("היה 90 גרם", "בעצם בלי הגבינה") מכוון לארוחה האחרונה אלא אם צוין אחרת — update_meal, חשב מחדש פרופורציונלית.
5א. קריטי ב-update_meal: פריטים שלא השתנו מועתקים מילה-במילה מה-items שבהקשר (כולל calories, grams, source_type) — לעולם אל תעריך מחדש פריט קיים. שנה רק את מה שהמשתמש ביקש או הוסף חדש.
6. source_type לכל פריט: personal_food (מהמילון) / label (המשתמש ציין ערכים מפורשים מתווית) / ai_estimate. quantity_source: user_explicit / default / estimated. לכל פריט צרף emoji אחד מתאים בשדה emoji.
7. ציין ב-assumptions כל הנחה מהותית, בקצרה ובעברית.
8. אחרי קריאת כלי מוצלחת — ברירת המחדל היא לענות בטקסט ריק: הקוד כבר מציג למשתמש אישור מלא. הוסף משפט קצר רק כשיש מידע שהאישור לא מראה (אזהרה, משהו חריג, הערה חשובה). לעולם אל תסכם את מה שנרשם.
9. מוצר ישראלי מוכר — השתמש בערכים האופייניים שלו. confidence: high רק כשהערכים ממקור מדויק.
10. בקשה מפורשת לזכור ("זכור ש...", "תזכור", "מעכשיו X זה Y גרם") — remember_food. אם הכינוי כבר קיים במילון, השדות החדשים מתמזגים עם הקיימים.
11. למידה אוטומטית מתיקונים: כשהמשתמש מתקן כמות או מזהה מוצר של מאכל שסביר שיחזור (מוצר ארוז, מאכל ביתי קבוע, כינוי שהוא משתמש בו) — בנוסף ל-update_meal קרא גם ל-remember_food עם מה שנלמד. אל תלמד מנות חד-פעמיות (מנת מסעדה, צירוף מקרי). כשלמדת — אמור זאת במשפט הסיכום הקצר.
12. מדידות ("נשקלתי 95.8", "מותן 105 צוואר 41") — log_measurement עם השדות שנאמרו בלבד, ברירת מחדל היום. לעולם אל תעריך אחוז שומן בעצמך — הקוד מחשב לפי נוסחת הצי האמריקאי.
13. שאלות על היסטוריה (אתמול, השבוע, ממוצעים, מגמות) — קרא query_log עם טווח התאריכים המתאים וענה על סמך התוצאה. אל תנחש מספרים.
13א. מנת מסעדה/רשת או מוצר ממותג שאינו במילון ואתה לא בטוח בערכיו — חפש ב-web_search את הערכים הרשמיים (למשל "McDonald's nuggets nutrition") לפני הרישום. ציין ב-assumptions שהערכים מהאתר הרשמי. אם לא נמצא — הערכה מחמירה כרגיל. אל תחפש עבור מאכלים בסיסיים או מה שבמילון.
14. תמונות — סדר עדיפות: (א) יש טבלת ערכים תזונתיים? קרא את המספרים ישירות ממנה; שים לב אם הם ל-100 גרם או למנה וחשב לפי מה שנאכל. source_type="label", confidence="high". (ב) מוצר ארוז מזוהה בלי טבלה קריאה — ערכים אופייניים של המוצר, confidence="medium". (ג) צלחת אוכל — זהה פריטים, הערך גרמים לפי מה שנראה, החמר בקלוריות, source_type="ai_estimate", confidence="low". ציין ב-assumptions באיזו דרך זיהית (טבלה / מוצר / הערכת צלחת). כיתוב שצירף המשתמש לתמונה הוא רמז מחייב. אין אוכל בתמונה? ענה בטקסט, אל תרשום.

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
    emoji: { type: 'string', description: 'אימוג׳י אחד שמייצג את הפריט, למשל 🍗' },
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
  {
    name: 'delete_meal',
    description: 'מחיקת ארוחה שלמה מהיומן. השתמש כשהמשתמש מבקש למחוק/להסיר רישום קיים.',
    input_schema: {
      type: 'object',
      properties: {
        meal_id: { type: 'string', description: 'id של הארוחה מרשימת הארוחות של היום' },
      },
      required: ['meal_id'],
    },
  },
  {
    name: 'log_measurement',
    description: 'רישום מדידת גוף. שלח רק שדות שנמדדו — קיימים באותו תאריך מתמזגים. אחוז שומן מחושב בקוד, לא על ידך.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, ברירת מחדל היום' },
        weight_kg: { type: 'number' },
        waist_cm: { type: 'number' },
        neck_cm: { type: 'number' },
        steps_avg: { type: 'number', description: 'ממוצע צעדים יומי' },
        notes: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'set_goals',
    description: 'עדכון היעדים היומיים. שלח רק את השדות שהמשתמש ביקש לשנות — השאר נשמרים.',
    input_schema: {
      type: 'object',
      properties: {
        calories: { type: 'number' },
        protein: { type: 'number' },
        carbs: { type: 'number' },
        fat: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'query_log',
    description: 'סיכומים יומיים היסטוריים (קלוריות ומאקרו לכל יום בטווח). לשאלות על העבר.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD (כולל)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  // Anthropic server-side web search — runs on their servers, results come
  // back inside the same response. Used for restaurant/chain nutrition lookups.
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  {
    name: 'remember_food',
    description: 'שמירה או עדכון של מאכל במילון האישי (my_foods). שלח רק שדות שנאמרו או ידועים בוודאות — שדות שלא נשלחו נשמרים כמו שהם אם הכינוי כבר קיים.',
    input_schema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'הכינוי שהמשתמש משתמש בו, למשל "לחמניה"' },
        product: { type: 'string', description: 'שם המוצר המלא, למשל "קוטג\' תנובה 5%"' },
        serving_grams: { type: 'number', description: 'גרמים במנה סטנדרטית אחת' },
        kcal_per_100g: { type: 'number' },
        protein_per_100g: { type: 'number' },
        carbs_per_100g: { type: 'number' },
        fat_per_100g: { type: 'number' },
        variants: {
          type: 'object',
          description: 'מיפוי וריאציה→גרמים, למשל {"חצי": 125, "שלם": 250}',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['alias'],
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
  // Guard against a ghost meal: an empty item list would store a 0-kcal row
  // that shows up in history and skews the accuracy split.
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: 'items is empty — nothing to log' };
  }
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
  // An empty replacement list would silently blank the meal — that's a delete,
  // and deletes must go through delete_meal so undo can restore the whole row.
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: 'items is empty — use delete_meal to remove a meal' };
  }
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

async function execDeleteMeal(chatId, input) {
  const { data: meal, error: e1 } = await sb
    .from('meals').select('*').eq('id', input.meal_id).eq('chat_id', chatId).maybeSingle();
  if (e1) throw e1;
  if (!meal) return { ok: false, error: 'meal not found' };

  const { error: e2 } = await sb
    .from('meals').delete().eq('id', meal.id).eq('chat_id', chatId);
  if (e2) throw e2;

  // Full row goes into the journal so undo can re-insert it as-is.
  const actionId = await recordAction(chatId, 'delete_meal', { meal });
  return {
    ok: true, kind: 'delete_meal', mealId: meal.id, actionId,
    items: meal.items, totals: meal.totals, assumptions: '',
    confidence: meal.confidence, dayKeyUsed: meal.day_key,
  };
}

const FOOD_FIELDS = ['product', 'serving_grams', 'kcal_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'variants'];

async function execRememberFood(chatId, input) {
  const alias = (input.alias || '').trim();
  if (!alias) return { ok: false, error: 'empty alias' };

  const { data: prev, error: e1 } = await sb
    .from('my_foods').select('*').eq('chat_id', chatId).eq('alias', alias).maybeSingle();
  if (e1) throw e1;

  // Only the fields the model actually sent — merge semantics on conflict.
  const row = { chat_id: chatId, alias, updated_at: new Date().toISOString() };
  for (const f of FOOD_FIELDS) if (input[f] !== undefined) row[f] = input[f];

  const { error: e2 } = await sb
    .from('my_foods').upsert(row, { onConflict: 'chat_id,alias' });
  if (e2) throw e2;

  const actionId = await recordAction(chatId, 'remember_food', { alias, prev: prev || null });
  const merged = { ...(prev || {}), ...row };
  return { ok: true, kind: 'remember_food', actionId, alias, saved: merged, isNew: !prev };
}

/* ---------------- measurements ---------------- */

const HEIGHT_CM = Number(process.env.AGENT_HEIGHT_CM || 172);
const MEAS_FIELDS = ['weight_kg', 'waist_cm', 'neck_cm', 'steps_avg', 'notes'];

/* US Navy body-fat formula (male, cm). Computed in code — never estimated. */
export function navyBodyFat(waist, neck, height = HEIGHT_CM) {
  if (!waist || !neck || waist <= neck) return null;
  const bf = 495 / (1.0324 - 0.19077 * Math.log10(waist - neck) + 0.15456 * Math.log10(height)) - 450;
  return Math.round(bf * 10) / 10;
}

async function execLogMeasurement(chatId, input) {
  const date = input.date || dayKey();

  const [{ data: prev, error: e1 }, { data: history, error: e2 }] = await Promise.all([
    sb.from('measurements').select('*').eq('chat_id', chatId).eq('measured_on', date).maybeSingle(),
    sb.from('measurements').select('*').eq('chat_id', chatId).lt('measured_on', date)
      .order('measured_on', { ascending: false }).limit(10),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const row = { chat_id: chatId, measured_on: date };
  let hasField = false;
  for (const f of MEAS_FIELDS) if (input[f] !== undefined) { row[f] = input[f]; hasField = true; }
  if (!hasField) return { ok: false, error: 'no measurement fields given' };

  const { error: e3 } = await sb
    .from('measurements').upsert(row, { onConflict: 'chat_id,measured_on' });
  if (e3) throw e3;

  const merged = { ...(prev || {}), ...row };
  const lastWith = (f) => (history || []).find((h) => h[f] != null);
  const neckForNavy = merged.neck_cm ?? lastWith('neck_cm')?.neck_cm;
  const navyPct = navyBodyFat(merged.waist_cm, neckForNavy);

  const deltas = {};
  for (const f of ['weight_kg', 'waist_cm']) {
    const prevRow = lastWith(f);
    if (merged[f] != null && prevRow) {
      deltas[f] = { diff: Math.round((merged[f] - prevRow[f]) * 10) / 10, since: prevRow.measured_on };
    }
  }

  const actionId = await recordAction(chatId, 'log_measurement', { measured_on: date, prev: prev || null });
  return {
    ok: true, kind: 'log_measurement', actionId, measuredOn: date,
    saved: merged, navyPct, deltas, isNew: !prev,
  };
}

/* ---------------- goals ---------------- */

const GOAL_FIELDS = ['calories', 'protein', 'carbs', 'fat'];
const DEFAULT_GOALS = { calories: 2000, protein: 130, carbs: 200, fat: 65 };

async function execSetGoals(chatId, input) {
  const patch = {};
  for (const f of GOAL_FIELDS) if (input[f] !== undefined) patch[f] = input[f];
  if (!Object.keys(patch).length) return { ok: false, error: 'no goal fields given' };
  if (Object.values(patch).some((v) => !(v > 0))) return { ok: false, error: 'goals must be positive' };

  const { data: prev, error: e1 } = await sb
    .from('goals').select('*').eq('chat_id', chatId).maybeSingle();
  if (e1) throw e1;

  const merged = { ...DEFAULT_GOALS, ...(prev || {}), ...patch, chat_id: chatId, updated_at: new Date().toISOString() };
  const { error: e2 } = await sb.from('goals').upsert(merged, { onConflict: 'chat_id' });
  if (e2) throw e2;

  const actionId = await recordAction(chatId, 'set_goals', { prev: prev || null });
  const changed = Object.keys(patch);
  return { ok: true, kind: 'set_goals', actionId, goals: merged, changed };
}

/* ---------------- history queries (read-only by construction) ---------------- */

async function execQueryLog(chatId, input) {
  const start = input.start_date, end = input.end_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    return { ok: false, error: 'bad date format, use YYYY-MM-DD' };
  }
  const { data, error } = await sb
    .from('meals').select('day_key, totals')
    .eq('chat_id', chatId).gte('day_key', start).lte('day_key', end)
    .order('day_key', { ascending: true }).limit(2000);
  if (error) throw error;

  const byDay = new Map();
  for (const r of data || []) {
    const d = byDay.get(r.day_key) || { calories: 0, protein: 0, carbs: 0, fat: 0, meals: 0 };
    for (const k of ['calories', 'protein', 'carbs', 'fat']) d[k] += Number(r.totals?.[k]) || 0;
    d.meals++;
    byDay.set(r.day_key, d);
  }
  const days = [...byDay.entries()].map(([day, v]) => ({
    day,
    calories: Math.round(v.calories), protein: Math.round(v.protein),
    carbs: Math.round(v.carbs), fat: Math.round(v.fat), meals: v.meals,
  }));
  return { ok: true, kind: 'query_log', days };
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
  } else if (action.kind === 'delete_meal') {
    const { error } = await sb.from('meals').insert(action.payload.meal);
    if (error && error.code !== '23505') throw error; // 23505: already restored
  } else if (action.kind === 'remember_food') {
    const { alias, prev } = action.payload;
    if (prev) {
      const restore = {};
      for (const f of FOOD_FIELDS) restore[f] = prev[f];
      restore.updated_at = prev.updated_at;
      await sb.from('my_foods').update(restore).eq('chat_id', chatId).eq('alias', alias);
    } else {
      await sb.from('my_foods').delete().eq('chat_id', chatId).eq('alias', alias);
    }
  } else if (action.kind === 'set_goals') {
    const { prev } = action.payload;
    if (prev) await sb.from('goals').upsert(prev, { onConflict: 'chat_id' });
    else await sb.from('goals').delete().eq('chat_id', chatId);
  } else if (action.kind === 'log_measurement') {
    const { measured_on, prev } = action.payload;
    if (prev) {
      const restore = {};
      for (const f of MEAS_FIELDS) restore[f] = prev[f];
      await sb.from('measurements').update(restore).eq('chat_id', chatId).eq('measured_on', measured_on);
    } else {
      await sb.from('measurements').delete().eq('chat_id', chatId).eq('measured_on', measured_on);
    }
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
   userContent: a plain string (text message) or an array of content blocks
   (photo: image block + text hint). rawText is what gets stored as the
   meal's raw_text — for photos, the caption or a placeholder.
   Returns { actions: [execution results], text: final model text }. */
export async function runAgent(chatId, userContent, ctx, rawText) {
  const started = Date.now();
  const system = buildSystem(ctx);

  // Recent conversation as real turns, so clarifying questions keep their context.
  // The API needs alternating roles starting with "user" — coalesce and trim.
  const history = [];
  for (const h of ctx.history || []) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (!history.length && role === 'assistant') continue; // must start with user
    const last = history[history.length - 1];
    if (last && last.role === role) last.content += `\n${h.content}`;
    else history.push({ role, content: h.content });
  }
  if (history.length && history[history.length - 1].role === 'user') {
    // fold a dangling user turn into the current message flow instead
    history[history.length - 1].content += '\n(לא נענה)';
    history.push({ role: 'assistant', content: '(אין תשובה שמורה)' });
  }

  const messages = [...history, { role: 'user', content: userContent }];
  const mealText = rawText || (typeof userContent === 'string' ? userContent : '📷 תמונה');
  const actions = [];
  let finalText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > DEADLINE_MS) break;
    const resp = await callClaude(system, messages);

    const textBlocks = (resp.content || []).filter((b) => b.type === 'text');
    finalText = textBlocks.map((b) => b.text).join('\n').trim();

    // Server-side tool (web search) hit its iteration limit mid-turn —
    // append the partial assistant turn and let it continue.
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content });
      continue;
    }

    if (resp.stop_reason !== 'tool_use') break;

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: resp.content });

    const results = [];
    for (const tu of toolUses) {
      let result;
      try {
        if (tu.name === 'log_meal') result = await execLogMeal(chatId, mealText, tu.input);
        else if (tu.name === 'update_meal') result = await execUpdateMeal(chatId, tu.input);
        else if (tu.name === 'delete_meal') result = await execDeleteMeal(chatId, tu.input);
        else if (tu.name === 'remember_food') result = await execRememberFood(chatId, tu.input);
        else if (tu.name === 'log_measurement') result = await execLogMeasurement(chatId, tu.input);
        else if (tu.name === 'set_goals') result = await execSetGoals(chatId, tu.input);
        else if (tu.name === 'query_log') result = await execQueryLog(chatId, tu.input);
        else result = { ok: false, error: `unknown tool ${tu.name}` };
      } catch (err) {
        console.error('tool exec error:', tu.name, err);
        result = { ok: false, error: String(err.message || err) };
      }
      // query_log is read-only — feeds the model, no undo/confirmation block.
      if (result.ok && result.kind !== 'query_log') actions.push(result);

      let resultContent;
      if (!result.ok) resultContent = { ok: false, error: result.error };
      else if (result.kind === 'remember_food') resultContent = { ok: true, alias: result.alias, is_new: result.isNew };
      else if (result.kind === 'log_measurement') resultContent = { ok: true, measured_on: result.measuredOn, saved: result.saved, navy_body_fat_pct: result.navyPct, deltas: result.deltas };
      else if (result.kind === 'set_goals') resultContent = { ok: true, goals: result.goals };
      else if (result.kind === 'query_log') resultContent = { ok: true, days: result.days };
      else resultContent = { ok: true, meal_id: result.mealId, totals: result.totals };

      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(resultContent),
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
