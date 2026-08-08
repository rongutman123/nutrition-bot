// Meal parsing via the Claude API — text and image.
// Docs: https://docs.claude.com/en/api/overview

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const SCHEMA = `{"items":[{"name":"שם בעברית","portion":"תיאור הכמות","grams":מספר,"calories":מספר,"protein":מספר,"carbs":מספר,"fat":מספר,"fiber":מספר,"sugar":מספר,"sodium_mg":מספר}],"assumptions":"משפט קצר בעברית או מחרוזת ריקה","confidence":"high|medium|low"}`;

const TEXT_SYSTEM = `אתה מנוע ניתוח תזונתי. תקבל תיאור חופשי של ארוחה (עברית או אנגלית) ותחזיר JSON בלבד — בלי הסברים, בלי markdown, בלי טקסט לפני או אחרי.

סכמה מדויקת:
${SCHEMA}

חוקים:
- הערכים הם עבור הכמות שצוינה בפועל, לא ל-100 גרם.
- אם כמות לא צוינה — הנח מנה ישראלית טיפוסית וציין זאת ב-assumptions.
- מוצר ישראלי מוכר (קוטג' 5%, במבה, מילקי וכו') — השתמש בערכים האופייניים של המוצר עצמו.
- confidence: high = מזון פשוט וכמויות ברורות; medium = נדרשו הנחות כמות; low = תיאור מעורפל או מנת מסעדה מורכבת.
- אם ההודעה אינה תיאור של אוכל: {"items":[],"assumptions":"","confidence":"low"}`;

const IMAGE_SYSTEM = `אתה מנוע ניתוח תזונתי שמנתח תמונות של אוכל. בחן את התמונה ובחר בדרך הכי מדויקת שזמינה, לפי סדר עדיפות:

1. אם מופיעה בתמונה טבלת ערכים תזונתיים (תווית של מוצר ארוז) — קרא את המספרים ישירות מהטבלה. זה המקור הכי מדויק. שים לב אם הערכים הם ל-100 גרם או למנה, וחשב לפי הכמות שנראית סבירה שנאכלה. confidence: high.
2. אם רואים מוצר ארוז מוכר (עם שם/מותג נראה) אך בלי טבלה קריאה — השתמש בערכים האופייניים של המוצר. confidence: medium.
3. אם זו צלחת/מנה של אוכל — זהה את הפריטים, הערך כמויות בגרמים לפי מה שנראה, וחשב ערכים. הבהר ב-assumptions מה הנחת (כמויות, שמן בישול וכו'). confidence: low.

החזר JSON בלבד — בלי הסברים, בלי markdown, בלי טקסט לפני או אחרי.

סכמה מדויקת:
${SCHEMA}

ב-assumptions ציין תמיד באיזו דרך זיהית (טבלה / מוצר מוכר / הערכת צלחת). אם אין בתמונה אוכל כלל: {"items":[],"assumptions":"לא זוהה אוכל בתמונה","confidence":"low"}`;

const EDIT_SYSTEM = `אתה מנוע ניתוח תזונתי שמתקן ארוחה שנרשמה. תקבל את הפירוק הקיים ובקשת תיקון מהמשתמש בשפה חופשית (למשל "רק חצי", "150 גרם במקום 200", "בלי הדבש", "תוסיף כף שמן זית").

החזר את הפירוק המעודכן כ-JSON בלבד — בלי הסברים, בלי markdown, בלי טקסט לפני או אחרי.

סכמה מדויקת:
${SCHEMA}

חוקים:
- שמור על הפריטים שלא הושפעו מהתיקון בדיוק כמו שהם.
- אם המשתמש מבקש להסיר פריט — הסר אותו מהמערך.
- אם המשתמש מבקש להוסיף פריט — הוסף אותו עם ערכים מתאימים.
- אם המשתמש משנה כמות — חשב מחדש את כל הערכים באופן פרופורציונלי.
- ב-assumptions ציין בקצרה מה שינית.`;

function extractJson(raw) {
  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no json in response');
  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!Array.isArray(parsed.items)) throw new Error('bad response shape');
  return parsed;
}

async function callClaude(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function parseMeal(text) {
  const raw = await callClaude({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: TEXT_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  return extractJson(raw);
}

export async function parseMealImage(base64Data, mediaType, hint) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64Data } },
  ];
  if (hint) content.push({ type: 'text', text: `רמז מהמשתמש: ${hint}` });

  const raw = await callClaude({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: IMAGE_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  return extractJson(raw);
}

export async function parseMealEdit(existingItems, instruction) {
  const payload = `הפירוק הקיים:\n${JSON.stringify(existingItems, null, 1)}\n\nבקשת התיקון: ${instruction}`;
  const raw = await callClaude({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: EDIT_SYSTEM,
    messages: [{ role: 'user', content: payload }],
  });
  return extractJson(raw);
}

export function sumItems(items) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 };
  for (const i of items || []) for (const k of Object.keys(t)) t[k] += Number(i[k]) || 0;
  return t;
}
