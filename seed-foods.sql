-- Seed my_foods from the Telegram history (old bot 7-24.08 + agent 24-26.08).
-- Per-100g values derived from confirmations Ron did not correct or delete;
-- each passed an Atwater reconciliation and a mass sanity check.
-- Existing rows are only FILLED IN — coalesce never overwrites what is there.

with c as (select chat_id from goals order by chat_id limit 1)
insert into my_foods (chat_id, alias, aliases, product, serving_grams,
                      kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, variants, barcode)
select c.chat_id, v.* from c, (values
  ('לחמניה', ARRAY['לחמנייה','לחמניה לבנה','לחמניות']::text[], 'לחמניה', 90, 270, 8.9, 51.1, 2.2, null::jsonb, null),  -- 6x ביומן · דיוק גבוה · 2026-08-18
  ('צלי כתף', ARRAY['כתף מספר 5','צלי כתף מספר 5','בשר מספר 5','כתף בקר']::text[], 'צלי כתף מס'' 5 במרינדת סילאן-חרדל', 200, 210, 27, 3.5, 8.5, null::jsonb, null),  -- 4x ביומן · דיוק גבוה · 2026-08-11
  ('גלידה פרו קרים שוקולד', ARRAY['פרו קרים','גלידת חלבון שוקולד','גלידת פרו קרים','pro cream']::text[], 'Pro Cream גלידת חלבון פאדג׳ שוקולד', 120, 240, 16.7, 31.4, 7.3, null::jsonb, null),  -- 3x ביומן · דיוק גבוה · 2026-08-07
  ('פסטה רוזה', ARRAY['פסטה רוזה חלבונית','פסטה חלבונית']::text[], 'פסטה רוזה חלבונית ביתית', 500, 150, 6, 26, 2.9, null::jsonb, null),  -- 3x ביומן · דיוק גבוה · 2026-08-12
  ('שניצל', ARRAY['שניצל עוף','שניצלים']::text[], 'שניצל עוף מטוגן', 110, 230, 18.2, 10.9, 12.7, null::jsonb, null),  -- 2x ביומן · דיוק גבוה · 2026-08-18
  ('אוכמניות', ARRAY['אוכמנית']::text[], 'אוכמניות', 240, 35, 0.5, 8.9, 0.2, null::jsonb, null),  -- 1x ביומן · דיוק גבוה · 2026-08-14
  ('במבה', ARRAY['במבה אוסם']::text[], 'במבה', 100, 544, 9.6, 55, 32, null::jsonb, null),  -- 1x ביומן · דיוק גבוה · 2026-08-17
  ('במבה נוגט', ARRAY['במבה נוגט אוסם']::text[], 'במבה נוגט', 30, 530, 8, 57, 31, null::jsonb, null),  -- 1x ביומן · דיוק גבוה · 2026-08-11
  ('כרוב בתנור', ARRAY['כרוב אפוי','כרוב']::text[], 'כרוב אפוי בתנור', 300, 25, 1.3, 5.8, 0.1, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-07
  ('כרוב סגול', ARRAY['סלט כרוב סגול','כרוב במיונז']::text[], 'כרוב סגול במיונז צבר', 60, 170, 1, 6, 16, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-08
  ('משקה חלבון קפה', ARRAY['מולר קפה','משקה חלבון מולר','פרו קפה','muller pro']::text[], 'Müller Pro Caffè 0% שומן', 350, 41, 7.1, 2.9, 0.1, null::jsonb, null),  -- 1x ביומן · דיוק גבוה · 2026-08-07
  ('עוגת גבינה', ARRAY['עוגת גבינה פירורים']::text[], 'עוגת גבינה פירורים', 40, 320, 7, 30, 19, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-15
  ('פיצה', ARRAY['פיצה זיתים','משולש פיצה']::text[], 'פיצה עם זיתים', 180, 260, 10, 30, 11.1, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-20
  ('פירה', ARRAY['פירה עם שמנת','פירה ביתי']::text[], 'פירה עם שמנת 9%', 400, 87, 1.6, 14, 2.7, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-07
  ('פנקייק', ARRAY['פנקייק סוויטנגו','פנקייק שיבולת שועל','סוויטנגו']::text[], 'פנקייק סוויטנגו שיבולת שועל', 200, 110, 7, 14, 2.5, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-22
  ('קטשופ', ARRAY['קטשופ מופחת','קטשופ דל קלוריות']::text[], 'קטשופ מופחת קלוריות', 150, 50, 1, 11.3, 0, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-20
  ('רוזאלה', ARRAY['רוזאלה לנדוור','עוגיית רוזאלה']::text[], 'רוזאלה לנדוור', 120, 440, 6, 52, 23.2, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-17
  ('שוקולד מריר', ARRAY['שוקולד']::text[], 'שוקולד מריר', 40, 540, 7, 50, 36, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-22
  ('שניצל בתנור', ARRAY['שניצל אפוי']::text[], 'שניצל עוף בתנור', 600, 170, 15, 7, 9, null::jsonb, null),  -- 1x ביומן · הערכה · 2026-08-20
  ('קוטג''', ARRAY['קוטג','קוטג׳','גביע קוטג']::text[], 'קוטג'' תנובה 5%', 300, 121, 9.7, 3.7, 5, '{"שלם":300,"חצי":150,"גביע":300}'::jsonb, null),  -- לימדת אותו ישירות · מנה 300 גרם לפי התיקון שלך
  ('מעדן פרו חלבון תות', ARRAY['מעדן פרו','פרו תות','מעדן חלבון תות']::text[], 'מעדן פרו חלבון תות', 200, 65, 10, 5.6, 0, null::jsonb, null),  -- נקרא מתווית הגביע
  ('משקה קפה מולר', ARRAY['מולר קפה חלבון','muller קפה']::text[], 'müller משקה קפה עם חלבוני חלב', 350, 45, 7.2, 4.2, 0, null::jsonb, '7290114313278')  -- ברקוד שסרקת ב-26.08
) as v(alias, aliases, product, serving_grams, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, variants, barcode)
on conflict (chat_id, alias) do update set
  aliases          = array(select distinct unnest(coalesce(my_foods.aliases, '{}'::text[]) || excluded.aliases)),
  product          = coalesce(my_foods.product,          excluded.product),
  serving_grams    = coalesce(my_foods.serving_grams,    excluded.serving_grams),
  kcal_per_100g    = coalesce(my_foods.kcal_per_100g,    excluded.kcal_per_100g),
  protein_per_100g = coalesce(my_foods.protein_per_100g, excluded.protein_per_100g),
  carbs_per_100g   = coalesce(my_foods.carbs_per_100g,   excluded.carbs_per_100g),
  fat_per_100g     = coalesce(my_foods.fat_per_100g,     excluded.fat_per_100g),
  variants         = coalesce(my_foods.variants,         excluded.variants),
  barcode          = coalesce(my_foods.barcode,          excluded.barcode),
  updated_at       = now();


-- Batch 2: foods from MULTI-ITEM meals in the Telegram history.
-- Portion and calories come from your own confirmations; the macro split is
-- standard reference values, reconciled against those calories.
-- Existing rows are only filled in, never overwritten.

with c as (select chat_id from goals order by chat_id limit 1)
insert into my_foods (chat_id, alias, aliases, product, serving_grams,
                      kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
select c.chat_id, v.* from c, (values
  ('אבקת חלבון', ARRAY['אבקת חלבון וניל','אול אין','all in','סקופ חלבון','כף מדידה אבקת חלבון']::text[], 'אבקת חלבון All In וניל עוגיות', 33, 394, 75, 10, 5),
  ('חלב דל לקטוז', ARRAY['חלב 2% דל לקטוז','חלב ללא לקטוז','חלב דל לקטוז 2%']::text[], 'חלב 2% דל לקטוז', 300, 50, 3.4, 4.8, 2),
  ('צלי בקר', ARRAY['צלי','בקר צלוי']::text[], 'צלי בקר', 120, 165, 26, 0, 7),
  ('תפוחי אדמה בתנור', ARRAY['תפוחי אדמה','תפו״א בתנור','תפוחי אדמה אפויים']::text[], 'תפוחי אדמה בתנור', 150, 90, 2, 19, 0.9),
  ('דבש', ARRAY['כפית דבש','כף דבש']::text[], 'דבש', 25, 320, 0.3, 79, 0),
  ('בננה', ARRAY['בננה בינונית','בננות']::text[], 'בננה', 120, 89, 1.1, 23, 0.3),
  ('סלט ירקות', ARRAY['סלט','סלט ירקות טרי']::text[], 'סלט ירקות', 90, 40, 1.5, 5.5, 1.4),
  ('ברוקולי', ARRAY['ברוקולי מבושל','ברוקולי מאודה']::text[], 'ברוקולי מבושל', 150, 34, 2.8, 5, 0.4),
  ('מק דאבל', ARRAY['מקדונלדס דאבל','דאבל','מק-דאבל','דאבל צ''יזבורגר']::text[], 'McDonald''s מק דאבל', 140, 194, 14.2, 16.4, 8.9),
  ('חלה', ARRAY['פרוסת חלה','פרוסות חלה']::text[], 'חלה', 80, 280, 8.8, 52.5, 2.5),
  ('טונה בשמן', ARRAY['טונה','פחית טונה','קופסת טונה']::text[], 'טונה בשמן', 160, 175, 24, 0, 8.2),
  ('צ''יפס', ARRAY['צ''יפס מטוגן','ציפס']::text[], 'צ''יפס', 150, 300, 3.4, 38, 15),
  ('טבעות בצל', ARRAY['טבעות בצל מטוגנות','אניון רינגס']::text[], 'טבעות בצל מטוגנות', 80, 250, 3, 28, 14),
  ('פוטטוס', ARRAY['פוטאטוס','potato wedges','תפוצ׳יפס']::text[], 'פוטטוס', 100, 180, 2.7, 24, 8),
  ('נקניקיית צ''וריסוס', ARRAY['צוריסוס','צ''וריסוס','נקניקיה']::text[], 'נקניקיית צ''וריסוס', 70, 371, 17, 2, 33),
  ('רול סושי', ARRAY['סושי','רול קליפורניה']::text[], 'רול סושי', 180, 178, 6.5, 30, 3.7),
  ('חלב', ARRAY['חלב 3%','חלב 3% שומן']::text[], 'חלב 3% שומן', 100, 62, 3.3, 4.8, 3.3),
  ('ביצה', ARRAY['ביצה מטוגנת','ביצים']::text[], 'ביצה מטוגנת', 50, 160, 12, 0.8, 12),
  ('אורז', ARRAY['אורז לבן','אורז מבושל','אורז לבן מבושל']::text[], 'אורז לבן מבושל', 250, 116, 2.4, 25, 0.3),
  ('גבינה צהובה', ARRAY['גבינה צהובה 9%','פרוסת גבינה צהובה']::text[], 'גבינה צהובה 9%', 25, 192, 25, 1, 9),
  ('גבינה בולגרית', ARRAY['בולגרית','גבינה בולגרית 5%']::text[], 'גבינה בולגרית 5%', 30, 120, 13, 3, 5),
  ('חלבון ביצה', ARRAY['חלבוני ביצה','לבן ביצה']::text[], 'חלבון ביצה', 33, 52, 11, 0.7, 0.2),
  ('בורקס דפי אורז', ARRAY['בורקס אורז','בורקס']::text[], 'בורקס דפי אורז', 250, 264, 6, 30, 13),
  ('קציצה', ARRAY['קציצות','קציצת בשר']::text[], 'קציצת בשר', 125, 215, 18, 6, 13)
) as v(alias, aliases, product, serving_grams, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
on conflict (chat_id, alias) do update set
  aliases          = array(select distinct unnest(coalesce(my_foods.aliases, '{}'::text[]) || excluded.aliases)),
  product          = coalesce(my_foods.product,          excluded.product),
  serving_grams    = coalesce(my_foods.serving_grams,    excluded.serving_grams),
  kcal_per_100g    = coalesce(my_foods.kcal_per_100g,    excluded.kcal_per_100g),
  protein_per_100g = coalesce(my_foods.protein_per_100g, excluded.protein_per_100g),
  carbs_per_100g   = coalesce(my_foods.carbs_per_100g,   excluded.carbs_per_100g),
  fat_per_100g     = coalesce(my_foods.fat_per_100g,     excluded.fat_per_100g),
  updated_at       = now();


-- Whole-package values for the products that come in a fixed unit.
-- Saying the name logs ONE package by default; an explicit weight still
-- falls back to the per-100g values. Label facts, stored, not derived.

update my_foods m set package = v.package, updated_at = now()
from (values
  ('מעדן פרו חלבון תות', '{"grams":200,"kcal":130,"protein":20,"carbs":11.2,"fat":0,"unit":"גביע"}'::jsonb),
  ('קוטג''', '{"grams":300,"kcal":363,"protein":29.1,"carbs":11.1,"fat":15,"unit":"גביע"}'::jsonb),
  ('משקה חלבון קפה', '{"grams":350,"kcal":143,"protein":25,"carbs":10,"fat":0.4,"unit":"בקבוק"}'::jsonb),
  ('משקה קפה מולר', '{"grams":350,"kcal":158,"protein":25.2,"carbs":14.7,"fat":0,"unit":"בקבוק"}'::jsonb),
  ('גלידה פרו קרים שוקולד', '{"grams":120,"kcal":288,"protein":20,"carbs":37.7,"fat":8.8,"unit":"גביע"}'::jsonb),
  ('אבקת חלבון', '{"grams":33,"kcal":130,"protein":24.8,"carbs":3.3,"fat":1.7,"unit":"סקופ"}'::jsonb),
  ('במבה', '{"grams":60,"kcal":326,"protein":5.8,"carbs":33,"fat":19.2,"unit":"שקית"}'::jsonb),
  ('במבה נוגט', '{"grams":30,"kcal":159,"protein":2.4,"carbs":17.1,"fat":9.3,"unit":"שקית"}'::jsonb),
  ('טונה בשמן', '{"grams":160,"kcal":280,"protein":38.4,"carbs":0,"fat":13.1,"unit":"פחית"}'::jsonb),
  ('רוזאלה', '{"grams":120,"kcal":528,"protein":7.2,"carbs":62.4,"fat":27.8,"unit":"יחידה"}'::jsonb),
  ('לחמניה', '{"grams":90,"kcal":243,"protein":8,"carbs":46,"fat":2,"unit":"יחידה"}'::jsonb)
) as v(alias, package)
where m.alias = v.alias and m.package is null;
