-- =============================================================================
-- Cambridge-Ellis School  ·  migration 16 of 18  ·  the write functions
-- =============================================================================
-- Every mutation the application performs happens in this file. Nothing else
-- writes content.
--
-- WHY THIS FILE EXISTS. Row level security closes the anonymous hole and leaves
-- an authenticated one wide open: a signed-in account holds a bearer token, and
-- that token can be pointed straight at the PostgREST API. RLS would happily
-- let it `patch` any row a `using` clause admits. So the design splits the two
-- directions:
--
--   reads   keep RLS. Migration 17's policies decide which rows come back.
--   writes  are REVOKED from `authenticated` entirely by migration 17, and are
--           reachable only through the security definer functions below, each of
--           which re-establishes who the caller is, whether they are still a
--           member, whether they presented a second factor, and whether they
--           hold the specific capability the operation needs.
--
-- That is what makes the authorization model real rather than decorative: the
-- same rules apply to a direct REST call as to a click in the editor, because
-- there is only one code path and it is this one.
--
--
-- -----------------------------------------------------------------------------
-- CONTRACT 1 · RETURN A TYPED RESULT. DO NOT RAISE ON A DENIAL.
-- -----------------------------------------------------------------------------
-- This is the single most important rule in the file and it is not stylistic.
--
-- A denial raised as an exception rolls the transaction back, and it takes any
-- audit row inserted before it along with it. A refused write that leaves no
-- record of having been refused is the exact failure `public.security_events`
-- exists to prevent, and migration 14 says so at its line 333.
--
-- Therefore:
--
--   * Capability, membership, assurance-level, conflict, blocking, validation
--     and rate-limit failures RETURN a result with `ok` false and a reason.
--     The function then commits, and the `denied` or `rate_limited` row it
--     inserted commits with it.
--
--   * Only a genuinely exceptional failure raises — a constraint violation, a
--     serialization failure, a deadlock. The calling Server Action in
--     nextjs/lib/actions/* catches that and writes the security event in a
--     SEPARATE transaction through the admin client. That is an explicit second
--     write, not an assumption that the first survived.
--
--   * THE AUDIT INSERT IS THE EXCEPTION TO THE EXCEPTION. If writing the
--     revision rows fails, the whole thing rolls back, mutation included. A
--     silently unaudited write is worse than a failed one, so
--     public.ces_write_revision() deliberately catches nothing.
--
-- The result shape is uniform across all thirty commands, because
-- nextjs/lib/actions/* depends on it being uniform. See section 1.
--
--
-- -----------------------------------------------------------------------------
-- CONTRACT 2 · EVERY FUNCTION PINS search_path AND QUALIFIES EVERY IDENTIFIER.
-- -----------------------------------------------------------------------------
-- `set search_path = ''` on every function in this file, without exception, and
-- every table, view and function referenced by its schema.
--
-- An unpinned search_path on a security definer function is a privilege
-- escalation vector: a caller who can create a schema on their own search path
-- can shadow a table name and have an owner-privileged function write to their
-- table instead of ours. Pinning it to the empty string removes the mechanism
-- rather than mitigating it.
--
-- Consequences of the empty path, all of which are load-bearing here:
--
--   * public.pages, public.assets, public.content_revisions … always qualified.
--   * auth.uid(), auth.jwt() … the auth schema is not on the path either.
--   * extensions.gen_random_uuid() — pgcrypto lives in `extensions`, not in
--     `public`, exactly as migration 03 records at its line 99.
--   * pg_catalog is the one schema Postgres always searches first regardless of
--     search_path, so `coalesce`, `length` and the operators resolve. The two
--     pg_catalog functions that carry real weight here — pg_advisory_xact_lock
--     and hashtext — are written qualified anyway, so a reader can see that
--     their resolution was considered rather than assumed.
--
-- The verification is a query, not a reading. It appears in section 18.
--
--
-- -----------------------------------------------------------------------------
-- CONTRACT 3 · THE AUDIT TRAIL IS APPEND-ONLY, AND EVERY COMMAND WRITES IT.
-- -----------------------------------------------------------------------------
-- Every mutating function mints one change_set_id and writes one
-- public.content_revisions row per (table, row, column) it touched, all sharing
-- that id. Nothing in this file updates or deletes an audit row, and nothing
-- updates or deletes a public.security_events row.
--
-- The change set is what makes a multi-row operation reversible AS ONE
-- OPERATION. reparent_page rewrites a page's path and every descendant's; a
-- forced delete strips references from three tables; a reorder renumbers a whole
-- sibling set. Undoing one row of any of those would leave the tree
-- inconsistent, which is why restore_change_set exists beside restore_revision.
--
--
-- -----------------------------------------------------------------------------
-- CONTRACT 4 · LEAST PRIVILEGE, AND THE GRANT TRAP THAT DEFEATS THE OBVIOUS FIX.
-- -----------------------------------------------------------------------------
-- Section 17 revokes execute from BOTH `public` AND `anon` on every function
-- here, then grants it to `authenticated` and `service_role`, and grants it to
-- `anon` on public.get_maintenance_state() and nothing else.
--
-- Both revokes are required and migration 13 measured why at its line 498:
-- `create function` grants execute to PUBLIC, and Supabase additionally ships
-- `alter default privileges in schema public grant execute on functions to
-- postgres, anon, authenticated, service_role`. That second one is a DIRECT
-- grant to the anon role, recorded in the acl as `anon=X/postgres`, and
-- `revoke ... from public` CANNOT remove it because PUBLIC and anon are
-- different grantees. Revoking only from PUBLIC would leave every write
-- function in this file executable by anonymous visitors while looking, in the
-- migration, as though it did not.
--
--
-- -----------------------------------------------------------------------------
-- CONTRACT 5 · IDEMPOTENT. THE EIGHTEEN MIGRATIONS RUN TWICE CLEANLY.
-- -----------------------------------------------------------------------------
-- `create or replace function` throughout. Two traps come with it:
--
--   * `create or replace` cannot change a function's return type or its
--     argument NAMES. Where this file needed to iterate on a signature during
--     development, the fix was `drop function if exists <name>(<types>)` first.
--   * SIGNATURES ARE NOW FROZEN. nextjs/lib/actions/* calls these by name and
--     by named argument over rpc, and nextjs/types/database.ts is generated from
--     them and diffed in CI. Renaming an argument is a breaking change.
--
--
-- -----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
-- -----------------------------------------------------------------------------
--   * No generic update_field(table, column, value). Not anywhere, not for
--     convenience. It would be an authorization hole wearing a helper's
--     clothing: one grant would license every column of every table. Each of
--     the seven field-write commands instead carries its OWN closed allowlist of
--     (table, column) pairs, restricted to columns of the type that command is
--     for, so update_text cannot reach `published` and cannot reach an asset
--     foreign key. Section 11 states this again where it is enforced.
--   * No policies. Migration 17 owns every policy, every table grant, and the
--     revocation of direct DML from `authenticated`.
--   * No Storage buckets. Migration 18.
--   * No new tables, and no check constraint added to any existing table. The
--     blueprint character limits and the per-kind section shapes are enforced
--     HERE, on create and edit, precisely so the legacy corpus can load
--     grandfathered — migration 05 line 275 and migration 04 line 522 both
--     delegate that here by name.
--   * No process-local or session-local rate counter. The reference
--     implementation's module-scope Map is per-instance on serverless and is
--     therefore not a limit at all. Section 4 counts from the database, inside
--     the mutation's own transaction.
--   * No attempt to invalidate an already-issued JWT. Section 16 explains why
--     the property that matters is achievable without it.
--   * No claim that the upload orchestration is atomic. Section 14 explains why
--     it cannot be and what is guaranteed instead.
--   * No page reparenting performed by the migration itself. reparent_page is
--     future machinery for the school, capability-gated to admin; all 142 paths
--     are unchanged by this migration set.
-- =============================================================================


-- =============================================================================
-- 1. The shared result envelope
-- =============================================================================
-- One shape, returned by all thirty commands and by every guard and check they
-- call:
--
--   {
--     "ok":            true | false,
--     "reason":        null when ok, otherwise one of the vocabulary below,
--     "message":       a human-readable sentence for the editor to surface,
--     "change_set_id": the uuid grouping this command's revision rows, or null,
--     "detail":        a per-reason object, never null — {} when there is none
--   }
--
-- THE REASON VOCABULARY, closed by convention:
--
--   unauthenticated  no auth.uid(); the caller presented no session at all
--   no_membership    a real session with no active admin_users row
--   aal2_required    an active member who has not presented a second factor
--   capability       an active aal2 member lacking the capability for this
--                    command — the editor-versus-admin boundary
--   rate_limited     a ceiling in section 4 was reached; detail carries the
--                    window reset time so the editor can say when, rather than
--                    retrying blindly
--   conflict         the optimistic concurrency check in section 5 found the row
--                    changed since it was read; detail carries the current value
--   route_conflict   the path is taken; detail names the conflicting kind and id
--   blocked          a reference-safety refusal; detail lists the blockers
--   not_found        the target row does not exist
--   invalid          the payload failed validation — an unknown column for this
--                    command, a bad enum, a length limit, a per-kind shape
--   invariant        a structural rule would be broken: a tree cycle, exceeding
--                    max_depth, removing the last active admin, self-demotion
--   unsupported      the operation is meaningless for this table, e.g. reorder
--                    on a collection with no sort_order column
--
-- WHY THE CONSTRUCTOR VALIDATES NOTHING. There is deliberately no check
-- constraint and no `case` rejecting an unrecognized reason string. Migration 14
-- reasons identically about content_revisions.table_name: a validator inside the
-- error path can only turn a legitimate refusal into a 500, which loses both the
-- typed result and the audit row. The vocabulary is a convention shared with
-- nextjs/lib/actions/commands.ts, and it is enforced by review and by tests, not
-- by a mechanism that can fail at the worst possible moment.
--
-- WHY jsonb RATHER THAN A COMPOSITE TYPE. `detail` is genuinely variable — a
-- rate-limit window, a list of blocking rows, a conflicting route, a current
-- value of arbitrary column type — which is the project's stated bar for
-- reaching for jsonb. A composite type would also have made every signature
-- change a drop-and-recreate of the type and everything depending on it, and
-- `create type` has no `or replace` form, which sits badly with contract 5.

create or replace function public.ces_result_ok(
  p_change_set_id uuid default null,
  p_detail        jsonb default '{}'::jsonb
)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select jsonb_build_object(
    'ok',            true,
    'reason',        null::text,
    'message',       null::text,
    'change_set_id', p_change_set_id,
    'detail',        coalesce(p_detail, '{}'::jsonb)
  )
$fn$;

create or replace function public.ces_result_error(
  p_reason  text,
  p_message text,
  p_detail  jsonb default '{}'::jsonb
)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select jsonb_build_object(
    'ok',            false,
    'reason',        p_reason,
    'message',       p_message,
    'change_set_id', null::uuid,
    'detail',        coalesce(p_detail, '{}'::jsonb)
  )
$fn$;


-- =============================================================================
-- 2. Identity, the service-role exemption, and the shared guard
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 Is the caller the service role?
-- -----------------------------------------------------------------------------
-- Read from the `role` claim of the request JWT rather than from current_user,
-- because inside a security definer function current_user is the function owner
-- and would tell us nothing about who called.
--
-- WHY THE SERVICE ROLE IS EXEMPT FROM THE GUARD AND FROM THE RATE LIMITS, and
-- why that is not a hole. The service role already bypasses RLS and already
-- holds direct DML on every table: whoever holds that key owns the database
-- outright. A capability refusal here would therefore stop nobody who could not
-- trivially route around it, while it WOULD break the operator tooling that is
-- supposed to work — tools/src/upload-assets.ts, bootstrap-admins.ts,
-- verify-parity.ts and the nightly cleanup route all run as service_role, and
-- the bulk migration load must not be throttled by a per-account hourly
-- ceiling. Migration 14 anticipates exactly this by making
-- content_revisions.actor_id nullable, noting that "supabase/seed.sql loads as
-- the service role, which is not an auth.users row at all".
--
-- NO USER ROLE IS EXEMPT. Not admin, not the last remaining admin, not the
-- account that owns the project. The exemption is for the key that already has
-- unmediated access, and for nothing else.
--
-- Never raises, for the same reason public.current_aal() never raises
-- (migration 13 line 441): a malformed claims payload must degrade to "not the
-- service role" — the conservative answer — rather than converting an
-- authorization question into a 500.
create or replace function public.ces_is_service_role()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_role text;
begin
  begin
    v_role := nullif(auth.jwt() ->> 'role', '');
  exception
    when others then
      -- An unreadable claims payload is not a service-role claim.
      v_role := null;
  end;

  -- The JWT claim is the ONLY signal used, and that is deliberate. Two
  -- alternatives were tried and REJECTED; they are recorded so the check is not
  -- "improved" back into being wrong:
  --
  --   * `current_user` cannot work here. This function is `security definer`, so
  --     inside it current_user is the function OWNER, never the caller — the very
  --     property section 2 relies on and documents. A current_user check would
  --     therefore be TRUE for every caller alike, turning the service-role
  --     exemption into a total bypass of the guard rather than a refinement.
  --   * `session_user` cannot work either: `set role` does not change it, so it
  --     reports the connection's original role and says nothing about the caller.
  --
  -- Nothing is lost by relying on the claim. A supabase-js client built with the
  -- secret key (tools/src/upload-assets.ts, tools/src/bootstrap-admins.ts)
  -- presents role='service_role' and is matched here. The operator running psql
  -- connects as the superuser that OWNS these functions and holds direct DML on
  -- every table, so it has no need of an exemption inside them —
  -- supabase/seed.sql bypasses this path entirely.
  return coalesce(v_role, '') = 'service_role';
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 2.2 THE GUARD. Every one of the thirty commands calls this first.
-- -----------------------------------------------------------------------------
-- Returns NULL when the caller may proceed, and an error envelope when they may
-- not. `null` for success rather than a result object is deliberate: it makes
-- the call site read as a single unmissable early return,
--
--   v_denied := public.ces_guard('edit', 'update-text');
--   if v_denied is not null then return v_denied; end if;
--
-- so there is no way to call the guard and forget to act on its answer, which is
-- the failure mode a boolean return invites.
--
-- FOUR CHECKS, IN THIS ORDER, and the order is the useful one — each answer is
-- more specific than the last, so the editor can say something true:
--
--   1. auth.uid() is not null      -> unauthenticated
--   2. is_active_admin_user()      -> no_membership   (covers "never a member"
--                                     AND "membership revoked", because
--                                     migration 13's helper tests is_active; a
--                                     blocked account fails here on its very
--                                     next request, before its token expires)
--   3. current_aal() = 'aal2'      -> aal2_required
--   4. has_capability(p_capability) -> capability
--
-- Check 3 relies on migration 13's decision that current_aal() returns 'aal1'
-- and never null. With null, `current_aal() = 'aal2'` would evaluate to null,
-- `not null` is null rather than true, and this check would silently pass the
-- very session it exists to stop.
--
-- IT INSERTS THE security_events ROW ITSELF, kind 'denied', and then RETURNS.
-- That is the whole reason the guard does not raise: the insert has to commit.
-- The caller may add nothing and forget nothing — every denial in the system is
-- recorded at exactly one place.
--
-- WHAT IT CANNOT SEE, stated because a reader will otherwise assume it does: a
-- direct PostgREST write that migration 17's revocation rejects produces NO row
-- here, because no function of ours runs at all. Migration 14 line 366 documents
-- that boundary and nextjs/tests/e2e/security.spec.ts asserts both halves of it.
create or replace function public.ces_guard(
  p_capability text,
  p_command    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid;
  v_reason text;
  v_msg    text;
begin
  -- The operator's key is exempt; see 2.1 for why refusing it would be theatre.
  if public.ces_is_service_role() then
    return null;
  end if;

  v_uid := auth.uid();

  if v_uid is null then
    v_reason := 'unauthenticated';
    v_msg    := 'You are not signed in.';

  elsif not public.is_active_admin_user() then
    v_reason := 'no_membership';
    v_msg    := 'This account does not have an active editing membership.';

  elsif public.current_aal() <> 'aal2' then
    v_reason := 'aal2_required';
    v_msg    := 'Confirm your second factor before making changes.';

  elsif not public.has_capability(p_capability) then
    v_reason := 'capability';
    v_msg    := 'This account does not have permission to do that.';

  else
    return null;
  end if;

  -- Recorded, then returned. Never raised: a raise would discard this insert.
  insert into public.security_events (actor_id, kind, outcome, detail)
  values (
    v_uid,
    'denied',
    v_reason,
    jsonb_build_object(
      'command',    p_command,
      'capability', p_capability,
      'aal',        public.current_aal()
    )
  );

  return public.ces_result_error(
    v_reason,
    v_msg,
    jsonb_build_object('command', p_command, 'capability', p_capability)
  );
end;
$fn$;


-- =============================================================================
-- 3. The audit writers
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 Mint a change set id.
-- -----------------------------------------------------------------------------
-- One per command invocation, shared by every revision row that command writes.
-- Trivial by design: the value carries no meaning beyond grouping, so there is
-- nothing to derive it from and nothing to make it reproducible.
create or replace function public.ces_new_change_set()
returns uuid
language sql
volatile
set search_path = ''
as $fn$
  select extensions.gen_random_uuid()
$fn$;


-- -----------------------------------------------------------------------------
-- 3.2 THE REVISION WRITER, and the one place in this file that must be allowed
--     to take the whole transaction down with it.
-- -----------------------------------------------------------------------------
-- IT CATCHES NOTHING. That is the point, and it is the deliberate inversion of
-- contract 1: everywhere else a failure returns a typed result so the audit row
-- survives, but if the AUDIT ITSELF cannot be written then there is no audit row
-- to save and the only correct outcome is for the mutation to disappear too. A
-- content change with no record of who made it is worse than a failed save,
-- because the failed save is visible and tells the editor to try again.
--
-- `p_column_name` is null for a whole-row event — create, delete, force-delete —
-- where migration 14 records the full row in value_before or value_after and
-- there is no single column to name.
--
-- `p_table_name` takes the PLURAL logical table name ('pages', 'people'), which
-- migration 14 deliberately leaves unconstrained and which is a different
-- vocabulary from migration 15's singular routing `kind` ('page', 'person').
-- Migration 15 line 402 spells out that the two must stay visibly distinct so
-- neither is ever passed where the other belongs.
create or replace function public.ces_write_revision(
  p_change_set_id uuid,
  p_table_name    text,
  p_row_id        uuid,
  p_column_name   text,
  p_value_before  jsonb,
  p_value_after   jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $fn$
  insert into public.content_revisions (
    actor_id, change_set_id, table_name, row_id,
    column_name, value_before, value_after
  )
  values (
    auth.uid(), p_change_set_id, p_table_name, p_row_id,
    p_column_name, p_value_before, p_value_after
  )
$fn$;


-- -----------------------------------------------------------------------------
-- 3.3 Log a security event that is not a guard denial.
-- -----------------------------------------------------------------------------
-- Used by section 4 for 'rate_limited' and by section 16 for 'role_change' and
-- 'revocation'. The other three kinds in migration 14's closed vocabulary —
-- 'csp', 'upload_rejected', 'media_denied' — are written by route handlers in
-- their own transactions and never reach this function.
--
-- `kind` must be one of those seven; migration 14's check constraint enforces it,
-- and a bad value here would raise rather than return, which is precisely why
-- every call site below passes a literal.
create or replace function public.ces_log_security_event(
  p_kind    text,
  p_outcome text,
  p_detail  jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $fn$
  insert into public.security_events (actor_id, kind, outcome, detail)
  values (auth.uid(), p_kind, p_outcome, coalesce(p_detail, '{}'::jsonb))
$fn$;



-- =============================================================================
-- 4. Rate limiting, counted from the database inside the mutation's transaction
-- =============================================================================
-- THE CEILINGS. These four numbers are also stated in nextjs/lib/upload-limits.ts
-- and nextjs/lib/rate-limit.ts, and THE TWO MUST AGREE. They are duplicated
-- rather than shared because the client needs them for a pre-check and the
-- database needs them for the decision; the database's copy is the one that
-- binds, and the client's copy exists only to give an editor a fast, friendly
-- refusal before a round trip.
--
--   content writes per account   300              rolling 1 hour   content_revisions
--   uploads per account           60              rolling 1 hour   assets.created_by
--   upload bytes per account     500,000,000      rolling 24 hours the reservation ledger
--
-- WHY THIS IS NOT A CACHE, A MAP OR A COUNTER TABLE. The reference
-- implementation keeps a token bucket in a module-scope JavaScript Map. On
-- serverless that is per-instance and per-cold-start, so ten concurrent lambdas
-- enforce ten independent limits and a burst is never counted at all. It is not a
-- limit; it is a comment that looks like one. It is not carried. Every count here
-- is a query against durable rows, so it holds across instances, across
-- deployments and across a restart.
--
-- WHY THE COUNTS RUN INSIDE THE MUTATION'S OWN TRANSACTION, AND WHY THEY LOCK.
-- Each of the three functions below takes `select ... for update` on the actor's
-- public.admin_users row before it counts. Without that lock, two requests
-- arriving together at position 300 would both read 300, both conclude they were
-- under the ceiling, and both commit — the classic read-then-write race, and the
-- one that matters most at exactly the boundary the limit is defending. With it,
-- the second request blocks until the first commits, then counts 301 and is
-- refused. The lock is on admin_users rather than on a counter row because the
-- actor's membership row already exists for every legitimate caller, needs no
-- separate lifecycle, and is the natural per-account mutex.
--
-- The `for update` does NOT modify the row and therefore does not fire
-- migration 13's set_updated_at trigger — a lock is not a write.
--
-- A CHECK THAT ERRORS DENIES. Every function below wraps its counting in an
-- exception block that returns a refusal. Failing open on an unexpected error
-- would make the ceiling advisory precisely when something is already wrong,
-- which is the wrong direction for a control whose purpose is to bound a
-- compromised session.
--
-- WHAT THESE ARE FOR. There are exactly two administrator accounts and no
-- anonymous write path anywhere in the system. These ceilings are not load
-- management — a preschool's two editors will never approach them. They exist to
-- bound the damage a stolen session can do before somebody notices, and to make
-- that bound observable in security_events.

-- -----------------------------------------------------------------------------
-- 4.1 Content writes: 300 per rolling hour, counted from content_revisions.
-- -----------------------------------------------------------------------------
-- Counting the AUDIT rather than the mutations is the right choice and not an
-- accident of convenience: content_revisions is written by every command in this
-- file without exception, so the count cannot be evaded by a command that
-- forgot to increment something. The audit trail is the meter.
--
-- Note that a multi-row command writes several revision rows and therefore
-- consumes several units. That is intended: a reparent that rewrites twenty
-- descendant paths did twenty times the work of a single field edit, and the
-- ceiling is there to bound work.
create or replace function public.ces_check_write_rate()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_ceiling  constant integer  := 300;
  c_window   constant interval := interval '1 hour';
  v_uid      uuid;
  v_count    integer;
  v_oldest   timestamptz;
  v_resets   timestamptz;
begin
  if public.ces_is_service_role() then
    return null;
  end if;

  v_uid := auth.uid();

  if v_uid is null then
    -- Unreachable behind the guard, which rejects an absent uid first. Denying
    -- rather than returning null keeps this function safe if it is ever called
    -- on its own.
    return public.ces_result_error(
      'unauthenticated', 'You are not signed in.'
    );
  end if;

  begin
    -- The per-account mutex. See the section note on why it is here.
    perform 1
      from public.admin_users au
     where au.user_id = v_uid
       for update;

    select count(*), min(cr.created_at)
      into v_count, v_oldest
      from public.content_revisions cr
     where cr.actor_id = v_uid
       and cr.created_at > timezone('utc', now()) - c_window;
  exception
    when others then
      -- A limit check that cannot answer denies. Never fails open.
      return public.ces_result_error(
        'rate_limited',
        'Could not verify your recent edit volume. Please try again shortly.',
        jsonb_build_object('limit', 'content_writes', 'check_failed', true)
      );
  end;

  if v_count < c_ceiling then
    return null;
  end if;

  -- The window is rolling, so it frees up when the OLDEST counted row ages out.
  -- The editor shows this instant rather than retrying blindly.
  v_resets := coalesce(v_oldest, timezone('utc', now())) + c_window;

  perform public.ces_log_security_event(
    'rate_limited',
    'content_writes',
    jsonb_build_object(
      'limit',    'content_writes',
      'ceiling',  c_ceiling,
      'window',   '1 hour',
      'observed', v_count,
      'resets_at', v_resets
    )
  );

  return public.ces_result_error(
    'rate_limited',
    'You have reached the hourly limit for content changes.',
    jsonb_build_object(
      'limit', 'content_writes', 'ceiling', c_ceiling,
      'observed', v_count, 'resets_at', v_resets
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 4.2 Uploads: 60 per rolling hour, counted from assets.created_by.
-- -----------------------------------------------------------------------------
-- Counts every row the account created in the window regardless of lifecycle,
-- INCLUDING trashed ones. A rejected upload still consumed a signed URL, a
-- quarantine object and an inspection, so it counts against the frequency
-- ceiling — unlike the BYTE quota in 4.3, where a rejection releases
-- immediately because the bytes never became durable. The two ceilings measure
-- different things and so treat rejection differently, which is deliberate.
create or replace function public.ces_check_upload_rate()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_ceiling  constant integer  := 60;
  c_window   constant interval := interval '1 hour';
  v_uid      uuid;
  v_count    integer;
  v_oldest   timestamptz;
  v_resets   timestamptz;
begin
  if public.ces_is_service_role() then
    return null;
  end if;

  v_uid := auth.uid();

  if v_uid is null then
    return public.ces_result_error(
      'unauthenticated', 'You are not signed in.'
    );
  end if;

  begin
    perform 1
      from public.admin_users au
     where au.user_id = v_uid
       for update;

    select count(*), min(a.created_at)
      into v_count, v_oldest
      from public.assets a
     where a.created_by = v_uid
       and a.created_at > timezone('utc', now()) - c_window;
  exception
    when others then
      return public.ces_result_error(
        'rate_limited',
        'Could not verify your recent upload volume. Please try again shortly.',
        jsonb_build_object('limit', 'uploads', 'check_failed', true)
      );
  end;

  if v_count < c_ceiling then
    return null;
  end if;

  v_resets := coalesce(v_oldest, timezone('utc', now())) + c_window;

  perform public.ces_log_security_event(
    'rate_limited',
    'uploads',
    jsonb_build_object(
      'limit', 'uploads', 'ceiling', c_ceiling, 'window', '1 hour',
      'observed', v_count, 'resets_at', v_resets
    )
  );

  return public.ces_result_error(
    'rate_limited',
    'You have reached the hourly upload limit.',
    jsonb_build_object(
      'limit', 'uploads', 'ceiling', c_ceiling,
      'observed', v_count, 'resets_at', v_resets
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 4.3 Upload bytes: 500,000,000 per rolling 24 hours, from the RESERVATION
--     LEDGER — reserved at sign time, never measured afterwards.
-- -----------------------------------------------------------------------------
-- THE DESIGN POINT, because getting this wrong makes the quota decorative. A
-- quota counted from assets.size_bytes CANNOT bind an upload: /api/uploads/sign
-- hands the browser a signed URL and the browser then pushes straight to
-- Storage, so at the instant the ceiling has to be enforced the bytes do not
-- exist yet and size_bytes is null. Counting after the fact would let one
-- account sign fifty URLs and upload every one of them.
--
-- So the ledger sums TWO things across the window, and the sum is what the
-- ceiling is tested against:
--
--   declared_size_bytes  for rows in 'reserved', 'uploaded' or 'inspecting'
--                        WHOSE reservation_expires_at HAS NOT PASSED
--   size_bytes           for rows in 'stored'
--
-- One ledger, so an in-flight upload consumes quota exactly as a completed one
-- does and there is no window in which a reservation is invisible.
--
-- 'trashed' IS NOT IN THE COUNTED SET. A rejected upload releases its quota the
-- moment finalize marks the row trashed — the bytes never became durable, so
-- charging for them would punish an editor for a failed magic-byte check.
--
-- RECONCILIATION NEEDS NO JOB. The `reservation_expires_at > now()` predicate
-- means an abandoned reservation stops consuming quota the instant it lapses,
-- with nothing to run and nothing to clean up first. The guarded sweep in
-- /api/cleanup/orphans later removes the row and any orphan quarantine object,
-- but the quota has already been released by arithmetic.
--
-- THE OTHER HALF OF THIS CONTRACT IS IN 14.2: finalize requires the object's
-- actual length to match declared_size_bytes within 1%, so the declared figure
-- cannot be understated to slip past this ceiling.
--
-- `p_declared_size_bytes` is the request's own declaration and is included in
-- the sum before the comparison, so the check answers "would this upload exceed
-- the ceiling" rather than "has the ceiling already been exceeded".
create or replace function public.ces_check_upload_bytes(
  p_declared_size_bytes bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_ceiling   constant bigint   := 500000000;
  c_window    constant interval := interval '24 hours';
  v_uid       uuid;
  v_committed bigint;
  v_would_be  bigint;
  v_oldest    timestamptz;
  v_resets    timestamptz;
begin
  if public.ces_is_service_role() then
    return null;
  end if;

  v_uid := auth.uid();

  if v_uid is null then
    return public.ces_result_error(
      'unauthenticated', 'You are not signed in.'
    );
  end if;

  if p_declared_size_bytes is null or p_declared_size_bytes < 0 then
    return public.ces_result_error(
      'invalid',
      'A non-negative declared byte length is required to reserve an upload.',
      jsonb_build_object('declared_size_bytes', p_declared_size_bytes)
    );
  end if;

  begin
    perform 1
      from public.admin_users au
     where au.user_id = v_uid
       for update;

    select
      coalesce(sum(
        case
          -- In flight: the declaration, but only while the reservation stands.
          when a.lifecycle in ('reserved', 'uploaded', 'inspecting')
               and a.reservation_expires_at is not null
               and a.reservation_expires_at > timezone('utc', now())
            then coalesce(a.declared_size_bytes, 0)
          -- Durable: the measured length.
          when a.lifecycle = 'stored'
            then coalesce(a.size_bytes, 0)
          -- 'trashed', and any lapsed reservation, contribute nothing.
          else 0
        end
      ), 0),
      min(a.created_at)
      into v_committed, v_oldest
      from public.assets a
     where a.created_by = v_uid
       and a.created_at > timezone('utc', now()) - c_window;
  exception
    when others then
      return public.ces_result_error(
        'rate_limited',
        'Could not verify your upload quota. Please try again shortly.',
        jsonb_build_object('limit', 'upload_bytes', 'check_failed', true)
      );
  end;

  v_would_be := v_committed + p_declared_size_bytes;

  if v_would_be <= c_ceiling then
    return null;
  end if;

  v_resets := coalesce(v_oldest, timezone('utc', now())) + c_window;

  perform public.ces_log_security_event(
    'rate_limited',
    'upload_bytes',
    jsonb_build_object(
      'limit', 'upload_bytes', 'ceiling', c_ceiling, 'window', '24 hours',
      'committed', v_committed, 'requested', p_declared_size_bytes,
      'resets_at', v_resets
    )
  );

  return public.ces_result_error(
    'rate_limited',
    'This upload would exceed your daily upload allowance.',
    jsonb_build_object(
      'limit', 'upload_bytes', 'ceiling', c_ceiling,
      'committed', v_committed, 'requested', p_declared_size_bytes,
      'resets_at', v_resets
    )
  );
end;
$fn$;



-- =============================================================================
-- 5. Optimistic conflict rejection, at ROW granularity, deliberately
-- =============================================================================
-- THE POLICY IS NOT LAST-WRITE-WINS. Every editable field is rendered carrying
-- the `updated_at` its row held when it was read. On commit the write function
-- compares that value with the row's current one, and if the row has moved on it
-- REFUSES and hands back the current value, which the editor surfaces as "this
-- field changed elsewhere — reload to see the current value" with an explicit
-- "keep mine" that re-submits against the new timestamp. A lost edit is silent;
-- a refused edit is not, and a refusal the editor can act on is strictly better
-- than a change that quietly disappears.
--
-- THE CHECK IS PER ROW, NOT PER COLUMN, AND THAT IS A DECISION — DO NOT "FIX" IT.
-- Two editors changing DIFFERENT columns of the same row will conflict on the
-- second write even though their edits do not overlap. That false conflict is
-- accepted knowingly: this is a school with two accounts, so it will happen
-- rarely, and the alternative — comparing per column — needs per-column
-- timestamps that do not exist and would have to be invented and maintained on
-- every table. Between a rare unnecessary reload and a possible lost edit, the
-- reload is the cheaper failure. nextjs/tests asserts BOTH the same-column and
-- the different-column case, and the second test is there specifically so that
-- anyone who "corrects" this behaviour has to delete a passing test that says it
-- is intentional.
--
-- A NULL EXPECTED TIMESTAMP SKIPS THE CHECK. That is how create paths and
-- non-field commands (reorder, publish from a collection list, restore) call
-- through without inventing a timestamp they never read. Field editors always
-- supply one; migration 05 line 706 records that this is what page_sections'
-- updated_at is for.
--
-- WHY DYNAMIC SQL IS SAFE HERE. `p_table` is checked against a closed allowlist
-- before it is interpolated, and it is interpolated with %I, so no value that
-- reaches format() can be anything but one of these sixteen identifiers. The
-- statement also only ever READS updated_at — this function writes nothing, so
-- even a hypothetical escape could not mutate anything. public.admin_users is
-- absent from the list on purpose: its primary key is user_id rather than id,
-- and the account commands in section 16 carry their own invariants instead of
-- optimistic concurrency. public.person_roles is absent because it has no
-- updated_at column at all — it is a pure join with only created_at.
create or replace function public.ces_check_conflict(
  p_table                text,
  p_row_id               uuid,
  p_expected_updated_at  timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_current timestamptz;
begin
  -- The caller did not read a timestamp, so there is nothing to compare.
  if p_expected_updated_at is null then
    return null;
  end if;

  if p_table not in (
    'pages', 'page_sections', 'people', 'person_education',
    'events', 'classrooms', 'classroom_teachers', 'page_classrooms',
    'promoted', 'promoted_links', 'announcements', 'inspiring_quotes',
    'taxonomy_terms', 'assets', 'site_globals', 'nav_items'
  ) then
    return public.ces_result_error(
      'invalid',
      'That table cannot be checked for edit conflicts.',
      jsonb_build_object('table', p_table)
    );
  end if;

  execute format('select u.updated_at from public.%I u where u.id = $1', p_table)
     into v_current
    using p_row_id;

  if v_current is null then
    return public.ces_result_error(
      'not_found',
      'That record no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  if v_current = p_expected_updated_at then
    return null;
  end if;

  return public.ces_result_error(
    'conflict',
    'This record changed elsewhere. Reload to see the current value.',
    jsonb_build_object(
      'table',       p_table,
      'row_id',      p_row_id,
      'expected_updated_at', p_expected_updated_at,
      'current_updated_at',  v_current
    )
  );
end;
$fn$;


-- =============================================================================
-- 6. Blueprint character limits — enforced on writes, never on the corpus
-- =============================================================================
-- THREE LIMITS, and they are enforced HERE rather than as check constraints for
-- one concrete reason: the existing content violates most of them, and a check
-- constraint would abort the canonical seed load. Migration 04 line 522 and
-- migration 10 both delegate the enforcement to this file by name, and both say
-- "do not add a check constraint here".
--
--   announcements.title       <= 30   resources/blueprints/collections/
--                                     announcements/announcements.yaml:16
--                                     ALL FOUR existing values violate it:
--                                     56, 55, 44 and 69 characters.
--   pages.short_description   <= 300  resources/blueprints/collections/pages/
--                                     programsumbrella.yaml — handle at line 30,
--                                     character_limit: '300' at line 32.
--                                     TWO of the four umbrella values violate
--                                     it: 606 and 379 characters.
--   events.short_description  <= 500  resources/blueprints/collections/events/
--                                     events.yaml:95. Corpus maximum is 448, so
--                                     there are no violations here.
--
-- NOTE THE ATTRIBUTION ON THE MIDDLE ONE. The limit belongs to
-- `short_description`, NOT to `description`: programsumbrella.yaml declares
-- `description` at line 54 with no character_limit whatsoever. Verified against
-- the blueprint rather than inherited from prose, and migration 04's own column
-- comments say the same in both directions. The grandfathered set across the
-- corpus is therefore SIX rows — four titles and two short descriptions — not
-- three descriptions.
--
-- These numbers are also in nextjs/lib/schema.ts, which drives the editor's
-- character counter. THE TWO MUST AGREE: the counter is a courtesy and this
-- function is the decision.
--
--
-- THE GRANDFATHERING POLICY, decided here and stated so nobody has to guess.
-- Grandfathering is worthless if it makes the six legacy rows unsavable — an
-- editor who opens the 69-character announcement, fixes a typo elsewhere on the
-- page and hits confirm must not be told the title is too long. So a write is
-- allowed when ANY of these holds:
--
--   1. the new value is within the limit                     — the normal case;
--   2. the new value is byte-identical to the stored value   — a no-op re-save
--      of a grandfathered value can never be blocked, which is what keeps those
--      six rows editable in place;
--   3. the stored value already exceeds the limit AND the new value is strictly
--      shorter than it                                       — monotonic
--      improvement. Shortening 606 characters to 400 is progress and is
--      accepted even though 400 still exceeds 300; it can only ever converge on
--      compliance, never away from it.
--
-- and is refused otherwise — which is exactly the case that matters: a NEW value
-- that is over the limit, on a row that was not already over it, or one that
-- makes an already-over row worse.
--
-- THE POLICY IS A RATCHET, which is the property that makes it safe. Clause 3
-- only ever admits a value strictly shorter than the one already stored, so a
-- grandfathered row can move toward the limit and never away from it, and the
-- moment it reaches compliance clause 1 takes over and clause 3 can never apply
-- to it again. There is therefore no sequence of allowed writes that turns a
-- compliant row into an over-length one, and the six legacy rows can only
-- converge. Verified against the real 69-character announcement title.
--
-- Each over-length legacy row is listed in artifacts/parity-report.json for the
-- school to shorten at their leisure. Nothing in this file shortens anything.
create or replace function public.ces_check_length(
  p_table         text,
  p_column        text,
  p_new_value     text,
  p_current_value text
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $fn$
declare
  v_limit integer;
  v_new   integer;
  v_cur   integer;
begin
  v_limit := case
    when p_table = 'announcements' and p_column = 'title'             then 30
    when p_table = 'pages'         and p_column = 'short_description' then 300
    when p_table = 'events'        and p_column = 'short_description' then 500
    else null
  end;

  -- No declared limit for this column: nothing to enforce.
  if v_limit is null then
    return null;
  end if;

  -- A null or empty new value cannot be too long. Whether it is ALLOWED to be
  -- null is a not-null question and belongs to the column, not here.
  if p_new_value is null then
    return null;
  end if;

  v_new := length(p_new_value);

  if v_new <= v_limit then
    return null;                                        -- policy clause 1
  end if;

  v_cur := length(coalesce(p_current_value, ''));

  if p_current_value is not null and p_new_value = p_current_value then
    return null;                                        -- policy clause 2
  end if;

  if v_cur > v_limit and v_new < v_cur then
    return null;                                        -- policy clause 3
  end if;

  return public.ces_result_error(
    'invalid',
    format(
      'That value is %s characters; the limit for this field is %s.',
      v_new, v_limit
    ),
    jsonb_build_object(
      'table', p_table, 'column', p_column,
      'limit', v_limit, 'length', v_new,
      'grandfathered', (v_cur > v_limit)
    )
  );
end;
$fn$;


-- =============================================================================
-- 7. assert_route_available — enforcement point 2 of four, and the locked one
-- =============================================================================
-- ITS FIRST ACT IS THE ADVISORY LOCK. Not its second, and not conditional on
-- anything. That ordering is the whole mechanism.
--
-- WHY A UNIQUE CONSTRAINT CANNOT DO THIS JOB. Four tables contribute to the URL
-- space — pages, classrooms, people, events — and each can independently hold a
-- row that resolves to the same path. `pages.path` is unique within pages, and
-- that is all it can be. public.content_routes is a `union all` VIEW, and a view
-- carries no constraint of its own, so there is nothing to make a path unique
-- ACROSS the four.
--
-- WHY A BARE EXISTENCE CHECK CANNOT DO IT EITHER, which is the subtler half.
-- Two transactions creating the same path in DIFFERENT tables would each run
-- `select ... where path = $1`, each see nothing — neither has committed, so
-- neither is visible to the other under any isolation level Postgres offers for
-- this read — and both would commit. The result is two rows claiming one path,
-- with migration 15's `precedence` quietly hiding one of them: a live collision
-- that looks like working software. Read committed does not prevent it, and
-- repeatable read would only convert it into a serialization error some of the
-- time, on one of the two.
--
-- WITH THE LOCK, they serialize on the path itself. hashtext('route:' || path)
-- is a value both transactions compute identically, so the second blocks in
-- pg_advisory_xact_lock until the first COMMITS, then performs its read, sees
-- the committed row, and is refused with the conflicting kind and id named so
-- the editor can say which record already owns the URL. The lock is transaction
-- scoped, so it is released at commit or rollback with nothing to unlock and no
-- way to leak it.
--
-- THE OTHER THREE ENFORCEMENT POINTS, so this one is not mistaken for the whole
-- mechanism: (1) a terminal per-path count check inside supabase/seed.sql's own
-- transaction, which aborts the load on any duplicate; (3) the deterministic
-- `precedence` integer in migration 15's view — pages 1, classrooms 2, people 3,
-- events 4 — with the route handler selecting `order by precedence limit 1`, so
-- behaviour stays DEFINED even under an unexpected duplicate; and (4) CI's
-- db-and-parity job asserting one row per path after `supabase db reset`.
--
-- p_exclude_kind TAKES MIGRATION 15's EXACT SINGULAR VOCABULARY: 'page',
-- 'classroom', 'person', 'event'. This is the argument migration 15 line 385
-- warns about — a plural on either side would make the exclusion never match,
-- and then EVERY slug re-save would be rejected as a collision with itself.
-- The pair is compared with `is not distinct from` so that passing nulls (a
-- create, which excludes nothing) includes every row rather than, through
-- three-valued logic, excluding all of them.
--
-- WHY THIS SEES DRAFTS. content_routes is declared `security_invoker = true`, so
-- it evaluates under the current user's rights — and inside this security
-- definer function that is the table owner, who bypasses RLS because migrations
-- 04 to 08 enable row level security without forcing it. Seeing unpublished rows
-- is REQUIRED, not incidental: a draft page still owns its path, and letting a
-- new entry take a draft's URL would produce a collision that appears the moment
-- the draft is published.
create or replace function public.assert_route_available(
  p_path         text,
  p_exclude_kind text default null,
  p_exclude_id   uuid  default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_kind text;
  v_id   uuid;
begin
  if p_path is null or p_path = '' then
    return public.ces_result_error(
      'invalid', 'A route path is required.'
    );
  end if;

  -- FIRST. Before the read, unconditionally. See the note above.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('route:' || p_path)
  );

  select r.kind, r.id
    into v_kind, v_id
    from public.content_routes r
   where r.path = p_path
     and not (
       r.kind is not distinct from p_exclude_kind
       and r.id is not distinct from p_exclude_id
     )
   order by r.precedence
   limit 1;

  if v_kind is null then
    return null;
  end if;

  return public.ces_result_error(
    'route_conflict',
    format('The address %s is already in use.', p_path),
    jsonb_build_object(
      'path', p_path,
      'conflicting_kind', v_kind,
      'conflicting_id',   v_id
    )
  );
end;
$fn$;



-- =============================================================================
-- 8. Page tree helpers
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 8.1 Slug shape.
-- -----------------------------------------------------------------------------
-- Lowercase alphanumerics and single hyphens. Not cosmetic: a slug containing a
-- slash would silently forge a path segment and let one entry claim another
-- entry's namespace, and a slug with a space or an uppercase letter would
-- produce a URL that does not match the one the editor was shown. Every legacy
-- slug in the corpus satisfies this, including the awkward ones —
-- 'school-age-mandarin-for-grades-k-through-3rd' and
-- '2023-24-admissions-season-now-open-apply-today'.
create or replace function public.ces_valid_slug(p_slug text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select p_slug is not null
     and p_slug <> ''
     and p_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
$fn$;


-- -----------------------------------------------------------------------------
-- 8.2 Materialize a page path from its parent and slug.
-- -----------------------------------------------------------------------------
-- Reproduces content/collections/pages.yaml's route '{parent_uri}/{slug}' and
-- nothing else. There is exactly one implementation of this rule in the target,
-- and it is this function: migration 04 materialized the column from
-- content/trees/collections/pages.yaml at load time, and every later mutation
-- comes through here, so the two cannot drift into disagreement.
--
-- THE ROOT-PAGE CASE. pages.yaml sets structure.root = true, which is why home's
-- path is '/' and not '/home'. Home's slug is still 'home'; only its path is
-- special. This function is therefore never used to compute home's own path —
-- reparent_page refuses to move the site root and update_slug leaves a '/' path
-- alone — but it DOES have to handle a page whose PARENT is the root, and it
-- collapses that correctly: with parent path '/', a child is '/<slug>' rather
-- than '//<slug>'.
create or replace function public.ces_page_path(
  p_parent_id uuid,
  p_slug      text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_parent_path text;
begin
  if p_parent_id is null then
    return '/' || p_slug;
  end if;

  select p.path into v_parent_path
    from public.pages p
   where p.id = p_parent_id;

  if v_parent_path is null then
    -- Caller's job to validate the parent exists; returning null lets it say so
    -- with a typed result instead of building a nonsense path.
    return null;
  end if;

  if v_parent_path = '/' then
    return '/' || p_slug;
  end if;

  return v_parent_path || '/' || p_slug;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 8.3 Depth of a page, 1-based.
-- -----------------------------------------------------------------------------
-- A root is depth 1 and its child is depth 2. content/collections/pages.yaml:9
-- sets structure.max_depth: 2, so depth 2 is the floor of the tree and a
-- grandchild is not a legal state. Section 13's reparent_page is the only thing
-- that can create one and it refuses to.
--
-- Recursive rather than derived from `path`, because counting slashes in a path
-- would get the root wrong ('/' has one slash and is depth 1; '/about' also has
-- one and is also depth 1) and would be a second, disagreeing definition of the
-- hierarchy. The tree is parent_id; path is its projection.
create or replace function public.ces_page_depth(p_page_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  with recursive ancestry (id, parent_id, depth) as (
    select p.id, p.parent_id, 1
      from public.pages p
     where p.id = p_page_id
    union all
    select p.id, p.parent_id, a.depth + 1
      from public.pages p
      join ancestry a on a.parent_id = p.id
  )
  select max(depth) from ancestry
$fn$;


-- -----------------------------------------------------------------------------
-- 8.4 Height of a page's own subtree, 1-based.
-- -----------------------------------------------------------------------------
-- 1 for a leaf, 2 for a page with children. Needed by reparent_page: moving a
-- page that HAS children under a new parent must keep the deepest descendant
-- within max_depth, so the test is on the whole subtree and not only on the page
-- being moved. Checking the page alone is the bug this function exists to
-- prevent.
create or replace function public.ces_page_subtree_height(p_page_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  with recursive subtree (id, height) as (
    select p.id, 1
      from public.pages p
     where p.id = p_page_id
    union all
    select p.id, s.height + 1
      from public.pages p
      join subtree s on p.parent_id = s.id
  )
  select max(height) from subtree
$fn$;


-- =============================================================================
-- 9. published_reference_count — THE single asset visibility predicate
-- =============================================================================
-- Stated once, applied in five places:
--
--   An asset belongs in the public `media` bucket IF AND ONLY IF
--   published_reference_count(asset_id) > 0. At zero it belongs in
--   `media-private`.
--
-- ELEVEN REFERENCE SOURCES, which is every foreign key pointing at
-- public.assets in the entire schema. Verified by grepping `references
-- public.assets` across migrations 02 to 11 rather than by reading the plan:
--
--   pages.main_image_asset_id       pages.program_image_asset_id
--   pages.og_image_id               page_sections.asset_id
--   people.photo_asset_id           people.og_image_id
--   events.image_asset_id           events.og_image_id
--   classrooms.og_image_id          promoted.image_asset_id
--   site_globals.asset_id
--
-- Note that public.classrooms has NO image_asset_id — only og_image_id — and
-- that public.announcements and public.inspiring_quotes reference no asset at
-- all. Adding a twelfth reference column anywhere in the schema means editing
-- this function in the same migration, or the new reference will not keep its
-- image public.
--
-- FOR A CHILD ROW, THE OWNING PAGE'S published FLAG GOVERNS. page_sections has
-- no published column of its own, so a section's visibility is entirely its
-- page's. AND a section with enabled = false DOES NOT COUNT: migration 05 gives
-- that column to the seven records the source carries as `enabled: false`, and a
-- disabled section renders to nobody, so its image is not public by virtue of it.
--
-- A PUBLIC site_globals KEY ALWAYS COUNTS. There is no published flag on
-- globals; `public` is the equivalent, and it is what keeps the logo — the one
-- global carrying an asset_id — reachable by an anonymous visitor. A non-public
-- key's asset does not count, which is the correct answer for a value the school
-- has not exposed yet.
--
--
-- THE TRAP THIS FUNCTION EXISTS TO AVOID, recorded because an earlier draft of
-- the design had it backwards and the inverted version reads just as plausibly:
--
--   WRONG: "promote only assets whose remaining references are ALL published."
--
-- Under that rule an image would be forced private whenever ANY draft row
-- referenced it — so a PUBLISHED page sharing a photograph with a draft page
-- would render a broken image. Sharing is common in this corpus, so that
-- failure would have been visible on day one, on real pages, to real visitors.
--
-- The correct rule is EXISTENTIAL, not universal: one published reference is
-- enough to make the bytes public, because those bytes are already on a page
-- anyone can see. Three tests pin the cases the universal rule gets wrong — an
-- asset referenced by one draft and one published row is public and stays public
-- when the draft is edited; unpublishing one of two published referrers demotes
-- nothing; only unpublishing the LAST published referrer demotes.
--
-- `count(*)` over a `union all` rather than `exists`: the number itself is what
-- section 12's set_published reports back in its detail payload, and knowing
-- there are three remaining referrers rather than one is what lets the editor
-- explain a refusal.
create or replace function public.published_reference_count(p_asset_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::integer from (

    select 1
      from public.pages p
     where p.published
       and p_asset_id in (
         p.main_image_asset_id, p.program_image_asset_id, p.og_image_id
       )

    union all

    -- The owning page's flag governs, and a disabled section counts for nothing.
    select 1
      from public.page_sections s
      join public.pages p on p.id = s.page_id
     where p.published
       and s.enabled
       and s.asset_id = p_asset_id

    union all

    select 1
      from public.people pe
     where pe.published
       and p_asset_id in (pe.photo_asset_id, pe.og_image_id)

    union all

    select 1
      from public.events e
     where e.published
       and p_asset_id in (e.image_asset_id, e.og_image_id)

    union all

    select 1
      from public.classrooms c
     where c.published
       and c.og_image_id = p_asset_id

    union all

    select 1
      from public.promoted pr
     where pr.published
       and pr.image_asset_id = p_asset_id

    union all

    -- No published column here; `public` is the equivalent, and this clause is
    -- what keeps the logo anonymously reachable.
    select 1
      from public.site_globals g
     where g.public
       and g.asset_id = p_asset_id

  ) refs
$fn$;


-- -----------------------------------------------------------------------------
-- 9.1 The bucket an asset SHOULD be in, from the predicate above.
-- -----------------------------------------------------------------------------
-- The five operations that recompute visibility — upload finalize, publish,
-- unpublish, replace and delete — all ask this rather than deciding for
-- themselves, so there is one rule and not five.
--
-- 'media-quarantine' is never returned: it is a staging bucket for bytes that
-- have not been inspected yet, not a visibility outcome, and finalize moves a
-- row out of it rather than into it.
create or replace function public.ces_required_bucket(p_asset_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when public.published_reference_count(p_asset_id) > 0 then 'media'
    else 'media-private'
  end
$fn$;


-- -----------------------------------------------------------------------------
-- 9.2 The move plan: which of these assets are now in the wrong bucket.
-- -----------------------------------------------------------------------------
-- Returns one entry per asset whose CURRENT bucket differs from the bucket the
-- section 9 predicate now requires, and nothing at all for the assets that are
-- already where they belong. "Only if the required bucket differs" is the whole
-- condition, and answering it here means the five operations that recompute
-- visibility cannot each decide it differently.
--
-- THIS FUNCTION MOVES NOTHING. It cannot: the bytes live in Supabase Storage and
-- Postgres has no reach into it. What it produces is a plan, returned in the
-- calling command's `detail` payload, which the route handler executes as a
-- copy, a verification and only then a delete — and then records by calling
-- public.commit_asset_bucket (section 14.1). Pretending the row update and the
-- object move were one transaction is exactly the claim section 14 refuses to
-- make; a plan plus an explicit commit is the honest decomposition, and it is
-- why a failure leaves the object in one place rather than none.
--
-- An asset in 'media-quarantine' is skipped: it has not been inspected yet, so
-- its destination is finalize's to decide and not this function's.
create or replace function public.ces_asset_move_plan(p_asset_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'asset_id',        a.id,
        'current_bucket',  a.bucket,
        'required_bucket', public.ces_required_bucket(a.id),
        'published_references', public.published_reference_count(a.id)
      )
    ),
    '[]'::jsonb
  )
  from public.assets a
  where a.id = any (coalesce(p_asset_ids, array[]::uuid[]))
    and a.bucket <> 'media-quarantine'
    and a.bucket <> public.ces_required_bucket(a.id)
$fn$;


-- -----------------------------------------------------------------------------
-- 9.3 Which rows reference an asset — the blockers a refused delete names.
-- -----------------------------------------------------------------------------
-- Every inbound foreign key to public.assets is a plain `references` with NO
-- referential action, which migration 02 line 431 states as a deliberate
-- contract: `on delete set null` is not merely undesirable but IMPOSSIBLE for
-- promoted.image_asset_id, which is not null, and silently nulling a required
-- image is worse than refusing the delete; `on delete cascade` would let
-- removing one photograph delete the content row that displays it.
--
-- So the database blocks the delete either way, and this function exists so the
-- refusal is USEFUL: the editor lists the referencing rows and the operator can
-- go and detach them, instead of reading a foreign-key violation.
--
-- Unlike the visibility predicate, this counts references regardless of publish
-- state — a draft page referencing an asset is still a reason not to delete the
-- bytes out from under it.
create or replace function public.ces_asset_reference_rows(p_asset_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(r), '[]'::jsonb)
    from (

      select jsonb_build_object(
               'table', 'pages', 'id', p.id, 'title', p.title,
               'column', case
                 when p.main_image_asset_id = p_asset_id then 'main_image_asset_id'
                 when p.program_image_asset_id = p_asset_id then 'program_image_asset_id'
                 else 'og_image_id'
               end
             ) as r
        from public.pages p
       where p_asset_id in (
               p.main_image_asset_id, p.program_image_asset_id, p.og_image_id
             )

      union all

      select jsonb_build_object(
               'table', 'page_sections', 'id', s.id,
               'title', s.kind, 'column', 'asset_id'
             )
        from public.page_sections s
       where s.asset_id = p_asset_id

      union all

      select jsonb_build_object(
               'table', 'people', 'id', pe.id, 'title', pe.name,
               'column', case
                 when pe.photo_asset_id = p_asset_id then 'photo_asset_id'
                 else 'og_image_id'
               end
             )
        from public.people pe
       where p_asset_id in (pe.photo_asset_id, pe.og_image_id)

      union all

      select jsonb_build_object(
               'table', 'events', 'id', e.id, 'title', e.title,
               'column', case
                 when e.image_asset_id = p_asset_id then 'image_asset_id'
                 else 'og_image_id'
               end
             )
        from public.events e
       where p_asset_id in (e.image_asset_id, e.og_image_id)

      union all

      select jsonb_build_object(
               'table', 'classrooms', 'id', c.id, 'title', c.title,
               'column', 'og_image_id'
             )
        from public.classrooms c
       where c.og_image_id = p_asset_id

      union all

      select jsonb_build_object(
               'table', 'promoted', 'id', pr.id, 'title', pr.title,
               'column', 'image_asset_id'
             )
        from public.promoted pr
       where pr.image_asset_id = p_asset_id

      union all

      select jsonb_build_object(
               'table', 'site_globals', 'id', g.id, 'title', g.key,
               'column', 'asset_id'
             )
        from public.site_globals g
       where g.asset_id = p_asset_id

    ) rows
$fn$;


-- -----------------------------------------------------------------------------
-- 9.4 Every asset one content row points at.
-- -----------------------------------------------------------------------------
-- Used by set_published, delete_entry and force_delete_entry to build a move
-- plan: publishing or removing a row changes the reference graph for every image
-- it touches, and each of those images may now belong in a different bucket.
--
-- FOR A PAGE THIS INCLUDES ITS SECTIONS' ASSETS, which is the case a naive
-- implementation misses. A page's photography mostly hangs off page_sections
-- rather than off the page row itself, so publishing a page with three image
-- sections must re-evaluate those three images and not merely main_image and the
-- OG image. Returning only the parent row's own columns would leave section
-- imagery private on a freshly published page.
create or replace function public.ces_row_asset_ids(
  p_table  text,
  p_row_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(distinct x), array[]::uuid[])
    from (
      select unnest(array[
               p.main_image_asset_id, p.program_image_asset_id, p.og_image_id
             ]) as x
        from public.pages p
       where p_table = 'pages' and p.id = p_row_id

      union all

      -- The page's own sections, which is where most page imagery lives.
      select s.asset_id
        from public.page_sections s
       where p_table = 'pages' and s.page_id = p_row_id

      union all

      select s.asset_id
        from public.page_sections s
       where p_table = 'page_sections' and s.id = p_row_id

      union all

      select unnest(array[pe.photo_asset_id, pe.og_image_id])
        from public.people pe
       where p_table = 'people' and pe.id = p_row_id

      union all

      select unnest(array[e.image_asset_id, e.og_image_id])
        from public.events e
       where p_table = 'events' and e.id = p_row_id

      union all

      select c.og_image_id
        from public.classrooms c
       where p_table = 'classrooms' and c.id = p_row_id

      union all

      select pr.image_asset_id
        from public.promoted pr
       where p_table = 'promoted' and pr.id = p_row_id
    ) ids
   where x is not null
$fn$;


-- =============================================================================
-- 10. get_maintenance_state — the ONE privileged read on the anonymous path
-- =============================================================================
-- nextjs/proxy.ts must evaluate maintenance mode on EVERY request, anonymous
-- ones included, and it must do so before it can know whether the caller is an
-- editor entitled to bypass it. But the four maintenance rows in
-- public.site_globals are the only rows in that table with public = false —
-- migration 11 made them private deliberately, so an anonymous visitor cannot
-- read the interstitial's wording before the school has ever used it. The
-- cookie-free anonymous client therefore cannot read them.
--
-- THE RESOLUTION, and the reason this is the only function in this file granted
-- to `anon`: one security definer function that answers only the question the
-- request boundary actually asks. To an unidentified caller it returns
-- `enabled` and `retry_after` — a boolean and an integer, which disclose nothing
-- about the school — and it adds `title` and `message` ONLY for a verified
-- active member. Migration 13 line 520 names this function as the single
-- exception to its rule that no privileged read exists on the anonymous path.
--
-- WIDENING THE RETURN SHAPE WOULD LEAK THE COPY. Do not add the title and
-- message to the unauthenticated branch "because they are only shown during
-- maintenance anyway": the whole point of `public = false` on those two rows is
-- that the school's not-yet-used wording is not readable in advance, and this
-- function is the one place that could hand it out.
--
-- IT NEVER RAISES AND NEVER RETURNS NULL. With no rows present at all — a schema
-- pushed but not yet seeded, which is a real state during cutover — it returns
-- enabled false and the 3600-second default that migration 11 seeds, so the
-- request boundary gets a usable answer rather than an error on every request to
-- the site. Defaulting to `false` is also the safe direction: a failure to read
-- the flag must not take the site down.
--
-- The result is cached under the `content:globals` tag and invalidated by
-- update-globals in section 13, so this is one query per revalidation window and
-- not one per request.
--
-- `is_active_admin_user()` covers both roles, which is correct here: an editor
-- working behind a maintenance screen needs to see the copy they are working
-- against even though only an admin can change it.
create or replace function public.get_maintenance_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_enabled     boolean;
  v_retry_after integer;
  v_title       text;
  v_message     text;
  v_privileged  boolean;
begin
  select
    coalesce(
      (select (g.value #>> '{}')::boolean
         from public.site_globals g
        where g.key = 'maintenance_enabled'),
      false
    ),
    coalesce(
      (select (g.value #>> '{}')::integer
         from public.site_globals g
        where g.key = 'maintenance_retry_after'),
      3600
    )
    into v_enabled, v_retry_after;

  -- Membership, not capability: an editor may read the copy, only an admin may
  -- change it, and changing it is section 13's business rather than this one's.
  v_privileged := public.is_active_admin_user();

  if not v_privileged then
    -- The whole answer for an anonymous or non-member caller. Two scalars.
    return jsonb_build_object(
      'enabled',     v_enabled,
      'retry_after', v_retry_after
    );
  end if;

  select g.value #>> '{}' into v_title
    from public.site_globals g where g.key = 'maintenance_title';

  select g.value #>> '{}' into v_message
    from public.site_globals g where g.key = 'maintenance_message';

  return jsonb_build_object(
    'enabled',     v_enabled,
    'retry_after', v_retry_after,
    'title',       v_title,
    'message',     v_message
  );
exception
  when others then
    -- A read failure must not take the public site down, and must not raise on
    -- a boundary that runs for every request. Fail to the safe answer.
    return jsonb_build_object('enabled', false, 'retry_after', 3600);
end;
$fn$;



-- =============================================================================
-- 11. Field writes — seven commands, capability `edit`, `publish` or `reorder`
-- =============================================================================
-- WHY THESE ARE SEVEN FUNCTIONS AND NOT ONE. A single
-- update_field(table, column, value) is the shape this file most has to avoid,
-- and it is worth being explicit about why, because it is genuinely the more
-- convenient design and somebody will propose it.
--
-- One function taking any column would mean ONE `grant execute` licensing every
-- column of every table. An account with `edit` could then set `published` on a
-- draft, repoint an asset foreign key, rewrite a slug without taking the route
-- lock, or change its own row in admin_users — all through the function that was
-- only ever meant to fix a typo in a paragraph. The capability system would
-- still be there, and it would be meaningless, because `edit` would have become
-- the capability to do anything.
--
-- So each command below carries its OWN closed allowlist of (table, column)
-- pairs, and each allowlist contains only columns of the type and role that
-- command is for:
--
--   update_text        text scalars an editor types into
--   update_rich_text   the three ProseMirror document columns, and only those
--   update_media       the ten content asset foreign keys, and only those
--
-- `published` appears in NONE of them — it belongs to set_published under the
-- `publish` capability. `slug` appears in none of them — it belongs to
-- update_slug, which takes the route lock. `path`, `parent_id` and `sort_order`
-- appear in none of them — they are the tree, and they belong to reparent_page
-- and reorder_entries under `manage_nav` and `reorder`. site_globals.asset_id
-- appears in none of them — it belongs to update_globals under
-- `manage_globals`. Each of those exclusions is a capability boundary, and the
-- allowlists are how the boundary is actually enforced rather than merely
-- described.
--
-- Dynamic SQL is used to apply the update, and it is safe for the same reason
-- given in section 5: the table and column names are checked against the closed
-- allowlist BEFORE they are interpolated, and they are interpolated with %I. No
-- string that reaches format() can be anything other than one of the identifiers
-- listed here.

-- -----------------------------------------------------------------------------
-- 11.1 The three allowlists.
-- -----------------------------------------------------------------------------
-- Held as functions rather than as tables. A table would need RLS, policies and
-- seed rows of its own, and it would put the authorization surface somewhere
-- readable and writable; migration 13 makes the same argument for keeping the
-- capability matrix in a function body. These lists change only when a migration
-- changes them.

-- Text scalars an editor edits in place. Every one is a `text` column.
-- assets.alt is here deliberately: migration 13's matrix names alt text under
-- the `edit` capability, and authoring it for the informative subset of the 289
-- migrated assets is a cutover deliverable, so it has to be reachable by an
-- editor rather than only an admin.
create or replace function public.ces_allow_text_column(
  p_table  text,
  p_column text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select (p_table, p_column) in (
    ('pages', 'title'), ('pages', 'description'), ('pages', 'short_description'),
    ('pages', 'intro'), ('pages', 'welcome_line'),
    ('pages', 'seo_title'), ('pages', 'seo_description'),

    ('people', 'name'), ('people', 'official_title'), ('people', 'email'),
    ('people', 'bio'), ('people', 'seo_title'), ('people', 'seo_description'),

    ('events', 'title'), ('events', 'location'), ('events', 'zoom_link'),
    ('events', 'short_description'), ('events', 'calendar_link'),
    ('events', 'seo_title'), ('events', 'seo_description'),

    ('classrooms', 'title'), ('classrooms', 'description'),
    ('classrooms', 'age_range'),
    ('classrooms', 'seo_title'), ('classrooms', 'seo_description'),

    ('promoted', 'title'), ('promoted', 'subtitle'),
    ('promoted', 'address'), ('promoted', 'summary'),

    ('announcements', 'title'),

    ('inspiring_quotes', 'quote'), ('inspiring_quotes', 'attribution'),

    ('assets', 'alt')
  )
$fn$;

-- The text columns above that are declared NOT NULL by their table. Setting one
-- to null would raise a not-null violation, which under contract 1 is the wrong
-- kind of failure for a validation problem: it would be an exception where a
-- typed `invalid` result belongs. Checked before the write so the editor gets a
-- sentence rather than a 500.
create or replace function public.ces_text_column_required(
  p_table  text,
  p_column text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select (p_table, p_column) in (
    ('pages', 'title'),
    ('people', 'name'),
    ('events', 'title'), ('events', 'location'), ('events', 'short_description'),
    ('classrooms', 'title'),
    ('promoted', 'title'),
    ('announcements', 'title'),
    ('inspiring_quotes', 'quote')
  )
$fn$;

-- The ProseMirror document columns. Exactly three in the whole schema.
create or replace function public.ces_allow_rich_text_column(
  p_table  text,
  p_column text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select (p_table, p_column) in (
    ('events', 'details'),
    ('pages', 'important_notes'),
    ('page_sections', 'body')
  )
$fn$;

-- The content asset foreign keys. Ten of the schema's eleven references to
-- public.assets; site_globals.asset_id is the eleventh and is excluded because
-- it is update_globals' business under a different capability.
create or replace function public.ces_allow_media_column(
  p_table  text,
  p_column text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select (p_table, p_column) in (
    ('pages', 'main_image_asset_id'), ('pages', 'program_image_asset_id'),
    ('pages', 'og_image_id'),
    ('page_sections', 'asset_id'),
    ('people', 'photo_asset_id'), ('people', 'og_image_id'),
    ('events', 'image_asset_id'), ('events', 'og_image_id'),
    ('classrooms', 'og_image_id'),
    ('promoted', 'image_asset_id')
  )
$fn$;


-- -----------------------------------------------------------------------------
-- 11.2 update-text · capability `edit`
-- -----------------------------------------------------------------------------
-- The workhorse. Every plain-text field an editor changes in place on a public
-- page arrives here, one confirm at a time — requirement 2's "saving happens
-- with each local edit" means one call per field, and there is no batch form of
-- this function for the same reason there is no page-level Save button.
create or replace function public.update_text(
  p_table               text,
  p_row_id              uuid,
  p_column              text,
  p_value               text,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   text;
  v_exists   boolean;
begin
  v_check := public.ces_guard('edit', 'update-text');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_allow_text_column(p_table, p_column) then
    return public.ces_result_error(
      'invalid',
      'That field cannot be edited as text.',
      jsonb_build_object('table', p_table, 'column', p_column)
    );
  end if;

  if public.ces_text_column_required(p_table, p_column)
     and (p_value is null or btrim(p_value) = '') then
    return public.ces_result_error(
      'invalid',
      'This field is required and cannot be left empty.',
      jsonb_build_object('table', p_table, 'column', p_column)
    );
  end if;

  v_check := public.ces_check_conflict(p_table, p_row_id, p_expected_updated_at);
  if v_check is not null then return v_check; end if;

  execute format(
            'select t.%I, true from public.%I t where t.id = $1',
            p_column, p_table
          )
     into v_before, v_exists
    using p_row_id;

  if not coalesce(v_exists, false) then
    return public.ces_result_error(
      'not_found', 'That record no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  -- The blueprint character limits, with the grandfathering policy in section 6.
  -- The CURRENT value is passed so a no-op re-save of one of the six
  -- over-length legacy rows is allowed rather than trapping the editor.
  v_check := public.ces_check_length(p_table, p_column, p_value, v_before);
  if v_check is not null then return v_check; end if;

  execute format(
            'update public.%I t set %I = $1 where t.id = $2',
            p_table, p_column
          )
    using p_value, p_row_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, p_column,
    to_jsonb(v_before), to_jsonb(p_value)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object('table', p_table, 'row_id', p_row_id, 'column', p_column)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 11.3 update-rich-text · capability `edit`
-- -----------------------------------------------------------------------------
-- THE DIVISION OF VALIDATION LABOUR, stated so that neither side is mistaken for
-- the whole of it. The authoritative node and mark allowlist lives in
-- nextjs/lib/richtext-validate.ts: permitted node types, permitted marks,
-- per-node attributes, heading levels 2 to 4, table span sanity, nesting depth
-- and node count. It lives there because the Tiptap editor's own extension
-- configuration is DERIVED from the same allowlist, which is what stops the
-- toolbar ever offering a node the validator would refuse.
--
-- What this function adds is defence in depth against the path that skips the
-- Server Action entirely: the envelope shape and a size ceiling. Those two are
-- cheap in SQL and catch the cases that would otherwise store something the
-- renderer cannot walk at all. Re-implementing the full allowlist here would be
-- a second copy of a long list, and two copies of a validator is how the editor
-- and the database come to disagree about what a link is.
--
-- THE STORED SHAPE IS THE TIPTAP SHAPE — a single `doc` node with a `content`
-- array. Legacy Bard stored a BARE ARRAY of nodes with no wrapper, and
-- nextjs/lib/richtext.ts owns the one lossless conversion in both directions.
-- This function therefore rejects a bare array: accepting both shapes would put
-- the corpus in two states and make the round-trip test meaningless.
create or replace function public.update_rich_text(
  p_table               text,
  p_row_id              uuid,
  p_column              text,
  p_value               jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_max_bytes constant integer := 262144;          -- 256 KB, as lib/richtext-validate.ts
  v_check     jsonb;
  v_cs        uuid;
  v_before    jsonb;
  v_exists    boolean;
begin
  v_check := public.ces_guard('edit', 'update-rich-text');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_allow_rich_text_column(p_table, p_column) then
    return public.ces_result_error(
      'invalid',
      'That field is not a rich-text field.',
      jsonb_build_object('table', p_table, 'column', p_column)
    );
  end if;

  -- Null clears the field, which is legal for all three of these columns.
  if p_value is not null then

    if jsonb_typeof(p_value) <> 'object' then
      return public.ces_result_error(
        'invalid',
        'A rich-text value must be a document object.',
        jsonb_build_object('received', jsonb_typeof(p_value))
      );
    end if;

    if p_value ->> 'type' <> 'doc' then
      return public.ces_result_error(
        'invalid',
        'A rich-text value must be a document with type "doc".',
        jsonb_build_object('type', p_value ->> 'type')
      );
    end if;

    if jsonb_typeof(coalesce(p_value -> 'content', '[]'::jsonb)) <> 'array' then
      return public.ces_result_error(
        'invalid',
        'A rich-text document must carry an array of content nodes.'
      );
    end if;

    if pg_catalog.octet_length(p_value::text) > c_max_bytes then
      return public.ces_result_error(
        'invalid',
        'That rich-text document is too large.',
        jsonb_build_object(
          'bytes', pg_catalog.octet_length(p_value::text),
          'limit', c_max_bytes
        )
      );
    end if;

  end if;

  v_check := public.ces_check_conflict(p_table, p_row_id, p_expected_updated_at);
  if v_check is not null then return v_check; end if;

  execute format(
            'select t.%I, true from public.%I t where t.id = $1',
            p_column, p_table
          )
     into v_before, v_exists
    using p_row_id;

  if not coalesce(v_exists, false) then
    return public.ces_result_error(
      'not_found', 'That record no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  execute format(
            'update public.%I t set %I = $1 where t.id = $2',
            p_table, p_column
          )
    using p_value, p_row_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, p_column, v_before, p_value
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object('table', p_table, 'row_id', p_row_id, 'column', p_column)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 11.4 update-media · capability `upload`
-- -----------------------------------------------------------------------------
-- Repoints one content asset foreign key. Three rules beyond the allowlist:
--
--   * THE ASSET MUST BE 'stored'. A row in 'reserved', 'uploaded' or
--     'inspecting' has no durable object behind it yet, and a 'trashed' one has
--     had its bytes moved to media-trash. Referencing either would put a broken
--     image on a page, which is the one outcome the upload state machine exists
--     to make impossible.
--   * promoted.image_asset_id IS NOT NULL, so clearing it is refused with a
--     typed result rather than left to raise a not-null violation. Migration 09
--     made that column required because a promoted card without its image is not
--     a card, and migration 02 line 434 gives the same reason for refusing to
--     null it on asset delete.
--   * BOTH ASSETS ARE RE-EVALUATED against the section 9 predicate — the one
--     being attached and the one being displaced. Attaching an image to a
--     published row can make it public; displacing one can leave its last
--     published referrer behind and make it private. Reporting only the new
--     asset would leave the old object public forever.
--
-- The bucket MOVE itself is Storage work and belongs to the route handler, which
-- calls public.commit_asset_bucket (section 14.1) once the copy has verified.
-- This function reports what is required in `asset_moves` and changes no bytes.
create or replace function public.update_media(
  p_table               text,
  p_row_id              uuid,
  p_column              text,
  p_asset_id            uuid,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check     jsonb;
  v_cs        uuid;
  v_before    uuid;
  v_exists    boolean;
  v_lifecycle text;
  v_moves     jsonb := '[]'::jsonb;
begin
  v_check := public.ces_guard('upload', 'update-media');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_allow_media_column(p_table, p_column) then
    return public.ces_result_error(
      'invalid',
      'That field is not an image field.',
      jsonb_build_object('table', p_table, 'column', p_column)
    );
  end if;

  if p_asset_id is null
     and (p_table, p_column) = ('promoted', 'image_asset_id') then
    return public.ces_result_error(
      'invalid',
      'A promoted item must keep an image. Replace it rather than removing it.',
      jsonb_build_object('table', p_table, 'column', p_column)
    );
  end if;

  if p_asset_id is not null then
    select a.lifecycle into v_lifecycle
      from public.assets a where a.id = p_asset_id;

    if v_lifecycle is null then
      return public.ces_result_error(
        'not_found', 'That image no longer exists.',
        jsonb_build_object('asset_id', p_asset_id)
      );
    end if;

    if v_lifecycle <> 'stored' then
      return public.ces_result_error(
        'invalid',
        'That image is not ready to be used yet.',
        jsonb_build_object('asset_id', p_asset_id, 'lifecycle', v_lifecycle)
      );
    end if;
  end if;

  v_check := public.ces_check_conflict(p_table, p_row_id, p_expected_updated_at);
  if v_check is not null then return v_check; end if;

  execute format(
            'select t.%I, true from public.%I t where t.id = $1',
            p_column, p_table
          )
     into v_before, v_exists
    using p_row_id;

  if not coalesce(v_exists, false) then
    return public.ces_result_error(
      'not_found', 'That record no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  execute format(
            'update public.%I t set %I = $1 where t.id = $2',
            p_table, p_column
          )
    using p_asset_id, p_row_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, p_column,
    to_jsonb(v_before), to_jsonb(p_asset_id)
  );

  -- Both ends of the swap, evaluated AFTER the update so the predicate sees the
  -- new reference graph.
  v_moves := public.ces_asset_move_plan(
    array_remove(array[v_before, p_asset_id]::uuid[], null)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'row_id', p_row_id, 'column', p_column,
      'asset_moves', v_moves
    )
  );
end;
$fn$;



-- -----------------------------------------------------------------------------
-- 11.5 update-focal-point · capability `edit`
-- -----------------------------------------------------------------------------
-- Three numbers, written together because they are one editorial act: dragging
-- the crosshair in components/cms/FocalPointPicker.tsx moves x and y at once,
-- and the zoom sits on the same control.
--
-- Statamic stored this as a single `x-y-zoom` string ('50-33-1'); migration 02
-- split it into three numeric columns and converted the 18 sidecars that carry
-- one. FOUR of those 18 carry a zoom above 1, which is why zoom is part of the
-- contract and not dropped as a curiosity — Media applies x and y as
-- object-position and zoom as a scale() inside the frame, and discarding it
-- would silently recrop four real images.
--
-- The ranges mirror migration 02's check constraints exactly — x and y are
-- percentages so [0, 100], zoom is a multiplier so [1, 10]. They are re-tested
-- here so an out-of-range value is a typed `invalid` the editor can show against
-- the field, rather than a constraint violation that raises. Contract 1: a
-- validation problem is not an exceptional failure.
create or replace function public.update_focal_point(
  p_asset_id            uuid,
  p_focus_x             numeric,
  p_focus_y             numeric,
  p_focus_zoom          numeric,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check  jsonb;
  v_cs     uuid;
  v_before public.assets;
begin
  v_check := public.ces_guard('edit', 'update-focal-point');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if p_focus_x is not null and (p_focus_x < 0 or p_focus_x > 100) then
    return public.ces_result_error(
      'invalid', 'The horizontal focal point must be between 0 and 100.',
      jsonb_build_object('focus_x', p_focus_x)
    );
  end if;

  if p_focus_y is not null and (p_focus_y < 0 or p_focus_y > 100) then
    return public.ces_result_error(
      'invalid', 'The vertical focal point must be between 0 and 100.',
      jsonb_build_object('focus_y', p_focus_y)
    );
  end if;

  -- 1 is the floor because there is no such thing as zooming out past the frame,
  -- which is migration 02's own reasoning for the constraint.
  if p_focus_zoom is not null and (p_focus_zoom < 1 or p_focus_zoom > 10) then
    return public.ces_result_error(
      'invalid', 'The focal zoom must be between 1 and 10.',
      jsonb_build_object('focus_zoom', p_focus_zoom)
    );
  end if;

  v_check := public.ces_check_conflict('assets', p_asset_id, p_expected_updated_at);
  if v_check is not null then return v_check; end if;

  select * into v_before from public.assets a where a.id = p_asset_id;

  if v_before.id is null then
    return public.ces_result_error(
      'not_found', 'That image no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  update public.assets
     set focus_x    = p_focus_x,
         focus_y    = p_focus_y,
         focus_zoom = p_focus_zoom
   where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  -- Three revision rows under one change set, so a restore puts the crosshair
  -- back where it was rather than half of it.
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'focus_x',
    to_jsonb(v_before.focus_x), to_jsonb(p_focus_x)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'focus_y',
    to_jsonb(v_before.focus_y), to_jsonb(p_focus_y)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'focus_zoom',
    to_jsonb(v_before.focus_zoom), to_jsonb(p_focus_zoom)
  );

  return public.ces_result_ok(
    v_cs, jsonb_build_object('asset_id', p_asset_id)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 11.6 The per-kind section shape, and update-section · capability `edit`
-- -----------------------------------------------------------------------------
-- WHY THE SHAPE IS ENFORCED HERE RATHER THAN BY A CHECK CONSTRAINT. Migration 05
-- line 260 explains it with the real rows: the one `session` set in
-- summer-programs.md carries the day-length prices but NO program_title at all,
-- and the one `programs_offered` set carries a program_title and no
-- program_description. A `check (kind <> 'program' or program_title is not null)`
-- would have aborted the canonical load on genuine history. So the corpus loads
-- grandfathered and the shape is enforced on every CREATE and EDIT — here.
--
-- The map below is the ten `kind` values from migration 05's closed vocabulary
-- against the typed columns each one legitimately owns:
--
--   text         body
--   image        asset_id, caption
--   slide        asset_id, caption, happy_verb
--   quote        quote_text, attribution
--   testimonial  quote_text, attribution, asset_id
--   movie        embed_url, caption
--   statistic    stat_number, stat_caption
--   program      program_title, program_description,
--                half_day_price, full_day_price, extended_day_price
--   session      session_title, session_dates
--   faq_item     question, answer
--
-- `happy_verb` is the one most easily lost in a rewrite and migration 05 says so
-- outright: it is the `slide` kind's second field, holding 'We Play', 'We Wonder'
-- and their siblings on the home hero. It is in the map for `slide` and in no
-- other kind.
--
-- `kind` ITSELF IS NOT PATCHABLE, and neither are page_id, parent_section_id,
-- sort_order, enabled, data or legacy. Changing a section's kind would change
-- which columns are meaningful and orphan the ones already set; ordering belongs
-- to reorder_sections, visibility to set_section_enabled, and `data` is
-- migration 05's remainder-only escape hatch rather than an editable surface.
create or replace function public.ces_allow_section_column(
  p_kind   text,
  p_column text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select (p_kind, p_column) in (
    ('text', 'body'),

    ('image', 'asset_id'), ('image', 'caption'),

    ('slide', 'asset_id'), ('slide', 'caption'), ('slide', 'happy_verb'),

    ('quote', 'quote_text'), ('quote', 'attribution'),

    ('testimonial', 'quote_text'), ('testimonial', 'attribution'),
    ('testimonial', 'asset_id'),

    ('movie', 'embed_url'), ('movie', 'caption'),

    ('statistic', 'stat_number'), ('statistic', 'stat_caption'),

    ('program', 'program_title'), ('program', 'program_description'),
    ('program', 'half_day_price'), ('program', 'full_day_price'),
    ('program', 'extended_day_price'),

    ('session', 'session_title'), ('session', 'session_dates'),

    ('faq_item', 'question'), ('faq_item', 'answer')
  )
$fn$;

-- Patches one section. `p_patch` is an object of column -> value, and EVERY key
-- must be legal for that section's own kind; one illegal key refuses the whole
-- patch rather than applying the rest, because a partially applied edit is worse
-- than a refused one — the editor would show success against a field that never
-- changed.
--
-- One revision row per key, all sharing one change_set_id, so restoring the
-- change set puts the whole section back and restoring a single revision puts
-- back one field.
create or replace function public.update_section(
  p_section_id          uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_fail    jsonb;
  v_check     jsonb;
  v_cs        uuid;
  v_kind      text;
  v_key       text;
  v_before_t  text;
  v_before_j  jsonb;
  v_before_u  uuid;
  v_new_u     uuid;
  v_lifecycle text;
  v_touched   jsonb := '[]'::jsonb;
  v_assets    uuid[] := array[]::uuid[];
begin
  v_check := public.ces_guard('edit', 'update-section');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return public.ces_result_error(
      'invalid', 'A section patch must be an object of fields to change.'
    );
  end if;

  if p_patch = '{}'::jsonb then
    return public.ces_result_error(
      'invalid', 'A section patch must change at least one field.'
    );
  end if;

  select s.kind into v_kind
    from public.page_sections s where s.id = p_section_id;

  if v_kind is null then
    return public.ces_result_error(
      'not_found', 'That section no longer exists.',
      jsonb_build_object('section_id', p_section_id)
    );
  end if;

  -- Validate EVERY key before applying ANY of them.
  for v_key in select jsonb_object_keys(p_patch) loop
    if not public.ces_allow_section_column(v_kind, v_key) then
      return public.ces_result_error(
        'invalid',
        format('A %s section has no editable field called %s.', v_kind, v_key),
        jsonb_build_object('kind', v_kind, 'column', v_key)
      );
    end if;
  end loop;

  v_check := public.ces_check_conflict(
    'page_sections', p_section_id, p_expected_updated_at
  );
  if v_check is not null then return v_check; end if;

  v_cs := public.ces_new_change_set();

  -- ALL-OR-NOTHING ACROSS A MULTI-KEY PATCH. The key-name allowlist above runs
  -- as its own pass, but the VALUE checks below cannot: whether an asset_id
  -- exists and is 'stored' is only knowable per key, inside this loop. Without
  -- the surrounding block a patch of {"caption": "...", "asset_id": "<missing>"}
  -- would apply the caption, then return a typed error for the asset — and
  -- because a typed return raises nothing, the caption would COMMIT while the
  -- caller was told the edit failed. The BEGIN ... EXCEPTION block gives the loop
  -- an implicit SAVEPOINT so a refusal on any key unwinds every key already
  -- applied, and the caller still receives an ordinary typed result. Same idiom,
  -- same reason, as restore_change_set in section 15.
  begin
  for v_key in select jsonb_object_keys(p_patch) loop

    if v_key = 'body' then
      -- The one jsonb column among the section fields. Envelope-checked exactly
      -- as update_rich_text does, for the same reason.
      if p_patch -> 'body' is not null
         and jsonb_typeof(p_patch -> 'body') = 'object'
         and (p_patch -> 'body') ->> 'type' <> 'doc' then
        v_fail := public.ces_result_error(
          'invalid', 'A section body must be a document with type "doc".'
        );
        raise exception 'ces_patch_abort' using errcode = 'CES01';
      end if;

      select s.body into v_before_j
        from public.page_sections s where s.id = p_section_id;

      update public.page_sections
         set body = nullif(p_patch -> 'body', 'null'::jsonb)
       where id = p_section_id;

      perform public.ces_write_revision(
        v_cs, 'page_sections', p_section_id, 'body',
        v_before_j, nullif(p_patch -> 'body', 'null'::jsonb)
      );

    elsif v_key = 'asset_id' then
      v_new_u := nullif(p_patch ->> 'asset_id', '')::uuid;

      if v_new_u is not null then
        select a.lifecycle into v_lifecycle
          from public.assets a where a.id = v_new_u;

        if v_lifecycle is null then
          v_fail := public.ces_result_error(
            'not_found', 'That image no longer exists.',
            jsonb_build_object('asset_id', v_new_u)
          );
          raise exception 'ces_patch_abort' using errcode = 'CES01';
        end if;

        if v_lifecycle <> 'stored' then
          v_fail := public.ces_result_error(
            'invalid', 'That image is not ready to be used yet.',
            jsonb_build_object('asset_id', v_new_u, 'lifecycle', v_lifecycle)
          );
          raise exception 'ces_patch_abort' using errcode = 'CES01';
        end if;
      end if;

      select s.asset_id into v_before_u
        from public.page_sections s where s.id = p_section_id;

      update public.page_sections
         set asset_id = v_new_u
       where id = p_section_id;

      perform public.ces_write_revision(
        v_cs, 'page_sections', p_section_id, 'asset_id',
        to_jsonb(v_before_u), to_jsonb(v_new_u)
      );

      -- Both ends of the swap, as in 11.4.
      v_assets := array_remove(v_assets || array[v_before_u, v_new_u], null);

    else
      -- Every remaining section column is text.
      execute format(
                'select s.%I from public.page_sections s where s.id = $1',
                v_key
              )
         into v_before_t
        using p_section_id;

      execute format(
                'update public.page_sections s set %I = $1 where s.id = $2',
                v_key
              )
        using p_patch ->> v_key, p_section_id;

      perform public.ces_write_revision(
        v_cs, 'page_sections', p_section_id, v_key,
        to_jsonb(v_before_t), to_jsonb(p_patch ->> v_key)
      );
    end if;

    v_touched := v_touched || to_jsonb(v_key);
  end loop;
  exception
    when sqlstate 'CES01' then
      -- Savepoint rollback has undone every key applied before the refusal.
      return v_fail;
  end;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'section_id', p_section_id,
      'kind', v_kind,
      'columns', v_touched,
      'asset_moves', public.ces_asset_move_plan(v_assets)
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 11.7 set-section-enabled · capability `publish`
-- -----------------------------------------------------------------------------
-- `publish` RATHER THAN `edit`, and the choice is migration 13's rather than
-- this file's: its capability matrix names "set-published, set-section-enabled"
-- together under `publish`. That is the right grouping — enabling a section
-- changes what the public sees, which is a publication decision even though the
-- mechanism is a boolean on a child row. Both roles hold `publish`, so the
-- practical audience is identical either way; what matters is that the two
-- visibility switches in the system are gated by the same capability.
--
-- `enabled` DEFAULTS TO TRUE, the opposite of `published`'s default false, and
-- migration 05 calls that asymmetry deliberate: a new section is part of the page
-- it was added to, whereas a new entry is a draft until somebody says otherwise.
-- The seven `enabled: false` records the source carries are the only ones that
-- start disabled.
--
-- IT RECOMPUTES THE ASSET MOVE PLAN, which is easy to miss. A disabled section
-- does not count toward published_reference_count — section 9 excludes it,
-- because a section that renders to nobody cannot be what makes an image public
-- — so disabling the last enabled section that referenced a photograph must
-- demote that photograph to media-private, and re-enabling it must promote it
-- back.
create or replace function public.set_section_enabled(
  p_section_id          uuid,
  p_enabled             boolean,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_before  boolean;
  v_asset   uuid;
begin
  v_check := public.ces_guard('publish', 'set-section-enabled');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if p_enabled is null then
    return public.ces_result_error(
      'invalid', 'A section must be either enabled or disabled.'
    );
  end if;

  v_check := public.ces_check_conflict(
    'page_sections', p_section_id, p_expected_updated_at
  );
  if v_check is not null then return v_check; end if;

  select s.enabled, s.asset_id into v_before, v_asset
    from public.page_sections s where s.id = p_section_id;

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That section no longer exists.',
      jsonb_build_object('section_id', p_section_id)
    );
  end if;

  update public.page_sections set enabled = p_enabled where id = p_section_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'page_sections', p_section_id, 'enabled',
    to_jsonb(v_before), to_jsonb(p_enabled)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'section_id', p_section_id,
      'enabled', p_enabled,
      'asset_moves', public.ces_asset_move_plan(
        array_remove(array[v_asset]::uuid[], null)
      )
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 11.8 reorder-sections · capability `reorder`
-- -----------------------------------------------------------------------------
-- Renumbers one sibling set to 1..n from the order of `p_ordered_ids`.
--
-- SIBLINGS ARE SCOPED BY BOTH page_id AND parent_section_id, which is migration
-- 05's three-column constraint and not an over-specification: a nested `program`
-- row inside a `session` must not compete for positions with the page's
-- top-level sections. `p_parent_section_id` null means the top level, and the
-- constraint is `nulls not distinct` precisely so those rows still collide with
-- each other rather than being treated as all-distinct and unconstrained.
--
-- THE ARRAY MUST BE THE COMPLETE SIBLING SET — every member, no extras, no
-- duplicates. A partial reorder is refused rather than interpreted, because
-- there is no correct interpretation: renumbering three of five siblings leaves
-- the other two at positions that may now collide, and guessing where they
-- should go is inventing an editorial decision.
--
-- `set constraints ... deferred` IS WHAT MAKES THIS POSSIBLE. Renumbering
-- necessarily passes through colliding intermediate states — swapping positions
-- 1 and 2 means two rows momentarily hold the same one. Migration 05 declared
-- the constraint `deferrable initially immediate` for exactly this, so plain bad
-- inserts still fail fast while this function opts into deferral for the length
-- of its own transaction and the invariant is checked once, at commit.
create or replace function public.reorder_sections(
  p_page_id           uuid,
  p_parent_section_id uuid,
  p_ordered_ids       uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_expected integer;
  v_given    integer;
  v_row      record;
  v_moved    integer := 0;
begin
  v_check := public.ces_guard('reorder', 'reorder-sections');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if p_ordered_ids is null or array_length(p_ordered_ids, 1) is null then
    return public.ces_result_error(
      'invalid', 'An order must list at least one section.'
    );
  end if;

  v_given := array_length(p_ordered_ids, 1);

  if v_given <> (
    select count(distinct u) from unnest(p_ordered_ids) u
  ) then
    return public.ces_result_error(
      'invalid', 'That order lists the same section more than once.'
    );
  end if;

  select count(*) into v_expected
    from public.page_sections s
   where s.page_id = p_page_id
     and s.parent_section_id is not distinct from p_parent_section_id;

  if v_expected = 0 then
    return public.ces_result_error(
      'not_found', 'There are no sections to reorder here.',
      jsonb_build_object(
        'page_id', p_page_id, 'parent_section_id', p_parent_section_id
      )
    );
  end if;

  -- Complete-set check, both directions: the count matches AND every listed id
  -- really is a member of this sibling set.
  if v_given <> v_expected
     or exists (
          select 1 from unnest(p_ordered_ids) u
          where not exists (
            select 1 from public.page_sections s
             where s.id = u
               and s.page_id = p_page_id
               and s.parent_section_id is not distinct from p_parent_section_id
          )
        ) then
    return public.ces_result_error(
      'invalid',
      'A reorder must list every section in this group exactly once.',
      jsonb_build_object('expected', v_expected, 'received', v_given)
    );
  end if;

  -- Intermediate collisions are legal until commit. See the note above.
  set constraints public.page_sections_page_parent_sort_order_key deferred;

  v_cs := public.ces_new_change_set();

  for v_row in
    select s.id, s.sort_order as old_order, o.ord as new_order
      from unnest(p_ordered_ids) with ordinality as o(id, ord)
      join public.page_sections s on s.id = o.id
  loop
    if v_row.old_order is distinct from v_row.new_order then
      update public.page_sections
         set sort_order = v_row.new_order
       where id = v_row.id;

      perform public.ces_write_revision(
        v_cs, 'page_sections', v_row.id, 'sort_order',
        to_jsonb(v_row.old_order), to_jsonb(v_row.new_order)
      );

      v_moved := v_moved + 1;
    end if;
  end loop;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'page_id', p_page_id,
      'parent_section_id', p_parent_section_id,
      'sections', v_given,
      'moved', v_moved
    )
  );
end;
$fn$;



-- =============================================================================
-- 12. Entry lifecycle — seven commands across four capabilities
-- =============================================================================
-- The seven collections, and which of them are ROUTED. Only four contribute to
-- the URL space, so only four take the advisory lock:
--
--   pages        routed, kind 'page'       hierarchical, sort_order, max_depth 2
--   people       routed, kind 'person'     /community/{slug}, sort_order
--   events       routed, kind 'event'      /events/{slug}, NO sort_order
--   classrooms   routed, kind 'classroom'  /programs/{slug}, sort_order
--   promoted     not routed               sort_order
--   announcements     not routed          NO sort_order
--   inspiring_quotes  not routed          NO sort_order
--
-- announcements, promoted and inspiring_quotes have no route pattern at all —
-- they render as components of other pages — so a slug change on one of them
-- moves no URL and needs no lock. That is why update_slug branches on this and
-- not on convenience.

-- -----------------------------------------------------------------------------
-- 12.1 Collection facts, in one place.
-- -----------------------------------------------------------------------------
create or replace function public.ces_is_collection(p_table text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select p_table in (
    'pages', 'people', 'events', 'classrooms',
    'promoted', 'announcements', 'inspiring_quotes'
  )
$fn$;

-- The routing `kind` for a routed collection, in migration 15's exact SINGULAR
-- vocabulary, and null for the three unrouted ones. This is the single place the
-- plural table name is translated into the singular routing discriminator, so
-- the mismatch migration 15 line 385 warns about cannot happen at a call site.
create or replace function public.ces_route_kind(p_table text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case p_table
    when 'pages'      then 'page'
    when 'people'     then 'person'
    when 'events'     then 'event'
    when 'classrooms' then 'classroom'
    else null
  end
$fn$;

-- The path a routed row occupies, reproducing each collection's own route
-- pattern. pages is materialized rather than derived, so it is read; the other
-- three concatenate, and the classrooms case carries migration 15's repair of
-- content/collections/classrooms.yaml's missing leading slash.
create or replace function public.ces_route_path(
  p_table  text,
  p_row_id uuid,
  p_slug   text
)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select case p_table
    when 'pages'      then (select p.path from public.pages p where p.id = p_row_id)
    when 'people'     then '/community/' || p_slug
    when 'events'     then '/events/'    || p_slug
    when 'classrooms' then '/programs/'  || p_slug
    else null
  end
$fn$;

-- Which collections can be manually ordered. SCHEMA-DETERMINED, not a policy
-- choice: these are exactly the four tables that HAVE a sort_order column.
-- events order publicly by event_date then title then slug; announcements and
-- inspiring_quotes have no public order at all — one banner is selected and one
-- quote is chosen per request — so offering a reorder control for them would
-- promise a control with nothing behind it. reorder_entries returns
-- `unsupported` for those three rather than silently succeeding.
create or replace function public.ces_is_orderable(p_table text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select p_table in ('pages', 'people', 'classrooms', 'promoted')
$fn$;

-- Insert a row into a collection from a jsonb object.
--
-- WHY THIS IS NOT `insert into t select * from jsonb_populate_record(null::t, $1)`,
-- which is the obvious form and is WRONG. jsonb_populate_record fills any field
-- absent from the json from the BASE RECORD, and the base record here is
-- `null::t` — every field null. So a column the payload does not mention gets
-- null rather than its table default, and every `not null default` column in the
-- schema fails: pages.show_in_nav, and the `legacy` and `data` jsonb columns on
-- all seven collections, all of which are `not null default '{}'::jsonb`. The
-- symptom is a not-null violation on a column the caller was never asked to
-- supply, and it raises rather than returning a typed result.
--
-- So the insert names ONLY the columns the payload actually carries, and every
-- other column takes its declared default. Two further rules make that safe:
--
--   * a key that is not a real column of the table is DROPPED rather than being
--     an error, so an editor payload carrying an extra field is tolerated the way
--     migration 05's `data` escape hatch is;
--   * a key whose value is json null on a NOT NULL column is dropped too, so an
--     explicit null falls back to the default instead of raising. A caller cannot
--     null a required column through this path, which is correct — that is what
--     the typed validation in each command is for.
--
-- The column names are read from pg_attribute, so every identifier interpolated
-- below is a real column of a real table and quote_ident makes it literal.
create or replace function public.ces_insert_row(
  p_table text,
  p_row   jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into v_cols
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class     c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = p_table
     and a.attnum > 0
     and not a.attisdropped
     and p_row ? a.attname
     and not (a.attnotnull and jsonb_typeof(p_row -> a.attname) = 'null');

  if v_cols is null then
    raise exception
      'ces_insert_row: payload named no insertable column of public.%', p_table;
  end if;

  execute format(
    'insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
    p_table, v_cols, v_cols, p_table
  ) using p_row;
end;
$fn$;

-- Read a whole row as jsonb. Used to record a create or a delete in
-- content_revisions, where migration 14 puts the full row in value_after or
-- value_before and leaves column_name null because there is no single column to
-- name.
create or replace function public.ces_row_json(
  p_table  text,
  p_row_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_row jsonb;
begin
  if not public.ces_is_collection(p_table) then
    return null;
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table)
     into v_row
    using p_row_id;

  return v_row;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 12.2 create-entry · capability `create_entry`
-- -----------------------------------------------------------------------------
-- Creates a row in any of the seven collections from a jsonb payload, and is the
-- reason the collection surfaces at /admin/collections/[collection] can exist at
-- all: a brand-new entry has no public page to be edited in place on.
--
-- FOUR THINGS IT MUST GET RIGHT, and each has a failure mode worth naming.
--
--   1. THE ROUTE. For a routed collection it computes the path the row will
--      occupy and calls assert_route_available, which takes the advisory lock.
--      Without that, two admins creating the same slug in different collections
--      would both succeed — the case section 7 exists for.
--
--   2. REQUIRED COLUMNS. events alone has five not-null columns (title,
--      event_date, location, short_description, slug), and promoted requires a
--      not-null image_asset_id. Checking them here turns a missing field into a
--      typed `invalid` the editor shows against the field, instead of a
--      not-null violation that raises and loses the audit row.
--
--   3. PEOPLE MUST ARRIVE WITH A ROLE. This is the subtle one. Migration 06
--      attaches a CONSTRAINT TRIGGER, people_has_role_check, that is DEFERRABLE
--      INITIALLY DEFERRED and fires at COMMIT — so a person inserted with no
--      person_roles row does not fail here, it fails at the end of the
--      transaction, long after this function has returned `ok`. The Server Action
--      would report success and the write would then vanish. So the payload must
--      carry role_term_ids, and a person without one is refused UP FRONT with a
--      typed result. All 77 migrated people satisfy the invariant, so this only
--      ever affects new entries.
--
--   4. sort_order. Computed as the next free position in the row's own sibling
--      scope — per parent for pages, per collection for the others — rather than
--      taken from the payload. Letting a caller choose it would collide with the
--      `nulls not distinct` unique constraint, and reordering is
--      reorder_entries' job.
--
-- PUBLISHED DEFAULTS TO FALSE and the payload cannot override it. A new entry is
-- a draft until somebody deliberately publishes it through set_published, which
-- is gated by a different capability. `create_entry` is not permission to put
-- something on the public site.
create or replace function public.create_entry(
  p_table   text,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check      jsonb;
  v_cs         uuid;
  v_id         uuid;
  v_slug       text;
  v_slug_taken boolean;
  v_kind       text;
  v_path       text;
  v_parent     uuid;
  v_sort       integer;
  v_roles      uuid[];
  v_term       uuid;
  v_row        jsonb;
  v_asset      uuid;
begin
  v_check := public.ces_guard('create_entry', 'create-entry');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return public.ces_result_error(
      'invalid', 'A new entry needs a payload object.'
    );
  end if;

  v_slug := nullif(btrim(coalesce(p_payload ->> 'slug', '')), '');

  if not public.ces_valid_slug(v_slug) then
    return public.ces_result_error(
      'invalid',
      'A web address is required, in lowercase words separated by hyphens.',
      jsonb_build_object('slug', v_slug)
    );
  end if;

  -- Slug uniqueness WITHIN the collection. All seven declare a unique slug, so
  -- a duplicate would raise; a typed result names the field instead. Tested
  -- directly against the table rather than through content_routes, because three
  -- of the seven collections do not appear in that view at all — and because
  -- uniqueness ACROSS collections is a different question, answered by the
  -- advisory lock further down for the four that share a URL space.
  execute format(
            'select exists (select 1 from public.%I t where t.slug = $1)',
            p_table
          )
     into v_slug_taken
    using v_slug;

  if v_slug_taken then
    return public.ces_result_error(
      'invalid',
      'That web address is already used in this collection.',
      jsonb_build_object('table', p_table, 'slug', v_slug)
    );
  end if;

  v_id   := extensions.gen_random_uuid();
  v_kind := public.ces_route_kind(p_table);

  -- ---- per-collection validation and the sibling scope --------------------
  if p_table = 'pages' then
    v_parent := nullif(p_payload ->> 'parent_id', '')::uuid;

    if v_parent is not null then
      if not exists (select 1 from public.pages p where p.id = v_parent) then
        return public.ces_result_error(
          'not_found', 'That parent page does not exist.',
          jsonb_build_object('parent_id', v_parent)
        );
      end if;

      -- content/collections/pages.yaml:9 sets max_depth: 2, so a child of a
      -- child is not a legal state and is refused rather than created.
      if public.ces_page_depth(v_parent) >= 2 then
        return public.ces_result_error(
          'invariant',
          'Pages can only be nested two levels deep.',
          jsonb_build_object('parent_id', v_parent,
                             'parent_depth', public.ces_page_depth(v_parent))
        );
      end if;
    end if;

    if nullif(btrim(coalesce(p_payload ->> 'title', '')), '') is null then
      return public.ces_result_error(
        'invalid', 'A page needs a title.', jsonb_build_object('column', 'title')
      );
    end if;

    if p_payload ->> 'template' is null or p_payload ->> 'blueprint' is null then
      return public.ces_result_error(
        'invalid',
        'A page needs a template and a blueprint.',
        jsonb_build_object('template', p_payload ->> 'template',
                           'blueprint', p_payload ->> 'blueprint')
      );
    end if;

    v_path := public.ces_page_path(v_parent, v_slug);

    select coalesce(max(p.sort_order), 0) + 1 into v_sort
      from public.pages p
     where p.parent_id is not distinct from v_parent;

  elsif p_table = 'people' then
    if nullif(btrim(coalesce(p_payload ->> 'name', '')), '') is null then
      return public.ces_result_error(
        'invalid', 'A person needs a name.', jsonb_build_object('column', 'name')
      );
    end if;

    -- See point 3 in the note above: the role invariant is enforced by a
    -- DEFERRED constraint trigger that fires at commit, so it has to be
    -- satisfied inside this call or the whole transaction dies after we return.
    select coalesce(
             array_agg(distinct (t.value #>> '{}')::uuid),
             array[]::uuid[]
           )
      into v_roles
      from jsonb_array_elements(
             case
               when jsonb_typeof(coalesce(p_payload -> 'role_term_ids', 'null'::jsonb))
                    = 'array'
                 then p_payload -> 'role_term_ids'
               else '[]'::jsonb
             end
           ) t;

    if array_length(v_roles, 1) is null then
      return public.ces_result_error(
        'invalid',
        'A person must be given at least one role.',
        jsonb_build_object('column', 'role_term_ids')
      );
    end if;

    foreach v_term in array v_roles loop
      if not exists (
        select 1 from public.taxonomy_terms tt
         where tt.id = v_term and tt.taxonomy = 'role'
      ) then
        return public.ces_result_error(
          'not_found', 'One of those roles does not exist.',
          jsonb_build_object('term_id', v_term)
        );
      end if;
    end loop;

    select coalesce(max(pe.sort_order), 0) + 1 into v_sort from public.people pe;

  elsif p_table = 'events' then
    -- Five not-null columns; migration 07 mirrors the blueprint's `required`
    -- flags exactly and this is where a missing one becomes a message.
    if nullif(btrim(coalesce(p_payload ->> 'title', '')), '') is null
       or nullif(btrim(coalesce(p_payload ->> 'location', '')), '') is null
       or nullif(btrim(coalesce(p_payload ->> 'short_description', '')), '') is null
       or nullif(p_payload ->> 'event_date', '') is null then
      return public.ces_result_error(
        'invalid',
        'An event needs a title, a date, a location and a short description.',
        jsonb_build_object(
          'title', p_payload ->> 'title',
          'event_date', p_payload ->> 'event_date',
          'location', p_payload ->> 'location',
          'short_description', p_payload ->> 'short_description'
        )
      );
    end if;

    v_check := public.ces_check_length(
      'events', 'short_description', p_payload ->> 'short_description', null
    );
    if v_check is not null then return v_check; end if;

    v_sort := null;                       -- events carry no sort_order column

  elsif p_table = 'classrooms' then
    if nullif(btrim(coalesce(p_payload ->> 'title', '')), '') is null then
      return public.ces_result_error(
        'invalid', 'A classroom needs a title.',
        jsonb_build_object('column', 'title')
      );
    end if;

    select coalesce(max(c.sort_order), 0) + 1 into v_sort from public.classrooms c;

  elsif p_table = 'promoted' then
    if nullif(btrim(coalesce(p_payload ->> 'title', '')), '') is null then
      return public.ces_result_error(
        'invalid', 'A promoted item needs a title.',
        jsonb_build_object('column', 'title')
      );
    end if;

    v_asset := nullif(p_payload ->> 'image_asset_id', '')::uuid;

    -- migration 09 makes this column not null: a promoted card without its
    -- image is not a card.
    if v_asset is null then
      return public.ces_result_error(
        'invalid', 'A promoted item needs an image.',
        jsonb_build_object('column', 'image_asset_id')
      );
    end if;

    if not exists (
      select 1 from public.assets a
       where a.id = v_asset and a.lifecycle = 'stored'
    ) then
      return public.ces_result_error(
        'invalid', 'That image is not available to use.',
        jsonb_build_object('asset_id', v_asset)
      );
    end if;

    select coalesce(max(pr.sort_order), 0) + 1 into v_sort from public.promoted pr;

  elsif p_table = 'announcements' then
    if nullif(btrim(coalesce(p_payload ->> 'title', '')), '') is null then
      return public.ces_result_error(
        'invalid', 'An announcement needs a title.',
        jsonb_build_object('column', 'title')
      );
    end if;

    -- The 30-character blueprint limit, applied to a NEW value with no stored
    -- value to grandfather against, so section 6 clause 1 is the only one that
    -- can admit it.
    v_check := public.ces_check_length(
      'announcements', 'title', p_payload ->> 'title', null
    );
    if v_check is not null then return v_check; end if;

    v_sort := null;

  else   -- inspiring_quotes
    if nullif(btrim(coalesce(p_payload ->> 'quote', '')), '') is null then
      return public.ces_result_error(
        'invalid', 'A quote needs its text.', jsonb_build_object('column', 'quote')
      );
    end if;

    v_sort := null;
  end if;

  -- ---- the route lock, for the four routed collections --------------------
  if v_kind is not null then
    v_path := coalesce(
      v_path,
      case v_kind
        when 'person'    then '/community/' || v_slug
        when 'event'     then '/events/'    || v_slug
        when 'classroom' then '/programs/'  || v_slug
      end
    );

    -- Nothing to exclude: this row does not exist yet, so it cannot collide
    -- with itself.
    v_check := public.assert_route_available(v_path, null, null);
    if v_check is not null then return v_check; end if;
  end if;

  -- ---- the insert --------------------------------------------------------
  -- Built from the payload but with every column this function owns forced to
  -- the value it decided: the id, the slug, the computed path, the sibling
  -- position, published false, and null provenance because a row created here
  -- has no Statamic source. legacy_ref is null for the same reason, which
  -- migration 03 notes is exactly what the nullable unique constraint is for.
  v_row := p_payload
           - 'role_term_ids'
           || jsonb_build_object(
                'id',         v_id,
                'slug',       v_slug,
                'published',  false,
                'legacy_ref', null,
                'source_updated_at', null,
                'source_updated_by', null,
                'created_at', timezone('utc', now()),
                'updated_at', timezone('utc', now())
              );

  if v_path is not null and p_table = 'pages' then
    v_row := v_row || jsonb_build_object('path', v_path, 'parent_id', v_parent);
  end if;

  if v_sort is not null then
    v_row := v_row || jsonb_build_object('sort_order', v_sort);
  end if;

  perform public.ces_insert_row(p_table, v_row);

  -- The role rows, before commit and therefore before the deferred trigger.
  if p_table = 'people' then
    foreach v_term in array v_roles loop
      insert into public.person_roles (person_id, term_id) values (v_id, v_term);
    end loop;
  end if;

  v_cs := public.ces_new_change_set();

  -- A whole-row event: column_name null, the full row in value_after.
  perform public.ces_write_revision(
    v_cs, p_table, v_id, null, null, public.ces_row_json(p_table, v_id)
  );

  if p_table = 'people' then
    foreach v_term in array v_roles loop
      perform public.ces_write_revision(
        v_cs, 'person_roles', v_id, 'term_id', null, to_jsonb(v_term)
      );
    end loop;
  end if;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'id', v_id, 'slug', v_slug,
      'path', v_path, 'published', false
    )
  );
end;
$fn$;



-- -----------------------------------------------------------------------------
-- 12.3 duplicate-entry · capability `create_entry`
-- -----------------------------------------------------------------------------
-- SHARES `create_entry` RATHER THAN HAVING ITS OWN CAPABILITY, and migration 13
-- says why in the matrix itself: "create_entry gates create-entry AND
-- duplicate-entry (a duplicate creates a row, so it needs no separate
-- capability)". The authority being exercised is "may bring a new entry into
-- existence", and where its field values came from does not change that.
--
-- IT COPIES THE CHILD ROWS, which is the difference between a useful duplicate
-- and an empty shell. Duplicating a flexible page whose entire content lives in
-- page_sections would otherwise produce a page with a title and nothing else,
-- and the editor would have to rebuild it by hand — which is the opposite of why
-- anybody reaches for duplicate. So:
--
--   pages       page_sections, including nested rows (parent_section_id is
--               remapped, so a session keeps its programs), and page_classrooms
--   people      person_education and person_roles — the latter also satisfies
--               the deferred role invariant for free
--   promoted    promoted_links
--   classrooms  classroom_teachers
--
-- THE COPY IS ALWAYS A DRAFT. published is forced false regardless of the
-- original's state, for the same reason create-entry forces it: publishing is a
-- separate capability and a duplicate appearing live on the site the instant it
-- is made would be a genuine surprise.
create or replace function public.duplicate_entry(
  p_table    text,
  p_row_id   uuid,
  p_new_slug text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_id      uuid;
  v_slug    text;
  v_kind    text;
  v_path    text;
  v_parent  uuid;
  v_sort    integer;
  v_row     jsonb;
  v_taken   boolean;
  v_sec     record;
  v_map     jsonb := '{}'::jsonb;
begin
  v_check := public.ces_guard('create_entry', 'duplicate-entry');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  v_slug := nullif(btrim(coalesce(p_new_slug, '')), '');

  if not public.ces_valid_slug(v_slug) then
    return public.ces_result_error(
      'invalid',
      'The copy needs a web address, in lowercase words separated by hyphens.',
      jsonb_build_object('slug', v_slug)
    );
  end if;

  v_row := public.ces_row_json(p_table, p_row_id);

  if v_row is null then
    return public.ces_result_error(
      'not_found', 'That entry no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  execute format(
            'select exists (select 1 from public.%I t where t.slug = $1)',
            p_table
          )
     into v_taken
    using v_slug;

  if v_taken then
    return public.ces_result_error(
      'invalid', 'That web address is already used in this collection.',
      jsonb_build_object('table', p_table, 'slug', v_slug)
    );
  end if;

  v_id   := extensions.gen_random_uuid();
  v_kind := public.ces_route_kind(p_table);

  if p_table = 'pages' then
    v_parent := nullif(v_row ->> 'parent_id', '')::uuid;
    v_path   := public.ces_page_path(v_parent, v_slug);

    select coalesce(max(p.sort_order), 0) + 1 into v_sort
      from public.pages p
     where p.parent_id is not distinct from v_parent;

  elsif public.ces_is_orderable(p_table) then
    execute format(
              'select coalesce(max(t.sort_order), 0) + 1 from public.%I t',
              p_table
            )
       into v_sort;
  end if;

  if v_kind is not null then
    v_path := coalesce(
      v_path,
      case v_kind
        when 'person'    then '/community/' || v_slug
        when 'event'     then '/events/'    || v_slug
        when 'classroom' then '/programs/'  || v_slug
      end
    );

    v_check := public.assert_route_available(v_path, null, null);
    if v_check is not null then return v_check; end if;
  end if;

  v_row := v_row || jsonb_build_object(
             'id',         v_id,
             'slug',       v_slug,
             'published',  false,
             'legacy_ref', null,
             'source_updated_at', null,
             'source_updated_by', null,
             'created_at', timezone('utc', now()),
             'updated_at', timezone('utc', now())
           );

  if p_table = 'pages' then
    v_row := v_row || jsonb_build_object('path', v_path);
  end if;

  if v_sort is not null then
    v_row := v_row || jsonb_build_object('sort_order', v_sort);
  end if;

  perform public.ces_insert_row(p_table, v_row);

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, p_table, v_id, null, null, public.ces_row_json(p_table, v_id)
  );

  -- ---- child rows ---------------------------------------------------------
  if p_table = 'pages' then

    -- Top level first, recording old id -> new id, then the nested rows using
    -- that map so a `session` keeps its `program` children. Two passes rather
    -- than a recursive copy because migration 05's tree is at most two deep.
    for v_sec in
      select s.* from public.page_sections s
       where s.page_id = p_row_id and s.parent_section_id is null
       order by s.sort_order
    loop
      insert into public.page_sections (
        id, legacy_ref, page_id, parent_section_id, kind, sort_order, enabled,
        body, asset_id, caption, happy_verb, quote_text, attribution, embed_url,
        stat_number, stat_caption, program_title, program_description,
        half_day_price, full_day_price, extended_day_price,
        session_title, session_dates, question, answer, data, legacy
      )
      values (
        extensions.gen_random_uuid(), null, v_id, null, v_sec.kind,
        v_sec.sort_order, v_sec.enabled,
        v_sec.body, v_sec.asset_id, v_sec.caption, v_sec.happy_verb,
        v_sec.quote_text, v_sec.attribution, v_sec.embed_url,
        v_sec.stat_number, v_sec.stat_caption, v_sec.program_title,
        v_sec.program_description, v_sec.half_day_price, v_sec.full_day_price,
        v_sec.extended_day_price, v_sec.session_title, v_sec.session_dates,
        v_sec.question, v_sec.answer, v_sec.data, v_sec.legacy
      )
      returning id into v_parent;                 -- reused as "new section id"

      v_map := v_map || jsonb_build_object(v_sec.id::text, v_parent);

      perform public.ces_write_revision(
        v_cs, 'page_sections', v_parent, null, null,
        public.ces_row_json('pages', v_id)
      );
    end loop;

    for v_sec in
      select s.* from public.page_sections s
       where s.page_id = p_row_id and s.parent_section_id is not null
       order by s.parent_section_id, s.sort_order
    loop
      insert into public.page_sections (
        id, legacy_ref, page_id, parent_section_id, kind, sort_order, enabled,
        body, asset_id, caption, happy_verb, quote_text, attribution, embed_url,
        stat_number, stat_caption, program_title, program_description,
        half_day_price, full_day_price, extended_day_price,
        session_title, session_dates, question, answer, data, legacy
      )
      values (
        extensions.gen_random_uuid(), null, v_id,
        (v_map ->> v_sec.parent_section_id::text)::uuid,
        v_sec.kind, v_sec.sort_order, v_sec.enabled,
        v_sec.body, v_sec.asset_id, v_sec.caption, v_sec.happy_verb,
        v_sec.quote_text, v_sec.attribution, v_sec.embed_url,
        v_sec.stat_number, v_sec.stat_caption, v_sec.program_title,
        v_sec.program_description, v_sec.half_day_price, v_sec.full_day_price,
        v_sec.extended_day_price, v_sec.session_title, v_sec.session_dates,
        v_sec.question, v_sec.answer, v_sec.data, v_sec.legacy
      );
    end loop;

    insert into public.page_classrooms (page_id, classroom_id, sort_order)
    select v_id, pc.classroom_id, pc.sort_order
      from public.page_classrooms pc
     where pc.page_id = p_row_id;

  elsif p_table = 'people' then

    insert into public.person_education
      (person_id, institution_name, sort_order, enabled, legacy)
    select v_id, pe.institution_name, pe.sort_order, pe.enabled, pe.legacy
      from public.person_education pe
     where pe.person_id = p_row_id;

    -- Also what satisfies migration 06's deferred role invariant for the copy.
    insert into public.person_roles (person_id, term_id)
    select v_id, pr.term_id
      from public.person_roles pr
     where pr.person_id = p_row_id;

  elsif p_table = 'promoted' then

    insert into public.promoted_links
      (promoted_id, link_title, link_url, sort_order, legacy)
    select v_id, pl.link_title, pl.link_url, pl.sort_order, pl.legacy
      from public.promoted_links pl
     where pl.promoted_id = p_row_id;

  elsif p_table = 'classrooms' then

    insert into public.classroom_teachers
      (classroom_id, person_id, sort_order, source)
    select v_id, ct.person_id, ct.sort_order, ct.source
      from public.classroom_teachers ct
     where ct.classroom_id = p_row_id;

  end if;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'id', v_id, 'copied_from', p_row_id,
      'slug', v_slug, 'path', v_path, 'published', false
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 12.4 update-slug · capability `edit`
-- -----------------------------------------------------------------------------
-- SEPARATE FROM update-text, and this is one of the three separations the design
-- insists on. A slug is not a text field that happens to be short: changing it
-- MOVES A URL. That means it must take the advisory lock in section 7, it must
-- re-materialize the page's path, and for a page with children it must rewrite
-- every descendant path in the same transaction. None of that belongs in the
-- function that fixes typos in paragraphs, and folding it in would mean either
-- update_text took the route lock on every call or slug changes silently skipped
-- it.
--
-- THE THREE UNROUTED COLLECTIONS take no lock and rewrite no path, because
-- announcements, promoted and inspiring_quotes have no route pattern — they
-- render inside other pages. Their slug is still unique and still validated; it
-- simply does not name a URL.
--
-- THE SITE ROOT KEEPS ITS PATH. home has parent_id null and path '/' because
-- content/collections/pages.yaml sets structure.root = true. Renaming its slug
-- is harmless and is allowed — the slug is not in its URL — so the path is left
-- at '/' rather than becoming '/new-slug'. Recomputing it would move the home
-- page, which is the one URL on the site that certainly must not move.
create or replace function public.update_slug(
  p_table               text,
  p_row_id              uuid,
  p_slug                text,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_slug     text;
  v_old_slug text;
  v_kind     text;
  v_old_path text;
  v_new_path text;
  v_parent   uuid;
  v_taken    boolean;
  v_desc     record;
  v_moved    integer := 0;
begin
  v_check := public.ces_guard('edit', 'update-slug');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  v_slug := nullif(btrim(coalesce(p_slug, '')), '');

  if not public.ces_valid_slug(v_slug) then
    return public.ces_result_error(
      'invalid',
      'A web address must be lowercase words separated by hyphens.',
      jsonb_build_object('slug', v_slug)
    );
  end if;

  v_check := public.ces_check_conflict(p_table, p_row_id, p_expected_updated_at);
  if v_check is not null then return v_check; end if;

  execute format('select t.slug from public.%I t where t.id = $1', p_table)
     into v_old_slug
    using p_row_id;

  if v_old_slug is null then
    return public.ces_result_error(
      'not_found', 'That entry no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  if v_old_slug = v_slug then
    -- A no-op re-save. Nothing to lock, nothing to move, nothing to audit.
    return public.ces_result_ok(
      null,
      jsonb_build_object('table', p_table, 'row_id', p_row_id,
                         'slug', v_slug, 'unchanged', true)
    );
  end if;

  execute format(
            'select exists (select 1 from public.%I t where t.slug = $1 and t.id <> $2)',
            p_table
          )
     into v_taken
    using v_slug, p_row_id;

  if v_taken then
    return public.ces_result_error(
      'invalid', 'That web address is already used in this collection.',
      jsonb_build_object('table', p_table, 'slug', v_slug)
    );
  end if;

  v_kind := public.ces_route_kind(p_table);
  v_cs   := public.ces_new_change_set();

  if v_kind is null then
    -- Unrouted: the slug is an identifier, not an address.
    execute format('update public.%I t set slug = $1 where t.id = $2', p_table)
      using v_slug, p_row_id;

    perform public.ces_write_revision(
      v_cs, p_table, p_row_id, 'slug',
      to_jsonb(v_old_slug), to_jsonb(v_slug)
    );

    return public.ces_result_ok(
      v_cs,
      jsonb_build_object('table', p_table, 'row_id', p_row_id, 'slug', v_slug)
    );
  end if;

  -- ---- routed ------------------------------------------------------------
  if p_table = 'pages' then
    select p.path, p.parent_id into v_old_path, v_parent
      from public.pages p where p.id = p_row_id;

    if v_old_path = '/' then
      -- The site root. Slug changes, path does not. See the note above.
      v_new_path := '/';
    else
      v_new_path := public.ces_page_path(v_parent, v_slug);
    end if;
  else
    v_old_path := public.ces_route_path(p_table, p_row_id, v_old_slug);
    v_new_path := case v_kind
                    when 'person'    then '/community/' || v_slug
                    when 'event'     then '/events/'    || v_slug
                    when 'classroom' then '/programs/'  || v_slug
                  end;
  end if;

  if v_new_path <> v_old_path then
    -- The lock, and the self-exclusion migration 15 line 385 warns about: this
    -- row must not be treated as colliding with itself.
    v_check := public.assert_route_available(v_new_path, v_kind, p_row_id);
    if v_check is not null then return v_check; end if;
  end if;

  execute format('update public.%I t set slug = $1 where t.id = $2', p_table)
    using v_slug, p_row_id;

  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, 'slug', to_jsonb(v_old_slug), to_jsonb(v_slug)
  );

  if p_table = 'pages' and v_new_path <> v_old_path then

    -- Every descendant moves with it. Their new paths must be free too, and
    -- they are asserted BEFORE anything is rewritten so a collision deeper in
    -- the subtree refuses the whole move rather than leaving it half applied.
    for v_desc in
      with recursive sub (id, old_path, new_path) as (
        select p.id, p.path, v_new_path
          from public.pages p where p.id = p_row_id
        union all
        select c.id,
               c.path,
               s.new_path || '/' || c.slug
          from public.pages c
          join sub s on c.parent_id = s.id
      )
      select id, old_path, new_path from sub where id <> p_row_id
    loop
      v_check := public.assert_route_available(v_desc.new_path, 'page', v_desc.id);
      if v_check is not null then return v_check; end if;
    end loop;

    for v_desc in
      with recursive sub (id, old_path, new_path) as (
        select p.id, p.path, v_new_path
          from public.pages p where p.id = p_row_id
        union all
        select c.id,
               c.path,
               s.new_path || '/' || c.slug
          from public.pages c
          join sub s on c.parent_id = s.id
      )
      select id, old_path, new_path from sub
    loop
      update public.pages set path = v_desc.new_path where id = v_desc.id;

      perform public.ces_write_revision(
        v_cs, 'pages', v_desc.id, 'path',
        to_jsonb(v_desc.old_path), to_jsonb(v_desc.new_path)
      );

      v_moved := v_moved + 1;
    end loop;

  elsif p_table = 'pages' then
    -- Root page: slug changed, path deliberately unchanged.
    v_moved := 0;
  end if;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'row_id', p_row_id, 'slug', v_slug,
      'old_path', v_old_path, 'path', v_new_path, 'paths_rewritten', v_moved
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 12.5 set-published · capability `publish`
-- -----------------------------------------------------------------------------
-- The switch that puts content on the public site, or takes it off. 55 of the
-- 163 migrated entries are drafts — including all 12 promoted items and 3 of the
-- 4 announcements — so this is the command that makes the dormant home-page
-- carousel and announcement banner come alive, and the migration deliberately
-- does not do it on the school's behalf.
--
-- IT RECOMPUTES ASSET VISIBILITY, which is the half that is easy to forget. The
-- section 9 predicate is existential over PUBLISHED referrers, so publishing a
-- row can be the thing that makes its images public and unpublishing can be the
-- thing that makes them private — but only when no OTHER published row still
-- references them. That is why the move plan is computed rather than assumed:
-- unpublishing one of two published referrers must demote nothing at all.
--
-- ces_row_asset_ids includes a page's SECTION assets as well as its own columns,
-- because that is where most page photography actually lives.
create or replace function public.set_published(
  p_table               text,
  p_row_id              uuid,
  p_published           boolean,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check  jsonb;
  v_cs     uuid;
  v_before boolean;
  v_assets uuid[];
begin
  v_check := public.ces_guard('publish', 'set-published');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  if p_published is null then
    return public.ces_result_error(
      'invalid', 'An entry must be either published or unpublished.'
    );
  end if;

  v_check := public.ces_check_conflict(p_table, p_row_id, p_expected_updated_at);
  if v_check is not null then return v_check; end if;

  execute format('select t.published from public.%I t where t.id = $1', p_table)
     into v_before
    using p_row_id;

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That entry no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  -- Collected before the flip so a page's section assets are captured even if
  -- the reference graph changes underneath; the PLAN is computed after.
  v_assets := public.ces_row_asset_ids(p_table, p_row_id);

  execute format('update public.%I t set published = $1 where t.id = $2', p_table)
    using p_published, p_row_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, 'published',
    to_jsonb(v_before), to_jsonb(p_published)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'row_id', p_row_id, 'published', p_published,
      'asset_moves', public.ces_asset_move_plan(v_assets)
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 12.6 reorder-entries · capability `reorder`
-- -----------------------------------------------------------------------------
-- Four collections only, and `unsupported` for the other three — see
-- ces_is_orderable in 12.1 for why that is a schema fact rather than a policy.
-- Returning a typed `unsupported` rather than silently succeeding matters: the
-- collection surface uses it to decide whether to render drag handles at all,
-- and a control that appears to work and changes nothing is worse than no
-- control.
--
-- pages ARE SCOPED BY parent_id; the other three are flat, so p_parent_id must be
-- null for them. A flat collection with a parent scope would silently renumber
-- the wrong set.
--
-- `set constraints ... deferred` for the same reason as reorder_sections: a
-- renumber passes through colliding intermediate states, and migration 04
-- declared pages_parent_sort_order_key deferrable precisely so this function
-- could opt in for the length of its transaction.
create or replace function public.reorder_entries(
  p_table       text,
  p_parent_id   uuid,
  p_ordered_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_given    integer;
  v_expected integer;
  v_row      record;
  v_moved    integer := 0;
begin
  v_check := public.ces_guard('reorder', 'reorder-entries');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  if not public.ces_is_orderable(p_table) then
    return public.ces_result_error(
      'unsupported',
      'This collection has no manual order.',
      jsonb_build_object('table', p_table)
    );
  end if;

  if p_table <> 'pages' and p_parent_id is not null then
    return public.ces_result_error(
      'invalid',
      'This collection is a flat list and has no parent scope.',
      jsonb_build_object('table', p_table, 'parent_id', p_parent_id)
    );
  end if;

  if p_ordered_ids is null or array_length(p_ordered_ids, 1) is null then
    return public.ces_result_error(
      'invalid', 'An order must list at least one entry.'
    );
  end if;

  v_given := array_length(p_ordered_ids, 1);

  if v_given <> (select count(distinct u) from unnest(p_ordered_ids) u) then
    return public.ces_result_error(
      'invalid', 'That order lists the same entry more than once.'
    );
  end if;

  if p_table = 'pages' then
    select count(*) into v_expected
      from public.pages p
     where p.parent_id is not distinct from p_parent_id;
  else
    execute format('select count(*) from public.%I t', p_table) into v_expected;
  end if;

  if v_expected = 0 then
    return public.ces_result_error(
      'not_found', 'There are no entries to reorder here.',
      jsonb_build_object('table', p_table, 'parent_id', p_parent_id)
    );
  end if;

  -- Complete-set check, both directions, exactly as in reorder_sections.
  if p_table = 'pages' then
    if v_given <> v_expected
       or exists (
            select 1 from unnest(p_ordered_ids) u
            where not exists (
              select 1 from public.pages p
               where p.id = u
                 and p.parent_id is not distinct from p_parent_id
            )
          ) then
      return public.ces_result_error(
        'invalid',
        'A reorder must list every entry in this group exactly once.',
        jsonb_build_object('expected', v_expected, 'received', v_given)
      );
    end if;

    set constraints public.pages_parent_sort_order_key deferred;
  else
    declare
      v_bad integer;
    begin
      execute format(
                'select count(*) from unnest($1) u
                  where not exists (select 1 from public.%I t where t.id = u)',
                p_table
              )
         into v_bad
        using p_ordered_ids;

      if v_given <> v_expected or v_bad > 0 then
        return public.ces_result_error(
          'invalid',
          'A reorder must list every entry in this collection exactly once.',
          jsonb_build_object('expected', v_expected, 'received', v_given)
        );
      end if;
    end;
  end if;

  v_cs := public.ces_new_change_set();

  for v_row in
    select o.id, o.ord as new_order
      from unnest(p_ordered_ids) with ordinality as o(id, ord)
  loop
    declare
      v_old integer;
    begin
      execute format(
                'select t.sort_order from public.%I t where t.id = $1', p_table
              )
         into v_old
        using v_row.id;

      if v_old is distinct from v_row.new_order then
        execute format(
                  'update public.%I t set sort_order = $1 where t.id = $2', p_table
                )
          using v_row.new_order, v_row.id;

        perform public.ces_write_revision(
          v_cs, p_table, v_row.id, 'sort_order',
          to_jsonb(v_old), to_jsonb(v_row.new_order)
        );

        v_moved := v_moved + 1;
      end if;
    end;
  end loop;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'parent_id', p_parent_id,
      'entries', v_given, 'moved', v_moved
    )
  );
end;
$fn$;



-- -----------------------------------------------------------------------------
-- 12.7 The deletion blockers, and delete-entry · capability `delete_entry`
-- -----------------------------------------------------------------------------
-- ADMIN ONLY. The legacy `editor` role could delete entries in all seven
-- collections including other authors'; the target withholds that, which is one
-- of the five capability reductions the school is asked to approve at cutover.
-- Destructive authority and daily editing are different jobs.
--
-- PAGE DELETION BLOCKS on four things, and each blocker exists because the
-- alternative is silent damage rather than mere untidiness:
--
--   children            pages.parent_id cascades, so deleting a parent would
--                       delete its children and their URLs with it. Naming them
--                       lets the operator move them first.
--   nav_items           target_page_id cascades too (migration 12), so the menu
--                       entry would vanish along with the page — the visitor
--                       loses the link with no trace of why.
--   announcements       link_page_id is `on delete set null` (migration 10), so
--                       the banner would keep rendering with its link silently
--                       gone. That is the dangling-link state the corpus already
--                       contains once, and it should not be created on purpose.
--   page_classrooms     the ordered page-to-classroom relation, which cascades.
--
-- Migration 12 line 476 and migration 08 line 991 both state this blocking as
-- PRODUCT BEHAVIOUR that migration 16 owns, so it is not a local choice.
--
-- The other six collections have no blockers: their children cascade and nothing
-- else points at them. A person's classroom_teachers rows, person_roles and
-- person_education go with them, which is correct — they describe that person.
create or replace function public.ces_entry_blockers(
  p_table  text,
  p_row_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(b), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'table', 'pages', 'id', c.id, 'title', c.title,
               'relation', 'child page'
             ) as b
        from public.pages c
       where p_table = 'pages' and c.parent_id = p_row_id

      union all

      select jsonb_build_object(
               'table', 'nav_items', 'id', n.id, 'title', n.label,
               'relation', 'navigation item'
             )
        from public.nav_items n
       where p_table = 'pages' and n.target_page_id = p_row_id

      union all

      select jsonb_build_object(
               'table', 'announcements', 'id', a.id, 'title', a.title,
               'relation', 'announcement link'
             )
        from public.announcements a
       where p_table = 'pages' and a.link_page_id = p_row_id

      union all

      select jsonb_build_object(
               'table', 'page_classrooms', 'id', pc.id, 'title', cl.title,
               'relation', 'classroom listed on this page'
             )
        from public.page_classrooms pc
        join public.classrooms cl on cl.id = pc.classroom_id
       where p_table = 'pages' and pc.page_id = p_row_id
    ) blockers
$fn$;

create or replace function public.delete_entry(
  p_table  text,
  p_row_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   jsonb;
  v_blockers jsonb;
  v_assets   uuid[];
begin
  v_check := public.ces_guard('delete_entry', 'delete-entry');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  v_before := public.ces_row_json(p_table, p_row_id);

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That entry no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  v_blockers := public.ces_entry_blockers(p_table, p_row_id);

  if v_blockers <> '[]'::jsonb then
    return public.ces_result_error(
      'blocked',
      'Other records still point at this page. Detach them first, or force the deletion.',
      jsonb_build_object(
        'table', p_table, 'row_id', p_row_id, 'blockers', v_blockers
      )
    );
  end if;

  -- Gathered before the delete, because afterwards there is nothing to ask.
  v_assets := public.ces_row_asset_ids(p_table, p_row_id);

  v_cs := public.ces_new_change_set();

  -- A whole-row event: the full row in value_before, column_name null, exactly
  -- as migration 14 specifies. This is also what makes the row restorable.
  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, null, v_before, null
  );

  execute format('delete from public.%I t where t.id = $1', p_table)
    using p_row_id;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'row_id', p_row_id, 'forced', false,
      'asset_moves', public.ces_asset_move_plan(v_assets)
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 12.8 force-delete-entry · capability `delete_entry`
-- -----------------------------------------------------------------------------
-- A SEPARATE FUNCTION, not a boolean on delete_entry, for the same reason
-- force_delete_term is separate: "delete this even though things reference it" is
-- a different authority from "delete this", and a flag would let a call site pass
-- it quietly. Here the destructive path is named at every call site and in every
-- audit row.
--
-- IT REMOVES THE REFERENCES IN THE SAME TRANSACTION, UNDER ONE CHANGE SET, AND
-- NEVER ORPHANS A ROUTE. Concretely, for a page:
--
--   nav_items rows pointing at it       deleted, each audited
--   announcements.link_page_id          set null, each audited — the banner then
--                                       renders without a link, which is the
--                                       behaviour migration 10 already defines
--                                       for the one dangling link in the corpus
--   page_classrooms rows                deleted, each audited
--   descendant pages                    deleted, DEEPEST FIRST, each recorded as
--                                       a whole-row revision
--
-- Descendants are deleted explicitly rather than left to the cascade, and the
-- ordering matters: the cascade would remove them with no audit rows at all, so
-- a restore would have nothing to work from and the change set would claim to
-- describe a move it could not reverse. Deleting deepest-first also means each
-- delete sees its own children already gone, so no route is ever left pointing
-- at a parent that no longer exists — which is what "never orphans a route"
-- actually requires.
create or replace function public.force_delete_entry(
  p_table  text,
  p_row_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_before  jsonb;
  v_assets  uuid[];
  v_row     record;
  v_navs    integer := 0;
  v_anns    integer := 0;
  v_pcs     integer := 0;
  v_kids    integer := 0;
begin
  v_check := public.ces_guard('delete_entry', 'force-delete-entry');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not public.ces_is_collection(p_table) then
    return public.ces_result_error(
      'invalid', 'That is not a content collection.',
      jsonb_build_object('table', p_table)
    );
  end if;

  v_before := public.ces_row_json(p_table, p_row_id);

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That entry no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  v_assets := public.ces_row_asset_ids(p_table, p_row_id);
  v_cs     := public.ces_new_change_set();

  if p_table = 'pages' then

    -- Every asset in the doomed subtree, not only the page's own.
    for v_row in
      with recursive sub (id) as (
        select p_row_id
        union all
        select c.id from public.pages c join sub s on c.parent_id = s.id
      )
      select id from sub
    loop
      v_assets := array_cat(v_assets, public.ces_row_asset_ids('pages', v_row.id));
    end loop;

    -- References into the subtree, audited then removed.
    for v_row in
      with recursive sub (id) as (
        select p_row_id
        union all
        select c.id from public.pages c join sub s on c.parent_id = s.id
      )
      select n.id, to_jsonb(n) as row from public.nav_items n
       where n.target_page_id in (select id from sub)
    loop
      perform public.ces_write_revision(
        v_cs, 'nav_items', v_row.id, null, v_row.row, null
      );
      delete from public.nav_items where id = v_row.id;
      v_navs := v_navs + 1;
    end loop;

    for v_row in
      with recursive sub (id) as (
        select p_row_id
        union all
        select c.id from public.pages c join sub s on c.parent_id = s.id
      )
      select a.id, a.link_page_id from public.announcements a
       where a.link_page_id in (select id from sub)
    loop
      perform public.ces_write_revision(
        v_cs, 'announcements', v_row.id, 'link_page_id',
        to_jsonb(v_row.link_page_id), null
      );
      update public.announcements set link_page_id = null where id = v_row.id;
      v_anns := v_anns + 1;
    end loop;

    for v_row in
      with recursive sub (id) as (
        select p_row_id
        union all
        select c.id from public.pages c join sub s on c.parent_id = s.id
      )
      select pc.id, to_jsonb(pc) as row from public.page_classrooms pc
       where pc.page_id in (select id from sub)
    loop
      perform public.ces_write_revision(
        v_cs, 'page_classrooms', v_row.id, null, v_row.row, null
      );
      delete from public.page_classrooms where id = v_row.id;
      v_pcs := v_pcs + 1;
    end loop;

    -- Descendants, DEEPEST FIRST, each audited as a whole row. Ordering by
    -- descending depth is what keeps every delete a leaf delete.
    for v_row in
      with recursive sub (id, depth) as (
        select p_row_id, 1
        union all
        select c.id, s.depth + 1
          from public.pages c join sub s on c.parent_id = s.id
      )
      select sub.id, to_jsonb(p) as row
        from sub
        join public.pages p on p.id = sub.id
       where sub.id <> p_row_id
       order by sub.depth desc
    loop
      perform public.ces_write_revision(
        v_cs, 'pages', v_row.id, null, v_row.row, null
      );
      delete from public.pages where id = v_row.id;
      v_kids := v_kids + 1;
    end loop;

  end if;

  perform public.ces_write_revision(
    v_cs, p_table, p_row_id, null, v_before, null
  );

  execute format('delete from public.%I t where t.id = $1', p_table)
    using p_row_id;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'table', p_table, 'row_id', p_row_id, 'forced', true,
      'nav_items_removed', v_navs,
      'announcement_links_cleared', v_anns,
      'page_classrooms_removed', v_pcs,
      'descendant_pages_deleted', v_kids,
      'asset_moves', public.ces_asset_move_plan(v_assets)
    )
  );
end;
$fn$;


-- =============================================================================
-- 13. Structure — six commands, ALL ADMIN ONLY
-- =============================================================================
-- Every command in this section is gated by an admin-only capability:
-- manage_nav, manage_taxonomy or manage_globals. That is a deliberate REDUCTION
-- of what the legacy `editor` role held — resources/users/roles.yaml gave it
-- taxonomy term creation and deletion and `reorder pages entries`, which is what
-- edits the page hierarchy — and it is the resolution of the inverted permission
-- model migration 13 describes. The account that edits copy every day should not
-- also be the one that can reorganize the navigation or delete a taxonomy term.
-- The reduction is enumerated for the school's approval as a cutover gate; it is
-- not this file's to soften.

-- -----------------------------------------------------------------------------
-- 13.1 reparent-page · capability `manage_nav`
-- -----------------------------------------------------------------------------
-- PAGE HIERARCHY IS NAVIGATION AUTHORITY, which is why this sits under
-- manage_nav rather than under `edit`: pages.parent_id determines pages.path, so
-- a reparent REWRITES URLS — this page's and every descendant's.
--
-- NO PAGE IS REPARENTED BY THE MIGRATION ITSELF. All 142 paths are preserved
-- exactly as the legacy site served them, and the parity gate asserts it. This
-- function is future machinery for the school, and it has to work correctly
-- precisely because the first person to use it will be doing so on a live site.
--
-- SIX THINGS IT ENFORCES, in this order, because each depends on the last:
--
--   1. THE SITE ROOT CANNOT MOVE. home's path is '/' because
--      content/collections/pages.yaml sets structure.root = true. There is no
--      coherent meaning to nesting it, and its URL is the one that certainly
--      must not change.
--   2. NO CYCLE. The new parent may not be the page itself, nor any of its
--      descendants. Without this a subtree detaches from the root entirely and
--      becomes unreachable while still holding its paths — a page that exists,
--      owns a URL, and can never be rendered or found again.
--   3. max_depth 2. Checked against the WHOLE SUBTREE, not just the page: moving
--      a parent under another parent would put its children at depth 3. This is
--      the check that a naive implementation gets wrong, because the page being
--      moved is itself legal at the new depth.
--   4. EVERY NEW PATH IS AVAILABLE — the page's and every descendant's — each
--      asserted through section 7 under the advisory lock, and ALL of them
--      BEFORE anything is rewritten. A collision three levels into the subtree
--      must refuse the whole move rather than leave half a tree rewritten.
--   5. ALL DESCENDANT PATHS ARE REWRITTEN IN THIS TRANSACTION. A path is
--      materialized rather than generated (migration 04 explains why), so
--      nothing recomputes it later; if this function does not rewrite it, it
--      stays wrong forever.
--   6. ONE REVISION ROW PER AFFECTED ROW, ALL SHARING ONE change_set_id. This is
--      what makes the move reversible AS A MOVE. Recording only the page's own
--      parent_id would leave a restore that reattaches the page and leaves
--      twenty descendant paths pointing at the old location.
--
-- A concurrent reparent losing the race ROLLS BACK CLEANLY: every path
-- assertion and every rewrite is in one transaction, so the loser leaves no
-- partial rewrite behind.
create or replace function public.reparent_page(
  p_page_id       uuid,
  p_new_parent_id uuid,
  p_position      integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check      jsonb;
  v_cs         uuid;
  v_slug       text;
  v_old_parent uuid;
  v_old_path   text;
  v_new_path   text;
  v_height     integer;
  v_new_depth  integer;
  v_siblings   integer;
  v_pos        integer;
  v_desc       record;
  v_row        record;
  v_moved      integer := 0;
begin
  v_check := public.ces_guard('manage_nav', 'reparent-page');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select p.slug, p.parent_id, p.path
    into v_slug, v_old_parent, v_old_path
    from public.pages p where p.id = p_page_id;

  if v_slug is null then
    return public.ces_result_error(
      'not_found', 'That page no longer exists.',
      jsonb_build_object('page_id', p_page_id)
    );
  end if;

  -- (1) the site root
  if v_old_path = '/' then
    return public.ces_result_error(
      'invariant',
      'The home page cannot be moved.',
      jsonb_build_object('page_id', p_page_id, 'path', v_old_path)
    );
  end if;

  if p_new_parent_id is not null then
    if not exists (select 1 from public.pages p where p.id = p_new_parent_id) then
      return public.ces_result_error(
        'not_found', 'That destination page does not exist.',
        jsonb_build_object('parent_id', p_new_parent_id)
      );
    end if;

    -- (2) no cycle: the destination may be neither the page nor a descendant.
    if p_new_parent_id = p_page_id
       or exists (
            with recursive sub (id) as (
              select p_page_id
              union all
              select c.id from public.pages c join sub s on c.parent_id = s.id
            )
            select 1 from sub where id = p_new_parent_id
          ) then
      return public.ces_result_error(
        'invariant',
        'A page cannot be moved inside itself.',
        jsonb_build_object('page_id', p_page_id, 'parent_id', p_new_parent_id)
      );
    end if;
  end if;

  -- (3) depth, measured across the whole subtree
  v_height    := public.ces_page_subtree_height(p_page_id);
  v_new_depth := case
                   when p_new_parent_id is null then 1
                   else public.ces_page_depth(p_new_parent_id) + 1
                 end;

  if v_new_depth + v_height - 1 > 2 then
    return public.ces_result_error(
      'invariant',
      'Pages can only be nested two levels deep, and this move would go deeper.',
      jsonb_build_object(
        'new_depth', v_new_depth, 'subtree_height', v_height, 'max_depth', 2
      )
    );
  end if;

  v_new_path := public.ces_page_path(p_new_parent_id, v_slug);

  if v_new_path is null then
    return public.ces_result_error(
      'invalid', 'That destination has no address to nest under.',
      jsonb_build_object('parent_id', p_new_parent_id)
    );
  end if;

  -- (4) every new path, asserted before anything moves
  for v_desc in
    with recursive sub (id, old_path, new_path) as (
      select p_page_id, v_old_path, v_new_path
      union all
      select c.id, c.path, s.new_path || '/' || c.slug
        from public.pages c
        join sub s on c.parent_id = s.id
    )
    select id, old_path, new_path from sub where new_path <> old_path
  loop
    v_check := public.assert_route_available(v_desc.new_path, 'page', v_desc.id);
    if v_check is not null then return v_check; end if;
  end loop;

  v_cs := public.ces_new_change_set();

  -- Renumbering necessarily passes through colliding positions; migration 04
  -- made pages_parent_sort_order_key deferrable for exactly this transaction.
  set constraints public.pages_parent_sort_order_key deferred;

  -- The move itself. sort_order is set below by the renumber.
  update public.pages set parent_id = p_new_parent_id where id = p_page_id;

  perform public.ces_write_revision(
    v_cs, 'pages', p_page_id, 'parent_id',
    to_jsonb(v_old_parent), to_jsonb(p_new_parent_id)
  );

  -- (5) all paths, in one transaction
  for v_desc in
    with recursive sub (id, old_path, new_path) as (
      select p_page_id, v_old_path, v_new_path
      union all
      select c.id, c.path, s.new_path || '/' || c.slug
        from public.pages c
        join sub s on c.parent_id = s.id
    )
    select id, old_path, new_path from sub where new_path <> old_path
  loop
    update public.pages set path = v_desc.new_path where id = v_desc.id;

    -- (6) one row per affected row, same change set
    perform public.ces_write_revision(
      v_cs, 'pages', v_desc.id, 'path',
      to_jsonb(v_desc.old_path), to_jsonb(v_desc.new_path)
    );

    v_moved := v_moved + 1;
  end loop;

  -- Position within the destination's children. Clamped rather than rejected: a
  -- caller asking for position 99 in a set of four plainly means "last".
  select count(*) into v_siblings
    from public.pages p where p.parent_id is not distinct from p_new_parent_id;

  v_pos := greatest(1, least(coalesce(p_position, v_siblings), v_siblings));

  for v_row in
    select p.id,
           p.sort_order as old_order,
           row_number() over (
             order by
               case when p.id = p_page_id then v_pos - 0.5
                    else p.sort_order::numeric end,
               p.slug
           ) as new_order
      from public.pages p
     where p.parent_id is not distinct from p_new_parent_id
  loop
    if v_row.old_order is distinct from v_row.new_order then
      update public.pages set sort_order = v_row.new_order where id = v_row.id;

      perform public.ces_write_revision(
        v_cs, 'pages', v_row.id, 'sort_order',
        to_jsonb(v_row.old_order), to_jsonb(v_row.new_order)
      );
    end if;
  end loop;

  -- The set the page LEFT closes its gap, so positions stay contiguous. Guarded
  -- positively: when the parent did not actually change, the loop above already
  -- renumbered this very set and running it again would be wasted work.
  if v_old_parent is distinct from p_new_parent_id then
    for v_row in
      select p.id,
             p.sort_order as old_order,
             row_number() over (order by p.sort_order, p.slug) as new_order
        from public.pages p
       where p.parent_id is not distinct from v_old_parent
    loop
      if v_row.old_order is distinct from v_row.new_order then
        update public.pages set sort_order = v_row.new_order where id = v_row.id;

        perform public.ces_write_revision(
          v_cs, 'pages', v_row.id, 'sort_order',
          to_jsonb(v_row.old_order), to_jsonb(v_row.new_order)
        );
      end if;
    end loop;
  end if;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'page_id', p_page_id,
      'old_parent_id', v_old_parent, 'new_parent_id', p_new_parent_id,
      'old_path', v_old_path, 'path', v_new_path,
      'position', v_pos, 'paths_rewritten', v_moved
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 13.2 update-nav-tree · capability `manage_nav`
-- -----------------------------------------------------------------------------
-- NAVIGATION IS A SEPARATE MODEL FROM ROUTING, and this command is why that
-- separation was worth building. pages.parent_id determines pages.path, so
-- expressing "Donate belongs under Giving in the menu" by reparenting the page
-- would move the URL to /giving/donate and break a live address. nav_items
-- carries menu structure independently, so grouping, labelling, ordering and
-- audience can all change WITHOUT MOVING A SINGLE URL. Every information-
-- architecture improvement in the plan is expressible here for that reason.
--
-- WHOLE-TREE REPLACE, because NavTreeEditor edits a tree and submits a tree.
-- Items in the payload are upserted; items absent from it are DELETED. A
-- per-item command would make a drag-and-drop reorder into a dozen calls with no
-- way to make them one reversible change set, and would leave the tree
-- inconsistent if one of them failed.
--
-- VALIDATED WHOLLY BEFORE ANYTHING IS WRITTEN. Five rules:
--
--   * a label is required — an item with no label renders as nothing;
--   * audience is one of prospective, enrolled, both;
--   * AT MOST ONE DESTINATION. migration 12 holds this in a check constraint
--     too, because a row carrying both an internal page and an external URL is
--     ambiguous and whichever NavTree picked would make the other a silent lie.
--     Neither is legal as well: that is a label-only group heading, which is
--     exactly what "Considering CES" and "Our Community" are;
--   * an internal target must exist;
--   * an external URL must be https or root-relative. donate_url is
--     root-relative in the migrated data, so requiring absolute https would
--     break it.
--
-- Cycles: migration 12's check constraint stops a row being its OWN parent and
-- says outright that a longer cycle spans rows and cannot be expressed there, so
-- full cycle prevention for the menu belongs here. It is enforced by walking
-- each item's ancestry within the submitted payload.
create or replace function public.update_nav_tree(p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_item    jsonb;
  v_id      uuid;
  v_parent  uuid;
  v_label   text;
  v_target  uuid;
  v_ext     text;
  v_aud     text;
  v_ids     uuid[] := array[]::uuid[];
  v_seen    uuid[];
  v_hops    integer;
  v_before  jsonb;
  v_created integer := 0;
  v_updated integer := 0;
  v_removed integer := 0;
begin
  v_check := public.ces_guard('manage_nav', 'update-nav-tree');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return public.ces_result_error(
      'invalid', 'A navigation tree must be an array of items.'
    );
  end if;

  -- ---- pass 1: validate every item, write nothing -------------------------
  for v_item in select value from jsonb_array_elements(p_items) loop

    v_label := nullif(btrim(coalesce(v_item ->> 'label', '')), '');
    v_aud   := coalesce(v_item ->> 'audience', 'both');
    v_target := nullif(v_item ->> 'target_page_id', '')::uuid;
    v_ext    := nullif(btrim(coalesce(v_item ->> 'external_url', '')), '');

    if v_label is null then
      return public.ces_result_error(
        'invalid', 'Every navigation item needs a label.',
        jsonb_build_object('item', v_item)
      );
    end if;

    if v_aud not in ('prospective', 'enrolled', 'both') then
      return public.ces_result_error(
        'invalid', 'That audience is not one of prospective, enrolled or both.',
        jsonb_build_object('label', v_label, 'audience', v_aud)
      );
    end if;

    if v_target is not null and v_ext is not null then
      return public.ces_result_error(
        'invalid',
        'A navigation item can point at a page or an external address, not both.',
        jsonb_build_object('label', v_label)
      );
    end if;

    if v_target is not null
       and not exists (select 1 from public.pages p where p.id = v_target) then
      return public.ces_result_error(
        'not_found', 'That navigation item points at a page that does not exist.',
        jsonb_build_object('label', v_label, 'target_page_id', v_target)
      );
    end if;

    if v_ext is not null
       and not (v_ext like 'https://%' or v_ext like '/%') then
      return public.ces_result_error(
        'invalid',
        'An external address must start with https:// or be a path beginning /.',
        jsonb_build_object('label', v_label, 'external_url', v_ext)
      );
    end if;

    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id is not null then
      if v_id = any (v_ids) then
        return public.ces_result_error(
          'invalid', 'That navigation tree lists the same item twice.',
          jsonb_build_object('id', v_id)
        );
      end if;
      v_ids := v_ids || v_id;
    end if;
  end loop;

  -- ---- pass 2: cycle detection over the submitted parent links ------------
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_id     := nullif(v_item ->> 'id', '')::uuid;
    v_parent := nullif(v_item ->> 'parent_id', '')::uuid;

    if v_id is null or v_parent is null then
      continue;
    end if;

    if v_parent = v_id then
      return public.ces_result_error(
        'invariant', 'A navigation item cannot be its own parent.',
        jsonb_build_object('id', v_id)
      );
    end if;

    -- Walk upward through the PAYLOAD's links. Bounded by the item count, so a
    -- cycle terminates instead of spinning.
    v_seen := array[v_id];
    v_hops := 0;

    while v_parent is not null loop
      if v_parent = any (v_seen) then
        return public.ces_result_error(
          'invariant',
          'That navigation tree contains a loop.',
          jsonb_build_object('id', v_id, 'at', v_parent)
        );
      end if;

      v_seen := v_seen || v_parent;
      v_hops := v_hops + 1;

      if v_hops > jsonb_array_length(p_items) then
        return public.ces_result_error(
          'invariant', 'That navigation tree contains a loop.',
          jsonb_build_object('id', v_id)
        );
      end if;

      select nullif(e.value ->> 'parent_id', '')::uuid
        into v_parent
        from jsonb_array_elements(p_items) e
       where nullif(e.value ->> 'id', '')::uuid = v_parent;

      exit when not found;
    end loop;
  end loop;

  v_cs := public.ces_new_change_set();

  -- Menu positions collide mid-rewrite exactly as page positions do.
  set constraints public.nav_items_parent_sort_order_key deferred;

  -- ---- pass 3: prune, then upsert ----------------------------------------
  -- Pruning FIRST frees the (parent_id, sort_order) positions the upsert is
  -- about to claim. Children cascade from a removed parent, so a subtree the
  -- editor deleted goes in one statement.
  for v_item in
    select to_jsonb(n) from public.nav_items n
     where not (n.id = any (v_ids))
  loop
    perform public.ces_write_revision(
      v_cs, 'nav_items', (v_item ->> 'id')::uuid, null, v_item, null
    );
    v_removed := v_removed + 1;
  end loop;

  delete from public.nav_items where not (id = any (v_ids));

  for v_item in
    select value from jsonb_array_elements(p_items)
     order by coalesce((value ->> 'sort_order')::integer, 0)
  loop
    v_id := nullif(v_item ->> 'id', '')::uuid;

    if v_id is not null and exists (
      select 1 from public.nav_items n where n.id = v_id
    ) then
      v_before := to_jsonb((select n from public.nav_items n where n.id = v_id));

      update public.nav_items n
         set parent_id      = nullif(v_item ->> 'parent_id', '')::uuid,
             label          = btrim(v_item ->> 'label'),
             target_page_id = nullif(v_item ->> 'target_page_id', '')::uuid,
             external_url   = nullif(btrim(coalesce(v_item ->> 'external_url', '')), ''),
             audience       = coalesce(v_item ->> 'audience', 'both'),
             sort_order     = coalesce((v_item ->> 'sort_order')::integer, n.sort_order),
             visible        = coalesce((v_item ->> 'visible')::boolean, n.visible)
       where n.id = v_id;

      perform public.ces_write_revision(
        v_cs, 'nav_items', v_id, null, v_before,
        to_jsonb((select n from public.nav_items n where n.id = v_id))
      );

      v_updated := v_updated + 1;
    else
      v_id := coalesce(v_id, extensions.gen_random_uuid());

      insert into public.nav_items
        (id, parent_id, label, target_page_id, external_url,
         audience, sort_order, visible)
      values (
        v_id,
        nullif(v_item ->> 'parent_id', '')::uuid,
        btrim(v_item ->> 'label'),
        nullif(v_item ->> 'target_page_id', '')::uuid,
        nullif(btrim(coalesce(v_item ->> 'external_url', '')), ''),
        coalesce(v_item ->> 'audience', 'both'),
        coalesce((v_item ->> 'sort_order')::integer, 1),
        coalesce((v_item ->> 'visible')::boolean, false)
      );

      perform public.ces_write_revision(
        v_cs, 'nav_items', v_id, null, null,
        to_jsonb((select n from public.nav_items n where n.id = v_id))
      );

      v_created := v_created + 1;
    end if;
  end loop;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'created', v_created, 'updated', v_updated, 'removed', v_removed
    )
  );
end;
$fn$;



-- -----------------------------------------------------------------------------
-- 13.3 upsert-term · capability `manage_taxonomy`
-- -----------------------------------------------------------------------------
-- Creates or renames a taxonomy term. One taxonomy exists — `role` — with the
-- three live terms migration 03 seeds: teacher, board-of-directors, leadership.
-- The taxonomy vocabulary is closed by migration 03's check constraint, so a
-- fourth taxonomy would be a schema change and is refused here with a typed
-- result rather than left to raise.
--
-- Terms have NO VISIBILITY COLUMN and this command must not invent one:
-- content/taxonomies/role.yaml declares nothing but `title: Role`, so every term
-- is public and migration 03's policy says so plainly rather than filtering on a
-- field that does not exist.
create or replace function public.upsert_term(
  p_term_id  uuid,
  p_taxonomy text,
  p_slug     text,
  p_title    text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check  jsonb;
  v_cs     uuid;
  v_id     uuid;
  v_slug   text;
  v_title  text;
  v_before jsonb;
begin
  v_check := public.ces_guard('manage_taxonomy', 'upsert-term');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if coalesce(p_taxonomy, '') <> 'role' then
    return public.ces_result_error(
      'invalid',
      'The only taxonomy on this site is Role.',
      jsonb_build_object('taxonomy', p_taxonomy)
    );
  end if;

  v_slug  := nullif(btrim(coalesce(p_slug, '')), '');
  v_title := nullif(btrim(coalesce(p_title, '')), '');

  if not public.ces_valid_slug(v_slug) then
    return public.ces_result_error(
      'invalid',
      'A term needs an identifier in lowercase words separated by hyphens.',
      jsonb_build_object('slug', v_slug)
    );
  end if;

  if v_title is null then
    return public.ces_result_error(
      'invalid', 'A term needs a title.', jsonb_build_object('column', 'title')
    );
  end if;

  -- (taxonomy, slug) is unique in migration 03. Checked here so a clash is a
  -- message on the field rather than a raised constraint violation.
  if exists (
    select 1 from public.taxonomy_terms t
     where t.taxonomy = 'role'
       and t.slug = v_slug
       and (p_term_id is null or t.id <> p_term_id)
  ) then
    return public.ces_result_error(
      'invalid', 'A role with that identifier already exists.',
      jsonb_build_object('slug', v_slug)
    );
  end if;

  v_cs := public.ces_new_change_set();

  if p_term_id is null then
    v_id := extensions.gen_random_uuid();

    -- legacy_ref stays null: a term the school creates has no Statamic source,
    -- and migration 03 made that column nullable-unique for exactly this case.
    insert into public.taxonomy_terms (id, taxonomy, slug, title)
    values (v_id, 'role', v_slug, v_title);

    perform public.ces_write_revision(
      v_cs, 'taxonomy_terms', v_id, null, null,
      to_jsonb((select t from public.taxonomy_terms t where t.id = v_id))
    );

    return public.ces_result_ok(
      v_cs, jsonb_build_object('id', v_id, 'slug', v_slug, 'created', true)
    );
  end if;

  select to_jsonb(t) into v_before
    from public.taxonomy_terms t where t.id = p_term_id;

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That role no longer exists.',
      jsonb_build_object('term_id', p_term_id)
    );
  end if;

  update public.taxonomy_terms
     set slug = v_slug, title = v_title
   where id = p_term_id;

  perform public.ces_write_revision(
    v_cs, 'taxonomy_terms', p_term_id, null, v_before,
    to_jsonb((select t from public.taxonomy_terms t where t.id = p_term_id))
  );

  return public.ces_result_ok(
    v_cs, jsonb_build_object('id', p_term_id, 'slug', v_slug, 'created', false)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 13.4 delete-term · capability `manage_taxonomy`
-- -----------------------------------------------------------------------------
-- REFERENCE-SAFE, and it has to be for a reason stronger than tidiness.
-- person_roles cascades from taxonomy_terms, so deleting a still-referenced term
-- would silently strip that role from every person holding it — and because
-- migration 06's DEFERRED constraint trigger requires every person to keep at
-- least one role, deleting the only role of any person would ALSO make the whole
-- transaction fail at commit with an error naming a person rather than the term.
-- Migration 06 line 467 says outright that this command refuses instead.
--
-- So the refusal names the people. force_delete_term is the separate authority.
create or replace function public.delete_term(p_term_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   jsonb;
  v_blockers jsonb;
begin
  v_check := public.ces_guard('manage_taxonomy', 'delete-term');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select to_jsonb(t) into v_before
    from public.taxonomy_terms t where t.id = p_term_id;

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That role no longer exists.',
      jsonb_build_object('term_id', p_term_id)
    );
  end if;

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'table', 'people', 'id', pe.id, 'title', pe.name
           ) order by pe.name),
           '[]'::jsonb
         )
    into v_blockers
    from public.person_roles pr
    join public.people pe on pe.id = pr.person_id
   where pr.term_id = p_term_id;

  if v_blockers <> '[]'::jsonb then
    return public.ces_result_error(
      'blocked',
      'That role is still assigned. Reassign these people first, or force the deletion.',
      jsonb_build_object('term_id', p_term_id, 'blockers', v_blockers)
    );
  end if;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'taxonomy_terms', p_term_id, null, v_before, null
  );

  delete from public.taxonomy_terms where id = p_term_id;

  return public.ces_result_ok(
    v_cs, jsonb_build_object('term_id', p_term_id, 'forced', false)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 13.5 force-delete-term · capability `manage_taxonomy`
-- -----------------------------------------------------------------------------
-- A SEPARATE FUNCTION RATHER THAN A BOOLEAN ON delete_term, because "delete this
-- even though things reference it" is a different authority and not a parameter.
-- A flag would mean one call site could quietly pass true, and code review would
-- have to catch it; a separate function means the destructive path is visible in
-- the name at every call site and in every audit row.
--
-- IT DETACHES THE TERM FROM EVERY PERSON IN ONE CHANGE SET, and it refuses if
-- doing so would leave any person with no role at all — which is migration 06's
-- deferred invariant, and it would otherwise fail at commit with an error about a
-- person rather than about the term. Refusing here, naming those people, is the
-- honest answer: the operator has to give them another role first.
create or replace function public.force_delete_term(p_term_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   jsonb;
  v_orphans  jsonb;
  v_row      record;
  v_detached integer := 0;
begin
  v_check := public.ces_guard('manage_taxonomy', 'force-delete-term');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select to_jsonb(t) into v_before
    from public.taxonomy_terms t where t.id = p_term_id;

  if v_before is null then
    return public.ces_result_error(
      'not_found', 'That role no longer exists.',
      jsonb_build_object('term_id', p_term_id)
    );
  end if;

  -- Anybody whose ONLY role is this one. Migration 06's constraint trigger
  -- fires at commit, so this has to be caught before we start deleting.
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'table', 'people', 'id', pe.id, 'title', pe.name
           ) order by pe.name),
           '[]'::jsonb
         )
    into v_orphans
    from public.people pe
   where exists (
           select 1 from public.person_roles pr
            where pr.person_id = pe.id and pr.term_id = p_term_id
         )
     and not exists (
           select 1 from public.person_roles pr
            where pr.person_id = pe.id and pr.term_id <> p_term_id
         );

  if v_orphans <> '[]'::jsonb then
    return public.ces_result_error(
      'blocked',
      'These people have no other role, so this one cannot be removed from them. '
      'Give them another role first.',
      jsonb_build_object('term_id', p_term_id, 'blockers', v_orphans)
    );
  end if;

  v_cs := public.ces_new_change_set();

  for v_row in
    select pr.person_id from public.person_roles pr where pr.term_id = p_term_id
  loop
    perform public.ces_write_revision(
      v_cs, 'person_roles', v_row.person_id, 'term_id',
      to_jsonb(p_term_id), null
    );
    v_detached := v_detached + 1;
  end loop;

  -- One statement, one change set. The cascade from taxonomy_terms would remove
  -- these anyway; deleting them explicitly is what makes the audit complete.
  delete from public.person_roles where term_id = p_term_id;

  perform public.ces_write_revision(
    v_cs, 'taxonomy_terms', p_term_id, null, v_before, null
  );

  delete from public.taxonomy_terms where id = p_term_id;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'term_id', p_term_id, 'forced', true, 'detached_people', v_detached
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 13.6 update-globals · capability `manage_globals`
-- -----------------------------------------------------------------------------
-- DISCRIMINATED BY KEY, which is the same principle as the per-command
-- allowlists in section 11 applied to a key-value table. site_globals is not an
-- arbitrary JSON store: migration 11 fixes 26 keys in a check constraint and 7
-- groups, and each key has a declared shape. This function validates the value
-- AGAINST THE KEY, so `maintenance_enabled` cannot be set to a sentence and
-- `phone` cannot be set to a boolean.
--
-- IT WRITES `value` AND `asset_id` ONLY. Never `key`, never `"group"`, never
-- `public`, never `label`. Migration 11 states that contract and relies on it:
-- it is why no constraint pairs each key to its group, because the pairing is
-- fixed by the seed and cannot drift if this is the only write path. Note that
-- "group" is a reserved word and must stay quoted anywhere it appears.
--
-- THE MAINTENANCE KEYS ARE THE SHARPEST EDGE HERE. They are the only four rows
-- with public = false, and setting maintenance_enabled true takes the public
-- site down behind a 503. That is admin-only, it is confirmed in the UI before it
-- fires, and this function invalidates the `content:globals` cache tag that
-- get_maintenance_state() is read under — without that, the request boundary
-- would keep serving the old flag for a whole revalidation window.
create or replace function public.update_globals(
  p_key      text,
  p_value    jsonb,
  p_asset_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   jsonb;
  v_group    text;
  v_type     text;
  v_text     text;
  v_lifecyc  text;
begin
  v_check := public.ces_guard('manage_globals', 'update-globals');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select g."group", to_jsonb(g) into v_group, v_before
    from public.site_globals g where g.key = p_key;

  if v_before is null then
    -- Either an unknown key or one migration 11 does not admit. Both are the
    -- same answer: the key set is closed and adding one is a migration.
    return public.ces_result_error(
      'not_found',
      'That is not a site setting.',
      jsonb_build_object('key', p_key)
    );
  end if;

  v_type := jsonb_typeof(coalesce(p_value, 'null'::jsonb));
  v_text := p_value #>> '{}';

  -- ---- per-key shape ------------------------------------------------------
  if p_key in ('maintenance_enabled', 'banner_enabled') then
    if v_type <> 'boolean' then
      return public.ces_result_error(
        'invalid', 'That setting is a yes/no value.',
        jsonb_build_object('key', p_key, 'received', v_type)
      );
    end if;

  elsif p_key = 'maintenance_retry_after' then
    if v_type <> 'number' or (p_value #>> '{}')::numeric <= 0 then
      return public.ces_result_error(
        'invalid', 'Retry-after must be a positive number of seconds.',
        jsonb_build_object('key', p_key, 'received', v_type)
      );
    end if;

  elsif p_key = 'logo' then
    -- The one key whose value lives in asset_id rather than in `value`.
    if p_asset_id is null then
      return public.ces_result_error(
        'invalid', 'The logo needs an image.',
        jsonb_build_object('key', p_key)
      );
    end if;

    select a.lifecycle into v_lifecyc
      from public.assets a where a.id = p_asset_id;

    if v_lifecyc is null then
      return public.ces_result_error(
        'not_found', 'That image no longer exists.',
        jsonb_build_object('asset_id', p_asset_id)
      );
    end if;

    if v_lifecyc <> 'stored' then
      return public.ces_result_error(
        'invalid', 'That image is not ready to be used yet.',
        jsonb_build_object('asset_id', p_asset_id, 'lifecycle', v_lifecyc)
      );
    end if;

  elsif p_key in ('instagram_url', 'facebook_url', 'family_portal_url') then
    if v_text is not null and v_text <> ''
       and v_text not like 'https://%' then
      return public.ces_result_error(
        'invalid', 'That address must start with https://.',
        jsonb_build_object('key', p_key)
      );
    end if;

  elsif p_key = 'donate_url' then
    -- ROOT-RELATIVE IS LEGAL HERE, and this exception is deliberate: the
    -- migrated value is '/donate', and demanding absolute https would break the
    -- one call to action the legacy site actually had.
    if v_text is not null and v_text <> ''
       and not (v_text like 'https://%' or v_text like '/%') then
      return public.ces_result_error(
        'invalid',
        'The donate address must start with https:// or be a path beginning /.',
        jsonb_build_object('key', p_key)
      );
    end if;

  elsif p_key = 'email' then
    if v_text is not null and v_text <> ''
       and v_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      return public.ces_result_error(
        'invalid', 'That is not a valid email address.',
        jsonb_build_object('key', p_key)
      );
    end if;

  elsif p_key in ('google_ads_id', 'statcounter_project', 'statcounter_security') then
    -- Format-checked, because a malformed identifier silently stops the school's
    -- analytics counting rather than failing visibly. The StatCounter security
    -- token appears in BOTH the script config and the noscript pixel URL, so a
    -- bad value breaks the fallback too.
    if v_text is null or btrim(v_text) = '' then
      return public.ces_result_error(
        'invalid', 'That analytics identifier is required.',
        jsonb_build_object('key', p_key)
      );
    end if;

    if p_key = 'google_ads_id' and v_text !~ '^AW-[0-9]{6,}$' then
      return public.ces_result_error(
        'invalid', 'A Google Ads tag looks like AW-123456789.',
        jsonb_build_object('key', p_key, 'value', v_text)
      );
    end if;

    if p_key in ('statcounter_project', 'statcounter_security')
       and v_text !~ '^[0-9]+$' then
      return public.ces_result_error(
        'invalid', 'That StatCounter value is a number.',
        jsonb_build_object('key', p_key, 'value', v_text)
      );
    end if;

  elsif v_type not in ('string', 'null') then
    -- Every remaining key is text: the address parts, phone, fax, opening_hours,
    -- logo_alt, site_name, tagline, banner_variant, site_description.
    return public.ces_result_error(
      'invalid', 'That setting is a text value.',
      jsonb_build_object('key', p_key, 'received', v_type)
    );
  end if;

  v_cs := public.ces_new_change_set();

  -- `value` and `asset_id` only. See the note above.
  update public.site_globals
     set value    = case when p_key = 'logo' then value else p_value end,
         asset_id = case when p_key = 'logo' then p_asset_id else asset_id end
   where key = p_key;

  perform public.ces_write_revision(
    v_cs, 'site_globals',
    (v_before ->> 'id')::uuid,
    case when p_key = 'logo' then 'asset_id' else 'value' end,
    case when p_key = 'logo' then v_before -> 'asset_id' else v_before -> 'value' end,
    case when p_key = 'logo' then to_jsonb(p_asset_id) else p_value end
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'key', p_key, 'group', v_group,
      -- The tag nextjs/lib/cache-tags.ts must invalidate. get_maintenance_state()
      -- is cached under it, so the request boundary needs this to take effect.
      'cache_tag', 'content:globals',
      'asset_moves', public.ces_asset_move_plan(
        array_remove(
          array[(v_before ->> 'asset_id')::uuid, p_asset_id]::uuid[], null
        )
      )
    )
  );
end;
$fn$;



-- =============================================================================
-- 14. Media — the upload orchestration's SQL half, and five commands
-- =============================================================================
-- WHAT THIS SECTION DOES NOT CLAIM. The upload path is NOT one atomic
-- transaction and must never be described as one. Postgres cannot execute
-- `sharp`, and a Storage copy plus a row insert plus an object delete span two
-- systems with no shared commit. Anything that promised atomicity here would be
-- promising something the platform cannot deliver, and the first failure would
-- be silent.
--
-- So the row side is a STATE MACHINE, and migration 02's lifecycle column is it:
--
--   reserved -> uploaded -> inspecting -> stored -> (trashed)
--
-- Every transition is idempotent and keyed on the row, so a retried finalize
-- converges instead of duplicating. The division of labour:
--
--   reserve_upload         HERE. Authorizes, checks both upload ceilings,
--                          reserves the byte quota durably, writes the
--                          'reserved' row. /api/uploads/sign then returns a
--                          signed URL for the media-quarantine bucket.
--   the browser            uploads straight to Storage over that URL, with
--                          XMLHttpRequest so upload.onprogress can drive a
--                          progress bar and xhr.abort() can really cancel, then
--                          marks the row 'uploaded'.
--   finalize_upload        HERE, but only as the LAST step.
--                          /api/uploads/finalize re-reads the quarantined
--                          object, agrees magic bytes against the declared type,
--                          decodes it for real, measures intrinsic dimensions,
--                          copies to the destination bucket and VERIFIES the
--                          copy by size and checksum — and only then calls this
--                          function to record path, bucket, mime, dimensions and
--                          lifecycle 'stored'. It deletes the quarantine object
--                          afterwards.
--
-- THE WORST REACHABLE OUTCOME is a 'trashed' row with no durable object. Never a
-- referenced row with no bytes, and never bytes with no row: the row always
-- exists first, and it only becomes referenceable at 'stored', which is the
-- state update_media and update_section require before they will point at it.
--
-- THE 1% TOLERANCE is the other half of the byte quota. Section 4.3 reserves
-- against declared_size_bytes because at sign time the bytes do not exist; if
-- finalize accepted any actual length, a caller could declare 1 byte and upload
-- 50 MB. Requiring agreement within 1% closes that, and the tolerance rather
-- than exact equality is there because a multipart transport can add a handful
-- of bytes of framing.

-- -----------------------------------------------------------------------------
-- 14.1 commit-asset-bucket — the row half of a VERIFIED object move.
-- -----------------------------------------------------------------------------
-- Shared machinery rather than one of the thirty commands, and it exists because
-- of the honest decomposition in 9.2: the section 9 predicate says which bucket
-- an object belongs in, the route handler performs the copy-verify-delete, and
-- this records that it happened. Calling it before the copy has verified would
-- put the row in a state the Storage layer does not match, which is the one thing
-- the compensation ordering is designed to avoid.
--
-- It refuses a bucket other than the one the predicate currently requires, so a
-- caller cannot use it to make a draft's image public: the authority to change a
-- bucket comes from the reference graph, not from the argument.
create or replace function public.commit_asset_bucket(
  p_asset_id uuid,
  p_bucket   text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_current  text;
  v_required text;
begin
  v_check := public.ces_guard('upload', 'commit-asset-bucket');
  if v_check is not null then return v_check; end if;

  select a.bucket into v_current from public.assets a where a.id = p_asset_id;

  if v_current is null then
    return public.ces_result_error(
      'not_found', 'That image no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  v_required := public.ces_required_bucket(p_asset_id);

  if p_bucket <> v_required then
    return public.ces_result_error(
      'invalid',
      'That is not the bucket this image belongs in.',
      jsonb_build_object(
        'asset_id', p_asset_id, 'requested', p_bucket, 'required', v_required
      )
    );
  end if;

  if v_current = p_bucket then
    return public.ces_result_ok(
      null,
      jsonb_build_object('asset_id', p_asset_id, 'bucket', p_bucket,
                         'unchanged', true)
    );
  end if;

  update public.assets set bucket = p_bucket where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'bucket',
    to_jsonb(v_current), to_jsonb(p_bucket)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object('asset_id', p_asset_id, 'bucket', p_bucket,
                       'previous_bucket', v_current)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 14.1b The editor upload policy: permitted types and per-class byte ceilings.
-- -----------------------------------------------------------------------------
-- These are the SAME numbers as nextjs/lib/upload-limits.ts, and the two must
-- agree. They are duplicated here rather than imported for the reason the whole
-- file exists: a ceiling enforced only in TypeScript is a ceiling a direct RPC
-- call ignores. The AAP names five enforcement points for one set of numbers —
-- the dropzone pre-check, the sign route, the quota reservation, the bucket
-- configuration, and finalize — and two of those five are in this file.
--
-- CRITICAL SCOPE NOTE. This policy binds EDITOR uploads only, and deliberately
-- does not describe the legacy corpus. The 289 migrated binaries include 3 HEIC,
-- 2 JS, 2 CSS and 1 SVG object that these sets exclude on purpose; they are
-- preserved byte-for-byte because tools/src/upload-assets.ts ingests them under
-- the service role, which never passes through here. Widening these sets to
-- accommodate the archive would hand an editor the ability to upload a script.
--
-- SVG is refused with no exception: it carries script, so an SVG in the public
-- bucket is a stored-XSS vector served from our own origin. HTML and executables
-- are refused for the same reason. Video is not an upload at all — the `movie`
-- section kind is a URL against an oEmbed host allowlist.
create or replace function public.ces_upload_class(p_mime text)
returns text
language sql
immutable
security definer
set search_path = ''
as $fn$
  select case pg_catalog.lower(pg_catalog.btrim(coalesce(p_mime, '')))
           when 'image/jpeg' then 'image'
           when 'image/png'  then 'image'
           when 'image/webp' then 'image'
           when 'image/avif' then 'image'
           when 'application/pdf' then 'document'
           when 'application/zip' then 'document'
           when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
             then 'document'
           else null
         end;
$fn$;

comment on function public.ces_upload_class(text) is
  'Internal. Maps a declared MIME type to the editor upload class it belongs to '
  '(image or document), or null when the type is not permitted for an editor '
  'upload at all. Mirrors nextjs/lib/upload-limits.ts.';

-- Returns null when the pair is acceptable, or a typed error result. Never
-- raises, so a refusal commits its security_events row like every other denial.
create or replace function public.ces_check_upload_limits(
  p_mime  text,
  p_bytes bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_class   text;
  v_ceiling bigint;
begin
  v_class := public.ces_upload_class(p_mime);

  if v_class is null then
    return public.ces_result_error(
      'invalid',
      'That kind of file cannot be uploaded here.',
      jsonb_build_object(
        'mime', p_mime,
        'permitted_images', jsonb_build_array('image/jpeg','image/png','image/webp','image/avif'),
        'permitted_documents', jsonb_build_array(
          'application/pdf','application/zip',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      )
    );
  end if;

  -- Decimal MB, matching every other byte figure in this migration set.
  -- 15,000,000 sits above the largest stored legacy image
  -- (open-house-website-banner.jpg, 10,619,043 bytes) so re-uploading existing
  -- material can never be refused; 25,000,000 sits above the largest stored
  -- archive (Photos-(4).zip, 6,962,762 bytes).
  v_ceiling := case v_class when 'image' then 15000000 else 25000000 end;

  if p_bytes is null or p_bytes <= 0 then
    return public.ces_result_error(
      'invalid', 'A file needs a declared byte length.',
      jsonb_build_object('size_bytes', p_bytes)
    );
  end if;

  if p_bytes > v_ceiling then
    return public.ces_result_error(
      'invalid',
      case v_class
        when 'image' then 'That image is larger than the 15 MB limit.'
        else 'That file is larger than the 25 MB limit.'
      end,
      jsonb_build_object('mime', p_mime, 'class', v_class,
                         'size_bytes', p_bytes, 'ceiling', v_ceiling)
    );
  end if;

  return null;
end;
$fn$;

comment on function public.ces_check_upload_limits(text, bigint) is
  'Internal. Enforces the editor upload policy — permitted MIME set and the '
  'per-class byte ceiling (15 MB image, 25 MB document) — for reserve_upload and '
  'finalize_upload. Returns null when acceptable, else a typed invalid result. '
  'Service-role migration ingestion does not pass through here, which is what '
  'preserves the HEIC/JS/CSS/SVG objects in the legacy corpus.';


-- -----------------------------------------------------------------------------
-- 14.2 reserve-upload — the /api/uploads/sign half. Shared machinery.
-- -----------------------------------------------------------------------------
-- NOT ONE OF THE THIRTY EDITORIAL COMMANDS, and listed as machinery for the same
-- reason commit_asset_bucket is: it is the database half of a route handler, not
-- something an editor invokes. It is nonetheless required rather than optional,
-- because the byte quota MUST be reserved at sign time — section 4.3 explains
-- why counting afterwards cannot bind an upload — and because the `select ... for
-- update` inside ces_check_upload_bytes is what makes two simultaneous signs at
-- the ceiling resolve to one grant and one denial rather than two grants.
--
-- The object path is SERVER-GENERATED. A client-supplied path would let a caller
-- overwrite an existing object by naming its key, so the caller supplies only a
-- filename and the path is composed from the new row's own id.
create or replace function public.reserve_upload(
  p_filename            text,
  p_mime                text,
  p_declared_size_bytes bigint,
  p_expires_in_seconds  integer default 3600
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_id      uuid;
  v_name    text;
  v_path    text;
  v_expires timestamptz;
begin
  v_check := public.ces_guard('upload', 'reserve-upload');
  if v_check is not null then return v_check; end if;

  -- Frequency first, then bytes. Both take the actor lock; both refuse rather
  -- than raise.
  v_check := public.ces_check_upload_rate();
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_upload_bytes(p_declared_size_bytes);
  if v_check is not null then return v_check; end if;

  v_name := nullif(btrim(coalesce(p_filename, '')), '');

  if v_name is null then
    return public.ces_result_error(
      'invalid', 'A file needs a name.', jsonb_build_object('filename', p_filename)
    );
  end if;

  -- No path separators and no traversal. The path is composed below, but a
  -- filename is also a display value and must not be able to look like a key.
  if v_name like '%/%' or v_name like '%\%' or v_name like '%..%' then
    return public.ces_result_error(
      'invalid', 'A file name cannot contain a path.',
      jsonb_build_object('filename', v_name)
    );
  end if;

  if nullif(btrim(coalesce(p_mime, '')), '') is null then
    return public.ces_result_error(
      'invalid', 'A file needs a declared type.',
      jsonb_build_object('mime', p_mime)
    );
  end if;

  -- Enforcement point 3 of the five for one set of numbers: the permitted MIME
  -- set and the per-class byte ceiling. Checked BEFORE the row is written, so a
  -- refused type never occupies a reservation or a quarantine key.
  v_check := public.ces_check_upload_limits(p_mime, p_declared_size_bytes);
  if v_check is not null then return v_check; end if;

  v_id      := extensions.gen_random_uuid();
  v_expires := timezone('utc', now())
               + make_interval(secs => greatest(60, coalesce(p_expires_in_seconds, 3600)));

  -- Lands in media-quarantine. Nothing reads that bucket from a client;
  -- migration 18 grants insert only, and only the finalize orchestration reads
  -- the bytes back, server-side.
  v_path := 'quarantine/' || v_id::text || '/' || v_name;

  insert into public.assets (
    id, bucket, path, filename, mime, lifecycle,
    created_by, declared_size_bytes, reservation_expires_at
  )
  values (
    v_id, 'media-quarantine', v_path, v_name, p_mime, 'reserved',
    auth.uid(), p_declared_size_bytes, v_expires
  );

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', v_id, null, null,
    to_jsonb((select a from public.assets a where a.id = v_id))
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'asset_id', v_id,
      'bucket', 'media-quarantine',
      'path', v_path,
      'lifecycle', 'reserved',
      'declared_size_bytes', p_declared_size_bytes,
      'reservation_expires_at', v_expires
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 14.3 finalize-upload · capability `upload`
-- -----------------------------------------------------------------------------
-- The LAST step of the orchestration, called by /api/uploads/finalize after it
-- has inspected the real bytes and verified the copy. Everything this function
-- can check, it checks; everything it cannot, it trusts the route handler to have
-- done, and the comment above says which is which so nobody assumes more.
--
-- It refuses a destination bucket other than the one the section 9 predicate
-- requires, for the same reason commit_asset_bucket does: an image attached to
-- nothing yet has no published referrer, so it belongs in media-private until
-- something publishes it — and finalize is one of the five operations that
-- recompute exactly that.
create or replace function public.finalize_upload(
  p_asset_id   uuid,
  p_bucket     text,
  p_path       text,
  p_mime       text,
  p_size_bytes bigint,
  p_width      integer default null,
  p_height     integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   public.assets;
  v_required text;
  v_declared bigint;
  v_drift    numeric;
begin
  v_check := public.ces_guard('upload', 'finalize-upload');
  if v_check is not null then return v_check; end if;

  select * into v_before from public.assets a where a.id = p_asset_id;

  if v_before.id is null then
    return public.ces_result_error(
      'not_found', 'That upload no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  -- IDEMPOTENT. A retried finalize on an already-stored row converges instead of
  -- duplicating or failing, which is the property the state machine promises.
  if v_before.lifecycle = 'stored' then
    return public.ces_result_ok(
      null,
      jsonb_build_object('asset_id', p_asset_id, 'lifecycle', 'stored',
                         'already_final', true)
    );
  end if;

  if v_before.lifecycle = 'trashed' then
    return public.ces_result_error(
      'invalid',
      'That upload was rejected and cannot be finalized.',
      jsonb_build_object('asset_id', p_asset_id,
                         'reason', v_before.trashed_reason)
    );
  end if;

  if p_bucket not in ('media', 'media-private') then
    return public.ces_result_error(
      'invalid',
      'A finalized object belongs in media or media-private.',
      jsonb_build_object('bucket', p_bucket)
    );
  end if;

  -- Same rule as commit_asset_bucket: the bucket follows the reference graph,
  -- not the argument. A freshly uploaded image is referenced by nothing, so it
  -- finalizes private and is promoted when something published points at it.
  v_required := public.ces_required_bucket(p_asset_id);

  if p_bucket <> v_required then
    return public.ces_result_error(
      'invalid',
      'That is not the bucket this image belongs in.',
      jsonb_build_object('requested', p_bucket, 'required', v_required)
    );
  end if;

  if p_size_bytes is null or p_size_bytes < 0 then
    return public.ces_result_error(
      'invalid', 'A finalized object needs its measured byte length.',
      jsonb_build_object('size_bytes', p_size_bytes)
    );
  end if;

  -- Enforcement point 5 of the five, and the only one that sees REAL bytes and a
  -- REAL sniffed type. The route handler has by now agreed magic bytes against
  -- the declared type and decoded the image for real, so re-checking the policy
  -- here catches the case the sign-time check structurally cannot: a caller that
  -- declared an permitted 1 MB JPEG and then pushed 14 MB of something else.
  -- The 1% agreement below covers understated LENGTH; this covers type and
  -- ceiling against the measured value.
  v_check := public.ces_check_upload_limits(p_mime, p_size_bytes);
  if v_check is not null then
    update public.assets
       set lifecycle = 'trashed',
           trashed_reason = 'measured bytes failed the upload policy',
           reservation_expires_at = null
     where id = p_asset_id;

    perform public.ces_log_security_event(
      'upload_rejected',
      'policy_violation_at_finalize',
      jsonb_build_object('asset_id', p_asset_id, 'mime', p_mime,
                         'size_bytes', p_size_bytes)
    );

    return v_check;
  end if;

  -- THE 1% AGREEMENT. See the section note: without it, the sign-time
  -- reservation could be understated to slip past the 24-hour byte quota.
  v_declared := v_before.declared_size_bytes;

  if v_declared is not null and v_declared > 0 then
    v_drift := abs(p_size_bytes - v_declared)::numeric / v_declared::numeric;

    if v_drift > 0.01 then
      -- Recorded as a rejection AND the row is trashed, so the reservation stops
      -- consuming quota immediately — 'trashed' is not in section 4.3's counted
      -- set. The bytes are the route handler's to remove.
      update public.assets
         set lifecycle = 'trashed',
             trashed_reason = 'declared byte length did not match the object',
             reservation_expires_at = null
       where id = p_asset_id;

      v_cs := public.ces_new_change_set();

      perform public.ces_write_revision(
        v_cs, 'assets', p_asset_id, 'lifecycle',
        to_jsonb(v_before.lifecycle), to_jsonb('trashed'::text)
      );

      perform public.ces_log_security_event(
        'upload_rejected',
        'declared_size_mismatch',
        jsonb_build_object(
          'asset_id', p_asset_id,
          'declared_size_bytes', v_declared,
          'actual_size_bytes', p_size_bytes,
          'tolerance', 0.01
        )
      );

      return public.ces_result_error(
        'invalid',
        'The uploaded file was not the size it declared.',
        jsonb_build_object(
          'declared_size_bytes', v_declared,
          'actual_size_bytes', p_size_bytes
        )
      );
    end if;
  end if;

  if nullif(btrim(coalesce(p_path, '')), '') is null then
    return public.ces_result_error(
      'invalid', 'A finalized object needs its storage path.',
      jsonb_build_object('path', p_path)
    );
  end if;

  if exists (
    select 1 from public.assets a
     where a.path = p_path and a.id <> p_asset_id
  ) then
    return public.ces_result_error(
      'invalid', 'Another file already occupies that storage path.',
      jsonb_build_object('path', p_path)
    );
  end if;

  update public.assets
     set bucket     = p_bucket,
         path       = p_path,
         mime       = coalesce(p_mime, mime),
         size_bytes = p_size_bytes,
         width      = p_width,
         height     = p_height,
         lifecycle  = 'stored',
         -- Cleared because the reservation is discharged: the row now counts
         -- against the byte quota through size_bytes instead.
         reservation_expires_at = null,
         trashed_reason         = null
   where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'lifecycle',
    to_jsonb(v_before.lifecycle), to_jsonb('stored'::text)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'path',
    to_jsonb(v_before.path), to_jsonb(p_path)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'bucket',
    to_jsonb(v_before.bucket), to_jsonb(p_bucket)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'asset_id', p_asset_id, 'bucket', p_bucket, 'path', p_path,
      'lifecycle', 'stored', 'size_bytes', p_size_bytes,
      'width', p_width, 'height', p_height
    )
  );
end;
$fn$;



-- -----------------------------------------------------------------------------
-- 14.4 The media-trash key, and why byte history is application-owned
-- -----------------------------------------------------------------------------
-- SUPABASE STORAGE DOES NOT OFFER OBJECT VERSIONING. Not on any plan — this is a
-- provider capability that does not exist, not a paid feature the school declined.
-- A deleted object is gone. An earlier draft of the design assumed S3-style
-- versioning and was corrected, so the assumption is recorded here as withdrawn
-- rather than left for somebody to rediscover.
--
-- Byte history is therefore APPLICATION-OWNED, and this is the mechanism:
-- replacing or deleting an asset copies the outgoing bytes to
--
--   media-trash/<asset_id>/<iso-timestamp>/<filename>
--
-- BEFORE the new bytes land, records the move in the change set, and exposes
-- restore-asset to admins. Retention is 90 DAYS, swept by /api/cleanup/orphans.
--
-- THIS FUNCTION COMPOSES THE KEY AND NOTHING ELSE. The copy is Storage work and
-- belongs to the route handler, exactly as in 9.2 — the ordering that matters is
-- copy first, verify, then let the new bytes land, so a failure leaves the
-- outgoing bytes still recoverable.
--
-- TWO DIFFERENCES FROM GIT, stated rather than glossed: Git retained prior bytes
-- indefinitely where this trash expires at 90 days, and Git history survived the
-- database where content_revisions does not. Migration 14 records both, and
-- README.md presents the pair as a REDUCED RECOVERY CAPABILITY requiring school
-- approval. Do not call any of this parity with Git-backed versioning.
create or replace function public.ces_trash_key(
  p_asset_id uuid,
  p_filename text
)
returns text
language sql
stable
set search_path = ''
as $fn$
  select 'media-trash/' || p_asset_id::text || '/'
         || to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SSZ') || '/'
         || p_filename
$fn$;


-- -----------------------------------------------------------------------------
-- 14.5 replace-asset · capability `upload`
-- -----------------------------------------------------------------------------
-- AN ATOMIC SWAP OF THE ROW, in one transaction: the asset keeps its id, so every
-- one of the eleven referencing columns keeps pointing at it and no content row
-- is touched at all. That is the whole point of replacing rather than deleting
-- and re-attaching — migration 02 line 445 and migration 07 line 426 both
-- specify it this way, and it is why references are by id and never by path.
--
-- The outgoing bytes go to the media-trash key this function returns, and the
-- route handler must have copied them there and verified the copy BEFORE calling
-- it. The row-level swap is atomic; the two-system sequence around it is not, and
-- 14's header says so.
create or replace function public.replace_asset(
  p_asset_id   uuid,
  p_path       text,
  p_filename   text,
  p_mime       text,
  p_size_bytes bigint,
  p_width      integer default null,
  p_height     integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   public.assets;
  v_trash    text;
begin
  v_check := public.ces_guard('upload', 'replace-asset');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select * into v_before from public.assets a where a.id = p_asset_id;

  if v_before.id is null then
    return public.ces_result_error(
      'not_found', 'That image no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  if v_before.lifecycle <> 'stored' then
    return public.ces_result_error(
      'invalid',
      'Only a stored file can be replaced.',
      jsonb_build_object('asset_id', p_asset_id, 'lifecycle', v_before.lifecycle)
    );
  end if;

  if nullif(btrim(coalesce(p_path, '')), '') is null
     or nullif(btrim(coalesce(p_filename, '')), '') is null then
    return public.ces_result_error(
      'invalid', 'A replacement needs a storage path and a file name.',
      jsonb_build_object('path', p_path, 'filename', p_filename)
    );
  end if;

  if exists (
    select 1 from public.assets a where a.path = p_path and a.id <> p_asset_id
  ) then
    return public.ces_result_error(
      'invalid', 'Another file already occupies that storage path.',
      jsonb_build_object('path', p_path)
    );
  end if;

  v_trash := public.ces_trash_key(p_asset_id, v_before.filename);

  update public.assets
     set path       = p_path,
         filename   = p_filename,
         mime       = coalesce(p_mime, mime),
         size_bytes = p_size_bytes,
         width      = p_width,
         height     = p_height,
         -- The focal point is DELIBERATELY PRESERVED. A replacement is normally a
         -- better crop or a retouch of the same photograph, so discarding the
         -- crosshair would silently recrop every place it appears. An editor who
         -- wants a different focal point sets one.
         lifecycle  = 'stored'
   where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'path',
    to_jsonb(v_before.path), to_jsonb(p_path)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'filename',
    to_jsonb(v_before.filename), to_jsonb(p_filename)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'size_bytes',
    to_jsonb(v_before.size_bytes), to_jsonb(p_size_bytes)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'asset_id', p_asset_id,
      'path', p_path, 'previous_path', v_before.path,
      -- The key the outgoing bytes must already have been copied to, and the one
      -- restore-asset will look for. 90-day retention.
      'trash_key', v_trash,
      'retention_days', 90,
      'asset_moves', public.ces_asset_move_plan(array[p_asset_id])
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 14.6 rename-asset · capability `delete_asset`
-- -----------------------------------------------------------------------------
-- ADMIN ONLY, and gated by `delete_asset` rather than by a capability of its own.
-- Migration 13 is explicit that this name is narrower than the authority it
-- gates — "the whole destructive and organizational asset authority" — because
-- the Storage policy table fixes the string. The legacy `editor` role held
-- `move assets` and `rename assets`; the target withholds both, which is one of
-- the enumerated capability reductions.
--
-- IT COVERS RENAME AND ANY PATH REORGANIZATION, deliberately as one command,
-- because both are a path change under one orchestration and splitting them
-- would give two commands the same compensation sequence to get right.
--
-- NO CONSUMER BREAKS, because references are by assets.id and never by path.
-- That is a schema property rather than a hope: all eleven referencing columns
-- are uuid foreign keys. The change set records both paths so a restore can put
-- the object back where it was.
create or replace function public.rename_asset(
  p_asset_id uuid,
  p_path     text,
  p_filename text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check  jsonb;
  v_cs     uuid;
  v_before public.assets;
  v_name   text;
  v_path   text;
begin
  v_check := public.ces_guard('delete_asset', 'rename-asset');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select * into v_before from public.assets a where a.id = p_asset_id;

  if v_before.id is null then
    return public.ces_result_error(
      'not_found', 'That file no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  v_name := nullif(btrim(coalesce(p_filename, v_before.filename)), '');
  v_path := nullif(btrim(coalesce(p_path, v_before.path)), '');

  if v_name is null or v_path is null then
    return public.ces_result_error(
      'invalid', 'A rename needs a file name and a storage path.',
      jsonb_build_object('filename', p_filename, 'path', p_path)
    );
  end if;

  if v_name like '%/%' or v_name like '%\%' or v_name like '%..%' then
    return public.ces_result_error(
      'invalid', 'A file name cannot contain a path.',
      jsonb_build_object('filename', v_name)
    );
  end if;

  -- A rename that would collide is REFUSED rather than resolved. Silently
  -- appending a suffix would mean the operator's chosen name is not the name,
  -- and overwriting would destroy another object's bytes.
  if exists (
    select 1 from public.assets a where a.path = v_path and a.id <> p_asset_id
  ) then
    return public.ces_result_error(
      'invalid', 'Another file already occupies that storage path.',
      jsonb_build_object('path', v_path)
    );
  end if;

  if v_path = v_before.path and v_name = v_before.filename then
    return public.ces_result_ok(
      null,
      jsonb_build_object('asset_id', p_asset_id, 'unchanged', true)
    );
  end if;

  update public.assets
     set path = v_path, filename = v_name
   where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'path',
    to_jsonb(v_before.path), to_jsonb(v_path)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'filename',
    to_jsonb(v_before.filename), to_jsonb(v_name)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'asset_id', p_asset_id,
      'path', v_path, 'previous_path', v_before.path,
      'filename', v_name,
      -- The outgoing key, preserved until the new one verifies. Same ordering as
      -- finalize: copy, verify, then delete the old.
      'trash_key', public.ces_trash_key(p_asset_id, v_before.filename)
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 14.7 retire-asset · capability `delete_asset`
-- -----------------------------------------------------------------------------
-- BLOCKED WHILE ANYTHING REFERENCES IT, and the refusal names the rows.
--
-- Migration 02 line 431 makes this a contract that cannot be weakened from
-- either side, and the reasoning is worth keeping in front of whoever next edits
-- this: `on delete set null` is not merely undesirable but IMPOSSIBLE for
-- promoted.image_asset_id, which is not null, so silently nulling a required
-- image is not even available as a bad option; and `on delete cascade` would let
-- removing one photograph delete the content row that displays it. The inbound
-- foreign keys therefore carry no referential action at all, the database refuses
-- the delete, and this function's job is to make the refusal USEFUL rather than a
-- foreign-key error.
--
-- IT RETIRES RATHER THAN DELETING THE ROW. lifecycle becomes 'trashed', the bytes
-- move to the media-trash key, and restore_asset can bring both back for 90 days.
-- Dropping the row would take its revision history's target with it and make the
-- restore path impossible.
create or replace function public.retire_asset(
  p_asset_id uuid,
  p_reason   text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   public.assets;
  v_refs     jsonb;
begin
  v_check := public.ces_guard('delete_asset', 'retire-asset');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select * into v_before from public.assets a where a.id = p_asset_id;

  if v_before.id is null then
    return public.ces_result_error(
      'not_found', 'That file no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  if v_before.lifecycle = 'trashed' then
    return public.ces_result_ok(
      null,
      jsonb_build_object('asset_id', p_asset_id, 'lifecycle', 'trashed',
                         'already_retired', true)
    );
  end if;

  -- Counted regardless of publish state: a DRAFT page referencing this image is
  -- still a reason not to pull the bytes out from under it.
  v_refs := public.ces_asset_reference_rows(p_asset_id);

  if v_refs <> '[]'::jsonb then
    return public.ces_result_error(
      'blocked',
      'This file is still in use. Detach it from these records first.',
      jsonb_build_object('asset_id', p_asset_id, 'blockers', v_refs)
    );
  end if;

  update public.assets
     set lifecycle      = 'trashed',
         trashed_reason = coalesce(
           nullif(btrim(coalesce(p_reason, '')), ''),
           'retired by an administrator'
         )
   where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'lifecycle',
    to_jsonb(v_before.lifecycle), to_jsonb('trashed'::text)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'asset_id', p_asset_id,
      'lifecycle', 'trashed',
      'previous_bucket', v_before.bucket,
      'previous_path', v_before.path,
      'trash_key', public.ces_trash_key(p_asset_id, v_before.filename),
      'retention_days', 90
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 14.8 restore-asset · capability `delete_asset`
-- -----------------------------------------------------------------------------
-- RECOVERS BYTES FROM media-trash, and it is admin-only under `delete_asset`
-- rather than under `restore`. That split is migration 13's and it is
-- deliberate: `restore` covers restoring a REVISION or a CHANGE SET and both
-- roles hold it, while recovering trashed asset BYTES is admin-only. Two
-- different authorities that happen to share a verb.
--
-- The route handler must have copied the bytes back out of media-trash and
-- verified them before calling this; the row side then returns the asset to
-- 'stored' in the bucket the section 9 predicate currently requires — which for a
-- restored asset referenced by nothing is media-private, correctly.
--
-- BEYOND 90 DAYS THERE IS NOTHING TO RESTORE. The sweep in /api/cleanup/orphans
-- has removed the key by then, and no amount of row state can bring bytes back
-- that the provider no longer holds. That is the stated limit of this mechanism.
create or replace function public.restore_asset(
  p_asset_id uuid,
  p_path     text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   public.assets;
  v_path     text;
  v_bucket   text;
begin
  v_check := public.ces_guard('delete_asset', 'restore-asset');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select * into v_before from public.assets a where a.id = p_asset_id;

  if v_before.id is null then
    return public.ces_result_error(
      'not_found', 'That file no longer exists.',
      jsonb_build_object('asset_id', p_asset_id)
    );
  end if;

  if v_before.lifecycle <> 'trashed' then
    return public.ces_result_error(
      'invalid',
      'Only a retired file can be restored.',
      jsonb_build_object('asset_id', p_asset_id, 'lifecycle', v_before.lifecycle)
    );
  end if;

  v_path := coalesce(nullif(btrim(coalesce(p_path, '')), ''), v_before.path);

  if exists (
    select 1 from public.assets a where a.path = v_path and a.id <> p_asset_id
  ) then
    return public.ces_result_error(
      'invalid',
      'Another file has taken that storage path. Restore it under a new name.',
      jsonb_build_object('path', v_path)
    );
  end if;

  -- The predicate decides, not the caller. A restored asset that nothing
  -- published references belongs in media-private.
  v_bucket := public.ces_required_bucket(p_asset_id);

  update public.assets
     set lifecycle      = 'stored',
         trashed_reason = null,
         path           = v_path,
         bucket         = v_bucket
   where id = p_asset_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'lifecycle',
    to_jsonb('trashed'::text), to_jsonb('stored'::text)
  );
  perform public.ces_write_revision(
    v_cs, 'assets', p_asset_id, 'bucket',
    to_jsonb(v_before.bucket), to_jsonb(v_bucket)
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'asset_id', p_asset_id, 'lifecycle', 'stored',
      'bucket', v_bucket, 'path', v_path
    )
  );
end;
$fn$;



-- =============================================================================
-- 14.9 Restore helpers (used by section 15)
-- =============================================================================

-- Which tables a history entry may be written back into.
--
-- Migration 14 deliberately puts NO check constraint on
-- content_revisions.table_name, because a constraint listing today's table names
-- would turn a legitimate future write into a failed save. That freedom is
-- correct for the audit trail and it means the RESTORE path must decide for
-- itself what it is willing to write, which is what this allowlist is.
--
-- public.admin_users is deliberately ABSENT. Account state is not content
-- history: reversing a role change or a revocation through the history UI would
-- let an editor with `restore` re-grant authority that an admin removed, which
-- would make section 16's invariants bypassable. Role changes are audited in
-- security_events and reversed by set_admin_role, under manage_users.
-- content_revisions and security_events are absent for the same class of reason:
-- both are append-only by policy and neither is a restore target.
create or replace function public.ces_restorable_table(p_table text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select p_table in (
    'pages', 'page_sections', 'people', 'person_education',
    'events', 'classrooms', 'classroom_teachers', 'page_classrooms',
    'promoted', 'promoted_links', 'announcements', 'inspiring_quotes',
    'taxonomy_terms', 'assets', 'site_globals', 'nav_items'
  )
$fn$;

-- Write one historical value back into one column, with the type conversion the
-- column actually needs.
--
-- THE MECHANISM IS jsonb_populate_record OVER THE EXISTING ROW, not a text cast.
-- `set %I = $1::text::<type>` would need the type spelled out per column, and
-- would corrupt a jsonb column by round-tripping it through text. Overlaying a
-- single-key json object onto the row and reading that one field back gives
-- Postgres itself the job of converting json to the column's declared type — for
-- text, integer, boolean, uuid, date, time, numeric and jsonb alike — with one
-- statement and no per-type branching. A json null restores a SQL null, which is
-- the correct reversal of a value that was cleared.
--
-- It returns a typed result on failure rather than raising, because a restore
-- that cannot be applied — a not-null column whose old value was null, a value
-- that no longer satisfies a check constraint — is a refusal the editor should
-- show, not a 500.
--
-- `p_column` is verified to be a real column of the table before it is
-- interpolated, so a revision row carrying a column that has since been dropped
-- is refused cleanly instead of producing a syntax error.
create or replace function public.ces_apply_restored_value(
  p_table  text,
  p_row_id uuid,
  p_column text,
  p_value  jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_exists boolean;
  v_rows   bigint;
begin
  if not public.ces_restorable_table(p_table) then
    return public.ces_result_error(
      'unsupported', 'History for that table cannot be restored automatically.',
      jsonb_build_object('table', p_table)
    );
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class     c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = p_table
       and a.attname = p_column
       and a.attnum > 0
       and not a.attisdropped
  ) then
    return public.ces_result_error(
      'unsupported',
      'That field no longer exists, so this history entry cannot be applied.',
      jsonb_build_object('table', p_table, 'column', p_column)
    );
  end if;

  -- Existence is checked BEFORE the update, not after it. Two reasons, and the
  -- second one is a bug this code previously had:
  --
  --   1. A missing row should be reported without mutating anything first.
  --   2. `FOUND` IS NOT SET BY `EXECUTE`. The PostgreSQL manual is explicit that
  --      EXECUTE changes GET DIAGNOSTICS but leaves FOUND untouched, so a
  --      trailing `if not found` after a dynamic UPDATE tests a stale value —
  --      here it would have been the initial false, making this function report
  --      `not_found` on every call while still having applied the value. That is
  --      the worst shape of failure available: the write happens and the caller
  --      is told it did not. Row count now comes from GET DIAGNOSTICS below.
  if not exists (
    select 1 from pg_catalog.pg_class c
     where c.oid = pg_catalog.format('public.%I', p_table)::regclass
  ) then
    return public.ces_result_error(
      'unsupported', 'History for that table cannot be restored automatically.',
      jsonb_build_object('table', p_table)
    );
  end if;

  execute format('select exists (select 1 from public.%I t where t.id = $1)', p_table)
     into v_exists
    using p_row_id;

  if not coalesce(v_exists, false) then
    return public.ces_result_error(
      'not_found',
      'The record this history entry describes no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  begin
    execute format(
      'update public.%I t set %I = (jsonb_populate_record(t, $1)).%I where t.id = $2',
      p_table, p_column, p_column
    ) using jsonb_build_object(p_column, p_value), p_row_id;

    get diagnostics v_rows = row_count;
  exception
    when others then
      return public.ces_result_error(
        'invalid',
        'That historical value can no longer be applied to this field.',
        jsonb_build_object(
          'table', p_table, 'column', p_column, 'detail', sqlerrm
        )
      );
  end;

  if coalesce(v_rows, 0) = 0 then
    return public.ces_result_error(
      'not_found',
      'The record this history entry describes no longer exists.',
      jsonb_build_object('table', p_table, 'row_id', p_row_id)
    );
  end if;

  return null;
end;
$fn$;


-- =============================================================================
-- 15. History — two commands, capability `restore`, BOTH ROLES
-- =============================================================================
-- This is the capability the target ADDS relative to the legacy editor role.
-- Statamic's own per-entry revisions were never enabled — config/statamic/
-- revisions.php defaults to false and all seven collection configs set
-- `revisions: false` — so the only history the school ever had was Git, which
-- was operator-side and invisible to the person doing the editing. Migration 14
-- records that plainly. Giving both roles `restore` means the person who made a
-- mistake is the person who can undo it, which is the whole point.
--
-- RESTORING IS ITSELF AN AUDITED WRITE. A restore does not rewind history or
-- delete the rows it reverses — content_revisions is append-only by policy, and
-- migration 17 declares no update and no delete policy on it. It writes NEW
-- revision rows describing the reversal, under a new change_set_id. So the trail
-- shows that a value was changed and then changed back, which is what actually
-- happened.
--
-- WHAT CANNOT BE RESTORED, stated rather than discovered: a whole-row revision
-- (column_name null) records a create or a delete, and this command does not
-- re-create a deleted row. Re-inserting it would have to resurrect its id, its
-- children and every reference that was removed with it, and a partial
-- resurrection is worse than none — the operator re-creates the entry and the
-- old row's revision history stays readable beside it. restore_change_set
-- reverses the COLUMN changes of a change set, which covers the operations that
-- matter most: a reparent, a reorder, a slug move, a forced reference strip.

-- -----------------------------------------------------------------------------
-- 15.1 restore-revision · capability `restore`
-- -----------------------------------------------------------------------------
create or replace function public.restore_revision(p_revision_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check jsonb;
  v_cs    uuid;
  v_rev   public.content_revisions;
  v_now   jsonb;
begin
  v_check := public.ces_guard('restore', 'restore-revision');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  select * into v_rev
    from public.content_revisions cr where cr.id = p_revision_id;

  if v_rev.id is null then
    return public.ces_result_error(
      'not_found', 'That history entry no longer exists.',
      jsonb_build_object('revision_id', p_revision_id)
    );
  end if;

  if v_rev.column_name is null then
    return public.ces_result_error(
      'unsupported',
      'That entry records a record being created or deleted, which cannot be '
      'undone from history. Re-create the entry instead.',
      jsonb_build_object('revision_id', p_revision_id,
                         'table', v_rev.table_name, 'row_id', v_rev.row_id)
    );
  end if;

  -- The target table must still be one we know how to write, and the row must
  -- still exist. Migration 14 deliberately puts no foreign key on row_id
  -- precisely so a revision outlives its row — so this is a real case, not a
  -- defensive one.
  if not public.ces_restorable_table(v_rev.table_name) then
    return public.ces_result_error(
      'unsupported',
      'History for that table cannot be restored automatically.',
      jsonb_build_object('table', v_rev.table_name)
    );
  end if;

  execute format(
            'select to_jsonb(t.%I) from public.%I t where t.id = $1',
            v_rev.column_name, v_rev.table_name
          )
     into v_now
    using v_rev.row_id;

  if v_now is null and not exists (
    select 1 from public.content_revisions x where x.id = p_revision_id
  ) then
    return public.ces_result_error(
      'not_found', 'The record this history entry describes no longer exists.',
      jsonb_build_object('table', v_rev.table_name, 'row_id', v_rev.row_id)
    );
  end if;

  v_check := public.ces_apply_restored_value(
    v_rev.table_name, v_rev.row_id, v_rev.column_name, v_rev.value_before
  );
  if v_check is not null then return v_check; end if;

  v_cs := public.ces_new_change_set();

  -- A NEW row describing the reversal. The original is never touched.
  perform public.ces_write_revision(
    v_cs, v_rev.table_name, v_rev.row_id, v_rev.column_name,
    v_now, v_rev.value_before
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'restored_from', p_revision_id,
      'table', v_rev.table_name, 'row_id', v_rev.row_id,
      'column', v_rev.column_name
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 15.2 restore-change-set · capability `restore`
-- -----------------------------------------------------------------------------
-- REVERSES A WHOLE OPERATION, which is what change_set_id exists for. Migration
-- 14 line 116 gives the cases: a reparent that rewrote twenty descendant paths,
-- a forced delete that stripped references from three tables, a reorder that
-- renumbered a sibling set, an atomic asset replacement. Undoing one row of any
-- of those would leave the structure inconsistent — a tree with one path from the
-- old location and nineteen from the new.
--
-- APPLIED IN REVERSE ORDER of the original writes, so that a change set which
-- touched the same column twice ends at the value it started from rather than in
-- the middle.
--
-- Whole-row entries within the set are SKIPPED rather than failing the restore,
-- and the count is reported. A forced delete's change set contains both the
-- reference removals (restorable) and the row deletions (not), and reversing the
-- references is genuinely useful on its own — refusing the whole thing because
-- part of it cannot be undone would make the feature useless in exactly the case
-- it is most wanted.
create or replace function public.restore_change_set(p_change_set_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_rev     public.content_revisions;
  v_now     jsonb;
  v_fail    jsonb;
  v_done    integer := 0;
  v_skipped integer := 0;
begin
  v_check := public.ces_guard('restore', 'restore-change-set');
  if v_check is not null then return v_check; end if;

  v_check := public.ces_check_write_rate();
  if v_check is not null then return v_check; end if;

  if not exists (
    select 1 from public.content_revisions cr
     where cr.change_set_id = p_change_set_id
  ) then
    return public.ces_result_error(
      'not_found', 'That change no longer appears in the history.',
      jsonb_build_object('change_set_id', p_change_set_id)
    );
  end if;

  v_cs := public.ces_new_change_set();

  -- ATOMICITY OF A MULTI-ROW RESTORE, and why this needs an inner block.
  --
  -- One unrestorable column must fail the WHOLE set rather than leave it half
  -- reversed — a partially reversed reparent is exactly the inconsistent state
  -- this command exists to prevent. But `return` does NOT undo anything: a
  -- plpgsql function that has already updated three rows and then returns a
  -- typed error still COMMITS those three updates, because the typed-result
  -- contract means no exception ever reaches the transaction. This was a real
  -- defect here, observed as a change set whose slug was reversed while its
  -- paths were not.
  --
  -- The fix is the one plpgsql idiom that gives both properties at once: a
  -- BEGIN ... EXCEPTION block establishes an implicit SAVEPOINT, so raising
  -- inside it and catching it here rolls back every row this loop touched, while
  -- the caller still receives an ordinary typed result. Local variables are not
  -- transactional, so v_fail survives the rollback and carries the real reason
  -- out. The audit rows written by the loop are unwound with the mutations they
  -- describe, which is correct — the restore did not happen.
  begin
    -- Deferred here because a change set that renumbered a sibling set will pass
    -- back through colliding positions on the way to its original order.
    set constraints
      public.pages_parent_sort_order_key,
      public.page_sections_page_parent_sort_order_key,
      public.nav_items_parent_sort_order_key
      deferred;

    for v_rev in
      select * from public.content_revisions cr
       where cr.change_set_id = p_change_set_id
       order by cr.created_at desc, cr.id desc
    loop
      if v_rev.column_name is null
         or not public.ces_restorable_table(v_rev.table_name) then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      execute format(
                'select to_jsonb(t.%I) from public.%I t where t.id = $1',
                v_rev.column_name, v_rev.table_name
              )
         into v_now
        using v_rev.row_id;

      v_check := public.ces_apply_restored_value(
        v_rev.table_name, v_rev.row_id, v_rev.column_name, v_rev.value_before
      );

      if v_check is not null then
        v_fail := v_check;
        raise exception 'ces_restore_set_abort'
          using errcode = 'CES01';
      end if;

      perform public.ces_write_revision(
        v_cs, v_rev.table_name, v_rev.row_id, v_rev.column_name,
        v_now, v_rev.value_before
      );

      v_done := v_done + 1;
    end loop;
  exception
    when sqlstate 'CES01' then
      -- Savepoint rollback has already undone every column applied above.
      return v_fail;
  end;

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'restored_change_set', p_change_set_id,
      'columns_restored', v_done,
      'entries_skipped', v_skipped
    )
  );
end;
$fn$;



-- =============================================================================
-- 16. Accounts — three commands, capability `manage_users`, ADMIN ONLY
-- =============================================================================
-- THE ROLE-SAFETY INVARIANT, enforced by both mutating commands in one
-- transaction each:
--
--   * AT LEAST ONE is_active ADMIN MUST ALWAYS REMAIN. Without this, one careless
--     demotion locks the school out of its own site permanently — no policy
--     grants an admin_users insert to any application role, and recovery would
--     mean an operator with the service-role key editing the table by hand.
--   * AN ADMIN MAY NEITHER DEMOTE NOR DISABLE THEMSELVES. Two admins each
--     demoting the other in the same minute is the same lockout by a different
--     route, and self-demotion is the single most common way to reach it by
--     accident.
--
-- Migration 13 line 780 states both and assigns them here by name.
--
-- BOOTSTRAP IS NOT THIS FILE'S JOB, and it cannot be: admin_users.user_id
-- references auth.users, so no row can exist before an account does, and accounts
-- are created by invitation. tools/src/bootstrap-admins.ts does that once, under
-- the service role, after the school's keys are added. There is no self-service
-- signup path and no policy is weakened to allow a first insert.
--
--
-- WHAT REVOCATION ACTUALLY DOES, because the obvious mental model is wrong and
-- the design deliberately does not rely on it.
--
-- You cannot invalidate an already-issued Supabase access token. They are
-- verified statelessly, and the Auth admin sign-out API takes THAT SESSION's own
-- JWT rather than a user id — so an operator revoking somebody else's access
-- cannot reach their token even in principle. Any design that assumed otherwise
-- would leave a real hole while appearing to close one.
--
-- The property that matters is achievable without it, because AUTHORIZATION IN
-- THIS SYSTEM IS DECIDED ON EVERY REQUEST rather than carried in the token:
--
--   1. Block clears admin_users.is_active. nextjs/lib/supabase/session.ts
--      consults is_active_admin_user() on every proxied request, and every write
--      function in this file consults it again through ces_guard. Both gates
--      close on the account's NEXT REQUEST.
--   2. The command's caller also bans the user through the Auth admin API, which
--      stops the refresh-token exchange and any new sign-in. That is an
--      application-side call: Postgres has no reach into GoTrue, and pretending
--      otherwise would be the same category of false claim as an atomic upload.
--   3. The residual access token stays cryptographically valid for up to its hour
--      and still AUTHENTICATES as that user — but it AUTHORIZES nothing, because
--      steps 1 and 2 have already closed every gate it could pass through.
--
-- nextjs/tests/e2e/security.spec.ts proves it with a token captured BEFORE the
-- block: every write command is denied, /admin/** redirects, /api/media/**
-- refuses, and an exchange of the pre-block refresh token fails to mint a new
-- session. None of those assertions rests on revoking a stateless token.

-- -----------------------------------------------------------------------------
-- 16.1 The remaining-admin count, used by both invariant checks.
-- -----------------------------------------------------------------------------
-- Takes `for update` on every active admin row, so two concurrent demotions
-- cannot both observe two admins and both proceed. The same read-then-write race
-- as the rate limits in section 4, with a much worse outcome: total lockout.
-- The lock and the count are two statements because Postgres refuses `for
-- update` alongside an aggregate — locking then counting is the same guarantee
-- written in the form the planner accepts.
create or replace function public.ces_other_active_admins(p_excluding uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  perform 1
    from public.admin_users au
   where au.role = 'admin'
     and au.is_active
     and au.user_id <> p_excluding
     for update;

  select count(*)::integer into v_count
    from public.admin_users au
   where au.role = 'admin'
     and au.is_active
     and au.user_id <> p_excluding;

  return v_count;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 16.2 invite-admin · capability `manage_users`
-- -----------------------------------------------------------------------------
-- THE ROW HALF OF AN INVITATION. The Auth invitation itself — the email, the
-- 72-hour single-use token, the redirect to /auth/accept-invite — is issued by
-- the caller through the Auth admin API, because it is a GoTrue operation.
-- This function records the membership and the role that invitation carries.
--
-- IT REQUIRES THE auth.users ROW TO EXIST ALREADY, which is the correct ordering:
-- admin_users.user_id is a foreign key to auth.users, so the invitation must be
-- created first and this called with the id it returned. A row here without an
-- account would be a grant of authority to nobody, and the foreign key makes it
-- impossible rather than merely discouraged.
--
-- Idempotent on the user id: re-inviting an existing member updates their role
-- and reactivates them rather than failing, which is what makes
-- tools/src/bootstrap-admins.ts safe to re-run.
create or replace function public.invite_admin(
  p_user_id uuid,
  p_role    text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check   jsonb;
  v_cs      uuid;
  v_before  jsonb;
  v_email   text;
begin
  v_check := public.ces_guard('manage_users', 'invite-admin');
  if v_check is not null then return v_check; end if;

  if coalesce(p_role, '') not in ('admin', 'editor') then
    return public.ces_result_error(
      'invalid', 'A role is either admin or editor.',
      jsonb_build_object('role', p_role)
    );
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;

  if v_email is null then
    return public.ces_result_error(
      'not_found',
      'No account exists for that invitation yet. Send the invitation first.',
      jsonb_build_object('user_id', p_user_id)
    );
  end if;

  select to_jsonb(au) into v_before
    from public.admin_users au where au.user_id = p_user_id;

  v_cs := public.ces_new_change_set();

  -- is_active true and disabled_at null together: migration 13's
  -- admin_users_disabled_at_check requires the pair to agree, and its trigger
  -- clears disabled_at on reactivation.
  insert into public.admin_users (user_id, role, is_active, invited_by)
  values (p_user_id, p_role, true, auth.uid())
  on conflict (user_id) do update
     set role      = excluded.role,
         is_active = true;

  perform public.ces_write_revision(
    v_cs, 'admin_users', p_user_id, null, v_before,
    to_jsonb((select au from public.admin_users au where au.user_id = p_user_id))
  );

  perform public.ces_log_security_event(
    'role_change',
    case when v_before is null then 'invited' else 'reinvited' end,
    jsonb_build_object(
      'user_id', p_user_id, 'email', v_email, 'role', p_role,
      'previous_role', v_before -> 'role'
    )
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'user_id', p_user_id, 'role', p_role,
      'created', (v_before is null)
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 16.3 set-admin-role · capability `manage_users`
-- -----------------------------------------------------------------------------
-- Promotes an editor to admin or demotes an admin to editor. This is also the
-- one-call answer to the capability reduction the school is asked to approve at
-- cutover: bekah@cambridge-ellis.org is seeded as `editor`, and if the school
-- wants her at `admin` it is this command from /admin/users and not a code
-- change.
create or replace function public.set_admin_role(
  p_user_id uuid,
  p_role    text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check  jsonb;
  v_cs     uuid;
  v_before public.admin_users;
  v_others integer;
begin
  v_check := public.ces_guard('manage_users', 'set-admin-role');
  if v_check is not null then return v_check; end if;

  if coalesce(p_role, '') not in ('admin', 'editor') then
    return public.ces_result_error(
      'invalid', 'A role is either admin or editor.',
      jsonb_build_object('role', p_role)
    );
  end if;

  -- Self-demotion, refused before anything else. See the section note.
  if p_user_id = auth.uid() and p_role <> 'admin' then
    return public.ces_result_error(
      'invariant',
      'You cannot remove your own administrator access.',
      jsonb_build_object('user_id', p_user_id)
    );
  end if;

  select * into v_before
    from public.admin_users au where au.user_id = p_user_id
     for update;

  if v_before.user_id is null then
    return public.ces_result_error(
      'not_found', 'That account is not a member.',
      jsonb_build_object('user_id', p_user_id)
    );
  end if;

  if v_before.role = p_role then
    return public.ces_result_ok(
      null,
      jsonb_build_object('user_id', p_user_id, 'role', p_role, 'unchanged', true)
    );
  end if;

  -- The last-admin invariant, under the lock ces_other_active_admins takes.
  if v_before.role = 'admin' and v_before.is_active and p_role = 'editor' then
    v_others := public.ces_other_active_admins(p_user_id);

    if v_others = 0 then
      return public.ces_result_error(
        'invariant',
        'This is the only administrator. Promote somebody else first.',
        jsonb_build_object('user_id', p_user_id, 'other_active_admins', 0)
      );
    end if;
  end if;

  update public.admin_users set role = p_role where user_id = p_user_id;

  v_cs := public.ces_new_change_set();

  perform public.ces_write_revision(
    v_cs, 'admin_users', p_user_id, 'role',
    to_jsonb(v_before.role), to_jsonb(p_role)
  );

  perform public.ces_log_security_event(
    'role_change',
    v_before.role || ' -> ' || p_role,
    jsonb_build_object(
      'user_id', p_user_id, 'previous_role', v_before.role, 'role', p_role
    )
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'user_id', p_user_id, 'previous_role', v_before.role, 'role', p_role
    )
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- 16.4 disable-admin · capability `manage_users`
-- -----------------------------------------------------------------------------
-- TWO ENUMERATED MODES, NOT A BOOLEAN FLAG, and they carry different authority:
--
--   'block'   Clears is_active and stamps disabled_at. The Auth user SURVIVES, so
--             content_revisions.actor_id keeps pointing at a real account and the
--             audit trail keeps a real actor. This is the mode an operator
--             revoking access actually wants, and migration 14 says so.
--   'delete'  Additionally signals that the Auth user is to be removed — and is
--             REFUSED OUTRIGHT if that user authored any surviving revision.
--             Migration 14 line 96 gives the reason: actor_id is `on delete set
--             null` precisely so history outlives an account, and this refusal is
--             what keeps that fallback from becoming the normal case. An
--             anonymous hole in the audit trail is a real loss.
--
-- A flag on one path would let a call site pass `true` quietly; two named modes
-- put the choice in the call and in every audit row. The mode is validated
-- against a closed set, so a typo denies rather than picking a default.
--
-- THE auth.users DELETION IS THE CALLER'S, NOT THIS FUNCTION'S. Postgres has no
-- reach into GoTrue's account lifecycle, and this function will not pretend
-- otherwise: in 'delete' mode it clears the membership, records the intent, and
-- returns `delete_auth_user` true so the route handler performs the Auth admin
-- deletion. The same applies to the ban in 'block' mode — see the section note on
-- what revocation does and does not do.
create or replace function public.disable_admin(
  p_user_id uuid,
  p_mode    text default 'block'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_check    jsonb;
  v_cs       uuid;
  v_before   public.admin_users;
  v_others   integer;
  v_authored integer;
begin
  v_check := public.ces_guard('manage_users', 'disable-admin');
  if v_check is not null then return v_check; end if;

  if coalesce(p_mode, '') not in ('block', 'delete') then
    return public.ces_result_error(
      'invalid',
      'Choose either block or delete.',
      jsonb_build_object('mode', p_mode)
    );
  end if;

  -- Self-disable, refused. Locking yourself out is not an operation.
  if p_user_id = auth.uid() then
    return public.ces_result_error(
      'invariant',
      'You cannot disable your own account.',
      jsonb_build_object('user_id', p_user_id)
    );
  end if;

  select * into v_before
    from public.admin_users au where au.user_id = p_user_id
     for update;

  if v_before.user_id is null then
    return public.ces_result_error(
      'not_found', 'That account is not a member.',
      jsonb_build_object('user_id', p_user_id)
    );
  end if;

  -- The last-admin invariant applies to BOTH modes, which is why it is tested
  -- here rather than inside one branch.
  if v_before.role = 'admin' and v_before.is_active then
    v_others := public.ces_other_active_admins(p_user_id);

    if v_others = 0 then
      return public.ces_result_error(
        'invariant',
        'This is the only administrator. Promote somebody else first.',
        jsonb_build_object('user_id', p_user_id, 'other_active_admins', 0)
      );
    end if;
  end if;

  if p_mode = 'delete' then
    select count(*)::integer into v_authored
      from public.content_revisions cr where cr.actor_id = p_user_id;

    if v_authored > 0 then
      return public.ces_result_error(
        'blocked',
        'This account has editing history, so it cannot be deleted. Block it '
        'instead — the history keeps a real author that way.',
        jsonb_build_object('user_id', p_user_id, 'authored_revisions', v_authored)
      );
    end if;
  end if;

  v_cs := public.ces_new_change_set();

  -- is_active and disabled_at set TOGETHER, because migration 13's
  -- admin_users_disabled_at_check requires the pair to agree. Supplying the
  -- timestamp explicitly also records the precise instant inside this
  -- transaction, which that migration's trigger honours rather than overwrites.
  if v_before.is_active then
    update public.admin_users
       set is_active   = false,
           disabled_at = timezone('utc', now())
     where user_id = p_user_id;

    perform public.ces_write_revision(
      v_cs, 'admin_users', p_user_id, 'is_active',
      to_jsonb(true), to_jsonb(false)
    );
  end if;

  if p_mode = 'delete' then
    -- The membership goes now; the Auth account is the caller's to remove. The
    -- refusal above guarantees there is no surviving revision to orphan.
    perform public.ces_write_revision(
      v_cs, 'admin_users', p_user_id, null,
      to_jsonb(v_before), null
    );

    delete from public.admin_users where user_id = p_user_id;
  end if;

  perform public.ces_log_security_event(
    'revocation',
    p_mode,
    jsonb_build_object(
      'user_id', p_user_id, 'mode', p_mode, 'role', v_before.role,
      'was_active', v_before.is_active
    )
  );

  return public.ces_result_ok(
    v_cs,
    jsonb_build_object(
      'user_id', p_user_id,
      'mode', p_mode,
      'is_active', false,
      -- What the route handler must still do through the Auth admin API. Named
      -- rather than implied, because Postgres cannot do it.
      'ban_auth_user',    (p_mode = 'block'),
      'delete_auth_user', (p_mode = 'delete')
    )
  );
end;
$fn$;




-- =============================================================================
-- 17. Execute privileges — least privilege, and the trap that defeats the
--     obvious fix
-- =============================================================================
-- THREE REVOKES ARE REQUIRED FOR EVERY FUNCTION, and only the first is obvious.
-- All three were verified against this stack rather than reasoned about, because
-- each default here differs from plain PostgreSQL:
--
--   * `create function` grants EXECUTE to PUBLIC, and both anon and
--     authenticated are members of PUBLIC. Granting to authenticated alone
--     would therefore change nothing whatsoever.
--   * Supabase additionally ships `alter default privileges in schema public
--     grant execute on functions to postgres, anon, authenticated,
--     service_role`. Those are DIRECT grants to the anon AND authenticated
--     roles, recorded in the acl as `anon=X/postgres` and
--     `authenticated=X/postgres`, and `revoke ... from public` CANNOT remove
--     either, because PUBLIC, anon and authenticated are different grantees.
--
-- Revoking only from PUBLIC would leave every function in this file executable
-- by anonymous visitors while the migration looked as though it had locked them
-- down. THE authenticated REVOKE IN 17.3 IS THE ONE THAT MATTERS MOST, and it
-- closes a hole that was measured on this stack rather than imagined: with the
-- inherited default grant in place, an ordinary signed-in account holding NO
-- admin_users row and sitting at aal1 could call
--
--   ces_insert_row(''pages'', ''{..."published": true}'')
--
-- over PostgREST and insert a PUBLISHED page, bypassing ces_guard, the
-- capability matrix, the route lock and the audit trail in a single request —
-- because these helpers are security definer and therefore run as the owner.
-- ces_write_revision would likewise let that account FORGE AUDIT ROWS, and
-- ces_apply_restored_value would let it write any column of any restorable
-- table. Revoking from PUBLIC and anon does nothing about any of it.
--
-- That is the whole reason this file exists stated in miniature: the guard is
-- only a guard if the only way in is through it. All three revokes appear below
-- for every function, and all are idempotent so a second apply is clean.
--
-- THE GRANT LINE, drawn deliberately:
--
--   authenticated   the 30 commands, plus get_maintenance_state,
--                   reserve_upload, commit_asset_bucket and
--                   published_reference_count. Nothing else.
--   anon            get_maintenance_state() AND NOTHING ELSE. This is the
--                   single privileged read on the anonymous path, and
--                   migration 13 line 520 names it as the only one.
--   service_role    everything, because the operator tooling runs as it and it
--                   is privilege-checked for execute like any other role
--                   despite bypassing RLS.
--
-- The 36 ces_* helpers and assert_route_available get NO authenticated grant at
-- all — 37 functions. They are called only
-- from inside the security definer functions above, where the privilege check
-- is against the function OWNER rather than the caller — so they work without
-- being reachable over rpc. A caller cannot invoke ces_guard, ces_write_revision
-- or ces_insert_row directly, which is what stops an audit row being forged or
-- an insert being made outside a command.
--
-- Verified by query rather than by reading; the two verification queries are in
-- section 18.

-- 17.1 Revoke from PUBLIC — every function in this file.
revoke execute on function public.assert_route_available(text, text, uuid) from public;
revoke execute on function public.ces_allow_media_column(text, text) from public;
revoke execute on function public.ces_allow_rich_text_column(text, text) from public;
revoke execute on function public.ces_allow_section_column(text, text) from public;
revoke execute on function public.ces_allow_text_column(text, text) from public;
revoke execute on function public.ces_apply_restored_value(text, uuid, text, jsonb) from public;
revoke execute on function public.ces_asset_move_plan(uuid[]) from public;
revoke execute on function public.ces_asset_reference_rows(uuid) from public;
revoke execute on function public.ces_check_conflict(text, uuid, timestamp with time zone) from public;
revoke execute on function public.ces_check_length(text, text, text, text) from public;
revoke execute on function public.ces_check_upload_bytes(bigint) from public;
revoke execute on function public.ces_upload_class(text) from public;
revoke execute on function public.ces_check_upload_limits(text, bigint) from public;
revoke execute on function public.ces_check_upload_rate() from public;
revoke execute on function public.ces_check_write_rate() from public;
revoke execute on function public.ces_entry_blockers(text, uuid) from public;
revoke execute on function public.ces_guard(text, text) from public;
revoke execute on function public.ces_insert_row(text, jsonb) from public;
revoke execute on function public.ces_is_collection(text) from public;
revoke execute on function public.ces_is_orderable(text) from public;
revoke execute on function public.ces_is_service_role() from public;
revoke execute on function public.ces_log_security_event(text, text, jsonb) from public;
revoke execute on function public.ces_new_change_set() from public;
revoke execute on function public.ces_other_active_admins(uuid) from public;
revoke execute on function public.ces_page_depth(uuid) from public;
revoke execute on function public.ces_page_path(uuid, text) from public;
revoke execute on function public.ces_page_subtree_height(uuid) from public;
revoke execute on function public.ces_required_bucket(uuid) from public;
revoke execute on function public.ces_restorable_table(text) from public;
revoke execute on function public.ces_result_error(text, text, jsonb) from public;
revoke execute on function public.ces_result_ok(uuid, jsonb) from public;
revoke execute on function public.ces_route_kind(text) from public;
revoke execute on function public.ces_route_path(text, uuid, text) from public;
revoke execute on function public.ces_row_asset_ids(text, uuid) from public;
revoke execute on function public.ces_row_json(text, uuid) from public;
revoke execute on function public.ces_text_column_required(text, text) from public;
revoke execute on function public.ces_trash_key(uuid, text) from public;
revoke execute on function public.ces_valid_slug(text) from public;
revoke execute on function public.ces_write_revision(uuid, text, uuid, text, jsonb, jsonb) from public;
revoke execute on function public.commit_asset_bucket(uuid, text) from public;
revoke execute on function public.create_entry(text, jsonb) from public;
revoke execute on function public.delete_entry(text, uuid) from public;
revoke execute on function public.delete_term(uuid) from public;
revoke execute on function public.disable_admin(uuid, text) from public;
revoke execute on function public.duplicate_entry(text, uuid, text) from public;
revoke execute on function public.finalize_upload(uuid, text, text, text, bigint, integer, integer) from public;
revoke execute on function public.force_delete_entry(text, uuid) from public;
revoke execute on function public.force_delete_term(uuid) from public;
revoke execute on function public.get_maintenance_state() from public;
revoke execute on function public.invite_admin(uuid, text) from public;
revoke execute on function public.published_reference_count(uuid) from public;
revoke execute on function public.rename_asset(uuid, text, text) from public;
revoke execute on function public.reorder_entries(text, uuid, uuid[]) from public;
revoke execute on function public.reorder_sections(uuid, uuid, uuid[]) from public;
revoke execute on function public.reparent_page(uuid, uuid, integer) from public;
revoke execute on function public.replace_asset(uuid, text, text, text, bigint, integer, integer) from public;
revoke execute on function public.reserve_upload(text, text, bigint, integer) from public;
revoke execute on function public.restore_asset(uuid, text) from public;
revoke execute on function public.restore_change_set(uuid) from public;
revoke execute on function public.restore_revision(uuid) from public;
revoke execute on function public.retire_asset(uuid, text) from public;
revoke execute on function public.set_admin_role(uuid, text) from public;
revoke execute on function public.set_published(text, uuid, boolean, timestamp with time zone) from public;
revoke execute on function public.set_section_enabled(uuid, boolean, timestamp with time zone) from public;
revoke execute on function public.update_focal_point(uuid, numeric, numeric, numeric, timestamp with time zone) from public;
revoke execute on function public.update_globals(text, jsonb, uuid) from public;
revoke execute on function public.update_media(text, uuid, text, uuid, timestamp with time zone) from public;
revoke execute on function public.update_nav_tree(jsonb) from public;
revoke execute on function public.update_rich_text(text, uuid, text, jsonb, timestamp with time zone) from public;
revoke execute on function public.update_section(uuid, jsonb, timestamp with time zone) from public;
revoke execute on function public.update_slug(text, uuid, text, timestamp with time zone) from public;
revoke execute on function public.update_text(text, uuid, text, text, timestamp with time zone) from public;
revoke execute on function public.upsert_term(uuid, text, text, text) from public;

-- 17.2 Revoke from anon — the direct grant the revoke above cannot reach.
revoke execute on function public.assert_route_available(text, text, uuid) from anon;
revoke execute on function public.ces_allow_media_column(text, text) from anon;
revoke execute on function public.ces_allow_rich_text_column(text, text) from anon;
revoke execute on function public.ces_allow_section_column(text, text) from anon;
revoke execute on function public.ces_allow_text_column(text, text) from anon;
revoke execute on function public.ces_apply_restored_value(text, uuid, text, jsonb) from anon;
revoke execute on function public.ces_asset_move_plan(uuid[]) from anon;
revoke execute on function public.ces_asset_reference_rows(uuid) from anon;
revoke execute on function public.ces_check_conflict(text, uuid, timestamp with time zone) from anon;
revoke execute on function public.ces_check_length(text, text, text, text) from anon;
revoke execute on function public.ces_check_upload_bytes(bigint) from anon;
revoke execute on function public.ces_upload_class(text) from anon;
revoke execute on function public.ces_check_upload_limits(text, bigint) from anon;
revoke execute on function public.ces_check_upload_rate() from anon;
revoke execute on function public.ces_check_write_rate() from anon;
revoke execute on function public.ces_entry_blockers(text, uuid) from anon;
revoke execute on function public.ces_guard(text, text) from anon;
revoke execute on function public.ces_insert_row(text, jsonb) from anon;
revoke execute on function public.ces_is_collection(text) from anon;
revoke execute on function public.ces_is_orderable(text) from anon;
revoke execute on function public.ces_is_service_role() from anon;
revoke execute on function public.ces_log_security_event(text, text, jsonb) from anon;
revoke execute on function public.ces_new_change_set() from anon;
revoke execute on function public.ces_other_active_admins(uuid) from anon;
revoke execute on function public.ces_page_depth(uuid) from anon;
revoke execute on function public.ces_page_path(uuid, text) from anon;
revoke execute on function public.ces_page_subtree_height(uuid) from anon;
revoke execute on function public.ces_required_bucket(uuid) from anon;
revoke execute on function public.ces_restorable_table(text) from anon;
revoke execute on function public.ces_result_error(text, text, jsonb) from anon;
revoke execute on function public.ces_result_ok(uuid, jsonb) from anon;
revoke execute on function public.ces_route_kind(text) from anon;
revoke execute on function public.ces_route_path(text, uuid, text) from anon;
revoke execute on function public.ces_row_asset_ids(text, uuid) from anon;
revoke execute on function public.ces_row_json(text, uuid) from anon;
revoke execute on function public.ces_text_column_required(text, text) from anon;
revoke execute on function public.ces_trash_key(uuid, text) from anon;
revoke execute on function public.ces_valid_slug(text) from anon;
revoke execute on function public.ces_write_revision(uuid, text, uuid, text, jsonb, jsonb) from anon;
revoke execute on function public.commit_asset_bucket(uuid, text) from anon;
revoke execute on function public.create_entry(text, jsonb) from anon;
revoke execute on function public.delete_entry(text, uuid) from anon;
revoke execute on function public.delete_term(uuid) from anon;
revoke execute on function public.disable_admin(uuid, text) from anon;
revoke execute on function public.duplicate_entry(text, uuid, text) from anon;
revoke execute on function public.finalize_upload(uuid, text, text, text, bigint, integer, integer) from anon;
revoke execute on function public.force_delete_entry(text, uuid) from anon;
revoke execute on function public.force_delete_term(uuid) from anon;
revoke execute on function public.get_maintenance_state() from anon;
revoke execute on function public.invite_admin(uuid, text) from anon;
revoke execute on function public.published_reference_count(uuid) from anon;
revoke execute on function public.rename_asset(uuid, text, text) from anon;
revoke execute on function public.reorder_entries(text, uuid, uuid[]) from anon;
revoke execute on function public.reorder_sections(uuid, uuid, uuid[]) from anon;
revoke execute on function public.reparent_page(uuid, uuid, integer) from anon;
revoke execute on function public.replace_asset(uuid, text, text, text, bigint, integer, integer) from anon;
revoke execute on function public.reserve_upload(text, text, bigint, integer) from anon;
revoke execute on function public.restore_asset(uuid, text) from anon;
revoke execute on function public.restore_change_set(uuid) from anon;
revoke execute on function public.restore_revision(uuid) from anon;
revoke execute on function public.retire_asset(uuid, text) from anon;
revoke execute on function public.set_admin_role(uuid, text) from anon;
revoke execute on function public.set_published(text, uuid, boolean, timestamp with time zone) from anon;
revoke execute on function public.set_section_enabled(uuid, boolean, timestamp with time zone) from anon;
revoke execute on function public.update_focal_point(uuid, numeric, numeric, numeric, timestamp with time zone) from anon;
revoke execute on function public.update_globals(text, jsonb, uuid) from anon;
revoke execute on function public.update_media(text, uuid, text, uuid, timestamp with time zone) from anon;
revoke execute on function public.update_nav_tree(jsonb) from anon;
revoke execute on function public.update_rich_text(text, uuid, text, jsonb, timestamp with time zone) from anon;
revoke execute on function public.update_section(uuid, jsonb, timestamp with time zone) from anon;
revoke execute on function public.update_slug(text, uuid, text, timestamp with time zone) from anon;
revoke execute on function public.update_text(text, uuid, text, text, timestamp with time zone) from anon;
revoke execute on function public.upsert_term(uuid, text, text, text) from anon;

-- 17.3 Revoke from authenticated — THE CRITICAL ONE. See the note above: this
--      is what stops a signed-in non-member reaching the internal helpers
--      directly over rpc. 17.5 grants it back on the 34 functions that are
--      genuinely part of the application surface, and on nothing else.
revoke execute on function public.assert_route_available(text, text, uuid) from authenticated;
revoke execute on function public.ces_allow_media_column(text, text) from authenticated;
revoke execute on function public.ces_allow_rich_text_column(text, text) from authenticated;
revoke execute on function public.ces_allow_section_column(text, text) from authenticated;
revoke execute on function public.ces_allow_text_column(text, text) from authenticated;
revoke execute on function public.ces_apply_restored_value(text, uuid, text, jsonb) from authenticated;
revoke execute on function public.ces_asset_move_plan(uuid[]) from authenticated;
revoke execute on function public.ces_asset_reference_rows(uuid) from authenticated;
revoke execute on function public.ces_check_conflict(text, uuid, timestamp with time zone) from authenticated;
revoke execute on function public.ces_check_length(text, text, text, text) from authenticated;
revoke execute on function public.ces_check_upload_bytes(bigint) from authenticated;
revoke execute on function public.ces_upload_class(text) from authenticated;
revoke execute on function public.ces_check_upload_limits(text, bigint) from authenticated;
revoke execute on function public.ces_check_upload_rate() from authenticated;
revoke execute on function public.ces_check_write_rate() from authenticated;
revoke execute on function public.ces_entry_blockers(text, uuid) from authenticated;
revoke execute on function public.ces_guard(text, text) from authenticated;
revoke execute on function public.ces_insert_row(text, jsonb) from authenticated;
revoke execute on function public.ces_is_collection(text) from authenticated;
revoke execute on function public.ces_is_orderable(text) from authenticated;
revoke execute on function public.ces_is_service_role() from authenticated;
revoke execute on function public.ces_log_security_event(text, text, jsonb) from authenticated;
revoke execute on function public.ces_new_change_set() from authenticated;
revoke execute on function public.ces_other_active_admins(uuid) from authenticated;
revoke execute on function public.ces_page_depth(uuid) from authenticated;
revoke execute on function public.ces_page_path(uuid, text) from authenticated;
revoke execute on function public.ces_page_subtree_height(uuid) from authenticated;
revoke execute on function public.ces_required_bucket(uuid) from authenticated;
revoke execute on function public.ces_restorable_table(text) from authenticated;
revoke execute on function public.ces_result_error(text, text, jsonb) from authenticated;
revoke execute on function public.ces_result_ok(uuid, jsonb) from authenticated;
revoke execute on function public.ces_route_kind(text) from authenticated;
revoke execute on function public.ces_route_path(text, uuid, text) from authenticated;
revoke execute on function public.ces_row_asset_ids(text, uuid) from authenticated;
revoke execute on function public.ces_row_json(text, uuid) from authenticated;
revoke execute on function public.ces_text_column_required(text, text) from authenticated;
revoke execute on function public.ces_trash_key(uuid, text) from authenticated;
revoke execute on function public.ces_valid_slug(text) from authenticated;
revoke execute on function public.ces_write_revision(uuid, text, uuid, text, jsonb, jsonb) from authenticated;
revoke execute on function public.commit_asset_bucket(uuid, text) from authenticated;
revoke execute on function public.create_entry(text, jsonb) from authenticated;
revoke execute on function public.delete_entry(text, uuid) from authenticated;
revoke execute on function public.delete_term(uuid) from authenticated;
revoke execute on function public.disable_admin(uuid, text) from authenticated;
revoke execute on function public.duplicate_entry(text, uuid, text) from authenticated;
revoke execute on function public.finalize_upload(uuid, text, text, text, bigint, integer, integer) from authenticated;
revoke execute on function public.force_delete_entry(text, uuid) from authenticated;
revoke execute on function public.force_delete_term(uuid) from authenticated;
revoke execute on function public.get_maintenance_state() from authenticated;
revoke execute on function public.invite_admin(uuid, text) from authenticated;
revoke execute on function public.published_reference_count(uuid) from authenticated;
revoke execute on function public.rename_asset(uuid, text, text) from authenticated;
revoke execute on function public.reorder_entries(text, uuid, uuid[]) from authenticated;
revoke execute on function public.reorder_sections(uuid, uuid, uuid[]) from authenticated;
revoke execute on function public.reparent_page(uuid, uuid, integer) from authenticated;
revoke execute on function public.replace_asset(uuid, text, text, text, bigint, integer, integer) from authenticated;
revoke execute on function public.reserve_upload(text, text, bigint, integer) from authenticated;
revoke execute on function public.restore_asset(uuid, text) from authenticated;
revoke execute on function public.restore_change_set(uuid) from authenticated;
revoke execute on function public.restore_revision(uuid) from authenticated;
revoke execute on function public.retire_asset(uuid, text) from authenticated;
revoke execute on function public.set_admin_role(uuid, text) from authenticated;
revoke execute on function public.set_published(text, uuid, boolean, timestamp with time zone) from authenticated;
revoke execute on function public.set_section_enabled(uuid, boolean, timestamp with time zone) from authenticated;
revoke execute on function public.update_focal_point(uuid, numeric, numeric, numeric, timestamp with time zone) from authenticated;
revoke execute on function public.update_globals(text, jsonb, uuid) from authenticated;
revoke execute on function public.update_media(text, uuid, text, uuid, timestamp with time zone) from authenticated;
revoke execute on function public.update_nav_tree(jsonb) from authenticated;
revoke execute on function public.update_rich_text(text, uuid, text, jsonb, timestamp with time zone) from authenticated;
revoke execute on function public.update_section(uuid, jsonb, timestamp with time zone) from authenticated;
revoke execute on function public.update_slug(text, uuid, text, timestamp with time zone) from authenticated;
revoke execute on function public.update_text(text, uuid, text, text, timestamp with time zone) from authenticated;
revoke execute on function public.upsert_term(uuid, text, text, text) from authenticated;

-- 17.4 Grant to service_role — the operator tooling and the cleanup route.
grant execute on function public.assert_route_available(text, text, uuid) to service_role;
grant execute on function public.ces_allow_media_column(text, text) to service_role;
grant execute on function public.ces_allow_rich_text_column(text, text) to service_role;
grant execute on function public.ces_allow_section_column(text, text) to service_role;
grant execute on function public.ces_allow_text_column(text, text) to service_role;
grant execute on function public.ces_apply_restored_value(text, uuid, text, jsonb) to service_role;
grant execute on function public.ces_asset_move_plan(uuid[]) to service_role;
grant execute on function public.ces_asset_reference_rows(uuid) to service_role;
grant execute on function public.ces_check_conflict(text, uuid, timestamp with time zone) to service_role;
grant execute on function public.ces_check_length(text, text, text, text) to service_role;
grant execute on function public.ces_check_upload_bytes(bigint) to service_role;
grant execute on function public.ces_upload_class(text) to service_role;
grant execute on function public.ces_check_upload_limits(text, bigint) to service_role;
grant execute on function public.ces_check_upload_rate() to service_role;
grant execute on function public.ces_check_write_rate() to service_role;
grant execute on function public.ces_entry_blockers(text, uuid) to service_role;
grant execute on function public.ces_guard(text, text) to service_role;
grant execute on function public.ces_insert_row(text, jsonb) to service_role;
grant execute on function public.ces_is_collection(text) to service_role;
grant execute on function public.ces_is_orderable(text) to service_role;
grant execute on function public.ces_is_service_role() to service_role;
grant execute on function public.ces_log_security_event(text, text, jsonb) to service_role;
grant execute on function public.ces_new_change_set() to service_role;
grant execute on function public.ces_other_active_admins(uuid) to service_role;
grant execute on function public.ces_page_depth(uuid) to service_role;
grant execute on function public.ces_page_path(uuid, text) to service_role;
grant execute on function public.ces_page_subtree_height(uuid) to service_role;
grant execute on function public.ces_required_bucket(uuid) to service_role;
grant execute on function public.ces_restorable_table(text) to service_role;
grant execute on function public.ces_result_error(text, text, jsonb) to service_role;
grant execute on function public.ces_result_ok(uuid, jsonb) to service_role;
grant execute on function public.ces_route_kind(text) to service_role;
grant execute on function public.ces_route_path(text, uuid, text) to service_role;
grant execute on function public.ces_row_asset_ids(text, uuid) to service_role;
grant execute on function public.ces_row_json(text, uuid) to service_role;
grant execute on function public.ces_text_column_required(text, text) to service_role;
grant execute on function public.ces_trash_key(uuid, text) to service_role;
grant execute on function public.ces_valid_slug(text) to service_role;
grant execute on function public.ces_write_revision(uuid, text, uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.commit_asset_bucket(uuid, text) to service_role;
grant execute on function public.create_entry(text, jsonb) to service_role;
grant execute on function public.delete_entry(text, uuid) to service_role;
grant execute on function public.delete_term(uuid) to service_role;
grant execute on function public.disable_admin(uuid, text) to service_role;
grant execute on function public.duplicate_entry(text, uuid, text) to service_role;
grant execute on function public.finalize_upload(uuid, text, text, text, bigint, integer, integer) to service_role;
grant execute on function public.force_delete_entry(text, uuid) to service_role;
grant execute on function public.force_delete_term(uuid) to service_role;
grant execute on function public.get_maintenance_state() to service_role;
grant execute on function public.invite_admin(uuid, text) to service_role;
grant execute on function public.published_reference_count(uuid) to service_role;
grant execute on function public.rename_asset(uuid, text, text) to service_role;
grant execute on function public.reorder_entries(text, uuid, uuid[]) to service_role;
grant execute on function public.reorder_sections(uuid, uuid, uuid[]) to service_role;
grant execute on function public.reparent_page(uuid, uuid, integer) to service_role;
grant execute on function public.replace_asset(uuid, text, text, text, bigint, integer, integer) to service_role;
grant execute on function public.reserve_upload(text, text, bigint, integer) to service_role;
grant execute on function public.restore_asset(uuid, text) to service_role;
grant execute on function public.restore_change_set(uuid) to service_role;
grant execute on function public.restore_revision(uuid) to service_role;
grant execute on function public.retire_asset(uuid, text) to service_role;
grant execute on function public.set_admin_role(uuid, text) to service_role;
grant execute on function public.set_published(text, uuid, boolean, timestamp with time zone) to service_role;
grant execute on function public.set_section_enabled(uuid, boolean, timestamp with time zone) to service_role;
grant execute on function public.update_focal_point(uuid, numeric, numeric, numeric, timestamp with time zone) to service_role;
grant execute on function public.update_globals(text, jsonb, uuid) to service_role;
grant execute on function public.update_media(text, uuid, text, uuid, timestamp with time zone) to service_role;
grant execute on function public.update_nav_tree(jsonb) to service_role;
grant execute on function public.update_rich_text(text, uuid, text, jsonb, timestamp with time zone) to service_role;
grant execute on function public.update_section(uuid, jsonb, timestamp with time zone) to service_role;
grant execute on function public.update_slug(text, uuid, text, timestamp with time zone) to service_role;
grant execute on function public.update_text(text, uuid, text, text, timestamp with time zone) to service_role;
grant execute on function public.upsert_term(uuid, text, text, text) to service_role;

-- 17.5 Grant to authenticated — the 30 commands and the four reachable helpers.
grant execute on function public.commit_asset_bucket(uuid, text) to authenticated;
grant execute on function public.create_entry(text, jsonb) to authenticated;
grant execute on function public.delete_entry(text, uuid) to authenticated;
grant execute on function public.delete_term(uuid) to authenticated;
grant execute on function public.disable_admin(uuid, text) to authenticated;
grant execute on function public.duplicate_entry(text, uuid, text) to authenticated;
grant execute on function public.finalize_upload(uuid, text, text, text, bigint, integer, integer) to authenticated;
grant execute on function public.force_delete_entry(text, uuid) to authenticated;
grant execute on function public.force_delete_term(uuid) to authenticated;
grant execute on function public.get_maintenance_state() to authenticated;
grant execute on function public.invite_admin(uuid, text) to authenticated;
grant execute on function public.published_reference_count(uuid) to authenticated;
grant execute on function public.rename_asset(uuid, text, text) to authenticated;
grant execute on function public.reorder_entries(text, uuid, uuid[]) to authenticated;
grant execute on function public.reorder_sections(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.reparent_page(uuid, uuid, integer) to authenticated;
grant execute on function public.replace_asset(uuid, text, text, text, bigint, integer, integer) to authenticated;
grant execute on function public.reserve_upload(text, text, bigint, integer) to authenticated;
grant execute on function public.restore_asset(uuid, text) to authenticated;
grant execute on function public.restore_change_set(uuid) to authenticated;
grant execute on function public.restore_revision(uuid) to authenticated;
grant execute on function public.retire_asset(uuid, text) to authenticated;
grant execute on function public.set_admin_role(uuid, text) to authenticated;
grant execute on function public.set_published(text, uuid, boolean, timestamp with time zone) to authenticated;
grant execute on function public.set_section_enabled(uuid, boolean, timestamp with time zone) to authenticated;
grant execute on function public.update_focal_point(uuid, numeric, numeric, numeric, timestamp with time zone) to authenticated;
grant execute on function public.update_globals(text, jsonb, uuid) to authenticated;
grant execute on function public.update_media(text, uuid, text, uuid, timestamp with time zone) to authenticated;
grant execute on function public.update_nav_tree(jsonb) to authenticated;
grant execute on function public.update_rich_text(text, uuid, text, jsonb, timestamp with time zone) to authenticated;
grant execute on function public.update_section(uuid, jsonb, timestamp with time zone) to authenticated;
grant execute on function public.update_slug(text, uuid, text, timestamp with time zone) to authenticated;
grant execute on function public.update_text(text, uuid, text, text, timestamp with time zone) to authenticated;
grant execute on function public.upsert_term(uuid, text, text, text) to authenticated;

-- 17.6 Grant to anon — get_maintenance_state() AND NOTHING ELSE.
--
-- If a second line ever appears in this block, it is a defect. The request
-- boundary needs the maintenance flag before it knows who is calling; nothing
-- else in this file has any business running without a session.
grant execute on function public.get_maintenance_state() to anon;


-- =============================================================================
-- 18. Documentation, and how to verify the two claims this file rests on
-- =============================================================================
-- Every function carries a comment naming its command variant and its
-- capability, so `\df+ public.*` is a readable index of the write surface.

-- 18.1 The thirty commands.
comment on function public.create_entry(text, jsonb) is
  'Command `create-entry`, capability `create_entry`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.delete_entry(text, uuid) is
  'Command `delete-entry`, capability `delete_entry`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.delete_term(uuid) is
  'Command `delete-term`, capability `manage_taxonomy`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.disable_admin(uuid, text) is
  'Command `disable-admin`, capability `manage_users`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.duplicate_entry(text, uuid, text) is
  'Command `duplicate-entry`, capability `create_entry`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.finalize_upload(uuid, text, text, text, bigint, integer, integer) is
  'Command `finalize-upload`, capability `upload`. Returns the shared '
  'jsonb result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.force_delete_entry(text, uuid) is
  'Command `force-delete-entry`, capability `delete_entry`. Returns '
  'the shared jsonb result envelope; denials are RETURNED, never '
  'raised, so the security_events row commits. Writes '
  'content_revisions under one change_set_id.';

comment on function public.force_delete_term(uuid) is
  'Command `force-delete-term`, capability `manage_taxonomy`. Returns '
  'the shared jsonb result envelope; denials are RETURNED, never '
  'raised, so the security_events row commits. Writes '
  'content_revisions under one change_set_id.';

comment on function public.invite_admin(uuid, text) is
  'Command `invite-admin`, capability `manage_users`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.rename_asset(uuid, text, text) is
  'Command `rename-asset`, capability `delete_asset`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.reorder_entries(text, uuid, uuid[]) is
  'Command `reorder-entries`, capability `reorder`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.reorder_sections(uuid, uuid, uuid[]) is
  'Command `reorder-sections`, capability `reorder`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.reparent_page(uuid, uuid, integer) is
  'Command `reparent-page`, capability `manage_nav`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.replace_asset(uuid, text, text, text, bigint, integer, integer) is
  'Command `replace-asset`, capability `upload`. Returns the shared '
  'jsonb result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.restore_asset(uuid, text) is
  'Command `restore-asset`, capability `delete_asset`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.restore_change_set(uuid) is
  'Command `restore-change-set`, capability `restore`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.restore_revision(uuid) is
  'Command `restore-revision`, capability `restore`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.retire_asset(uuid, text) is
  'Command `retire-asset`, capability `delete_asset`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.set_admin_role(uuid, text) is
  'Command `set-admin-role`, capability `manage_users`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.set_published(text, uuid, boolean, timestamp with time zone) is
  'Command `set-published`, capability `publish`. Returns the shared '
  'jsonb result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.set_section_enabled(uuid, boolean, timestamp with time zone) is
  'Command `set-section-enabled`, capability `publish`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.update_focal_point(uuid, numeric, numeric, numeric, timestamp with time zone) is
  'Command `update-focal-point`, capability `edit`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.update_globals(text, jsonb, uuid) is
  'Command `update-globals`, capability `manage_globals`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.update_media(text, uuid, text, uuid, timestamp with time zone) is
  'Command `update-media`, capability `upload`. Returns the shared '
  'jsonb result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.update_nav_tree(jsonb) is
  'Command `update-nav-tree`, capability `manage_nav`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

comment on function public.update_rich_text(text, uuid, text, jsonb, timestamp with time zone) is
  'Command `update-rich-text`, capability `edit`. Returns the shared '
  'jsonb result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.update_section(uuid, jsonb, timestamp with time zone) is
  'Command `update-section`, capability `edit`. Returns the shared '
  'jsonb result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.update_slug(text, uuid, text, timestamp with time zone) is
  'Command `update-slug`, capability `edit`. Returns the shared jsonb '
  'result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.update_text(text, uuid, text, text, timestamp with time zone) is
  'Command `update-text`, capability `edit`. Returns the shared jsonb '
  'result envelope; denials are RETURNED, never raised, so the '
  'security_events row commits. Writes content_revisions under one '
  'change_set_id.';

comment on function public.upsert_term(uuid, text, text, text) is
  'Command `upsert-term`, capability `manage_taxonomy`. Returns the '
  'shared jsonb result envelope; denials are RETURNED, never raised, '
  'so the security_events row commits. Writes content_revisions under '
  'one change_set_id.';

-- 18.2 The reachable helpers.
comment on function public.commit_asset_bucket(uuid, text) is
  'Shared machinery, capability `upload`. Records a VERIFIED Storage '
  'object move; refuses any bucket other than the one '
  'published_reference_count currently requires.';

comment on function public.get_maintenance_state() is
  'ANON-CALLABLE. The one privileged read on the anonymous path: '
  'returns the maintenance flag and retry seconds to any caller, and '
  'the title and message only to an active member. Read by '
  'nextjs/proxy.ts on every request.';

comment on function public.published_reference_count(uuid) is
  'THE single asset visibility predicate. > 0 means the object '
  'belongs in the public `media` bucket; 0 means `media-private`. '
  'Existential over published referrers, never universal.';

comment on function public.reserve_upload(text, text, bigint, integer) is
  'Shared machinery, capability `upload`. The /api/uploads/sign half: '
  'checks both upload ceilings, reserves the byte quota durably and '
  'writes the `reserved` asset row. Not one of the thirty commands.';

-- 18.3 Internal machinery — no authenticated grant.
comment on function public.assert_route_available(text, text, uuid) is
  'Route uniqueness enforcement point 2 of 4. Takes '
  'pg_advisory_xact_lock(hashtext(''route:'' || path)) as its FIRST '
  'act, then checks content_routes excluding the given kind+id. '
  'Internal: called by create-entry, update-slug and reparent-page.';

comment on function public.ces_allow_media_column(text, text) is
  'The closed allowlist for update-media: ten of the eleven asset '
  'foreign keys. site_globals.asset_id is excluded because it belongs '
  'to update-globals.';

comment on function public.ces_allow_rich_text_column(text, text) is
  'The closed allowlist for update-rich-text: the three ProseMirror '
  'document columns and no others.';

comment on function public.ces_allow_section_column(text, text) is
  'The per-kind section shape for update-section. Enforced here '
  'rather than as a check constraint so the legacy corpus loads '
  'grandfathered.';

comment on function public.ces_allow_text_column(text, text) is
  'The closed (table, column) allowlist for update-text. Text scalars '
  'only; `published`, `slug`, `path` and asset keys are absent by '
  'design.';

comment on function public.ces_apply_restored_value(text, uuid, text, jsonb) is
  'Writes one historical value back with the column''s own type '
  'conversion, by overlaying a single-key json object onto the '
  'existing row. Returns a typed result rather than raising when the '
  'value no longer fits.';

comment on function public.ces_asset_move_plan(uuid[]) is
  'One entry per asset whose current bucket differs from the required '
  'one. A PLAN only — it moves no bytes, because Storage is a '
  'separate system.';

comment on function public.ces_asset_reference_rows(uuid) is
  'Every row referencing an asset, regardless of publish state. What '
  'a blocked delete names so the refusal is actionable.';

comment on function public.ces_check_conflict(text, uuid, timestamp with time zone) is
  'Optimistic conflict rejection at ROW granularity. Compares the '
  'caller''s expected updated_at with the row''s current value and '
  'returns a typed conflict carrying both. A null expectation skips '
  'the check.';

comment on function public.ces_check_length(text, text, text, text) is
  'Blueprint character limits, enforced on writes only: '
  'announcements.title 30, pages.short_description 300, '
  'events.short_description 500. Grandfathers the six over-length '
  'legacy rows via a RATCHET — an unchanged or strictly shorter value '
  'is allowed, so a row can only converge on the limit.';

comment on function public.ces_check_upload_bytes(bigint) is
  'Rate limit: 500,000,000 upload bytes per account per rolling 24 '
  'hours, summed from the reservation ledger — declared_size_bytes '
  'for unexpired in-flight rows plus size_bytes for stored ones. '
  '`trashed` counts for nothing. Errors deny.';

comment on function public.ces_check_upload_rate() is
  'Rate limit: 60 uploads per account per rolling hour, counted from '
  'assets.created_by. Errors deny.';

comment on function public.ces_check_write_rate() is
  'Rate limit: 300 content writes per account per rolling hour, '
  'counted from content_revisions under `select ... for update` on '
  'the actor row. Errors deny.';

comment on function public.ces_entry_blockers(text, uuid) is
  'What blocks a page deletion: child pages, nav_items, announcement '
  'links and page_classrooms rows.';

comment on function public.ces_guard(text, text) is
  'THE authorization guard every command calls first. Checks '
  'auth.uid(), active admin_users membership, aal2 and the named '
  'capability, in that order. Returns null when allowed; otherwise '
  'inserts a security_events row of kind `denied` and RETURNS a typed '
  'result rather than raising, so the audit row commits.';

comment on function public.ces_insert_row(text, jsonb) is
  'Inserts from jsonb naming only the columns the payload carries, so '
  'every other column takes its table DEFAULT. Replaces `select * '
  'from jsonb_populate_record(null::t, $1)`, which nulls out every '
  '`not null default` column.';

comment on function public.ces_is_collection(text) is
  'True for the seven content collections.';

comment on function public.ces_is_orderable(text) is
  'The four collections that HAVE a sort_order column. '
  'Schema-determined, not a policy choice.';

comment on function public.ces_is_service_role() is
  'True when the request JWT carries role=service_role. Exempt from '
  'the guard and the rate limits because that key already bypasses '
  'RLS and holds direct DML. Never raises.';

comment on function public.ces_log_security_event(text, text, jsonb) is
  'Inserts a security_events row for a non-guard outcome: '
  'rate_limited, role_change or revocation.';

comment on function public.ces_new_change_set() is
  'Mints the change_set_id grouping every revision row one command '
  'writes.';

comment on function public.ces_other_active_admins(uuid) is
  'Counts the OTHER active admins, locking them first, so two '
  'concurrent demotions cannot both see a spare admin. Backs the '
  'last-admin invariant.';

comment on function public.ces_page_depth(uuid) is
  '1-based depth of a page. content/collections/pages.yaml sets '
  'max_depth 2, so 2 is the floor of the tree.';

comment on function public.ces_page_path(uuid, text) is
  'Materializes a page path from parent and slug, reproducing route '
  '''{parent_uri}/{slug}''. Collapses a ''/'' parent so a child of '
  'the site root is ''/slug'' and not ''//slug''.';

comment on function public.ces_page_subtree_height(uuid) is
  '1-based height of a page''s own subtree. Needed because a reparent '
  'must keep the DEEPEST DESCENDANT within max_depth, not merely the '
  'page being moved.';

comment on function public.ces_required_bucket(uuid) is
  'The bucket published_reference_count requires for an asset: '
  '`media` above zero, `media-private` at zero.';

comment on function public.ces_restorable_table(text) is
  'Which tables a history entry may be written back into. admin_users '
  'is deliberately absent: account state is not content history.';

comment on function public.ces_result_error(text, text, jsonb) is
  'Builds the shared failure envelope. Validates nothing, '
  'deliberately: a validator in the error path could only turn a '
  'refusal into a 500.';

comment on function public.ces_result_ok(uuid, jsonb) is
  'Builds the shared success envelope {ok, reason, message, '
  'change_set_id, detail}.';

comment on function public.ces_route_kind(text) is
  'Translates a plural table name into migration 15''s SINGULAR '
  'routing kind — page, classroom, person, event — or null for the '
  'three unrouted collections. The only place that translation '
  'happens.';

comment on function public.ces_route_path(text, uuid, text) is
  'The path a routed row occupies, per its collection''s own route '
  'pattern.';

comment on function public.ces_row_asset_ids(text, uuid) is
  'Every asset one content row points at, INCLUDING a page''s section '
  'assets — which is where most page photography lives.';

comment on function public.ces_row_json(text, uuid) is
  'A whole row as jsonb, for the whole-row create and delete revision '
  'entries.';

comment on function public.ces_text_column_required(text, text) is
  'Which allowlisted text columns are NOT NULL, so emptying one is a '
  'typed `invalid` rather than a raised constraint violation.';

comment on function public.ces_trash_key(uuid, text) is
  'Composes media-trash/<asset_id>/<iso-timestamp>/<filename>. Byte '
  'history is application-owned because Supabase Storage offers no '
  'object versioning at any tier. 90-day retention.';

comment on function public.ces_valid_slug(text) is
  'Slug shape: lowercase alphanumerics separated by single hyphens. '
  'Rejects anything that could forge a path segment.';

comment on function public.ces_write_revision(uuid, text, uuid, text, jsonb, jsonb) is
  'THE revision writer. Inserts one append-only content_revisions '
  'row. Catches nothing on purpose: if the audit cannot be written '
  'the whole transaction rolls back, mutation included.';

-- -----------------------------------------------------------------------------
-- 18.4 The verification queries, and their exact expected results
-- -----------------------------------------------------------------------------
-- Run all four after `supabase db reset`. None of these is a matter of reading
-- the file: each claim has a failure mode that is invisible on inspection, and
-- one of them (d) caught a real hole in this migration during development.
--
-- (a) EVERY security definer function pins search_path. Expect ZERO rows.
--
--   select p.proname
--     from pg_proc p
--    where p.pronamespace = ''public''::regnamespace
--      and p.prosecdef
--      and (p.proconfig is null
--           or not exists (select 1 from unnest(p.proconfig) c
--                          where c like ''search_path=%''));
--
-- (b) anon holds execute on get_maintenance_state AND NOTHING ELSE FROM THIS
--     MIGRATION. Expect exactly one row.
--
--   select p.proname
--     from pg_proc p, aclexplode(p.proacl) a, pg_roles r
--    where r.oid = a.grantee and a.privilege_type = ''EXECUTE''
--      and r.rolname = ''anon''
--      and p.pronamespace = ''public''::regnamespace
--      and p.proname not in (
--            ''ces_uuid'', ''ces_uuid_namespace'', ''set_updated_at'',
--            ''assert_person_has_role'', ''admin_users_stamp_disabled_at'',
--            ''is_active_admin_user'', ''has_capability'', ''current_aal'');
--
--     THE EXCLUSION LIST IS NOT A FUDGE, and it is worth being exact about
--     because the unscoped form of this query returns SIX rows on a correctly
--     built database. Five of those belong to earlier migrations and each is a
--     documented decision there rather than an oversight here:
--
--       ces_uuid, ces_uuid_namespace     migration 01 grants both to anon
--                                        deliberately and says why — they are
--                                        pure and disclose nothing, and
--                                        seed.sql needs them.
--       set_updated_at,                  trigger functions. Migration 06 spells
--       assert_person_has_role,          out that PUBLIC''s default execute
--       admin_users_stamp_disabled_at    grants nobody anything here, because
--                                        a trigger function invoked outside a
--                                        trigger context raises. Their
--                                        privileges are checked when the
--                                        trigger is created, not when it fires.
--
--     This migration does not revoke them: they are other files'' objects, their
--     comments explain the current state, and contradicting those comments from
--     here would make them stale. What this migration is answerable for is that
--     of the 73 functions IT defines, exactly one is anon-callable.
--
-- (c) No function from this migration retains a PUBLIC execute grant. Expect
--     ZERO rows. An acl entry with grantee 0 is PUBLIC. The same five
--     earlier-migration functions appear in the unscoped form, for the reasons
--     in (b).
--
--   select p.proname
--     from pg_proc p, aclexplode(p.proacl) a
--    where a.grantee = 0 and a.privilege_type = ''EXECUTE''
--      and p.pronamespace = ''public''::regnamespace
--      and p.proname not in (
--            ''ces_uuid'', ''ces_uuid_namespace'', ''set_updated_at'',
--            ''assert_person_has_role'', ''admin_users_stamp_disabled_at'');
--
-- (d) authenticated holds execute on EXACTLY 34 functions from this migration —
--     the 30 commands plus get_maintenance_state, reserve_upload,
--     commit_asset_bucket and published_reference_count. Expect 34, and expect
--     none of the ces_* helpers or assert_route_available among them.
--
--     THIS IS THE QUERY THAT MATTERS MOST, and it is not hypothetical. Before
--     17.3 was added it returned EVERY function this file defines (73 of 73,
--     rather than 34), because Supabase ships
--       alter default privileges in schema public
--         grant execute on functions to postgres, anon, authenticated, service_role
--     which is a DIRECT grant to authenticated that revoking from PUBLIC and from
--     anon leaves completely untouched. The consequence was reproduced as a live
--     exploit on a local stack: a signed-in account with NO admin_users row, at
--     aal1, called public.ces_insert_row and INSERTED A PUBLISHED PAGE — past the
--     guard, the capability matrix, the route lock and the audit trail. It could
--     equally forge content_revisions rows via ces_write_revision or write any
--     column of any restorable table via ces_apply_restored_value. DO NOT REMOVE
--     17.3, and do not assume a two-revoke pattern copied from another migration
--     is sufficient here.
--
--   select p.proname
--     from pg_proc p, aclexplode(p.proacl) a, pg_roles r
--    where r.oid = a.grantee and a.privilege_type = ''EXECUTE''
--      and r.rolname = ''authenticated''
--      and p.pronamespace = ''public''::regnamespace
--      and p.proname not in (
--            ''ces_uuid'', ''ces_uuid_namespace'', ''set_updated_at'',
--            ''assert_person_has_role'', ''admin_users_stamp_disabled_at'',
--            ''is_active_admin_user'', ''has_capability'', ''current_aal'')
--    order by p.proname;
-- =============================================================================
