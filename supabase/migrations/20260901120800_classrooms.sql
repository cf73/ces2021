-- =============================================================================
-- Cambridge-Ellis School  ·  migration 08 of 18  ·  classrooms
-- =============================================================================
-- Creates three tables -- public.classrooms, public.classroom_teachers and
-- public.page_classrooms -- and nothing else.
--
-- Why both join tables live here rather than with their other parent, which is
-- the same dependency-order reasoning that puts person_roles with `people`
-- instead of with the taxonomy it references:
--
--   classroom_teachers  carries foreign keys to BOTH public.classrooms (this
--                       file) and public.people (migration 06), so this is the
--                       first file in which both parents exist. Migration 06
--                       states the same boundary from its own side at
--                       20260901120600_people.sql:67-71 and leaves no stub.
--   page_classrooms     carries foreign keys to BOTH public.pages (migration
--                       04) and public.classrooms (this file), so likewise.
--                       Migration 04 says so at 20260901120400_pages.sql:64-68
--                       and migration 05 says it emphatically at
--                       20260901120500_page_sections.sql:92-101 -- "a `create
--                       table page_classrooms` in this file would not even
--                       apply, because public.classrooms does not exist yet".
--                       There is exactly one owner of that table and it is this
--                       file.
--
-- The eighteen filenames are a fixed, ordered sequence and no nineteenth file
-- is added. A table declared in one migration and given its foreign key in
-- another is worse than one whole table in one place.
--
--
-- Source of truth, read in full rather than inferred:
--
--   resources/blueprints/collections/classrooms/classrooms.yaml
--        The declared column set, and it declares EXACTLY FOUR things:
--          title (line 7)        -> title        `type: text`, `required:
--                                                true`, `validate: [required]`
--          description (line 14) -> description  `type: textarea`, so plain
--                                                text and NOT bard. NOT
--                                                required -- it carries no
--                                                `validate` key at all.
--          teachers (line 22)    -> classroom_teachers
--                                                `type: entries`,
--                                                `collections: [people]`,
--                                                `mode: select`, `create:
--                                                true`, and NO `max_items`,
--                                                therefore an unbounded ordered
--                                                list. This is the forward half
--                                                of the reconciliation below.
--          slug (line 37)        -> slug         sidebar, `type: slug`,
--                                                `validate: [required,
--                                                unique_entry_value:...]`
--        Everything else on a classroom entry is UNDECLARED DRIFT. See the
--        census below: the blueprint models four fields and the entries carry
--        nine.
--   content/collections/classrooms.yaml
--        `route: 'programs/{slug}'` -- written WITHOUT a leading slash, unlike
--        every other collection in this corpus. `template: room`, `sort_dir:
--        asc`, `revisions: false`.
--
--        Two consequences of that route, both belonging to migration 15 rather
--        than to this file, recorded here because this is where the evidence
--        is. The derived path must be normalized to `/programs/<slug>`, and
--        `/programs/{slug}` is a namespace SHARED with the umbrella pages
--        (/programs/day-programs and the rest are `pages` rows). All 142 derived
--        paths are unique today, so these are OVERLAPPING NAMESPACES and not
--        collisions -- but nothing in the flat files enforced that, which is why
--        migration 15's content_routes view exposes a deterministic
--        `precedence` integer in which CLASSROOMS ARE 2 (pages 1, classrooms 2,
--        people 3, events 4) and why the uniqueness guarantee is in the schema
--        rather than in the routing code.
--
--        It also declares `date_behavior: {past: public, future: private}`,
--        which IS INERT AND IS DELIBERATELY NOT REPRODUCED HERE. The collection
--        is not `dated` and no entry carries an entry-level `date:` key, so the
--        setting has no effect whatsoever. Runtime confirms it --
--        /events/open-house returns 200 while the unpublished /events/story-slam
--        returns 404. Publish state ALONE governs visibility, in the legacy site
--        and here. There is therefore no check constraint, no policy predicate
--        and no generated column anywhere in this file implying otherwise.
--   resources/blueprints/collections/pages/programsumbrella.yaml
--        Line 65, the `classrooms` field: `type: entries`, `collections:
--        [classrooms]`, `mode: select`, `create: false`. The source of
--        page_classrooms.
--   content/collections/pages/day-programs.md
--        7 classroom references (lines 8-14).
--   content/collections/pages/language-programs.md
--        5 classroom references (lines 8-12).
--        Those are the ONLY two pages carrying the field, so page_classrooms
--        holds exactly 12 rows.
--   content/collections/classrooms/*.md
--        13 entries, of which 1 is a draft.
--
--
-- THE UNDECLARED DRIFT, and the one promotion this file makes.
--
-- Measured across the 13 entries rather than inferred from the blueprint:
--
--   programs      12 of 13   -> legacy
--   ages          12 of 13   -> legacy
--   program_type   4 of 13   -> legacy
--   integer        3 of 13   -> legacy
--   age_range      2 of 13   -> age_range, A REAL COLUMN
--
-- Only `age_range` is promoted, because it is the value the target actually
-- renders. The other four are retained verbatim in the `legacy` jsonb: they are
-- real editorial data that no blueprint models, and neither dropping them nor
-- guessing at a normalized shape for them is defensible. Promoting them would
-- mean inventing four columns for values the target has no renderer for; the
-- retention keeps them queryable so that normalizing any one of them later is a
-- migration rather than a re-extraction.
--
-- Two live defects this settles, worth naming so that nobody preserves them.
-- /programs/blue-room today renders `<a href="/programs/"> Program</a>` -- a
-- bare " Program" -- and an empty `<h3></h3>`, because the entries carry
-- `programs: day` and `ages: upper-preschool` as plain strings that the
-- blueprint never declared, so Antlers' `:title` and `:slug` modifiers cannot
-- resolve them. The schema-level fix is exactly this: the two strings are
-- preserved in `legacy` where they can be audited, `age_range` is a real column
-- the presenter can read, and the real parent comes from public.pages.
--
--
-- THE CLASSROOM RELATION IS NOT LOSSLESS BY DEFAULT. This is the single most
-- consequential data decision in the migration, so the evidence is stated in
-- full and the numbers are restated in the column comments too, because
-- content/ is deleted at the end of the migration phase and these figures must
-- stay checkable without it.
--
-- Two directions exist in the source and THEY DISAGREE MATERIALLY. Measured
-- with a real YAML parse over the actual entries:
--
--   forward   classrooms.teachers      32 pairs
--   reverse   people.classrooms        24 pairs
--   common to both                     15 pairs
--   UNION                              41 pairs
--   forward-only                       17 pairs
--   reverse-only                        9 pairs
--   dangling references, either way     0
--
-- The legacy template renders the REVERSE query --
-- `{{collection:people classrooms:contains="{id}"}}` -- so adopting the
-- declared forward relation alone would silently REMOVE NINE associations the
-- site displays today and ADD SEVENTEEN it does not. Neither direction is "the"
-- data, and neither a strict port nor a strict trust-the-declared-field reading
-- is acceptable under "no content or functionality is lost".
--
-- The authorized reconciliation is therefore THE UNION: 41 rows, each tagged
-- `source` as forward / reverse / both, with BOTH original arrays retained in
-- `legacy` on their respective rows -- classrooms.legacy.teachers here and
-- people.legacy.classrooms in migration 06, which records the same numbers at
-- 20260901120600_people.sql:302-316 and states that its array "must not be
-- dropped as redundant: it is the audit trail for a reconciliation that adds 17
-- visible associations". tools/src/verify-parity.ts lists the 17 additions and
-- the 9 forward-gaps as a named review section in artifacts/parity-report.json,
-- so nothing is dropped and the additions are visible rather than silent. All
-- editing afterwards is on this one join table.
--
-- A 32-row or a 24-row classroom_teachers is a content loss and a parity
-- failure, not a simplification.
--
-- One implementation warning is carried here because it produced a real bug
-- against this very data: parse the front matter as YAML, never with a
-- line-oriented regex. A regex for a trailing YAML list key consumes the
-- closing `---` delimiter as a list item, which in a first pass produced 12
-- phantom dangling references, 44 forward pairs and a union of 53. The foreign
-- keys below are deliberately NOT relaxed to tolerate that: a dangling teacher
-- reference must fail the load loudly rather than being absorbed.
--
--
-- Verified volumes, so the load can be checked without content/:
--
--   classrooms          13 rows, 1 with published = false
--   classroom_teachers  41 rows -- 15 `both`, 17 `forward`, 9 `reverse`
--   page_classrooms     12 rows, from exactly 2 pages (7 + 5)
--
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   policies          migration 17, together with the table-level grants. Row
--                     level security is switched ON here for all three tables
--                     and ZERO policies are written. That combination is the
--                     least-privilege order and not an oversight: the tables
--                     are closed to anon and authenticated from the moment they
--                     exist and are opened deliberately, once, in one
--                     reviewable place. supabase/seed.sql is unaffected because
--                     it loads as service_role, which bypasses RLS.
--   content_routes    migration 15. This file creates no view. The classrooms
--                     contribution to it is (slug -> /programs/<slug>,
--                     precedence 2), and the normalization of the leading-slash
--                     quirk belongs there.
--   write functions   migration 16 -- create-entry, update-slug, set-published,
--                     reorder-entries, delete-entry, force-delete-entry and the
--                     rest, each checking session, active membership, AAL2 and
--                     capability before applying a mutation, and each writing
--                     its revision rows under one change_set_id. Direct DML on
--                     content tables is revoked from `authenticated` there, so
--                     a bearer token calling PostgREST directly cannot write.
--   rows              supabase/seed.sql, the canonical load. Not one insert
--                     appears in this file: two owners of the same rows is
--                     precisely how they diverge.
--   length limits     nothing, anywhere. classrooms.yaml declares no
--                     `character_limit` on any field, so unlike
--                     announcements.title or the umbrella descriptions there is
--                     not even a limit to grandfather. Where limits do exist
--                     elsewhere they live in nextjs/lib/schema.ts and the
--                     migration 16 write functions, never as a check
--                     constraint, so the legacy corpus can never abort the
--                     load.
--
-- Depends on migration 01 for extensions.gen_random_uuid() and
-- public.set_updated_at(), on migration 02 for public.assets, on migration 04
-- for public.pages and on migration 06 for public.people. Follows the schema
-- contract stated once at 20260901120100_extensions.sql:29-67, which names this
-- migration among the tables attaching the shared updated_at trigger. Every
-- statement is idempotent -- `create table if not exists`, `create index if not
-- exists`, `drop constraint if exists` before `add constraint`, and `drop
-- trigger if exists` before `create trigger` -- so applying all eighteen
-- migrations twice is clean. Conventions: lowercase SQL, `text` never
-- varchar(n), the explicit timezone('utc', now()) timestamp form, and jsonb
-- only where the structure is genuinely variable.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. classrooms
-- -----------------------------------------------------------------------------
-- Per-column rationale is carried in the `comment on column` statements in
-- section 12 rather than duplicated here, because those comments survive into
-- the database and stay readable after content/ is gone. The notes in this
-- block are limited to decisions a reader would otherwise have to reverse
-- engineer from the column list.

create table if not exists public.classrooms (

  -- Identity. gen_random_uuid() is schema-qualified because pgcrypto lives in
  -- the extensions schema and migration 01 makes qualification an absolute
  -- project rule (20260901120100_extensions.sql:76-83); an unqualified call
  -- inside a search_path-pinned function fails at runtime rather than at create
  -- time. Seeded rows do not use this default -- they derive their id from
  -- public.ces_uuid('classrooms', legacy_ref), which is what makes the load
  -- idempotent and lets classroom_teachers and page_classrooms reference a
  -- classroom before that classroom is inserted -- so the default serves rows
  -- the editor creates later.
  id                 uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id, e.g. 448d749d-93d0-4c81-bd6f-806e5e431849. Null on
  -- editor-created rows.
  legacy_ref         text,

  -- Derived from the source FILENAME: not one of the 13 entries carries a
  -- `slug:` key, because Statamic takes it from the file name. It is also the
  -- final tie-breaker of every ordering in this project.
  slug               text not null,

  -- `validate: [required]` at classrooms.yaml:10-12.
  title              text not null,

  -- Nullable, exactly as the blueprint declares it: `description` carries no
  -- `validate` key, so it is the one declared content field that is optional.
  description        text,

  -- PROMOTED from an undeclared key, present on 2 of the 13 entries. See the
  -- header and the column comment: this is the one drift key the target
  -- renders, which is why it earns a column while `programs`, `ages`,
  -- `program_type` and `integer` stay in `legacy`.
  age_range          text,

  -- Draft is the safe default: a load error must never publish content. 1 of
  -- the 13 source entries is a draft and that flag migrates exactly.
  published          boolean not null default false,

  -- Manual ordering, with no default on purpose. See the column comment for
  -- why there is no uniqueness constraint on it.
  sort_order         integer not null,

  -- Net-new per-route SEO. No legacy route carries a meta description, a
  -- canonical link or an Open Graph tag, so there is nothing to preserve and
  -- these three start null. `og_image_id` is this column's name everywhere in
  -- the plan; a second name for the same column is how a metadata function and
  -- a migration end up disagreeing.
  seo_title          text,
  seo_description    text,
  og_image_id        uuid,

  -- The four undeclared drift keys plus the raw forward `teachers` array.
  -- jsonb because their structure is genuinely variable and no blueprint gives
  -- any of them a shape.
  legacy             jsonb not null default '{}'::jsonb,

  -- Provenance, held verbatim and never defaulted.
  source_updated_at  timestamptz,
  source_updated_by  text,

  -- Operational columns describing target writes. `updated_at` is maintained
  -- solely by the trigger in section 3; no application code and no migration
  -- 16 write function may set it.
  created_at         timestamptz not null default timezone('utc', now()),
  updated_at         timestamptz not null default timezone('utc', now()),

  -- Constraints are named explicitly rather than left to Postgres so the names
  -- are stable across environments, greppable, and legible in a violation
  -- message.

  -- Nullable-unique on purpose: Postgres treats nulls as distinct, so any
  -- number of editor-created rows coexist while no two migrated rows can
  -- collide on their source id.
  constraint classrooms_legacy_ref_key unique (legacy_ref),

  -- The route key. `route: 'programs/{slug}'` makes this the URL, so
  -- uniqueness here is what keeps /programs/<slug> resolving to one classroom.
  -- The cross-table guarantee is migration 15's: content_routes must hold one
  -- row per path, and a per-table unique cannot see the other three routable
  -- tables -- which matters more here than anywhere else in the schema, because
  -- this collection shares its namespace with the umbrella pages.
  constraint classrooms_slug_key unique (slug),

  -- No `on delete` action, therefore NO ACTION, therefore deleting an asset
  -- that any classroom references is BLOCKED. That is deliberate and must not
  -- be weakened from this side -- migration 02 says so at
  -- 20260901120200_assets.sql:42-44. `on delete set null` would be wrong here
  -- even though the column is nullable, because the editor's job is to list the
  -- referencing rows and let an admin decide, not to silently drop an image;
  -- and it is impossible on promoted.image_asset_id, which is not null, so one
  -- rule across the schema beats two.
  constraint classrooms_og_image_id_fkey
    foreign key (og_image_id) references public.assets (id)
);


-- -----------------------------------------------------------------------------
-- 2. classrooms · row level security
-- -----------------------------------------------------------------------------
-- On immediately, so there is no window between this migration and 17 in which
-- the table is readable by anon or authenticated. With RLS on and no policy
-- present only the service role -- which bypasses it, and which
-- supabase/seed.sql loads as -- can reach these rows.
--
-- `force row level security` is deliberately NOT set: it would subject the
-- table owner to policies too and break that load.
--
-- For the record, migration 17 grants anon `select` where published = true and
-- authenticated `select` on everything given active membership and AAL2. A
-- draft is not fetched then hidden; it is not returned. 1 of these 13 rows is a
-- draft, so that is not a hypothetical.

alter table public.classrooms enable row level security;


-- -----------------------------------------------------------------------------
-- 3. classrooms · the updated_at trigger
-- -----------------------------------------------------------------------------
-- The one shared function from migration 01, which names this migration among
-- its attachers at 20260901120100_extensions.sql:172-176. Dropped first because
-- `create trigger` has no `if not exists` form, which is what makes a second
-- apply clean. `created_at` is deliberately left as a column default only, and
-- `source_updated_at` is never touched by it: that column holds the SOURCE's
-- timestamp verbatim and describes an edit made in Statamic, not a write here.

drop trigger if exists set_classrooms_updated_at on public.classrooms;

create trigger set_classrooms_updated_at
  before update on public.classrooms
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. classrooms · indexes
-- -----------------------------------------------------------------------------
-- `slug` and `legacy_ref` are already indexed by their unique constraints and
-- are not repeated. Each index below backs a named access path.

-- Every anonymous read of this table filters on published: the classroom pages,
-- the two umbrella pages' ordered listings and migration 17's policy surface
-- all do.
create index if not exists classrooms_published_idx
  on public.classrooms (published);

-- The collection surface at /admin/collections/classrooms lists rows in
-- sort_order, and reorder-entries renumbers on it.
create index if not exists classrooms_sort_order_idx
  on public.classrooms (sort_order);

-- Indexed because deleting an asset must check it. With NO ACTION the check
-- runs at end of statement over every referencing table, and an unindexed
-- referencing column turns each such check into a sequential scan. It also
-- serves the editor's "what references this asset?" listing, which is the
-- affordance that makes a blocked delete usable rather than merely refused.
create index if not exists classrooms_og_image_id_idx
  on public.classrooms (og_image_id);


-- -----------------------------------------------------------------------------
-- 5. classroom_teachers · the union
-- -----------------------------------------------------------------------------
-- Which people teach in which classroom. The header states the reconciliation
-- in full; this block covers the three structural decisions a reader would
-- otherwise have to reverse engineer.
--
-- IDENTITY: a surrogate id plus an explicit unique on the pair, rather than a
-- composite primary key. Both shapes guarantee what the union requires -- that
-- a pair appearing in BOTH source directions resolves to ONE row tagged `both`
-- and never to two rows -- so the choice is decided by two other things.
--
-- First, this schema already has a discriminator and it is worth following
-- rather than crossing. Every table here that carries `sort_order` carries a
-- surrogate uuid id: pages, people, classrooms, page_sections (05),
-- person_education (06), promoted and promoted_links (09), nav_items (12). The
-- one table with a composite primary key and no id is public.person_roles
-- (06), and it is precisely the one with NO sort_order -- its own comment says
-- "there is deliberately no sort_order: the source role list has no meaningful
-- order and nothing renders one". This table is ordered and reorderable, so it
-- belongs with the former group.
--
-- Second, and concretely: migration 14 declares `content_revisions.row_id uuid
-- not null` (20260901121400_content_revisions.sql:154). A reorder here is a
-- real mutation that must be recorded per row under one change_set_id, and a
-- composite-keyed row has no single uuid to name in that column. The surrogate
-- id is what lets a reorder be audited and restored row by row.
--
-- NO legacy_ref, deliberately, and this is the one child table in the schema
-- where the derived-child-identity rule of migration 01
-- (20260901120100_extensions.sql:145-151) does not apply. That rule derives a
-- child's ref as `<parent legacy_ref>:<field handle>:<ordinal>`, which presumes
-- ONE parent. A union row has two candidate parents and 26 of the 41 rows exist
-- in only one direction: deriving from the classroom would misrepresent the 9
-- reverse-only rows, and deriving from the person would misrepresent the 17
-- forward-only ones. The identity of a row here is the PAIR, which is exactly
-- what the unique constraint below states, and its provenance is the `source`
-- column, which is exactly what `source` is for. Both raw source arrays remain
-- on their own rows -- classrooms.legacy.teachers and people.legacy.classrooms
-- -- so the derivation is fully reconstructible without storing an ambiguous
-- key here.

create table if not exists public.classroom_teachers (

  id            uuid primary key default extensions.gen_random_uuid(),

  classroom_id  uuid not null,
  person_id     uuid not null,

  -- Source order of the teacher within the classroom's list. Teacher output on
  -- a classroom page is ordered by sort_order and then by the person's `slug`
  -- as the final tie-breaker, which is what gives the 9 reverse-only rows --
  -- which have no forward ordinal to inherit -- a stable, defined position
  -- rather than an accidental one. The uniqueness constraint is declared
  -- separately in section 7, because its deferrability is the one property
  -- worth re-asserting on every apply.
  sort_order    integer not null,

  -- WHICH DIRECTION DECLARED THIS PAIR. The tag that makes the union auditable
  -- in both directions, and the reason nothing had to be dropped to reconcile
  -- the two source lists. Its closed vocabulary is declared in section 6;
  -- migration 07 already lists this column among the schema's closed
  -- vocabularies at 20260901120700_events.sql:227.
  --
  -- Measured over the real entries with a YAML parse -- restated on the column
  -- itself in section 12 as well, because content/ is deleted at the end of the
  -- migration phase and this is the number the parity gate asserts:
  --
  --   forward   32 pairs declared by classrooms.teachers
  --   reverse   24 pairs declared by people.classrooms
  --   both      15 pairs declared by each
  --   ----------------------------------------------------
  --   union     41 rows  =  17 forward-only + 9 reverse-only + 15 both
  --
  -- So this table holds 41 rows: 17 tagged `forward`, 9 tagged `reverse`, 15
  -- tagged `both`. A 32-row or 24-row table is a content loss, not a
  -- simplification.
  source        text not null,

  created_at    timestamptz not null default timezone('utc', now()),

  -- Present, and maintained by the trigger in section 8 rather than left as a
  -- decorative default. That combination is the point: an `updated_at` with no
  -- trigger is truthful only until the first edit, which is a named weakness of
  -- the fidelis reference that migration 01 corrects
  -- (20260901120100_extensions.sql:178-181), so this column either comes with
  -- its trigger or does not exist.
  --
  -- It exists because rows here are genuinely mutable -- a reorder rewrites
  -- sort_order -- unlike public.person_roles, which is immutable by nature
  -- (changing either column makes it a different association) and therefore
  -- carries created_at alone. It also feeds the optimistic per-field conflict
  -- check: a write function compares the updated_at the client read against the
  -- current one and rejects a stale write rather than silently overwriting it.
  updated_at    timestamptz not null default timezone('utc', now()),

  -- THE PAIR IS UNIQUE. This is the constraint that enforces the union's
  -- central guarantee: a pair declared by both source directions is one row
  -- tagged `both`, never two rows that would render the same teacher twice on
  -- one classroom page and would make the 41 unverifiable.
  constraint classroom_teachers_classroom_id_person_id_key
    unique (classroom_id, person_id),

  -- Both cascade. The relation has no meaning without either end, and the
  -- parent's own deletion is the only thing that should remove it. These are
  -- NOT relaxed to tolerate a bad extraction: there are zero dangling
  -- references in either source direction, so a dangling teacher reference
  -- means the extractor is wrong and must fail the load loudly rather than
  -- being absorbed into a nullable column. The regex-versus-YAML bug described
  -- in the header is exactly the failure these two constraints are here to
  -- catch.
  constraint classroom_teachers_classroom_id_fkey
    foreign key (classroom_id) references public.classrooms (id) on delete cascade,

  constraint classroom_teachers_person_id_fkey
    foreign key (person_id) references public.people (id) on delete cascade
);


-- -----------------------------------------------------------------------------
-- 6. classroom_teachers · the source vocabulary
-- -----------------------------------------------------------------------------
-- Declared as drop-then-add rather than inline so that the definition appears
-- exactly once and is re-asserted on every apply, which is what makes this file
-- converge rather than merely not error.
--
-- Three values and no more. `both` is not redundant with the other two: it is
-- the 15-row overlap, and collapsing it into either neighbour would destroy the
-- evidence that the two source directions agreed on those pairs. There is
-- deliberately no fourth value and no default -- the extractor knows which
-- direction produced each row and must say so, and a default would let a row
-- claim a provenance nobody established.

alter table public.classroom_teachers
  drop constraint if exists classroom_teachers_source_check;

alter table public.classroom_teachers
  add constraint classroom_teachers_source_check
  check (source in ('forward', 'reverse', 'both'));


-- -----------------------------------------------------------------------------
-- 7. classroom_teachers · the ordering constraint
-- -----------------------------------------------------------------------------
-- Declared here as drop-then-add for the same reason as section 6, and for one
-- more: `deferrable initially immediate` is the property a drifted environment
-- could silently lack.
--
-- `nulls not distinct` follows the schema-wide convention stated at
-- 20260901120100_extensions.sql:50-56. On this table `classroom_id` is `not
-- null`, so it is belt-and-braces here rather than load-bearing as it is for a
-- table whose parent column is nullable. It is kept for consistency, so that
-- reading two child tables side by side does not suggest a difference in intent
-- that does not exist.
--
-- The deferrability IS load-bearing. A reorder swapping two teachers' positions
-- must pass through a state where two rows share a sort_order; with an
-- immediate constraint the write function would have to renumber through a
-- temporary hole, which is exactly the kind of workaround that leaves gaps
-- behind when it fails halfway. `initially immediate` keeps ordinary single-row
-- inserts failing fast, and reorder-entries in migration 16 issues `set
-- constraints ... deferred` inside its own transaction.
--
-- Scope is (classroom_id, sort_order), so two DIFFERENT classrooms may hold the
-- same sort_order -- correct, because ordering is per classroom, not global,
-- and one teacher legitimately appears first in one room and third in another.

alter table public.classroom_teachers
  drop constraint if exists classroom_teachers_classroom_id_sort_order_key;

alter table public.classroom_teachers
  add constraint classroom_teachers_classroom_id_sort_order_key
  unique nulls not distinct (classroom_id, sort_order)
  deferrable initially immediate;


-- -----------------------------------------------------------------------------
-- 8. classroom_teachers · row level security, trigger and indexes
-- -----------------------------------------------------------------------------
-- RLS on, zero policies, for the same reason as section 2. This table has no
-- `published` column of its own, which is why migration 17's anon policy has to
-- reach through BOTH foreign keys: a teacher association is public only if the
-- classroom is published and the person is published. That is stricter than the
-- single-parent reach person_education needs, and it is the correct reading --
-- an unpublished person must not surface on a published classroom page merely
-- because the join row exists.

alter table public.classroom_teachers enable row level security;


drop trigger if exists set_classroom_teachers_updated_at on public.classroom_teachers;

create trigger set_classroom_teachers_updated_at
  before update on public.classroom_teachers
  for each row
  execute function public.set_updated_at();


-- "Which teachers are in this classroom" is served by the leading column of
-- classroom_teachers_classroom_id_sort_order_key, and the cascade from
-- public.classrooms uses it too.
--
-- This index covers the OTHER direction, and it is not redundant with anything:
-- "which classrooms does this person teach in" is the query behind every bio
-- page, and it is also the lookup the cascade from public.people must make on
-- a person deletion. Without it each parent delete degrades to a sequential
-- scan here.
create index if not exists classroom_teachers_person_id_idx
  on public.classroom_teachers (person_id);

-- Backs the parity query. artifacts/parity-report.json lists the 17 additions
-- and the 9 forward-gaps as a named section for school review, which is a
-- `group by source` over this table, and the review is expected to be run more
-- than once while the school works through it.
create index if not exists classroom_teachers_source_idx
  on public.classroom_teachers (source);


-- -----------------------------------------------------------------------------
-- 9. page_classrooms
-- -----------------------------------------------------------------------------
-- The ordered `classrooms` relation on the umbrella pages, from
-- resources/blueprints/collections/pages/programsumbrella.yaml:65 (`type:
-- entries`, `collections: [classrooms]`, `mode: select`, `create: false`).
--
-- It is a join table with a sort_order rather than a jsonb array on
-- public.pages for one reason: the relation is ORDERED, and the order is what
-- the umbrella page renders. A jsonb array would carry the order too, but it
-- could not be a foreign key -- so a classroom deleted or renamed would leave a
-- dangling id inside a json document that nothing checks, which is precisely
-- the class of drift this migration exists to end. Migration 04 records the
-- same decision from the pages side at 20260901120400_pages.sql:64-68.
--
-- Exactly 12 rows, from exactly 2 of the 34 pages, verified by reading both
-- entries: content/collections/pages/day-programs.md carries 7 classroom
-- references at lines 8-14 and content/collections/pages/language-programs.md
-- carries 5 at lines 8-12. No other page carries the field.
--
-- Identity is the surrogate id plus the unique on the pair, for the same two
-- reasons as section 5: this table is ordered and reorderable, which in this
-- schema means a surrogate id, and a reorder must name a single uuid in
-- content_revisions.row_id. There is no legacy_ref: the pair is the natural
-- key, and the source order is already carried in sort_order.

create table if not exists public.page_classrooms (

  id            uuid primary key default extensions.gen_random_uuid(),

  page_id       uuid not null,
  classroom_id  uuid not null,

  -- Source order of the classroom within the page's list. The uniqueness
  -- constraint is declared separately in section 10.
  sort_order    integer not null,

  created_at    timestamptz not null default timezone('utc', now()),

  -- Present with its trigger in section 11, on the same reasoning as section 5:
  -- sort_order is mutable, so the column is meaningful, and an updated_at
  -- without a trigger would be false after the first reorder.
  updated_at    timestamptz not null default timezone('utc', now()),

  -- The pair is unique: a page lists a given classroom once. Listing it twice
  -- would render the same room twice on one umbrella page, which no source
  -- entry does -- all 12 references across the two pages are distinct.
  constraint page_classrooms_page_id_classroom_id_key
    unique (page_id, classroom_id),

  -- Both cascade, and the cascade is THE DATABASE'S FLOOR RATHER THAN THE
  -- PRODUCT BEHAVIOUR. The two are not in conflict and the distinction matters,
  -- so it is stated here rather than left to be discovered:
  --
  -- Deletion of a page BLOCKS while it is referenced by page_classrooms --
  -- alongside nav_items and announcements -- and that refusal is enforced by
  -- the migration 16 write functions, not by this constraint. `delete-entry`
  -- refuses and the editor LISTS THE BLOCKERS so an admin can see what would
  -- break; forcing it is a separate admin action, `force-delete-entry`, which
  -- removes the references in the same transaction under one change_set_id and
  -- never orphans a route. Migration 12 states the same pairing from its side
  -- at 20260901121200_nav_items.sql:116 and migration 14 records the forced
  -- path at 20260901121400_content_revisions.sql:119.
  --
  -- The cascade therefore exists so that a FORCED deletion cannot leave a row
  -- pointing at a page or a classroom that no longer exists -- not so that
  -- either can be deleted casually.
  constraint page_classrooms_page_id_fkey
    foreign key (page_id) references public.pages (id) on delete cascade,

  constraint page_classrooms_classroom_id_fkey
    foreign key (classroom_id) references public.classrooms (id) on delete cascade
);


-- -----------------------------------------------------------------------------
-- 10. page_classrooms · the ordering constraint
-- -----------------------------------------------------------------------------
-- Same form and same reasoning as section 7: declared drop-then-add so the
-- deferrability is re-asserted on every apply, `nulls not distinct` for
-- schema-wide consistency though page_id is not null, and deferrable so a
-- reorder can swap two positions inside one transaction without renumbering
-- through a temporary hole.
--
-- Scope is (page_id, sort_order), so the two umbrella pages order their
-- classroom lists independently -- day-programs positions 1-7 and
-- language-programs positions 1-5 coexist, which is exactly what the source
-- holds.

alter table public.page_classrooms
  drop constraint if exists page_classrooms_page_id_sort_order_key;

alter table public.page_classrooms
  add constraint page_classrooms_page_id_sort_order_key
  unique nulls not distinct (page_id, sort_order)
  deferrable initially immediate;


-- -----------------------------------------------------------------------------
-- 11. page_classrooms · row level security, trigger and index
-- -----------------------------------------------------------------------------
-- RLS on, zero policies, per section 2. Like classroom_teachers this table has
-- no `published` of its own, so migration 17's anon policy reaches through both
-- foreign keys: the relation is public only if the page is published and the
-- classroom is published.

alter table public.page_classrooms enable row level security;


drop trigger if exists set_page_classrooms_updated_at on public.page_classrooms;

create trigger set_page_classrooms_updated_at
  before update on public.page_classrooms
  for each row
  execute function public.set_updated_at();


-- The forward direction -- "which classrooms does this page list, in order" --
-- is served by the leading column of page_classrooms_page_id_sort_order_key.
--
-- This index covers the reverse direction: "which pages reference this
-- classroom", which is both the cascade's supporting index on a classroom
-- deletion and the editor's blocker listing when a delete is refused.
create index if not exists page_classrooms_classroom_id_idx
  on public.page_classrooms (classroom_id);



-- -----------------------------------------------------------------------------
-- 12. Comments
-- -----------------------------------------------------------------------------
-- These are the durable half of this file's documentation. content/ is deleted
-- at the end of the migration phase, so every measured figure a later reader
-- might want to check is restated here where it lives in the database itself
-- rather than only in a comment block that a schema dump would drop.

comment on table public.classrooms is
  'The 13 classroom entries from content/collections/classrooms/*.md, 1 of them '
  'a draft. Routed at /programs/<slug> -- the source declares '
  'route: ''programs/{slug}'' WITHOUT a leading slash, which migration 15 '
  'normalizes. That namespace is SHARED with the umbrella pages, which are '
  '`pages` rows, so migration 15''s content_routes view gives classrooms '
  'precedence 2 (pages 1, classrooms 2, people 3, events 4); all 142 derived '
  'paths are unique today, making these overlapping namespaces rather than '
  'collisions. Rendered by the `room` presenter. The source collection also '
  'declares date_behavior {past: public, future: private}, which is INERT and '
  'is deliberately not reproduced anywhere in this schema: the collection is '
  'not `dated` and no entry carries an entry-level date key, so publish state '
  'alone governs visibility.';

comment on column public.classrooms.id is
  'Primary key. Seeded rows derive theirs from '
  'public.ces_uuid(''classrooms'', legacy_ref), which is what makes the load '
  'idempotent and lets classroom_teachers and page_classrooms reference a '
  'classroom before it is inserted; the gen_random_uuid() default serves rows '
  'the editor creates later.';

comment on column public.classrooms.legacy_ref is
  'The source Statamic entry id, e.g. 448d749d-93d0-4c81-bd6f-806e5e431849. '
  'Nullable-unique: nulls are distinct in Postgres, so any number of '
  'editor-created rows coexist while no two migrated rows can collide on their '
  'source id.';

comment on column public.classrooms.slug is
  'The route key -- /programs/<slug>. Derived from the source FILENAME: not one '
  'of the 13 entries carries a `slug:` key, because Statamic takes it from the '
  'file name. Also the final tie-breaker of every ordering involving this '
  'table, which is what makes equal sort_order values still produce a stable '
  'order.';

comment on column public.classrooms.title is
  'The classroom name, e.g. Blue Room. Required: '
  'resources/blueprints/collections/classrooms/classrooms.yaml:10-12 declares '
  '`required: true` and `validate: [required]`.';

comment on column public.classrooms.description is
  'Prose description. `type: textarea` at classrooms.yaml:14-20, so plain text '
  'and NOT bard -- it holds no ProseMirror document and needs no rich-text '
  'renderer. Nullable, because it is the one declared content field carrying no '
  '`validate` key.';

comment on column public.classrooms.age_range is
  'The classroom''s age band. PROMOTED from an undeclared source key present on '
  '2 of the 13 entries -- the blueprint models it nowhere -- because it is the '
  'value the target actually renders. It is the ONLY one of the five drift keys '
  'promoted to a column: `programs` (12 of 13), `ages` (12), `program_type` (4) '
  'and `integer` (3) are retained in the `legacy` jsonb instead, because the '
  'target has no renderer for them and inventing four columns for values '
  'nothing displays would be worse than keeping them queryable. This promotion '
  'is also half the fix for a live defect: /programs/blue-room currently '
  'renders an empty <h3></h3> because the entry carries `ages: '
  'upper-preschool` as a plain string the blueprint never declared, so Antlers'' '
  ':title modifier cannot resolve it.';

comment on column public.classrooms.published is
  'Publish state, and the ONLY thing governing public visibility of a '
  'classroom. Draft is the safe default: a load error must never publish '
  'content. 1 of the 13 source entries is a draft and that flag migrates '
  'exactly. Migration 17''s anon policy returns only published rows -- a draft '
  'is not fetched then hidden, it is not returned.';

comment on column public.classrooms.sort_order is
  'Manual ordering for the collection surface at '
  '/admin/collections/classrooms; classrooms IS manually orderable. There is '
  'deliberately NO uniqueness constraint on it, only a plain index: the '
  'deferrable `unique nulls not distinct (parent_id, sort_order)` convention in '
  'this schema applies to CHILD tables, which have a parent column to scope '
  'uniqueness by, and classrooms is a flat collection with none. A '
  'collection-wide unique would make the seed load and every reorder a '
  'constraint-juggling exercise for no gain, since reorder-entries in migration '
  '16 renumbers siblings transactionally and the public orderings end in slug, '
  'which is unique -- so equal sort_order values still produce a stable, '
  'defined order. This matches public.people and public.promoted, the schema''s '
  'other two flat collections. No default, so create-entry must compute a '
  'position (max + 1) rather than silently pile new rows at zero.';

comment on column public.classrooms.seo_title is
  'Per-route SEO title override. Net-new: no legacy route carries one. Null '
  'means the deterministic fallback chain in nextjs/lib/seo.ts composes the '
  'title instead.';

comment on column public.classrooms.seo_description is
  'Per-route meta description override. Net-new -- not one of the legacy routes '
  'has a meta description at all. Null falls back to age_range plus the opening '
  'of description.';

comment on column public.classrooms.og_image_id is
  'Per-route Open Graph image. Net-new, and `og_image_id` is this column''s '
  'name everywhere in the plan -- a second name for the same column is how a '
  'metadata function and a migration end up disagreeing. NO on-delete action, '
  'therefore NO ACTION, therefore deleting an asset any classroom references is '
  'BLOCKED; the editor lists the referencing rows and an admin decides. `on '
  'delete set null` is deliberately not used even though the column is '
  'nullable, because it is impossible on promoted.image_asset_id (not null) and '
  'one rule across the schema beats two.';

comment on column public.classrooms.legacy is
  'The undeclared drift keys, retained verbatim and queryably: `programs` (on '
  '12 of 13 entries), `ages` (12), `program_type` (4), `integer` (3), plus the '
  'raw forward `teachers` array. Retention is IN THE DATABASE and not only in '
  'nextjs/data/fallback/*.json, which is the point: parity is verified against '
  'the live schema, and a later decision to normalize any of these is then a '
  'migration rather than a re-extraction from source files that no longer '
  'exist. The `teachers` array specifically is the forward half of the '
  'classroom-relation audit trail and must not be dropped as redundant with '
  'classroom_teachers -- it is the evidence for a reconciliation that adds 17 '
  'visible associations, listed for school review in '
  'artifacts/parity-report.json. Its reverse counterpart is '
  'people.legacy.classrooms (migration 06).';

comment on column public.classrooms.source_updated_at is
  'The source entry''s own `updated_at`, held VERBATIM and never defaulted. '
  'Defaulting it to load time would destroy real provenance, which is why it is '
  'separate from the operational updated_at and why no trigger touches it.';

comment on column public.classrooms.source_updated_by is
  'The source entry''s `updated_by`, mapped from the two known Statamic user '
  'ids to their addresses -- 1179db75-8eeb-4bad-8e60-d5005aef7ef8 -> '
  'bekah@cambridge-ellis.org and b863e707-3140-4001-859f-3487e09c5881 -> '
  'conrad.fulbrook@gmail.com -- and held verbatim for anything unrecognized. '
  'text rather than a foreign key to auth.users on purpose: neither legacy '
  'account can be imported (their bcrypt hashes cannot transfer and no '
  'plaintext exists), so both are re-provisioned by invitation and a foreign '
  'key would either fail the load or force a fabricated account.';

comment on column public.classrooms.created_at is
  'When the row was created in THIS database. An operational column describing '
  'a target write, distinct from source_updated_at. Column default only; no '
  'trigger maintains it.';

comment on column public.classrooms.updated_at is
  'When the row was last written in THIS database. Maintained solely by the '
  'set_classrooms_updated_at trigger via public.set_updated_at(); no '
  'application code and no migration 16 write function may set it, so it can be '
  'neither forged nor forgotten. Also the value the optimistic per-field '
  'conflict check compares against, so a stale write is rejected rather than '
  'silently overwriting a concurrent edit.';


comment on table public.classroom_teachers is
  'Which people teach in which classroom: THE UNION of the two disagreeing '
  'source directions, and the single most consequential data decision in this '
  'migration. Measured with a real YAML parse over the actual entries: the '
  'forward direction (classrooms.teachers) declares 32 pairs, the reverse '
  '(people.classrooms) declares 24, and only 15 appear in both -- so the union '
  'is 41 rows: 17 forward-only, 9 reverse-only, 15 both. Zero dangling '
  'references exist in either direction. The legacy template renders the '
  'REVERSE query, so adopting the declared forward relation alone would '
  'silently REMOVE 9 associations the site displays today and ADD 17 it does '
  'not; neither direction is "the" data and neither is acceptable under "no '
  'content is lost". Every row is therefore tagged with the direction that '
  'declared it, both raw source arrays are retained on their own rows '
  '(classrooms.legacy.teachers and people.legacy.classrooms), and '
  'tools/src/verify-parity.ts lists the 17 additions and the 9 forward-gaps as '
  'a named review section in artifacts/parity-report.json. A 32-row or 24-row '
  'table is a content loss and a parity failure. All editing after the '
  'migration is on this one table.';

comment on column public.classroom_teachers.id is
  'Surrogate primary key. Chosen over a composite key on (classroom_id, '
  'person_id) for two reasons, since both shapes guarantee pair uniqueness: '
  'every table in this schema carrying sort_order carries a surrogate uuid id, '
  'and the one composite-keyed table (public.person_roles) is precisely the one '
  'with no sort_order; and migration 14 declares content_revisions.row_id as a '
  'single uuid, so an auditable, restorable per-row reorder needs one column to '
  'name. There is deliberately no legacy_ref: the derived-child-identity rule '
  'presumes ONE parent, and a union row has two candidates -- deriving from the '
  'classroom would misrepresent the 9 reverse-only rows and deriving from the '
  'person would misrepresent the 17 forward-only ones. The pair is the '
  'identity; `source` is the provenance.';

comment on column public.classroom_teachers.classroom_id is
  'The classroom. Cascades on delete: the association has no meaning without '
  'it. Not relaxed to tolerate a bad extraction -- there are zero dangling '
  'references in the source, so a dangling id means the extractor is wrong and '
  'must fail the load loudly.';

comment on column public.classroom_teachers.person_id is
  'The teacher. Cascades on delete, same reasoning as classroom_id. Indexed '
  'separately because "which classrooms does this person teach in" is the query '
  'behind every bio page and the lookup a person deletion must make.';

comment on column public.classroom_teachers.sort_order is
  'Order of the teacher within the classroom''s list. Public output orders by '
  'sort_order then the person''s slug as the final tie-breaker, which is what '
  'gives the 9 reverse-only rows -- which have no forward ordinal to inherit -- '
  'a stable, defined position. Scoped uniqueness only: '
  'classroom_teachers_classroom_id_sort_order_key is unique nulls not distinct '
  '(classroom_id, sort_order) and DEFERRABLE initially immediate, so two '
  'different classrooms may share a position while a reorder can swap two '
  'positions inside one transaction without renumbering through a temporary '
  'hole.';

comment on column public.classroom_teachers.source is
  'Which source direction declared this pair -- forward (from '
  'classrooms.teachers), reverse (from people.classrooms), or both. A closed '
  'vocabulary of exactly three values, enforced by '
  'classroom_teachers_source_check and listed among this schema''s closed '
  'vocabularies at 20260901120700_events.sql:227. This is the column that makes '
  'the union auditable in both directions and the reason nothing had to be '
  'dropped to reconcile the two lists. Expected distribution over the canonical '
  'load: 17 forward, 9 reverse, 15 both = 41 rows. `both` is not redundant with '
  'the other two -- it is the 15-row overlap, and collapsing it into either '
  'neighbour would destroy the evidence that the two directions agreed. No '
  'default: the extractor knows which direction produced each row and must say '
  'so.';

comment on column public.classroom_teachers.created_at is
  'When the association was made in this database. Column default only.';

comment on column public.classroom_teachers.updated_at is
  'When the association was last written. Maintained by the '
  'set_classroom_teachers_updated_at trigger, never by application code. This '
  'table carries the column -- unlike public.person_roles, which is immutable '
  'by nature and has created_at alone -- because a reorder genuinely rewrites '
  'sort_order, and an updated_at without a trigger would be truthful only until '
  'the first edit.';


comment on table public.page_classrooms is
  'The ordered `classrooms` relation on the umbrella pages, from '
  'resources/blueprints/collections/pages/programsumbrella.yaml:65. Exactly 12 '
  'rows from exactly 2 of the 34 pages, verified by reading both entries: '
  'day-programs carries 7 classroom references and language-programs carries 5. '
  'A join table with a sort_order rather than a jsonb array on public.pages '
  'because the relation is ORDERED and the order is what the page renders -- and '
  'because an array could not be a foreign key, so a deleted classroom would '
  'leave a dangling id inside a json document that nothing checks, which is the '
  'class of drift this schema exists to end. Deletion of a page BLOCKS while it '
  'is referenced here, alongside nav_items and announcements, enforced by the '
  'migration 16 write functions rather than by the cascade.';

comment on column public.page_classrooms.id is
  'Surrogate primary key, for the same two reasons as '
  'classroom_teachers.id: this table is ordered and reorderable, and a reorder '
  'must name a single uuid in content_revisions.row_id. No legacy_ref -- the '
  'pair is the natural key and the source order is carried in sort_order.';

comment on column public.page_classrooms.page_id is
  'The umbrella page listing the classroom -- one of exactly two pages in the '
  'corpus. Cascades on delete, which is THE DATABASE''S FLOOR AND NOT THE '
  'PRODUCT BEHAVIOUR: migration 16''s delete-entry REFUSES while a page is '
  'referenced here and the editor lists the blockers, and the separate '
  'force-delete-entry action removes the references in the same transaction '
  'under one change_set_id and never orphans a route. The cascade exists so a '
  'forced deletion cannot leave a row pointing at a page that no longer '
  'exists.';

comment on column public.page_classrooms.classroom_id is
  'The classroom being listed. Cascades on delete, on the same '
  'floor-not-behaviour reasoning as page_id. Indexed because "which pages '
  'reference this classroom" is both the cascade''s supporting index and the '
  'editor''s blocker listing when a delete is refused.';

comment on column public.page_classrooms.sort_order is
  'Order of the classroom within the page''s list -- day-programs holds '
  'positions for its 7 references and language-programs for its 5. Scoped '
  'uniqueness only: page_classrooms_page_id_sort_order_key is unique nulls not '
  'distinct (page_id, sort_order) and DEFERRABLE initially immediate, so the '
  'two pages order independently and a reorder swaps positions inside one '
  'transaction.';

comment on column public.page_classrooms.created_at is
  'When the relation row was created in this database. Column default only.';

comment on column public.page_classrooms.updated_at is
  'When the relation row was last written. Maintained by the '
  'set_page_classrooms_updated_at trigger, never by application code, because '
  'sort_order is mutable and a column without its trigger would be false after '
  'the first reorder.';
