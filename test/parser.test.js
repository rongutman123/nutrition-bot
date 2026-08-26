import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMealText, parseSegment, parseCorrection, applyCorrectionToItems,
  parseMeasurementText, parseBarcodeDigits, parseLabelAnswer, findFood,
} from '../lib/parser.js';

const FOODS = [
  { alias: 'בננה', serving_grams: 120, kcal_per_100g: 89, protein_per_100g: 1.1, carbs_per_100g: 23, fat_per_100g: 0.3 },
  { alias: 'לחמנייה', product: 'לחמניית כוסמין', serving_grams: 90, kcal_per_100g: 270, protein_per_100g: 9, carbs_per_100g: 50, fat_per_100g: 3 },
  { alias: 'קוטג', product: "קוטג' תנובה 5%", serving_grams: 250, kcal_per_100g: 121, protein_per_100g: 11.7, carbs_per_100g: 3.7, fat_per_100g: 5 },
  { alias: 'טחינה', kcal_per_100g: 595, protein_per_100g: 17, carbs_per_100g: 21, fat_per_100g: 54, variants: { 'כף': 15 } },
  { alias: 'אורז', kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3 }, // no serving size
  { alias: 'בצל', serving_grams: 100, kcal_per_100g: 40, protein_per_100g: 1, carbs_per_100g: 9, fat_per_100g: 0 },
];
const ctx = { foods: FOODS, savedMeals: [{ name: 'השייק שלי' }], recipes: [] };

describe('the meal parser', () => {
  test('an exact dictionary word logs one default serving', () => {
    const r = parseMealText('בננה', ctx);
    assert.equal(r.type, 'meal');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].grams, 120);
    assert.equal(r.items[0].calories, Math.round(89 * 1.2));
    assert.equal(r.items[0].source_type, 'personal_food');
    assert.equal(r.items[0].quantity_source, 'default');
  });

  test('a leading count multiplies the serving, plural matches singular', () => {
    const r = parseMealText('2 לחמניות', ctx);
    assert.equal(r.type, 'meal');
    assert.equal(r.items[0].grams, 180);
    assert.equal(r.items[0].calories, Math.round(270 * 1.8));
  });

  test('explicit grams need no serving size', () => {
    const r = parseMealText('150 גרם אורז', ctx);
    assert.equal(r.type, 'meal');
    assert.equal(r.items[0].grams, 150);
    assert.equal(r.items[0].calories, 195);
    assert.equal(r.items[0].quantity_source, 'user_explicit');
  });

  test('a serving word (גביע) resolves through serving_grams', () => {
    const r = parseMealText('גביע קוטג', ctx);
    assert.equal(r.type, 'meal');
    assert.equal(r.items[0].grams, 250);
  });

  test('a spoon resolves only through a known variant weight', () => {
    const spoon = parseMealText('כף טחינה', ctx);
    assert.equal(spoon.type, 'meal');
    assert.equal(spoon.items[0].grams, 15);

    const two = parseMealText('2 כפות טחינה', ctx);
    assert.equal(two.items[0].grams, 30);

    // קוטג has no spoon variant — a spoon of it must not be guessed
    const noVariant = parseMealText('כף קוטג', ctx);
    assert.notEqual(noVariant.type, 'meal');
  });

  test('multi-item messages split on comma and "עם"', () => {
    const r = parseMealText('לחמנייה עם קוטג, בננה', ctx);
    assert.equal(r.type, 'meal');
    assert.equal(r.items.length, 3);
  });

  test('a known food without serving size and without grams declines', () => {
    const r = parseMealText('אורז', ctx);
    assert.notEqual(r.type, 'meal'); // never guess a portion
  });

  test('fuzzy matching never crosses to a different short word (בצק≠בצל)', () => {
    assert.equal(findFood('בצק', FOODS), null);
    const r = parseMealText('בצק', ctx);
    assert.equal(r.type, 'unknown_food');
  });

  test('a food is found by any of its learned alternative names', () => {
    const foods = [{
      alias: 'מק דאבל', aliases: ['מקדונלדס דאבל', 'דאבל', 'המבורגר מק דאבל'],
      product: 'McDonald\'s Mc Double', serving_grams: 150, kcal_per_100g: 250,
      protein_per_100g: 15, carbs_per_100g: 20, fat_per_100g: 12,
    }];
    for (const name of ['מק דאבל', 'מקדונלדס דאבל', 'דאבל', 'המבורגר מק דאבל']) {
      assert.ok(findFood(name, foods), `should match "${name}"`);
    }
    const r = parseMealText('2 דאבל', { foods });
    assert.equal(r.type, 'meal');
    assert.equal(r.items[0].grams, 300);
    assert.equal(r.items[0].name, 'מק דאבל', 'logged under the canonical name');
  });

  test('questions are not meals', () => {
    assert.equal(parseMealText('כמה חלבון אכלתי היום?', ctx).type, 'no_parse');
    assert.equal(parseMealText('מה אכלתי אתמול', ctx).type, 'no_parse');
  });

  test('a saved meal is recognized by name, with or without "רשום"', () => {
    assert.equal(parseMealText('השייק שלי', ctx).type, 'saved');
    assert.equal(parseMealText('רשום השייק שלי', ctx).type, 'saved');
  });

  test('an unknown single food is routed to the database, keeping its grams', () => {
    const r = parseMealText('פלאפל 150 גרם', ctx);
    assert.equal(r.type, 'unknown_food');
    assert.equal(r.name, 'פלאפל');
    assert.equal(r.grams, 150);
  });

  test('long free text is declined, not guessed', () => {
    const r = parseMealText('אכלתי משהו קטן אחרי האימון אולי חצי פיתה עם קצת חומוס', ctx);
    assert.equal(r.type, 'no_parse');
  });

  test('a multi-item message with one unknown declines entirely', () => {
    const r = parseMealText('בננה, שקשוקת פלדה', ctx);
    assert.equal(r.type, 'no_parse'); // partial logging would silently drop food
  });
});

describe('corrections', () => {
  const items = [
    { name: 'לחמנייה', grams: 90, calories: 243, protein: 8.1, carbs: 45, fat: 2.7 },
    { name: 'גבינה צהובה', grams: 25, calories: 90, protein: 6, carbs: 0.5, fat: 7 },
  ];

  test('the pattern set parses', () => {
    assert.deepEqual(parseCorrection('רק חצי'), { op: 'scale', factor: 0.5 });
    assert.deepEqual(parseCorrection('חצי'), { op: 'scale', factor: 0.5 });
    assert.deepEqual(parseCorrection('פעמיים'), { op: 'scale', factor: 2 });
    assert.deepEqual(parseCorrection('בלי הגבינה צהובה'), { op: 'remove', name: 'גבינה צהובה' });
    assert.deepEqual(parseCorrection('היה 120 גרם'), { op: 'set_grams', grams: 120 });
    assert.deepEqual(parseCorrection('תמחק את זה'), { op: 'delete' });
    assert.equal(parseCorrection('בננה'), null);
  });

  test('scale halves every number', () => {
    const out = applyCorrectionToItems({ op: 'scale', factor: 0.5 }, items);
    assert.equal(out[0].grams, 45);
    assert.equal(out[0].calories, 122); // rounded
    assert.equal(out[1].calories, 45);
  });

  test('remove drops exactly one matched item', () => {
    const out = applyCorrectionToItems({ op: 'remove', name: 'גבינה צהובה' }, items);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'לחמנייה');
  });

  test('remove declines when nothing (or everything) matches', () => {
    assert.equal(applyCorrectionToItems({ op: 'remove', name: 'עגבנייה' }, items), null);
    assert.equal(applyCorrectionToItems({ op: 'remove', name: 'לחמנייה' }, [items[0]]), null);
  });

  test('set_grams rescales a single-item meal proportionally', () => {
    const out = applyCorrectionToItems({ op: 'set_grams', grams: 120 }, [items[0]]);
    assert.equal(out[0].grams, 120);
    assert.equal(out[0].calories, 324);
    assert.equal(out[0].quantity_source, 'user_explicit');
  });

  test('set_grams declines on a multi-item meal (ambiguous)', () => {
    assert.equal(applyCorrectionToItems({ op: 'set_grams', grams: 120 }, items), null);
  });
});

describe('measurements, barcodes, label answers', () => {
  test('weight + waist parse; out-of-range declines', () => {
    assert.deepEqual(parseMeasurementText('נשקלתי 95.8 מותן 105'), { weight_kg: 95.8, waist_cm: 105 });
    assert.deepEqual(parseMeasurementText('נשקלתי 95.8, מותן 105, צוואר 42'), { weight_kg: 95.8, waist_cm: 105, neck_cm: 42 });
    assert.equal(parseMeasurementText('נשקלתי 500'), null);
    assert.equal(parseMeasurementText('סתם משפט על מותניים'), null);
  });

  test('barcode digits: 13 digits pass, with or without spaces', () => {
    assert.equal(parseBarcodeDigits('7290004131074'), '7290004131074');
    assert.equal(parseBarcodeDigits('729 0004 131074'), '7290004131074');
    assert.equal(parseBarcodeDigits('12345'), null);
    assert.equal(parseBarcodeDigits('בננה'), null);
  });

  test('label answers: name plus numbers in order', () => {
    const a = parseLabelAnswer('קוטג תנובה 5%, 121, 11.7, 3.7, 5, 250');
    assert.equal(a.name, 'קוטג תנובה 5%');
    assert.equal(a.kcal, 121);
    assert.equal(a.protein, 11.7);
    assert.equal(a.serving_grams, 250);
    assert.equal(parseLabelAnswer('סתם טקסט בלי מספרים'), null);
    assert.equal(parseLabelAnswer('123, 456'), null); // a number is not a name
  });
});
