// Meal parsing via the Claude API — one short call per logged meal.
// Docs: https://docs.claude.com/en/api/overview

const SYSTEM = `אתה מנוע ניתוח תזונתי. תקבל תיאור חופשי של ארוחה (עברית או אנגלית) ותחזיר JSON בלבד — בלי הסברים, בלי markdown, בלי טקסט לפני או אחרי.

סכמה מדויקת:
{"items":[{"name":"שם בעברית","portion":"תיאור הכמות","grams":מספר,"calories":מספר,"protein":מספר,"carbs":מספר,"fat":מספר,"fiber":מספר,"sugar":מספר,"sodium_mg":מספר}],"assumptions":"משפט קצר בעברית או מחרוזת ריקה","confidence":"high|medium|low"}

חוקים:
- הערכים הם עבור הכמות שצוינה בפועל, לא ל-100 גרם.
- אם כמות לא צוינה — הנח מנה ישראלית טיפוסית וציין זאת ב-assumptions.
- מוצר ישראלי מוכר (קוטג' 5%, במבה, מילקי וכו') — השתמש בערכים האופייניים של המוצר עצמו.
- confidence: high = מזון פשוט וכמויות ברורות; medium = נדרשו הנחות כמות; low = תיאור מעורפל או מנת מסעדה מורכבת.
- אם ההודעה אינה תיאור של אוכל: {"items":[],"assumptions":"","confidence":"low"}`;

export async function parseMeal(text) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1200,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no json in response');

  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!Array.isArray(parsed.items)) throw new Error('bad response shape');
  return parsed;
}

export function sumItems(items) {
