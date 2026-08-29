-- =============================================================================
-- Cambridge-Ellis School  ·  migration 03 of 18  ·  taxonomy
-- =============================================================================
-- Creates exactly one table: public.taxonomy_terms.
--
-- Source of truth for this file, read in full rather than inferred:
--   content/taxonomies/role.yaml                        the taxonomy itself
--   content/taxonomies/role/teacher.yaml                \
--   content/taxonomies/role/leadership.yaml              >  its three terms
--   content/taxonomies/role/board-of-directors.yaml     /
--
-- One taxonomy exists in the legacy corpus and it has three terms. That is the
-- whole of the source, and it is why this is the smallest of the eighteen
-- migrations. content/collections/people.yaml declares `taxonomies: [role]` and
-- resources/blueprints/collections/people/people.yaml:103-115 declares the
-- `role` field as `type: terms` with `validate: [required]` — which is why
-- migration 06 enforces at least one person_roles row per person, satisfied by
-- all 77 people entries.
--
-- Three ownership boundaries, stated up front because each is easy to mistake
-- for this file's business:
--
--   person_roles  belongs to migration 06 (people). Its foreign key needs
--                 public.people to exist and the eighteen filenames are
--                 ordered, so it cannot be created here. No placeholder is
--                 created either: a table declared in one migration and given
--                 its foreign key in another is worse than one whole table in
--                 one place. This is the same dependency-order reasoning that
--                 puts the routes view and the write functions last.
--   policies      belong to migration 17 (rls_policies), together with the
--                 table-level grants. Row level security is switched on here
--                 and no policy is written, which is the least-privilege
--                 order: the table is closed to anon and authenticated from
--                 the moment it exists, and is opened deliberately, once, in
--                 one reviewable place. Migration 17 grants `select` on all
--                 rows to anon and to authenticated, and requires the `admin`
--                 capability to write — taxonomy term CRUD is one of the five
--                 capabilities the target deliberately removes from `editor`
--                 (the legacy editor role held view/edit/create/delete on role
--                 terms at resources/users/roles.yaml:99-102, and the target
--                 resolves the source's inverted role model as admin ⊇ editor).
--   rows          belong to supabase/seed.sql, the canonical load for all
--                 content. It inserts exactly three rows, every one
--                 taxonomy = 'role', with slugs teacher, leadership and
--                 board-of-directors. No guarded insert appears here: two
--                 owners of the same three rows is precisely how they diverge.
--                 (Migrations 11 and 12 do seed, because a closed globals key
--                 set and a menu structure are schema rather than collection
--                 content. A taxonomy term is collection content.)
--
-- Depends on migration 01 for extensions.gen_random_uuid() and
-- public.set_updated_at(), and follows the schema contract stated at
-- 20260901120100_extensions.sql:29-67. Every statement below is idempotent, so
-- applying all eighteen migrations twice is clean.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Why there is no visibility column
-- -----------------------------------------------------------------------------
-- content/taxonomies/role.yaml is one line long. In full, that line is:
--
--     title: Role
--
-- No `fields`, no blueprint reference, no published / visible / private flag —
-- nothing else whatsoever. The three term files carry only `title`,
-- `updated_by`, `updated_at` and `blueprint: role`. There is therefore no
-- visibility state anywhere in the source to carry across, and every term in
-- this taxonomy is public.
--
-- That absence is deliberate, and it is the single most likely thing for a
-- later reader to "fix" wrongly. A visible / published / public / enabled
-- column here would invent editorial state the school has never expressed, and
-- migration 17's policy would then filter on a column that nothing sets —
-- which reads as intentional and would deny rows for no reason at all. So the
-- policy says plainly that every term is public instead of filtering on a
-- field that does not exist.
--
-- Compare nav_items in migration 12, which does carry `visible`, and
-- page_sections and person_education, which carry `enabled` because seven
-- nested source records really are `enabled: false`. The difference between
-- those tables and this one is evidence, not consistency for its own sake.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- taxonomy_terms
-- -----------------------------------------------------------------------------
-- Column notes, in declaration order:
--
-- id                 Derived rather than random for every migrated row: the
--                    seed load supplies public.ces_uuid('taxonomy_terms',
--                    legacy_ref), a pure function of table and legacy_ref, so
--                    a re-run produces byte-identical ids and person_roles in
--                    migration 06 can reference a term before it is inserted.
--                    The gen_random_uuid() default therefore serves terms
--                    created later through the editor's `upsert-term` command,
--                    which have no legacy_ref to derive from. Qualified as
--                    extensions.gen_random_uuid() because pgcrypto lives in
--                    the extensions schema and the pinned search_path of the
--                    write functions in migration 16 does not include it.
-- legacy_ref         Nullable on purpose. Migrated terms carry their source
--                    slug; a term the school creates afterwards has no source
--                    and carries null. Postgres treats nulls as distinct under
--                    a unique constraint, so any number of editor-created
--                    terms coexist while no two migrated terms can collide —
--                    exactly the wanted behaviour, and the reason this is a
--                    unique constraint rather than a second primary key.
-- taxonomy           Closed vocabulary, one value. See the check below.
-- slug               The URL-safe identifier, and in this taxonomy it is the
--                    source filename rather than a field.
-- title              The human label. `text`, never varchar(n): the blueprints
--                    declare no character limit for a term title, and where
--                    they do declare limits elsewhere those are enforced in
--                    nextjs/lib/schema.ts and the migration 16 write functions
--                    so the legacy corpus loads grandfathered.
-- source_updated_at  \  Provenance. Held verbatim from the source and never
-- source_updated_by  /  defaulted. See the note below.
-- created_at         \  Operational columns describing target writes, in the
-- updated_at         /  explicit timezone('utc', now()) form this project
--                       mandates. updated_at is maintained solely by the
--                       trigger further down; no application code writes it.
--
-- Provenance is kept separate from the operational timestamps because
-- collapsing them destroys information. Each term file carries its own
-- `updated_at` (1633284801, 1633284817 and 1633284824) and `updated_by`
-- (b863e707-3140-4001-859f-3487e09c5881 on all three, which maps to
-- conrad.fulbrook@gmail.com). The only other known id is
-- 1179db75-8eeb-4bad-8e60-d5005aef7ef8, which maps to
-- bekah@cambridge-ellis.org; anything unrecognized is kept verbatim.
-- Defaulting created_at/updated_at to load time and calling
-- that the source value would erase the only record of when the school last
-- touched a term. artifacts/parity-report.json asserts both halves: that the
-- migrated source values match the files, and that no row's operational
-- timestamps precede the load.

create table if not exists public.taxonomy_terms (
  id                uuid primary key default extensions.gen_random_uuid(),
  legacy_ref        text,
  taxonomy          text not null,
  slug              text not null,
  title             text not null,
  source_updated_at timestamptz,
  source_updated_by text,
  created_at        timestamptz not null default timezone('utc', now()),
  updated_at        timestamptz not null default timezone('utc', now()),

  -- Named explicitly rather than left to Postgres so the names are stable
  -- across environments, greppable, and legible in a violation message.
  constraint taxonomy_terms_legacy_ref_key unique (legacy_ref),

  -- The closed vocabulary. One value, because exactly one taxonomy exists in
  -- the source: content/taxonomies/ holds role.yaml and nothing else. Three
  -- further taxonomy blueprints do exist under
  -- resources/blueprints/taxonomies/{program_ages,program_types,programs}/ and
  -- all three are orphaned — no taxonomy directory, no term files, no entry
  -- referencing them — so they carry nothing to migrate and get no value here.
  -- Adding a taxonomy is a migration, not a row: widening this check is a
  -- reviewed schema change rather than something an editor can do by typing.
  constraint taxonomy_terms_taxonomy_check check (taxonomy in ('role')),

  -- The real business key. A bare unique on slug alone would be wrong the
  -- moment a second taxonomy is added, since two taxonomies may legitimately
  -- share a term slug; scoping uniqueness by taxonomy is correct now and stays
  -- correct then. It also covers slug lookups, which is why the index below is
  -- on taxonomy alone.
  constraint taxonomy_terms_taxonomy_slug_key unique (taxonomy, slug)
);


-- Enabled immediately after the create, so the table is never readable by anon
-- or authenticated during the window between this migration and migration 17.
-- With row level security on and no policy present, only the service role —
-- which bypasses it, and which supabase/seed.sql loads as — can reach these
-- rows. That is the intended state at this point in the sequence.
alter table public.taxonomy_terms enable row level security;


-- The shared trigger function from migration 01. Dropped first so a second
-- apply is clean: create trigger has no `if not exists` form.
drop trigger if exists set_taxonomy_terms_updated_at on public.taxonomy_terms;

create trigger set_taxonomy_terms_updated_at
  before update on public.taxonomy_terms
  for each row
  execute function public.set_updated_at();


-- The list query filters on taxonomy — every read of this table is "the terms
-- of taxonomy X", whether it is the people editor's term picker or migration
-- 17's policy surface. Slug lookups are already served by
-- taxonomy_terms_taxonomy_slug_key, so no second index is warranted: at three
-- rows neither index is load-bearing today, and this one is declared for the
-- access pattern rather than for the row count.
create index if not exists taxonomy_terms_taxonomy_idx
  on public.taxonomy_terms (taxonomy);


-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------

comment on table public.taxonomy_terms is
  'Taxonomy vocabulary terms, migrated from content/taxonomies/**. One taxonomy '
  'exists (role) with three terms: teacher, leadership, board-of-directors. '
  'There is deliberately no visibility column — content/taxonomies/role.yaml '
  'declares nothing but `title: Role`, so no visibility state exists in the '
  'source and every term is public. The person relation lives in person_roles, '
  'created by migration 06 because its foreign key needs public.people.';

comment on column public.taxonomy_terms.legacy_ref is
  'Source identity: the term SLUG (teacher, leadership, board-of-directors), '
  'not a uuid — one of the concrete reasons legacy_ref is text rather than '
  'uuid across this schema. Row ids derive from it via '
  'ces_uuid(''taxonomy_terms'', legacy_ref). Null for terms created after the '
  'migration, which have no source.';

comment on column public.taxonomy_terms.taxonomy is
  'Closed vocabulary, currently the single value ''role'', because exactly one '
  'taxonomy exists in the source. Adding a taxonomy is a migration that widens '
  'the check constraint, not a data entry.';

comment on column public.taxonomy_terms.slug is
  'URL-safe term identifier. Derived from the source FILENAME: none of the '
  'three term files carries a slug key, because Statamic takes it from the file '
  'name. Unique per taxonomy, not globally.';

comment on column public.taxonomy_terms.source_updated_at is
  'The source file''s own updated_at, held verbatim and never defaulted — '
  'created_at and updated_at are operational columns describing target writes. '
  'parity-report.json asserts both the migrated source values and that no '
  'row''s operational timestamps precede the load.';

comment on column public.taxonomy_terms.source_updated_by is
  'The source file''s updated_by, mapped from the Statamic user id to that '
  'user''s email address (all three terms: conrad.fulbrook@gmail.com). An '
  'unrecognized id is kept verbatim.';
