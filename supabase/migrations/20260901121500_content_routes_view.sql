-- =============================================================================
-- Cambridge-Ellis School  ·  migration 15 of 18  ·  the content_routes view
-- =============================================================================
-- Creates the schema's ONE view, and nothing else: no table, no function, no
-- policy, no index, no seed row, no redirect table and no path-rewriting logic.
--
-- It sits at 15 rather than earlier for the same dependency reason person_roles
-- sits with people in migration 06: a view is validated against its base
-- relations at create time, so all four routed tables must already exist.
--
--   public.pages       migration 04   precedence 1
--   public.classrooms  migration 08   precedence 2
--   public.people      migration 06   precedence 3
--   public.events      migration 07   precedence 4
--
-- This file is small and it is the keystone. Two mistakes are available in it
-- and both are silent: get the column list wrong and a draft's PATH leaks
-- through routing, get security_invoker wrong and the draft ROWS leak. Sections
-- 1.2 and 1.3 below exist to make both impossible to introduce by accident.
--
--
-- WHAT THIS VIEW IS FOR
--
-- Statamic resolved every content URL through a single router, fed by the four
-- collection route patterns quoted in section 1.6. The target reproduces that
-- single-router behaviour in exactly one place, which is what preserves all 142
-- content paths BY CONSTRUCTION rather than by a redirect layer -- and no
-- redirect is introduced anywhere in this project. The eleven Bard link
-- rewrites performed at extraction change a link's FORM, never its destination,
-- so they need none either.
--
-- Two consumers, and only these two, resolve a path through this view:
-- nextjs/app/(site)/(pages)/[...slug]/page.tsx does exactly one lookup per
-- request, and nextjs/app/sitemap.ts reads it filtered to published rows.
--
-- The 142 paths, stated here because content/ is deleted on this branch and
-- this file is now one of the few durable records of the arithmetic: of the 163
-- source entries, 142 belong to the four ROUTABLE collections -- pages 34,
-- people 77, events 18, classrooms 13. Of those 142, 102 resolve publicly and
-- 40 return 404 because their entry is a draft. Once supabase/seed.sql has
-- loaded, this view therefore holds 142 rows, of which an anonymous caller can
-- see 102.
--
-- announcements, promoted and inspiring_quotes declare NO route pattern. They
-- render as components of other pages, contribute nothing here, and must never
-- be added as a fifth branch. Migrations 09 and 10 state that from their own
-- side rather than leaving it to this file
-- (20260901120900_promoted.sql:78, 20260901121000_announcements_quotes.sql:105).
--
--
-- FOUR ENFORCEMENT POINTS FOR ROUTE UNIQUENESS -- THIS FILE OWNS THE THIRD
--
-- Uniqueness cannot rest on a per-table constraint, because the four routed
-- tables can each hold the same path and a UNION view has no constraint of its
-- own. It cannot rest on a bare existence check either: two transactions
-- inserting one path into two DIFFERENT tables would both pass and both commit.
-- So there are four points, and this file is one of them:
--
--   1. At load.      supabase/seed.sql ends, inside its own transaction, with a
--                    per-path count check that aborts the load on any
--                    duplicate.
--   2. At mutation.  assert_route_available(path, exclude_kind, exclude_id) in
--                    migration 16, whose FIRST act is
--                    pg_advisory_xact_lock(hashtext('route:' || path)) so two
--                    concurrent mutations targeting one path serialize even
--                    when they touch different tables.
--   3. At read.      >>> THIS FILE. <<< The deterministic `precedence` integer
--                    below. The route handler selects
--                    `order by precedence limit 1`, so behaviour is DEFINED
--                    even under an unexpected duplicate instead of being
--                    whichever row the planner happened to emit first.
--   4. In CI.        The db-and-parity job asserts one row per path after
--                    `supabase db reset`.
--
-- Point 3 is a fallback, not a licence: it makes an unexpected duplicate
-- harmless to resolve, and points 1, 2 and 4 are what stop one existing.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO, because another file owns it
--
--   policies         migration 17. RLS is already ENABLED on all four base
--                    tables with ZERO policies (04:322, 06:237, 07:260,
--                    08:345), which is the least-privilege order rather than an
--                    oversight: the tables are closed from the moment they
--                    exist and are opened deliberately, once, in one reviewable
--                    place. Under section 1.2's security_invoker that means
--                    this view returns nothing to anon or authenticated until
--                    17 applies -- correct, and the reason the view needs no
--                    predicate of its own.
--   write functions  migration 16, which owns assert_route_available() and
--                    reparent_page(). Rewriting a page's path and every
--                    descendant's, under one change_set_id, happens there; this
--                    view only reads whatever pages.path currently holds.
--   an index         A VIEW CANNOT BE INDEXED, so there is nothing to add here
--                    -- and this file adds no index to a base table either,
--                    because those belong to the migrations that own them. All
--                    four routed columns ARE already unique-indexed, verified
--                    rather than assumed: pages.path inline unique (04:127),
--                    events.slug inline unique (07:108), constraint
--                    people_slug_key unique (slug) (06:211), constraint
--                    classrooms_slug_key unique (slug) (08:314). What those
--                    indexes actually buy THIS lookup is measured in section
--                    1.7 rather than asserted, and the honest answer is "one
--                    branch of four" -- with the reason that is nonetheless the
--                    correct outcome for this corpus.
--   seed rows        supabase/seed.sql is the canonical load. A view holds no
--                    rows of its own and this file inserts nothing.
--
-- NOT APPLICABLE HERE, and deliberately absent rather than forgotten: uuid
-- defaults, the timezone('utc', now()) timestamp form, the set_updated_at
-- trigger and jsonb. A view declares no storage, so none of migration 01's
-- storage conventions has anything to attach to. The one convention from
-- 20260901120100_extensions.sql that DOES bind here is `case`: all SQL in these
-- eighteen files is lowercase.
--
-- PostgreSQL 17, pinned by supabase/config.toml [db] major_version. Every
-- statement below is idempotent, so applying all eighteen migrations twice is
-- clean.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. public.content_routes
-- -----------------------------------------------------------------------------

-- 1.1 Idempotency: a GUARDED DROP, not `create or replace view`.
--
-- Both forms are re-appliable, and the guarded drop is chosen on purpose.
-- `create or replace view` cannot change a column list: PostgreSQL permits it
-- only to ADD columns at the end, and refuses outright to rename, reorder,
-- retype or remove one. The column list here is a four-item SECURITY boundary
-- (section 1.3) that a later reviewer may well need to correct, and with
-- `create or replace` that correction would fail on the second apply with
-- `cannot change name of view column` -- exactly the class of breakage the
-- twice-clean rule exists to catch. `drop view if exists` followed by
-- `create view` is unconditionally re-appliable whatever the column list does.
--
-- The drop is safe to make unconditional because nothing depends on this view:
-- it is a leaf. Migrations 16, 17 and 18 create functions, policies and buckets
-- and none of them selects from it; the two TypeScript consumers named in the
-- header query it over the wire. Were a later migration ever to build a view on
-- top of this one, that dependency would have to be dropped and recreated with
-- it, and `drop view` without `cascade` is what makes such a mistake fail loudly
-- here rather than silently discard the dependent object. No `cascade`.

drop view if exists public.content_routes;


-- 1.2 `with (security_invoker = true)` -- one line, enormous blast radius.
--
-- A PostgreSQL view executes with the privileges of its OWNER by default, and
-- the owner of everything in this migration set is postgres. Without this
-- option the view would read the four base tables as postgres, which owns them
-- and is therefore not subject to their row-level security at all -- so an
-- anonymous request through the view would return EVERY row, including all 40
-- draft paths that migration 17's policies exist to hide. The view would become
-- a hole straight through RLS, and nothing about the query would look wrong.
--
-- With the option set, the base-table policies are evaluated under the CALLER's
-- identity. anon sees only `published = true`, so a draft path is not returned
-- at all and nextjs renders not-found; an authenticated editor with active
-- membership and AAL2 sees the draft and can preview it. That is the entire
-- draft-isolation property, delegated to one place instead of restated here.
--
-- Being explicit is required, not stylistic: the option is off by default, so
-- omitting it and setting it to false are the same insecure outcome.
--
-- Note for anyone auditing privileges: under security_invoker the caller needs
-- `select` on the BASE TABLES as well as on the view. Supabase's default
-- privileges in schema public supply that for anon and authenticated, and RLS
-- then decides which rows come back. Section 3 grants the view itself.
--
-- Requires PostgreSQL 15 or later. This project is pinned to 17.

create view public.content_routes
  with (security_invoker = true)
as

  -- 1.3 THE COLUMN LIST IS EXACTLY FOUR, AND THAT IS A SECURITY DECISION.
  --
  -- path, kind, id, precedence. No title, no published, no slug, no template,
  -- no created_at/updated_at, no seo_* and no og_image_id.
  --
  -- The reason is not minimalism or taste: it is so that a draft's path is
  -- never disclosed through routing, and so that this view cannot be used as a
  -- content reader. Those are two distinct hazards. Even with security_invoker
  -- on -- which already stops draft ROWS being returned -- a wider column list
  -- would invite callers to read content through the router, and would invite a
  -- future author to relax a policy "just for the view" to make some column
  -- they added resolve. Four columns is the smallest set that answers the only
  -- question routing asks: given this path, which row renders it?
  --
  -- Everything else about the row is read afterwards by the typed readers in
  -- nextjs/lib/content/*, under the same RLS, using the id this view returned.
  -- The underlying policies decide readability; an unreadable target renders
  -- not-found.
  --
  -- ADDING A FIFTH COLUMN HERE IS A SECURITY CHANGE, NOT A CONVENIENCE.
  --
  --
  -- 1.4 `union all`, NOT `union`.
  --
  -- `union` deduplicates, and deduplication would silently hide precisely the
  -- condition enforcement point 4 exists to detect: two rows claiming one path.
  -- CI asserts one row per path by grouping over this view, and a deduplicating
  -- union would make that assertion vacuously true forever. `union all` also
  -- avoids a pointless sort over all 142 rows on every lookup.
  --
  --
  -- 1.5 THERE IS NO `where published = true` FILTER, DELIBERATELY.
  --
  -- Publish filtering is RLS's job and is enforced server-side under
  -- security_invoker. A predicate here would restate migration 17's policy in a
  -- second place that can drift from it -- and, worse, it would break the
  -- authenticated editor previewing a draft, who legitimately needs that path
  -- to resolve. One rule, one owner. nextjs/app/sitemap.ts filters to published
  -- rows for its own purposes; that is a consumer's choice, not this view's.
  --
  --
  -- 1.6 The four branches, in precedence order.
  --
  -- The precedence order is FIXED and is not this file's to choose: pages 1,
  -- classrooms 2, people 3, events 4. It is stated identically in the plan and
  -- corroborated by the base-table migrations themselves
  -- (04:403 "precedence 1, the highest"; 08:68 and 08:752 "classrooms are 2
  -- (pages 1, classrooms 2, people 3, events 4)"), and the route handler
  -- depends on it.
  --
  -- Why pages outrank the rest: two namespaces are SHARED by two collections
  -- each. /programs/{slug} is claimed by the umbrella pages AND by classroom
  -- entries; /community/{slug} by landing pages AND by 77 staff bios. All 142
  -- derived paths are unique today, so these are OVERLAPPING NAMESPACES and not
  -- collisions -- but nothing in the flat files enforced that. Pages hold the
  -- hand-authored landing pages a visitor reaches from the menu, so if a
  -- duplicate ever did appear the page is the row that should win.
  --
  -- Every branch selects the same four columns in the same order, with `kind`
  -- and `precedence` cast explicitly so the view's column types are text and
  -- integer rather than left to literal-type resolution. That matters because
  -- `supabase gen types typescript` reads these types into
  -- nextjs/types/database.ts.

  -- pages, precedence 1.
  --
  -- pages.path is used VERBATIM. It is already materialized -- migration 04
  -- built it from content/trees/collections/pages.yaml, which is what the
  -- legacy site actually resolved from -- and its own comment records that it
  -- is byte-identical to the legacy URL. So this branch performs NO derivation
  -- whatsoever, which is the point: no second implementation of
  -- route '{parent_uri}/{slug}' exists to disagree with the first.
  --
  -- It is also why home is '/' and not '/home': content/collections/pages.yaml
  -- sets structure.root = true, so the root page contributes no slug segment.
  -- Home's slug is still 'home'; only its path is '/'. Deriving this branch
  -- from slug would have got that one row wrong.
  select
    p.path                        as path,
    'page'::text                  as kind,
    p.id                          as id,
    1::integer                    as precedence
  from public.pages as p

  union all

  -- classrooms, precedence 2.
  --
  -- THIS IS THE ONE BRANCH THAT NORMALIZES ITS SOURCE ROUTE.
  -- content/collections/classrooms.yaml:5 declares route: 'programs/{slug}' --
  -- written WITHOUT a leading slash, alone among the four collections. Emitting
  -- it as written would produce the relative path 'programs/blue-room' where
  -- every other row is absolute, and the catch-all would never match it.
  -- Migrations 04 and 08 both delegate this repair here by name
  -- (08:186-189 "the normalization of the leading-slash quirk belongs there"),
  -- so it is performed once, in this expression, and nowhere else.
  --
  -- slug is `not null` on all three concatenating branches, so `'/x/' || slug`
  -- can never yield null.
  select
    '/programs/' || c.slug        as path,
    'classroom'::text             as kind,
    c.id                          as id,
    2::integer                    as precedence
  from public.classrooms as c

  union all

  -- people, precedence 3. route '/community/{slug}', already absolute.
  -- 77 bios, the largest branch. people_slug_key is what keeps
  -- /community/<slug> resolving to one person (06:207-211).
  select
    '/community/' || pe.slug      as path,
    'person'::text                as kind,
    pe.id                         as id,
    3::integer                    as precedence
  from public.people as pe

  union all

  -- events, precedence 4. route '/events/{slug}', already absolute.
  --
  -- The source collection also declares date_behavior {past: public, future:
  -- private}. It is INERT -- the collection is not `dated` and no entry carries
  -- an entry-level date key -- and migration 07 deliberately does not reproduce
  -- it. Publish state ALONE governs visibility, so there is no date predicate
  -- here and must never be one: a future-dated published event is publicly
  -- visible, in the legacy site and here.
  select
    '/events/' || e.slug          as path,
    'event'::text                 as kind,
    e.id                          as id,
    4::integer                    as precedence
  from public.events as e;


-- -----------------------------------------------------------------------------
-- 1.7 The query plan, measured rather than assumed
-- -----------------------------------------------------------------------------
-- `explain` on the handler's real query
--
--   select kind, id from public.content_routes where path = $1
--   order by precedence limit 1
--
-- shows the predicate PUSHED DOWN into all four branches -- the Filter sits
-- inside each scan, not above the Append -- so a lookup never materializes four
-- tables and filters afterwards. That is the property that matters and it holds.
--
-- Index usage is more nuanced, and the overclaim is worth writing down so the
-- next reader does not have to rediscover it. Measured on the local stack with
-- 20,000 rows loaded into each of pages, classrooms and events and the tables
-- analyzed -- far past any size at which the planner would ignore a usable
-- index:
--
--   pages       ->  Index Scan using pages_path_key
--                     Index Cond: (path = $1)
--   classrooms  ->  Seq Scan, Filter: (('/programs/' || slug) = $1)
--   people      ->  Seq Scan, Filter: (('/community/' || slug) = $1)
--   events      ->  Seq Scan, Filter: (('/events/' || slug) = $1)
--
-- Only the pages branch reaches its index, because only there is the predicate
-- a direct column comparison. In the other three the view derives the path by
-- concatenation, and PostgreSQL will not invert `'/prefix/' || slug = $1` into
-- `slug = <suffix of $1>`; the plain unique index on `slug` is therefore
-- unusable THROUGH THIS VIEW. Proven by contrast in the same session: the same
-- predicate written against the bare column, `where slug = 'c123'`, plans as
-- `Index Scan using classrooms_slug_key`.
--
-- This is deliberately left as it is, for three reasons.
--
--   1. At the real corpus size a sequential scan is the OPTIMAL plan, not a
--      regression. The four routed tables hold 142 rows between them and the
--      largest is people at 77. Scanning 77 rows is cheaper than descending an
--      index, which is exactly why the planner chooses it; an index here would
--      be built, maintained and then ignored.
--   2. The alternatives are all worse. Expression indexes -- e.g. on
--      (('/programs/' || slug)) -- would fix it, but they belong to the
--      migrations that own those tables (04, 06, 07, 08), not to a view
--      migration reaching across into them, and they would be dead weight at
--      142 rows. A materialized view would make the whole thing index-able and
--      is ruled out on its own merits below. Storing a materialized `path`
--      column on all four tables would duplicate pages.path's design onto three
--      tables that do not need it and would need a trigger per table to stay
--      true.
--   3. If this site ever did grow by orders of magnitude, the fix is additive
--      and local: add an expression index to the base-table migration that owns
--      each slug, change nothing in this file, and re-run this same `explain`.
--
-- So the claim this file makes is the narrow true one: the predicate is pushed
-- down, pages resolves by unique index, and the other three resolve by a scan
-- that is correct at this scale. Nothing here depends on all four using an
-- index.
--
--
-- -----------------------------------------------------------------------------
-- 2. The `kind` vocabulary — a binding contract, fixed here
-- -----------------------------------------------------------------------------
-- THE FOUR VALUES ARE SINGULAR:  'page'  'classroom'  'person'  'event'
--
-- This file is where that vocabulary is established, so it is written down here
-- rather than left to be inferred from the branches above. Three separate
-- consumers must use this EXACT set, and a mismatch in any of them is a silent
-- routing failure rather than a compile error:
--
--   * nextjs/lib/content/* and the [...slug] catch-all, which switch on `kind`
--     to choose a presenter. An unrecognized value renders not-found.
--   * assert_route_available(path, exclude_kind, exclude_id) in migration 16.
--     Its exclude_kind argument is compared against these values to let a row
--     keep its own path while editing; a plural on one side would make the
--     exclusion never match, and every slug edit would then be rejected as a
--     self-collision.
--   * nextjs/types/database.ts, generated by `supabase gen types typescript`.
--
-- Why singular rather than the plural table names:
--
--   1. `kind` describes what ONE ROW IS. A row is a page; it is not "pages".
--      The plural would name the row's collection, which is a different fact
--      and one this view does not carry.
--   2. It removes the people/person irregular plural, which is the single most
--      likely place for the two sides of a comparison to drift apart. There is
--      no plausible way to mistype 'person' as 'persons' and have it look
--      right, whereas 'people' invites exactly that.
--   3. It stays VISIBLY DISTINCT from content_revisions.table_name, which is
--      the plural LOGICAL TABLE name of a changed row (migration 14, and
--      deliberately unconstrained there). Those are different concepts --
--      a routing discriminator and an audit target -- and using the plural in
--      both would invite a future author to pass one where the other belongs.
--
-- The set is closed. A fifth value would mean a fifth routable collection,
-- which would mean a fifth branch above, which the header forbids.
--
-- There is no check constraint enforcing this, because a view cannot carry one:
-- the values are literals in the branches above and are therefore already
-- exhaustive by construction. That is stronger than a constraint, not weaker.


-- -----------------------------------------------------------------------------
-- 3. Privileges
-- -----------------------------------------------------------------------------
-- Least privilege, stated rather than inherited -- the same posture migration
-- 13 takes for its function grants (20260901121300_admin_roles.sql:497).
--
-- A REVOKE IS REQUIRED FIRST, AND IT IS THE PART THAT IS EASY TO MISS.
-- Verified against the local stack rather than assumed, because the default
-- here is emphatically not the plain PostgreSQL default. Supabase ships
--
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role
--
-- and `pg_default_acl` records it for object type `r` as
-- `anon=arwdDxtm/postgres`. A VIEW IS A RELATION, so this view is created with
-- that default already applied: measured immediately after creation, its acl
-- was
--
--   {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--    authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--
-- -- that is anon and authenticated holding insert, update, delete AND truncate
-- on route resolution, without a single grant being written anywhere. Writing
-- only `grant select` would therefore have changed nothing and left this file
-- documenting a privilege set it did not actually have. This is the same trap
-- migration 13 documents for functions, where it also notes that a
-- `revoke ... from public` cannot remove it, because PUBLIC and anon are
-- different grantees. Both revokes are present below for that reason: the
-- `from public` form is what holds the line on any database that does NOT carry
-- Supabase's defaults, and the role-specific form is what removes the direct
-- grants on one that does. Both are idempotent, so a second apply is clean.
--
-- Nothing available today exploits those privileges -- a `union all` view is
-- not auto-updatable, so a write against it fails on that ground irrespective
-- of the acl -- information_schema.tables reports is_insertable_into = NO for
-- this view, and relkind is `v`, both verified on the local stack. The
-- revoke is here because that is a property of the CURRENT query, not a
-- guarantee: an `instead of` trigger, or a future simplification to a single
-- branch, would make the inherited privileges live DML on route resolution
-- without anyone editing this grant block. Route changes must go through
-- migration 16's write functions -- update_slug and reparent_page -- which take
-- the advisory lock and write revision rows under a change_set_id. A writable
-- route view would bypass both, so the privilege is removed rather than left
-- resting on the query shape.
--
-- `select` is then granted back, and granting it is SAFE HERE only because of
-- section 1.2. The grant lets a role reach the view; the base tables' RLS,
-- evaluated under that same role thanks to security_invoker, decides which rows
-- come back. Without security_invoker this grant would be the second half of a
-- draft leak.
--
-- service_role is included on migration 13's stated reasoning: it is
-- privilege-checked for access like any other role despite bypassing RLS, and
-- the migration tooling runs as it. tools/src/verify-parity.ts reads this view
-- to assert all 142 paths resolve, and CI's db-and-parity job reads it for the
-- one-row-per-path assertion (enforcement points 1 and 4). Both would fail with
-- permission denied without it.
--
-- The owner (postgres) is deliberately not revoked from: it needs full rights
-- to replace the view on the next apply.

revoke all on public.content_routes from public;
revoke all on public.content_routes from anon, authenticated, service_role;

grant select on public.content_routes to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. Durable documentation
-- -----------------------------------------------------------------------------
-- content/ is deleted at the end of the migration phase -- on this branch it is
-- already gone -- so after cutover the database itself is the only place a
-- reader can learn why this view exists and what its values mean. A schema dump
-- keeps these comments and drops every block comment above, which is why the
-- load-bearing reasoning is restated here rather than only in section 1.

comment on view public.content_routes is
  'THE ROUTE RESOLVER. Reproduces Statamic''s single-router behaviour over the '
  'four routable collections, which is what preserves all 142 legacy content '
  'paths BY CONSTRUCTION -- no redirect layer exists anywhere in this project. '
  'A `union all` (never `union`: deduplication would hide the very duplicate '
  'condition CI checks for) over pages, classrooms, people and events. Once '
  'supabase/seed.sql has loaded it holds 142 rows -- pages 34, people 77, '
  'events 18, classrooms 13 -- of which an anonymous caller sees 102, the other '
  '40 being drafts. announcements, promoted and inspiring_quotes declare no '
  'route pattern, contribute nothing, and must never be added. '
  'SECURITY: created `with (security_invoker = true)`, so the base tables'' RLS '
  'is evaluated under the CALLER''s identity, not the postgres owner''s. '
  'Without that option the view would read as its owner, bypass RLS entirely '
  'and return all 40 draft paths to anonymous visitors -- it is off by default, '
  'so omitting it and setting it false are the same insecure outcome. '
  'The column list is EXACTLY four (path, kind, id, precedence) as a SECURITY '
  'decision and not a stylistic one: no title, published, slug, template, '
  'timestamp or seo_* column, so a draft''s path is never disclosed through '
  'routing and the view cannot be used as a content reader. Adding a fifth '
  'column is a security change. There is deliberately NO `where published` '
  'predicate: publish filtering belongs to migration 17''s policies, and '
  'duplicating it here would both drift from them and break an authenticated '
  'editor previewing a draft, who legitimately needs the path to resolve. '
  'This view is one of FOUR enforcement points for route uniqueness and owns '
  'the third -- (1) a terminal per-path count check inside seed.sql''s own '
  'transaction; (2) assert_route_available() in migration 16, whose first act '
  'is pg_advisory_xact_lock(hashtext(''route:'' || path)) so two mutations on '
  'one path serialize even across different tables; (3) THIS view''s '
  'deterministic `precedence` integer, which the route handler consumes as '
  '`order by precedence limit 1` so behaviour stays defined even under an '
  'unexpected duplicate; (4) CI''s db-and-parity one-row-per-path assertion. '
  'Not materialized, deliberately: a materialized view would need refreshing '
  'on every content write, would not honour security_invoker, and would break '
  'read-your-writes after a field edit. It carries no index because a view '
  'cannot. On the query plan, measured rather than assumed: the path predicate '
  'is pushed down into all four branches, and the pages branch resolves by '
  'Index Scan on pages_path_key -- but the other three cannot use their slug '
  'indexes through this view, because PostgreSQL will not invert '
  '''/prefix/'' || slug = $1 into a bare slug comparison. That is correct at '
  'this scale rather than a defect: the four tables hold 142 rows between them '
  'and the largest is people at 77, so a scan beats an index descent and the '
  'planner is right to choose it. If the corpus ever grew, the fix is an '
  'expression index in each base table''s own migration, with no change here.';

comment on column public.content_routes.path is
  'The site-absolute content path, and the only column a caller filters on. '
  'For pages this is pages.path VERBATIM -- already materialized by migration '
  '04 from content/trees/collections/pages.yaml and byte-identical to the '
  'legacy URL -- so no second implementation of route ''{parent_uri}/{slug}'' '
  'exists here to disagree with it, and home is ''/'' rather than ''/home'' '
  'because content/collections/pages.yaml sets structure.root = true. The '
  'other three branches derive it from slug: ''/programs/'' || slug, '
  '''/community/'' || slug, ''/events/'' || slug. The classrooms branch is the '
  'one that NORMALIZES its source route, which is declared '
  '''programs/{slug}'' WITHOUT a leading slash -- alone among the four '
  'collections -- and would otherwise emit a relative path the catch-all could '
  'never match. Not unique in this view and cannot be made so: a view carries '
  'no constraint, and two namespaces are shared by two collections each '
  '(/programs/<slug> by umbrella pages and classrooms, /community/<slug> by '
  'landing pages and 77 bios). All 142 derived paths are unique today, making '
  'those OVERLAPPING NAMESPACES rather than collisions -- which is exactly why '
  '`precedence` exists.';

comment on column public.content_routes.kind is
  'Which collection renders this path, as a CLOSED set of four SINGULAR '
  'values: ''page'', ''classroom'', ''person'', ''event''. This view is where '
  'that vocabulary is fixed, and three consumers must use the identical set -- '
  'the [...slug] catch-all and nextjs/lib/content/* which switch on it to pick '
  'a presenter, assert_route_available(path, exclude_kind, exclude_id) in '
  'migration 16 which compares against it so a row may keep its own path while '
  'being edited, and nextjs/types/database.ts. A mismatch is a silent routing '
  'failure, not an error: a plural on one side of the exclude_kind comparison '
  'would make the exclusion never match and every slug edit would be rejected '
  'as a self-collision. Singular because `kind` says what ONE ROW IS -- a row '
  'is a page, not "pages" -- because it removes the people/person irregular '
  'plural that most invites drift, and because it stays visibly distinct from '
  'content_revisions.table_name, which is the plural logical TABLE name of a '
  'changed row and a different concept. Exhaustive by construction, since the '
  'values are literals in the four branches; a view can carry no check '
  'constraint and needs none.';

comment on column public.content_routes.id is
  'Primary key of the row that renders this path, in the table named by '
  '`kind`. The pair (kind, id) is what the route handler returns, and the typed '
  'readers in nextjs/lib/content/* then fetch the row itself under the same '
  'RLS. Deliberately NOT a foreign key and deliberately unaccompanied by any '
  'other column from that row -- see the view comment on why the column list '
  'is exactly four. Not unique across this view in principle, because two kinds '
  'could in theory hold one uuid; unique in practice because every id derives '
  'from public.ces_uuid(<table>, legacy_ref), which is scoped by table.';

comment on column public.content_routes.precedence is
  'The tie-breaker that makes route resolution DETERMINISTIC: pages 1, '
  'classrooms 2, people 3, events 4. Fixed by the plan and corroborated by the '
  'base-table migrations (20260901120400_pages.sql:403, '
  '20260901120800_classrooms.sql:68); NOT this view''s choice to change, '
  'because the route handler depends on the ordering. The handler selects '
  '`order by precedence limit 1`, so if two rows ever claimed one path the '
  'winner is defined rather than being whichever row the planner emitted '
  'first. Pages rank highest because they hold the hand-authored landing pages '
  'a visitor reaches from the menu, and because both shared namespaces '
  '(/programs, /community) pair a pages row with a collection row. This is '
  'enforcement point 3 of 4 and is a FALLBACK, not a licence: points 1, 2 and '
  '4 -- seed.sql''s terminal count check, migration 16''s advisory lock, and '
  'CI''s one-row-per-path assertion -- are what stop a duplicate existing at '
  'all.';
