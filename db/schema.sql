create table if not exists properties (
  key text primary key,
  name text not null,
  area text,
  type text,
  guests int,
  size_m2 int,
  bedrooms text,
  url text,
  highlights text,
  open_questions text,
  active boolean not null default true,
  last_posted_at timestamptz
);

create table if not exists photos (
  file_id text primary key,
  property_key text not null references properties(key) on delete cascade,
  name text,
  web_url text,
  size_bytes bigint,
  room text,
  motif text,
  time_of_day text,
  quality int,
  issues text,
  has_people boolean not null default false,
  orientation text,
  reel_fit boolean not null default false,
  approved boolean not null default true,
  analyzed_at timestamptz not null default now(),
  used_count int not null default 0,
  last_used_at timestamptz
);
create index if not exists photos_property_idx on photos (property_key, quality desc);

create table if not exists posts (
  id serial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  plan_date date,
  pillar text,
  format text,
  property_key text,
  status text not null default 'planned',
  plan jsonb,
  copy jsonb,
  media jsonb,
  ghl jsonb,
  scheduled_for timestamptz,
  feedback text,
  error text
);
create index if not exists posts_status_idx on posts (status, created_at desc);
create unique index if not exists posts_plan_day_idx on posts (plan_date, format, pillar) where status <> 'rejected';
