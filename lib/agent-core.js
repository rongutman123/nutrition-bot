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
      if (src === 'personal_food' || src === 'label' || src === 'israeli_db') measured += cal;
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
  const [foods, meals, goalsRow, chatLog, savedMeals, recipes] = await Promise.all([
    sb.from('my_foods').select('*').eq('chat_id', chatId).order('alias'),
    sb.from('meals').select('id, ts, raw_text, items, totals, confidence')
      .eq('chat_id', chatId).eq('day_key', dayKey()).order('ts', { ascending: true }),
    sb.from('goals').select('*').eq('chat_id', chatId).maybeSingle(),
    // Ordered by id, not created_at: two turns written in the same millisecond
    // tie on the timestamp and can come back in the wrong order.
    sb.from('agent_chat_log').select('id, role, content')
      .eq('chat_id', chatId).gte('created_at', since)
      .order('id', { ascending: false }).limit(10),
    sb.from('saved_meals').select('name, category, totals').eq('chat_id', chatId).order('use_count', { ascending: false }).limit(30),
    sb.from('recipes').select('name, servings, total_grams, totals').eq('chat_id', chatId).order('name').limit(30),
  ]);
  if (foods.error) throw foods.error;
  if (meals.error) throw meals.error;
  return {
    foods: foods.data || [],
    todayMeals: meals.data || [],
    goals: goalsRow.data || { calories: 2000, protein: 130, carbs: 200, fat: 65 },
    history: (chatLog.data || []).reverse(), // oldest → newest
    savedMeals: savedMeals.data || [],
    recipes: recipes.data || [],
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

function savedBlock(ctx) {
  const lines = [];
  for (const m of ctx.savedMeals || []) {
    lines.push(`- ארוחה "${m.name}"${m.category ? ` (${m.category})` : ''} · ${Math.round(m.totals?.calories || 0)} קק"ל`);
  }
  for (const r of ctx.recipes || []) {
    const bits = [`- מתכון "${r.name}"`, `סה"כ ${Math.round(r.totals?.calories || 0)} קק"ל`];
    if (r.servings) bits.push(`${r.servings} מנות`);
    if (r.total_grams) bits.push(`${r.total_grams} גרם`);
    lines.push(bits.join(' · '));
  }
  return lines.length ? lines.join(String.fromCharCode(10)) : '(אין עדיין ארוחות או מתכונים שמורים)';
}

function buildSystem(ctx) {
  return `אתה סוכן יומן התזונה האישי של המשתמש בטלגרם (משתמש יחיד). כל הודעה היא אחת מאלה: רישום אוכל, תיקון/הוספה לרישום קיים, שאלה, או שיחה. החלט ופעל.

הכלים שלך:
- log_meal — רישום ארוחה חדשה. תומך ברישום לאחור (date / meal_time).
- update_meal — תיקון או הוספת פריטים לארוחה קיימת. שולחים את הפירוק המלא אחרי השינוי.
- remember_food — שמירה או עדכון של מאכל במילון האישי. שלח רק שדות שידועים.
- delete_meal — מחיקת ארוחה שלמה מהיומן ("תמחק את הקוטג'"). ניתנת לשחזור בכפתור ביטול.
- log_measurement — רישום מדידת גוף (משקל/מותן/צוואר/צעדים). אחוז שומן מחושב בקוד.
- lookup_barcode — זיהוי מוצר לפי ברקוד (מילון אישי ← Open Food Facts).
- lookup_israeli_food — חיפוש במאגר התזונה הלאומי של משרד הבריאות (צמרת): ערכים ל-100 גרם + מידות ביתיות (כף/כוס/גביע → גרמים).
- set_goals — שינוי היעדים היומיים ("תעדכן יעד חלבון ל-150"). שלח רק את מה שמשתנה.
- save_recipe — שמירת מתכון (רכיבים + משקל סופי). מחשב מאקרו למנה ול-100 גרם.
- save_meal — שמירת ארוחה חוזרת בשם ("השייק שלי") כדי לרשום אותה שוב בלחיצה.
- log_saved — רישום מתכון או ארוחה שמורה שכבר קיימים, לפי שם.
- query_log — נתונים היסטוריים מעבר להיום (סיכומים יומיים בטווח תאריכים). קרא אותו לפני שאתה עונה על שאלות היסטוריה.

חוקים מחייבים:
1. שאלות עונים בטקסט, לא רושמים. אם לא ברור אם זה רישום או שאלה — שאל, אל תכתוב.
2. קיבוץ ארוחות: אם עברו פחות מ-15 דקות מהארוחה האחרונה והמשתמש שולח עוד אוכל — זו אותה ארוחה: update_meal עם כל הפריטים (הקיימים + החדשים), אלא אם אמר שזו ארוחה נפרדת.
3. מילון קודם להערכה: בדוק את המילון האישי לפני כל הערכה. התאמת כינוי גוברת על ניחוש. serving_grams מהמילון היא הכמות כשלא צוינה כמות. יש ערכים ל-100 גרם? השתמש בהם, source_type="personal_food".
3א. ערך מסומן "⚠️חסרים ערכים" — הכמות ידועה אך הקלוריות לא. כשאתה רושם אותו והמשתמש נותן מידע חדש (תמונת תווית, שם מוצר מדויק, ערכים מפורשים) — קרא גם ל-remember_food עם הערכים ל-100 גרם, כדי שבפעם הבאה זה יהיה מדידה ולא ניחוש. אל תמציא ערכים רק כדי למלא את השדה.
3ב. סדר פתרון מזון — אל תדלג ואל תהפוך: (1) המילון האישי, (2) ברקוד/תווית, (3) lookup_israeli_food — מאגר משרד הבריאות, (4) מוצר ממותג מוכר או חיפוש רשת למנת מסעדה, (5) הערכה שלך — רק כמוצא אחרון. מאכל ישראלי או ביתי גנרי (פלאפל, חומוס, שקשוקה, סלט, לחמניה, גבינה) — חפש במאגר לפני שאתה מעריך.
3ג. מידות ביתיות: כשהמאגר מחזיר measures (כף/כוס/גביע/יחידה במשקל) והמשתמש נקב במידה כזו — השתמש במשקל מהמאגר, quantity_source="user_explicit". זה מדויק בהרבה מניחוש.
3ד. פריט שהגיע ממאגר משרד הבריאות — source_type="israeli_db". החיפוש מחזיר כמה תוצאות; בחר את המתאימה ביותר לפי השם, ואם אף אחת לא מתאימה אל תכריח — עבור לשלב הבא.
4. החמרה מכוונת: כשאתה מעריך בלי תווית, בלי מילון ובלי מאגר — בחר את הקצה הגבוה של טווח הקלוריות הסביר. העדפה מפורשת של המשתמש.
5. תיקון ("היה 90 גרם", "בעצם בלי הגבינה") מכוון לארוחה האחרונה אלא אם צוין אחרת — update_meal, חשב מחדש פרופורציונלית.
5א. קריטי ב-update_meal: פריטים שלא השתנו מועתקים מילה-במילה מה-items שבהקשר (כולל calories, grams, source_type) — לעולם אל תעריך מחדש פריט קיים. שנה רק את מה שהמשתמש ביקש או הוסף חדש.
6. source_type לכל פריט: personal_food (מהמילון) / label (תווית או ברקוד) / israeli_db (מאגר משרד הבריאות) / ai_estimate. quantity_source: user_explicit / default / estimated. לכל פריט צרף emoji אחד מתאים בשדה emoji.
7. ציין ב-assumptions כל הנחה מהותית, בקצרה ובעברית.
8. אורך התשובה: **אם ביצעת פעולת כתיבה** (log_meal/update_meal/delete_meal/remember_food/save_*/log_measurement/set_goals) — הקוד כבר מציג אישור מלא, אז אל תסכם אותו; ענה טקסט ריק, או משפט קצר אחד רק אם יש מידע שהאישור לא מראה.
8א. **אם לא ביצעת פעולת כתיבה — אתה חייב לענות בטקסט.** שאלה, בקשת הבהרה, סירוב, או כל מצב אחר: תמיד תשובה מילולית בעברית. לעולם אל תחזיר תשובה ריקה בלי שביצעת כתיבה.
8ב. **עיצוב כל תשובה — חוק על, חל על כל דבר שאתה כותב:** המשתמש קולט ויזואלית ומתקשה בקירות טקסט. לכן:
   • רעיון אחד בשורה. לעולם לא שורה אחת ארוכה עם יותר מ-3 פריטים מופרדים בנקודות.
   • המספר שמניע החלטה בא ראשון ובהדגשה: <b>1,145</b>.
   • רשימה = שורה לכל פריט, עם אימוג׳י מתאים בתחילתה.
   • שורה ריקה בין קבוצות רעיונות.
   • פירוט משני, הסתייגויות והנחות — בתוך <blockquote expandable>...</blockquote> ולא בגוף התשובה.
   • מותר לך רק: <b> <i> <u> <s> <code> <blockquote expandable>. בלי markdown, בלי כוכביות, בלי מקפים בתחילת שורה.
   • אימוג׳ים בשימוש קבוע: 🔥 קלוריות · 🥩 חלבון · 🍚 פחמימות · 🧈 שומן · ⚡ נותרו · 🔺 חריגה · ⚖️ משקל · 🎯 מדויק · 〰️ הערכה.
   דוגמה טובה לתשובה על שאלה:
   🔥 <b>1,145</b> קק"ל היום
   ⚡ נותרו <b>955</b>

   🥩 חלבון <b>72</b> מתוך 140
   🍚 פחמימות <b>101</b> מתוך 200
   🧈 שומן <b>49</b> מתוך 100
9. מוצר ישראלי מוכר — השתמש בערכים האופייניים שלו. confidence: high רק כשהערכים ממקור מדויק.
10. בקשה מפורשת לזכור ("זכור ש...", "תזכור", "מעכשיו X זה Y גרם") — remember_food. אם הכינוי כבר קיים במילון, השדות החדשים מתמזגים עם הקיימים.
11. למידה אוטומטית מתיקונים: כשהמשתמש מתקן כמות או מזהה מוצר של מאכל שסביר שיחזור (מוצר ארוז, מאכל ביתי קבוע, כינוי שהוא משתמש בו) — בנוסף ל-update_meal קרא גם ל-remember_food עם מה שנלמד. אל תלמד מנות חד-פעמיות (מנת מסעדה, צירוף מקרי). כשלמדת — אמור זאת במשפט הסיכום הקצר.
12. מדידות ("נשקלתי 95.8", "מותן 105 צוואר 41") — log_measurement עם השדות שנאמרו בלבד, ברירת מחדל היום. לעולם אל תעריך אחוז שומן בעצמך — הקוד מחשב לפי נוסחת הצי האמריקאי.
13. שאלות על היסטוריה (אתמול, השבוע, ממוצעים, מגמות) — קרא query_log עם טווח התאריכים המתאים וענה על סמך התוצאה. אל תנחש מספרים.
13א. מנת מסעדה/רשת או מוצר ממותג שאינו במילון ואתה לא בטוח בערכיו — חפש ב-web_search את הערכים הרשמיים (למשל "McDonald's nuggets nutrition") לפני הרישום. ציין ב-assumptions שהערכים מהאתר הרשמי. אם לא נמצא — הערכה מחמירה כרגיל. אל תחפש עבור מאכלים בסיסיים או מה שבמילון.
14. ברקוד בתמונה: קרא את הספרות וקרא ל-lookup_barcode. נמצא — השתמש בערכים (source_type="label") ושאל כמה נאכל אם לא ברור. לא נמצא — הסבר בקצרה ובקש תמונה של טבלת הערכים; כשתקבל אותה, קרא ל-remember_food עם הערכים **וגם עם הברקוד**, ואז רשום. ככה כל מוצר נשאל פעם אחת בלבד.
16. מתכון (טקסט או תמונה של מתכון): אסוף רכיבים וכמויות, חשב מאקרו לכל רכיב, וקרא ל-save_recipe עם המשקל הסופי (total_grams) ומספר המנות אם ידוע. אם המשתמש גם אכל מזה עכשיו — רשום בנפרד עם log_saved או log_meal.
17. ארוחה חוזרת: אם המשתמש מבקש "תשמור את זה בשם X" — save_meal עם הפריטים של הארוחה האחרונה. אם הוא כותב שם של ארוחה/מתכון שמור — log_saved.
18. תמונות אוכל — סדר עדיפות: (א) יש טבלת ערכים תזונתיים? קרא את המספרים ישירות ממנה; שים לב אם הם ל-100 גרם או למנה וחשב לפי מה שנאכל. source_type="label", confidence="high". (ב) מוצר ארוז מזוהה בלי טבלה קריאה — ערכים אופייניים של המוצר, confidence="medium". (ג) צלחת אוכל — זהה פריטים, הערך גרמים לפי מה שנראה, החמר בקלוריות, source_type="ai_estimate", confidence="low". ציין ב-assumptions באיזו דרך זיהית (טבלה / מוצר / הערכת צלחת). כיתוב שצירף המשתמש לתמונה הוא רמז מחייב. אין אוכל בתמונה? ענה בטקסט, אל תרשום.

--- המילון האישי (my_foods) ---
${foodsBlock(ctx.foods)}

--- ארוחות ומתכונים שמורים ---
${savedBlock(ctx)}

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
    source_type: { type: 'string', enum: ['personal_food', 'label', 'israeli_db', 'ai_estimate'] },
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
    name: 'lookup_barcode',
    description: 'חיפוש מוצר לפי ברקוד — קודם במילון האישי, אחר כך במאגר Open Food Facts. מוצרים ישראליים רבים אינם במאגר; אז מבקשים תמונת תווית פעם אחת.',
    input_schema: {
      type: 'object',
      properties: { barcode: { type: 'string', description: 'ספרות הברקוד כפי שנקראו מהתמונה' } },
      required: ['barcode'],
    },
  },
  {
    name: 'lookup_israeli_food',
    description: 'חיפוש במאגר התזונה הלאומי הישראלי (משרד הבריאות). מחזיר ערכים ל-100 גרם ומידות ביתיות במשקל. השתמש למאכלים ישראליים/גנריים שאינם במילון האישי, לפני שאתה מעריך לבד.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'שם המאכל בעברית, למשל: פלאפל, גבינת קוטג׳, לחמניה' },
        limit: { type: 'number', description: 'כמה תוצאות, ברירת מחדל 5' },
      },
      required: ['query'],
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
    name: 'save_recipe',
    description: 'שמירת מתכון: רכיבים עם מאקרו, משקל סופי ומספר מנות. החישוב למנה נעשה בקוד.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        ingredients: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' }, grams: { type: 'number' },
              calories: { type: 'number' }, protein: { type: 'number' },
              carbs: { type: 'number' }, fat: { type: 'number' },
              fiber: { type: 'number' }, sugar: { type: 'number' }, sodium_mg: { type: 'number' },
            },
            required: ['name', 'calories', 'protein', 'carbs', 'fat'],
          },
        },
        total_grams: { type: 'number', description: 'משקל התבשיל המוכן, אם ידוע' },
        servings: { type: 'number', description: 'כמה מנות יוצאות' },
        notes: { type: 'string' },
      },
      required: ['name', 'ingredients'],
    },
  },
  {
    name: 'save_meal',
    description: 'שמירת ארוחה חוזרת בשם, לרישום מהיר בעתיד.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', description: 'קטגוריה חופשית, למשל "ארוחת בוקר"' },
        items: { type: 'array', items: ITEM_SCHEMA, minItems: 1 },
      },
      required: ['name', 'items'],
    },
  },
  {
    name: 'log_saved',
    description: 'רישום ארוחה שמורה או מנה ממתכון שמור, לפי שם. portion=1 היא מנה אחת.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'שם הארוחה השמורה או המתכון' },
        portions: { type: 'number', description: 'כמה מנות נאכלו, ברירת מחדל 1' },
        grams: { type: 'number', description: 'למתכון: כמה גרם נאכלו, במקום מנות' },
      },
      required: ['name'],
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
        barcode: { type: 'string', description: 'ברקוד המוצר, אם ידוע — כדי שסריקה הבאה תזוהה מיד' },
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

const FOOD_FIELDS = ['product', 'barcode', 'serving_grams', 'kcal_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'variants'];

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

/* ---------------- recipes & saved meals ----------------
   Both store a macro snapshot. Recipes additionally carry a finished weight so
   "I ate 250g of the casserole" is arithmetic, not another estimate. */

const scaleItem = (it, factor) => {
  const out = { ...it };
  for (const k of ['grams', 'calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium_mg']) {
    if (out[k] != null) out[k] = Math.round(Number(out[k]) * factor * 10) / 10;
  }
  return out;
};

async function execSaveRecipe(chatId, input) {
  if (!Array.isArray(input.ingredients) || !input.ingredients.length) {
    return { ok: false, error: 'ingredients is empty' };
  }
  const name = (input.name || '').trim();
  if (!name) return { ok: false, error: 'name is required' };

  const totals = sumItems(input.ingredients);
  const rawGrams = input.ingredients.reduce((s, i) => s + (Number(i.grams) || 0), 0);
  const totalGrams = Number(input.total_grams) || rawGrams || null;

  const { data: prev, error: e1 } = await sb
    .from('recipes').select('*').eq('chat_id', chatId).eq('name', name).maybeSingle();
  if (e1) throw e1;

  const row = {
    chat_id: chatId, name,
    ingredients: input.ingredients, totals,
    total_grams: totalGrams,
    servings: Number(input.servings) || null,
    notes: input.notes || null,
    updated_at: new Date().toISOString(),
  };
  const { error: e2 } = await sb.from('recipes').upsert(row, { onConflict: 'chat_id,name' });
  if (e2) throw e2;

  const actionId = await recordAction(chatId, 'save_recipe', { name, prev: prev || null });
  const perServing = row.servings ? scaleItem(totals, 1 / row.servings) : null;
  const per100g = totalGrams ? scaleItem(totals, 100 / totalGrams) : null;
  return {
    ok: true, kind: 'save_recipe', actionId, name, isNew: !prev,
    totals, totalGrams, servings: row.servings, perServing, per100g,
    ingredientCount: input.ingredients.length,
  };
}

async function execSaveMeal(chatId, input) {
  if (!Array.isArray(input.items) || !input.items.length) return { ok: false, error: 'items is empty' };
  const name = (input.name || '').trim();
  if (!name) return { ok: false, error: 'name is required' };

  const { data: prev, error: e1 } = await sb
    .from('saved_meals').select('*').eq('chat_id', chatId).eq('name', name).maybeSingle();
  if (e1) throw e1;

  const totals = sumItems(input.items);
  const row = {
    chat_id: chatId, name, category: input.category || null,
    items: input.items, totals,
    use_count: prev?.use_count || 0,
    last_used: prev?.last_used || null,
    updated_at: new Date().toISOString(),
  };
  const { error: e2 } = await sb.from('saved_meals').upsert(row, { onConflict: 'chat_id,name' });
  if (e2) throw e2;

  const actionId = await recordAction(chatId, 'save_meal', { name, prev: prev || null });
  return { ok: true, kind: 'save_meal', actionId, name, isNew: !prev, items: input.items, totals };
}

/* Logs a saved meal or a portion of a recipe. Scaling happens here, in code. */
async function execLogSaved(chatId, rawText, input) {
  const name = (input.name || '').trim();
  const [{ data: meal }, { data: recipe }] = await Promise.all([
    sb.from('saved_meals').select('*').eq('chat_id', chatId).eq('name', name).maybeSingle(),
    sb.from('recipes').select('*').eq('chat_id', chatId).eq('name', name).maybeSingle(),
  ]);
  if (!meal && !recipe) return { ok: false, error: `no saved meal or recipe named "${name}"` };

  let items, note;
  if (meal) {
    const portions = Number(input.portions) || 1;
    items = meal.items.map((i) => scaleItem(i, portions));
    note = portions === 1 ? `ארוחה שמורה: ${name}` : `${portions} מנות של ${name}`;
    await sb.from('saved_meals')
      .update({ use_count: (meal.use_count || 0) + 1, last_used: new Date().toISOString() })
      .eq('id', meal.id).eq('chat_id', chatId);
  } else {
    let factor;
    if (input.grams && recipe.total_grams) {
      factor = Number(input.grams) / Number(recipe.total_grams);
      note = `${input.grams} גרם מתוך ${recipe.name} (${recipe.total_grams} גרם סה"כ)`;
    } else {
      const portions = Number(input.portions) || 1;
      factor = recipe.servings ? portions / Number(recipe.servings) : portions;
      note = recipe.servings
        ? `${portions} מנות מתוך ${recipe.name} (${recipe.servings} מנות במתכון)`
        : `${recipe.name} — המתכון כולו`;
    }
    const scaled = scaleItem(recipe.totals, factor);
    items = [{
      name: recipe.name, emoji: '🥘',
      portion: input.grams ? `${input.grams} גרם` : `${Number(input.portions) || 1} מנות`,
      grams: input.grams || (recipe.total_grams ? Math.round(recipe.total_grams * factor) : null),
      calories: scaled.calories, protein: scaled.protein, carbs: scaled.carbs, fat: scaled.fat,
      fiber: scaled.fiber, sugar: scaled.sugar, sodium_mg: scaled.sodium_mg,
      source_type: 'personal_food', quantity_source: input.grams ? 'user_explicit' : 'default',
    }];
  }

  return execLogMeal(chatId, rawText, { items, confidence: 'high', assumptions: note });
}

/* ---------------- barcode lookup ----------------
   Personal dictionary first, then Open Food Facts. Israeli products have thin
   OFF coverage, so a miss is expected — the caller then asks for a label photo
   once and stores it against the barcode, making the next scan instant. */

async function execLookupBarcode(chatId, input) {
  const code = String(input.barcode || '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) return { ok: false, error: 'barcode must be 8-14 digits' };

  const { data: mine, error } = await sb
    .from('my_foods').select('*').eq('chat_id', chatId).eq('barcode', code).maybeSingle();
  if (error) throw error;
  if (mine) {
    return {
      ok: true, kind: 'lookup_barcode', found: true, source: 'personal', barcode: code,
      product: mine.product || mine.alias, alias: mine.alias,
      serving_grams: mine.serving_grams,
      per100g: {
        kcal: mine.kcal_per_100g, protein: mine.protein_per_100g,
        carbs: mine.carbs_per_100g, fat: mine.fat_per_100g,
      },
    };
  }

  let off = null;
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${code}` +
      '?fields=product_name,product_name_he,brands,quantity,serving_size,nutriments';
    const res = await fetch(url, {
      headers: { 'user-agent': 'RonNutritionAgent/1.0 (personal use)' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) off = await res.json();
  } catch (err) {
    console.error('open food facts error:', err.message);
    return { ok: true, kind: 'lookup_barcode', found: false, barcode: code, reason: 'lookup_failed' };
  }

  if (!off || off.status !== 1 || !off.product) {
    return { ok: true, kind: 'lookup_barcode', found: false, barcode: code, reason: 'not_in_database' };
  }

  const p = off.product;
  const nut = p.nutriments || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
  const per100g = {
    kcal: num(nut['energy-kcal_100g']),
    protein: num(nut.proteins_100g),
    carbs: num(nut.carbohydrates_100g),
    fat: num(nut.fat_100g),
    fiber: num(nut.fiber_100g),
    sugar: num(nut.sugars_100g),
    sodium_mg: nut.sodium_100g != null ? Math.round(Number(nut.sodium_100g) * 1000) : null,
  };
  if (per100g.kcal == null) {
    return { ok: true, kind: 'lookup_barcode', found: false, barcode: code, reason: 'no_nutrition_data' };
  }

  const name = [p.brands, p.product_name || p.product_name_he].filter(Boolean).join(' ');
  return {
    ok: true, kind: 'lookup_barcode', found: true, source: 'open_food_facts',
    barcode: code, product: name || `מוצר ${code}`,
    package_size: p.quantity || null, serving_size: p.serving_size || null,
    per100g,
  };
}

/* ---------------- Israeli national nutrition database (צמרת) ----------------
   Ministry of Health, via data.gov.il CKAN. Free, no key, Hebrew, and — the
   part that matters here — 19k household measures (כף / כוס / גביע → grams),
   which is where most of this user's manual corrections came from. */

const CKAN = 'https://data.gov.il/api/3/action/datastore_search';
const RES_FOODS = 'c3cb0630-0650-46c1-a068-82d575c094b2';   // foods, per 100g
const RES_MEASURES = '755d28c0-75f7-40e1-9c8c-ecdd106f9b2d'; // food Code -> unit code + grams
const RES_UNITS = '98fb46fe-e8de-4067-94d2-b0a8ea4269da';    // unit code -> Hebrew name

let unitNames = null; // cached per warm lambda
const RAW_UNITS = new Set(['גרמים', 'גרם', 'קילוגרם', 'ק"ג', 'קג', 'מיליליטר', 'מ"ל', 'ליטר']);

async function ckan(resourceId, params, ms = 6000) {
  const u = new URL(CKAN);
  u.searchParams.set('resource_id', resourceId);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, {
    headers: { 'user-agent': 'RonNutritionAgent/1.0' },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`ckan ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error('ckan returned success=false');
  return body.result;
}

async function getUnitNames() {
  if (unitNames) return unitNames;
  try {
    const r = await ckan(RES_UNITS, { limit: 300 });
    // Cache only a real answer: caching {} on a transient failure would leave
    // this warm instance showing "יחידה 300" instead of "כף" forever.
    const map = Object.fromEntries(r.records.map((x) => [String(x.smlmida), x.shmmida]));
    if (Object.keys(map).length) unitNames = map;
    return map;
  } catch {
    return {};
  }
}

/* Test seam: the unit-name cache is process-wide by design. */
export function __resetLookupCache() { unitNames = null; }

// Number(null) and Number('') are 0, not NaN — guard before coercing.
const numOrNull = (v) =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

async function execLookupIsraeliFood(chatId, input) {
  const query = String(input.query || '').trim();
  if (query.length < 2) return { ok: false, error: 'query too short' };
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 8);

  let found;
  try {
    found = await ckan(RES_FOODS, { q: query, limit });
  } catch (err) {
    console.error('tzameret search error:', err.message);
    return { ok: true, kind: 'lookup_israeli_food', found: false, reason: 'lookup_failed', query };
  }
  if (!found.records?.length) {
    return { ok: true, kind: 'lookup_israeli_food', found: false, reason: 'no_match', query };
  }

  const names = await getUnitNames();

  const results = await Promise.all(found.records.map(async (rec) => {
    let measures = [];
    try {
      const m = await ckan(RES_MEASURES, {
        filters: JSON.stringify({ mmitzrach: String(rec.Code) }), limit: 12,
      }, 5000);
      measures = (m.records || [])
        .map((x) => ({ unit: names[String(x.mida)] || `יחידה ${x.mida}`, grams: numOrNull(x.mishkal) }))
        // Keep only household measures — raw weight/volume units carry no information.
        .filter((x) => x.grams > 0 && !RAW_UNITS.has(x.unit.trim()));
    } catch { /* measures are a bonus, not a requirement */ }

    return {
      name: rec.shmmitzrach,
      code: rec.smlmitzrach,
      per100g: {
        kcal: numOrNull(rec.food_energy),
        protein: numOrNull(rec.protein),
        carbs: numOrNull(rec.carbohydrates),
        fat: numOrNull(rec.total_fat),
        fiber: numOrNull(rec.total_dietary_fiber),
        sodium_mg: numOrNull(rec.sodium),
      },
      measures,
    };
  }));

  return {
    ok: true, kind: 'lookup_israeli_food', found: true, query,
    total: found.total, results: results.filter((r) => r.per100g.kcal != null),
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
  } else if (action.kind === 'save_recipe') {
    const { name, prev } = action.payload;
    if (prev) await sb.from('recipes').upsert(prev, { onConflict: 'chat_id,name' });
    else await sb.from('recipes').delete().eq('chat_id', chatId).eq('name', name);
  } else if (action.kind === 'save_meal') {
    const { name, prev } = action.payload;
    if (prev) await sb.from('saved_meals').upsert(prev, { onConflict: 'chat_id,name' });
    else await sb.from('saved_meals').delete().eq('chat_id', chatId).eq('name', name);
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

async function callClaude(system, messages, { forceText = false } = {}) {
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
      ...(forceText ? { tool_choice: { type: 'none' } } : {}),
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
        else if (tu.name === 'lookup_barcode') result = await execLookupBarcode(chatId, tu.input);
        else if (tu.name === 'lookup_israeli_food') result = await execLookupIsraeliFood(chatId, tu.input);
        else if (tu.name === 'save_recipe') result = await execSaveRecipe(chatId, tu.input);
        else if (tu.name === 'save_meal') result = await execSaveMeal(chatId, tu.input);
        else if (tu.name === 'log_saved') result = await execLogSaved(chatId, mealText, tu.input);
        else if (tu.name === 'query_log') result = await execQueryLog(chatId, tu.input);
        else result = { ok: false, error: `unknown tool ${tu.name}` };
      } catch (err) {
        console.error('tool exec error:', tu.name, err);
        result = { ok: false, error: String(err.message || err) };
      }
      // query_log is read-only — feeds the model, no undo/confirmation block.
      if (result.ok && result.kind !== 'query_log' && result.kind !== 'lookup_barcode' && result.kind !== 'lookup_israeli_food') actions.push(result);

      let resultContent;
      if (!result.ok) resultContent = { ok: false, error: result.error };
      else if (result.kind === 'remember_food') resultContent = { ok: true, alias: result.alias, is_new: result.isNew };
      else if (result.kind === 'log_measurement') resultContent = { ok: true, measured_on: result.measuredOn, saved: result.saved, navy_body_fat_pct: result.navyPct, deltas: result.deltas };
      else if (result.kind === 'set_goals') resultContent = { ok: true, goals: result.goals };
      else if (result.kind === 'query_log') resultContent = { ok: true, days: result.days };
      else if (result.kind === 'lookup_barcode' || result.kind === 'lookup_israeli_food') resultContent = result;
      else if (result.kind === 'save_recipe') resultContent = { ok: true, name: result.name, totals: result.totals, per_serving: result.perServing, per_100g: result.per100g };
      else if (result.kind === 'save_meal') resultContent = { ok: true, name: result.name, totals: result.totals };
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

  // Safety net: a turn that neither wrote anything nor said anything is a dead
  // end for the user. Ask once more with tools off so a text answer is the only
  // thing the model can produce.
  if (!actions.length && !finalText && Date.now() - started < DEADLINE_MS) {
    try {
      const resp = await callClaude(system, messages, { forceText: true });
      finalText = (resp.content || [])
        .filter((b) => b.type === 'text').map((b) => b.text).join(String.fromCharCode(10)).trim();
    } catch (err) {
      console.error('forced-text retry failed:', err.message);
    }
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
