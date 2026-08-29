-- =============================================================================
-- Cambridge-Ellis School  ·  migration 10 of 18  ·  announcements and quotes
-- =============================================================================
-- Creates exactly two tables: public.announcements and public.inspiring_quotes.
--
-- Neither collection is routable, and that single fact drives most of what this
-- file does and does not contain. content/collections/announcements.yaml is
-- eight lines long and declares `template: default` and `layout: layout` but no
-- `route`; content/collections/inspiring_quotes.yaml is five lines long and
-- declares neither `route` nor `template`. No announcement and no quote has
-- ever had a URL. Both render as components of other pages --
-- components/site/AnnouncementBanner.tsx on the home page, and
-- components/site/InspiringQuote.tsx on the home page and on all 22 flex pages.
-- Two consequences follow directly and both are load-bearing for later work:
--
--   * neither table contributes anything to the content_routes view in
--     migration 15, and neither must be added to it;
--   * neither carries seo_title / seo_description / og_image_id. The SEO trio
--     belongs to the four routable tables -- pages, people, events and
--     classrooms -- because only a row with a URL can have a canonical link, a
--     meta description or an Open Graph image. See the closing note.
--
-- Sources of truth for the field sets, read rather than assumed:
--
--   resources/blueprints/collections/announcements/announcements.yaml
--                                   52 lines. `title` (line 7) is type text
--                                   with validate: [required] at lines 11-12
--                                   and character_limit: 30 at line 16 -- see
--                                   section 2, which is the most important
--                                   section in this file. `link` (line 19) is
--                                   type entries with max_items: 1 (line 21),
--                                   collections: [pages] (lines 24-25), mode
--                                   select and create: false; it carries no
--                                   validate key, so it is a single NULLABLE
--                                   foreign key to public.pages.
--                                   `feature_on_homepage` (line 32) is a toggle
--                                   with default: false (line 34). The sidebar
--                                   declares `slug` (line 44) as required with
--                                   validate: [required,
--                                   'unique_entry_value:{collection},{id},{site}'].
--   resources/blueprints/collections/inspiring_quotes/inspiring_quotes.yaml
--                                   34 lines. `title` (line 7) is type text
--                                   with validate: [required] -- this is the
--                                   field that becomes the `quote` column; see
--                                   the rename below. `attribution` (line 14)
--                                   is type text with no validate key and is
--                                   therefore nullable. The sidebar declares
--                                   `slug` (line 27) as required. The file
--                                   declares NO character_limit on any field.
--   content/collections/announcements.yaml
--                                   title Announcements, revisions: false,
--                                   sort_dir: asc, and a date_behavior block
--                                   that is inert. See the closing note on both
--                                   sort_dir and date_behavior.
--   content/collections/inspiring_quotes.yaml
--                                   title 'Inspiring Quotes', revisions: false,
--                                   and the same inert date_behavior block.
--   content/collections/announcements/*.md
--                                   4 entries, 3 of them drafts. Every title
--                                   length, the publish flags, the
--                                   feature_on_homepage flags and the dangling
--                                   link below were measured by parsing the
--                                   front matter of all four, not inferred.
--   content/collections/inspiring_quotes/*.md
--                                   5 entries, 0 drafts. All five carry an
--                                   attribution. Not one of the nine entries
--                                   across both collections carries a `slug:`
--                                   key.
--
-- artifacts/corpus-census.json keeps every count above reproducible now that
-- content/ has been deleted -- and on this branch it already has been, which is
-- why the `comment on column` statements in section 8 are written as the
-- durable record rather than as decoration.
--
-- ONE FIELD IS RENAMED, for a stated reason:
--
--   title -> quote   on inspiring_quotes only. The source handle is Statamic's
--                    generic entry title; the value it holds is the quotation
--                    itself. announcements.title keeps its name because there
--                    the handle and the meaning agree.
--
-- ONE SOURCE-INTEGRITY CASE LIVES IN THIS FILE, and it is resolved by
-- nullability rather than by coercion. See the link_page_id column comment in
-- section 8 for the full record; the short form is that one of the four
-- announcements points at an entry id that no entry in the corpus holds, and
-- the column is nullable precisely so that row loads instead of aborting the
-- canonical load or being silently dropped.
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   policies          migration 17. RLS is ENABLED on both tables here and ZERO
--                     policies are written, so both are closed until 17 opens
--                     them. For announcements that matters more than usual:
--                     three of the four migrated rows are unpublished.
--   write functions   migration 16, which owns create-entry, update-text,
--                     set-published and delete-entry together with the
--                     capability checks, the optimistic conflict check, the
--                     content_revisions writes -- and the character_limit
--                     enforcement this file deliberately does not express as a
--                     check constraint.
--   banner switch     migration 11. site_globals.banner_enabled and
--                     banner_variant are presentation and live there; the
--                     announcement text and its target live here. See the
--                     table comment on ownership in section 8.
--   content_routes    migration 15 -- and it must include neither table.
--   the seed rows     supabase/seed.sql, generated by
--                     tools/src/extract-statamic-content.ts. This file creates
--                     structure only and inserts nothing.
--
-- Every statement is idempotent -- `create table if not exists`, `create index
-- if not exists`, `drop constraint if exists` before `add constraint`, and
-- `drop trigger if exists` before `create trigger` -- so applying all eighteen
-- migrations twice is clean. Conventions (lowercase SQL, `text` never
-- varchar(n), the explicit timezone('utc', now()) timestamp form, and jsonb
-- only where the structure is genuinely variable) are stated once in migration
-- 01 and followed here.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. public.announcements
-- -----------------------------------------------------------------------------
-- The site-wide announcement banner. Four migrated rows, and the feature they
-- drive is currently invisible on the live site -- not because it is broken but
-- because of the publish flags, which migrate exactly as they are. Measured
-- across the four entries: exactly one is published, and that one carries
-- `feature_on_homepage: false`; all three that carry `true` are drafts. The
-- banner therefore never appears today. It is built here so that it works the
-- moment staff publish one of those three, which is what "no content or
-- functionality is lost" requires: preserving a dormant feature's data and its
-- dormancy, rather than publishing rows to make a feature demonstrable.
--
-- Column-by-column rationale is carried in the `comment on column` statements
-- in section 8 rather than duplicated here.

create table if not exists public.announcements (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule. Seeded rows do not rely on this default -- they derive their
  -- id from public.ces_uuid('announcements', legacy_ref), which is what makes
  -- the load idempotent -- so the default serves editor-created rows.
  id                   uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id. text rather than uuid, per the schema-wide contract in
  -- migration 01: legacy_ref is heterogeneous across tables and scoped by
  -- table, so announcements:<id> cannot collide with a page.
  legacy_ref           text unique,

  -- Derived from the entry FILENAME, not from front matter: no announcement
  -- entry carries a `slug:` key. See the column comment.
  slug                 text not null unique,

  -- Required by the blueprint (validate: [required] at lines 11-12). NO LENGTH
  -- CHECK -- section 2 carries the measured evidence and it is the single most
  -- consequential decision in this file.
  title                text not null,

  -- The optional banner target, and the file's source-integrity case. NULLABLE
  -- by design, not by omission: one of the four source rows points at an entry
  -- id that no entry in the corpus holds. `on delete set null` so a later page
  -- deletion costs the banner its link and not the announcement itself.
  link_page_id         uuid references public.pages (id) on delete set null,

  -- Mirrors the blueprint's own `default: false` at line 34.
  feature_on_homepage  boolean not null default false,

  -- Draft is the safe default: a load error must never publish content.
  published            boolean not null default false,

  -- The queryable retention column. For this table it holds the raw dangling
  -- link id, plus any undeclared key a future source edit introduces. Nothing
  -- else -- neither table has a rich-text field, so this is the only jsonb
  -- here.
  legacy               jsonb not null default '{}'::jsonb,

  -- Migrated provenance, held verbatim and never overwritten by the
  -- operational timestamps below.
  source_updated_at    timestamptz,
  source_updated_by    text,

  -- Operational timestamps describing target writes. `updated_at` is
  -- maintained exclusively by the trigger in section 4; no application code
  -- writes it.
  created_at           timestamptz not null default timezone('utc', now()),
  updated_at           timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Check constraints on public.announcements: there are none, and that is a
--    decision
-- -----------------------------------------------------------------------------
-- THERE IS DELIBERATELY NO LENGTH CHECK ON `title`. This is the one line in
-- this file most likely to be "corrected" by someone who has just read the
-- blueprint, and the correction would abort the canonical seed load on its
-- first row, so the evidence is recorded here rather than left to a commit
-- message.
--
-- resources/blueprints/collections/announcements/announcements.yaml declares
-- `character_limit: 30` on title at line 16. Measured against the corpus, the
-- four title values are:
--
--    69  'Tickets now on Sale for our Annual Auction and Community Celebration!'
--    56  'Summer Camp 2023 Registration Opens to the Public, 2/15!'
--    55  'Now Accepting Applications for the 2025-26 School Year!'
--    44  'Summer Camp registration is now open to all!'
--
-- Every single one violates the declared limit, by between 14 and 39
-- characters. `check (char_length(title) <= 30)` would therefore reject all
-- four rows and abort supabase/seed.sql outright.
--
-- These four are four of the six grandfathered rows in the whole corpus. The
-- other two are the umbrella `short_description` values at 379 and 606
-- characters against a `character_limit: '300'`; migration 04 records that case
-- and also records that AAP sections 0.4.2 and 0.5.1 mis-attribute that limit
-- to `description`, which declares none. Either reading yields the same
-- instruction for this file.
--
-- The limit is real and it IS enforced, just not here and not against history:
-- nextjs/lib/schema.ts holds it, the editor's character counter surfaces it
-- live, and the migration 16 write functions apply it on every create and every
-- edit. The seed load is exempt, and each over-length row is listed in
-- artifacts/parity-report.json for the school to shorten at leisure. So a
-- staff member cannot save a 40-character title tomorrow, while the four
-- historical rows load untouched today -- which is the only reading of "no
-- content is lost" that also honours the blueprint.
--
-- For the same reason there is no check on any other column of either table:
--
--   * no format check on `slug`. It is derived by the extractor from a filename
--     that Statamic itself produced, and the unique constraint is the property
--     that actually matters.
--   * no check that `link_page_id` is populated. That is the whole point of the
--     source-integrity resolution; see section 8.
--   * no check on inspiring_quotes.quote or .attribution. That blueprint
--     declares no character_limit at all, so there is not even a limit to
--     grandfather.
--
-- Both `slug` and `legacy_ref` are already constrained unique inline in
-- sections 1 and 6, which is where the uniqueness this table needs lives; those
-- constraints also create the unique indexes, so section 5 does not repeat
-- them.
--
-- No `alter table ... add constraint` statement appears in this file at all.
-- That is deliberate and complete, not an unfinished section.


-- -----------------------------------------------------------------------------
-- 3. Row level security on public.announcements
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies, neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table where three of four rows are
-- unpublished.
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that
-- load.
--
-- Migration 17 owns the policy set. For this table it is the standard content
-- shape: `anon` gets `select` where published = true; `authenticated` gets
-- `select` over everything ONLY with an active admin_users membership AND aal2,
-- and otherwise sees exactly what anon sees; and direct DML is REVOKED from
-- `authenticated` entirely, so every write goes through a security definer
-- function in migration 16. A draft is not fetched and then hidden -- it is not
-- returned.

alter table public.announcements enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger on public.announcements
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, which names this
-- migration among its callers. `updated_at` therefore cannot be forged and
-- cannot be forgotten: no application code and no write function in migration
-- 16 may set the column.
--
-- `created_at` is deliberately left as a column default only, and
-- `source_updated_at` is deliberately untouched by this trigger -- it holds
-- migrated provenance and must survive every later edit.

drop trigger if exists set_announcements_updated_at on public.announcements;

create trigger set_announcements_updated_at
  before update on public.announcements
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes on public.announcements
-- -----------------------------------------------------------------------------
-- `slug` and `legacy_ref` are already indexed by their inline unique
-- constraints and are not repeated here. Each index below backs a named access
-- path rather than being added speculatively.

-- Every foreign key gets an index, which is the project rule stated
-- unconditionally in migration 04. This one also backs the reference check that
-- blocks or reports a page deletion: a page cannot be deleted while rows point
-- at it without the editor first listing those rows, and migration 16's
-- delete-entry path scans by page id to build that list.
create index if not exists announcements_link_page_id_idx
  on public.announcements (link_page_id);

-- The composite that actually serves the banner. AnnouncementBanner issues one
-- query -- `where published = true and feature_on_homepage = true limit 1` --
-- and this index answers it from the index alone. `published` leads because
-- migration 17's RLS policy is itself a predicate on that column, so it is the
-- selective term on every anonymous read.
create index if not exists announcements_published_feature_idx
  on public.announcements (published, feature_on_homepage);

-- The two single-column indexes below are partly redundant against the
-- composite above -- `published` is its leading column, so the composite
-- already serves a `published`-only lookup -- and they are declared anyway, for
-- the same reason migration 04 declares its parent_id index alongside a
-- constraint that already covers it: the collection surface at
-- /admin/collections/announcements filters on each flag independently, the cost
-- on a four-row table is nil, and a future change to the composite would
-- otherwise silently remove the only index behind a documented access path.
create index if not exists announcements_published_idx
  on public.announcements (published);

create index if not exists announcements_feature_on_homepage_idx
  on public.announcements (feature_on_homepage);


-- -----------------------------------------------------------------------------
-- 6. public.inspiring_quotes
-- -----------------------------------------------------------------------------
-- The rotating sidebar quotation. Five migrated rows, none of them a draft --
-- the only collection in the corpus with no draft at all -- so unlike the
-- banner above, this feature is live today and must stay live.
--
-- Selection is RANDOM PER REQUEST. The legacy templates issue
-- `{{collection:inspiring_quotes sort="random" limit="1"}}` twice, and the
-- target reproduces that behaviour in components/site/InspiringQuote.tsx by
-- selecting from the cached list on each render. Nothing in this DDL enforces
-- or expresses it, and nothing should: there is no `featured` flag, no
-- `sort_order`, no `weight` and no `last_shown_at` column, because the
-- selection is a property of the render and not of the data. The note is here
-- so that a reader who finds a table with no ordering column does not conclude
-- one was forgotten -- see also the closing note.

create table if not exists public.inspiring_quotes (

  -- Identity, on the same contract as announcements above. Seeded rows derive
  -- their id from public.ces_uuid('inspiring_quotes', legacy_ref).
  id                   uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id, scoped by table.
  legacy_ref           text unique,

  -- Derived from the entry FILENAME: no quote entry carries a `slug:` key
  -- either. The five filenames are long because Statamic derived them from the
  -- quotation text itself.
  slug                 text not null unique,

  -- THE RENAME. The source handle is `title` (blueprint line 7, validate:
  -- [required]); the value is the quotation. Naming the column `quote` is the
  -- whole point -- see the column comment, and note that this table has NO
  -- `title` column by design.
  quote                text not null,

  -- Who said it. The blueprint declares no validate key, so nullable -- though
  -- all five migrated rows populate it.
  attribution          text,

  -- Draft is the safe default here too, even though all five source rows are
  -- published: the default describes what happens to a row created without an
  -- explicit flag, not what the corpus contains.
  published            boolean not null default false,

  -- The queryable retention column. Empty for all five migrated rows -- this
  -- blueprint has no undeclared drift -- and present so that a future source
  -- key cannot be dropped silently.
  legacy               jsonb not null default '{}'::jsonb,

  -- Migrated provenance, held verbatim.
  source_updated_at    timestamptz,
  source_updated_by    text,

  -- Operational timestamps. `updated_at` is maintained exclusively by the
  -- trigger in section 7.
  created_at           timestamptz not null default timezone('utc', now()),
  updated_at           timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 7. Row level security, trigger and indexes on public.inspiring_quotes
-- -----------------------------------------------------------------------------
-- Same contract as sections 3, 4 and 5: RLS enabled with zero policies until
-- migration 17, the shared trigger from migration 01 attached, and only the
-- indexes that back a named access path. No check constraints -- this blueprint
-- declares no character_limit on any field, so there is not even a limit to
-- grandfather.

alter table public.inspiring_quotes enable row level security;

drop trigger if exists set_inspiring_quotes_updated_at on public.inspiring_quotes;

create trigger set_inspiring_quotes_updated_at
  before update on public.inspiring_quotes
  for each row
  execute function public.set_updated_at();

-- `slug` and `legacy_ref` are already indexed by their inline unique
-- constraints. `published` is the only other access path: InspiringQuote reads
-- the published set to select from, and migration 17's policy is a predicate on
-- this column.
create index if not exists inspiring_quotes_published_idx
  on public.inspiring_quotes (published);



-- -----------------------------------------------------------------------------
-- 8. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. content/, resources/ and public/assets/ are
-- removed by the end of the migration phase -- on this branch they are already
-- gone -- so after cutover the database itself is the only place a reader can
-- learn why a column exists, where its values came from, or what a value means.

comment on table public.announcements is
  'The 4 announcement entries from content/collections/announcements, '
  'normalized. NOT a routable collection: '
  'content/collections/announcements.yaml declares no `route`, so no '
  'announcement has ever had a URL, this table contributes nothing to the '
  'content_routes view in migration 15, and it carries no SEO columns. '
  'Rendered by components/site/AnnouncementBanner.tsx on the home page. '
  'OWNERSHIP, stated so it is not split: this table owns the announcement '
  'itself -- its text, its target and its flags -- and the globals panel''s '
  'Announcement Presentation tab owns only the banner''s presentation, namely '
  'site_globals.banner_enabled and banner_variant (migration 11). That tab '
  'links through to this collection for the text and the target rather than '
  'duplicating either. One owner, one editing path: a staff member never has '
  'to guess which of two screens changes the words on the banner.';

comment on column public.announcements.id is
  'Primary key. Seeded rows derive theirs from '
  'public.ces_uuid(''announcements'', legacy_ref) so the load is idempotent; '
  'the default serves editor-created rows.';

comment on column public.announcements.legacy_ref is
  'The source entry id from the Statamic front matter -- all four are uuids '
  'here, but the column is text because legacy_ref is text schema-wide: '
  'migration 01 derives every target id from (logical table name, legacy_ref) '
  'and source identifiers elsewhere in the corpus include the bare string '
  '"home", short replicator set ids and taxonomy slugs. Scoped by table, so an '
  'announcement id cannot collide with a page. Null on editor-created rows.';

comment on column public.announcements.slug is
  'Derived from the entry FILENAME, never from front matter: not one of the 4 '
  'announcement entries carries a `slug:` key, because Statamic derives it '
  'from the file name. The blueprint does declare a slug field (line 44, '
  'required, with unique_entry_value validation), which is why this column '
  'exists and is unique -- the value simply lives in the filename rather than '
  'in the document. Unique per collection, and the final tie-breaker on any '
  'ordering of this table, since it carries no sort_order.';

comment on column public.announcements.title is
  'The announcement text shown in the banner. Required by the blueprint '
  '(validate: [required], lines 11-12). DELIBERATELY CARRIES NO LENGTH CHECK, '
  'even though the blueprint declares character_limit: 30 at line 16: the four '
  'migrated values measure 69, 56, 55 and 44 characters, so every one of them '
  'violates that limit and a check constraint here would abort the canonical '
  'seed load on its first row. The limit is instead held in '
  'nextjs/lib/schema.ts, surfaced live by the editor''s character counter, and '
  'enforced by the migration 16 write functions on every create and edit, '
  'while the historical rows load grandfathered and are listed in '
  'artifacts/parity-report.json for the school to shorten at leisure. See '
  'section 2 before adding a constraint here.';

comment on column public.announcements.link_page_id is
  'Optional banner target: the page the announcement links to. From the '
  'blueprint''s `link` field (line 19), an entries field with max_items: 1 and '
  'collections: [pages], which is why this is a single foreign key to '
  'public.pages rather than a join table or an array. '
  'NULLABLE BY DESIGN, and this is one of the three named source-integrity '
  'cases in the migration. '
  'content/collections/announcements/2023-24-admissions-season-now-open-apply-today.md '
  'line 5 carries link: 53cf3d97-1b19-4551-a080-30b69ec56ef6, and no entry '
  'anywhere in the corpus holds that id -- every id: key in '
  'content/collections was scanned to confirm it. The other three links all '
  'resolve, and all three resolve to pages entries: '
  'a1104c2b-9a1c-4e71-a25b-cdab3a77e936 to pages/apply.md, '
  '21904ad8-20a4-4672-a6eb-51204901e0e7 to pages/summer-programs.md, and '
  '7c9e5336-9d8b-40d0-b884-0e0e0712dcff to pages/auction.md. The resolution '
  'is therefore: the dangling row loads with this column NULL, the raw id is '
  'retained in legacy.link, the banner renders that announcement WITHOUT a '
  'link, and the case is reported in artifacts/parity-report.json. The three '
  'alternatives were each rejected as worse: coercing the id to some valid '
  'page invents an editorial decision, dropping the row loses content, and '
  'making this column NOT NULL fails the load. `on delete set null` rather '
  'than cascade for the same reason -- deleting the target page must cost the '
  'banner its link, never the announcement.';

comment on column public.announcements.feature_on_homepage is
  'Whether this announcement is eligible for the home page banner, from the '
  'blueprint''s toggle at line 32 whose own `default: false` at line 34 this '
  'column default mirrors. AnnouncementBanner selects `where published = true '
  'and feature_on_homepage = true limit 1`, which the '
  'announcements_published_feature_idx composite serves. Measured across the '
  'four migrated rows: three carry true and all three of those are drafts, '
  'while the single published row carries false. The banner consequently never '
  'renders today -- dormant by publish state, not broken -- and starts working '
  'the moment staff publish one of the three.';

comment on column public.announcements.published is
  'Publish state, migrated exactly. 3 of the 4 rows are drafts. Default false '
  'because a load error must never publish content. Authoritative and enforced '
  'server-side: migration 17 restricts anonymous select to published = true, '
  'so a draft announcement is not fetched and then hidden -- it is never '
  'returned.';

comment on column public.announcements.legacy is
  'Queryable retention for anything the typed columns above do not carry. For '
  'the migrated corpus it holds exactly one thing: legacy.link on the '
  'dangling-reference row, preserving '
  '53cf3d97-1b19-4551-a080-30b69ec56ef6 verbatim so the raw source value '
  'survives in the database and not merely in a report. Retention is here '
  'rather than only in nextjs/data/fallback/*.json so that parity is verified '
  'against the live schema and a later decision to normalize a key is a '
  'migration rather than a re-extraction.';

comment on column public.announcements.source_updated_at is
  'The entry''s own updated_at from the Statamic front matter, held verbatim. '
  'Distinct from the operational updated_at below and never overwritten by it: '
  'defaulting the target timestamp to load time would destroy the editorial '
  'history of all four rows.';

comment on column public.announcements.source_updated_by is
  'The entry''s own updated_by, mapped from the two known Statamic user ids to '
  'their email addresses -- 1179db75-8eeb-4bad-8e60-d5005aef7ef8 to '
  'bekah@cambridge-ellis.org and b863e707-3140-4001-859f-3487e09c5881 to '
  'conrad.fulbrook@gmail.com -- and held verbatim for anything unrecognized. '
  'All four announcement entries carry the former. text rather than a foreign '
  'key to auth.users on purpose: these are Statamic identities, and Supabase '
  'Auth accounts are created fresh by invitation (migration 13), so no target '
  'row corresponds to them.';

comment on column public.announcements.created_at is
  'When this row was written to the target database. Operational, not '
  'migrated; see source_updated_at for the editorial timestamp.';

comment on column public.announcements.updated_at is
  'Maintained exclusively by the set_announcements_updated_at trigger, so it '
  'can be neither forged nor forgotten. No application code and no migration '
  '16 write function sets this column.';

comment on table public.inspiring_quotes is
  'The 5 inspiring-quote entries from content/collections/inspiring_quotes, '
  'normalized. NOT a routable collection: '
  'content/collections/inspiring_quotes.yaml declares neither `route` nor '
  '`template`, so no quote has ever had a URL, this table contributes nothing '
  'to the content_routes view in migration 15, and it carries no SEO columns. '
  'Rendered by components/site/InspiringQuote.tsx, which the home page and all '
  '22 flex pages share. SELECTION IS RANDOM PER REQUEST, reproducing the '
  'legacy `{{collection:inspiring_quotes sort="random" limit="1"}}` by '
  'selecting from the cached list on each render -- which is one of the '
  'reasons pages render per request rather than being statically cached. '
  'Nothing in this table expresses that: there is no featured flag, no '
  'sort_order and no last_shown_at, because the choice belongs to the render '
  'and not to the data. All 5 rows are published; this is the only collection '
  'in the corpus with no draft.';

comment on column public.inspiring_quotes.id is
  'Primary key. Seeded rows derive theirs from '
  'public.ces_uuid(''inspiring_quotes'', legacy_ref) so the load is '
  'idempotent; the default serves editor-created rows.';

comment on column public.inspiring_quotes.legacy_ref is
  'The source entry id from the Statamic front matter. text and scoped by '
  'table, on the same schema-wide contract as every other legacy_ref. Null on '
  'editor-created rows.';

comment on column public.inspiring_quotes.slug is
  'Derived from the entry FILENAME, never from front matter: not one of the 5 '
  'quote entries carries a `slug:` key. The filenames are unusually long '
  'because Statamic derived them from the quotation text -- the longest runs to '
  'the full 162-character opening of the "our heritage and ideals" quote -- '
  'which is a cosmetic consequence of the source and not a reason to '
  'regenerate them, since a slug change would be a content change on a '
  'collection whose slugs are not even addressable.';

comment on column public.inspiring_quotes.quote is
  'The quotation text. RENAMED from the source handle, which is `title` '
  '(blueprint line 7, type text, validate: [required]): the handle is '
  'Statamic''s generic entry title, while the value is the quotation itself, '
  'so the column is named for what it holds. This table therefore has NO '
  '`title` column, deliberately -- a reader looking for one is looking for '
  'this. The rename is recorded in the field-level source mapping and asserted '
  'by tools/src/verify-parity.ts, which checks all five values arrive here.';

comment on column public.inspiring_quotes.attribution is
  'Who the quotation is attributed to. Nullable, because the blueprint (line '
  '14) declares no validate key -- though all 5 migrated rows populate it. '
  'Rendered beneath the quote in the --text-quote role.';

comment on column public.inspiring_quotes.published is
  'Publish state, migrated exactly. All 5 rows are published, so this table '
  'has no drafts at all. The default is nevertheless false, because a default '
  'describes a row created without an explicit flag rather than the contents '
  'of the corpus, and a load error must never publish content.';

comment on column public.inspiring_quotes.legacy is
  'Queryable retention for anything the typed columns do not carry. Empty for '
  'all 5 migrated rows: this is one of the few blueprints in the corpus with '
  'no undeclared drift, every source key mapping to a column above. Present so '
  'that a future source key cannot be dropped silently.';

comment on column public.inspiring_quotes.source_updated_at is
  'The entry''s own updated_at from the front matter, held verbatim and never '
  'overwritten by the operational updated_at.';

comment on column public.inspiring_quotes.source_updated_by is
  'The entry''s own updated_by, mapped from the two known Statamic user ids to '
  'their email addresses and held verbatim for anything unrecognized. text '
  'rather than a foreign key to auth.users, for the reason given on the '
  'announcements column of the same name.';

comment on column public.inspiring_quotes.created_at is
  'When this row was written to the target database.';

comment on column public.inspiring_quotes.updated_at is
  'Maintained exclusively by the set_inspiring_quotes_updated_at trigger.';


-- -----------------------------------------------------------------------------
-- A note on six deliberate absences
-- -----------------------------------------------------------------------------
-- Each of these is the kind of thing a later reader is likely to add, believing
-- it was forgotten. None of them was.
--
-- 1. NO length check on announcements.title, and no check constraint anywhere
--    in this file. The four migrated titles are 69, 56, 55 and 44 characters
--    against a declared character_limit of 30, so a check would abort the
--    canonical seed load on its first row. Section 2 carries the full evidence
--    and the enforcement path that replaces it. This is the single most likely
--    mistake in this file.
--
-- 2. NO `not null` on announcements.link_page_id. One of the four source rows
--    points at an entry id no entry holds; nullability is what lets that row
--    load with its raw value preserved in legacy.link. See the column comment
--    in section 8.
--
-- 3. NO `sort_order` on either table. This is a stated design decision, not an
--    oversight: neither collection has any public order. One announcement is
--    SELECTED -- `where published = true and feature_on_homepage = true limit
--    1` -- and one quote is chosen at RANDOM per request. Reordering is
--    genuinely not uniform across this schema: pages, people, classrooms and
--    promoted carry sort_order and are manually orderable; events order by
--    event_date; and these two order by nothing, because nothing consumes an
--    order. The collection surface at /admin/collections/<collection>
--    consequently offers sorting for the admin's own convenience and NO public
--    reorder control for these two, and
--    nextjs/tests/e2e/admin-collections.spec.ts asserts the ABSENCE of that
--    control for exactly these two while asserting its presence for the other
--    five. Adding a column here would make that test a lie and would promise a
--    control with nothing behind it.
--
-- 4. NO seo_title, seo_description or og_image_id, on either table. Neither
--    collection config declares a `route`, so no row here has a URL. A
--    canonical link, a meta description and an Open Graph image are all
--    properties of a page, and the SEO trio therefore belongs to the four
--    routable tables only: pages, people, events and classrooms. Adding it
--    here would be dead weight that nextjs/app/sitemap.ts and generateMetadata
--    could never read, and would imply these collections are routable when
--    migration 15 must exclude both.
--
-- 5. NO reproduction of date_behavior, and none of sort_dir either. Both
--    collection configs set `date_behavior: {past: public, future: private}`,
--    and that setting is INERT: neither collection is declared `dated`,
--    neither blueprint has a date field at all, and no entry carries an
--    entry-level `date:` key -- all nine were checked. Runtime confirms the
--    same conclusion on the sibling events collection, where a future-dated
--    published entry resolves 200 while an unpublished one 404s. Publish state
--    alone governs visibility, in the legacy site and here. So there is no
--    check, no generated column, and migration 17 adds no date predicate to
--    either policy. content/collections/announcements.yaml additionally sets
--    `sort_dir: asc` with no `sort_by` alongside it, which orders nothing that
--    any template reads -- see absence 3.
--
-- 6. NO seed rows. This file creates structure only. supabase/seed.sql,
--    generated by tools/src/extract-statamic-content.ts, is the canonical load,
--    and it is idempotent on legacy_ref. After it runs the expected state is:
--    4 announcements, of which 3 have published = false; exactly 1 with a null
--    link_page_id and a populated legacy.link; exactly 1 published, and that
--    one carrying feature_on_homepage = false; and 3 carrying
--    feature_on_homepage = true, all 3 of them drafts. Plus 5
--    inspiring_quotes, every one published, every one with a non-null
--    attribution, and none with a `title` column to populate.
--    tools/src/verify-parity.ts asserts each of those.
-- =============================================================================

