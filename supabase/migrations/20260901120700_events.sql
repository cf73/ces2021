-- =============================================================================
-- Cambridge-Ellis School  ·  migration 07 of 18  ·  events
-- =============================================================================
-- Creates exactly one table: public.events. It carries the 18 entries of the
-- `events` collection, and it is the table that establishes this project's
-- zone-free date/time contract for every other table that stores a wall-clock
-- value (promoted.start_time / end_time in migration 09 follow it).
--
-- It also holds the most NOT NULL columns in the schema: FIVE, not four. They
-- come straight from the five `validate: - required` blocks in the blueprint and
-- are enumerated in section 1.
--
-- Source of truth for the field set, read in full rather than assumed:
--
--   resources/blueprints/collections/events/events.yaml
--                                   165 lines. Five required fields: title
--                                   (line 7, validate 12), event_date (14,
--                                   validate 32-33), location (57, validate
--                                   67-68), short_description (93, validate
--                                   104-105) and the sidebar slug (158,
--                                   validate 162-164, `required` plus
--                                   `unique_entry_value`). Everything else --
--                                   start_time (35), end_time (46), zoom_link
--                                   (70), image (82), details (107),
--                                   calendar_link (143) -- declares no
--                                   validation and is therefore nullable here.
--   content/collections/events.yaml route '/events/{slug}', template `event`,
--                                   sort_dir asc, revisions false. There is no
--                                   `sort_by` key: the public ordering comes
--                                   from the template's sort="event_date:asc".
--   content/collections/events/*.md the 18 entries. Verified directly: all 18
--                                   carry title, event_date, location and
--                                   short_description, so the five NOT NULLs
--                                   cannot block the canonical load; only 3
--                                   carry an image; 4 carry a calendar_link; 1
--                                   carries a zoom_link and its value is prose;
--                                   1 carries duplicated_from; the longest
--                                   short_description is 448 characters.
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   policies          migration 17. RLS is ENABLED in section 2 and zero
--                     policies are written, so the table is closed until 17
--                     opens it.
--   route resolution  migration 15 builds the content_routes view. This table
--                     supplies `slug`; the '/events/{slug}' pattern is applied
--                     there, not here.
--   write functions   migration 16, which owns create/edit authorization, the
--                     conflict check, the revision rows, and every editorial
--                     validation rule this file deliberately declines to encode
--                     as a check constraint (see sections 1 and 5).
--   seed rows         supabase/seed.sql is the canonical load. This file
--                     inserts nothing.
--
-- Every statement is idempotent -- `create table if not exists`, `create index
-- if not exists`, `drop trigger if exists` before `create trigger` -- so
-- applying all eighteen migrations twice is clean. Conventions (lowercase SQL,
-- `text` never varchar(n), the explicit timezone('utc', now()) timestamp form,
-- and jsonb only where the structure is genuinely variable) are stated once in
-- migration 01 and followed here.
--
-- This table declares NO check constraints at all. That is a decision, not an
-- omission, and each instance is justified where it arises: no length check on
-- short_description, no format check on zoom_link or calendar_link, and no
-- ordering check between start_time and end_time. Sections 1 and 5 carry the
-- reasoning.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
-- Column-by-column rationale is carried in the `comment on column` statements
-- in section 5 rather than duplicated here, because those comments survive into
-- the database and remain readable once content/ has been deleted.
--
-- THE TIMEZONE CONTRACT, stated here because this is the table that sets it.
-- Every source date is a local wall-clock value with no zone, and the contract
-- is America/New_York. `event_date` is `date`. `start_time` and `end_time` are
-- `time`. NEITHER IS EVER CONVERTED TO UTC, and neither may be widened to
-- timestamptz, timestamp or timetz. Only structured data (Event.startDate /
-- endDate) and calendar links need an absolute instant, and both compose it by
-- applying that zone's offset FOR THE SPECIFIC DATE in nextjs/lib/timezone.ts,
-- whose unit tests cover both DST boundaries and non-Eastern runner zones. A
-- future author reaching for timestamptz to "fix" the missing zone would
-- silently shift every event on the calendar by four or five hours.
--
-- THE FIVE NOT NULL COLUMNS, so a reader can count them without re-deriving:
-- title, event_date, location, short_description, slug. Five. `published` and
-- `legacy` are also not null but carry defaults, so they are never a load
-- hazard; the five above are the ones a caller must supply.

create table if not exists public.events (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule; an unqualified call would fail at runtime, not at create
  -- time. Seeded rows do not rely on this default -- they derive their id from
  -- public.ces_uuid('events', legacy_ref), which is what makes the load
  -- idempotent -- so the default serves editor-created rows.
  id                  uuid primary key default extensions.gen_random_uuid(),

  -- The source entry id from the .md front matter. Null on editor-created rows.
  legacy_ref          text unique,

  -- Derived from the FILENAME: no entry carries a `slug:` key, because Statamic
  -- derives it from the file name.
  slug                text not null unique,

  title               text not null,

  -- `date`, never timestamptz. See the timezone contract above.
  event_date          date not null,

  -- `time`, never timetz. Nullable: 8 of the 18 entries carry neither time and
  -- 1 carries only a start. Deliberately unconstrained -- see the note below
  -- the table and the column comments in section 5.
  start_time          time,
  end_time            time,

  -- A per-row venue value, NOT the school's own address. See the column
  -- comment: site_globals owns the school address and a globals edit does not
  -- touch this.
  location            text not null,

  -- Nullable and deliberately unconstrained: the one populated value in the
  -- corpus is prose, not a URL.
  zoom_link           text,

  -- NULLABLE, and that is specific to this table: only 3 of the 18 entries
  -- carry an image, so a NOT NULL here would abort the canonical load on 15
  -- rows. Contrast promoted.image_asset_id in migration 09, which IS not null.
  --
  -- NO referential action, per the contract migration 02 sets out for
  -- migrations 04-11: deleting an asset that any row still references is
  -- BLOCKED, and the editor answers a blocked delete by listing the referencing
  -- rows. `on delete set null` would silently blank a required image elsewhere
  -- in the schema and `on delete cascade` would let removing one photograph
  -- delete the event that displays it.
  image_asset_id      uuid references public.assets (id),

  -- NOT NULL, and with NO length check despite the blueprint's
  -- `character_limit: '500'` at events.yaml line 95. See the note below.
  short_description   text not null,

  -- jsonb, and one of only two columns here that earns it: a ProseMirror
  -- document genuinely IS a variable tree, so this is not a value that has a
  -- name being smuggled into json. See the column comment for the canonical
  -- shape.
  details             jsonb,

  -- Preserved verbatim where populated; never regenerated. 4 entries carry a
  -- hand-built Google Calendar template URL.
  calendar_link       text,

  -- Draft is the safe default for publication: a load error must never publish
  -- content.
  published           boolean not null default false,

  -- Net-new per-route SEO. No legacy route carries any of these. `og_image_id`
  -- is this column's name everywhere in the plan; do not rename it.
  seo_title           text,
  seo_description     text,
  og_image_id         uuid references public.assets (id),

  -- The second and last jsonb column. Holds every undeclared source key so
  -- nothing is discarded; 1 entry carries duplicated_from.
  legacy              jsonb not null default '{}'::jsonb,

  -- Migrated provenance, held verbatim. Distinct from the operational
  -- timestamps below, and never overwritten by a target write.
  source_updated_at   timestamptz,
  source_updated_by   text,

  -- Operational timestamps describing target writes. `updated_at` is
  -- maintained exclusively by the trigger in section 3; no application code and
  -- no write function in migration 16 writes it.
  created_at          timestamptz not null default timezone('utc', now()),
  updated_at          timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 1a. Why there are no check constraints on this table
-- -----------------------------------------------------------------------------
-- Four candidate constraints were considered and all four are declined. Each is
-- recorded so a later author does not add one believing it was overlooked.
--
-- short_description length. The blueprint declares `character_limit: '500'`
-- (events.yaml:95) and the corpus maximum is 448 characters, so a check WOULD
-- pass today -- this table is the one place a length check happens to be
-- satisfiable. It is still declined, because the project-wide rule is that
-- blueprint limits are enforced by nextjs/lib/schema.ts, the editor's character
-- counter and the migration 16 write functions on create and edit, while the
-- seed load is exempt and over-length legacy rows load grandfathered. Applying
-- that rule inconsistently on the single table where the corpus happens to
-- comply would be worse than applying it uniformly: it would make `events` the
-- one collection where an editor's 501st character fails in the database with a
-- constraint error instead of in the editor with a character count. For scale,
-- the corpus-wide grandfathered set is 6 rows -- 4 announcements.title at
-- 56/55/44/69 against a limit of 30, and 2 umbrella short_description at 379
-- and 606 against 300. `events` contributes zero.
--
-- zoom_link format. One entry (story-slam) holds the literal prose `Zoom link
-- to come`. A URL check would reject the real corpus outright. The value
-- migrates unchanged and renders as plain text with no href, because a link to
-- nothing is worse than a note. New writes require a valid https URL, enforced
-- in nextjs/lib/schema.ts and the write functions.
--
-- calendar_link format. Same reasoning, and the same answer: the four populated
-- values are curated URLs pointing at the school's real calendar and are
-- preserved verbatim, so nothing here needs a constraint to defend it.
--
-- start_time / end_time ordering. `check (end_time is null or start_time is
-- null or end_time >= start_time)` was evaluated against all 18 entries and
-- every one of them satisfies it: 9 rows carry both times and all 9 are
-- strictly increasing (06:30-11:00, 10:00-12:00, 17:00-20:00, 08:30-12:00,
-- 16:00-18:00, 03:00-06:00, 10:00-12:00, 19:00-20:30, 07:00-08:30), 1 carries
-- only a start, and 8 carry neither. So the constraint was permitted -- and it
-- is still declined, for three reasons. First, with zone-free `time` columns and
-- no end-date column, an overnight event genuinely has end_time < start_time: a
-- family camp-out running 20:00 to 07:00 is a shape this school could
-- reasonably schedule, and the constraint would block it permanently with no
-- workaround short of another migration. Second, every check constraint this
-- schema does declare is a CLOSED VOCABULARY -- page_sections.kind,
-- taxonomy_terms.taxonomy, admin_users.role, nav_items.audience,
-- classroom_teachers.source, assets.lifecycle, security_events.kind -- and a
-- cross-column temporal rule would be the only one of its kind here. Third, the
-- blueprint declares no validation on either time field, so a constraint would
-- be inventing an editorial rule rather than carrying one across. The sane
-- version of this rule is a warning in the editor that knows about overnight
-- events, and that belongs in nextjs/lib/schema.ts.


-- -----------------------------------------------------------------------------
-- 2. Row level security
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies, neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table where most of the migrated
-- rows are unpublished drafts (see the count note on the `published` column).
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that
-- load.
--
-- Migration 17 owns the policy set: `anon` gets `select` where published = true;
-- `authenticated` gets `select` on everything ONLY with active admin_users
-- membership AND aal2, and otherwise falls back to the same published = true
-- that anon sees; and direct DML is REVOKED from `authenticated` entirely, so
-- every write goes through a migration 16 security definer function and an
-- authenticated bearer token cannot mutate this table through the REST API.
--
-- One thing migration 17 must NOT add, stated here where the table is defined:
-- a publish predicate is the WHOLE of visibility for this table. See the
-- inert-date_behavior note in section 5.

alter table public.events enable row level security;


-- -----------------------------------------------------------------------------
-- 3. The updated_at trigger
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, which lists migration 07
-- among its attachers. `updated_at` therefore cannot be forged and cannot be
-- forgotten: no application code and no write function in migration 16 may set
-- the column.
--
-- `created_at` is deliberately left as a column default only, and
-- `source_updated_at` is migrated provenance that this trigger must never
-- touch -- the trigger assigns only new.updated_at, so it does not.

drop trigger if exists set_events_updated_at on public.events;

create trigger set_events_updated_at
  before update on public.events
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. Indexes
-- -----------------------------------------------------------------------------
-- `slug` and `legacy_ref` are already indexed by their unique constraints, so
-- they are not repeated here. The five below back specific, named access paths
-- rather than being added speculatively.
--
-- There is deliberately no index supporting a manual ordering, because there is
-- no manual ordering: see the no-sort_order note in section 5.

-- The public ordering is event_date ascending, and app/sitemap.ts reads the
-- column too.
create index if not exists events_event_date_idx
  on public.events (event_date);

-- Every anonymous read is filtered to published = true by the migration 17
-- policy, and the collection surface filters on it to list drafts.
create index if not exists events_published_idx
  on public.events (published);

-- The composite backs the /events index page's exact query -- published rows in
-- date order -- so that read is satisfied from one index rather than a filter
-- plus a sort. Column order matters: the equality predicate leads, the ordering
-- column follows.
create index if not exists events_published_event_date_idx
  on public.events (published, event_date);

-- Both asset references are indexed because the blocked-delete contract in
-- migration 02 requires the reverse lookup: before an asset can be deleted the
-- editor has to find every row referencing it, and the single visibility
-- predicate recomputes published_reference_count over exactly these columns.
create index if not exists events_image_asset_id_idx
  on public.events (image_asset_id);

create index if not exists events_og_image_id_idx
  on public.events (og_image_id);


-- -----------------------------------------------------------------------------
-- 5. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. This file deletes nothing, but content/ is
-- removed at the end of the migration phase, so after cutover the database
-- itself is the only place a reader can learn why a column exists, what its
-- values mean, or which constraints were considered and declined.

comment on table public.events is
  'The events collection: 18 rows migrated from content/collections/events, '
  'routed at /events/{slug} by the content_routes view in migration 15. '
  'Five NOT NULL columns -- title, event_date, location, short_description, '
  'slug -- matching the five validate:required blocks in '
  'resources/blueprints/collections/events/events.yaml. This is the table that '
  'sets the project timezone contract: wall-clock America/New_York values, '
  'never converted to UTC. It declares no check constraints at all, and the '
  'reasoning for each one declined is in the file that created it.';

comment on column public.events.id is
  'Primary key. Seeded rows derive theirs from public.ces_uuid(''events'', '
  'legacy_ref) so the load is idempotent and a referencing row can be written '
  'before this one; the default serves editor-created rows.';

comment on column public.events.legacy_ref is
  'The source entry id from the .md front matter, e.g. '
  'ecbb3d41-19c6-47b5-a3de-417466f44ef7 for open-house. Set on all 18 migrated '
  'rows, null on editor-created ones. Scoped by table through ces_uuid, so an '
  'events legacy_ref cannot collide with a people or pages one.';

comment on column public.events.slug is
  'The URL segment, unique across this collection. Derived from the source '
  'FILENAME, not from front matter: no entry carries a slug key, because '
  'Statamic derives it from the file name. Also the final tie-breaker in every '
  'ordering of this table -- see the ordering note on event_date.';

comment on column public.events.title is
  'The event name, as staff wrote it. Required, per validate at '
  'events.yaml:12. Carried across verbatim -- no copy in this collection is '
  'edited by the migration. Also the second key in the public ordering, '
  'between event_date and slug.';

comment on column public.events.event_date is
  'The event day as a LOCAL WALL-CLOCK DATE in America/New_York, stored as '
  '`date`. Never timestamptz, never timestamp, and never converted to UTC: a '
  'zone-bearing type would shift every event by four or five hours depending '
  'on the date, and would make the stored value depend on the writing '
  'client''s session TimeZone. Only structured data and calendar links need an '
  'absolute instant, and they compose it by applying the zone offset for the '
  'specific date in nextjs/lib/timezone.ts, whose tests cover both DST '
  'boundaries and non-Eastern runner zones. PUBLIC ORDERING is this column '
  'ascending, then title, then slug as the final tie-breaker -- matching '
  'sort_dir: asc in content/collections/events.yaml and the legacy template''s '
  'sort="event_date:asc". Slug is required as the last key because nothing '
  'else guarantees a stable order between two events on the same day with the '
  'same title.';

comment on column public.events.start_time is
  'Local wall-clock start time in America/New_York, stored as `time` -- never '
  'timetz, never timestamptz, and never converted to UTC. See event_date for '
  'the full contract. Nullable: 8 of the 18 migrated entries carry no time at '
  'all, so an all-day or time-unannounced event is represented by null rather '
  'than by a sentinel such as 00:00. The blueprint sets seconds_enabled: '
  'false, so values are minute-precision.';

comment on column public.events.end_time is
  'Local wall-clock end time, stored as `time`, same contract as start_time. '
  'Nullable and independent of start_time: one migrated entry '
  '(outdoor-movie-night) carries a start with no end, which is a legitimate '
  '"starts at 5, runs as long as it runs" event. DELIBERATELY UNCONSTRAINED, '
  'and the omission was tested rather than overlooked: a check requiring '
  'end_time >= start_time was evaluated against all 18 entries and every one '
  'satisfies it, so the constraint was available -- it is declined because '
  'with zone-free time columns and no end-date column an overnight event '
  'legitimately stores end_time < start_time (a camp-out running 20:00 to '
  '07:00), and a check would block that shape permanently. The editorial rule, '
  'which can distinguish an overnight event from a typo, belongs in '
  'nextjs/lib/schema.ts and the migration 16 write functions. Do not add the '
  'constraint here.';

comment on column public.events.location is
  'The venue for THIS event, as free text -- 80 Trowbridge St, Cambridge for '
  'an open house, Big Playground for the Festival of Lights. A PER-ROW value, '
  'and deliberately not a reference to the school''s own address: site_globals '
  'owns address_line_1, address_locality, address_region and address_postal, '
  'and editing those does not and must not touch this column. The globals '
  'editor states that distinction on the field so nobody expects one edit to '
  'update the other. Required, per validate at events.yaml:67-68.';

comment on column public.events.zoom_link is
  'A joining link for a remote or hybrid event. Nullable and DELIBERATELY '
  'UNCONSTRAINED: exactly one migrated entry (story-slam) populates it, and '
  'its value is the literal prose "Zoom link to come", so a URL format check '
  'would reject the real corpus. That value migrates unchanged and renders as '
  'PLAIN TEXT WITH NO href, because a link to nothing is worse than a note. '
  'New writes require a valid https URL, enforced by nextjs/lib/schema.ts and '
  'the migration 16 write functions rather than by a constraint here.';

comment on column public.events.image_asset_id is
  'Optional lead image, referencing assets.id. NULLABLE, and specifically so: '
  'only 3 of the 18 migrated entries carry an image, so NOT NULL would abort '
  'the canonical seed load on 15 rows. Contrast promoted.image_asset_id in '
  'migration 09, which IS not null because all 12 of its entries carry one -- '
  'confusing the two rules is a load failure. NO referential action by design: '
  'deleting an asset that any row still references is BLOCKED, and the editor '
  'answers a blocked delete by listing the referencing rows. Replacement is an '
  'atomic swap in one transaction, in migration 16.';

comment on column public.events.short_description is
  'The summary shown on event cards and used as the SEO description fallback. '
  'Required, per validate at events.yaml:104-105. NO LENGTH CHECK, despite the '
  'blueprint''s character_limit: 500 -- and this is the one table where a check '
  'would actually pass, since the corpus maximum is 448 characters. It is '
  'declined for consistency: across this schema, blueprint limits are enforced '
  'by nextjs/lib/schema.ts, the editor''s character counter and the migration '
  '16 write functions on create and edit, while the seed load is exempt so '
  'over-length legacy rows in other collections load grandfathered rather than '
  'aborting. Enforcing it here alone would make events the only collection '
  'where the 501st character fails as a database error instead of a character '
  'count.';

comment on column public.events.details is
  'The long-form event body, as a ProseMirror document. jsonb is correct here '
  'rather than a rule violation: the structure is a genuinely variable tree, '
  'not a named value hidden in json. CANONICAL SHAPE: the database stores the '
  'TIPTAP shape -- a single `doc` node with a `content` array -- because that '
  'is what the editor round-trips without transformation and what the renderer '
  'walks. Legacy Bard stored something different: for a standalone field like '
  'this one it is a BARE ARRAY of ProseMirror nodes with no wrapper, which was '
  'confirmed against all 4 populated entries. nextjs/lib/richtext.ts owns the '
  'one lossless conversion in both directions and a round-trip test covers '
  'events.details across all 18 entries. The permitted node and mark set comes '
  'from this field''s own Bard buttons (events.yaml:112-122): h2, h3, bold, '
  'italic, unorderedlist, orderedlist, removeformat, anchor, image, table. '
  'This is the only Bard field in the corpus exposing h2 and one of two '
  'exposing image, and it has no section-list alternative -- which is why '
  '@tiptap/extension-image is a required dependency and the image node is '
  'enabled but RE-ATTRIBUTED to assetId plus alt with no src at all, so no '
  'arbitrary or external URL can enter a document. Nothing in this DDL '
  'enforces any of that; nextjs/lib/richtext-validate.ts does, and the '
  'editor''s StarterKit config is derived from the same allowlist so the two '
  'cannot drift.';

comment on column public.events.calendar_link is
  'An "add to calendar" URL. PRESERVED VERBATIM WHERE POPULATED AND NEVER '
  'REGENERATED: 4 of the 18 entries carry a hand-built Google Calendar '
  'action=TEMPLATE URL pointing at the school''s real calendar, and '
  'regenerating one would discard a curated link. Where this column is null '
  'the target composes a link from event_date, the times and the timezone '
  'contract in nextjs/lib/timezone.ts. Nullable and unconstrained, for the '
  'same reason as zoom_link.';

comment on column public.events.published is
  'Publish state, and THE WHOLE OF PUBLIC VISIBILITY for this table. Default '
  'false because a load error must never publish content. Enforced server-side '
  'by the migration 17 policies, not by filtering after the fetch: a draft is '
  'not returned at all. COUNT DISCREPANCY, recorded here because content/ is '
  'deleted after cutover and this is the last durable place to note it: the '
  'source corpus holds 15 entries with an explicit `published: false` and 3 '
  'with no published key at all (boston-area-school-fair, festival-of-lights, '
  'open-house), and absence of the key means published -- so the measured '
  'split is 15 drafts and 3 public. The technical specification states 16 '
  'drafts and 2 public for this collection. The difference does not affect '
  'this column or any other part of this table, but supabase/seed.sql, '
  'artifacts/route-manifest.json and artifacts/parity-report.json all carry '
  'that tally and should reconcile against the entries rather than against '
  'the prose.';

comment on column public.events.seo_title is
  'Per-route SEO title override. Net-new -- no legacy route carries one -- and '
  'null means "use the generateMetadata fallback", which for an event is '
  '<title> · Events · Cambridge-Ellis School.';

comment on column public.events.seo_description is
  'Per-route meta description override. Net-new; the legacy site has no meta '
  'description on any route. Null means "use the fallback", which for an event '
  'composes date, time and location through the America/New_York contract and '
  'then the short_description.';

comment on column public.events.og_image_id is
  'Per-route Open Graph image override, referencing assets.id. THIS IS THE '
  'COLUMN''S NAME everywhere in the plan -- not og_image, not og_image_asset_id '
  '-- because a metadata function and a migration disagreeing about it is '
  'exactly how the tag silently stops rendering. Null falls back to '
  'image_asset_id and then to the shared app/opengraph-image.tsx. NO '
  'referential action, same blocked-delete contract as image_asset_id.';

comment on column public.events.legacy is
  'Every source key that no target column claims, retained verbatim so nothing '
  'in the corpus is discarded and a later decision to normalize one is a '
  'migration rather than a re-extraction. For this table that is '
  'duplicated_from, a Statamic system key with no target meaning, present on 1 '
  'entry (fall-growth-conferences). Queryable jsonb rather than a dropped '
  'value: tools/src/verify-parity.ts asserts against the live schema that '
  'every source key is either mapped to a column or present here. Defaults to '
  'an empty object, never null, so a reader never has to distinguish "no '
  'undeclared keys" from "not populated".';

comment on column public.events.source_updated_at is
  'The entry''s own updated_at from the source front matter, held verbatim. '
  'Separate from the operational updated_at below because defaulting the '
  'target column to load time would destroy the real editing history of all 18 '
  'entries. Never written by a target edit.';

comment on column public.events.source_updated_by is
  'The entry''s own updated_by, resolved to an email address: '
  '1179db75-8eeb-4bad-8e60-d5005aef7ef8 is bekah@cambridge-ellis.org and '
  'b863e707-3140-4001-859f-3487e09c5881 is conrad.fulbrook@gmail.com. Any '
  'other value is held verbatim rather than guessed at. Text, not a reference '
  'to auth.users: the source users are not target accounts, and history must '
  'survive an account being removed.';

comment on column public.events.created_at is
  'When this row was written to the target database. An operational timestamp, '
  'not migrated provenance -- see source_updated_at for that.';

comment on column public.events.updated_at is
  'Maintained exclusively by the set_events_updated_at trigger. No application '
  'code and no write function may set this column.';


-- -----------------------------------------------------------------------------
-- Two notes for whoever touches this table next
-- -----------------------------------------------------------------------------
-- THERE IS NO sort_order COLUMN, AND THAT IS DELIBERATE.
--
-- `events` is not manually orderable. Its public order is event_date ascending,
-- then title, then slug -- derived from sort_dir: asc in
-- content/collections/events.yaml and the legacy template's
-- sort="event_date:asc". There is no `sort_by` key in that config and there was
-- never a manual order to migrate. Adding a sort_order column would promise a
-- drag-to-reorder control with nothing behind it, and the collection management
-- surface deliberately does not offer one for this collection. The tables that
-- DO carry sort_order -- pages, people, classrooms, promoted and the child
-- tables -- carry it because a human genuinely chooses their order.
--
-- date_behavior IS INERT IN THE SOURCE AND IS DELIBERATELY NOT REPRODUCED.
--
-- content/collections/events.yaml sets `date_behavior: {past: public, future:
-- private}`, and it has no effect whatsoever. The collection is not declared
-- `dated`, and no entry carries an entry-level `date:` key -- event_date is an
-- ordinary blueprint field. All six non-pages collection configs carry the same
-- inert block. Runtime confirms it: /events/open-house returns 200 while the
-- unpublished /events/story-slam returns 404, and open-house is FUTURE-dated.
--
-- So publish state alone governs visibility, in the legacy site and in the
-- target. Do not add a check constraint, a policy predicate, a generated
-- column, a view filter or a partial index that treats a future event_date as
-- private. It would hide the school's entire upcoming calendar -- which is the
-- only part of this table a prospective parent has any reason to read -- and it
-- would do so while looking like faithful migration. A test asserts that a
-- future-dated published event stays publicly visible, precisely so this
-- setting cannot be reintroduced by a well-meaning author reading the source
-- config without also reading this note.
-- =============================================================================
