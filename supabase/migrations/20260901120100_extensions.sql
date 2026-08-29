-- =============================================================================
-- Cambridge-Ellis School  ·  migration 01 of 18  ·  extensions and primitives
-- =============================================================================
-- Creates no tables. Migration 02 (assets) creates the first one. This file
-- supplies the primitives every later migration and supabase/seed.sql depend
-- on, which is why it must apply cleanly before any of them:
--
--   pgcrypto                     -> extensions.gen_random_uuid()   uuid pk default
--   uuid-ossp                    -> extensions.uuid_generate_v5()  derived row ids
--   public.ces_uuid_namespace()  -> the fixed v5 namespace constant
--   public.ces_uuid()            -> legacy_ref -> uuid, the idempotent load
--   public.set_updated_at()      -> the one updated_at trigger function
--
-- Nothing here is ported. The repository's only legacy migrations are
-- database/migrations/2014_10_12_000000_create_users_table.php and
-- 2019_08_19_000000_create_failed_jobs_table.php, which create Laravel's
-- `users` and `failed_jobs` and hold no site content whatsoever. This folder is
-- their named replacement but is authored from resources/blueprints/**, the 163
-- content entries and content/trees/collections/pages.yaml. Identity belongs to
-- Supabase Auth: auth.users is the account table, and neither legacy table is
-- reproduced.
--
-- PostgreSQL 17, pinned by supabase/config.toml [db] major_version. Every
-- statement below is idempotent, so applying all eighteen migrations twice is
-- clean.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Schema contract for migrations 02-18 — stated once, here, so the other
-- seventeen files have a single place to point at.
-- -----------------------------------------------------------------------------
-- timestamps   `created_at` and `updated_at timestamptz not null default
--              timezone('utc', now())`. Always that explicit UTC form; never a
--              bare now(), never current_timestamp.
-- timezone     Wall-clock content dates are America/New_York and are never
--              converted to UTC. events.event_date is `date`;
--              events.start_time/end_time and promoted.start_time/end_time are
--              `time`. Only structured data and calendar links need an absolute
--              instant, and they compose it in nextjs/lib/timezone.ts, not in
--              SQL.
-- text         `text` throughout, never varchar(n). The blueprints' character
--              limits are enforced by nextjs/lib/schema.ts and the write
--              functions in migration 16, so the legacy corpus loads
--              grandfathered instead of aborting on a check constraint.
-- jsonb        Only where the structure is genuinely variable:
--              page_sections.data, site_globals.value, the per-row `legacy`
--              columns, content_revisions.value_before / value_after, and
--              security_events.detail. Never for a value that has a name.
-- ordering     Child tables carry `sort_order integer not null` with a
--              deferrable, null-safe `unique nulls not distinct (parent_id,
--              sort_order)`: a plain unique index treats null parents as
--              distinct and would let every root share position 1. Every
--              ordering in this project ends with `slug` as its final
--              tie-breaker, because slug is unique per collection and nothing
--              else guarantees a stable order between equal sort keys.
-- booleans     `not null default false` for published, show_in_nav,
--              feature_on_homepage and nav_items.visible; `not null default
--              true` for page_sections.enabled and person_education.enabled.
--              Draft is the safe default for publication: a load error must
--              never publish content.
-- functions    Every function pins `search_path`, and identifiers in a function
--              body are schema-qualified rather than resolved against the
--              caller's path. (pg_catalog stays implicitly searched even under
--              `search_path = ''`, so unqualified built-ins are unambiguous.)
-- case         All SQL in these eighteen files is lowercase.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
-- Both are installed into the `extensions` schema, which is the Supabase
-- convention and where the local stack already places them.
--
-- Because migrations 02-18 pin `search_path = ''` inside their functions, the
-- extensions schema is not on the resolution path there. The project rule is
-- therefore absolute and holds in all seventeen later files: call these
-- functions schema-qualified, as `extensions.gen_random_uuid()` and
-- `extensions.uuid_generate_v5(...)`. An unqualified call inside a pinned
-- function fails at runtime rather than at create time, so it would otherwise
-- ship undetected.
--
-- `if not exists` is a no-op — a notice, not an error — when the extension is
-- already present, which is what makes a second apply clean.

create extension if not exists pgcrypto with schema extensions;

-- The extension name contains a hyphen and must be double-quoted.
create extension if not exists "uuid-ossp" with schema extensions;


-- -----------------------------------------------------------------------------
-- 2. Deterministic row identity
-- -----------------------------------------------------------------------------
-- Source identifiers are heterogeneous and are not uuids: the page tree's first
-- node is the literal string `home` (content/trees/collections/pages.yaml:3)
-- while its own sibling is a uuid, replicator set ids are short random strings
-- such as `OR52n05c`, taxonomy terms are slugs (`teacher`, `leadership`,
-- `board-of-directors`) and assets are paths. `legacy_ref` is therefore `text`,
-- and every target uuid is derived from it rather than generated.
--
-- That derivation is what makes supabase/seed.sql idempotent and lets a child
-- row reference its parent before the parent is inserted: the id is a pure
-- function of (table, legacy_ref) and is identical on every run.

create or replace function public.ces_uuid_namespace()
returns uuid
language sql
immutable
parallel safe
set search_path = ''
as $$ select '840c711d-7f81-4376-b0f3-d4154d606b54'::uuid $$;

-- This constant must never change. Every row id in the database derives from
-- it, so editing it re-keys the entire corpus and breaks every foreign key in
-- supabase/seed.sql along with every id already committed to
-- nextjs/data/fallback/*.json. It is a hard-coded literal on purpose: a table
-- row could be edited, and a set_config/GUC value would be per-session — either
-- would make the derivation non-deterministic across the seed load and later
-- writes.
comment on function public.ces_uuid_namespace() is
  'Fixed uuid v5 namespace for every derived row id. Never change this value: '
  'all ids in the database derive from it.';

create or replace function public.ces_uuid(p_table text, p_legacy_ref text)
returns uuid
language sql
immutable
parallel safe
set search_path = ''
as $$
  select extensions.uuid_generate_v5(
    public.ces_uuid_namespace(),
    p_table || ':' || p_legacy_ref
  )
$$;

-- Scoping: `legacy_ref` is scoped by table, so ces_uuid('pages','home') and
-- ces_uuid('people','home') are different uuids and cannot collide. p_table is
-- the logical table name — pages, people, events, classrooms, promoted,
-- announcements, inspiring_quotes, assets, taxonomy_terms, page_sections,
-- person_education, nav_items, and so on.
--
-- Child identity is derived, never taken from the source. A child row's
-- legacy_ref is `<parent legacy_ref>:<field handle>:<ordinal within that field>`
-- with the ordinal in source order. That is mandatory rather than stylistic: of
-- the 81 `institution` replicator sets, seven carry no source `id` at all;
-- three of the four `quote` sets carry none; and ProseMirror nodes never do.
-- Where a source id does exist it is retained in the row's `legacy.set_id`
-- jsonb for traceability, but it is not the identity.
--
-- `immutable` is required rather than decorative: it lets a later migration use
-- the function in a generated column, an index expression or a check
-- constraint, and lets the planner fold the call.
comment on function public.ces_uuid(text, text) is
  'Derives a stable uuid v5 from (logical table name, legacy_ref). Basis of the '
  'idempotent seed load; scoped by table so one legacy_ref cannot collide '
  'across tables.';

-- Both functions are pure and disclose nothing. The grants are explicit so they
-- survive a later `revoke execute ... from public` hardening pass:
-- supabase/seed.sql loads as service_role, and the write functions in migration
-- 16 call ces_uuid when creating rows.
grant execute on function public.ces_uuid_namespace() to anon, authenticated, service_role;
grant execute on function public.ces_uuid(text, text) to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. The shared updated_at trigger function
-- -----------------------------------------------------------------------------
-- One function, attached `before update on <table> for each row` by every
-- content table (migrations 02, 04, 05, 06, 07, 08, 09, 10, 11, 12 and 13). No
-- application code sets updated_at: neither nextjs/lib/actions/* nor the
-- security definer write functions in migration 16 may touch the column, so the
-- timestamp can be neither forged nor forgotten.
--
-- This corrects a named weakness in the fidelis reference, which declares
-- `updated_at timestamptz not null default timezone('utc', now())` and then
-- creates no trigger anywhere, leaving the column truthful only until the first
-- edit.
--
-- `set timezone = 'utc'` is load-bearing, not decoration. timezone(text,
-- timestamptz) returns `timestamp without time zone` — the UTC wall clock — so
-- assigning it to a timestamptz column re-interprets it in the caller's session
-- TimeZone. A client that had run `set time zone 'America/New_York'` would
-- otherwise store an instant four or five hours off. Pinning the GUC on the
-- function keeps this project's mandated timezone('utc', now()) idiom exact
-- while making it correct for every caller.
--
-- created_at is deliberately untouched: it is a column default only.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
set timezone = 'utc'
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Before-update trigger function maintaining updated_at in UTC. Attached by '
  'every content table; no application code writes the column.';
