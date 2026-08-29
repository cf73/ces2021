-- =============================================================================
-- Cambridge-Ellis School  ·  migration 17 of 18  ·  the policy set
-- =============================================================================
-- Every row level security policy in the schema, every table-level grant, and
-- the revocation of direct DML from the two application roles. Nothing else: no
-- table, no column, no index, no view, no function, no trigger, no seed row and
-- no Storage bucket or Storage policy -- migration 18 owns those.
--
-- It sits at 17 because it is the only file that references EVERY table, and
-- because its predicates call the membership helpers from migration 13 and
-- published_reference_count() from migration 16. Both must already exist.
--
-- All twenty-one tables arrive here with row level security ALREADY ENABLED and
-- ZERO policies, each in its own migration (02:220, 03:176, 04:322, 05:379,
-- 06:237, 06:414, 06:519, 07:260, 08:345, 08:579, 08:716, 09:265, 09:420,
-- 10:271, 10:403, 11:242, 12:332, 13:214, 13:724, 14:202, 14:485). That is the
-- least-privilege order rather than an oversight: every table is closed to anon
-- and to authenticated from the moment it exists, and is opened deliberately,
-- once, in this one reviewable place. Until this file applies, only the service
-- role -- which bypasses RLS, and which supabase/seed.sql loads as -- can reach
-- a single row. `force row level security` is set on nothing, deliberately: it
-- would subject the table owner to policies too, and the owner is exactly the
-- role migration 16's security definer write functions run as.
--
--
-- THE NAMING SCHEME: <table>_<role>_<operation>_<qualifier>
--
-- Applied to all thirty-eight policies without exception, so that
--
--   select tablename, policyname, roles, cmd, qual from pg_policies
--    where schemaname = 'public' order by tablename, policyname;
--
-- reads as the access matrix itself rather than as prose. <role> is the single
-- role in the policy's `to` clause -- anon or authenticated, never both, so that
-- one row of that output is one decision about one role. <qualifier> names the
-- predicate: `published`, `visible`, `public`, `own`, `member`, `edit`, `admin`,
-- `published_parent`, `published_parents`, `published_parent_enabled`,
-- `published_reference`, `role_terms`.
--
-- ONE CONVENTION IS WORTH STATING BECAUSE THE NAME UNDERSTATES THE PREDICATE.
-- Every `_authenticated_select_member` policy carries the anonymous predicate
-- OR active membership with aal2 -- not membership alone. That is what makes an
-- authenticated caller who is NOT a member see exactly what an anonymous
-- caller sees, instead of seeing nothing, and it is why none of those policies
-- is `using (true)`.
--
-- PERMISSIVE, NOT RESTRICTIVE. Postgres ORs permissive policies together, and
-- every policy here is permissive, so the two policies on a table are two
-- alternative grounds for reading a row. There is no restrictive policy in this
-- file: with `to anon` and `to authenticated` policies written separately, a
-- restrictive one would have to be repeated per role to avoid silently denying
-- the other, which is a worse failure than the redundancy it would remove.
--
--
-- >>> THE DML REVOCATION -- THE MOST IMPORTANT STATEMENT IN THIS FILE <<<
--
-- RLS ALONE IS NOT ENOUGH, and the hole is not hypothetical. An authenticated
-- bearer token can call PostgREST directly -- `PATCH /rest/v1/pages?id=eq...`
-- -- without going near the application. A permissive policy plus a live table
-- grant is a write path, and ENABLING RLS DOES NOT REVOKE THE GRANT.
--
-- Supabase's default privileges in schema `public` grant broadly, and this was
-- MEASURED on the local stack after migrations 01 to 16 rather than assumed.
-- pg_class.relacl on every one of the twenty-one tables reads:
--
--     anon=arwdDxtm/postgres   authenticated=arwdDxtm/postgres
--
-- That is a=insert, r=select, w=update, d=delete, D=TRUNCATE, x=REFERENCES,
-- t=TRIGGER and m=MAINTAIN (PostgreSQL 17). Revoking only insert, update and
-- delete would therefore leave anon holding TRUNCATE -- which BYPASSES ROW
-- LEVEL SECURITY ENTIRELY and empties a table without consulting a single
-- policy -- plus REFERENCES, TRIGGER and MAINTAIN.
--
-- So section 1.1 revokes ALL PRIVILEGES from `public`, `anon` and
-- `authenticated` on all twenty-one tables, and section 1.2 grants `select`
-- back where the matrix allows a read. `revoke all` names no privilege keyword
-- and therefore cannot miss one, now or when a future major adds another; the
-- end state is provably `select` and nothing else. `public` is in the grantee
-- list because a privilege held by PUBLIC is inherited implicitly and a revoke
-- from anon would not remove it.
--
-- SELECT IS RETAINED, because reads legitimately go through RLS: the policies
-- below are the read model, and a revoked select would replace a filtered read
-- with a 42501. WRITES DO NOT GO THROUGH RLS AT ALL. Every one of the thirty
-- commands goes through a security definer function in migration 16 that
-- re-checks session, active membership, assurance level and capability, applies
-- the mutation, writes content_revisions under one change_set_id, and rolls the
-- whole thing back if the audit insert fails. Those functions run as the table
-- owner, so they need no grant to `authenticated` on any table and are
-- unaffected by anything in section 1.
--
-- TO A FUTURE AUTHOR WHO SEES "we have RLS" AND RE-GRANTS: the grant is the
-- hole, not the policy. Nothing in this schema needs insert, update or delete
-- on a table to be held by anon or authenticated, and nothing ever will while
-- writes are function-mediated.
--
-- ONE CONSEQUENCE, DOCUMENTED RATHER THAN DISCOVERED: a direct REST PATCH is
-- rejected by the missing grant before any code of ours executes, so it
-- produces NO security_events ROW. That is the boundary migration 14 states
-- from its own side, and nextjs/tests/e2e/security.spec.ts asserts both halves
-- -- the rejection, and the absence of the row. Those rejections are visible in
-- Supabase's API and Postgres logs, which are the source of truth for that
-- class.
--
--
-- APPEND-ONLY IS PARTLY AN OMISSION, AND THE OMISSION IS DELIBERATE
--
-- content_revisions and security_events get a `select` policy each and NOTHING
-- ELSE. There is no insert policy (inserts come from migration 16's write
-- functions, which run as the owner and are not subject to RLS), no update
-- policy and no delete policy -- ON EITHER TABLE, ANYWHERE IN THIS FILE. With
-- RLS enabled, THE ABSENCE OF A POLICY IS THE DENIAL, and section 1.1 has
-- already removed the underlying grants, so the denial does not rest on the
-- omission alone.
--
-- No `using (false) with check (false)` deny policy is written for them either.
-- The reference implementation uses that form in
-- 20260128123000_tighten_newsletter_subscribers_policy.sql, and it is a
-- legitimate idiom where a permissive policy must be superseded -- but here it
-- would be belt-and-braces over two mechanisms that already deny, and migration
-- 14's header explicitly asks whoever writes this file not to add one "out of
-- habit or for symmetry with the content tables". Not written, on purpose.
-- `select count(*) from pg_policies where cmd in ('UPDATE','DELETE')` is 0 for
-- the whole schema, not just for those two tables.
--
--
-- THE RECURSION TRAP, NAMED SO IT CANNOT BE WALKED INTO
--
-- A policy ON admin_users that asks "is the caller an admin?" with a SUBQUERY
-- ON admin_users recurses: evaluating the subquery applies the same policy,
-- which evaluates the subquery. Postgres reports infinite recursion and every
-- read of the table fails -- including the reads the application needs to
-- render the editor. Section 7 therefore asks migration 13's
-- public.has_capability(), which is security definer and runs as the owner, so
-- its own read of admin_users is not subject to any policy. The own-row branch
-- is a bare column comparison against auth.uid() and touches no other table.
-- No policy in this file subqueries the table it is defined on.
--
--
-- WHAT IS CORRECTED FROM THE REFERENCE (fidelis3-main.zip, 209 members, 11 SQL)
--
-- Read for policy SHAPE only; nothing is copied. Its idioms that ARE carried:
-- `drop policy if exists` before `create policy`, and documenting objects in
-- the database itself. The eight weaknesses, each verified by reading the
-- member rather than inferred, and each corrected here:
--
--   1. `for select to authenticated using (true)` on contact_submissions and
--      newsletter_subscribers -- blanket read for every authenticated user.
--      CORRECTED: no policy here grants a role a literal-true read. Draft
--      visibility requires active membership AND aal2, and falls back to the
--      anonymous predicate otherwise.
--   2. `for insert to anon, authenticated with check (true)` on both -- an
--      anonymous write path. CORRECTED: THIS FILE CONTAINS NO INSERT POLICY,
--      on any table, for any role.
--   3. `for select using (true)` on site_business_info, a table with no
--      visibility column at all. CORRECTED: site_globals has a `public`
--      boolean, the four maintenance rows are `public = false`, and section 6
--      is a predicate on that column.
--   4. Zero `revoke` statements across all eleven members -- RLS trusted alone.
--      CORRECTED: section 1, which is the reason this file exists.
--   5. No security definer function and no pinned search_path anywhere.
--      CORRECTED upstream: migrations 13 and 16, whose functions this file
--      calls rather than reimplementing.
--   6. No `create trigger` -- updated_at defaulted on insert and never
--      maintained. CORRECTED upstream: migration 01's shared trigger.
--   7. jsonb for structured data that has a name (store_hours holding
--      {"label","value"} objects). CORRECTED upstream: typed columns.
--   8. No audit table of any kind, and ad-hoc prose policy names ("Allow
--      public inserts", "Only authenticated users can read", "Deny public
--      updates") with no per-role, per-operation matrix. CORRECTED: migration
--      14's two append-only tables, and the naming scheme above.
--
-- The reference also mixes UPPERCASE and lowercase SQL across files, and ships
-- supabase/functions/ and supabase/.temp/. This file is entirely lowercase and
-- supabase/migrations/ has no subdirectories.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
--   storage policies    migration 18, together with the three buckets and the
--                       media-trash prefix. Not one policy here touches
--                       storage.objects or storage.buckets.
--   an insert policy    nowhere, for the reason in weakness 2 above. In
--                       particular admin_users gets NONE: the first membership
--                       rows arrive under the SERVICE ROLE from
--                       tools/src/bootstrap-admins.ts, which bypasses RLS
--                       legitimately, and no self-service signup path exists.
--                       NO POLICY IS WEAKENED TO ALLOW A BOOTSTRAP INSERT.
--   a policy on a view  content_routes is a VIEW. PostgreSQL has no row level
--                       security on views; `alter view ... enable row level
--                       security` is not valid syntax. Migration 15 created it
--                       `with (security_invoker = true)`, so the base-table
--                       policies below decide what it returns -- 102 paths for
--                       anon, 142 for a member -- and section 10 states that
--                       its grant already exists rather than restating it.
--   a date predicate    NOTHING here hides a future-dated event.
--                       content/collections/events.yaml:8-10 set
--                       `date_behavior: past: public, future: private`, but the
--                       collection is not `dated` and no entry carried an
--                       entry-level `date:` key, so the setting was INERT: the
--                       legacy runtime served /events/open-house 200 while the
--                       unpublished /events/story-slam returned 404. Publish
--                       state alone governs visibility, and migrations 07 and
--                       09 say so from their own side.
--   a new object        no table, no function, no bucket, no index, no seed row.
--
--
-- IDEMPOTENCY. `create policy` has no `if not exists` form, so EVERY create is
-- preceded by `drop policy if exists`. Without that guard the second apply of
-- the eighteen fails outright -- this is the file most able to break the
-- twice-clean rule. `revoke` and `grant` are naturally idempotent. Applying all
-- eighteen migrations twice is therefore clean, and `supabase db reset` run
-- twice yields an identical pg_policies output.
--
-- No user-specified rules were provided for this project -- review_rules
-- returns none. Enterprise-standard practice is applied and not relaxed: least
-- privilege on every grant, an append-only audit trail, no bootstrap
-- concession, full idempotency, and every non-obvious decision documented in
-- the database itself with `comment on policy`.
--
-- PostgreSQL 17, per supabase/config.toml [db] major_version. All SQL
-- lowercase. Section 11 carries the queries that verify each claim above.
-- =============================================================================


-- =============================================================================
-- 1. Table-level privileges
-- =============================================================================
-- Read the two sub-sections together: 1.1 removes everything, 1.2 puts back the
-- one privilege the matrix allows. Splitting them by direction rather than
-- interleaving them per table is what makes the highest-value assertion in this
-- file a single readable block -- after 1.1 there is no path by which any table
-- here can be written by anon or authenticated, and 1.2 cannot reintroduce one
-- because `select` is the only privilege it names.
--
-- service_role is deliberately absent from every statement in this section. It
-- keeps its default privileges and bypasses RLS, which is what the canonical
-- seed load, tools/src/upload-assets.ts, tools/src/bootstrap-admins.ts, the
-- readiness write and the nightly cleanup sweep all depend on.


-- -----------------------------------------------------------------------------
-- 1.1 Revoke everything from public, anon and authenticated
-- -----------------------------------------------------------------------------
-- Twenty-one statements, one per table, in migration order. This removes
-- insert, update and delete -- the three verbs PostgREST exposes -- and with
-- them truncate, references, trigger and PostgreSQL 17's maintain, all four of
-- which the measured default ACL `arwdDxtm` also granted. See the header for
-- why `revoke all privileges` is the right form rather than a verb list.

revoke all privileges on table public.assets             from public, anon, authenticated;
revoke all privileges on table public.taxonomy_terms     from public, anon, authenticated;
revoke all privileges on table public.pages              from public, anon, authenticated;
revoke all privileges on table public.page_sections      from public, anon, authenticated;
revoke all privileges on table public.people             from public, anon, authenticated;
revoke all privileges on table public.person_education   from public, anon, authenticated;
revoke all privileges on table public.person_roles       from public, anon, authenticated;
revoke all privileges on table public.events             from public, anon, authenticated;
revoke all privileges on table public.classrooms         from public, anon, authenticated;
revoke all privileges on table public.classroom_teachers from public, anon, authenticated;
revoke all privileges on table public.page_classrooms    from public, anon, authenticated;
revoke all privileges on table public.promoted           from public, anon, authenticated;
revoke all privileges on table public.promoted_links     from public, anon, authenticated;
revoke all privileges on table public.announcements      from public, anon, authenticated;
revoke all privileges on table public.inspiring_quotes   from public, anon, authenticated;
revoke all privileges on table public.site_globals       from public, anon, authenticated;
revoke all privileges on table public.nav_items          from public, anon, authenticated;
revoke all privileges on table public.admin_users        from public, anon, authenticated;
revoke all privileges on table public.content_revisions  from public, anon, authenticated;
revoke all privileges on table public.security_events    from public, anon, authenticated;
revoke all privileges on table public.site_readiness     from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 1.2 Grant select back, exactly where the matrix allows a read
-- -----------------------------------------------------------------------------
-- Seventeen tables readable by both roles, three by authenticated only, one by
-- neither. The grant opens the table; the policies in sections 2 to 8 decide
-- which rows come back. Both are required, and that is the point of splitting
-- them: a grant with no policy returns zero rows, and a policy with no grant
-- returns 42501.

-- The seventeen public-content tables. Every one of these is also read through
-- content_routes or by a presenter, and migration 15 relies on this grant:
-- under `security_invoker` the caller needs `select` on the BASE TABLES as well
-- as on the view. Stated here rather than inherited from Supabase's default
-- privileges, so that 1.1 does not silently take the view's reads with it.
grant select on table public.assets             to anon, authenticated;
grant select on table public.taxonomy_terms     to anon, authenticated;
grant select on table public.pages              to anon, authenticated;
grant select on table public.page_sections      to anon, authenticated;
grant select on table public.people             to anon, authenticated;
grant select on table public.person_education   to anon, authenticated;
grant select on table public.person_roles       to anon, authenticated;
grant select on table public.events             to anon, authenticated;
grant select on table public.classrooms         to anon, authenticated;
grant select on table public.classroom_teachers to anon, authenticated;
grant select on table public.page_classrooms    to anon, authenticated;
grant select on table public.promoted           to anon, authenticated;
grant select on table public.promoted_links     to anon, authenticated;
grant select on table public.announcements      to anon, authenticated;
grant select on table public.inspiring_quotes   to anon, authenticated;
grant select on table public.site_globals       to anon, authenticated;
grant select on table public.nav_items          to anon, authenticated;

-- The three tables anon must never read at all. Withholding the grant as well
-- as the policy means an anonymous request is refused by privilege before RLS
-- is consulted, so the denial does not depend on a policy staying absent.
grant select on table public.admin_users        to authenticated;
grant select on table public.content_revisions  to authenticated;
grant select on table public.security_events    to authenticated;

-- site_readiness: NO GRANT TO EITHER ROLE, deliberately. The single readiness
-- row is read server-side by nextjs/lib/content/source.ts under the service
-- role, which bypasses both the grant and RLS. Nothing in a browser has any
-- business reading the schema version, the source-manifest checksum or the
-- corpus counts, and migration 13:721-725 left the decision to this file. It
-- consequently has no policy either, in section 9.


-- -----------------------------------------------------------------------------
-- 1.3 The same defect class, one level down: default EXECUTE on PUBLIC
-- -----------------------------------------------------------------------------
-- Table privileges are not the only thing granted broadly by default.
-- PostgreSQL grants EXECUTE ON A NEW FUNCTION TO PUBLIC, and Supabase's default
-- privileges additionally grant it to anon, authenticated and service_role
-- explicitly. Migrations 13 and 16 each closed that for the functions they own
-- -- 13:530-540 for the three membership helpers, 16:7706-7904 for all fifty
-- write functions and internal helpers -- and both then re-granted only what is
-- meant to be callable.
--
-- FIVE FUNCTIONS WERE COVERED BY NEITHER, and this was found by RUNNING the
-- check in section 11.5 rather than by trusting the claim it verifies. Their ACL
-- read `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`, so
-- migration 16's statement that get_maintenance_state() is the ONLY function
-- anon may execute was, measurably, not yet true:
--
--   public.set_updated_at()                  migration 01, shared trigger
--   public.ces_uuid(text, text)              migration 01, deterministic v5 id
--   public.ces_uuid_namespace()              migration 01, the namespace uuid
--   public.assert_person_has_role()          migration 06, deferred constraint
--   public.admin_users_stamp_disabled_at()   migration 13, disabled_at trigger
--
-- None is exploitable today: three return `trigger` and raise if called outside
-- a trigger context, and the two uuid derivations disclose nothing an anonymous
-- caller cannot already read from content_routes. They are revoked anyway,
-- because least privilege is not a judgment about which surplus privilege
-- happens to be harmless, and because a claim this schema makes about itself
-- should be true.
--
-- REVOKED HERE RATHER THAN BY EDITING MIGRATIONS 01, 06 AND 13, for the same
-- reason the table grants are here rather than beside each `create table`: this
-- file is the schema's single privilege owner, and a privilege closed in one
-- reviewable place is auditable by one query. Each function is named with its
-- owning migration above so the provenance is not lost.
--
-- WHY THIS IS SAFE FOR THE TRIGGERS. `service_role=X` is an EXPLICIT grant on
-- all five and is deliberately left in place, so the canonical seed load and
-- tools/src/upload-assets.ts are unaffected even in the reading where a trigger
-- re-checks execute at fire time (it does not -- PostgreSQL checks it once, at
-- `create trigger`). Migration 16's write functions call ces_uuid() from inside
-- a security definer body, where the effective user is the owner. And anon and
-- authenticated can no longer fire any trigger on these tables at all, because
-- section 1.1 removed every write privilege they had. Section 11.5 asserts the
-- end state; the deferred-constraint trigger is exercised by the seed load.

revoke execute on function public.set_updated_at()                from public, anon, authenticated;
revoke execute on function public.ces_uuid(text, text)            from public, anon, authenticated;
revoke execute on function public.ces_uuid_namespace()            from public, anon, authenticated;
revoke execute on function public.assert_person_has_role()        from public, anon, authenticated;
revoke execute on function public.admin_users_stamp_disabled_at() from public, anon, authenticated;


-- =============================================================================
-- 2. The seven content tables
-- =============================================================================
-- pages, people, events, classrooms, promoted, announcements, inspiring_quotes.
-- These are the seven tables that carry a `published` column of their own, and
-- the shape is identical on all seven, so it is described once here.
--
--   anon           select where published
--   authenticated  select where published, OR everything given an active
--                  admin_users membership AND aal2
--
-- A DRAFT IS NOT FETCHED AND THEN HIDDEN -- IT IS NOT RETURNED. 55 of the 163
-- source entries are unpublished (pages 2, people 21, events 16, classrooms 1,
-- promoted 12 -- all of them -- announcements 3), so after the canonical load an
-- anonymous caller sees 32 of 34 pages, 56 of 77 people, 2 of 18 events, 12 of
-- 13 classrooms, 0 of 12 promoted, 1 of 4 announcements and all 5 quotes. That
-- arithmetic is the assertion in section 11.4.
--
-- WHY THE MEMBER POLICY CARRIES `published or ...` RATHER THAN MEMBERSHIP
-- ALONE: an authenticated caller with no admin_users row -- a signed-in account
-- whose membership was never created or has been revoked -- must see exactly
-- what an anonymous visitor sees, not nothing. Two permissive policies would
-- also achieve it, but one predicate per role keeps pg_policies to one row per
-- decision, and keeps the literal `true` out of a policy for `authenticated`,
-- which is reference weakness 1.
--
-- BOTH CONJUNCTS OF THE MEMBER BRANCH ARE LOAD-BEARING.
--   public.is_active_admin_user() is the MEMBERSHIP gate and covers admin and
--   editor alike -- both edit drafts. It reads admin_users.is_active, so an
--   account whose membership is cleared by disable-admin loses draft visibility
--   on its VERY NEXT REQUEST, without waiting for its access token to expire.
--   public.current_aal() = 'aal2' is the SECOND-FACTOR gate. TOTP enrolment is
--   mandatory; an aal1 session can reach /auth/mfa/enroll and nothing else.
--   Every write function in migration 16 requires aal2, and the draft-read
--   policies require it too -- otherwise a stolen aal1 session would be able to
--   read unpublished content it could not write, which is not a coherent
--   boundary. current_aal() returns 'aal1' rather than null for a missing claim,
--   so this comparison is always a real boolean and fails closed.
--
-- Both helpers are security definer with a pinned search_path, and both are
-- granted to `authenticated` and NOT to `anon` (migration 13:534-540) -- which
-- is precisely why the anon policies below call neither.


-- 2.1 pages -- 34 rows, 2 drafts.
drop policy if exists pages_anon_select_published on public.pages;
create policy pages_anon_select_published
  on public.pages
  for select
  to anon
  using (pages.published);

drop policy if exists pages_authenticated_select_member on public.pages;
create policy pages_authenticated_select_member
  on public.pages
  for select
  to authenticated
  using (
    pages.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy pages_authenticated_select_member on public.pages is
  'Published rows for any authenticated caller, plus every row -- including the '
  'two drafts and their paths -- for an active admin_users member at aal2. Not '
  '`using (true)`: an authenticated non-member, or a member whose is_active was '
  'cleared, sees exactly what anon sees on its next request.';


-- 2.2 people -- 77 rows, 21 drafts. The largest draft set in the schema.
drop policy if exists people_anon_select_published on public.people;
create policy people_anon_select_published
  on public.people
  for select
  to anon
  using (people.published);

drop policy if exists people_authenticated_select_member on public.people;
create policy people_authenticated_select_member
  on public.people
  for select
  to authenticated
  using (
    people.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );


-- 2.3 events -- 18 rows, 16 drafts.
--
-- NO DATE PREDICATE, and this is the table where one would have been added by
-- mistake. A future-dated PUBLISHED event is publicly visible, exactly as it was
-- on the legacy site; see the header for why `date_behavior` was inert there and
-- migration 07:256 for the same statement from the table's own side.
drop policy if exists events_anon_select_published on public.events;
create policy events_anon_select_published
  on public.events
  for select
  to anon
  using (events.published);

drop policy if exists events_authenticated_select_member on public.events;
create policy events_authenticated_select_member
  on public.events
  for select
  to authenticated
  using (
    events.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy events_anon_select_published on public.events is
  'Publish state alone governs visibility. Deliberately NO predicate on '
  'event_date: the legacy date_behavior setting was inert because the collection '
  'was not dated, and a future-dated published event must stay publicly visible. '
  'e2e asserts that, so the predicate cannot be reintroduced unnoticed.';


-- 2.4 classrooms -- 13 rows, 1 draft.
drop policy if exists classrooms_anon_select_published on public.classrooms;
create policy classrooms_anon_select_published
  on public.classrooms
  for select
  to anon
  using (classrooms.published);

drop policy if exists classrooms_authenticated_select_member on public.classrooms;
create policy classrooms_authenticated_select_member
  on public.classrooms
  for select
  to authenticated
  using (
    classrooms.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );


-- 2.5 promoted -- 12 rows, ALL TWELVE drafts.
--
-- The anonymous result set is therefore EMPTY on day one. That is dormant by
-- publish state, not broken: PromotedCarousel renders the section absent rather
-- than empty, and the carousel appears the moment the school publishes a row.
drop policy if exists promoted_anon_select_published on public.promoted;
create policy promoted_anon_select_published
  on public.promoted
  for select
  to anon
  using (promoted.published);

drop policy if exists promoted_authenticated_select_member on public.promoted;
create policy promoted_authenticated_select_member
  on public.promoted
  for select
  to authenticated
  using (
    promoted.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy promoted_anon_select_published on public.promoted is
  'All twelve migrated rows are drafts, so this returns nothing until the school '
  'publishes. The section is rendered absent rather than empty, and the '
  'collection surface at /admin/collections/promoted is how a draft stays '
  'reachable without a public URL.';


-- 2.6 announcements -- 4 rows, 3 drafts.
drop policy if exists announcements_anon_select_published on public.announcements;
create policy announcements_anon_select_published
  on public.announcements
  for select
  to anon
  using (announcements.published);

drop policy if exists announcements_authenticated_select_member on public.announcements;
create policy announcements_authenticated_select_member
  on public.announcements
  for select
  to authenticated
  using (
    announcements.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );


-- 2.7 inspiring_quotes -- 5 rows, no drafts.
--
-- A policy is still required. RLS is enabled on the table, so without one anon
-- would read zero rows and every flex page would render without its sidebar
-- quote -- "no drafts" is a fact about the data, never a reason to omit a
-- policy.
drop policy if exists inspiring_quotes_anon_select_published on public.inspiring_quotes;
create policy inspiring_quotes_anon_select_published
  on public.inspiring_quotes
  for select
  to anon
  using (inspiring_quotes.published);

drop policy if exists inspiring_quotes_authenticated_select_member on public.inspiring_quotes;
create policy inspiring_quotes_authenticated_select_member
  on public.inspiring_quotes
  for select
  to authenticated
  using (
    inspiring_quotes.published
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );



-- =============================================================================
-- 3. The six child tables
-- =============================================================================
-- page_sections, page_classrooms, person_education, person_roles,
-- classroom_teachers, promoted_links.
--
-- NONE OF THESE HAS A `published` COLUMN OF ITS OWN, which is the whole reason
-- their policies are not one-line predicates: a child row's public visibility is
-- entirely its parent's publish state, so each anonymous policy must REACH
-- THROUGH the foreign key with an `exists`. Getting this wrong does not fail
-- loudly -- it publishes the body copy of a draft page while the page itself
-- 404s.
--
-- HOW FAR EACH ONE REACHES IS NOT UNIFORM, and the difference is stated by each
-- table's own migration rather than invented here:
--
--   page_sections       page published AND this row enabled      (05:363-378)
--   person_education    person published AND this row enabled    (06:405-410)
--   person_roles        person published                         (06:519)
--   promoted_links      parent published                         (09:415-418)
--   classroom_teachers  classroom published AND person published (08:572-578)
--   page_classrooms     page published AND classroom published   (08:712-715)
--
-- The two pure join tables reach through BOTH foreign keys, and that is the
-- considered reading rather than extra caution: an unpublished person must not
-- surface on a published classroom page merely because the join row exists. The
-- other side's own policy would hide the person's name either way, but a
-- one-sided rule would still hand an anonymous caller the row -- and therefore
-- the fact of the association -- for content the school has not published.
--
-- `ENABLED` IS THE ASYMMETRY, AND IT IS THE WHOLE POINT OF THE COLUMN. Only
-- page_sections and person_education carry it (default true; exactly seven rows
-- across the corpus are false -- six page_sections records and the first
-- `institution` set on people/jeanette-herrera.md). The ANON policy honours it,
-- because a disabled record renders to nobody. The MEMBER policy IGNORES it, so
-- a disabled record stays visible and toggleable in edit mode and round-trips
-- through export. promoted_links has NO `enabled` column -- its one source set
-- is `enabled: true`, the default -- so no policy here mentions one; a predicate
-- on a non-existent column would fail at create time, and inventing the column
-- to make the six policies look alike would be worse.
--
-- THE NESTED POLICY QUESTION, ANSWERED ONCE. An `exists` inside a policy is
-- itself subject to the referenced table's RLS, evaluated as the same caller.
-- For anon that is harmless and in fact doubly safe: the sub-select on
-- public.pages is already filtered to published rows by section 2.1, and this
-- policy's own `p.published` states the requirement explicitly rather than
-- relying on that. It is written explicitly on purpose -- a predicate that
-- depended on another table's policy for its correctness would break silently if
-- that policy ever widened. There is no cycle: nothing in section 2 references a
-- child table, so no policy graph closes on itself.


-- 3.1 page_sections -- the body copy of every page, plus the 11 FAQ items.
drop policy if exists page_sections_anon_select_published_parent_enabled on public.page_sections;
create policy page_sections_anon_select_published_parent_enabled
  on public.page_sections
  for select
  to anon
  using (
    page_sections.enabled
    and exists (
      select 1
        from public.pages p
       where p.id = page_sections.page_id
         and p.published
    )
  );

drop policy if exists page_sections_authenticated_select_member on public.page_sections;
create policy page_sections_authenticated_select_member
  on public.page_sections
  for select
  to authenticated
  using (
    (
      page_sections.enabled
      and exists (
        select 1
          from public.pages p
         where p.id = page_sections.page_id
           and p.published
      )
    )
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy page_sections_anon_select_published_parent_enabled on public.page_sections is
  'No published column on this table, so visibility is the OWNING PAGE''s '
  'published flag AND this row''s enabled flag. Both conjuncts are required: a '
  'draft page''s sections must not be readable, and a disabled section renders '
  'to nobody. The member policy deliberately drops the enabled test so the six '
  'disabled records stay editable and round-trip through export.';


-- 3.2 person_education -- 81 institution rows, one of them disabled.
drop policy if exists person_education_anon_select_published_parent_enabled
  on public.person_education;
create policy person_education_anon_select_published_parent_enabled
  on public.person_education
  for select
  to anon
  using (
    person_education.enabled
    and exists (
      select 1
        from public.people pe
       where pe.id = person_education.person_id
         and pe.published
    )
  );

drop policy if exists person_education_authenticated_select_member on public.person_education;
create policy person_education_authenticated_select_member
  on public.person_education
  for select
  to authenticated
  using (
    (
      person_education.enabled
      and exists (
        select 1
          from public.people pe
         where pe.id = person_education.person_id
           and pe.published
      )
    )
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy person_education_anon_select_published_parent_enabled
  on public.person_education is
  'Parent published AND row enabled, the same shape as page_sections and for the '
  'same reason. Exactly one row in the migrated corpus is disabled -- the first '
  'institution set on people/jeanette-herrera.md -- and it must be suppressed '
  'publicly while staying visible in edit mode.';


-- 3.3 person_roles -- the taxonomy relation. Reaches through the PERSON only.
--
-- No predicate on the term, because every term is public (see section 4.1): a
-- test against taxonomy_terms would restate that table's own policy here and
-- could only ever be true. The person's flag is the one thing that decides
-- whether this association is public.
drop policy if exists person_roles_anon_select_published_parent on public.person_roles;
create policy person_roles_anon_select_published_parent
  on public.person_roles
  for select
  to anon
  using (
    exists (
      select 1
        from public.people pe
       where pe.id = person_roles.person_id
         and pe.published
    )
  );

drop policy if exists person_roles_authenticated_select_member on public.person_roles;
create policy person_roles_authenticated_select_member
  on public.person_roles
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.people pe
       where pe.id = person_roles.person_id
         and pe.published
    )
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy person_roles_anon_select_published_parent on public.person_roles is
  'Single-parent reach: the person''s published flag governs. No term predicate, '
  'because taxonomy_terms has no visibility field and every term is public -- '
  'adding one would restate section 4.1 and could only ever be true. This is '
  'the query behind the Leadership Team, Teaching Team and Board of Directors '
  'pages, so a draft person drops out of those listings by RLS, not by filtering '
  'after the fetch.';


-- 3.4 promoted_links -- at most one row per promotion, and NO `enabled` column.
drop policy if exists promoted_links_anon_select_published_parent on public.promoted_links;
create policy promoted_links_anon_select_published_parent
  on public.promoted_links
  for select
  to anon
  using (
    exists (
      select 1
        from public.promoted pr
       where pr.id = promoted_links.promoted_id
         and pr.published
    )
  );

drop policy if exists promoted_links_authenticated_select_member on public.promoted_links;
create policy promoted_links_authenticated_select_member
  on public.promoted_links
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.promoted pr
       where pr.id = promoted_links.promoted_id
         and pr.published
    )
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy promoted_links_anon_select_published_parent on public.promoted_links is
  'Parent published, and NOTHING ELSE -- this table has no enabled column, '
  'unlike page_sections and person_education, so no policy here may test one. '
  'All twelve promoted rows are drafts, so the single migrated link row is not '
  'anonymously readable until its promotion is published.';


-- 3.5 classroom_teachers -- the union of both legacy directions, 41 pairs.
--
-- BOTH foreign keys, per migration 08:572-578. The union is already broader than
-- either legacy direction (32 forward, 24 reverse, 15 common), which is exactly
-- why the visibility rule is the strict one: an association the source never
-- displayed must not become public because a draft person sits on one side of it.
drop policy if exists classroom_teachers_anon_select_published_parents on public.classroom_teachers;
create policy classroom_teachers_anon_select_published_parents
  on public.classroom_teachers
  for select
  to anon
  using (
    exists (
      select 1
        from public.classrooms c
       where c.id = classroom_teachers.classroom_id
         and c.published
    )
    and exists (
      select 1
        from public.people pe
       where pe.id = classroom_teachers.person_id
         and pe.published
    )
  );

drop policy if exists classroom_teachers_authenticated_select_member on public.classroom_teachers;
create policy classroom_teachers_authenticated_select_member
  on public.classroom_teachers
  for select
  to authenticated
  using (
    (
      exists (
        select 1
          from public.classrooms c
         where c.id = classroom_teachers.classroom_id
           and c.published
      )
      and exists (
        select 1
          from public.people pe
         where pe.id = classroom_teachers.person_id
           and pe.published
      )
    )
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy classroom_teachers_anon_select_published_parents on public.classroom_teachers is
  'Reaches through BOTH foreign keys: the association is public only if the '
  'classroom AND the person are published. Stricter than the single-parent reach '
  'person_education needs, and the correct reading -- an unpublished person must '
  'not surface on a published classroom page merely because the join row exists, '
  'and 21 of 77 people are drafts.';


-- 3.6 page_classrooms -- the ordered relation two page entries carry.
drop policy if exists page_classrooms_anon_select_published_parents on public.page_classrooms;
create policy page_classrooms_anon_select_published_parents
  on public.page_classrooms
  for select
  to anon
  using (
    exists (
      select 1
        from public.pages p
       where p.id = page_classrooms.page_id
         and p.published
    )
    and exists (
      select 1
        from public.classrooms c
       where c.id = page_classrooms.classroom_id
         and c.published
    )
  );

drop policy if exists page_classrooms_authenticated_select_member on public.page_classrooms;
create policy page_classrooms_authenticated_select_member
  on public.page_classrooms
  for select
  to authenticated
  using (
    (
      exists (
        select 1
          from public.pages p
         where p.id = page_classrooms.page_id
           and p.published
      )
      and exists (
        select 1
          from public.classrooms c
         where c.id = page_classrooms.classroom_id
           and c.published
      )
    )
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy page_classrooms_anon_select_published_parents on public.page_classrooms is
  'Both foreign keys, per migration 08:712-715: the relation is public only if '
  'the page AND the classroom are published. One classroom of the thirteen is a '
  'draft, so this is not hypothetical.';



-- =============================================================================
-- 4. taxonomy_terms and nav_items -- two tables, two policies, one contrast
-- =============================================================================
-- These two are placed together because the difference between them is the
-- point. Both are small reference tables read on every page. One is readable in
-- full by an anonymous visitor and the other is not, and in each case the answer
-- comes from the SOURCE rather than from a preference about how much to expose:
--
--   content/taxonomies/role.yaml is twelve bytes -- `title: Role`, and nothing
--   else. There is no visibility field, no `published`, no `hidden`, no
--   `visible`. Every term is public because the source has no way to say
--   otherwise, so section 4.1 says so plainly.
--
--   nav_items HAS a visibility column, created for exactly this purpose in
--   migration 12, and two of its seeded children plus the Header Actions group
--   are seeded `visible = false`. Section 4.2 is a predicate on it.
--
-- Writing them alike -- either by filtering taxonomy on a field it does not have
-- or by exposing hidden menu items -- would lose real information in one
-- direction or the other.


-- -----------------------------------------------------------------------------
-- 4.1 taxonomy_terms -- three role terms, all public
-- -----------------------------------------------------------------------------
-- teacher, board-of-directors, leadership. All three readable by everyone.
--
-- THE PREDICATE IS `taxonomy = 'role'` AND THAT IS A DELIBERATE CHOICE BETWEEN
-- TWO WRONG ALTERNATIVES, so it is justified here rather than left to look like
-- an accident:
--
--   NOT `using (true)`. A literal-true select policy for `authenticated` is
--   reference weakness 1 verbatim, and this file does not contain one on any
--   table. The objection to the reference's version was that a blanket read is
--   unauditable -- a reader cannot tell from the policy what makes the rows
--   safe to expose -- and that objection applies to a true predicate here too,
--   even though these particular rows are harmless.
--
--   NOT AN INVENTED VISIBILITY PREDICATE. Filtering on a `public` or `visible`
--   column that role.yaml never declared would be fabricating editorial state
--   the school never expressed, and migration 03:74 warns that such a policy
--   would "filter on a column that nothing sets".
--
-- `taxonomy = 'role'` is neither. It is a true statement about which taxonomy is
-- public, it is scoped by the table's own check constraint (which admits exactly
-- 'role' today, migration 03:160), and it returns all three seeded rows to both
-- roles -- behaviourally identical to the matrix. It also FAILS CLOSED for a
-- second taxonomy added later: those terms would be invisible until somebody
-- decided, in a migration, whether they are public. That is the safe direction,
-- and it is the whole reason to prefer it to `true`.
--
-- Both roles get the same predicate, and identical is correct here: anon already
-- reads every row, so authentication buys nothing on this table and must not
-- appear to.

drop policy if exists taxonomy_terms_anon_select_role_terms on public.taxonomy_terms;
create policy taxonomy_terms_anon_select_role_terms
  on public.taxonomy_terms
  for select
  to anon
  using (taxonomy_terms.taxonomy = 'role');

drop policy if exists taxonomy_terms_authenticated_select_role_terms on public.taxonomy_terms;
create policy taxonomy_terms_authenticated_select_role_terms
  on public.taxonomy_terms
  for select
  to authenticated
  using (taxonomy_terms.taxonomy = 'role');

comment on policy taxonomy_terms_anon_select_role_terms on public.taxonomy_terms is
  'Every role term is public: content/taxonomies/role.yaml declares only '
  '`title: Role`, so NO VISIBILITY FIELD EXISTS TO FILTER ON and none is '
  'invented. The predicate scopes to the one taxonomy the check constraint '
  'admits rather than being the literal `true` this file refuses to write for a '
  'select policy, and it fails closed for any taxonomy added later. Writes are '
  'admin-only via upsert_term/delete_term and take no policy at all, because '
  'direct DML is revoked in section 1.1.';

comment on policy taxonomy_terms_authenticated_select_role_terms on public.taxonomy_terms is
  'Identical to the anon policy on purpose. Authentication buys nothing on this '
  'table -- every term is already public -- and a wider authenticated predicate '
  'would imply otherwise.';


-- -----------------------------------------------------------------------------
-- 4.2 nav_items -- the route-independent navigation model
-- -----------------------------------------------------------------------------
-- 9 roots and 25 children after the seed. Three rows are `visible = false` and
-- must stay out of an anonymous read: the two draft children (School Age
-- Mandarin under Programs, Deposits under Admissions), which appear
-- automatically when the school publishes their pages, and the Header Actions
-- group, which is a container for the two calls to action and never renders as a
-- menu entry.
--
-- The member policy is `visible or member` rather than plain membership for the
-- usual reason, and it is what lets NavTreeEditor at /admin/navigation see,
-- reorder and unhide the invisible rows.

drop policy if exists nav_items_anon_select_visible on public.nav_items;
create policy nav_items_anon_select_visible
  on public.nav_items
  for select
  to anon
  using (nav_items.visible);

drop policy if exists nav_items_authenticated_select_member on public.nav_items;
create policy nav_items_authenticated_select_member
  on public.nav_items
  for select
  to authenticated
  using (
    nav_items.visible
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy nav_items_anon_select_visible on public.nav_items is
  'A predicate on the visibility column this table actually has -- deliberately '
  'UNLIKE taxonomy_terms in section 4.1, whose source declares no such field. '
  'Two tables, two policies, each justified by its own evidence. Hides the two '
  'draft children and the Header Actions container from anonymous reads; the '
  'member policy shows them so the navigation editor can reorder and unhide '
  'them.';


-- =============================================================================
-- 5. assets -- the one policy with a genuinely non-obvious predicate
-- =============================================================================
-- 289 migrated rows: 110 referenced by published content, 24 referenced only by
-- unpublished entries, 155 referenced by nothing.
--
-- An asset's anonymous readability is NOT a column on this table. It is a
-- function of who references it, which is the same single predicate that decides
-- which Storage bucket the bytes belong in:
--
--     public if published_reference_count(asset_id) > 0, private at zero
--
-- and the count is EXISTENTIAL, not universal. One published reference is enough
-- -- those bytes are already on a page anyone can see. The inverted rule
-- ("promote only assets whose references are ALL published") would force an image
-- private whenever any draft referenced it, so a published page sharing a
-- photograph with a draft would render a broken image. Migration 16:section 9
-- records that trap at length; this file must not reintroduce it.
--
-- >>> THE PUBLIC-GLOBALS CLAUSE IS THE ONE MOST EASILY MISSED <<<
-- site_globals has no `published` column; `public` is its equivalent. The school
-- logo (CESHouseLogo.png) is referenced by NO content row at all -- it reaches
-- the site through site_globals.asset_id on the `logo` key, which is a public
-- row. Without the final clause below the logo would be invisible to every
-- anonymous visitor, on every page, and the failure would look like a broken
-- image rather than like a policy.
--
-- WHY THE anon POLICY IS AN INLINE PREDICATE AND NOT A CALL TO
-- published_reference_count(): that function is REVOKED FROM anon (migration
-- 16:7804) and must stay revoked. Migration 16:8016-8021 states that
-- get_maintenance_state() is the only function anon may execute and that a
-- second line in that grant block is a defect -- the request boundary needs the
-- maintenance flag before it knows who is calling; nothing else has any business
-- running without a session. An RLS predicate is evaluated with the CALLER's
-- privileges, so an anon policy calling the function would fail with 42501 on
-- every anonymous page load. The predicate below is therefore an equivalent,
-- mirroring the function's `union all` branches clause for clause, in the same
-- order, over the same eleven reference columns.
--
-- THAT MIRROR IS A COUPLING, AND IT IS STATED RATHER THAN HOPED ABOUT. A twelfth
-- asset reference column added anywhere in the schema must be added to BOTH this
-- policy and published_reference_count(), in the same migration, or a newly
-- referenced image stays invisible to visitors. The two are assertable against
-- each other with one query, which is section 11.6 -- if it ever returns a row,
-- they have drifted.
--
-- The authenticated policy calls the function, because `authenticated` DOES hold
-- execute on it (migration 16:7993) and the canonical implementation should be
-- the one in use wherever privileges allow. It is security definer, so it sees
-- the true reference count regardless of the caller's own row visibility -- which
-- is why an authenticated non-member gets exactly the anonymous answer.

drop policy if exists assets_anon_select_published_reference on public.assets;
create policy assets_anon_select_published_reference
  on public.assets
  for select
  to anon
  using (
    exists (
      select 1
        from public.pages p
       where p.published
         and assets.id in (
           p.main_image_asset_id, p.program_image_asset_id, p.og_image_id
         )
    )
    -- The owning page's flag governs, and a disabled section counts for nothing.
    or exists (
      select 1
        from public.page_sections s
        join public.pages p on p.id = s.page_id
       where p.published
         and s.enabled
         and s.asset_id = assets.id
    )
    or exists (
      select 1
        from public.people pe
       where pe.published
         and assets.id in (pe.photo_asset_id, pe.og_image_id)
    )
    or exists (
      select 1
        from public.events e
       where e.published
         and assets.id in (e.image_asset_id, e.og_image_id)
    )
    -- classrooms has NO image_asset_id -- only og_image_id.
    or exists (
      select 1
        from public.classrooms c
       where c.published
         and c.og_image_id = assets.id
    )
    or exists (
      select 1
        from public.promoted pr
       where pr.published
         and pr.image_asset_id = assets.id
    )
    -- No published column here; `public` is the equivalent, and THIS is the
    -- clause that keeps the school logo anonymously reachable.
    or exists (
      select 1
        from public.site_globals g
       where g.public
         and g.asset_id = assets.id
    )
  );

drop policy if exists assets_authenticated_select_member on public.assets;
create policy assets_authenticated_select_member
  on public.assets
  for select
  to authenticated
  using (
    public.published_reference_count(assets.id) > 0
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy assets_anon_select_published_reference on public.assets is
  'Readable anonymously when the asset is referenced by a PUBLISHED row -- any '
  'one is enough, the test is existential -- OR by a PUBLIC site_globals key. '
  'That second clause is what keeps the school logo reachable without a session: '
  'no content row references it. Written inline rather than as a call to '
  'published_reference_count() because that function is revoked from anon and '
  'must stay revoked, get_maintenance_state() being the only function anon may '
  'execute. The two MUST agree; a twelfth reference column has to be added to '
  'both in the same migration.';

comment on policy assets_authenticated_select_member on public.assets is
  'Calls the canonical published_reference_count() -- authenticated holds '
  'execute on it -- so an authenticated non-member gets exactly the anonymous '
  'answer, and an active member at aal2 additionally reads the 24 draft-only and '
  '155 archived rows the asset library lists. Reading the ROW is not reading the '
  'BYTES: private objects are delivered only through /api/media, never through '
  'the image optimizer, and migration 18 owns the Storage policies.';


-- =============================================================================
-- 6. site_globals -- and why the maintenance copy is not public
-- =============================================================================
-- 26 seeded keys across six groups. Exactly four are `public = false`:
-- maintenance_enabled, maintenance_title, maintenance_message and
-- maintenance_retry_after. An anonymous caller therefore reads 22 rows.
--
-- The privacy of those four is not fastidiousness. The interstitial's wording is
-- something the school has not used yet, and an anonymous reader should not be
-- able to read it in advance -- so `select using (public)` and nothing wider.
-- Reference weakness 3 is the opposite of this: a blanket public read of a
-- business-info table that had no visibility column to filter on at all.
--
-- WHICH RAISES THE ONE QUESTION THIS POLICY CANNOT ANSWER, and migration 16
-- already has: nextjs/proxy.ts must evaluate maintenance mode on EVERY request,
-- including anonymous ones, and the cookie-free anon client cannot read a
-- non-public row. get_maintenance_state() resolves it -- security definer,
-- granted to anon, returning only `enabled` and `retry_after` to an unidentified
-- caller and adding `title` and `message` only for a verified member. It is the
-- single privileged read on the anonymous path, and section 10 confirms rather
-- than restates its grant.

drop policy if exists site_globals_anon_select_public on public.site_globals;
create policy site_globals_anon_select_public
  on public.site_globals
  for select
  to anon
  using (site_globals.public);

drop policy if exists site_globals_authenticated_select_member on public.site_globals;
create policy site_globals_authenticated_select_member
  on public.site_globals
  for select
  to authenticated
  using (
    site_globals.public
    or (public.is_active_admin_user() and public.current_aal() = 'aal2')
  );

comment on policy site_globals_anon_select_public on public.site_globals is
  'Anonymous reads are 22 of the 26 keys. The four maintenance rows are '
  'public = false and stay unreadable, because the school''s not-yet-used '
  'interstitial wording must not be readable in advance -- which is exactly why '
  'get_maintenance_state() exists for the request boundary. NOT '
  '`select using (true)`: that is reference weakness 3, on a table that had no '
  'visibility column to filter on.';

comment on policy site_globals_authenticated_select_member on public.site_globals is
  'A member at aal2 reads all 26 keys, including the maintenance copy an editor '
  'working behind the interstitial needs to see. WRITING them is a different '
  'question and is not settled here: update_globals requires the '
  'manage_globals capability, which is ADMIN ONLY, and direct DML is revoked in '
  'section 1.1 -- so an editor can read this table and cannot change it.';



-- =============================================================================
-- 7. admin_users -- the recursion trap, and the bootstrap that is not weakened
-- =============================================================================
-- Membership itself. Two policies, both for `authenticated`, both narrow:
--
--   own row   a caller may read their OWN membership -- role, is_active, when it
--             changed, who invited them. A bare comparison against auth.uid().
--   all rows  an admin at aal2 may read every row, which is what /admin/users
--             renders.
--
-- anon gets NO POLICY AND NO GRANT (section 1.2), so an anonymous request is
-- refused by privilege before RLS is consulted. Nothing about this table -- not
-- the number of administrators, not their user ids -- is public.
--
-- >>> THE RECURSION TRAP <<<
-- The admin branch asks public.has_capability('manage_users'), NOT a subquery on
-- admin_users. A subquery here would be evaluated under this very policy, which
-- would evaluate the subquery, and Postgres would report infinite recursion --
-- breaking every read of the table, including the one the editor needs to render
-- at all. has_capability() is security definer and runs as the owner, so its own
-- read of admin_users is subject to no policy. This is the trap migration
-- 13:255-262 and 13:772-780 name from the other side, and it is why those
-- helpers exist.
--
-- WHY 'manage_users' IS HOW "admin" IS ASKED. There is no is_admin() helper, by
-- design: migration 13's capability matrix is the authorization vocabulary, and
-- manage_users is its admin-only capability for exactly this surface -- invite,
-- change roles, disable accounts. Asking the capability rather than the role
-- keeps this policy honest if the matrix is ever refined, and it fails closed on
-- an unknown string.
--
-- THE ASYMMETRY ON aal2 IS DELIBERATE. Reading every member's row is privileged
-- and requires the second factor. Reading YOUR OWN row is not: it discloses
-- nothing the caller does not already know, and an aal1 session -- one that has
-- signed in and must now enrol TOTP -- can therefore still resolve its own role
-- while being unable to read anybody else's row, write anything, or see a single
-- draft. Requiring aal2 on the own-row branch would buy no confidentiality and
-- would make the enrolment surface harder to build correctly.
--
-- >>> NO INSERT POLICY, HERE OR ANYWHERE <<<
-- The first membership rows arrive under the SERVICE ROLE, from
-- tools/src/bootstrap-admins.ts, which bypasses RLS legitimately. The foreign
-- key to auth.users already makes a membership row impossible before an account
-- exists, and accounts are created by invitation only -- public signup is
-- disabled at the project level and no signup route exists. NO POLICY IS
-- WEAKENED TO ALLOW THAT INSERT. The reference implementation's
-- `for insert to anon, authenticated with check (true)` is weakness 2, and this
-- is the table where reproducing it would hand out authority itself.

drop policy if exists admin_users_authenticated_select_own on public.admin_users;
create policy admin_users_authenticated_select_own
  on public.admin_users
  for select
  to authenticated
  using (admin_users.user_id = auth.uid());

drop policy if exists admin_users_authenticated_select_admin on public.admin_users;
create policy admin_users_authenticated_select_admin
  on public.admin_users
  for select
  to authenticated
  using (
    public.has_capability('manage_users')
    and public.current_aal() = 'aal2'
  );

comment on policy admin_users_authenticated_select_own on public.admin_users is
  'A caller reads their own membership row and no other. A bare column '
  'comparison against auth.uid(), touching no other table -- so it cannot '
  'recurse. No aal2 requirement: the row discloses nothing the caller does not '
  'already know, and an aal1 session mid-TOTP-enrolment still needs to resolve '
  'its own role while being unable to read another member''s row or any draft.';

comment on policy admin_users_authenticated_select_admin on public.admin_users is
  'An admin at aal2 reads every membership row -- the /admin/users surface. Asks '
  'public.has_capability(''manage_users''), which is SECURITY DEFINER, and NEVER '
  'a subquery on admin_users: a subquery here would be evaluated under this '
  'policy and recurse, breaking every read of the table. That is the named trap '
  'this file was written to avoid. Fails closed for an unknown capability, an '
  'anonymous caller and a member whose is_active was cleared.';


-- =============================================================================
-- 8. The two append-only tables
-- =============================================================================
-- One select policy each, and NOTHING ELSE -- no insert policy, no update
-- policy, no delete policy. The omission is the specification, not an oversight,
-- and migration 14:38-60 asks whoever writes this file not to fill it in "out of
-- habit or for symmetry with the content tables".
--
-- WHY NO INSERT POLICY IS NEEDED AT ALL. Every row in both tables is written by
-- a security definer function in migration 16 (or, for `csp`, `upload_rejected`
-- and `media_denied`, by a route handler through the service role). Those run as
-- the table owner and are not subject to RLS, so an insert policy would grant
-- nothing that is used and would open a path that is not.
--
-- WHY NO UPDATE OR DELETE POLICY. A row here is a statement about something that
-- already happened, and a statement about the past has no legitimate reason to
-- change. With RLS enabled the absence of a policy is the denial, and section
-- 1.1 has additionally removed the underlying grants -- two independent
-- mechanisms, so neither has to be perfect alone. The one legitimate deletion is
-- the nightly retention sweep (csp at 30 days, everything else at 90), which
-- runs as the service role and needs no policy.
--
-- WHY NOT AN EXPLICIT `using (false) with check (false)` DENY. The reference uses
-- that form in 20260128123000_tighten_newsletter_subscribers_policy.sql, and it
-- is the right idiom THERE -- it supersedes a permissive policy that already
-- existed. Here there is nothing to supersede, so a deny policy would be
-- belt-and-braces over two mechanisms that already deny, and it would make
-- `select count(*) from pg_policies where cmd in ('UPDATE','DELETE')` non-zero,
-- which is the assertion section 11.3 relies on to prove append-only by reading
-- the catalogue. Deliberately not written.


-- 8.1 content_revisions -- readable with the `edit` capability
--
-- `edit` and not admin: an editor may review the history of the content they
-- maintain, and RevisionHistory is reachable per field from FieldFrame. That is
-- migration 13's matrix, which lists `edit` among the capabilities editor and
-- admin hold alike. aal2 as well, on the same reasoning as the draft-read
-- policies: this table holds before-and-after values of every field, including
-- unpublished ones, so reading it is at least as sensitive as reading a draft.

drop policy if exists content_revisions_authenticated_select_edit on public.content_revisions;
create policy content_revisions_authenticated_select_edit
  on public.content_revisions
  for select
  to authenticated
  using (
    public.has_capability('edit')
    and public.current_aal() = 'aal2'
  );

comment on policy content_revisions_authenticated_select_edit on public.content_revisions is
  'The ONLY policy on this table. Select requires the `edit` capability -- held '
  'by editor and admin alike, so an editor can review content history -- plus '
  'aal2, because value_before/value_after expose unpublished field values. THERE '
  'IS DELIBERATELY NO INSERT, UPDATE OR DELETE POLICY: inserts come from '
  'migration 16''s security definer write functions, which run as the owner, and '
  'append-only means the absence of the other two is the denial. Do not add one '
  'for symmetry with the content tables.';


-- 8.2 security_events -- readable by admin only
--
-- The stricter of the two. An editor can review their own content history; the
-- security log is an admin surface, rendered as a panel over the trailing 90
-- days at /admin/users -- which is also why `manage_users` is the capability
-- asked, matching section 7 rather than introducing a second way to spell
-- "admin".

drop policy if exists security_events_authenticated_select_admin on public.security_events;
create policy security_events_authenticated_select_admin
  on public.security_events
  for select
  to authenticated
  using (
    public.has_capability('manage_users')
    and public.current_aal() = 'aal2'
  );

comment on policy security_events_authenticated_select_admin on public.security_events is
  'The ONLY policy on this table, and stricter than content_revisions: select '
  'requires an ADMIN capability, asked as manage_users to match the /admin/users '
  'panel that renders it, plus aal2. No insert, update or delete policy, for the '
  'same append-only reason. BOUNDARY, stated rather than implied: a direct '
  'PostgREST write rejected by the missing grant in section 1.1 produces NO ROW '
  'HERE, because no function of ours executes on that path -- those rejections '
  'live in Supabase''s API and Postgres logs, and e2e asserts both halves.';


-- =============================================================================
-- 9. site_readiness -- the table with no policy, on purpose
-- =============================================================================
-- Row level security is enabled on it (migration 13:724) and this file adds NO
-- POLICY, so anon and authenticated read zero rows; section 1.2 additionally
-- grants neither of them `select`, so the request is refused by privilege before
-- RLS is even consulted. Two mechanisms, and the state is intentional in both.
--
-- The single readiness row is read server-side by nextjs/lib/content/source.ts
-- under the service role, which bypasses both. It holds the schema version, the
-- source-manifest checksum and the corpus counts -- nothing a browser needs and
-- nothing a visitor should have. Written once per cutover by
-- tools/src/verify-parity.ts --write-readiness.
--
-- Stated as a section rather than by silence so a later reader does not add a
-- policy here believing one was forgotten. If the admin shell ever needs to
-- display the readiness state, the correct change is a server-side read, not a
-- policy on this table.


-- =============================================================================
-- 10. Privileges owned elsewhere -- confirmed here, not restated
-- =============================================================================
-- Two grants this file's matrix depends on already exist upstream. Both are
-- deliberately NOT repeated: a grant with two owners is a grant nobody owns, and
-- restating them here would make a later change in the owning migration look
-- like it had taken effect when this file had quietly overridden it.
--
--   execute on public.get_maintenance_state() to anon
--     Migration 16:8016-8021, whose comment states that it is the ONLY function
--     anon may execute and that a second line in that block is a defect. The
--     request boundary needs the maintenance flag before it knows who is
--     calling. Section 11.5 asserts that anon holds execute on that function and
--     on nothing else in schema public -- including published_reference_count(),
--     which is why section 5's anon predicate is written inline.
--
--   select on public.content_routes to anon, authenticated
--     Migration 15:476-479, which revokes all and then grants select. The view
--     is `with (security_invoker = true)`, so it needs no policy and cannot have
--     one -- PostgreSQL has no row level security on views. Under
--     security_invoker the caller also needs select on the BASE TABLES, which
--     section 1.2 grants explicitly rather than leaving to Supabase's default
--     privileges that section 1.1 has just revoked. The policies in section 2
--     are then what make the view return 102 paths to anon and 142 to a member.
--
-- No grant of execute on any other function appears in this file. The thirty
-- write commands are granted to `authenticated` by migration 16:7982-8015, and
-- the membership helpers by migration 13:538-540.



-- =============================================================================
-- 11. How to verify every claim this file makes
-- =============================================================================
-- Each query below was RUN against the local stack after `supabase db reset`,
-- and its expected result is stated. They are recorded here because this file's
-- correctness is a property of the catalogue rather than of its own text: a
-- policy that looks right and a grant that was never revoked produce a schema
-- that reads securely and is not.
--
-- 11.1 THE HIGHEST-VALUE ASSERTION -- zero write grants. Expect ZERO ROWS.
--
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and grantee in ('anon', 'authenticated')
--      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
--    order by table_name, grantee, privilege_type;
--
-- And the same claim read from the ACL itself, which also covers truncate,
-- references, trigger and PostgreSQL 17's maintain. Expect `r/postgres` for
-- anon and authenticated on the seventeen public tables, `authenticated=r` only
-- on admin_users, content_revisions and security_events, and NEITHER role
-- present on site_readiness:
--
--   select relname, unnest(relacl)::text as acl
--     from pg_class
--    where relnamespace = 'public'::regnamespace
--      and relkind = 'r'
--    order by relname, acl;
--
-- 11.2 The matrix, read back row by row. Expect 38 rows, every cmd = SELECT,
-- every roles entry a single role, and NO qual equal to the literal `true`:
--
--   select tablename, policyname, roles, cmd, qual, with_check
--     from pg_policies
--    where schemaname = 'public'
--    order by tablename, policyname;
--
--   select count(*) from pg_policies where schemaname = 'public';          -- 38
--   select count(*) from pg_policies
--    where schemaname = 'public' and cmd <> 'SELECT';                      --  0
--   select count(*) from pg_policies
--    where schemaname = 'public' and qual = 'true';                        --  0
--   select count(*) from pg_policies
--    where schemaname = 'public' and with_check is not null;               --  0
--
-- 11.3 Append-only, proved from the catalogue. Expect 0 for the whole schema,
-- which is stronger than the two tables the claim is about:
--
--   select count(*) from pg_policies
--    where schemaname = 'public' and cmd in ('UPDATE', 'DELETE');          --  0
--   select count(*) from pg_policies
--    where schemaname = 'public' and cmd = 'INSERT';                       --  0
--
-- 11.4 Draft isolation, after supabase/seed.sql has loaded. As anon --
--   set local role anon; set local request.jwt.claims to '{"role":"anon"}';
-- expect pages 32, people 56, events 2, classrooms 12, promoted 0,
-- announcements 1, inspiring_quotes 5, site_globals 22, taxonomy_terms 3,
-- content_routes 102, and zero rows from admin_users, content_revisions and
-- security_events (each refused by privilege, not returned empty). As a member
-- at aal2, every content count is the full figure -- 34, 77, 18, 13, 12, 4, 5 --
-- site_globals is 26 and content_routes is 142.
--
-- 11.5 anon executes exactly one function. Expect a single row,
-- get_maintenance_state:
--
--   select p.proname
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and has_function_privilege('anon', p.oid, 'execute')
--    order by 1;
--
-- 11.6 THE MIRROR IN SECTION 5 AGREES WITH THE FUNCTION. Expect ZERO ROWS; a
-- row means the inline anon predicate and published_reference_count() have
-- drifted, and a referenced image is either invisible to visitors or visible
-- when it should not be. Run as the owner, so both sides see every row:
--
--   select a.id, a.path, public.published_reference_count(a.id) as fn
--     from public.assets a
--    where (public.published_reference_count(a.id) > 0) is distinct from (
--      exists (select 1 from public.pages p
--               where p.published
--                 and a.id in (p.main_image_asset_id, p.program_image_asset_id,
--                              p.og_image_id))
--      or exists (select 1 from public.page_sections s
--                   join public.pages p on p.id = s.page_id
--                  where p.published and s.enabled and s.asset_id = a.id)
--      or exists (select 1 from public.people pe
--                  where pe.published and a.id in (pe.photo_asset_id,
--                                                  pe.og_image_id))
--      or exists (select 1 from public.events e
--                  where e.published and a.id in (e.image_asset_id,
--                                                 e.og_image_id))
--      or exists (select 1 from public.classrooms c
--                  where c.published and c.og_image_id = a.id)
--      or exists (select 1 from public.promoted pr
--                  where pr.published and pr.image_asset_id = a.id)
--      or exists (select 1 from public.site_globals g
--                  where g.public and g.asset_id = a.id)
--    );
--
-- 11.7 Idempotency. `supabase db reset` twice, or the eighteen applied twice,
-- must leave 11.2's output identical -- and the second apply must not fail.
-- `create policy` has no `if not exists` form, so the guarded drops above are
-- what make that true.
--
-- 11.8 The negative set belongs to nextjs/tests/e2e/security.spec.ts, under real
-- RLS against the local stack, because privileges and policies together are only
-- observable through a real client: an anonymous select of a draft returns
-- nothing; an anonymous insert on every table fails; a signed-in account with no
-- admin_users row cannot write; an editor cannot update site_globals; an aal1
-- session cannot write; a disabled account loses draft access and all capability
-- on its next request; a direct REST PATCH is rejected AND produces no
-- security_events row; and an anonymous fetch of a private Storage object is
-- refused.
-- =============================================================================

