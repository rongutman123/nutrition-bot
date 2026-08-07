create table if not exists meals (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  ts          timestamptz not null default now(),
  day_key     text not null,
  raw_text    text not null,
  items       jsonb not null,
  totals      jsonb not null,
  assumptions text default '',
  confidence  text default 'medium',
  source      text default 'ai'
);

create index if not exists meals_chat_day on meals (chat_id, day_key);

create table if not exists goals (
  chat_id    bigint primary key,
  calories   int not null default 2000,
  protein    int not null default 130,
  carbs      int not null default 200,
  fat        int not null default 65,
  updated_at timestamptz default now()
);

alter table meals enable row level security;
alter table goals enable row level security;
