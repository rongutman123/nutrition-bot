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

-- ============================================================
-- Phase 2a — barcode support on the personal dictionary
-- ============================================================
alter table my_foods add column if not exists barcode text;
create unique index if not exists my_foods_chat_barcode
  on my_foods (chat_id, barcode) where barcode is not null;

-- ============================================================
-- Phase 2b — recipes and saved meals
-- ============================================================
create table if not exists recipes (
  id bigserial primary key,
  chat_id bigint not null,
  name text not null,
  total_grams numeric,             -- finished weight, for per-100g math
  servings numeric,                -- how many portions it makes
  ingredients jsonb not null,      -- [{name, grams, calories, protein, carbs, fat}]
  totals jsonb not null,           -- whole-recipe macros
  notes text,
  updated_at timestamptz default now(),
  unique (chat_id, name)
);

create table if not exists saved_meals (
  id bigserial primary key,
  chat_id bigint not null,
  name text not null,
  category text,                   -- "ארוחת בוקר" / "שייק" / ...
  items jsonb not null,            -- snapshot of the item list
  totals jsonb not null,
  use_count int default 0,
  last_used timestamptz,
  updated_at timestamptz default now(),
  unique (chat_id, name)
);

alter table recipes enable row level security;
alter table saved_meals enable row level security;

-- Token/usage accounting: one row per handled message, every route (free and
-- Claude alike), so /cost can price the traffic and show the free share.
create table agent_usage (
  id          bigint generated always as identity primary key,
  chat_id     bigint not null,
  ts          timestamptz not null default now(),
  route       text not null,        -- 'claude' | 'parser' | 'barcode' | 'menu' | 'command'
  kind        text,                 -- 'log_meal' | 'correction' | 'question' | ...
  model       text,                 -- null on the free routes
  input_tokens        int,
  output_tokens       int,
  cache_write_tokens  int,
  cache_read_tokens   int,
  rounds      int,
  latency_ms  int,
  snippet     text,
  ok          boolean not null default true
);

create index agent_usage_chat_ts on agent_usage (chat_id, ts desc);

alter table agent_usage enable row level security;

-- ---------- alternative names ----------
-- One food, many ways the user says it ("מק דאבל" / "מקדונלדס דאבל" / "דאבל").
-- The parser matches on alias OR any entry here, so a food learned once is
-- recognized however it is phrased next time — no LLM call.
alter table my_foods add column if not exists aliases text[];

-- ---------- packaged products ----------
-- Some foods are not weight-dependent: a McDouble, a cottage tub, a protein
-- drink. Their natural unit is the whole package, and the label's per-package
-- numbers are the authoritative fact — not something to derive from per-100g
-- (rounding drifts, and the package weight is often unknown or wrong).
-- Shape: {"grams":140,"kcal":415,"protein":22,"carbs":34,"fat":21,"unit":"מנה"}
-- When present, saying the food's name logs ONE WHOLE PACKAGE by default.
alter table my_foods add column if not exists package jsonb;
