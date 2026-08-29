-- =============================================================================
-- Cambridge-Ellis School  ·  migration 05 of 18  ·  page sections
-- =============================================================================
-- Creates exactly one table: public.page_sections. Every repeater across the six
-- page blueprints collapses into it, which is why it is self-referencing and why
-- its `kind` vocabulary is closed.
--
-- It runs fifth because it carries foreign keys to two tables that must already
-- exist: public.pages (migration 04) and public.assets (migration 02). It also
-- uses extensions.gen_random_uuid() and public.set_updated_at() from migration
-- 01, which names this migration among that trigger function's callers.
--
-- THE SPLIT RULE, stated in migration 04 and honoured from this side: a scalar
-- or single asset reference becomes a typed column on `pages`; a repeater
-- becomes ordered rows here. Migration 04 marks six of its source keys `(05)`
-- and omits them from its own table by design, not by omission. This file is
-- where they land.
--
-- Source of truth for the field set, read rather than assumed:
--
--   resources/blueprints/collections/pages/flexible_content_page.yaml
--                                  the `add_content` replicator and its four
--                                  sets: text (bard, save_html: false, L55),
--                                  image (L70-83), quote (L84-103) and movie
--                                  (L104-117, declared `type: assets` at L115).
--   resources/blueprints/collections/pages/home.yaml
--                                  the `slideshow` replicator, whose `image`
--                                  set carries TWO fields -- `image` and
--                                  `happy_verb` (L35-44); the `at_a_glance`
--                                  replicator, `max_sets: 4` (L72), whose
--                                  `statistic` set declares `number` as
--                                  `type: text` (L83); and the nine flat
--                                  testimonial_1/2/3 (+_attribution, +_image)
--                                  fields, all nine `validate: required`.
--   resources/blueprints/collections/pages/programsumbrellasummer.yaml
--                                  `programs_offered` (L65-95) and `sessions`
--                                  (L97-189), the latter nesting
--                                  `programs_in_this_session` (L125). This is
--                                  the file that proves the `program` set has
--                                  two different field shapes.
--   resources/blueprints/collections/pages/programsumbrella.yaml
--                                  `slideshow` declared `type: assets` with
--                                  `mode: list` (L42-52) -- a FLAT asset list,
--                                  not a replicator. Its rows still land here.
--   content/collections/pages/home.md
--                                  5 slideshow sets, each with an `image` and a
--                                  `happy_verb` ('We Play', 'We Wonder', 'We
--                                  Explore', 'We Make', 'We Grow'); 3
--                                  at_a_glance sets whose `number` values are
--                                  '41', '5:1' and '9'.
--   content/collections/pages/summer-programs.md
--                                  the one `sessions` set (id v9xeLPP5) and its
--                                  one nested `program` child (id voiW3WLF) --
--                                  the concrete case that exercises
--                                  parent_section_id.
--   content/collections/pages/frequently-asked-questions.md
--                                  one `add_content` set of type `text` whose
--                                  bard document holds 11 `Q:` and 11 matching
--                                  `A:` paragraphs as ordinary prose behind a
--                                  level-2 'Language Program' heading.
--   content/collections/pages/tuition.md
--                                  all 50 table-family ProseMirror nodes in the
--                                  entire corpus.
--
-- The measured source volumes this DDL must accept, which is what makes the
-- nullability below evidence rather than preference:
--
--   23 pages  add_content       -> `text`, `image`, `quote`, `movie` rows
--             (the 22 flexpages + school-age-mandarin-for-grades-k-through-3rd)
--    5 pages  slideshow         -> home.md's is a REPLICATOR (set `image` with
--             image + happy_verb) and becomes `slide` rows; the other four
--             (day-programs, enrichment-programs, language-programs,
--             summer-programs) are flat asset lists on the umbrella blueprints
--             and become `image` rows, or `slide` rows with happy_verb null
--    1 page   at_a_glance       -> `statistic` rows, at most 4 (max_sets: 4)
--    1 page   testimonial_1/2/3 -> exactly 3 `testimonial` rows
--    1 page   sessions          -> 1 `session` row with nested `program`
--                                  children -- the parent_section_id case
--    2 pages  programs_offered  -> `program` rows (enrichment-programs,
--             summer-programs). A SIBLING repeater, not a nested one.
--    1 page   FAQ split         -> exactly 11 `faq_item` rows
--    6 rows   enabled = false   -> apply x2, auction, careers, deposits,
--             enrichment-programs. The seventh `enabled: false` record in the
--             corpus is a person_education row and belongs to migration 06.
--
-- `important_notes` is deliberately NOT here. It is a standalone bard field, so
-- a single value and therefore a column on `pages` (migration 04), not a
-- repeater.
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   page_classrooms   MIGRATION 08, emphatically not this file. It carries
--                     foreign keys to BOTH `pages` (04, present) and
--                     `classrooms` (08), so only in 08 do both parents exist --
--                     the same dependency-order reasoning that puts
--                     person_roles with `people` rather than with the taxonomy
--                     it references. Migration 04 says the same thing at its
--                     own lines 64-68. There is exactly one owner and no stub
--                     here; a `create table page_classrooms` in this file would
--                     not even apply, because public.classrooms does not exist
--                     yet.
--   policies          migration 17. This file enables row level security and
--                     writes ZERO policies; see section 3.
--   write functions   migration 16. Reorders, per-kind shape validation and the
--                     capability checks all live there.
--   content_routes    migration 15. Sections are not routable.
--   the actual rows   supabase/seed.sql is the canonical load. Nothing is
--                     inserted here.
--
-- PostgreSQL 17. Every statement is idempotent -- `create table if not exists`,
-- `create index if not exists`, `drop constraint if exists` before `add
-- constraint`, and `drop trigger if exists` before `create trigger` -- so
-- applying all eighteen migrations twice is clean.
--
-- All SQL below is lowercase, per the contract in migration 01.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
-- One table serves ten kinds. That is a deliberate normalization of five
-- separate replicators plus two derived shapes, and it is what lets
-- SectionRenderer dispatch on a single column instead of the
-- `{{ if type == 'text' }}...{{ elseif }}` ladder in flexpage.antlers.html.
--
-- The consequence, which section 2 returns to: no per-kind column may be `not
-- null`, because a value that is required for one kind is meaningless for the
-- other nine.

create table if not exists public.page_sections (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule. Seeded rows do not rely on this default -- they derive their
  -- id from public.ces_uuid('page_sections', legacy_ref), which is what makes
  -- the load idempotent and lets a nested `program` row reference its `session`
  -- parent before that parent is inserted -- so the default serves
  -- editor-created rows.
  id                   uuid primary key default extensions.gen_random_uuid(),

  -- The DERIVED composite `<parent legacy_ref>:<field handle>:<ordinal>`. Never
  -- a source id; see the column comment for why that is mandatory rather than
  -- stylistic.
  legacy_ref           text unique,

  -- The owning page. `on delete cascade`: a section has no meaning apart from
  -- its page, and it carries no `published` flag of its own, so the page's
  -- lifetime is exactly the section's.
  page_id              uuid not null references public.pages (id) on delete cascade,

  -- Nullable self-reference: null for a top-level section, set for a nested
  -- one. Genuinely exercised, not speculative -- see the column comment.
  parent_section_id    uuid references public.page_sections (id) on delete cascade,

  -- Which of the ten shapes this row is. Closed vocabulary, constrained in
  -- section 2.
  kind                 text not null,

  -- Position among siblings. Constrained in section 2, not inline, because the
  -- constraint it needs is null-safe and deferrable and spans three columns.
  sort_order           integer not null,

  -- Editorial state Statamic honours and no blueprint declares. `not null
  -- default TRUE`, which is the opposite of `published`'s `default false`, and
  -- the asymmetry is deliberate; see the column comment.
  enabled              boolean not null default true,

  -- ---------------------------------------------------------------------------
  -- Typed per-kind columns. Every one is nullable, and every named source field
  -- gets its own column rather than a jsonb key. `data` at the foot of this list
  -- is a remainder-only escape hatch, not a dumping ground.
  -- ---------------------------------------------------------------------------

  -- The ProseMirror document for a `text` section. jsonb is correct here and is
  -- consistent with the project's jsonb rule rather than an exception to it: a
  -- rich-text document genuinely IS a variable tree. The column comment carries
  -- the argument and the canonical shape, because a reader applying that rule
  -- mechanically will otherwise flag this line.
  body                 jsonb,

  -- The single asset reference behind `image`, `slide` and `testimonial`. All
  -- three source fields declare `max_files: 1`, so this is a typed foreign key
  -- rather than an array. NO referential action, which is the contract
  -- migration 02 states for all of migrations 04-11: deleting a referenced
  -- asset is BLOCKED and the editor answers by listing the referencing rows.
  asset_id             uuid references public.assets (id),

  -- Image caption. Note for the reader who compares this against the legacy
  -- template: `caption` is NOT a field the `image` set declares -- see the
  -- column comment.
  caption              text,

  -- The `slide` kind's second field, and the one thing most easily lost in this
  -- migration. Do not remove it; see the column comment.
  happy_verb           text,

  -- Shared by the `quote` and `testimonial` kinds. `quote_text` rather than
  -- `quote` because the unqualified word is the kind, not the value.
  quote_text           text,
  attribution          text,

  -- The `movie` kind's destination, as a URL rather than an asset foreign key.
  -- This is an AUTHORIZED DEVIATION from the blueprint's declared `type:
  -- assets`; see the column comment before changing it.
  embed_url            text,

  -- The `statistic` kind. `stat_number` is TEXT and must stay text; the column
  -- comment names the value that proves it.
  stat_number          text,
  stat_caption         text,

  -- The `program` kind, covering the UNION of its two different source shapes.
  -- All five are text: they hold strings such as '8:30 - 4pm, $2750', not
  -- numbers. See the note in section 2 on why no check constraint tries to
  -- police which subset applies.
  program_title        text,
  program_description  text,
  half_day_price       text,
  full_day_price       text,
  extended_day_price   text,

  -- The `session` kind. `session_dates` is text holding prose -- the one real
  -- value is 'June 22nd – July 17th (We are closed Friday July 3rd)' -- and is
  -- emphatically not a date or a range type.
  session_title        text,
  session_dates        text,

  -- The `faq_item` kind. Both plain text, and that choice is deliberate and
  -- consistent; see the column comment on `answer`.
  question             text,
  answer               text,

  -- The remainder-only escape hatch and the queryable retention column. Both
  -- `not null default '{}'::jsonb` so a reader never has to distinguish "no
  -- remainder" from "unknown".
  data                 jsonb not null default '{}'::jsonb,
  legacy               jsonb not null default '{}'::jsonb,

  -- Operational timestamps describing target writes. `updated_at` is maintained
  -- exclusively by the trigger in section 4; no application code and no write
  -- function in migration 16 may set the column.
  created_at           timestamptz not null default timezone('utc', now()),
  updated_at           timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Constraints
-- -----------------------------------------------------------------------------
-- Declared as explicitly-named `alter table` statements rather than inline, for
-- two reasons: the names are then stable and greppable instead of
-- server-generated, and the `drop constraint if exists` / `add constraint` pair
-- is idempotent where a bare inline constraint is not.
--
-- ON WHAT IS DELIBERATELY *NOT* CONSTRAINED HERE, because it is the decision a
-- later reader is most likely to want to reverse:
--
-- There is NO per-kind check constraint -- nothing that says "a `program` row
-- must have a program_title" or "a `faq_item` row must have a question". That is
-- a considered choice, not an omission, and the source is what settles it:
--
--   * summer-programs.md's one nested `program` set (id voiW3WLF) carries
--     half_day_time_and_price, full_day_time_and_price and
--     extended_day_time_and_price but NO program_title at all. That unset title
--     is exactly why an empty <h5> renders on /programs/summer-programs today.
--     A `check (kind <> 'program' or program_title is not null)` would abort the
--     canonical load on this real row.
--   * the same file's one `programs_offered` set (id ml1ape2m) carries a
--     program_title and no program_description, which is why an empty <p>
--     renders beneath it.
--
-- Per-kind shape is therefore enforced where it can be enforced without
-- rejecting real history: nextjs/lib/schema.ts and the security definer write
-- functions in migration 16 validate shape on every CREATE and EDIT, while the
-- legacy corpus loads grandfathered. This mirrors the project-wide treatment of
-- the blueprints' character limits, which migration 01 records at its lines
-- 42-45, and it keeps the DDL from being the one thing that can make a faithful
-- migration impossible.

-- The closed `kind` vocabulary: exactly these ten values, in this order for
-- readability. Six come from replicator set names in the blueprints (`text`,
-- `image`, `quote`, `movie`, `statistic`, `program`), one from a set name plus a
-- nesting role (`session`), one from a replicator whose set is also called
-- `image` but which carries a second field (`slide`), and two are derived shapes
-- no blueprint declares (`faq_item`, `testimonial`).
--
-- Adding a value here is a schema change with three other owners:
-- SectionRenderer's dispatch, components/cms/registry.ts, and the
-- `update-section` command's Zod schema. A value present in the database that
-- none of those three knows about renders as nothing.
alter table public.page_sections drop constraint if exists page_sections_kind_check;
alter table public.page_sections add constraint page_sections_kind_check
  check (kind in (
    'text',
    'image',
    'quote',
    'movie',
    'slide',
    'statistic',
    'program',
    'session',
    'faq_item',
    'testimonial'
  ));

-- Sibling ordering. Four properties of this constraint are load-bearing and none
-- of them is stylistic:
--
--   the three-column tuple  siblings are scoped by BOTH page_id and
--                           parent_section_id. Scoping by page_id alone would
--                           make a nested `program` row compete for positions
--                           with the top-level sections of the same page;
--                           scoping by parent_section_id alone would make every
--                           top-level section on every page compete, since that
--                           column is null for all of them.
--   `nulls not distinct`    is MANDATORY. Under the default `nulls distinct`,
--                           two rows with a null parent_section_id are never
--                           considered equal -- so every top-level section on a
--                           page could share position 1 and the constraint
--                           would silently enforce nothing at exactly the level
--                           where order is most visible. Top-level sections are
--                           the overwhelming majority of this table.
--   `deferrable`            because a reorder legitimately passes through
--                           colliding intermediate states. It runs as one
--                           transaction inside the `reorder-sections` write
--                           function in migration 16, which renumbers siblings
--                           and only needs the invariant to hold at commit.
--   `initially immediate`   so the default behaviour is still to fail fast on a
--                           plain bad insert; the write function opts into
--                           deferral with `set constraints ... deferred` when it
--                           actually needs it.
--
-- A note for whoever writes supabase/seed.sql: a DEFERRABLE unique constraint
-- cannot serve as an `on conflict` arbiter. Use `on conflict (legacy_ref)`,
-- whose unique constraint in section 1 is not deferrable and is the intended
-- idempotency key for the load anyway.
--
-- Note also that this constraint indexes page_id as its leading column. The
-- separate page_id index in section 5 is therefore partly redundant, and is
-- declared anyway; see the note there.
alter table public.page_sections
  drop constraint if exists page_sections_page_parent_sort_order_key;
alter table public.page_sections
  add constraint page_sections_page_parent_sort_order_key
  unique nulls not distinct (page_id, parent_section_id, sort_order)
  deferrable initially immediate;


-- -----------------------------------------------------------------------------
-- 3. Row level security
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies, neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table that holds the body copy of
-- two unpublished pages and six explicitly disabled records.
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that load.
--
-- Migration 17 owns the policy set, and for THIS table it is genuinely
-- non-obvious, which is the reason it is described here rather than left to be
-- rediscovered:
--
--   * this table has no `published` column of its own, so the `anon` policy
--     cannot be a predicate on this row alone. It must check the OWNING PAGE's
--     `published` -- an exists() against public.pages -- AND this row's
--     `enabled`. A disabled section renders to nobody.
--   * the `authenticated` policy (active admin_users membership plus aal2)
--     deliberately IGNORES `enabled`, because a disabled record must stay
--     visible and toggleable in edit mode and must round-trip through export.
--     That asymmetry between the two policies is the whole point of the column.
--   * direct DML is REVOKED from `authenticated` entirely, so every write goes
--     through a security definer function in migration 16 that re-checks
--     session, membership, assurance level and capability.

alter table public.page_sections enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, which names this migration
-- among its callers. `updated_at` therefore cannot be forged and cannot be
-- forgotten: no application code and no write function in migration 16 may set
-- the column.
--
-- It is not decorative here. The optimistic concurrency check in migration 16
-- compares the `updated_at` a field was rendered with against the row's current
-- value and rejects a stale write, so this trigger is the mechanism that makes
-- per-field conflict rejection possible at all.
--
-- `created_at` is deliberately left as a column default only.

drop trigger if exists set_page_sections_updated_at on public.page_sections;

create trigger set_page_sections_updated_at
  before update on public.page_sections
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes
-- -----------------------------------------------------------------------------
-- `legacy_ref` is already indexed by its unique constraint, so it is not
-- repeated here. Each index below backs a named access path rather than being
-- added speculatively.

-- Every foreign key gets an index, which is the project rule. This one is also
-- the single hottest access path in the table: rendering any of the 23 pages
-- that carry `add_content` reads its sections by page_id. It is partly redundant
-- against page_sections_page_parent_sort_order_key, which indexes page_id as its
-- leading column, and it is declared anyway -- the FK-index rule is stated
-- unconditionally, the cost on a table of this size is nil, and a future change
-- to that constraint would otherwise silently remove the only index on a
-- foreign key.
create index if not exists page_sections_page_id_idx
  on public.page_sections (page_id);

-- The self-referencing foreign key. Read when a `session` row's nested
-- `program` children are fetched, and walked by the cascade on delete.
create index if not exists page_sections_parent_section_id_idx
  on public.page_sections (parent_section_id);

-- Not decorative: the single visibility predicate in migration 16,
-- published_reference_count(asset_id), unions a lookup against every
-- asset-referencing column in the schema, and a blocked asset delete has to list
-- the referencing rows. Both queries scan by asset id.
create index if not exists page_sections_asset_id_idx
  on public.page_sections (asset_id);

-- SectionRenderer dispatches on kind, and the FAQ page reads only its
-- `faq_item` rows while the home page reads only `slide`, `statistic` and
-- `testimonial`.
create index if not exists page_sections_kind_idx
  on public.page_sections (kind);

-- The `anon` policy in migration 17 is itself a predicate on this column, and
-- the collection surfaces filter disabled records in and out.
create index if not exists page_sections_enabled_idx
  on public.page_sections (enabled);

-- The ordered read, which is how every presenter actually consumes this table:
-- the sections of one page in document order. Composite so the sort is served
-- from the index rather than by a sort node on top of a page_id lookup.
create index if not exists page_sections_page_id_sort_order_idx
  on public.page_sections (page_id, sort_order);


-- -----------------------------------------------------------------------------
-- 6. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. content/, resources/ and public/assets/ are
-- removed by the end of the migration phase -- on this branch they are already
-- gone -- so after cutover the database itself is the only place a reader can
-- learn why a column exists, where its values came from, or what a value means.

comment on table public.page_sections is
  'Every repeater across the six page blueprints, normalized into one ordered, '
  'self-referencing table: add_content (23 pages) as text/image/quote/movie, '
  'slideshow (5 pages) as slide or image, at_a_glance (1 page, max 4) as '
  'statistic, programs_offered (2 pages) and the nested programs_in_this_session '
  'as program, sessions (1 page) as session, plus two shapes no blueprint '
  'declares: 11 faq_item rows split out of frequently-asked-questions.md and 3 '
  'testimonial rows built from home.md nine flat testimonial fields. A scalar '
  'or single asset reference lives on pages (migration 04); a repeater lives '
  'here. Ten kinds share one table, which is why no per-kind column is not '
  'null. page_classrooms is NOT part of this table or this migration: it is an '
  'ordered page-to-classroom relation and belongs to migration 08, where both '
  'of its parents exist.';

comment on column public.page_sections.id is
  'Surrogate key. Seeded rows derive it from '
  'public.ces_uuid(''page_sections'', legacy_ref) rather than using the '
  'default, which is what makes the load idempotent and lets a nested program '
  'row reference its session parent before that parent is inserted.';

comment on column public.page_sections.legacy_ref is
  'DERIVED child identity: <parent legacy_ref>:<field handle>:<ordinal within '
  'that field>, ordinal in source order. It cannot be taken from the source id, '
  'and that is a fact about the corpus rather than a preference: replicator sets '
  'do not reliably carry one -- seven of the 81 institution sets and three of '
  'the four quote sets have no id at all, and ProseMirror nodes never do. Where '
  'a source id does exist (deposits.md carries OR52n05c on its second '
  'add_content set) it is retained in legacy.set_id for traceability but is NOT '
  'the identity. Unique, and not deferrable, so it is the correct on conflict '
  'arbiter for supabase/seed.sql.';

comment on column public.page_sections.page_id is
  'The owning page. on delete cascade: a section has no meaning apart from its '
  'page and carries no published flag of its own, so the page lifetime is '
  'exactly the section lifetime.';

comment on column public.page_sections.parent_section_id is
  'Nullable self-reference: null for a top-level section, set for a nested one. '
  'Genuinely exercised rather than speculative -- content/collections/pages/'
  'summer-programs.md carries one sessions set (id v9xeLPP5, Summer 2026) whose '
  'programs_in_this_session replicator holds one program child (id voiW3WLF), '
  'so a session row is the parent of program rows. That nesting is the only '
  'two-level structure in the corpus, and it is the reason this table is '
  'self-referencing instead of flat. Note that programs_offered is a SIBLING '
  'repeater, not a nested one, so its program rows have a null parent. Cascades '
  'on delete, so removing a session removes its programs.';

comment on column public.page_sections.kind is
  'Closed vocabulary of exactly ten values: text, image, quote, movie, slide, '
  'statistic, program, session, faq_item, testimonial. Six are replicator set '
  'names from the blueprints, one (session) is a set name plus a nesting role, '
  'one (slide) is the home.yaml slideshow set -- also called image in the source '
  'but carrying a second field, happy_verb -- and two (faq_item, testimonial) '
  'are derived shapes no blueprint declares. Replaces the '
  '{{ if type == ... }} ladder in flexpage.antlers.html with a single dispatch '
  'column. Adding a value requires matching changes in SectionRenderer, '
  'components/cms/registry.ts and the update-section command schema; a kind the '
  'renderer does not know renders as nothing.';

comment on column public.page_sections.sort_order is
  'Position among siblings, in source document order. Constrained by '
  'page_sections_page_parent_sort_order_key, which is scoped to (page_id, '
  'parent_section_id, sort_order) with nulls not distinct and is deferrable; see '
  'that constraint in section 2 for why all three properties are load-bearing.';

comment on column public.page_sections.enabled is
  'Real editorial state that Statamic honours and that NO blueprint declares. '
  'Six page-level records carry enabled: false in the source -- apply.md twice, '
  'and once each in auction.md, careers.md, deposits.md and '
  'enrichment-programs.md -- across more than one kind: deposits is a text set '
  'and enrichment-programs is a program set. The seventh such record in the '
  'corpus is a person_education row (migration 06). Default TRUE, deliberately '
  'the opposite of published default false: a section absent this flag is '
  'ordinary content and must render, whereas an entry absent a publish decision '
  'must not go public. Disabled rows are suppressed from public rendering, stay '
  'visible and toggleable in edit mode, and round-trip through export.';

comment on column public.page_sections.body is
  'The ProseMirror document for a text section. jsonb here is CONSISTENT with '
  'the project rule that jsonb is only for genuinely variable structure, not an '
  'exception to it: a rich-text document is a variable tree of nodes and marks, '
  'and no set of columns can represent it. Canonical shape is the TIPTAP shape '
  '-- a single doc node with a content array -- because that is what the editor '
  'round-trips without transformation and what the renderer walks. Legacy bard '
  'stores something different: a BARE ARRAY of nodes with no wrapper for a '
  'standalone field, or that same bare array under a set key inside a '
  'replicator. nextjs/lib/richtext.ts owns the one lossless conversion in both '
  'directions. The real contract of this column is the node inventory: text, '
  'paragraph, heading, bulletList, orderedList, listItem, blockquote, hardBreak, '
  'the marks bold, italic and link, AND THE WHOLE TABLE FAMILY -- table, '
  'tableRow, tableHeader, tableCell with colspan, rowspan and colwidth. All 50 '
  'table-family nodes in the corpus arrive in one row, the text section of '
  'content/collections/pages/tuition.md, and a renderer that skips them loses '
  'the entire fee schedule of 15 rows across five tables.';

comment on column public.page_sections.asset_id is
  'The single asset behind an image, slide or testimonial row; all three source '
  'fields declare max_files: 1, so this is a typed foreign key rather than an '
  'array. No referential action by design, per the contract migration 02 states '
  'for migrations 04-11: deleting a referenced asset is BLOCKED and the editor '
  'answers by listing the referencing rows. Replacement is an atomic swap in one '
  'transaction in migration 16.';

comment on column public.page_sections.caption is
  'Caption for an image row. Note for anyone reconciling this against the '
  'legacy output: the add_content image set declares only one field, image, and '
  'the legacy template reads photo and caption -- NEITHER of which exists in the '
  'blueprint -- which is why six image sets render nothing at all today. The '
  'target renders the declared asset, so this column starts empty and exists so '
  'an editor can add what the legacy template only pretended to read.';

comment on column public.page_sections.happy_verb is
  'The second field of the home.yaml slideshow image set '
  '(resources/blueprints/collections/pages/home.yaml lines 35-44), and the most '
  'easily lost value in this migration. It holds the .happyverb hero statement '
  'rendered over each home slide: We Play, We Wonder, We Explore, We Make, We '
  'Grow. Null on slide rows derived from the four umbrella pages, whose '
  'slideshow is a flat asset list (type: assets, mode: list) with no text field '
  'at all.';

comment on column public.page_sections.quote_text is
  'The quotation itself, for a quote row (add_content quote set, a textarea) and '
  'for a testimonial row. Named quote_text rather than quote because the '
  'unqualified word is the kind, not the value.';

comment on column public.page_sections.attribution is
  'Who said it. Shared by quote rows and by testimonial rows, whose source '
  'values are CES Caregiver, CES Leadership and CES Caregiver.';

comment on column public.page_sections.embed_url is
  'The movie row destination, as a URL. AUTHORIZED DEVIATION from the source: '
  'flexible_content_page.yaml declares the movie field as type: assets (line '
  '115), and this migrates as an oEmbed-allowlisted URL instead of an asset '
  'foreign key. It is justified rather than convenient -- the movie set has ZERO '
  'instances anywhere in content, and no stored asset among the 289 binaries is '
  'a video file -- so building an upload and transcoding path for an unused '
  'capability would be waste, while preserving the capability as a link costs '
  'one column. Do not convert this back to an asset foreign key. Validation '
  '(scheme https only, host against the YouTube/Vimeo allowlist) lives in '
  'nextjs/lib/schema.ts and the migration 16 write functions, NOT in a check '
  'constraint here, so the rule can be changed without a migration. Rendered '
  'through components/site/EmbedFrame.tsx.';

comment on column public.page_sections.stat_number is
  'The figure shown by an at_a_glance statistic row. TEXT, and it must stay '
  'text. home.yaml declares the source field number as type: text (line 83) and '
  'the corpus proves the declaration right: the three values are 41, 9 and '
  '"5:1", the average child-to-teacher ratio. A numeric column would fail the '
  'canonical load on that third value. Do not "improve" this to numeric or '
  'integer.';

comment on column public.page_sections.stat_caption is
  'The label beneath a statistic, such as years of nurturing young children. '
  'Named stat_caption rather than caption so a statistic row and an image row do '
  'not share one column with two unrelated meanings.';

comment on column public.page_sections.program_title is
  'Title of a program row. Nullable, and its nullability is load-bearing rather '
  'than permissive: the one nested program set in summer-programs.md (id '
  'voiW3WLF) carries all three price strings and NO program_title, which is '
  'exactly why an empty h5 renders on /programs/summer-programs today. The '
  'target renders no element for an unset field. See section 2 on why no check '
  'constraint requires this column.';

comment on column public.page_sections.program_description is
  'Description of a program row, from the programs_offered shape only. The one '
  'programs_offered set in summer-programs.md (id ml1ape2m) has a title and no '
  'description, which is why an empty p renders beneath it today.';

comment on column public.page_sections.half_day_price is
  'One of the three summer price tiers, from the NESTED program shape '
  '(programs_in_this_session). text, not a number: the real value is '
  '"8:30 - 12pm, $2400" -- a time range and a price in one string. The tier '
  'LABELS ("Half day:", "Full day:", "Extended day:") are hardcoded in '
  'programsumbrellasummer.antlers.html and are promoted into managed content by '
  'migration 11; the VALUES are this column and the two below it.';

comment on column public.page_sections.full_day_price is
  'Second summer price tier, from the nested program shape. Real value '
  '"8:30 - 4pm, $2750". text, for the same reason as half_day_price.';

comment on column public.page_sections.extended_day_price is
  'Third summer price tier, from the nested program shape. Real value '
  '"8:30 - 5pm, $3150". text, for the same reason as half_day_price.';

comment on column public.page_sections.session_title is
  'Title of a session row. The one real value is Summer 2026.';

comment on column public.page_sections.session_dates is
  'When a session runs, as PROSE and deliberately not a date, daterange or pair '
  'of dates. The one real value is "June 22nd – July 17th (We are closed Friday '
  'July 3rd)", which carries a parenthetical exception no range type can hold. '
  'Preserved verbatim and rendered as written.';

comment on column public.page_sections.question is
  'The question of a faq_item row. faq_item is a DERIVED kind: '
  'content/collections/pages/frequently-asked-questions.md holds a single '
  'add_content set of type text whose bard document contains 11 paragraphs '
  'beginning Q: and 11 matching paragraphs beginning A: as ordinary prose. '
  'Extraction splits them deterministically -- a paragraph whose first text node '
  'begins Q: opens an item and the following paragraphs up to the next Q: form '
  'its answer -- yielding exactly 11 rows. Any paragraph outside a pair, such as '
  'the leading level-2 Language Program heading, is preserved in document order '
  'as a text section so nothing is dropped.';

comment on column public.page_sections.answer is
  'The answer of a faq_item row, as PLAIN TEXT rather than a ProseMirror '
  'document in body. That choice is deliberate and must stay consistent, because '
  'a parity test asserts the concatenated text of the rebuilt FAQ page equals '
  'the source document text content: the source answers are single paragraphs of '
  'unmarked prose, so plain text is lossless for all 11 and keeps the Accordion '
  'renderer trivial. An answer that later needs marks belongs in body, and '
  'moving it is a migration plus a renderer change, not an in-place '
  'reinterpretation of this column.';

comment on column public.page_sections.data is
  'REMAINDER ONLY. This column exists for a kind genuinely variable leftover and '
  'for NOTHING ELSE. Every named source field on this table has its own typed '
  'column -- that is the entire design of this table -- so if a value has a '
  'name, putting it here is WRONG, and the correct response to a new named field '
  'is a new column in a new migration. The mistake this prohibition exists to '
  'prevent is concrete: the fidelis reference declares '
  'store_hours jsonb default ''[]''::jsonb and then fills it with '
  '{"label":...,"value":...} objects, which are two named fields hidden inside a '
  'blob where no constraint, no index, no foreign key and no generated type can '
  'reach them. Expect this column to be {} on every row loaded from the legacy '
  'corpus.';

comment on column public.page_sections.legacy is
  'Queryable retention for source keys with no target column: set_id where the '
  'source replicator set carried an id (for example OR52n05c in deposits.md), '
  'the source set type where it adds information beyond kind, and any '
  'undeclared key. Retention is in the DATABASE and not only in '
  'nextjs/data/fallback/*.json, so tools/src/verify-parity.ts can assert against '
  'the live schema and a later decision to normalize one of these keys is a '
  'migration rather than a re-extraction.';

comment on column public.page_sections.created_at is
  'When the target row was written. Operational, not migrated provenance: a '
  'section carries no source timestamp of its own, and the owning page holds the '
  'migrated source_updated_at and source_updated_by.';

comment on column public.page_sections.updated_at is
  'Maintained exclusively by the set_page_sections_updated_at trigger, so it can '
  'be neither forged nor forgotten. Load-bearing rather than informational: the '
  'optimistic concurrency check in migration 16 compares the value a field was '
  'rendered with against the row current value and rejects a stale write, which '
  'is how per-field conflict rejection works.';
