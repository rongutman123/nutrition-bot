-- ============================================================
-- Nutrition Agent — Phase 1 schema additions
-- Run in: Supabase SQL Editor (project wkpelooymaqlgkvyuidv)
-- Safe to re-run (idempotent). Does NOT touch existing tables.
-- ============================================================

-- ---------- personal food dictionary ----------
create table if not exists my_foods (
  id bigserial primary key,
  chat_id bigint not null,
  alias text not null,            -- "קוטג'"
  product text,                   -- "קוטג' תנובה 5%"
  serving_grams numeric,          -- 250
  kcal_per_100g numeric,
  protein_per_100g numeric,
  carbs_per_100g numeric,
  fat_per_100g numeric,
  variants jsonb,                 -- {"חצי": 125, "שלם": 250}
  updated_at timestamptz default now(),
  unique (chat_id, alias)
);

-- ---------- body measurements ----------
create table if not exists measurements (
  id bigserial primary key,
  chat_id bigint not null,
  measured_on date not null,
  weight_kg numeric,
  waist_cm numeric,
  neck_cm numeric,
  steps_avg int,
  notes text,
  unique (chat_id, measured_on)
);

alter table my_foods enable row level security;
alter table measurements enable row level security;

-- ============================================================
-- Seed data — chat_id is pulled from the existing meals table
-- (single-user DB, so the distinct chat_id is yours).
-- ============================================================

-- ---------- my_foods: known corrections from the Aug export ----------
insert into my_foods (chat_id, alias, product, serving_grams,
                      kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, variants)
select m.chat_id, v.alias, v.product, v.serving_grams,
       v.kcal, v.protein, v.carbs, v.fat, v.variants
from (select distinct chat_id from meals) m
cross join (values
  ('לחמניה',                null,                          90::numeric,  null::numeric, null::numeric, null::numeric, null::numeric, null::jsonb),
  ('כף מדידה אבקת חלבון',   'אבקת חלבון — סקופ',           33,           null, null, null, null, null),
  ('קציצה',                 null,                          125,          null, null, null, null, null),
  ('גלידה פרו קרים שוקולד', 'Pro Cream שוקולד',            120,          null, null, null, null, null),
  ('בורקס דפי אורז',        null,                          250,          null, null, null, null, null),
  ('דנבר',                  'דנבר',                        200,          250,  25,   null, null, null)
) as v(alias, product, serving_grams, kcal, protein, carbs, fat, variants)
on conflict (chat_id, alias) do nothing;

-- ---------- measurements: verified history ----------
insert into measurements (chat_id, measured_on, weight_kg, waist_cm, neck_cm)
select m.chat_id, v.measured_on::date, v.weight_kg, v.waist_cm, v.neck_cm
from (select distinct chat_id from meals) m
cross join (values
  ('2026-07-23', 97.2::numeric, 109::numeric, 41::numeric),
  ('2026-08-01', null,          107.5,        null),
  ('2026-08-22', 96.0,          106,          41)
) as v(measured_on, weight_kg, waist_cm, neck_cm)
on conflict (chat_id, measured_on) do nothing;

-- ---------- verification ----------
select 'my_foods' as t, count(*) from my_foods
union all
select 'measurements', count(*) from measurements;

-- ============================================================
-- Phase 1b — undo journal for agent write actions
-- ============================================================
create table if not exists agent_actions (
  id bigserial primary key,
  chat_id bigint not null,
  kind text not null,             -- 'log_meal' | 'update_meal' | ...
  payload jsonb not null,         -- what's needed to revert
  undone boolean default false,
  created_at timestamptz default now()
);
alter table agent_actions enable row level security;
