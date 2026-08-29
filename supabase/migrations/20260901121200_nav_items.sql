-- =============================================================================
-- Cambridge-Ellis School  ·  migration 12 of 18  ·  navigation items
-- =============================================================================
-- Creates exactly one table: public.nav_items, the route-independent navigation
-- model. It inserts ZERO rows; the reason is in "The seed lives in seed.sql"
-- below, and the complete tree it must be loaded with is specified in section 7
-- of this file so the specification sits beside the schema that holds it.
--
-- WHY THIS TABLE EXISTS AT ALL, which is the whole argument and not a
-- preamble. public.pages.parent_id determines public.pages.path: a child
-- resolves at '{parent_uri}/{slug}'. So parent_id cannot ALSO express
-- navigation grouping. Moving Donate under Giving in the menu by editing
-- pages.parent_id would move the page to /giving/donate and break a live URL
-- that is printed in school materials and indexed.
--
-- Requirement 10 asks for the information architecture, routing and navigation
-- to be optimized, and in the same sentence constrains that work by content and
-- functional parity; requirement 12 makes no-loss absolute. Read naively the two
-- halves cancel out. This table is the resolution, and it is exact:
--
--     nav_items carries PRESENTATION and is free.
--     pages.path carries the URL and is FROZEN at its migrated value.
--
-- Every information-architecture improvement in the plan is expressible here
-- without moving a single URL -- the two audience groups, Admissions promoted
-- from sixth of nine to first, Visit CES and Apply raised to header calls to
-- action, and Donate relocated to a child of Giving while /donate stays
-- /donate. That is not a coincidence; it is why the table exists. NO PAGE IS
-- REPARENTED BY THIS MIGRATION OR BY THE SEED, and the parity gate asserts all
-- 142 content paths unchanged (nextjs/tests/e2e/public-routes.spec.ts), which is
-- the assertion that pairs with the nav assertions in
-- nextjs/tests/e2e/admin-navigation.spec.ts to prove presentation moved and URLs
-- did not.
--
-- FOUR CONCEPTS STAY DISTINCT. Conflating any two of them in a later change is
-- the single most likely way to break a URL in this schema:
--
--   1. URL parent            public.pages.parent_id (migration 04). Produces
--                            path.
--   2. Breadcrumb parent     ALSO public.pages.parent_id, rendered by
--                            nextjs/components/site/Breadcrumbs.tsx. Same
--                            relation, so one column serves both.
--   3. Menu membership,      THIS TABLE, rendered by
--      label, audience and   nextjs/components/site/NavTree.tsx and edited by
--      order                 nextjs/components/cms/NavTreeEditor.tsx.
--   4. Contextual child      Neither: a live query for the published children of
--      listings              the current page, used by ProgramsIndex and
--                            ChildPageLinks.
--
-- SOURCE OF TRUTH, read rather than assumed:
--
--   content/trees/collections/    The hierarchy this menu is derived FROM but is
--     pages.yaml                  deliberately not equal to. 76 lines, 34 nodes:
--                                 9 roots and 25 children (home 0, about 4,
--                                 events 0, programs 5, community 5,
--                                 admissions 7, giving 3, donate 0, contact 1).
--                                 Its first node is the literal string `home`
--                                 (line 3) while its own siblings are uuids.
--   resources/views/layout        The legacy sidebar this replaces. Line 33 is
--     .antlers.html               the logo link to `/`; lines 34-42 are a
--                                 `{{ nav include_home="false" }}` loop wrapped
--                                 in `{{if include}}`, which renders ONE
--                                 undifferentiated flat list of nine items with
--                                 Admissions sixth; line 54 is
--                                 `<a href="/donate"><button>Donate Now</button>`
--                                 -- the only standing call to action on the
--                                 entire site. `include_home="false"` is why
--                                 home is not a menu row here either: the logo
--                                 is the route to `/`.
--   content/collections/pages/    Line 8 is `include: false`. That single key is
--     donate.md                   why Donate is a standing button today rather
--                                 than a menu item, and it is the reason the
--                                 `include` key must NOT be transcribed; see
--                                 the next note.
--
-- THE show_in_nav SEED RULE DELIBERATELY OVERRIDES THE SOURCE, and migration 04
-- carries the same note on the column itself so neither file can be "corrected"
-- in isolation. The undeclared `include:` key exists on exactly nine entries --
-- about, admissions, community, contact, events, giving, programs and
-- ways-to-give true, and donate FALSE. Seeding pages.show_in_nav by copying it
-- would reproduce the legacy sidebar exactly: nine items and 24 hidden children.
-- The rule is instead: pages.show_in_nav is true for the nine roots AND for
-- every published child; nav_items then holds the designed two-level,
-- two-audience menu in section 7. The legacy values remain recoverable from
-- artifacts/migration-source-manifest.json.
--
-- Why the designed order is what it is, since a menu order with no stated reason
-- invites arbitrary revision. Independent-school guidance offers a blunt test:
-- if a parent cannot find the admissions page in about ten seconds, the
-- navigation is wrong. Admissions is therefore the FIRST item under the FIRST
-- group, against a legacy sidebar that places it sixth of nine while asking for
-- a donation from every viewport. Donation moves inside Giving, where a
-- prospective parent is not asked for money before they have seen a classroom.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO, because another migration owns it:
--
--   policies          migration 17. RLS is ENABLED here with ZERO policies, so
--                     the table is closed until 17 opens it. For this table the
--                     anon policy is `select where visible` -- gated on the
--                     column created here, and specifically UNLIKE
--                     taxonomy_terms, which gets a plain select because its
--                     source declares no visibility field at all. Two tables,
--                     two policies, each justified by its own evidence.
--   functions         migration 16, which owns update-nav-tree (menu edits and
--                     the transactional renumbering this table's deferrable
--                     constraint exists for), reparent_page() for the URL tree,
--                     and the capability checks that make both admin-only.
--   url validation    migration 16 plus nextjs/lib/schema.ts. There is NO format
--                     check on external_url here; the rule enforced on write is
--                     that the scheme must be https:, mailto: or tel:, or a
--                     root-relative path, with javascript:, data: and
--                     protocol-relative forms rejected.
--   delete refusal    migration 16. `on delete cascade` on target_page_id below
--                     is the DATABASE FLOOR, not the product behaviour: deleting
--                     a page BLOCKS while any nav_items row references it (as it
--                     does for announcements and page_classrooms), the editor
--                     lists the blockers, and forcing it is a separate admin
--                     action that removes the references in the same transaction
--                     under one change_set_id.
--   rows              supabase/seed.sql. See immediately below.
--
-- THE SEED LIVES IN seed.sql, AND THAT IS A DECISION WITH A REASON. This
-- migration runs BEFORE supabase/seed.sql: supabase/config.toml sets
-- [db.seed] sql_paths = ["./seed.sql"], which `supabase db reset` executes after
-- ALL eighteen migrations. Migration 04 inserts no page rows either -- seed.sql
-- is the canonical load for all 34 -- so at the moment this file runs, public
-- .pages is EMPTY. Three consequences follow and each rules out seeding here:
--
--   * `(select id from public.pages where path = '/admissions')` would return
--     null, so every row would load with a null target_page_id and be
--     indistinguishable from a label-only group header. NavTree would render
--     "Admissions" as inert text and admin-navigation.spec.ts would fail.
--   * Deriving the target instead as public.ces_uuid('pages', '<entry id>')
--     computes the right uuid but still violates the foreign key at this
--     migration's commit, because the referenced row does not exist yet -- and
--     it would mean hard-coding page identity, which is precisely what
--     resolving by path exists to avoid.
--   * Seeding only the three label-only roots here is worse than seeding
--     nothing. nav_items carries `unique nulls not distinct (parent_id,
--     sort_order)`, so if seed.sql inserts the full tree under a different
--     legacy_ref convention than the one in section 7, its own roots collide
--     with these at (null, 1..3) and THE ENTIRE SEED LOAD ABORTS. Inserting no
--     rows makes seed.sql correct under any convention it chooses.
--
-- So: this file owns the table and the SPECIFICATION of its contents (section
-- 7); seed.sql owns the INSERT. Migration 11's header describes this file as one
-- of the two carrying a seed, which remains true of what is being seeded --
-- structure rather than content, a menu shape rather than collection rows -- but
-- the statement executes there, not here, for the ordering reason above.
--
-- Every statement below is idempotent -- `create table if not exists`, `create
-- index if not exists`, `drop constraint if exists` before `add constraint`, and
-- `drop trigger if exists` before `create trigger` -- so applying all eighteen
-- migrations twice is clean and leaves `select count(*) from public.nav_items`
-- unchanged. Conventions (lowercase SQL, `text` never varchar(n), the explicit
-- timezone('utc', now()) timestamp form, and jsonb only where the structure is
-- genuinely variable -- which here is nowhere, because every value has a name)
-- are stated once in migration 01 and followed here.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
-- Column-by-column rationale is carried in the `comment on column` statements in
-- section 6 rather than duplicated here, because those comments survive into the
-- database and stay readable once content/ has been deleted -- which it already
-- has on this branch. The notes inline below are only the ones a reader needs
-- before reaching section 6.

create table if not exists public.nav_items (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule. Seeded rows do not rely on this default: they derive their id
  -- from public.ces_uuid('nav_items', legacy_ref), which is what lets a child
  -- row reference its parent before the parent is inserted and makes a re-run
  -- byte-identical. The default serves rows an editor creates later.
  id              uuid primary key default extensions.gen_random_uuid(),

  -- The stable handle. Unlike every other table's legacy_ref this one names no
  -- source record -- there is no legacy nav model to migrate -- so it is a
  -- designed identity. One value is contractual: 'nav:header-actions'.
  legacy_ref      text unique,

  -- MENU nesting, and nothing else. Never the URL parent.
  parent_id       uuid references public.nav_items (id) on delete cascade,

  -- What the visitor reads. Free of the target page's title by design.
  label           text not null,

  -- The internal destination. Nullable, because label-only group headers exist.
  -- `on delete cascade` is the floor; migration 16 refuses the delete instead.
  target_page_id  uuid references public.pages (id) on delete cascade,

  -- The external destination, for an item with no page behind it. No format
  -- check here; see the header note on url validation.
  external_url    text,

  -- Which journey this item addresses. Constrained in section 2.
  audience        text not null,

  -- Position among menu siblings. Constrained in section 2, not inline, because
  -- the constraint it needs is null-safe and deferrable.
  sort_order      integer not null,

  -- Default false, matching the schema-wide rule for visibility booleans. A row
  -- added later is hidden until somebody says otherwise.
  visible         boolean not null default false,

  -- Operational timestamps. `updated_at` is maintained exclusively by the
  -- trigger in section 4; no application code and no write function writes it.
  created_at      timestamptz not null default timezone('utc', now()),
  updated_at      timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Constraints
-- -----------------------------------------------------------------------------
-- Declared as explicitly-named `alter table` statements rather than inline, for
-- the two reasons migration 04 states: the names are stable and greppable
-- instead of server-generated, and the `drop constraint if exists` /
-- `add constraint` pair re-asserts each definition on a second apply, so this
-- file converges even against a table that already exists with a drifted
-- constraint. Each definition appears exactly once.
--
-- THERE IS DELIBERATELY NO LENGTH CHECK ON `label`, NO FORMAT CHECK ON
-- `external_url` AND NO RANGE CHECK ON `sort_order`. This matches migration 04,
-- which declines the same three classes of check for the same reason: a value
-- constraint that the corpus or a legitimate intermediate state can violate
-- turns a data problem into a failed load. Menu labels are the school's own
-- words with no declared limit anywhere in the source; external_url is
-- validated on write by nextjs/lib/schema.ts and migration 16, where a rejected
-- scheme can be reported to the editor instead of aborting a transaction; and
-- sort_order legitimately passes through arbitrary values mid-renumber.
--
-- The four constraints below are all structural: each one describes a shape the
-- table can be in, not a value it can hold.

-- Which journey an item addresses, so the menu can be filtered per audience
-- rather than shown whole to everyone. Three values and no more.
--
-- `enrolled` is admitted even though the legacy site barely has an
-- enrolled-family journey, and that is a stated capability rather than a claim
-- that the journey exists: the only enrolled-family destination in the entire
-- source is a Blackbaud portal URL sitting inside a DISABLED block in
-- content/collections/pages/deposits.md. The value exists so the menu can
-- address those families the moment the school has somewhere to send them --
-- see the family-portal note in section 7 -- and so nothing has to be migrated
-- to add one later. Nothing in the seed uses it.
alter table public.nav_items drop constraint if exists nav_items_audience_check;
alter table public.nav_items add constraint nav_items_audience_check
  check (audience in ('prospective', 'enrolled', 'both'));

-- An item has AT MOST one destination. A row carrying both an internal page and
-- an external URL is ambiguous -- NavTree would have to pick one, and whichever
-- it picked would make the other value a silent lie.
--
-- It deliberately does NOT require at least one. That asymmetry is the point:
-- the three group headers in section 7 (Considering CES, Our Community, Header
-- Actions) legitimately have neither, because a heading that grouped items and
-- also navigated somewhere would be a worse affordance than one that does not.
-- Requiring a destination would make the designed menu unloadable.
alter table public.nav_items drop constraint if exists nav_items_target_exclusive_check;
alter table public.nav_items add constraint nav_items_target_exclusive_check
  check (target_page_id is null or external_url is null);

-- Sibling ordering. Three properties are load-bearing and none is stylistic:
--
--   `nulls not distinct`  is MANDATORY. Under the default `nulls distinct` two
--                         rows with a null parent_id are never considered equal,
--                         so all three roots could share position 1 and the
--                         constraint would enforce nothing at exactly the level
--                         -- the top of the menu -- where order is most visible
--                         and where this table's whole purpose (Admissions
--                         first) is expressed.
--   `deferrable`          because a reorder legitimately passes through
--                         colliding intermediate states. update-nav-tree in
--                         migration 16 renumbers siblings inside one
--                         transaction and only needs the invariant to hold at
--                         commit.
--   `initially immediate` so the default behaviour is still to fail fast on a
--                         plain bad insert; the write function opts into
--                         deferral with `set constraints ... deferred` when it
--                         actually needs it.
--
-- Note that this constraint also indexes parent_id as its leading column, which
-- is why the composite index in section 5 is declared partial rather than as a
-- byte-identical duplicate of this one.
alter table public.nav_items drop constraint if exists nav_items_parent_sort_order_key;
alter table public.nav_items add constraint nav_items_parent_sort_order_key
  unique nulls not distinct (parent_id, sort_order)
  deferrable initially immediate;

-- A row may not be its own parent. This is the floor a self-referencing tree can
-- defend in a check constraint and no more: a longer cycle spans rows and cannot
-- be expressed here, so update-nav-tree in migration 16 owns full cycle
-- prevention for the menu exactly as reparent_page() owns it for the URL tree.
-- The floor is still worth holding, because a self-parent row is not merely
-- invalid data -- it is a row that makes a recursive descent over the menu
-- non-terminating, and a renderer is the wrong place to discover that.
alter table public.nav_items drop constraint if exists nav_items_parent_id_not_self_check;
alter table public.nav_items add constraint nav_items_parent_id_not_self_check
  check (parent_id is null or parent_id <> id);


-- -----------------------------------------------------------------------------
-- 3. Row level security
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table that carries three hidden rows
-- and the shape of the site's navigation.
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that load.
--
-- Migration 17 owns the policy set, and for this table it is: `anon` gets
-- `select` where visible = true; `authenticated` gets `select` over everything
-- ONLY with an active admin_users membership and aal2, so the navigation editor
-- can see and reorder hidden items; write is admin-only and, like every other
-- content table, direct DML is REVOKED from `authenticated` so every menu edit
-- goes through update-nav-tree in migration 16.
--
-- One consequence of the `visible` predicate is worth stating here rather than
-- leaving for a renderer to discover; see the Header Actions note in section 7
-- for the resolutions.

alter table public.nav_items enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, which names this migration
-- among its callers. `updated_at` therefore cannot be forged and cannot be
-- forgotten: no application code and no write function in migration 16 may set
-- the column. `created_at` is deliberately left as a column default only.
--
-- This table has no source_updated_at counterpart, unlike every content table:
-- there is no legacy navigation record to carry provenance from. The menu is
-- designed here, and its history begins at the seed load.

drop trigger if exists set_nav_items_updated_at on public.nav_items;

create trigger set_nav_items_updated_at
  before update on public.nav_items
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes
-- -----------------------------------------------------------------------------
-- `legacy_ref` is already indexed by its unique constraint
-- (nav_items_legacy_ref_key), and (parent_id, sort_order) by
-- nav_items_parent_sort_order_key, so neither is repeated as a plain index.
-- Each index below backs a named access path.

-- The foreign key to this table itself. Every foreign key gets an index, which
-- is the project rule, and this one also backs the recursive descent NavTree and
-- NavTreeEditor both perform. It is partly redundant against
-- nav_items_parent_sort_order_key, which indexes parent_id as its leading
-- column, and it is declared anyway: the rule is stated unconditionally, the
-- cost on a 38-row table is nil, and a future change to that constraint would
-- otherwise silently remove the only index on a foreign key.
create index if not exists nav_items_parent_id_idx
  on public.nav_items (parent_id);

-- The foreign key to pages. Not decorative: migration 16 refuses to delete a
-- page while any nav_items row references it and has to LIST the blockers, and
-- the navigation editor resolves an item's current destination the same way.
-- Both queries scan by page id.
create index if not exists nav_items_target_page_id_idx
  on public.nav_items (target_page_id);

-- The anon RLS predicate in migration 17 is exactly this column, and the
-- navigation editor's "show hidden" filter is its negation.
create index if not exists nav_items_visible_idx
  on public.nav_items (visible);

-- The per-audience menu read: NavTree renders the prospective path and the
-- enrolled path from the same table.
create index if not exists nav_items_audience_idx
  on public.nav_items (audience);

-- The ordered public read -- `where parent_id = $1 and visible order by
-- sort_order` -- as a PARTIAL index, and the partiality is the reason it earns
-- its place. A non-partial index on (parent_id, sort_order) would be
-- byte-identical to the index nav_items_parent_sort_order_key already creates,
-- so declaring one would be pure duplication: two indexes to maintain on every
-- write, one of them flagged by any duplicate-index lint, and no query served
-- that was not already served. Adding `where visible` makes it a different and
-- narrower index that matches the anonymous read exactly, including the
-- migration 17 predicate. The authenticated editor's read of ALL rows in menu
-- order remains served by the unique constraint's own index.
create index if not exists nav_items_parent_id_sort_order_idx
  on public.nav_items (parent_id, sort_order)
  where visible;


-- -----------------------------------------------------------------------------
-- 6. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. content/, resources/ and public/assets/ are
-- removed by the end of the migration phase -- on this branch they are already
-- gone -- so after cutover the database itself is the only place a reader can
-- learn why a column exists or what a value means.

comment on table public.nav_items is
  'Site navigation: menu membership, label, audience, nesting and order. A '
  'route-INDEPENDENT model, and the independence is the entire point. '
  'pages.parent_id determines pages.path, so it cannot also express menu '
  'grouping: moving Donate under Giving by editing that column would move the '
  'page to /giving/donate and break a live URL. Four concepts stay distinct -- '
  'the URL parent (pages.parent_id), the breadcrumb parent (also '
  'pages.parent_id, rendered by Breadcrumbs), menu membership and order (this '
  'table, rendered by NavTree), and contextual child listings (a live query for '
  'the published children of the current page, used by ProgramsIndex and '
  'ChildPageLinks). Seeded by supabase/seed.sql with the designed tree '
  'specified in section 7 of this migration: 38 rows, 3 label-only roots and 35 '
  'items, of which 33 point at the 33 non-home page entries exactly once each '
  'and 2 are the header calls to action. No legacy navigation record exists to '
  'migrate -- the source is a single flat nine-item sidebar loop in '
  'resources/views/layout.antlers.html:34-42 -- so this menu is designed, not '
  'transcribed.';

comment on column public.nav_items.id is
  'Primary key. Seeded rows derive theirs from public.ces_uuid(''nav_items'', '
  'legacy_ref), so a re-run is byte-identical and a child row can reference its '
  'parent before the parent is inserted; the default serves editor-created '
  'rows.';

comment on column public.nav_items.legacy_ref is
  'The stable handle. Unique, and unlike every other table''s legacy_ref it '
  'names no source record: there is no legacy navigation model, so these are '
  'designed identities rather than migrated ones. ONE VALUE IS CONTRACTUAL -- '
  '''nav:header-actions'' -- because SiteHeader resolves the two header calls to '
  'action by that handle rather than by a magic label or an extra column, which '
  'is what lets the label be edited without breaking the header. The convention '
  'for the other 37 rows is in section 7 of this migration; it exists so the '
  'seed load is idempotent on conflict (legacy_ref) and so a menu row can be '
  'found again after its label changes.';

comment on column public.nav_items.parent_id is
  'MENU nesting, and nothing else. Entirely independent of pages.parent_id: '
  'this column expresses where an item sits in the menu, that one determines a '
  'page''s URL. The designed tree exploits the difference deliberately -- '
  'Frequently Asked Questions has URL parent `contact` and menu parent '
  '`Considering CES`, and Donate sits under Giving in the menu while its page '
  'stays at /donate. Null for the three roots. `on delete cascade` removes a '
  'group''s items with the group. A row may not be its own parent '
  '(nav_items_parent_id_not_self_check); longer cycles span rows and are '
  'refused by update-nav-tree in migration 16, which owns menu mutation exactly '
  'as reparent_page() owns the URL tree.';

comment on column public.nav_items.label is
  'What the visitor reads. Deliberately free of the target page''s title, '
  'because that freedom is half of what this table buys: the menu can say '
  '"Schedule a Visit" while the page is titled "Visit CES", and can group items '
  'under a heading that is not a page at all. 33 of the 35 seeded items do '
  'happen to carry their target page''s exact title; the documented exceptions '
  'are in section 7. No length check -- the source declares none anywhere.';

comment on column public.nav_items.target_page_id is
  'The internal destination, resolved from public.pages BY PATH at seed time and '
  'never hard-coded, because page ids are derived from public.ces_uuid(''pages'', '
  'legacy_ref) and a hard-coded uuid would break silently if a legacy_ref '
  'changed. Nullable, because the three label-only group headers have no '
  'destination. Mutually exclusive with external_url '
  '(nav_items_target_exclusive_check), which does NOT require at least one of '
  'the two. `on delete cascade` is the DATABASE FLOOR, not the product '
  'behaviour: migration 16 BLOCKS deletion of a page while any nav_items row '
  'references it -- alongside announcements and page_classrooms -- lists the '
  'blockers to the editor, and forces it only as a separate admin action that '
  'removes the references in the same transaction under one change_set_id. The '
  'cascade exists so that a forced delete cannot leave a menu row pointing at '
  'nothing.';

comment on column public.nav_items.external_url is
  'A destination with no page behind it. Null on all 38 seeded rows -- every '
  'designed item is either a page or a group header -- and present for the '
  'capability: a family portal, an application system or a calendar lives '
  'outside this database and the menu has to be able to reach it without '
  'inventing a page. NO FORMAT CHECK HERE BY DESIGN. Validation belongs on the '
  'write path, in nextjs/lib/schema.ts and update-nav-tree (migration 16): the '
  'scheme must be https:, mailto: or tel:, or a root-relative path, and '
  'javascript:, data: and protocol-relative forms are rejected. A check '
  'constraint would report the same rejection as a failed transaction instead of '
  'a message an editor can act on, and could not be relaxed for a legacy value '
  'the way site_globals.donate_url''s root-relative form has to be.';

comment on column public.nav_items.audience is
  'Which journey the item addresses: prospective, enrolled or both. This is the '
  'column that lets one table serve two audiences without duplicating the menu, '
  'and it is why an audience-labelled group with no page behind it is '
  'expressible at all. `enrolled` is admitted as a CAPABILITY, not a claim that '
  'the journey exists: the only enrolled-family destination anywhere in the '
  'source is a Blackbaud portal URL inside a DISABLED block in '
  'content/collections/pages/deposits.md, recovered into '
  'site_globals.family_portal_url (migration 11) and marked unconfirmed. No '
  'seeded row uses the value; the enrolled path is served today by Events, '
  'Families, Contact and the FAQ, all of which already exist.';

comment on column public.nav_items.sort_order is
  'Position among menu siblings, 1-based. Constrained by '
  'nav_items_parent_sort_order_key, which is null-safe (`nulls not distinct`, '
  'mandatory: without it all three roots could share position 1) and deferrable '
  '(a renumber inside update-nav-tree passes through colliding intermediate '
  'states and only needs the invariant at commit). No range check: mid-renumber '
  'values are legitimate.';

comment on column public.nav_items.visible is
  'Whether the item renders in the public menu. Default FALSE, matching the '
  'schema-wide rule for visibility booleans -- published, show_in_nav and '
  'feature_on_homepage all default false, and only page_sections.enabled and '
  'person_education.enabled default true -- so a row added later is hidden until '
  'somebody says otherwise. Read directly by the migration 17 anon policy, which '
  'is why this table gets a visibility-gated policy where taxonomy_terms gets a '
  'plain select: that source declares no such field, this menu genuinely has '
  'hidden rows. Three of the 38 seeded rows are false: Deposits and School Age '
  'Mandarin, whose pages are drafts and which therefore appear automatically '
  'when the school publishes them, and the Header Actions group, which is a '
  'container for the header calls to action and must never render as a menu '
  'entry.';

comment on column public.nav_items.created_at is
  'When the row entered this database. For seeded rows that is the seed load, '
  'not a migrated date: no legacy navigation record exists to carry provenance '
  'from, which is why this table has no source_updated_at counterpart.';

comment on column public.nav_items.updated_at is
  'Maintained exclusively by set_nav_items_updated_at, which calls the shared '
  'public.set_updated_at() from migration 01. No application code and no write '
  'function sets this column, so it can be neither forged nor forgotten.';


-- -----------------------------------------------------------------------------
-- 7. The designed menu -- the specification supabase/seed.sql loads
-- -----------------------------------------------------------------------------
-- This section inserts nothing. It is the authoritative specification of the 38
-- rows supabase/seed.sql must load, recorded here because the schema and the
-- shape it holds belong next to each other, and because after cutover this file
-- is the only place the shape is written down. It is the same tree
-- nextjs/tests/e2e/admin-navigation.spec.ts asserts row for row, so a
-- disagreement between that spec, seed.sql and this section is a defect in
-- whichever of the three moved last.
--
-- Coverage: every one of the 34 page entries appears exactly once EXCEPT home,
-- which is reached by the logo -- the legacy sidebar excludes it the same way,
-- with `include_home="false"` at resources/views/layout.antlers.html:34. So 33
-- page-targeting items, plus 2 header calls to action that re-target two of
-- those pages, plus 3 label-only group headers = 38 rows.
--
-- 7a. THE legacy_ref CONVENTION, which makes the load idempotent and lets a row
-- be found again after its label is edited. One uniform rule:
--
--     a root      'nav:' || kebab-cased label
--     a child     <parent legacy_ref> || '/' || segment
--     segment     the target page's slug, or the kebab-cased label where the
--                 row has no target page
--
-- Worked: 'nav:considering-ces', 'nav:considering-ces/admissions',
-- 'nav:considering-ces/admissions/visit-ces',
-- 'nav:considering-ces/frequently-asked-questions' (the FAQ page's slug, under
-- its MENU parent, not its URL parent), 'nav:our-community/giving/donate',
-- 'nav:header-actions/visit-ces'. The same page slug appearing under two menu
-- parents therefore yields two distinct handles, which is exactly why the
-- parent prefix is part of the rule: Visit CES appears both under Admissions and
-- as a header call to action.
--
-- Only 'nav:header-actions' is CONTRACTUAL -- SiteHeader resolves the calls to
-- action by that literal string. The other 37 are a convention: seed.sql may
-- choose another scheme provided it is deterministic, but it must then keep
-- admin-navigation.spec.ts and any code that looks a row up by handle in step.
--
-- 7b. THE TREE. Two lines per row: order, label, audience and visibility, then
-- the target path. `--` for a target means the row is a label-only group header
-- and carries neither target_page_id nor external_url. No row carries an
-- external_url. Order numbers are the dotted position; sort_order is the last
-- component (so 1.2.5 is sort_order 5 under the Programs item).
--
--  ord     label                                            audience    visible
--  ------  -----------------------------------------------  ----------  -------
--  1       "Considering CES"                                prospective Y
--          -> --  (group header)
--  1.1     "Admissions"                                     prospective Y
--          -> /admissions
--  1.1.1   "Visit CES"                                      prospective Y
--          -> /admissions/visit-ces
--  1.1.2   "Apply"                                          prospective Y
--          -> /admissions/apply
--  1.1.3   "Timeline"                                       prospective Y
--          -> /admissions/timeline
--  1.1.4   "Tuition"                                        prospective Y
--          -> /admissions/tuition
--  1.1.5   "Financial Aid"                                  prospective Y
--          -> /admissions/financial-aid
--  1.1.6   "Request Information"                            prospective Y
--          -> /admissions/request-information
--  1.1.7   "Deposits"                                       prospective N
--          -> /admissions/deposits                          (page is a draft)
--  1.2     "Programs"                                       both        Y
--          -> /programs
--  1.2.1   "Day Programs"                                   both        Y
--          -> /programs/day-programs
--  1.2.2   "Afternoon Language Program"                     both        Y
--          -> /programs/language-programs
--  1.2.3   "Enrichment Programs"                            both        Y
--          -> /programs/enrichment-programs
--  1.2.4   "Summer Programs"                                both        Y
--          -> /programs/summer-programs
--  1.2.5   "School Age Mandarin - Grades K through 3"       both        N
--          -> /programs/school-age-mandarin-for-grades-k-through-3rd
--                                                           (page is a draft)
--  1.3     "Frequently Asked Questions"                     prospective Y
--          -> /contact/frequently-asked-questions
--  2       "Our Community"                                  both        Y
--          -> --  (group header)
--  2.1     "About"                                          both        Y
--          -> /about
--  2.1.1   "A Letter from the Director"                     both        Y
--          -> /about/a-letter-from-the-director
--  2.1.2   "Mission and Philosophy"                         both        Y
--          -> /about/mission-and-philosophy
--  2.1.3   "History"                                        both        Y
--          -> /about/history
--  2.1.4   "Careers"                                        both        Y
--          -> /about/careers
--  2.2     "Community"                                      both        Y
--          -> /community
--  2.2.1   "Leadership Team"                                both        Y
--          -> /community/leadership-team
--  2.2.2   "Teaching Team"                                  both        Y
--          -> /community/teaching-team
--  2.2.3   "Board of Directors"                             both        Y
--          -> /community/board-of-directors
--  2.2.4   "Families"                                       both        Y
--          -> /community/families
--  2.2.5   "Partnerships"                                   both        Y
--          -> /community/partnerships
--  2.3     "Events"                                         both        Y
--          -> /events
--  2.4     "Giving"                                         both        Y
--          -> /giving
--  2.4.1   "Ways to Give"                                   both        Y
--          -> /giving/ways-to-give
--  2.4.2   "Annual Fund"                                    both        Y
--          -> /giving/annual-fund
--  2.4.3   "Auction"                                        both        Y
--          -> /giving/auction
--  2.4.4   "Donate"                                         both        Y
--          -> /donate                                       (URL UNCHANGED)
--  2.5     "Contact"                                        both        Y
--          -> /contact
--  3       "Header Actions"                                 prospective N
--          -> --  (group header; legacy_ref 'nav:header-actions')
--  3.1     "Schedule a Visit"                               prospective Y
--          -> /admissions/visit-ces
--  3.2     "Apply"                                          prospective Y
--          -> /admissions/apply
--
-- Row 2.4.4 is the clearest demonstration of why this table exists at all.
-- Donate becomes a child of Giving in the MENU while its page keeps the path
-- /donate. Achieving the same grouping through pages.parent_id would have
-- rewritten the URL to /giving/donate.
--
-- Row 1.3 is the second demonstration: Frequently Asked Questions keeps the URL
-- parent it has -- its path is /contact/frequently-asked-questions and its
-- breadcrumb still reads Contact -- while its MENU parent is Considering CES,
-- where a prospective parent will look for it.
--
-- 7c. LABELS. 33 of the 35 item rows carry their target page's `title`
-- verbatim. Two do not, and the three group headers have no page title behind
-- them at all. Each divergence is deliberate, so none of the three cases below
-- should be "corrected" to a page title:
--
--   "Schedule a Visit"      row 3.1, targeting the page titled "Visit CES".
--                           The header call to action states the action; the
--                           page states the subject. Row 1.1.1 keeps the title.
--   "Request Information"    row 1.1.6. The page's own title is "Request
--                           information" with a lower-case i. Title case is
--                           correct for a menu entry, and the page title is not
--                           being edited to match -- prose is content and the
--                           migration changes exactly one word of it, elsewhere.
--   the three group headers  "Considering CES", "Our Community" and "Header
--                           Actions" have no page behind them at all. That is
--                           the capability an audience-grouped menu needs and a
--                           page tree cannot provide.
--
-- One character matters and is easy to lose: row 1.2.5's label uses an ASCII
-- HYPHEN-MINUS, as the page's own title does --
-- `School Age Mandarin - Grades K through 3`. The plan document renders that
-- dash typographically as an en dash; that is a rendering artifact of the
-- document, not a content value, and the ASCII form is what the source holds.
--
-- 7d. INVARIANTS seed.sql must satisfy, and which are cheap to assert in its own
-- terminal transaction rather than discovering later from a rendered menu:
--
--   * exactly 38 rows.
--   * exactly 3 rows with parent_id is null, with sort_order 1, 2 and 3 and
--     legacy_ref 'nav:considering-ces', 'nav:our-community' and
--     'nav:header-actions' in that order.
--   * exactly 3 rows with target_page_id is null -- those same three.
--     Equivalently: `select count(*) from public.nav_items where
--     target_page_id is null and external_url is null` = 3, and every other row
--     has a NON-NULL target. A null target on an item row means a path lookup
--     silently missed and the load must fail rather than ship an inert menu
--     entry; see the resolution idiom in 7e.
--   * 0 rows with external_url is not null.
--   * exactly 3 rows with visible = false: the Deposits item, the School Age
--     Mandarin item and the Header Actions group.
--   * exactly 1 row with legacy_ref = 'nav:header-actions', and its 2 children.
--   * 33 DISTINCT target_page_id values across the 35 item rows: /admissions
--     /visit-ces and /admissions/apply are each targeted twice, once in the menu
--     and once as a header call to action. Not a duplicate -- there is no unique
--     constraint on target_page_id, deliberately, because one page legitimately
--     appears in more than one place in a menu.
--   * `select count(*) from public.pages p where not exists (select 1 from
--     public.nav_items n where n.target_page_id = p.id)` = 1, and that one row
--     is home.
--
-- 7e. THE RESOLUTION IDIOM. Resolve every target from public.pages BY PATH, and
-- make a miss LOUD. A bare `(select id from public.pages where path = '...')`
-- yields null on a miss and would load a broken menu quietly, so seed.sql should
-- either join and let a not-null constraint on the insert fail, or assert 7d
-- before committing. A shape that does both, and stays idempotent on a re-run:
--
--   insert into public.nav_items
--     (id, legacy_ref, parent_id, label, target_page_id, audience, sort_order,
--      visible)
--   select public.ces_uuid('nav_items', v.ref),
--          v.ref,
--          case when v.parent_ref is null then null
--               else public.ces_uuid('nav_items', v.parent_ref) end,
--          v.label,
--          p.id,
--          v.audience,
--          v.sort_order,
--          v.visible
--     from (values ...) as v (ref, parent_ref, label, path, audience,
--                             sort_order, visible)
--     join public.pages p on p.path = v.path
--    on conflict (legacy_ref) do nothing;
--
-- with the three group headers inserted separately (they have no path to join
-- on) and a terminal count check: an inner join drops any row whose path did not
-- resolve, so `38` rows present is itself the proof that all 35 paths matched.
-- Deriving both ids from public.ces_uuid('nav_items', ...) is what lets a child
-- name its parent in the same statement without a second pass, and is why no
-- uuid appears literally anywhere in this specification.
--
-- 7f. ONE CONSEQUENCE OF THE anon POLICY, stated here because it is invisible
-- until the header renders empty. Migration 17's anon policy is `select where
-- visible`, and the Header Actions GROUP is visible = false while its two
-- children are visible = true. An anonymous reader can therefore see the two
-- calls to action but NOT the row that groups them, so a reader that resolves
-- them by selecting the parent row by legacy_ref and then its children will
-- return nothing for exactly the visitors the calls to action exist for. Two
-- resolutions work and either is acceptable; what is not acceptable is
-- discovering this from an empty header:
--
--   * the header reader derives the group id directly --
--     public.ces_uuid('nav_items', 'nav:header-actions') -- and selects children
--     by parent_id, never reading the group row itself; or
--   * migration 17's anon policy admits a row that is the parent of a visible
--     row, i.e. `visible or exists (select 1 from public.nav_items c where
--     c.parent_id = nav_items.id and c.visible)`.
--
-- The group is NOT seeded visible instead. It must never render as a menu entry,
-- and `visible` is the only column that says so.
--
-- 7g. NO FAMILY-PORTAL ITEM IS SEEDED, and the omission is the decision rather
-- than an oversight. site_globals.family_portal_url (migration 11) holds
-- https://bngn.blackbaud.school/... recovered from a DISABLED replicator set in
-- content/collections/pages/deposits.md and seeded UNCONFIRMED. Until the school
-- confirms that destination is current, shipping it into an enrolled-family
-- journey would put a dead link in the menu, which is worse than shipping
-- nothing. When it is confirmed the item is one update-nav-tree call: a row
-- under Our Community with external_url set, target_page_id null, audience
-- 'enrolled' -- every column it needs already exists here. Should a row be
-- seeded ahead of that confirmation for any reason, it seeds visible = false.
