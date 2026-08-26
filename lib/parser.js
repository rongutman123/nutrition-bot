// The deterministic layer: parse a Hebrew food message without an LLM.
// Design rule — never guess. Every function either resolves with full
// confidence or declines; a decline falls through to buttons or (on explicit
// tap only) the AI. A wrong silent log is worse than any "לא זיהיתי".

/* ---------------- normalization & similarity ---------------- */

const FINALS = { 'ן': 'נ', 'ם': 'מ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };

export function normalize(s = '') {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/["'׳״`]/g, '')
    // strip punctuation, but keep the decimal point inside numbers (95.8)
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[,!?;:()%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Final letters are folded only for comparisons — never in the text itself,
   or "גרם" stops matching the quantity patterns. */
const foldFinals = (s) => s.replace(/[ןםץףך]/g, (c) => FINALS[c]);
const key = (s) => foldFinals(normalize(s));

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* Tolerance scales with length: short Hebrew words are one letter apart from
   different foods (בצל/בצק), so short means exact. */
function closeEnough(a, b) {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  const d = levenshtein(a, b);
  if (len >= 8) return d <= 2;
  if (len >= 5) return d <= 1;
  return false;
}

/* Singular/plural stems: לחמניות→לחמני, ביצים→ביצ, לחמנייה→לחמני */
function stems(word) {
  const out = new Set([word]);
  for (const suf of ['יות', 'ות', 'ים', 'יה', 'ה']) {
    if (word.length - suf.length >= 3 && word.endsWith(suf)) out.add(word.slice(0, -suf.length));
  }
  return [...out];
}

function wordsMatch(a, b) {
  if (closeEnough(a, b)) return true;
  for (const sa of stems(a)) for (const sb of stems(b)) {
    if (sa === sb || closeEnough(sa, sb)) return true;
  }
  return false;
}

/* Whole-name match: exact, stem, fuzzy, or one being a short extension of the
   other ("קוטג" ↔ "קוטג 5%"). */
export function namesMatch(a, b) {
  const na = key(a), nb = key(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (wordsMatch(na, nb)) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return longer.startsWith(shorter + ' ') && longer.length - shorter.length <= 8;
}

/* Every name a food answers to: its alias, the learned alternatives, and the
   full product name. */
const allNames = (f) => [f.alias, ...(f.aliases || []), f.product].filter(Boolean);

export function findFood(name, foods = []) {
  const q = key(name);
  if (q.length < 2) return null;
  // exact match on any known name wins over any fuzzy match
  for (const f of foods) if (allNames(f).some((nm) => key(nm) === q)) return f;
  for (const f of foods) if (allNames(f).some((nm) => namesMatch(nm, q))) return f;
  return null;
}

/* ---------------- quantities ---------------- */

const FRACTIONS = { 'חצי': 0.5, 'רבע': 0.25, 'שליש': 0.33, 'שלושת רבעי': 0.75 };
const COUNT_WORDS = {
  'שתי': 2, 'שני': 2, 'שניים': 2, 'שתיים': 2, 'זוג': 2,
  'שלוש': 3, 'שלושה': 3, 'ארבע': 4, 'ארבעה': 4, 'חמש': 5, 'חמישה': 5,
};
// measures that mean "one standard serving" when the food defines one
const SERVING_WORDS = new Set(['גביע', 'יחידה', 'מנה', 'פרוסה', 'פרוסות', 'גביעי', 'יחידות', 'מנות', 'פחית', 'בקבוק', 'כוס', 'כוסות']);
const SPOON_WORDS = { 'כף': 'כף', 'כפות': 'כף', 'כפית': 'כפית', 'כפיות': 'כפית', 'כוס': 'כוס', 'כוסות': 'כוס' };

/* Parse one segment ("2 לחמניות", "גביע קוטג", "150 גרם אורז") against the
   dictionary. Returns a meal item or null. */
export function parseSegment(segment, foods) {
  let seg = normalize(segment);
  if (!seg || seg.length > 40) return null;

  let grams = null;
  let count = null;
  let measure = null;
  let explicit = false;

  // "150 גרם" anywhere in the segment
  const g = seg.match(/(\d+(?:\.\d+)?)\s*(?:גרם|גר|ג)(?=\s|$)/);
  if (g) {
    grams = Number(g[1]);
    explicit = true;
    seg = (seg.slice(0, g.index) + ' ' + seg.slice(g.index + g[0].length)).replace(/\s+/g, ' ').trim();
  }

  // leading count: number, count word, or fraction
  const lead = seg.match(/^(\d+(?:\.\d+)?)\s+/);
  if (lead) {
    count = Number(lead[1]);
    seg = seg.slice(lead[0].length).trim();
  } else {
    for (const [w, v] of Object.entries({ ...COUNT_WORDS, ...FRACTIONS })) {
      if (seg.startsWith(w + ' ')) { count = v; seg = seg.slice(w.length + 1).trim(); break; }
    }
  }
  if (count != null && (!(count > 0) || count > 20)) return null;

  // leading measure word: "גביע קוטג", "כף טחינה", "2 פרוסות לחם"
  const first = seg.split(' ')[0];
  if (SERVING_WORDS.has(first) || SPOON_WORDS[first]) {
    measure = SPOON_WORDS[first] || first;
    seg = seg.slice(first.length).trim();
  }

  if (!seg || seg.length < 2) return null;
  const food = findFood(seg, foods);
  if (!food) return null;

  // Packaged product: the label's per-package numbers are the fact. Use them
  // as-is unless the user asked for a weight or a sub-unit measure — deriving
  // them from per-100g drifts, and the package weight is often not the point.
  const pkg = food.package;
  if (pkg && Number.isFinite(Number(pkg.kcal)) && !explicit && !measure) {
    const n = count == null ? 1 : count;
    if (!(n > 0) || n > 20) return null;
    const r1p = (v) => (v == null ? null : Math.round(Number(v) * n * 10) / 10);
    const unit = pkg.unit || 'אריזה';
    return {
      name: food.alias,
      grams: pkg.grams != null ? r1p(pkg.grams) : null,
      portion: n === 1 ? unit : n === 0.5 ? `חצי ${unit}` : `${n} ${unit}`,
      calories: Math.round(Number(pkg.kcal) * n),
      protein: r1p(pkg.protein) ?? 0,
      carbs: r1p(pkg.carbs) ?? 0,
      fat: r1p(pkg.fat) ?? 0,
      source_type: 'personal_food',
      quantity_source: count == null ? 'default' : 'user_explicit',
      units: n, // how many whole packages — so "change amount" can rescale by count
      fromPackage: true,
    };
  }

  if (food.kcal_per_100g == null) return null;

  // resolve grams — decline rather than guess
  let quantitySource = 'user_explicit';
  let portion = null;
  const variants = food.variants || {};
  const variantGrams = (key) => {
    for (const [k, v] of Object.entries(variants)) if (namesMatch(k, key)) return Number(v);
    return null;
  };

  if (explicit) {
    if (count) grams *= count;
  } else if (measure) {
    const vg = variantGrams(measure);
    const per = vg != null ? vg
      : SERVING_WORDS.has(measure) && food.serving_grams ? Number(food.serving_grams)
      : null;
    if (per == null) return null; // "כף" without a known spoon weight — not a guess we make
    grams = per * (count || 1);
    portion = count && count !== 1 ? `${count} ${measure}` : measure;
  } else if (count != null) {
    if (!food.serving_grams) return null;
    grams = Number(food.serving_grams) * count;
    portion = count === 0.5 ? 'חצי' : count !== 1 ? `x${count}` : null;
  } else if (food.serving_grams) {
    grams = Number(food.serving_grams);
    quantitySource = 'default';
  } else {
    return null; // no explicit amount and no known serving — decline
  }

  if (!(grams > 0) || grams > 3000) return null;

  const per100 = grams / 100;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    name: food.alias,
    grams: r1(grams),
    ...(portion ? { portion } : {}),
    calories: Math.round((food.kcal_per_100g || 0) * per100),
    protein: r1((food.protein_per_100g || 0) * per100),
    carbs: r1((food.carbs_per_100g || 0) * per100),
    fat: r1((food.fat_per_100g || 0) * per100),
    source_type: 'personal_food',
    quantity_source: explicit ? 'user_explicit' : quantitySource,
  };
}

/* ---------------- the full message ---------------- */

const QUESTION_HINTS = /[?]|^כמה |^מה |^מתי |^למה |^איך |^האם /;
const SPLIT = /\s*(?:,|\+|\n| וגם | עם )\s*/;

/* returns:
   { type: 'meal', items }          — everything resolved, log it
   { type: 'saved', name }          — a saved meal / recipe by name
   { type: 'unknown_food', name, grams } — one food-looking item we don't know
   { type: 'no_parse' }             — not ours; buttons / AI decide */
export function parseMealText(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 120) return { type: 'no_parse' };
  if (QUESTION_HINTS.test(raw)) return { type: 'no_parse' };

  // saved meal / recipe by name, optionally with "רשום"
  const savedName = normalize(raw.replace(/^(רשום|תרשום)\s+/, ''));
  for (const s of [...(ctx.savedMeals || []), ...(ctx.recipes || [])]) {
    if (normalize(s.name) === savedName || namesMatch(s.name, savedName)) {
      return { type: 'saved', name: s.name };
    }
  }

  const segments = raw.split(SPLIT).map((s) => s.trim()).filter(Boolean);
  if (!segments.length || segments.length > 5) return { type: 'no_parse' };

  const items = [];
  const unknown = [];
  for (const seg of segments) {
    const item = parseSegment(seg, ctx.foods || []);
    if (item) items.push(item);
    else unknown.push(seg);
  }

  if (!unknown.length) return { type: 'meal', items };

  // A single short unresolved segment is worth a database lookup with buttons.
  if (segments.length === 1 && unknown.length === 1) {
    const seg = normalize(unknown[0]);
    const g = seg.match(/(\d+(?:\.\d+)?)\s*(?:גרם|גר|ג)(?=\s|$)/);
    const name = g
      ? (seg.slice(0, g.index) + ' ' + seg.slice(g.index + g[0].length)).replace(/\s+/g, ' ').trim()
      : seg;
    const words = name.split(' ').filter(Boolean);
    if (name.length >= 2 && words.length <= 3 && !/\d/.test(name)) {
      return { type: 'unknown_food', name, grams: g ? Number(g[1]) : null };
    }
  }
  return { type: 'no_parse' };
}

/* ---------------- corrections (always about the last meal) ---------------- */

export function parseCorrection(text) {
  const t = normalize(text);
  if (!t || t.length > 40) return null;

  if (/^(מחק|תמחק)( את)?( ה?ארוחה)?( האחרונה| האחרון| זה| זאת)?$/.test(t)) return { op: 'delete' };
  if (/^(רק )?חצי$/.test(t)) return { op: 'scale', factor: 0.5 };
  if (/^(רק )?רבע$/.test(t)) return { op: 'scale', factor: 0.25 };
  if (/^(כפול|פעמיים|x2|פי 2)$/.test(t)) return { op: 'scale', factor: 2 };

  const without = t.match(/^בלי ה?(.+)$/);
  if (without) return { op: 'remove', name: without[1].trim() };

  const grams = t.match(/^(?:זה היה |היה |בעצם )?(\d+(?:\.\d+)?) גרם$/);
  if (grams) return { op: 'set_grams', grams: Number(grams[1]) };

  const back = t.match(/^(?:שמור |תשמור |תעביר |העבר )?(?:את זה |אותו |אותה )?ל?(אתמול|שלשום)$/) ||
    t.match(/^(?:זה )?היה (אתמול|שלשום)$/);
  if (back) return { op: 'backdate', days: back[1] === 'אתמול' ? 1 : 2 };

  return null;
}

/* "אתמול 2 לחמניות" / "בננה שלשום" — pull the day off the message so the food
   can be parsed normally and logged to the right date. Returns the offset in
   days back and the text with the date words removed. */
// No \b here: in JS a word boundary is defined on [A-Za-z0-9_], so it never
// matches next to a Hebrew letter. Anchor on whitespace or string edges.
const E = '(?:^|\\s)';
const D = '(?=\\s|$)';
const DAY_WORDS = [
  [new RegExp(`${E}לפני\\s*3\\s*ימים${D}`), 3],
  [new RegExp(`${E}(?:לפני\\s*יומיים|שלשום|שילשום)${D}`), 2],
  [new RegExp(`${E}(?:אתמול|אמש)${D}`), 1],
];

export function extractDayOffset(text) {
  let rest = normalize(text);
  let days = 0;
  for (const [re, d] of DAY_WORDS) {
    if (re.test(rest)) {
      days = d;
      rest = rest.replace(re, ' ');
      break;
    }
  }
  if (!days) return { days: 0, rest: String(text || '').trim() };
  // a time of day can ride along ("אתמול בערב") — drop it, keep the day
  rest = rest.replace(new RegExp(`${E}(?:בבוקר|בצהריים|בערב|בלילה|בצהרים)${D}`, 'g'), ' ')
    .replace(/^\s*[-–—:,]\s*/, '').replace(/\s+/g, ' ').trim();
  return { days, rest };
}

/* Free-text amount for the quantity button: "150 גרם" / "2" / "חצי" / "2 כפות" */
export function parseAmount(text) {
  const t = normalize(text);
  if (!t || t.length > 24) return null;
  const g = t.match(/^(\d+(?:\.\d+)?)\s*(?:גרם|גר|ג|מל|מ״ל|מ"ל)$/);
  if (g) {
    const grams = Number(g[1]);
    return grams > 0 && grams <= 5000 ? { grams } : null;
  }
  const n = t.match(/^(\d+(?:\.\d+)?)$/);
  if (n) {
    const count = Number(n[1]);
    return count > 0 && count <= 50 ? { count } : null;
  }
  for (const [w, v] of Object.entries({ ...COUNT_WORDS, ...FRACTIONS })) {
    if (t === w) return { count: v };
  }
  return null;
}

/* Does THIS message ask for a date other than now? Used to stop the model
   backdating a meal because an older turn in the conversation log mentioned
   yesterday — a live bug: "מק דאבל" landed on 25.08 with nothing said about it. */
export function hasDateHint(text) {
  const t = normalize(text);
  return /אתמול|שלשום|שילשום|לפני יומיים|בבוקר|בצהריים|בערב|בלילה|אמש|\bב-?\d{1,2}[:.]\d{2}\b|\d{1,2}[./]\d{1,2}/.test(t);
}

/* Completing dictionary values by text — the syntax /foods teaches:
   "לחמניה: 280 קלוריות ל-100 גרם, חלבון 9, פחמימות 50, שומן 3" */
export function parseFoodValues(text) {
  const t = normalize(text);
  const m = t.match(/^([^\d]{2,40}?)\s+(\d+(?:\.\d+)?)\s*(?:קלוריות|קקל|קק"ל)\s*ל\s*-?\s*100\s*(?:גרם|גר|ג)(.*)$/);
  if (!m) return null;
  const kcal = Number(m[2]);
  if (!(kcal > 0) || kcal > 900) return null;

  const rest = m[3] || '';
  const grab = (word) => {
    const g = rest.match(new RegExp(`${word}\\s+(\\d+(?:\\.\\d+)?)`));
    return g ? Number(g[1]) : null;
  };
  return {
    name: m[1].trim(),
    kcal,
    protein: grab('חלבון'),
    carbs: grab('פחמימות') ?? grab('פחמ'),
    fat: grab('שומן'),
    serving_grams: grab('מנה'),
  };
}

/* Apply a correction to a meal's items. Returns new items or null (decline). */
export function applyCorrectionToItems(corr, items) {
  const scale = (it, f) => {
    const out = { ...it };
    for (const k of ['grams', 'calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium_mg']) {
      if (out[k] != null && Number.isFinite(Number(out[k]))) out[k] = Math.round(Number(out[k]) * f * 10) / 10;
    }
    if (out.calories != null) out.calories = Math.round(out.calories);
    return out;
  };

  if (corr.op === 'scale') return items.map((it) => scale(it, corr.factor));

  if (corr.op === 'remove') {
    const kept = items.filter((it) => !namesMatch(it.name, corr.name));
    // decline unless exactly one item was removed — ambiguity is not ours to resolve
    if (kept.length !== items.length - 1 || kept.length === 0) return null;
    return kept;
  }

  if (corr.op === 'set_grams') {
    // only unambiguous on a single-item meal
    if (items.length !== 1) return null;
    const it = items[0];
    if (!Number.isFinite(Number(it.grams)) || !(Number(it.grams) > 0)) return null;
    const f = corr.grams / Number(it.grams);
    const out = scale(it, f);
    out.grams = corr.grams;
    out.quantity_source = 'user_explicit';
    return [out];
  }

  return null;
}

/* ---------------- measurements ---------------- */

export function parseMeasurementText(text) {
  const t = normalize(text);
  if (!/(נשקלתי|משקל|מותן|צוואר|היקף)/.test(t)) return null;
  if (t.length > 80) return null;

  const num = (re) => {
    const m = t.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const fields = {};
  const w = num(/נשקלתי\s+(\d+(?:\.\d+)?)/) ?? num(/משקל\s+(\d+(?:\.\d+)?)/);
  if (w !== undefined) fields.weight_kg = w;
  const waist = num(/(?:מותן|היקף מותן)\s+(\d+(?:\.\d+)?)/);
  if (waist !== undefined) fields.waist_cm = waist;
  const neck = num(/צוואר\s+(\d+(?:\.\d+)?)/);
  if (neck !== undefined) fields.neck_cm = neck;

  if (!Object.keys(fields).length) return null;
  // sanity ranges — outside them we decline instead of storing garbage
  if (fields.weight_kg !== undefined && (fields.weight_kg < 30 || fields.weight_kg > 300)) return null;
  if (fields.waist_cm !== undefined && (fields.waist_cm < 40 || fields.waist_cm > 250)) return null;
  if (fields.neck_cm !== undefined && (fields.neck_cm < 20 || fields.neck_cm > 80)) return null;
  return fields;
}

/* ---------------- barcodes ---------------- */

export function parseBarcodeDigits(text) {
  const t = String(text || '').trim();
  if (!/^[\d\s-]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

/* The one-time label questionnaire answer:
   "שם המוצר, 250, 10, 30, 8" (kcal, protein, carbs, fat[, serving grams]) */
export function parseLabelAnswer(text) {
  const parts = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts[0];
  if (!/[א-תa-z]/i.test(name) || name.length < 2) return null;

  const nums = parts.slice(1).map((p) => {
    const m = p.match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  });
  if (nums[0] == null || !(nums[0] > 0) || nums[0] > 900) return null; // kcal per 100g

  return {
    name,
    kcal: nums[0],
    protein: nums[1] ?? null,
    carbs: nums[2] ?? null,
    fat: nums[3] ?? null,
    serving_grams: nums[4] ?? null,
  };
}
