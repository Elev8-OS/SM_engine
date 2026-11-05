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

create table if not exists clicks (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  post_id int references posts(id) on delete set null,
  source text,
  is_bot boolean not null default false,
  user_agent text
);
create index if not exists clicks_post_idx on clicks (post_id, created_at desc);
create index if not exists clicks_day_idx on clicks (created_at desc);

-- Paid ads. One row per campaign (one ad set and one ad each at Meta). Status: draft, approved, pushed, active, paused, rejected, ended.
create table if not exists ad_campaigns (
  id serial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'draft',
  kind text not null default 'prospecting',
  property_key text not null references properties(key) on delete cascade,
  post_id int references posts(id) on delete set null,
  name text not null,
  optimize_for text not null default 'INITIATE_CHECKOUT',
  daily_budget_usd numeric(8,2) not null,
  start_date date not null,
  end_date date,
  max_cpa_usd numeric(8,2) not null default 40,
  stop_no_checkout_usd numeric(8,2) not null default 60,
  audience jsonb not null,
  creative jsonb not null,
  checks jsonb,
  approved_at timestamptz,
  meta jsonb,
  feedback text,
  error text
);
create index if not exists ad_campaigns_status_idx on ad_campaigns (status, created_at desc);
create index if not exists ad_campaigns_property_idx on ad_campaigns (property_key, status);
