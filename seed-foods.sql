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