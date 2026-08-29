-- =============================================================================
-- Cambridge-Ellis School  ·  migration 04 of 18  ·  pages
-- =============================================================================
-- Creates exactly one table: public.pages. It is the widest table in the schema
-- and the primary contributor to route resolution, so an error here propagates
-- into the content_routes view (migration 15), the write functions (16) and
-- every public URL. All 34 rows and all 34 of their paths are load-bearing:
-- there is no redirect layer in the target and none is being introduced, so a
-- path that differs from the legacy URL by one byte is a broken link.
--
-- Source of truth for the column set, read rather than assumed. The key census
-- below was measured with a real YAML parse of all 34 entries, not inferred
-- from the blueprints, because the blueprints and the entries disagree:
--
--   resources/blueprints/collections/pages/*.yaml
--       Five blueprints are in use -- flexible_content_page 23, landing_page 5,
--       programsumbrella 3, programsumbrellasummer 2, home 1 = 34. A sixth
--       file, pages/events.yaml, exists and is used by ZERO entries: the events
--       landing page carries blueprint `landing_page` with `template: events`.
--       That is why the blueprint check in section 2 admits five values and not
--       six.
--   content/collections/pages.yaml
--       route '{parent_uri}/{slug}', structure `root: true` and
--       `max_depth: 2`, sort_dir asc. `root: true` is why home resolves at `/`
--       rather than `/home`. `max_depth: 2` is the depth ceiling
--       reparent_page() enforces in migration 16. The file carries no
--       date_behavior key at all.
--   content/trees/collections/pages.yaml
--       THE authority for hierarchy and therefore for `path`. 34 nodes: 9 roots
--       and 25 children (home 0, about 4, events 0, programs 5, community 5,
--       admissions 7, giving 3, donate 0, contact 1).
--
-- The measured key census across the 34 entries, which is what makes the
-- nullability below evidence rather than preference:
--
--   34  id, blueprint, title, template, updated_by, updated_at
--   23  add_content        -> page_sections (migration 05)
--   23  main_image         -> main_image_asset_id
--   14  parent             -> see the note on parent_id and legacy
--    9  include            -> show_in_nav, but NOT by copying the value
--    9  description        -> description
--    5  slideshow          -> page_sections (05)
--    4  program_image      -> program_image_asset_id
--    4  short_description  -> short_description
--    3  published          -> published (2 false, 1 explicit true)
--    2  classrooms         -> page_classrooms (migration 08)
--    2  programs_offered   -> page_sections (05)
--    1  each of: hero (undeclared -> legacy), intro, welcome_line,
--       at_a_glance (05), testimonial_1/2/3 + _image + _attribution (05, as
--       three `testimonial` sections), sessions (05), important_notes
--
-- THE SPLIT RULE, which is the single most important decision in this file: a
-- scalar or single asset reference becomes a typed column here; a repeater
-- becomes ordered rows in page_sections. Everything above marked `(05)` is a
-- repeater and is therefore absent from this table by design, not by omission.
-- The nine testimonial values are three numbered field triplets -- a repeater
-- the blueprint failed to model -- so they become three `testimonial` sections
-- rather than nine columns here.
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   page_sections     migration 05. Every repeater listed above, plus the 11
--                     faq_item rows split out of frequently-asked-questions.md.
--   page_classrooms   migration 08, not here: it carries a foreign key to
--                     `classrooms`, which does not exist until 08. It is an
--                     ORDERED relation (day-programs 7 refs, language-programs
--                     5 refs = 12 rows), which is why it is a join table with a
--                     sort_order rather than a jsonb array on this table.
--   nav_items         migration 12. Menu membership, labelling and audience are
--                     a separate model from the URL tree; see the parent_id and
--                     show_in_nav comments in section 6 for why that separation
--                     is mandatory rather than tidy.
--   content_routes    migration 15. The UNION view over pages, classrooms,
--                     people and events, with the deterministic `precedence`
--                     integer.
--   write functions   migration 16, which owns reparent_page(),
--                     assert_route_available() and the length validation this
--                     file deliberately does not express as a check.
--   policies          migration 17. RLS is ENABLED here and ZERO policies are
--                     written, so the table is closed until 17 opens it.
--   seed rows         supabase/seed.sql is the canonical load for all 34 rows.
--                     This file inserts nothing.
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
-- 1. The table
-- -----------------------------------------------------------------------------
-- Column-by-column rationale is carried in the `comment on column` statements
-- in section 6 rather than duplicated here, because those comments survive into
-- the database and remain readable once content/ has been deleted -- which it
-- is: this branch has already removed resources/** and content/**, so the
-- database and artifacts/ are the only durable record of any of it.

create table if not exists public.pages (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule; an unqualified call would fail at runtime, not at create
  -- time. Seeded rows do not rely on this default -- they derive their id from
  -- public.ces_uuid('pages', legacy_ref), which is what makes the load
  -- idempotent and lets a child row reference its parent before the parent is
  -- inserted -- so the default serves editor-created rows.
  id                      uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id, or the literal string `home`. text, not uuid; see the
  -- column comment.
  legacy_ref              text unique,

  -- Derived from the entry FILENAME, not from front matter: no page entry
  -- carries a `slug:` key. Home's slug is `home` even though its path is `/`.
  slug                    text not null unique,

  -- The URL parent and the breadcrumb parent, seeded from the tree. Nullable
  -- for the 9 roots. Emphatically not menu membership.
  parent_id               uuid references public.pages (id) on delete cascade,

  -- The materialized route. Never a generated column; see the column comment.
  path                    text not null unique,

  -- Position among siblings. Constrained in section 2, not inline, because the
  -- constraint it needs is null-safe and deferrable.
  sort_order              integer not null,

  -- Required by all five blueprints in use, every one of them with
  -- `validate: required`.
  title                   text not null,

  -- Which presenter renders this row, and which blueprint it came from. Both
  -- are constrained vocabularies; see section 2.
  template                text not null,
  blueprint               text not null,

  -- Draft is the safe default: a load error must never publish content.
  published               boolean not null default false,

  -- NOT a copy of the legacy `include:` key. See the column comment before
  -- changing this.
  show_in_nav             boolean not null default false,

  -- Scalar prose. All four nullable, with the census counts in the header
  -- above: description 9, short_description 4, intro 1, welcome_line 1. No
  -- length check on any of them -- see the note at the head of section 2.
  description             text,
  short_description       text,
  intro                   text,
  welcome_line            text,

  -- Single asset references (both blueprints declare `max_files: 1`), so both
  -- are typed foreign keys rather than arrays. No referential action, which is
  -- the contract migration 02 states for all of migrations 04-11: deleting a
  -- referenced asset is BLOCKED.
  main_image_asset_id     uuid references public.assets (id),
  program_image_asset_id  uuid references public.assets (id),

  -- A standalone bard field on programsumbrellasummer, so a single value and
  -- therefore a column -- but the value is a ProseMirror document. jsonb is the
  -- correct representation here and this is consistent with the project's jsonb
  -- rule rather than an exception to it; the column comment carries the
  -- argument, because a reader applying that rule mechanically will otherwise
  -- flag this line.
  important_notes         jsonb,

  -- Per-route SEO overrides. All net-new: no legacy route carries a meta
  -- description, a canonical link or an Open Graph tag.
  seo_title               text,
  seo_description         text,
  og_image_id             uuid references public.assets (id),

  -- The queryable retention column, and the only jsonb on this table whose
  -- contents are genuinely open-ended.
  legacy                  jsonb not null default '{}'::jsonb,

  -- Migrated provenance, held verbatim. Distinct from the operational
  -- timestamps below, and never overwritten by them.
  source_updated_at       timestamptz,
  source_updated_by       text,

  -- Operational timestamps describing target writes. `updated_at` is
  -- maintained exclusively by the trigger in section 4; no application code
  -- writes it.
  created_at              timestamptz not null default timezone('utc', now()),
  updated_at              timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Constraints
-- -----------------------------------------------------------------------------
-- Declared as explicitly-named `alter table` statements rather than inline, for
-- two reasons: the names are then stable and greppable instead of
-- server-generated, and the `drop constraint if exists` / `add constraint` pair
-- re-asserts each definition on a second apply, so this file converges even
-- against a table that already exists with a drifted constraint. Each
-- definition appears exactly once.
--
-- THERE IS DELIBERATELY NO LENGTH CHECK ON ANY COLUMN, and this is the one
-- decision in this file most likely to be "corrected" by someone reading the
-- blueprints, so the evidence is recorded here rather than left to a commit
-- message.
--
-- Two blueprints declare `character_limit: '300'`, and both declare it on
-- `short_description`, NOT on `description`:
-- resources/blueprints/collections/pages/programsumbrella.yaml declares handle
-- `short_description` at line 30 with the limit at line 32, and declares
-- `description` at line 54 with no character_limit at all;
-- programsumbrellasummer.yaml is identical. Measured against the corpus, the
-- four short_description values are 181, 379, 606 and 134 characters, so TWO
-- of them exceed 300 and a check constraint here would abort the canonical seed
-- load outright. (AAP sections 0.4.2 and 0.5.1 attribute this limit to
-- `description` and claim three violations of 675/533/301; that attribution is
-- incorrect -- description carries no limit -- and the correction is
-- authoritative. Either reading produces the same instruction for this file:
-- declare no length check.)
--
-- Corpus-wide the grandfathered set is six rows: those two umbrella
-- short_description values plus the four announcements.title values, which are
-- 56, 55, 44 and 69 characters against `character_limit: 30`. The limits are
-- real and they are enforced -- by nextjs/lib/schema.ts and the editor's
-- character counter, and by the write functions in migration 16 on every
-- create and edit -- while the seed load is exempt and each over-length row is
-- listed in artifacts/parity-report.json for the school to shorten at leisure.
--
-- For the same reason there is no format check on `path` and no range check on
-- `sort_order`: the only vocabularies constrained below are the two that are
-- genuinely closed sets of identifiers this repository owns.

-- `template` names the React presenter that renders the row. Exactly the eight
-- templates the 34 page entries actually use, measured: flexpage 22,
-- peopleindex 3, programsumbrella 3, programsumbrellasummer 2, home 1,
-- events 1, programs 1, donate 1. `bio`, `event` and `room` are deliberately
-- absent -- they are the people, events and classrooms templates and belong to
-- migrations 06, 07 and 08.
alter table public.pages drop constraint if exists pages_template_check;
alter table public.pages add constraint pages_template_check
  check (template in (
    'home',
    'flexpage',
    'programs',
    'programsumbrella',
    'programsumbrellasummer',
    'peopleindex',
    'events',
    'donate'
  ));

-- `blueprint` records which Statamic blueprint the row came from, which is what
-- lets the editor know which fields to offer. Exactly the five in use:
-- flexible_content_page 23, landing_page 5, programsumbrella 3,
-- programsumbrellasummer 2, home 1. `events` is deliberately absent: the file
-- resources/blueprints/collections/pages/events.yaml exists but no entry uses
-- it as its blueprint, so admitting the value would license a state the corpus
-- never contained.
alter table public.pages drop constraint if exists pages_blueprint_check;
alter table public.pages add constraint pages_blueprint_check
  check (blueprint in (
    'home',
    'flexible_content_page',
    'landing_page',
    'programsumbrella',
    'programsumbrellasummer'
  ));

-- Sibling ordering. Three properties of this constraint are load-bearing and
-- none of them is stylistic:
--
--   `nulls not distinct`  is MANDATORY. Under the default `nulls distinct`, two
--                         rows with a null parent_id are never considered
--                         equal, so all nine roots could share position 1 and
--                         the constraint would silently enforce nothing at
--                         exactly the level -- the top of the menu -- where
--                         order is most visible.
--   `deferrable`          because a reorder legitimately passes through
--                         colliding intermediate states. It runs as one
--                         transaction inside a write function in migration 16,
--                         which renumbers siblings and only needs the invariant
--                         to hold at commit.
--   `initially immediate` so the default behaviour is still to fail fast on a
--                         plain bad insert; the write function opts into
--                         deferral with `set constraints ... deferred` when it
--                         actually needs it.
--
-- Note that this constraint also indexes parent_id as its leading column. The
-- separate parent_id index in section 5 is therefore partly redundant, and is
-- declared anyway; see the note there.
alter table public.pages drop constraint if exists pages_parent_sort_order_key;
alter table public.pages add constraint pages_parent_sort_order_key
  unique nulls not distinct (parent_id, sort_order)
  deferrable initially immediate;


-- -----------------------------------------------------------------------------
-- 3. Row level security
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies, neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table that holds two unpublished
-- pages and their paths.
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that
-- load.
--
-- Migration 17 owns the policy set, and for this table it is specific: `anon`
-- gets `select` where published = true; `authenticated` gets `select` over
-- everything ONLY with an active admin_users membership AND aal2, and otherwise
-- sees exactly what anon sees; and direct DML is REVOKED from `authenticated`
-- entirely, so every write goes through a security definer function in
-- migration 16 that re-checks session, membership, assurance level and
-- capability. A draft is not fetched and then hidden -- it is not returned.

alter table public.pages enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, which migration 01 names
-- this migration among the callers of. `updated_at` therefore cannot be forged
-- and cannot be forgotten: no application code and no write function in
-- migration 16 may set the column.
--
-- `created_at` is deliberately left as a column default only, and
-- `source_updated_at` is deliberately untouched by this trigger -- it holds
-- migrated provenance and must survive every later edit.

drop trigger if exists set_pages_updated_at on public.pages;

create trigger set_pages_updated_at
  before update on public.pages
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes
-- -----------------------------------------------------------------------------
-- `path`, `slug` and `legacy_ref` are already indexed by their unique
-- constraints, so they are not repeated here. Each index below backs a named
-- access path rather than being added speculatively.

-- Every foreign key gets an index, which is the project rule, and this one also
-- backs the contextual child listing: ProgramsIndex and ChildPageLinks both
-- query the published children of a given page, and reparent_page() walks
-- descendants. It is partly redundant against pages_parent_sort_order_key,
-- which indexes parent_id as its leading column, and it is declared anyway --
-- the FK-index rule is stated unconditionally, the cost on a 34-row table is
-- nil, and a future change to that constraint would otherwise silently remove
-- the only index on a foreign key.
create index if not exists pages_parent_id_idx
  on public.pages (parent_id);

-- Every public read filters on published, and the RLS policy in migration 17 is
-- itself a predicate on this column.
create index if not exists pages_published_idx
  on public.pages (published);

-- The catch-all route handler dispatches on template to choose a presenter, and
-- the per-template SEO description chain in nextjs/lib/seo.ts groups by it.
create index if not exists pages_template_idx
  on public.pages (template);

-- The nav_items seed and the navigation editor both read the show_in_nav set.
create index if not exists pages_show_in_nav_idx
  on public.pages (show_in_nav);

-- The three asset foreign keys. These are not decorative: the single visibility
-- predicate in migration 16, published_reference_count(asset_id), unions a
-- lookup against every asset-referencing column in the schema, and a blocked
-- asset delete has to list the referencing rows. Both queries scan by asset id.
create index if not exists pages_main_image_asset_id_idx
  on public.pages (main_image_asset_id);

create index if not exists pages_program_image_asset_id_idx
  on public.pages (program_image_asset_id);

create index if not exists pages_og_image_id_idx
  on public.pages (og_image_id);


-- -----------------------------------------------------------------------------
-- 6. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. content/, resources/ and public/assets/ are
-- removed by the end of the migration phase -- on this branch they are already
-- gone -- so after cutover the database itself is the only place a reader can
-- learn why a column exists, where its values came from, or what a value means.

comment on table public.pages is
  'The 34 page entries from content/collections/pages, normalized. Carries the '
  'materialized URL tree: this table alone produces 34 of the site''s 142 '
  'content paths, and contributes rows to the content_routes view in migration '
  '15 with precedence 1, the highest. Scalars and single asset references are '
  'columns here; every repeater is ordered rows in page_sections (migration '
  '05) and the ordered classrooms relation is page_classrooms (migration 08).';

comment on column public.pages.id is
  'Primary key. Seeded rows derive theirs from public.ces_uuid(''pages'', '
  'legacy_ref) so the load is idempotent and a child row can reference its '
  'parent before the parent is inserted; the default serves editor-created '
  'rows.';

comment on column public.pages.legacy_ref is
  'The source entry id from the Statamic front matter -- or the literal string '
  '"home" for the home page, which is exactly why this column is text and not '
  'uuid. content/collections/pages/home.md carries `id: home` while the other '
  '33 entries carry uuids, and content/trees/collections/pages.yaml:3 names '
  'that same bare string as its first node. Scoped by table, so pages:home '
  'cannot collide with a person. Null on editor-created rows.';

comment on column public.pages.slug is
  'Derived from the entry FILENAME, never from front matter: not one of the 34 '
  'page entries carries a `slug:` key, because Statamic derives it from the '
  'file name. Home''s slug is "home" even though its path is "/". Unique per '
  'collection, which is what makes it the final tie-breaker on every ordering '
  'in this project -- sort_order alone does not guarantee a stable order '
  'between two rows with equal sort keys.';

comment on column public.pages.parent_id is
  'The URL parent AND the breadcrumb parent -- one column serving both, because '
  'they are the same relation. Seeded from content/trees/collections/pages.yaml '
  'and NOT from the entries'' own `parent:` key: the tree is what the legacy '
  'site actually resolves from, and four entries carry a parent id '
  '(261c91f6-648b-409b-8457-02a740156d6a) that no entry holds. Those four -- '
  'day-programs, enrichment-programs, language-programs and summer-programs -- '
  'render at their correct URLs today only because of that. The raw value is '
  'retained in legacy.parent and reported under "stale parent references". '
  'Null for the 9 roots. This column is emphatically NOT menu membership: that '
  'is nav_items (migration 12), and the separation is mandatory rather than '
  'tidy, because parent_id determines path -- moving Donate under Giving in the '
  'menu by editing this column would move it to /giving/donate and break a '
  'live URL. Nor is it a contextual child listing, which is a query for the '
  'published children of the current page.';

comment on column public.pages.path is
  'The materialized route, byte-identical to the legacy URL. "/" for home '
  '(content/collections/pages.yaml sets structure.root = true), "/<slug>" for a '
  'root, "/<parent slug>/<slug>" for a child, per route ''{parent_uri}/{slug}''. '
  'Materialized rather than a generated column on purpose: reparent_page() in '
  'migration 16 rewrites this page''s path AND every descendant''s in one '
  'transaction under a single change_set_id, and a generated column could not '
  'be locked, asserted against or revised. This unique constraint is one of '
  'FOUR enforcement points and cannot stand alone, because the four routed '
  'tables can each hold the same path and the content_routes UNION view has no '
  'constraint of its own. The other three: (1) a terminal per-path count check '
  'inside supabase/seed.sql''s own transaction, which aborts the load on any '
  'duplicate; (2) assert_route_available(path, exclude_kind, exclude_id) in '
  'migration 16, whose FIRST act is pg_advisory_xact_lock(hashtext(''route:'' '
  '|| path)) so two concurrent mutations targeting the same path serialize even '
  'when they touch different tables -- a bare existence check is insufficient '
  'precisely because two transactions inserting one path into two tables would '
  'both pass and both commit; and (3) the deterministic precedence integer in '
  'the migration 15 view (pages 1, classrooms 2, people 3, events 4) with the '
  'route handler selecting `order by precedence limit 1`, so behaviour stays '
  'defined even under an unexpected duplicate.';

comment on column public.pages.sort_order is
  'Position among siblings, 1-based, from the order of the tree file. '
  'Constrained by pages_parent_sort_order_key, which is null-safe and '
  'deferrable; see that constraint in section 2 for why both properties are '
  'required. Public orderings end with slug as their tie-breaker.';

comment on column public.pages.title is
  'Required by all five blueprints in use, every one with `validate: required`. '
  'No length check: see the note at the head of section 2.';

comment on column public.pages.template is
  'Which React presenter under nextjs/components/templates renders this row. '
  'One of eight, measured from the corpus rather than from the blueprint '
  'defaults. Distinct from `blueprint`, and the two genuinely diverge: the '
  'events landing page is blueprint landing_page with template events.';

comment on column public.pages.blueprint is
  'Which Statamic blueprint the row came from, retained because it tells the '
  'editor which field set to offer for this page. One of five; the sixth '
  'blueprint file in the source directory, pages/events.yaml, is used by zero '
  'entries and is not an admissible value.';

comment on column public.pages.published is
  'Publication state, authoritative and enforced server-side by the migration '
  '17 policies -- a draft is not returned to an anonymous reader, not fetched '
  'and then hidden. Default false because draft is the safe default: a load '
  'error must never publish content. Only three of the 34 entries carry the key '
  'at all -- deposits false, school-age-mandarin-for-grades-k-through-3rd '
  'false, request-information an explicit true -- so 2 rows load as drafts and '
  'the other 32 as published. Those two draft paths are part of the 40 of 142 '
  'content paths that correctly return 404 anonymously.';

comment on column public.pages.show_in_nav is
  'Whether this page is offered to the navigation model. The seed rule '
  'DELIBERATELY OVERRIDES the source and must not be "corrected" back: set it '
  'true for the nine roots and for every published child, NOT by copying the '
  'legacy `include:` key. That key exists on exactly nine entries -- about, '
  'admissions, community, contact, events, giving, programs and ways-to-give '
  'true, and donate FALSE, which is why Donate is a standing button today '
  'rather than a menu item -- so seeding from it would reproduce the legacy '
  'sidebar: nine items and 24 hidden children. The designed menu in migration '
  '12 is a two-level, two-audience tree, and it needs the children visible. '
  'The legacy values are still recoverable from the migration source manifest; '
  'this column is the target''s own decision, not a transcription.';

comment on column public.pages.description is
  'The blueprint-declared long description, on 9 of 34 entries. First candidate '
  'in the peopleindex, programs, umbrella and events branches of the '
  'per-template SEO description chain. Carries NO character_limit in any '
  'blueprint -- the limit both umbrella blueprints declare is on '
  'short_description.';

comment on column public.pages.short_description is
  'The umbrella pages'' card summary, on 4 of 34 entries. This is the column '
  'the blueprints limit to 300 characters, and two of the four migrated values '
  '(606 and 379) exceed it. They load grandfathered; migration 16 enforces the '
  'limit on every create and edit. Do not add a check constraint here.';

comment on column public.pages.intro is
  'Home page only. Real school prose, over 250 characters, and therefore the '
  'first candidate in the home branch of the SEO description chain -- and also '
  'the seed source for site_globals.site_description in migration 11, trimmed '
  'to 155 characters on a word boundary, so that no route can ever emit an '
  'empty description and the value that appears is the school''s own sentence '
  'rather than a generated one.';

comment on column public.pages.welcome_line is
  'Home page only: the short line above the intro. A declared scalar on the '
  'home blueprint, so a column rather than a section.';

comment on column public.pages.main_image_asset_id is
  'The page hero, on 23 of 34 entries -- exactly the 23 flexible_content_page '
  'rows. A typed foreign key rather than a path, and single-valued because the '
  'blueprint declares max_files: 1. NO referential action, which is migration '
  '02''s stated contract for every inbound reference in migrations 04-11: '
  'deleting a referenced asset is BLOCKED and the editor answers by listing the '
  'referencing rows. `on delete set null` would silently strip an image, and it '
  'is impossible anyway for promoted.image_asset_id, which is not null; '
  '`on delete cascade` would let removing one photograph delete the page that '
  'displays it. Replacement is an atomic swap in one transaction in migration '
  '16, with the outgoing bytes copied to the media-trash/ prefix first.';

comment on column public.pages.program_image_asset_id is
  'The programs-index card image, on the 4 umbrella pages that carry it. Same '
  'single-valued typed reference and the same blocked-delete contract as '
  'main_image_asset_id. ProgramsIndex renders the card without an image when '
  'this is null rather than rendering a broken frame.';

comment on column public.pages.important_notes is
  'The standalone bard field on programsumbrellasummer (1 entry), stored as a '
  'Tiptap `doc` node. jsonb here is the project''s jsonb rule applied, not an '
  'exception to it: the rule admits jsonb where the structure is genuinely '
  'variable, and a ProseMirror document genuinely is a variable tree of nodes '
  'and marks whose shape is not knowable from a column list. The blueprint sets '
  'save_html: false, so the source value is already a node array and never '
  'markup; nextjs/lib/richtext.ts owns the one lossless conversion in both '
  'directions -- a standalone bard field stores a BARE node array, which is '
  'imported as {type: "doc", content: [...]} and exported back to a bare array '
  '-- and nextjs/lib/richtext-validate.ts rejects anything outside the '
  'server-side node and mark allowlist rather than stripping it. This is not '
  'licence for jsonb elsewhere: every other value this table holds has a name '
  'and has a column.';

comment on column public.pages.seo_title is
  'Per-route title override, net-new. Null on every migrated row: no legacy '
  'route carries one. When null, generateMetadata composes the title from the '
  'page title and the school name.';

comment on column public.pages.seo_description is
  'Per-route meta description override, net-new. Null on every migrated row -- '
  'the legacy site has no meta description on any route, which is Lighthouse''s '
  'only SEO failure against it. When null, generateMetadata walks the '
  'deterministic per-template fallback chain, which is per-template precisely '
  'because 11 of the 34 pages carry no add_content and a single '
  '"first paragraph" rule would return nothing for them. Every candidate passes '
  'the same guard: rejected if empty, shorter than 50 characters, or entirely '
  'enclosed in square brackets -- content/collections/pages/events.md''s '
  'description is literally a staff note to themselves in brackets, and an '
  'ungated fallback would publish it to Google.';

comment on column public.pages.og_image_id is
  'Per-route Open Graph image override, net-new and null on every migrated row. '
  'THIS IS THE COLUMN''S NAME EVERYWHERE IN THIS PROJECT -- not og_image_asset_id '
  'and not seo_image_id. A second name for one column is how a generateMetadata '
  'implementation and a migration end up disagreeing, so the name is fixed here '
  'even though the two sibling asset columns on this table do carry the '
  '_asset_id suffix. Same blocked-delete contract as those two.';

comment on column public.pages.legacy is
  'Queryable retention for source keys no blueprint declares, so that nothing '
  'in the corpus is discarded and verify-parity.ts can assert exactly that. '
  'For pages it holds two things: the raw `parent` value on the four rows whose '
  'parent id is stale, and the undeclared `hero` key on home.md, which is an '
  'array of six asset filenames. Retention is IN THE DATABASE, not only in '
  'nextjs/data/fallback/*.json -- that is the point of the column. Parity is '
  'therefore verified against the live schema, and a later decision to '
  'normalize any of these keys becomes a migration rather than a '
  're-extraction, which matters because content/ no longer exists to '
  're-extract from. Never a home for a value that has a name.';

comment on column public.pages.source_updated_at is
  'The entry''s own updated_at from the source front matter, held verbatim. '
  'Present on all 34 entries as a unix timestamp and converted once at '
  'extraction. Defaulting the target''s updated_at to load time would have '
  'destroyed it, which is why provenance and operational time are separate '
  'columns. The set_pages_updated_at trigger never touches this column.';

comment on column public.pages.source_updated_by is
  'The entry''s own updated_by, mapped from the Statamic user id to the address '
  'it identifies: 1179db75-8eeb-4bad-8e60-d5005aef7ef8 -> '
  'bekah@cambridge-ellis.org (30 of the 34 pages) and '
  'b863e707-3140-4001-859f-3487e09c5881 -> conrad.fulbrook@gmail.com (4). text '
  'rather than a foreign key to auth.users on purpose: the legacy bcrypt '
  'credentials cannot be imported, both accounts are re-provisioned by '
  'invitation with new uuids, and provenance must survive even for an actor who '
  'never accepts one. Anything unrecognized is kept verbatim.';

comment on column public.pages.created_at is
  'When this row was written to the target database. An operational timestamp, '
  'not migrated provenance.';

comment on column public.pages.updated_at is
  'Maintained exclusively by the set_pages_updated_at trigger. No application '
  'code and no write function may set this column.';


-- -----------------------------------------------------------------------------
-- A note on what the canonical load must produce, for whoever writes seed.sql
-- -----------------------------------------------------------------------------
-- This table is declared to accept exactly the following, and nothing in it
-- should have to be relaxed to get that load in:
--
--   34 rows; 9 with parent_id null and 25 children; sort_order 1-based within
--   each parent (1..9 across the roots); 2 drafts; 4 rows carrying
--   legacy.parent; 1 row carrying legacy.hero, important_notes and intro.
--
--   The 34 paths, which are the legacy URLs byte for byte:
--     /
--     /about  + a-letter-from-the-director, mission-and-philosophy, careers,
--               history
--     /events
--     /programs + day-programs, language-programs,
--                 school-age-mandarin-for-grades-k-through-3rd,
--                 enrichment-programs, summer-programs
--     /community + board-of-directors, leadership-team, teaching-team,
--                  families, partnerships
--     /admissions + visit-ces, apply, timeline, tuition, deposits,
--                   financial-aid, request-information
--     /giving + ways-to-give, annual-fund, auction
--     /donate
--     /contact + frequently-asked-questions
--
-- Two of those are the draft paths that must return 404 anonymously:
-- /programs/school-age-mandarin-for-grades-k-through-3rd and
-- /admissions/deposits. Both are nonetheless reachable in the editor through
-- the collection manager, which is how a draft with no public URL stays
-- editable.
--
-- No page is reparented during the migration itself. reparent_page() exists in
-- migration 16 for the school's later use and is capability-gated to admin;
-- every information-architecture improvement this project makes is expressed in
-- nav_items instead, which is precisely why that table exists.
-- =============================================================================
