-- =============================================================================
-- Cambridge-Ellis School  ·  migration 09 of 18  ·  promoted
-- =============================================================================
-- Creates exactly two tables: public.promoted and public.promoted_links.
--
-- `promoted` is the home page's promotional carousel. It is NOT a routable
-- collection: content/collections/promoted.yaml is five lines long and declares
-- neither `route` nor `template`, so no promoted entry has ever had a URL. It
-- renders as a component of the home page (components/site/PromotedCarousel.tsx)
-- rather than as a page of its own. Two consequences follow directly and both
-- are load-bearing for later migrations:
--
--   * this table contributes NOTHING to the content_routes view in migration
--     15, and must not be added to it;
--   * it carries NO seo_title / seo_description / og_image_id. The SEO trio
--     belongs to the four routable tables — pages, people, events and
--     classrooms — because only a row with a URL can have a canonical link, a
--     meta description or an Open Graph image. See the closing note.
--
-- Sources of truth for the field set, read rather than assumed:
--
--   resources/blueprints/collections/promoted/promoted.yaml
--                                   152 lines. `title` (line 6) and `image`
--                                   (line 126) are the only required fields —
--                                   validate: [required] at lines 10-11 and
--                                   141-142 respectively. The `add_link`
--                                   replicator (line 13) is capped at
--                                   `max_sets: 1` (line 52) and its two
--                                   children, link_title (lines 33-34) and
--                                   link_address (lines 44-45), are each
--                                   required. Everything else — subtitle
--                                   (54), date_of_event (65), start_time (82),
--                                   end_time (93), address (104),
--                                   summary_or_additional_info (115) — carries
--                                   no validate key and is therefore nullable.
--                                   The file declares NO character_limit on
--                                   any field.
--   content/collections/promoted.yaml
--                                   title: Promoted, revisions: false, and a
--                                   date_behavior block that is inert. See the
--                                   note on date_behavior below.
--   content/collections/promoted/*.md
--                                   12 entries. All 12 are drafts, all 12
--                                   carry both title and image, exactly ONE
--                                   carries an add_link set, and not one
--                                   carries a `slug:` key or an entry-level
--                                   `date:` key. Counts verified by parsing
--                                   the front matter, not inferred from the
--                                   blueprint; artifacts/corpus-census.json
--                                   keeps them reproducible after content/ is
--                                   deleted.
--
-- Three fields are renamed on the way in, each for a stated reason:
--
--   date_of_event              -> event_date   aligns with events.event_date so
--                                              one date helper in
--                                              nextjs/lib/timezone.ts serves
--                                              both tables.
--   summary_or_additional_info -> summary      the source handle encodes UI
--                                              guidance to the editor, not the
--                                              meaning of the value.
--   link_address               -> link_url     it holds a URL.
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   policies          migration 17. RLS is ENABLED on both tables here and
--                     ZERO policies are written, so both are closed until 17
--                     opens them. That matters more than usual for this table:
--                     all twelve migrated rows are unpublished.
--   write functions   migration 16, which owns create-entry, update-text,
--                     update-media, set-published, reorder-entries and
--                     delete-entry, together with the capability checks, the
--                     optimistic conflict check and the content_revisions
--                     writes. No DML here.
--   url validation    nextjs/lib/schema.ts and the migration 16 write
--                     functions. See section 2 for why link_url carries no
--                     check constraint.
--   content_routes    migration 15 — and it must not include this table.
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
-- 1. public.promoted
-- -----------------------------------------------------------------------------
-- Column-by-column rationale is carried both inline below and in the
-- `comment on column` statements in section 9, because those comments survive
-- into the database and remain readable once content/ has been deleted.

create table if not exists public.promoted (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule; an unqualified call would fail at runtime, not at create
  -- time. Seeded rows do not rely on this default -- they derive their id from
  -- public.ces_uuid('promoted', legacy_ref), which is what makes the load
  -- idempotent and lets promoted_links reference a parent before it is
  -- inserted -- so the default serves editor-created rows.
  id                 uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id from the .md front matter, e.g.
  -- 8b87e474-816a-435f-ab1e-5d5e42f22e45. Nullable: a promotion the school
  -- creates later has no source to derive from. Postgres treats nulls as
  -- distinct under a unique constraint, so any number of editor-created rows
  -- coexist while no two migrated rows can collide.
  legacy_ref         text unique,

  -- Derived from the FILENAME, not from a field. This is the one column whose
  -- nullability a later reader is most likely to "fix" wrongly, so the
  -- reasoning is recorded here as well as in its column comment: the sidebar
  -- `slug` field at promoted.yaml line 147 carries NO `validate` key, unlike
  -- every other collection in this project, and none of the twelve entries
  -- carries a `slug:` key at all. NOT NULL is still correct, because Statamic
  -- derives the slug from the entry's file name and a file always has one.
  -- The missing validate is not licence to make this nullable.
  slug               text not null unique,

  -- promoted.yaml line 6: type text, required: true, validate: [required].
  -- Present on all 12 source entries, so the constraint is satisfiable by the
  -- canonical seed rather than a load-blocker.
  title              text not null,

  -- Nullable, all three: type textarea with no validate key. Present on 8, 5
  -- and 6 of the 12 entries respectively.
  subtitle           text,
  address            text,
  summary            text,

  -- Renamed from date_of_event. `date`, never timestamptz: the source value is
  -- a bare wall-clock day ('2024-04-27') with no zone, the project contract is
  -- America/New_York, and only structured data and calendar links need an
  -- absolute instant -- they compose one in nextjs/lib/timezone.ts. Nullable:
  -- present on 8 of 12.
  event_date         date,

  -- `time`, never timetz, for the same reason. Present on 5 of 12. The source
  -- values are ambiguous 12-hour readings and are preserved verbatim; see the
  -- note in section 2 on why there is no ordering check.
  start_time         time,
  end_time           time,

  -- NOT NULL. promoted.yaml lines 141-142 declare validate: [required] on the
  -- `image` field, and all 12 source entries carry one -- this is the only
  -- mandatory asset reference in the whole schema.
  --
  -- No `on delete` action, deliberately, and migration 02's closing note fixes
  -- the same contract from the other side. Deleting an asset that any row still
  -- references is BLOCKED, and the editor answers by listing the referencing
  -- rows. `on delete set null` is not merely undesirable here but impossible,
  -- because the column is NOT NULL -- and silently nulling a required image
  -- would be worse than refusing the delete anyway. `on delete cascade` would
  -- let removing one photograph delete the promotion that displays it.
  -- Replacement is an atomic swap inside one transaction in migration 16.
  image_asset_id     uuid not null references public.assets (id),

  -- Draft is the safe default for publication: a load error must never publish
  -- content. All 12 migrated rows are `published: false`, which is why the
  -- carousel renders zero slides on day one -- a feature dormant by publish
  -- state, not a broken one. Preserving that is part of "no content lost";
  -- publishing them to make the feature visible would be a content change
  -- nobody asked for.
  published          boolean not null default false,

  -- This collection IS manually orderable, unlike announcements and
  -- inspiring_quotes which have no public order at all. The carousel renders
  -- published rows ordered by sort_order then `slug` as the final tie-breaker,
  -- per the project rule that every ordering ends with slug. The legacy
  -- {{collection:promoted}} tag declares no sort whatsoever, so today's order
  -- is incidental and the seed assigns source order.
  --
  -- No unique constraint: see the index in section 5 for the reasoning.
  sort_order         integer not null,

  -- The one jsonb column on this table, and it holds exactly one key on
  -- exactly one row: the undeclared scalar `link` that
  -- new-k-3rd-grade-mandarin-...-today.md carries alongside its add_link set.
  -- The blueprint declares add_link, not link, so the scalar is retained
  -- queryably rather than guessed at, and it is NOT rendered. See the closing
  -- note on why the replicator is authoritative.
  legacy             jsonb not null default '{}'::jsonb,

  -- Provenance, held verbatim and never defaulted. Kept separate from the
  -- operational timestamps below because collapsing them destroys information.
  -- Every one of the 12 entries carries updated_by
  -- 1179db75-8eeb-4bad-8e60-d5005aef7ef8, which maps to
  -- bekah@cambridge-ellis.org; the only other known id,
  -- b863e707-3140-4001-859f-3487e09c5881 (conrad.fulbrook@gmail.com), does not
  -- appear in this collection at all. Anything unrecognized is kept verbatim.
  source_updated_at  timestamptz,
  source_updated_by  text,

  -- Operational timestamps describing target writes. `updated_at` is
  -- maintained exclusively by the trigger in section 4; no application code and
  -- no migration 16 write function may set it.
  created_at         timestamptz not null default timezone('utc', now()),
  updated_at         timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Check constraints: there are none, and that is a decision
-- -----------------------------------------------------------------------------
-- This table adds no check constraint at all. Each omission is deliberate and
-- is recorded so it reads as decided rather than forgotten.
--
-- NO length check. promoted.yaml declares no `character_limit` on any field, so
-- unlike announcements.title (limit 30, actual values 44-69 characters) and the
-- umbrella description fields there is nothing even to grandfather here. Length
-- limits in this project are enforced by nextjs/lib/schema.ts and the migration
-- 16 write functions on create and edit, never by a database check, so the
-- canonical seed load cannot abort on one.
--
-- NO url check on the link_url column in section 6. URL validation is a shared
-- validator in nextjs/lib/schema.ts and the migration 16 write functions:
-- scheme must be https:, mailto: or tel:, or a root-relative path, while
-- javascript:, data: and protocol-relative forms are rejected. Putting a check
-- here would duplicate that rule in a place the seed load cannot bypass, and
-- the seed must load whatever the source holds.
--
-- NO ordering check on start_time / end_time. The five source rows carrying
-- times hold bare 12-hour readings with no meridiem: the annual auction reads
-- 06:30 to 11:00 but is semantically 6:30 PM to 11:00 PM, and the community
-- welcome night reads 07:00 to 08:00. A `start_time <= end_time` constraint
-- would happen to pass all five rows today, which is precisely what makes it a
-- trap -- it would encode an assumption the data does not support and could
-- reject a legitimate evening event later. The values migrate verbatim; no
-- ordering is asserted and no AM/PM is inferred, because either would be a
-- content change.
--
-- NO check reproducing date_behavior. See the closing note.
--
-- A non-negative check on sort_order was considered and rejected: reordering
-- runs as a single transaction in migration 16 that renumbers siblings, and a
-- floor would only constrain an intermediate state that transaction already
-- owns.


-- -----------------------------------------------------------------------------
-- 3. Row level security on public.promoted
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table in which all twelve migrated
-- rows are unpublished.
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that
-- load.
--
-- Migration 17 grants anonymous `select` where published = true, so a draft is
-- never fetched-then-hidden -- it is not returned at all.

alter table public.promoted enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger on public.promoted
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, which names migration 09
-- among its attachers. `updated_at` therefore cannot be forged and cannot be
-- forgotten. `created_at` is deliberately left as a column default only, and
-- `source_updated_at` is never touched by the trigger -- it is migrated
-- provenance, not an operational timestamp.

drop trigger if exists set_promoted_updated_at on public.promoted;

create trigger set_promoted_updated_at
  before update on public.promoted
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes on public.promoted
-- -----------------------------------------------------------------------------
-- `slug` and `legacy_ref` are already indexed by their unique constraints, so
-- they are not repeated here. The three below back specific, named access
-- paths.

-- Every public read of this table filters on published: the carousel renders
-- published rows only, and migration 17's anonymous policy filters on the same
-- column.
create index if not exists promoted_published_idx
  on public.promoted (published);

-- The carousel's ordering, and the column reorder-entries renumbers.
--
-- Deliberately NON-UNIQUE. Migration 01's ordering contract prescribes a
-- deferrable, null-safe unique for CHILD tables keyed on (parent_id,
-- sort_order); promoted is a top-level collection with no parent column, so the
-- analogous constraint would be a collection-wide unique on sort_order alone,
-- and that fights the two operations that matter. The seed load would have to
-- guarantee twelve distinct positions before any row lands, and a manual
-- reorder passes through intermediate states in which two rows briefly share a
-- position. A non-unique index lets the migration 16 reorder-entries command
-- renumber the whole collection transactionally, and `slug` as the final
-- tie-breaker already guarantees a stable, deterministic order between two rows
-- with equal sort keys. Uniqueness here would buy nothing that the tie-breaker
-- does not already provide.
create index if not exists promoted_sort_order_idx
  on public.promoted (sort_order);

-- Migration 16 recomputes published_reference_count and moves objects between
-- the media and media-private buckets on finalize, publish, unpublish, replace
-- and delete, so the rows referencing a given asset are queried directly. This
-- index is also what makes a blocked asset delete cheap: answering "which rows
-- reference this asset?" is an index lookup rather than a sequential scan.
create index if not exists promoted_image_asset_id_idx
  on public.promoted (image_asset_id);


-- -----------------------------------------------------------------------------
-- 6. public.promoted_links
-- -----------------------------------------------------------------------------
-- The `add_link` replicator (promoted.yaml line 13) as a child table. It holds
-- ZERO OR ONE row per promoted entry, and exactly one row exists across the
-- whole corpus: new-k-3rd-grade-mandarin-...-today.md carries a single set with
-- link_title 'Apply now!' and link_address
-- https://cambridge-ellis.myschoolapp.com/app#login/apply. The other eleven
-- cards render no call to action at all, which is why PromotedCarousel treats
-- the link as conditional rather than assuming one.
--
-- It is a table rather than two nullable columns on promoted because the source
-- is a replicator: it is a repeater by declaration, capped at one set today,
-- and modelling it as rows keeps that shape and its ordering intact.

create table if not exists public.promoted_links (

  -- Identity, as in section 1. Seeded rows derive theirs from
  -- public.ces_uuid('promoted_links', legacy_ref).
  id            uuid primary key default extensions.gen_random_uuid(),

  -- The DERIVED composite, never the source set id:
  -- '<promoted legacy_ref>:add_link:<ordinal>', so this row's value is
  -- '8b87e474-816a-435f-ab1e-5d5e42f22e45:add_link:0'. Child identity must be
  -- derived because the corpus proves a source id cannot be relied on: seven of
  -- the 81 `institution` sets carry none and three of the four `quote` sets
  -- carry none. This particular set happens to carry id 'm7kug0k7', which is
  -- retained in `legacy.set_id` for traceability but is NOT the identity.
  legacy_ref    text unique,

  -- `on delete cascade`, which is the correct action for a child row: deleting
  -- a promotion removes its call to action with it. Contrast
  -- promoted.image_asset_id in section 1, where a delete is blocked instead,
  -- because an asset is a shared resource rather than a part of this row.
  promoted_id   uuid not null references public.promoted (id) on delete cascade,

  -- Both NOT NULL, and the distinction is worth stating precisely: the SET is
  -- optional -- an unrequired replicator, so the ROW may be absent, and for
  -- eleven of the twelve entries it is -- but WITHIN a row that exists both
  -- children are required by the blueprint's own validate keys at lines 33-34
  -- and 44-45.
  link_title    text not null,

  -- Renamed from link_address because it holds a URL. No format check; see
  -- section 2.
  link_url      text not null,

  -- Defaulted to 1 rather than 0 because `max_sets: 1` means the only row that
  -- can exist is the first one. Retained as a column so the shape survives if
  -- the school ever raises the cap.
  sort_order    integer not null default 1,

  -- Holds `set_id` where the source set carried one -- 'm7kug0k7' for the one
  -- migrated row. Nothing else; this table has no rich-text field and no
  -- undeclared drift keys.
  legacy        jsonb not null default '{}'::jsonb,

  -- Operational timestamps. As in section 1, `updated_at` is the trigger's
  -- alone. There are deliberately no provenance columns here: a replicator set
  -- has no updated_at or updated_by of its own in the source -- that metadata
  -- belongs to the parent entry and lives on public.promoted.
  created_at    timestamptz not null default timezone('utc', now()),
  updated_at    timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 7. Enforcing max_sets: 1
-- -----------------------------------------------------------------------------
-- promoted.yaml line 52 caps the add_link replicator at one set, so at most one
-- row may exist per promoted entry. A plain `unique (promoted_id)` says exactly
-- that and lets the database enforce it; a check constraint counting rows in
-- the same table could not, since a check cannot see other rows.
--
-- Declared as a named `alter table` pair rather than inline so the name is
-- stable and greppable instead of server-generated, and so a second apply
-- re-asserts the definition against a table that already exists with a drifted
-- constraint.
--
-- Note what this subsumes: migration 01's child-ordering contract would
-- otherwise call for a unique on (promoted_id, sort_order), but with at most
-- one row per parent that pair is unique by construction. This single-column
-- constraint is strictly stronger and there is no reason to declare both.

alter table public.promoted_links drop constraint if exists promoted_links_promoted_id_key;
alter table public.promoted_links add constraint promoted_links_promoted_id_key
  unique (promoted_id);


-- -----------------------------------------------------------------------------
-- 8. RLS, trigger and indexes on public.promoted_links
-- -----------------------------------------------------------------------------
-- RLS enabled with zero policies, exactly as in section 3. Migration 17 gates
-- anonymous reads of this table on the PARENT's published flag, because a child
-- table has no `published` column of its own.

alter table public.promoted_links enable row level security;

drop trigger if exists set_promoted_links_updated_at on public.promoted_links;

create trigger set_promoted_links_updated_at
  before update on public.promoted_links
  for each row
  execute function public.set_updated_at();

-- NO separate index on promoted_id: the unique constraint in section 7 already
-- creates a btree index on that exact column, and a second one would be dead
-- weight the planner never chooses and every write would still maintain. The
-- lookup this table actually performs -- "the link for this promotion" -- is
-- served by that unique index. Stated explicitly so the absence reads as
-- decided rather than overlooked.
--
-- `legacy_ref` is likewise already indexed by its unique constraint, and
-- sort_order needs no index: at most one row exists per parent, so there is
-- nothing to sort.


-- -----------------------------------------------------------------------------
-- 9. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. This file deletes nothing, but content/ is
-- removed at the end of the migration phase, so after cutover the database
-- itself is the only place a reader can learn why a column exists, what its
-- values mean, or why something is absent.

comment on table public.promoted is
  'The home page promotional carousel: 12 rows migrated from '
  'content/collections/promoted, all of them drafts. NOT a routable '
  'collection -- content/collections/promoted.yaml declares neither route nor '
  'template -- so it contributes nothing to the content_routes view and '
  'carries no SEO columns. Rendered by components/site/PromotedCarousel.tsx as '
  'a component of the home page, ordered by sort_order then slug.';

comment on column public.promoted.id is
  'Primary key. Seeded rows derive theirs from public.ces_uuid(''promoted'', '
  'legacy_ref) so the load is idempotent and promoted_links can be written '
  'before its parent; the default serves editor-created rows.';

comment on column public.promoted.legacy_ref is
  'The source entry id from the .md front matter. Set on all 12 migrated rows; '
  'null on rows the school creates afterwards, which is why it is a unique '
  'constraint rather than a second primary key.';

comment on column public.promoted.slug is
  'Derived from the source FILENAME, not from a field: no promoted entry '
  'carries a slug: key, and the blueprint''s sidebar slug field (line 147) '
  'carries no validate key either -- uniquely among this project''s '
  'collections. NOT NULL is nonetheless correct, because Statamic derives the '
  'slug from the file name and a file always has one. Do not relax this on the '
  'strength of the missing validate. Also the final tie-breaker in every '
  'ordering of this table.';

comment on column public.promoted.title is
  'Required by the blueprint (line 6) and present on all 12 source entries. '
  'No length check: promoted.yaml declares no character_limit on any field.';

comment on column public.promoted.subtitle is
  'Optional supporting line, type textarea in the source. Present on 8 of 12.';

comment on column public.promoted.address is
  'A PER-ROW VENUE value, and deliberately not connected to site_globals. '
  'site_globals owns the school''s own address, phone, fax and email; this '
  'column holds wherever this particular promotion happens, which is often '
  'somewhere else entirely (one row reads "Harry Parker Boathouse, 20 Nonatum '
  'Rd, Brighton, MA") and in one row is logistics prose rather than an address '
  'at all. Editing the global address must not change this value and vice '
  'versa; the globals editor says so on its own field. Present on 5 of 12.';

comment on column public.promoted.summary is
  'Renamed from the source handle summary_or_additional_info, which encodes UI '
  'guidance to the editor rather than the meaning of the value. Present on 6 '
  'of 12.';

comment on column public.promoted.event_date is
  'Renamed from date_of_event to align with events.event_date so one helper in '
  'nextjs/lib/timezone.ts serves both. Type `date`, never timestamptz: the '
  'source is a bare wall-clock day with no zone and the project contract is '
  'America/New_York, unconverted. Only structured data and calendar links need '
  'an absolute instant and they compose one in TypeScript. Nullable; present '
  'on 8 of 12.';

comment on column public.promoted.start_time is
  'Type `time`, never timetz, under the same timezone contract as event_date. '
  'The source values are bare 12-hour readings with no meridiem and are '
  'preserved verbatim -- inferring AM/PM would be a content change. Nullable; '
  'present on 5 of 12.';

comment on column public.promoted.end_time is
  'As start_time. No constraint asserts end_time >= start_time: the ambiguous '
  '12-hour source values would make such a check an assumption the data does '
  'not support.';

comment on column public.promoted.image_asset_id is
  'NOT NULL -- the only mandatory asset reference in the entire schema '
  '(promoted.yaml lines 141-142), and satisfiable because all 12 source '
  'entries carry an image. No referential action: deleting a referenced asset '
  'is BLOCKED and the editor lists the referencing rows instead. on delete set '
  'null is impossible here because the column is NOT NULL, and silently '
  'nulling a required image would be worse than refusing; on delete cascade '
  'would let removing a photograph delete the promotion. Replacement is an '
  'atomic swap in one transaction in migration 16.';

comment on column public.promoted.published is
  'Draft is the safe default: a load error must never publish content. All 12 '
  'migrated rows are false, so the carousel renders zero slides until the '
  'school publishes -- dormant by publish state, not broken. Migration 17 '
  'gates anonymous select on this column, so a draft is never returned at all.';

comment on column public.promoted.sort_order is
  'This collection IS manually orderable, unlike announcements and '
  'inspiring_quotes which have no public order. Non-unique by design: a '
  'collection-wide unique would fight both the seed load and the intermediate '
  'states of a reorder, while slug as the final tie-breaker already '
  'guarantees a deterministic order between equal sort keys. Renumbered '
  'transactionally by the reorder-entries command in migration 16.';

comment on column public.promoted.legacy is
  'Undeclared source keys, retained queryably so nothing is discarded. Holds '
  'exactly one key on exactly one row: the scalar `link` that '
  'new-k-3rd-grade-mandarin-...-today.md carries alongside its add_link set, '
  'duplicating the set''s own link_address. The blueprint declares add_link '
  'and not link, so the replicator is authoritative: this value is retained '
  'and reported in artifacts/parity-report.json but is never rendered and must '
  'not be promoted to a column or merged with promoted_links.';

comment on column public.promoted.source_updated_at is
  'The source entry''s own updated_at, held verbatim. Migrated provenance, not '
  'an operational timestamp, and never touched by the updated_at trigger. '
  'Defaulting it to load time would erase the only record of when the school '
  'last edited the entry.';

comment on column public.promoted.source_updated_by is
  'The source entry''s updated_by, mapped to an email address where the id is '
  'known and kept verbatim otherwise. All 12 rows carry '
  '1179db75-8eeb-4bad-8e60-d5005aef7ef8 = bekah@cambridge-ellis.org; the only '
  'other known id, b863e707-3140-4001-859f-3487e09c5881 = '
  'conrad.fulbrook@gmail.com, does not appear in this collection.';

comment on column public.promoted.created_at is
  'When this row was written to the target database. An operational timestamp, '
  'not migrated provenance.';

comment on column public.promoted.updated_at is
  'Maintained exclusively by the set_promoted_updated_at trigger. No '
  'application code and no migration 16 write function may set this column.';

comment on table public.promoted_links is
  'The add_link replicator as a child table: ZERO OR ONE row per promoted '
  'entry, capped by unique (promoted_id) to mirror max_sets: 1 at '
  'promoted.yaml line 52. Exactly one row exists across the whole corpus, so '
  'eleven of the twelve cards render no call to action and PromotedCarousel '
  'must treat the link as conditional. Carries no `enabled` column and no '
  'provenance columns -- see their absences, documented on this table and in '
  'the closing notes.';

comment on column public.promoted_links.id is
  'Primary key, derived for seeded rows from '
  'public.ces_uuid(''promoted_links'', legacy_ref).';

comment on column public.promoted_links.legacy_ref is
  'The DERIVED composite <promoted legacy_ref>:add_link:<ordinal>, never the '
  'source set id. Derivation is mandatory rather than stylistic: across the '
  'corpus seven of 81 institution sets and three of four quote sets carry no '
  'source id at all. This set does carry id m7kug0k7, which is kept in '
  'legacy.set_id for traceability but is not the identity.';

comment on column public.promoted_links.promoted_id is
  'Parent reference, on delete cascade: deleting a promotion removes its call '
  'to action with it. Unique, per the constraint mirroring max_sets: 1, which '
  'also supplies this column''s only index.';

comment on column public.promoted_links.link_title is
  'The visible link text, e.g. "Apply now!". Required by the blueprint (lines '
  '33-34) WITHIN a row that exists -- the set itself is optional, so the row '
  'may legitimately be absent, and for eleven of twelve entries it is.';

comment on column public.promoted_links.link_url is
  'Renamed from link_address because it holds a URL. NOT NULL within a row '
  'that exists (blueprint lines 44-45). Deliberately carries NO format check: '
  'the scheme rule -- https:, mailto:, tel: or root-relative, rejecting '
  'javascript:, data: and protocol-relative forms -- lives in '
  'nextjs/lib/schema.ts and the migration 16 write functions, so it applies to '
  'every edit while the canonical seed load can still carry whatever the '
  'source holds.';

comment on column public.promoted_links.sort_order is
  'Defaults to 1 because max_sets: 1 means the only row that can exist is the '
  'first. Retained so the shape survives if the school ever raises the cap. '
  'Needs no index: at most one row exists per parent.';

comment on column public.promoted_links.legacy is
  'Holds set_id where the source set carried one -- m7kug0k7 for the single '
  'migrated row. Nothing else.';

comment on column public.promoted_links.created_at is
  'When this row was written to the target database.';

comment on column public.promoted_links.updated_at is
  'Maintained exclusively by the set_promoted_links_updated_at trigger.';


-- -----------------------------------------------------------------------------
-- A note on four deliberate absences
-- -----------------------------------------------------------------------------
-- Each of these is the kind of thing a later reader is likely to add, believing
-- it was forgotten. None of them was.
--
-- 1. NO seo_title, seo_description or og_image_id, on either table.
--    content/collections/promoted.yaml declares neither `route` nor
--    `template`, so no promoted row has a URL. A canonical link, a meta
--    description and an Open Graph image are all properties of a page, and the
--    SEO trio therefore belongs to the four routable tables only: pages,
--    people, events and classrooms. Adding it here would be dead weight that
--    nextjs/app/sitemap.ts and generateMetadata could never read, and would
--    imply this collection is routable when migration 15 must exclude it.
--
-- 2. NO `enabled` column on promoted_links. Its one source set is
--    `enabled: true`, which is the default, and export re-emits it as such.
--    Exactly two tables in this schema carry `enabled` -- page_sections
--    (migration 05) and person_education (migration 06) -- because those are
--    the only two places a `false` actually occurs: six disabled page-level
--    records and one disabled education record, seven in total across the
--    corpus. A column here would be editorial state with no data behind it and
--    no source expression of it, and migration 17's policy would then filter
--    on a field nothing sets. The difference between those tables and this one
--    is evidence, not consistency for its own sake.
--
-- 3. NO reproduction of date_behavior. content/collections/promoted.yaml sets
--    `date_behavior: {past: public, future: private}`, and that setting is
--    INERT: the collection is not declared `dated`, event_date is an ordinary
--    blueprint field, and no entry carries an entry-level `date:` key -- all
--    12 were checked. Runtime confirms the same conclusion on the sibling
--    events collection, where a future-dated published entry resolves 200
--    while an unpublished one 404s. Publish state alone governs visibility,
--    in the legacy site and here. So there is no check, no generated column,
--    and migration 17 adds no date predicate to its policy.
--
-- 4. NO seed rows. This file creates structure only. supabase/seed.sql,
--    generated by tools/src/extract-statamic-content.ts, is the canonical
--    load, and it is idempotent on legacy_ref. After it runs the expected
--    state is: 12 promoted rows, every one with published = false and a
--    non-null image_asset_id; exactly 1 promoted_links row; and exactly 1 row
--    carrying legacy.link. tools/src/verify-parity.ts asserts each of those.
-- =============================================================================
