-- =============================================================================
-- Cambridge-Ellis School  ·  migration 06 of 18  ·  people
-- =============================================================================
-- Creates three tables -- public.people, public.person_education and
-- public.person_roles -- plus the single function that enforces the
-- at-least-one-role invariant. Nothing else.
--
-- Why person_roles lives here and not in migration 03 (taxonomy): it carries a
-- foreign key to BOTH public.people (this file) and public.taxonomy_terms
-- (migration 03), so it goes where both parents already exist. The eighteen
-- filenames are a fixed, ordered sequence and no nineteenth file is added.
-- Migration 03 states the same boundary from its own side at
-- 20260901120300_taxonomy.sql:23-29, and declines to leave a placeholder there:
-- a table declared in one migration and given its foreign key in another is
-- worse than one whole table in one place. This is the same dependency-order
-- reasoning that puts the content_routes view (15) and the write functions (16)
-- after every table they touch.
--
-- Source of truth, read in full rather than inferred:
--
--   resources/blueprints/collections/people/people.yaml
--        The column set. Handle -> column, with the two renames this file makes
--        and the reason for each:
--          title (line 7)          -> name             `display: Name`; the
--                                                      handle is generic, the
--                                                      column says what it holds
--          officialtitle (line 18) -> official_title    snake case
--          joined_ces (line 27)    -> joined_ces  date  `type: date`,
--                                                      `time_enabled: false`
--          education (line 43)     -> person_education  replicator, ONE set
--          email (line 64)         -> email
--          bio (line 73)           -> bio               `type: textarea`, so
--                                                      plain text and NOT bard
--          photo (line 81)         -> photo_asset_id    `max_files: 1`, not
--                                                      required
--          slug (line 95)          -> slug              `validate: [required,
--                                                      unique_entry_value:...]`
--          role (line 103)         -> person_roles      `type: terms`,
--                                                      `validate: [required]`
--                                                      at lines 114-115
--   content/collections/people.yaml
--        `route: /community/{slug}`, `template: bio`, `taxonomies: [role]`,
--        `sort_dir: asc`. It also declares `date_behavior: {past: public,
--        future: private}`, which is INERT and is deliberately not reproduced:
--        the collection is not `dated` and no entry carries an entry-level
--        `date:` key, so the setting has no effect. Runtime confirms it --
--        /events/open-house returns 200 while the unpublished
--        /events/story-slam returns 404. Publish state alone governs
--        visibility, in the legacy site and here.
--   content/collections/people/*.md
--        77 entries, of which 21 are drafts. All 77 carry a non-empty `role:`
--        list, which is what makes the invariant in section 9 satisfiable by
--        the canonical seed rather than a load-blocker. Their `education`
--        replicators yield 81 `institution` sets in total, exactly one of which
--        is `enabled: false` -- the first set in
--        content/collections/people/jeanette-herrera.md.
--
-- Verified volumes, restated once so a later reader can check the load without
-- content/ (which is deleted at the end of the migration phase):
--
--   people             77 rows, 21 with published = false
--   person_education   81 rows, 1 with enabled = false
--   person_roles       at least 77 rows -- every person has one or more
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   classroom_teachers  migration 08 (classrooms). It cannot be created here:
--                       its other parent does not exist yet. It is also the
--                       one relation in this schema that is not lossless by
--                       default -- see the note in section 5 about
--                       people.legacy.classrooms, which is half its evidence.
--   policies            migration 17, with the table-level grants. Row level
--                       security is switched ON here for all three tables and
--                       ZERO policies are written. That combination is the
--                       least-privilege order and not an oversight: the tables
--                       are closed to anon and authenticated from the moment
--                       they exist, and are opened deliberately, once, in one
--                       reviewable place. supabase/seed.sql is unaffected
--                       because it loads as service_role, which bypasses RLS.
--   write functions     migration 16 -- create-entry, update-slug,
--                       set-published, reorder-entries, delete-entry and the
--                       rest, each checking session, active membership, AAL2
--                       and capability before applying a mutation. Direct DML
--                       on content tables is revoked from `authenticated`
--                       there, so a bearer token calling PostgREST directly
--                       cannot write.
--   rows                supabase/seed.sql, the canonical load. No insert
--                       appears in this file: two owners of the same rows is
--                       precisely how they diverge.
--   length limits       nothing, anywhere. people.yaml declares no
--                       `character_limit` on any field, so unlike
--                       announcements.title or the umbrella descriptions there
--                       is not even a limit to grandfather. Where limits do
--                       exist elsewhere they live in nextjs/lib/schema.ts and
--                       the migration 16 write functions, never as a check
--                       constraint, so the legacy corpus can never abort the
--                       load.
--
-- Depends on migration 01 for extensions.gen_random_uuid() and
-- public.set_updated_at(), on migration 02 for public.assets and on migration
-- 03 for public.taxonomy_terms. Follows the schema contract stated once at
-- 20260901120100_extensions.sql:29-67. Every statement is idempotent --
-- `create table if not exists`, `create index if not exists`, `drop constraint
-- if exists` before `add constraint`, and `drop trigger if exists` before
-- `create trigger`, which the two CONSTRAINT triggers in section 9 need just as
-- much as an ordinary one -- so applying all eighteen migrations twice is
-- clean.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. people
-- -----------------------------------------------------------------------------
-- Per-column rationale is carried in the `comment on column` statements in
-- section 10 rather than duplicated here, because those comments survive into
-- the database and stay readable after content/ is gone. The notes in this
-- block are limited to decisions a reader would otherwise have to reverse
-- engineer from the column list.

create table if not exists public.people (

  -- Identity. gen_random_uuid() is schema-qualified because pgcrypto lives in
  -- the extensions schema and migration 01 makes qualification an absolute
  -- project rule (20260901120100_extensions.sql:76-83); an unqualified call
  -- inside a search_path-pinned function fails at runtime rather than at create
  -- time. Seeded rows do not use this default -- they derive their id from
  -- public.ces_uuid('people', legacy_ref), which is what makes the load
  -- idempotent and lets person_education and person_roles reference a person
  -- before that person is inserted -- so the default serves rows the editor
  -- creates later.
  id                 uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id, e.g. 328dac6a-39bb-4cfe-bfca-9d8b36a34b5c. Null on
  -- editor-created rows.
  legacy_ref         text,

  -- Derived from the source FILENAME: not one of the 77 entries carries a
  -- `slug:` key, because Statamic takes it from the file name. It is also the
  -- final tie-breaker of every ordering in this project.
  slug               text not null,

  -- The `title` handle, renamed. See the column comment.
  name               text not null,

  -- All four nullable, exactly as the blueprint declares them: only `title`
  -- and `slug` carry `validate: [required]`.
  official_title     text,

  -- `date`, never timestamptz. See the column comment.
  joined_ces         date,

  email              text,
  bio                text,

  -- No `on delete` action, therefore NO ACTION, therefore deleting an asset
  -- that any person references is BLOCKED. That is deliberate and must not be
  -- weakened from this side -- migration 02 says so at
  -- 20260901120200_assets.sql:42-44. `on delete set null` would be wrong here
  -- even though this column is nullable, because the editor's job is to list
  -- the referencing rows and let an admin decide, not to silently drop a
  -- portrait; and it is impossible on promoted.image_asset_id, which is not
  -- null, so one rule across the schema beats two.
  photo_asset_id     uuid,

  -- Draft is the safe default: a load error must never publish content. 21 of
  -- the 77 source entries are drafts and those flags migrate exactly.
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

  -- The undeclared drift keys. Exactly two of them, named in the column
  -- comment. jsonb because their structure is genuinely variable and no
  -- blueprint gives either a shape.
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
  constraint people_legacy_ref_key unique (legacy_ref),

  -- The route key. `route: /community/{slug}` makes this the URL, so
  -- uniqueness here is what keeps /community/<slug> resolving to one person.
  -- The cross-table guarantee is migration 15's: content_routes must hold one
  -- row per path, and a per-table unique cannot see the other three routable
  -- tables.
  constraint people_slug_key unique (slug),

  constraint people_photo_asset_id_fkey
    foreign key (photo_asset_id) references public.assets (id),

  constraint people_og_image_id_fkey
    foreign key (og_image_id) references public.assets (id)
);


-- -----------------------------------------------------------------------------
-- 2. people · row level security
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
-- draft is not fetched then hidden; it is not returned. 21 of these 77 rows are
-- drafts, so that is not a hypothetical.

alter table public.people enable row level security;


-- -----------------------------------------------------------------------------
-- 3. people · the updated_at trigger
-- -----------------------------------------------------------------------------
-- The one shared function from migration 01. Dropped first because `create
-- trigger` has no `if not exists` form, which is what makes a second apply
-- clean. `created_at` is deliberately left as a column default only.

drop trigger if exists set_people_updated_at on public.people;

create trigger set_people_updated_at
  before update on public.people
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. people · indexes
-- -----------------------------------------------------------------------------
-- `slug` and `legacy_ref` are already indexed by their unique constraints and
-- are not repeated. Each index below backs a named access path.

-- Every anonymous read of this table filters on published: the two people
-- index pages and migration 17's policy surface all do.
create index if not exists people_published_idx
  on public.people (published);

-- Both asset references are indexed because deleting an asset must check them.
-- With NO ACTION the check runs at end of statement over every referencing
-- table, and an unindexed referencing column turns each such check into a
-- sequential scan. These also serve the editor's "what references this asset?"
-- listing, which is the affordance that makes a blocked delete usable rather
-- than merely refused.
create index if not exists people_photo_asset_id_idx
  on public.people (photo_asset_id);

create index if not exists people_og_image_id_idx
  on public.people (og_image_id);

-- The collection surface at /admin/collections/people lists rows in
-- sort_order, and reorder-entries renumbers on it.
create index if not exists people_sort_order_idx
  on public.people (sort_order);


-- -----------------------------------------------------------------------------
-- 5. person_education
-- -----------------------------------------------------------------------------
-- The `education` replicator, normalized. It has exactly ONE set --
-- `institution` -- whose only field is `name_of_institution`
-- (resources/blueprints/collections/people/people.yaml:43-62), so the child
-- table needs one content column and no `kind` discriminator and no `data`
-- jsonb. This is the scalar-versus-repeater rule from the plan applied
-- literally: a scalar or single asset reference becomes a typed column on the
-- parent, a repeater becomes ordered rows in a child table.
--
-- Child identity is DERIVED, never taken from the source. `legacy_ref` here is
-- `<person legacy_ref>:education:<ordinal>` with the ordinal in source order.
-- That is mandatory rather than stylistic: of the 81 `institution` sets, seven
-- carry no source `id` at all. Where a source id does exist it is retained in
-- `legacy.set_id` for traceability and is NOT the identity. Migration 01
-- documents the same rule at 20260901120100_extensions.sql:145-151.
--
-- A note that belongs with this table because it is the other half of a
-- reconciliation migration 08 has to make, and because people.legacy is where
-- the evidence is kept: the classroom relation is NOT lossless by default. The
-- entries' own `classrooms.teachers` lists yield 32 teacher-classroom pairs;
-- the reverse `people.classrooms` lists yield 24; only 15 appear in both, so
-- the union is 41 -- 17 forward-only and 9 reverse-only, with zero dangling
-- references in either direction. The legacy template renders the REVERSE
-- query, so adopting the declared forward relation alone would silently remove
-- nine associations the site displays today. Migration 08 therefore loads the
-- union of 41 with a `source` tag of forward / reverse / both, and BOTH
-- original arrays are retained in `legacy` on their respective rows. That is
-- why people.legacy.classrooms must hold the raw reverse array for the 22
-- entries that carry it, and why it must not be dropped as redundant: it is the
-- audit trail for a reconciliation that adds 17 visible associations, listed
-- for school review in artifacts/parity-report.json.

create table if not exists public.person_education (

  id               uuid primary key default extensions.gen_random_uuid(),

  -- The derived composite described above, e.g.
  -- 328dac6a-39bb-4cfe-bfca-9d8b36a34b5c:education:0.
  legacy_ref       text,

  person_id        uuid not null,

  -- The set's sole field, `name_of_institution`. `not null` because a set that
  -- exists names an institution; an empty one would be a set the editor should
  -- have deleted.
  institution_name text not null,

  -- Source order within the person's replicator. The uniqueness constraint is
  -- declared separately in section 6, because its deferrability is the one
  -- property worth re-asserting on every apply.
  sort_order       integer not null,

  -- Real editorial state that no blueprint declares. Statamic honours
  -- `enabled: false` on a replicator set and hides it from the front end, and
  -- exactly one row in this table is false: the first `institution` set in
  -- content/collections/people/jeanette-herrera.md ('A.A. Cambridge College',
  -- source id AOk8pOUc). Default true, because that is what an absent key
  -- means -- 80 of the 81 sets carry no `enabled` key at all or carry true.
  --
  -- Disabled rows are suppressed from public rendering, remain visible and
  -- toggleable in edit mode, and round-trip through export: the export re-emits
  -- `enabled: false` so a later re-extraction sees what the source saw.
  -- Migration 17's anon policy on this table is therefore parent published AND
  -- enabled, while the authenticated policy ignores `enabled` so the row stays
  -- editable.
  enabled          boolean not null default true,

  -- Holds `set_id` where the source set carried an id -- 74 of the 81 do, seven
  -- do not. Nothing else.
  legacy           jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default timezone('utc', now()),
  updated_at       timestamptz not null default timezone('utc', now()),

  constraint person_education_legacy_ref_key unique (legacy_ref),

  -- `on delete cascade`: an education row has no meaning without its person,
  -- and the parent's own deletion is the only thing that should remove it.
  constraint person_education_person_id_fkey
    foreign key (person_id) references public.people (id) on delete cascade
);


-- -----------------------------------------------------------------------------
-- 6. person_education · the ordering constraint
-- -----------------------------------------------------------------------------
-- Declared here as drop-then-add rather than inline in the create above, and
-- for one specific reason: `deferrable initially immediate` is the property a
-- drifted environment could silently lack, and re-asserting it on every apply
-- is what makes this file converge rather than merely not error. The definition
-- appears exactly once.
--
-- `nulls not distinct` follows the schema-wide convention stated at
-- 20260901120100_extensions.sql:50-56. On this table `person_id` is `not null`,
-- so it is belt-and-braces here rather than load-bearing as it is for a table
-- whose parent column is nullable -- there, a plain unique treats null parents
-- as distinct and would let every root share position 1. It is kept for
-- consistency, so that reading two child tables side by side does not suggest a
-- difference in intent that does not exist.
--
-- The deferrability IS load-bearing. A reorder swapping two rows' positions
-- must pass through a state where two rows share a sort_order; with an
-- immediate constraint the write function would have to renumber through a
-- temporary hole, which is exactly the kind of workaround that leaves gaps
-- behind when it fails halfway. `initially immediate` keeps ordinary
-- single-row inserts failing fast, and reorder-entries in migration 16 issues
-- `set constraints ... deferred` inside its own transaction.
--
-- Scope is (person_id, sort_order), so two DIFFERENT people may hold the same
-- sort_order -- correct, because ordering is per person, not global.

alter table public.person_education
  drop constraint if exists person_education_person_id_sort_order_key;

alter table public.person_education
  add constraint person_education_person_id_sort_order_key
  unique nulls not distinct (person_id, sort_order)
  deferrable initially immediate;


-- -----------------------------------------------------------------------------
-- 7. person_education · row level security, trigger and indexes
-- -----------------------------------------------------------------------------
-- RLS on, zero policies, for the same reason as section 2. This table has no
-- `published` column of its own, which is why migration 17's anon policy has to
-- reach through person_id to the parent's flag: a child row is public only if
-- its person is published and the row itself is enabled.

alter table public.person_education enable row level security;


drop trigger if exists set_person_education_updated_at on public.person_education;

create trigger set_person_education_updated_at
  before update on public.person_education
  for each row
  execute function public.set_updated_at();


-- Every read of this table is "the education rows for person X", and the
-- cascade from public.people needs an index on the referencing column or each
-- parent delete degrades to a sequential scan here.
--
-- Stated plainly rather than left for a reviewer to notice: the leading column
-- of person_education_person_id_sort_order_key already serves person_id
-- lookups, so this index is redundant with it TODAY. It is declared anyway,
-- because the project indexes every foreign key and because the cascade's
-- supporting index should not be a side effect of the ordering constraint's
-- current shape -- a future change to the reorder strategy would otherwise
-- remove it silently.
create index if not exists person_education_person_id_idx
  on public.person_education (person_id);

-- A boolean index earns its place here only in one direction, and that is the
-- direction that is queried: `enabled = false` selects 1 row of 81, which is
-- selective enough for the planner to use. It backs the editor's and the
-- exporter's enumeration of disabled records and the parity assertion that
-- exactly one row is disabled. The `enabled = true` side is served by the
-- composite above, since public reads always arrive scoped to a person.
create index if not exists person_education_enabled_idx
  on public.person_education (enabled);


-- -----------------------------------------------------------------------------
-- 8. person_roles
-- -----------------------------------------------------------------------------
-- The taxonomy relation for the `role` field
-- (resources/blueprints/collections/people/people.yaml:103-115). A pure join
-- table: the composite primary key is the whole of its identity, so it carries
-- no id, no legacy_ref and no updated_at.
--
-- There is deliberately NO sort_order. The source `role` list has no
-- meaningful order -- it is a `mode: select` term field, the three terms are
-- teacher, leadership and board-of-directors, and nothing on the site renders
-- them in a sequence a person could have chosen. A sort_order column here
-- would promise a control with nothing behind it, and the collection surface
-- would then have to offer a reorder that changes nothing.
--
-- Both foreign keys cascade. On the people side that is the same reasoning as
-- person_education: the relation has no meaning without the person. On the
-- taxonomy side the cascade is the DATABASE's floor and not the product
-- behaviour: migration 16's `delete-term` command is reference-safe and REFUSES
-- while any entry still references the term, naming the referencing rows, with
-- a separate `force-delete-term` action that detaches it from every entry in
-- one change set. The cascade exists so that a forced deletion cannot leave an
-- orphan row pointing at a term that no longer exists, not so that terms can be
-- deleted casually -- and taxonomy term deletion is admin-only in the first
-- place (migration 03 records that it is one of the five capabilities the
-- target removes from `editor`).
--
-- One consequence of that cascade meeting the invariant in section 9 is
-- specified here rather than discovered later, because it constrains a command
-- migration 16 owns and was verified against this schema rather than reasoned
-- about. Deleting a term cascades away the person_roles rows that reference it;
-- for a person whose ONLY role was that term, the deferred check then finds an
-- empty role set and the whole transaction is rejected at commit with `person
-- <slug> (<id>) must have at least one role`. So:
--
--   * `delete-term` is unaffected -- it already refuses while any entry
--     references the term.
--   * `force-delete-term` cannot be a blind detach. For each person left with
--     no other role it must either assign a replacement term in the same change
--     set or refuse and name those people. A blind detach does not corrupt
--     anything -- the invariant rolls the change set back intact -- but it
--     fails, and it should fail with the editor's own explanation rather than
--     with a database exception.
--
-- The alternative would be weakening the invariant to make a convenience
-- possible, which inverts the priority: the source declares the role field
-- required, and three terms exist, so a person can always be moved to another
-- one.

create table if not exists public.person_roles (

  person_id  uuid not null,
  term_id    uuid not null,

  -- When the association was made. There is no updated_at and no trigger: a
  -- join row is immutable -- changing either column makes it a different
  -- association -- so the editor's term picker inserts and deletes rather than
  -- updating.
  created_at timestamptz not null default timezone('utc', now()),

  constraint person_roles_pkey primary key (person_id, term_id),

  constraint person_roles_person_id_fkey
    foreign key (person_id) references public.people (id) on delete cascade,

  constraint person_roles_term_id_fkey
    foreign key (term_id) references public.taxonomy_terms (id) on delete cascade
);


alter table public.person_roles enable row level security;


-- The primary key already indexes (person_id, term_id) and therefore serves
-- person_id, so only the reverse direction needs its own index: "which people
-- hold this term" is the query behind the Leadership Team, Teaching Team and
-- Board of Directors pages -- all three of which replace the legacy template's
-- `slug | contains:` string matching with an explicit role-term query -- and it
-- is also the lookup a term deletion has to make.
create index if not exists person_roles_term_id_idx
  on public.person_roles (term_id);



-- -----------------------------------------------------------------------------
-- 9. The at-least-one-role invariant
-- -----------------------------------------------------------------------------
-- Every person must hold at least one role. This is a source rule, not an
-- invention: resources/blueprints/collections/people/people.yaml:114-115
-- declares `validate: [required]` on the `role` terms field, and all 77 source
-- entries satisfy it -- verified by parsing the entries rather than by trusting
-- the blueprint -- so the canonical seed load meets the invariant instead of
-- being blocked by it. Migration 03 anticipates this file enforcing it
-- (20260901120300_taxonomy.sql:14-18).
--
-- It cannot be a check constraint or a foreign key: "at least one row exists in
-- another table" is not expressible as either. It cannot be a PLAIN `after
-- insert` trigger either, and that is the crux of the design. A person and its
-- role rows are inserted in the same transaction, in that order, because
-- person_roles.person_id references public.people -- so a non-deferred trigger
-- would fire the instant the person row landed, before any role row could
-- exist, and would reject every correct insert in the corpus. The enforcement
-- point has to be COMMIT, which is exactly what a `deferrable initially
-- deferred` CONSTRAINT trigger provides.
--
-- Two consequences of that are worth stating so they are not discovered by
-- accident:
--
--   * supabase/seed.sql must insert a person and its person_roles rows inside
--     ONE transaction. It does -- it is a single transactional load that ends
--     with its own assertions -- but a hand-run of individual insert statements
--     in psql's autocommit mode would commit the person alone and be rejected
--     here, correctly.
--   * The violation surfaces at commit rather than at the offending statement.
--     The message therefore names the person by slug and id, because "which
--     row?" is not answerable from the statement that failed.
--
-- Two triggers, one function. Both directions are covered:
--
--   people          after insert       a person created with no roles
--   person_roles    after delete       a person's last role removed
--                   after update       a role moved to another person, which
--                                      can empty the row it left
--
-- Not wired, deliberately:
--
--   people after update    an update cannot change the role set. Changing
--                          people.id would have to, but the person_roles
--                          foreign key has no `on update cascade`, so such an
--                          update is rejected by the foreign key while any role
--                          row exists.
--   people after delete    a person that no longer exists has no invariant to
--                          satisfy. The cascade removes its role rows, and the
--                          person_roles trigger that those removals fire finds
--                          no person and returns -- see the guard in the
--                          function body, which is what stops a legitimate
--                          person deletion from being read as a violation.
--   person_roles insert    adding a role can never empty a role set.
--
-- No `when` clause is used on either trigger, and that is not an oversight: for
-- a constraint trigger the `when` condition is evaluated immediately after the
-- row operation rather than at commit, so a `when` that counted role rows would
-- be asking the very question that has to wait until the transaction ends.
-- All of the logic therefore lives in the function body.
--
-- Two boundaries of this mechanism, verified against this schema rather than
-- assumed, so nobody has to rediscover them:
--
--   * A person inserted and deleted within the SAME transaction commits
--     cleanly. The insert queues a deferred event, and by the time it runs the
--     person is gone, so the guard in the function returns. That is correct:
--     there is no row left to hold a role.
--   * `truncate public.person_roles` does NOT fire row triggers, so it can
--     leave people roleless without raising. This is inherent to row-level
--     triggers and is accepted rather than worked around: truncate needs table
--     ownership, no application path issues one -- content writes all go
--     through the migration 16 write functions, which are DML -- and the sole
--     legitimate use is a full reload, which repopulates both tables in one
--     transaction. Building a statement-level guard for it would add a check on
--     every write to defend against an operation the application cannot
--     perform.

-- `security definer` is load-bearing rather than habitual. Row level security
-- is enabled on both tables this function reads, and migration 17 will restrict
-- what `authenticated` may see. A trigger function running as the caller would
-- have its `exists` probe filtered by those policies and could conclude that a
-- person has no roles when the rows are merely invisible -- a false violation
-- that would block a legitimate write. Running as the owner, which is exempt
-- from RLS on these tables, makes the check see the true state. It cannot be
-- abused as an escalation: the function reads two columns, returns nothing, and
-- raises when the invariant is broken.
--
-- `search_path = ''` follows the project rule
-- (20260901120100_extensions.sql:62-65), so every identifier below is
-- schema-qualified. pg_catalog stays implicitly searched, which is why the
-- unqualified `uuid` and `text` types resolve.
--
-- No grant or revoke accompanies this function, matching migration 01's
-- treatment of public.set_updated_at(). Trigger privileges are checked when the
-- trigger is created, not when it fires, and a direct call is refused by
-- Postgres itself -- a trigger function invoked outside a trigger context
-- raises -- so PUBLIC's default execute privilege grants nobody anything here.

create or replace function public.assert_person_has_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_slug      text;
begin
  -- Resolve which person's role set may have been left empty. One function
  -- serves triggers on two tables, so it dispatches on the firing table.
  if tg_table_name = 'people' then

    -- Only `after insert` is wired on public.people. The guard is written
    -- anyway so that a future trigger definition cannot dereference a null
    -- `new` record and turn a schema change into a runtime error.
    if tg_op = 'DELETE' then
      return null;
    end if;

    v_person_id := new.id;

  elsif tg_table_name = 'person_roles' then

    -- Adding a role cannot empty a role set.
    if tg_op = 'INSERT' then
      return null;
    end if;

    -- delete and update: the row the association LEFT is the one at risk.
    -- Where an update moved it, the destination person gained a row and needs
    -- no check.
    v_person_id := old.person_id;

  else

    -- Unreachable while only the two triggers below exist. Returning rather
    -- than raising means attaching this function to a third table degrades to
    -- "no check" instead of "every write fails".
    return null;

  end if;

  -- The person may legitimately be gone: deleting a person cascades to
  -- public.person_roles, and each of those deletions queues one of these
  -- deferred events. Without this guard every person deletion would raise at
  -- commit. `found` is set by the select into above it.
  select p.slug
    into v_slug
    from public.people p
   where p.id = v_person_id;

  if not found then
    return null;
  end if;

  if exists (
    select 1
      from public.person_roles pr
     where pr.person_id = v_person_id
  ) then
    return null;
  end if;

  -- errcode 23514 is check_violation. A custom SQLSTATE would carry no meaning
  -- to a client; this is an integrity constraint violation and reporting it in
  -- class 23 lets the Server Actions in nextjs/lib/actions/* map it with every
  -- other one instead of special-casing a bespoke code.
  raise exception 'person % (%) must have at least one role', v_slug, v_person_id
    using
      errcode = '23514',
      detail  = 'public.person_roles holds no row for this person, and the '
                'role field is required by '
                'resources/blueprints/collections/people/people.yaml:114-115.',
      hint    = 'Insert at least one public.person_roles row for this person in '
                'the same transaction, or delete the person.';
end;
$$;


-- Dropped before created because CREATE OR REPLACE TRIGGER does not extend to
-- constraint triggers, and `create constraint trigger` has no `if not exists`
-- form. Without these two guarded drops a second apply of the eighteen
-- migrations fails here -- which is the single most likely idempotency failure
-- in this file.

drop trigger if exists people_has_role_check on public.people;

create constraint trigger people_has_role_check
  after insert on public.people
  deferrable initially deferred
  for each row
  execute function public.assert_person_has_role();


drop trigger if exists person_roles_has_role_check on public.person_roles;

create constraint trigger person_roles_has_role_check
  after delete or update on public.person_roles
  deferrable initially deferred
  for each row
  execute function public.assert_person_has_role();


-- -----------------------------------------------------------------------------
-- 10. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. This file deletes nothing, but content/ is
-- removed at the end of the migration phase, so after cutover the database is
-- the only place a reader can learn why a column exists or what its values
-- mean. artifacts/migration-source-manifest.json and
-- artifacts/corpus-census.json hold the machine-readable half.

comment on table public.people is
  'Staff, leadership and board members, migrated from '
  'content/collections/people/*.md. 77 rows, 21 of them drafts. Routed at '
  '/community/{slug} and rendered by nextjs/components/templates/Bio.tsx. '
  'Education is normalized into person_education; the role taxonomy relation '
  'into person_roles, which every row must have at least one of. The classroom '
  'relation is NOT here: migration 08 owns classroom_teachers, loaded as the '
  'union of both legacy directions, and this table keeps the reverse direction '
  'raw in legacy.classrooms as that reconciliation''s audit trail.';

comment on column public.people.id is
  'Primary key. Seeded rows derive theirs from public.ces_uuid(''people'', '
  'legacy_ref) so the load is idempotent and person_education and person_roles '
  'can reference a person before this row is inserted; the gen_random_uuid() '
  'default serves rows created later through the editor''s create-entry '
  'command, which have no legacy_ref to derive from.';

comment on column public.people.legacy_ref is
  'Source identity: the entry''s own `id` front-matter value, e.g. '
  '328dac6a-39bb-4cfe-bfca-9d8b36a34b5c. text rather than uuid because '
  'legacy_ref is one column type across the whole schema and source '
  'identifiers are heterogeneous -- taxonomy terms are slugs, the page tree''s '
  'first node is the literal string `home`, replicator set ids are short '
  'random strings. Null on editor-created rows, and nullable-unique so any '
  'number of those coexist while no two migrated rows collide.';

comment on column public.people.slug is
  'URL-safe identifier and the route key: content/collections/people.yaml '
  'declares `route: /community/{slug}`, so this column IS the public URL and '
  'all 77 paths must be preserved exactly. Derived from the source FILENAME -- '
  'no entry carries a `slug:` key, because Statamic takes it from the file '
  'name. Also the final tie-breaker of every ordering in this project, '
  'including the Teaching Team page''s official_title, name, slug -- it is '
  'unique per collection and nothing else guarantees a stable order between '
  'two rows with equal sort keys.';

comment on column public.people.name is
  'The person''s name. Renamed from the source handle `title`, which is '
  'generic: the blueprint itself displays the field as "Name" '
  '(resources/blueprints/collections/people/people.yaml:7-13). Required in the '
  'source and not null here.';

comment on column public.people.official_title is
  'Job title, e.g. "Spanish Room Head Teacher". Snake-cased from the source '
  'handle `officialtitle`. Nullable -- the blueprint does not require it -- and '
  'it is the primary sort key of the Teaching Team page, matching the legacy '
  'template''s sort="officialtitle" ascending.';

comment on column public.people.joined_ces is
  'The date the person joined the school, e.g. 2018-01-01. Deliberately `date` '
  'and NOT timestamptz: the blueprint declares `type: date` with '
  '`time_enabled: false`, so the source value is a zone-free calendar day. '
  'Storing it as timestamptz would attach an instant the school never stated '
  'and let a client''s session timezone shift the day. The project timezone '
  'contract is America/New_York with no UTC conversion, and only structured '
  'data and calendar links need an absolute instant -- they compose one in '
  'nextjs/lib/timezone.ts. Rendered as "N years at CES", pluralized correctly '
  'and omitted entirely when null, which the legacy template gets wrong.';

comment on column public.people.email is
  'Contact address, rendered as a mailto: link -- which it is not today: '
  'resources/views/bio.antlers.html emits it as plain text.';

comment on column public.people.bio is
  'Biography. Plain text, not rich text: the source field is `type: textarea` '
  '(people.yaml:73-79), so there is no ProseMirror document here and the '
  'renderer must not treat it as one.';

comment on column public.people.photo_asset_id is
  'Portrait, as a foreign key to public.assets rather than a path. Nullable, '
  'because the source field is not required, and NO on-delete action, so '
  'deleting an asset a person references is BLOCKED -- the editor lists the '
  'referencing rows and an admin decides. `on delete set null` would silently '
  'drop a portrait, and it is impossible anyway on promoted.image_asset_id, '
  'which is not null; one rule across the schema beats two.';

comment on column public.people.published is
  'Publish state, authoritative and enforced server-side by migration 17: '
  'anonymous reads are restricted to published = true, so a draft is not '
  'fetched then hidden -- it is not returned. 21 of the 77 migrated rows are '
  'drafts and those flags transfer unchanged; publishing them to make pages '
  'visible would be a content change nobody asked for. Default false because a '
  'load error must never publish content.';

comment on column public.people.sort_order is
  'Manual ordering for the collection surface at '
  '/admin/collections/people. There is deliberately NO uniqueness constraint '
  'on it, only a plain index: the deferrable `unique nulls not distinct '
  '(parent_id, sort_order)` convention in this schema applies to CHILD tables, '
  'which have a parent column to scope uniqueness by, and people is a flat '
  'collection with none. A collection-wide unique would make the seed load and '
  'every reorder a constraint-juggling exercise for no gain, since '
  'reorder-entries in migration 16 renumbers siblings transactionally and the '
  'public orderings end in slug, which is unique -- so equal sort_order values '
  'still produce a stable, defined order. No default, so create-entry must '
  'compute a position (max + 1) rather than silently pile new rows at zero.';

comment on column public.people.seo_title is
  'Per-route SEO title override. Net-new: no legacy route carries one. Null '
  'means the deterministic fallback applies -- "<name>, <official title> · '
  'Cambridge-Ellis School".';

comment on column public.people.seo_description is
  'Per-route meta description override. Net-new: not one of the ten measured '
  'legacy routes has a meta description at all. Null means the fallback '
  'applies, and for a person that fallback is COMPOSED from name, official '
  'title and years at CES rather than extracted from the bio, because a '
  'biography''s opening sentence is often mid-thought.';

comment on column public.people.og_image_id is
  'Per-route Open Graph image override, as a foreign key to public.assets. '
  'Net-new. This is the column''s name everywhere in the project; renaming it '
  'is how a metadata function and a migration end up disagreeing. Null falls '
  'back to the portrait, then to the shared app/opengraph-image.tsx. NO '
  'on-delete action, for the same reason as photo_asset_id.';

comment on column public.people.legacy is
  'The undeclared source keys, retained queryably so nothing is discarded. '
  'Exactly two occur on people entries, neither declared by any blueprint: '
  '`programs` on 25 entries and `classrooms` on 22. legacy.classrooms is '
  'load-bearing rather than merely archival -- it is the REVERSE direction of '
  'the classroom relation, and the two directions disagree materially: '
  'classrooms.teachers yields 32 pairs, people.classrooms yields 24, only 15 '
  'are common. The legacy template renders the reverse query, so migration 08 '
  'loads the union of 41 with a source tag and both original arrays stay on '
  'their respective rows as that reconciliation''s audit trail. Do not drop '
  'this key as redundant. verify-parity.ts asserts every unmapped source key '
  'is retained here.';

comment on column public.people.source_updated_at is
  'The source entry''s own updated_at (a unix timestamp in the front matter), '
  'held verbatim and never defaulted, because defaulting it to load time would '
  'destroy the only record of when the school last touched the person. '
  'created_at and updated_at are operational columns describing target writes; '
  'parity-report.json asserts both the migrated source values and that no '
  'row''s operational timestamps precede the load.';

comment on column public.people.source_updated_by is
  'The source entry''s updated_by, mapped from the Statamic user id to that '
  'user''s email address: 1179db75-8eeb-4bad-8e60-d5005aef7ef8 -> '
  'bekah@cambridge-ellis.org and b863e707-3140-4001-859f-3487e09c5881 -> '
  'conrad.fulbrook@gmail.com. Anything unrecognized is kept verbatim rather '
  'than nulled.';


comment on table public.person_education is
  'The `education` replicator, normalized: one row per `institution` set, 81 in '
  'total across the 77 people. The replicator declares exactly one set with '
  'exactly one field, so this table needs no kind discriminator and no data '
  'jsonb. Ordered per person by sort_order; disabled rows are suppressed '
  'publicly and stay editable.';

comment on column public.person_education.id is
  'Primary key. Seeded rows derive theirs from '
  'public.ces_uuid(''person_education'', legacy_ref), so a second seed load '
  'updates the same 81 rows instead of inserting 81 more; the '
  'gen_random_uuid() default serves rows added later through the editor.';

comment on column public.person_education.person_id is
  'The person this education row belongs to. Cascades on delete, because a set '
  'inside a person''s replicator has no existence apart from that person -- and '
  'the cascade is why this column is indexed separately from the ordering '
  'constraint.';

comment on column public.person_education.legacy_ref is
  'Derived child identity: <person legacy_ref>:education:<ordinal> with the '
  'ordinal in source order. Derived rather than taken from the source because '
  'seven of the 81 sets carry no `id` at all. Where a source id does exist it '
  'is kept in legacy.set_id for traceability and is NOT the identity -- which '
  'is what makes a second seed load produce identical ids instead of duplicate '
  'rows.';

comment on column public.person_education.institution_name is
  'The institution, e.g. "B.A. Cambridge College". The `institution` set''s '
  'sole field, source handle `name_of_institution`. Not null: a set that '
  'exists names an institution.';

comment on column public.person_education.sort_order is
  'Source order within the person''s replicator. Unique per person under a '
  'DEFERRABLE constraint, so a reorder may pass through a state where two rows '
  'share a position within one transaction; `initially immediate` keeps '
  'ordinary single-row inserts failing fast. Two different people may hold the '
  'same sort_order -- ordering is per person, not global.';

comment on column public.person_education.enabled is
  'Editorial state that no blueprint declares but Statamic honours: a '
  'replicator set carrying `enabled: false` is hidden from the front end. '
  'Exactly one row in this table is false -- the first institution set in '
  'content/collections/people/jeanette-herrera.md -- and preserving it is part '
  'of losing no content. Disabled rows render to nobody, remain visible and '
  'toggleable in edit mode, and round-trip through export so a later '
  're-extraction sees what the source saw. Default true, which is what an '
  'absent key means.';

comment on column public.person_education.legacy is
  'Holds `set_id`, the source replicator set id, where one existed -- 74 of the '
  '81 sets carry one. Traceability only: identity is legacy_ref. Nothing else '
  'goes in this column.';


comment on table public.person_roles is
  'The role taxonomy relation: which terms each person holds. A pure join '
  'table -- the composite primary key is its whole identity, so it carries no '
  'id, no legacy_ref and no updated_at. Every person must have at least one '
  'row here, enforced by the deferred constraint triggers backed by '
  'public.assert_person_has_role(); all 77 source entries satisfy it. There is '
  'deliberately no sort_order: the source role list has no meaningful order '
  'and nothing renders one.';

comment on column public.person_roles.person_id is
  'The person. Cascades on delete: the association has no meaning without '
  'them.';

comment on column public.person_roles.term_id is
  'The role term -- one of teacher, leadership or board-of-directors. Cascades '
  'on delete, which is the database''s floor and not the product behaviour: '
  'migration 16''s delete-term command REFUSES while any entry still '
  'references the term and names the referencing rows, and a separate forced '
  'action detaches it from every entry in one change set. The cascade exists so '
  'that a forced deletion cannot leave a row pointing at a term that no longer '
  'exists. Note the interaction with the at-least-one-role invariant, verified '
  'against this schema: deleting a term cascades these rows away, so for a '
  'person whose only role was that term the transaction is rejected at commit. '
  'force-delete-term must therefore assign a replacement term for those people '
  'in the same change set, or refuse and name them -- it cannot be a blind '
  'detach.';

comment on column public.person_roles.created_at is
  'When the association was made. There is no updated_at and no trigger: a '
  'join row is immutable, since changing either column makes it a different '
  'association, so the term picker inserts and deletes rather than updating.';


comment on function public.assert_person_has_role() is
  'Enforces at least one public.person_roles row per public.people row. Wired '
  'as DEFERRED constraint triggers on both tables -- after insert on people, '
  'after delete or update on person_roles -- because a person and its role '
  'rows are inserted in the same transaction and a non-deferred check would '
  'fire before the roles land, rejecting every correct insert. Derives from '
  '`validate: [required]` on the role field at '
  'resources/blueprints/collections/people/people.yaml:114-115; all 77 source '
  'entries satisfy it, so it is a rule the corpus already meets rather than a '
  'load-blocker. security definer so row level security cannot hide role rows '
  'and produce a false violation; search_path pinned and every identifier '
  'schema-qualified. Returns without raising when the person row itself is '
  'gone, so a person deletion cascading to its role rows is not misread as a '
  'violation.';

