-- =============================================================================
-- Cambridge-Ellis School  ·  migration 14 of 18  ·  the audit trail
-- =============================================================================
-- Two tables, and they are the only two append-only tables in the schema:
--
--   public.content_revisions  -> who changed which column of which row, from
--                                what to what, grouped into reversible units
--   public.security_events    -> security-relevant outcomes, admin-readable
--
-- WHAT THESE REPLACE, STATED HONESTLY. config/statamic/git.php enabled Git
-- integration with `automatic` on, so a commit was queued on every `Saved` and
-- `Deleted` event, `use_authenticated` attributed each commit to the signed-in
-- user, `dispatch_delay` was 0, and the tracked paths covered content, users,
-- blueprints, fieldsets, forms and public/assets. The legacy capability was
-- therefore automatic, actor-attributed history on every save. Statamic's OWN
-- per-entry revision system was never part of it: config/statamic/revisions.php
-- sets `enabled` to env('STATAMIC_REVISIONS_ENABLED', false) and every one of
-- the seven collection configs sets `revisions: false`. The only history the
-- school ever had was Git.
--
-- content_revisions is that capability's named replacement, and it is NOT
-- parity. Two differences are stated here rather than glossed over, because
-- somebody will eventually rely on one of them:
--
--   1. Git retained prior BYTES indefinitely. The target keeps replaced and
--      deleted media in the media-trash prefix for 90 DAYS, after which the
--      bytes are gone. This table records that a byte replacement happened; it
--      does not hold the bytes.
--   2. Git history survived the database. THIS TABLE DOES NOT. If the database
--      is lost, the audit trail is lost with it. Whole-database rollback
--      therefore rests on point-in-time recovery or the nightly pg_dump
--      fallback, never on this table.
--
-- README.md presents that pair as a REDUCED RECOVERY CAPABILITY REQUIRING
-- SCHOOL APPROVAL. Do not describe this migration as achieving parity with
-- Git-backed versioning anywhere, in code or in comments.
--
-- APPEND-ONLY IS THE POINT, AND IT IS ENFORCED IN TWO PLACES. This file supplies
-- the shape: there is NO updated_at column on either table, NO trigger of any
-- kind, and no soft-delete flag or status column that would imply a row can be
-- revised after the fact. A row here is a statement about something that already
-- happened, and a statement about the past has no legitimate reason to change.
-- Migration 17 supplies the permissions, and its job here is PARTLY TO OMIT:
--
--   content_revisions  select -> requires the `edit` capability
--                      insert -> only from inside a security definer write
--                                function in migration 16
--                      update -> NO POLICY. DELETE -> NO POLICY.
--   security_events    select -> requires ADMIN (asked as an admin-only
--                                capability, per migration 13)
--                      insert -> only from inside a write function or one of
--                                the route handlers listed in section 2
--                      update -> NO POLICY. DELETE -> NO POLICY.
--
-- With RLS enabled, THE ABSENCE OF A POLICY IS THE DENIAL. Whoever writes
-- migration 17 must not add an update or a delete policy to either table out of
-- habit or for symmetry with the content tables, and whoever next edits this
-- file must not add an `updated_at` "for consistency" with them either. The one
-- deletion that is legitimate is the nightly retention sweep described in
-- section 2, which runs as the service role and needs no policy.
--
-- WHY THREE COLUMNS ARE jsonb AND NO MORE. Migration 01's schema contract admits
-- jsonb only where the structure is genuinely variable, and names exactly three
-- columns from this file: content_revisions.value_before, .value_after and
-- security_events.detail. The first two hold an ARBITRARY COLUMN's value, which
-- across this schema is genuinely a text string, a boolean, an integer, a date,
-- a uuid or a whole ProseMirror document — there is no narrower type that can
-- represent all of them, and storing them as text would destroy the distinction
-- between the string "false" and the boolean false. security_events.detail holds
-- a payload whose shape differs per `kind`: a CSP report body has nothing in
-- common with a rate-limit window or a role change. Nothing else here is jsonb,
-- because everything else has a name.
--
-- No user-specified rules were provided for this project — review_rules returns
-- none. Enterprise-standard practice is applied and not relaxed: least privilege
-- (RLS on, no policy written here, neither table readable by anon), append-only
-- shape, full idempotency, and every column documented in the database itself.
--
-- PostgreSQL 17, per supabase/config.toml [db] major_version. Every statement is
-- idempotent, so applying all eighteen migrations twice is clean. All SQL
-- lowercase. No functions are defined here — the write functions that populate
-- both tables belong to migration 16 — and no seed rows are inserted, because a
-- migration has nothing to attest to.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. content_revisions
-- -----------------------------------------------------------------------------
-- One row per changed column of each row that a single command touched. A field edit
-- writes one row; a reparent writes one per affected page; a forced delete
-- writes one per reference it removes.

create table if not exists public.content_revisions (
  id             uuid        primary key default extensions.gen_random_uuid(),

  -- Who did it. `on delete set null`, NEVER cascade: the whole value of an
  -- audit trail is that it outlives the account it describes, and cascading
  -- would let deleting a user erase every trace of what that user did.
  --
  -- The nulling is a fallback rather than the expected path. Migration 16's
  -- disable_admin has two modes, and its *delete* mode is REFUSED OUTRIGHT if
  -- the target user authored any surviving revision — precisely so the trail
  -- keeps a real actor instead of an anonymous hole. Its *block* mode clears
  -- admin_users.is_active and leaves auth.users intact, which is the mode an
  -- operator revoking access actually uses. So this column goes null only when
  -- an account with no surviving history is genuinely removed, or when an
  -- account is removed out of band directly in Supabase Auth.
  --
  -- Nullable for one further reason: supabase/seed.sql loads as the service
  -- role, which is not an auth.users row at all.
  actor_id       uuid        references auth.users (id) on delete set null,

  -- THE COLUMN THIS TABLE EXISTS FOR, and the reason it is `not null`.
  --
  -- A per-column diff cannot express what these commands actually do. Migration
  -- 16's reparent_page rewrites the moved page's `path` AND EVERY DESCENDANT's
  -- in one transaction. A forced entry delete removes that entry's references
  -- from nav_items, announcements and page_classrooms in one transaction. A
  -- reorder renumbers a whole sibling set. An atomic asset replacement swaps
  -- bytes in Storage and updates the referencing row. Each of those is ONE
  -- operation that touched many rows, and each must be reversible AS ONE
  -- OPERATION -- undoing a single descendant's path would leave the tree
  -- inconsistent.
  --
  -- change_set_id is what makes that possible: every row a single command wrote
  -- carries the same value, so migration 16's restore_change_set can reverse the
  -- whole operation while restore_revision reverses one field. Both are exposed
  -- by nextjs/components/cms/RevisionHistory.tsx — per field from FieldFrame,
  -- and per row and per change set from the collection list.
  --
  -- There is no legitimate row without one. A revision with a null change set is
  -- unreversible as a group and would silently drop out of every restore, which
  -- is the exact failure the column is here to prevent. Hence not null, with no
  -- default: the value is minted by the calling command, once, and shared.
  change_set_id  uuid        not null,

  -- Which row was changed. Deliberately loose: a plain table name and a uuid,
  -- with NO foreign key and NO check constraint enumerating table names.
  --
  -- No FK is possible — the target could be any of a dozen tables — and none is
  -- wanted: a revision must survive the deletion of the row it describes, which
  -- is the case a restore is most needed in.
  --
  -- The absence of a CHECK is equally deliberate and is a correctness
  -- requirement, not laziness. Migration 16's write functions apply a mutation,
  -- insert these rows, and ROLL THE WHOLE TRANSACTION BACK IF THE AUDIT INSERT
  -- FAILS. A check listing today's table or column names would therefore turn a
  -- perfectly legitimate future edit into a failed save the moment a later
  -- migration adds a table or a column — the constraint would not merely reject
  -- an audit row, it would reject the content change. Nothing in this file may
  -- be able to fail for a valid write.
  table_name     text        not null,
  row_id         uuid        not null,

  -- Which column, and NULLABLE on purpose. A whole-row operation has no single
  -- column: create-entry, delete-entry and force-delete-entry record the row
  -- coming into or going out of existence, with the full row in value_after or
  -- value_before respectively and nothing meaningful to name here.
  column_name    text,

  -- The old and the new value. Both nullable, and asymmetrically so by design:
  -- a create has no before, a delete has no after, and a field that was
  -- genuinely null has a json null. See the jsonb justification in the header --
  -- these hold an arbitrary column's value, so no narrower type exists.
  value_before   jsonb,
  value_after    jsonb,

  -- When. The explicit UTC form mandated by migration 01's contract. There is no
  -- updated_at counterpart and there is no trigger on this table: see the
  -- append-only note below.
  created_at     timestamptz not null default timezone('utc', now())
);

-- 1.1 Append-only: what is deliberately absent.
--
-- NO updated_at column, and so no `before update` trigger calling
-- public.set_updated_at() — unlike every content table in migrations 02 and
-- 04-13, which all attach it. That divergence is intentional and is the whole
-- shape of this table: an updated_at would advertise that a revision can be
-- amended, and a trail that can be amended is not a trail. Migration 17 declares
-- no update policy, so the claim is enforced and not merely implied.
--
-- NO soft-delete or status flag either. A revision is not retracted; a mistaken
-- change is corrected by making another change, which writes its own row.

-- 1.2 Row level security: enabled here, policies in migration 17.
--
-- `enable` and not `force`, consistently with migration 13: forcing RLS would
-- apply it to the table owner as well, and the owner is exactly the role that
-- migration 16's security definer write functions run as. Forcing it would break
-- every insert this table is supposed to receive.
--
-- With RLS enabled and no policy present, non-owner roles read nothing and write
-- nothing. That is the correct default for an audit trail and it is why this
-- file writes no policy at all: `anon` must never read either table, and the
-- authenticated read is a capability question that belongs with the rest of the
-- policy set. Migration 17 owns the `select` policy (the `edit` capability, per
-- migration 13's matrix, which names reading content_revisions explicitly), the
-- table-level grants, and the revocation of direct DML from `authenticated`.
-- What it must NOT own is an update or a delete policy: see the header.
alter table public.content_revisions enable row level security;

-- 1.3 Indexes.
--
-- Three, each backing a named access path. Kept deliberately tight because this
-- is the schema's highest-insert-rate table — one row per edited field, plus one
-- per affected row in a multi-row change set — so every extra index is write
-- amplification on the critical path of a save.

-- The restore path. `select ... from content_revisions where change_set_id = $1`
-- is exactly the query migration 16's restore_change_set runs to gather an
-- operation before reversing it.
create index if not exists content_revisions_change_set_id_idx
  on public.content_revisions (change_set_id);

-- Per-row history: the query behind RevisionHistory when it is opened from a
-- field or from a row in the collection list. The pair is the natural key of
-- "this row's past", and table_name leading also serves a per-table sweep.
create index if not exists content_revisions_table_name_row_id_idx
  on public.content_revisions (table_name, row_id);

-- The rate limit, and the reason the composite is ordered this way.
--
-- Content writes are capped at 300 per rolling hour and counted FROM THIS TABLE,
-- because a process-local counter is per-instance on serverless and therefore
-- not a limit at all — the fidelis reference's module-scope Map is exactly that
-- mistake, and it is not carried. The count runs INSIDE the mutation's own
-- transaction, after `select ... for update` on the actor's admin_users row, so
-- two concurrent writes cannot both pass a check at the ceiling. Its shape is
-- fixed: `where actor_id = $1 and created_at > now() - interval '1 hour'`. This
-- index matches it exactly — equality on the leading column, range on the
-- second.
--
-- CHOSEN OVER A BARE created_at INDEX, deliberately. A bare created_at would
-- serve a whole-table retention sweep, but this table has no retention sweep:
-- /api/cleanup/orphans ages out security_events, never content_revisions, whose
-- rows are the history and are kept. So the only time-filtered query here is the
-- per-actor one above, and the composite serves it strictly better.
--
-- A STANDALONE actor_id INDEX IS DELIBERATELY NOT CREATED. It would be a
-- redundant btree prefix of this one — `where actor_id = $1` alone uses this
-- index just as well — so it would add insert cost on every save and buy
-- nothing. If a future query needs actor plus a different second column, add
-- that composite rather than resurrecting the single-column index.
create index if not exists content_revisions_actor_id_created_at_idx
  on public.content_revisions (actor_id, created_at);

-- 1.4 Comments.
--
-- The durable record. content/ and public/assets/ are deleted at the end of the
-- migration phase, so after cutover the database itself is the only place a
-- reader can learn why a column exists.

comment on table public.content_revisions is
  'Append-only audit trail: one row per changed column of each row a single '
  'command touched, grouped by change_set_id into reversible units. Replaces the '
  'automatic, actor-attributed Git history configured in '
  'config/statamic/git.php -- Statamic''s own revision system was disabled '
  '(config/statamic/revisions.php, and revisions: false on all seven '
  'collections), so Git was the only history that existed. NOT PARITY WITH GIT, '
  'and two differences matter: replaced media bytes live in media-trash for 90 '
  'days rather than indefinitely, and this trail does not survive the database, '
  'so whole-database rollback rests on point-in-time recovery or the nightly '
  'pg_dump fallback. README.md records that as a reduced recovery capability '
  'requiring school approval. No updated_at and no trigger, by design; '
  'migration 17 grants select on the edit capability, allows insert only from '
  'inside a security definer write function, and declares NO update policy and '
  'NO delete policy -- with RLS enabled, that absence is the denial.';

comment on column public.content_revisions.id is
  'Surrogate key, generated at write time. Deliberately NOT derived through '
  'public.ces_uuid() like the content tables: a revision has no legacy_ref '
  'because it has no counterpart in the Statamic corpus -- rows here describe '
  'writes made after cutover.';

comment on column public.content_revisions.actor_id is
  'The auth user who made the change; null for a service-role write such as the '
  'seed load. on delete SET NULL, never cascade, so history outlives the '
  'account. Migration 16''s disable_admin refuses its delete mode outright when '
  'the user authored any surviving revision, so the trail keeps a real actor.';

comment on column public.content_revisions.change_set_id is
  'Groups every row one command touched so the operation is ONE reversible '
  'unit: reparent_page rewrites the moved page and every descendant, a forced '
  'delete removes references from nav_items, announcements and page_classrooms, '
  'a reorder renumbers a sibling set, an asset replacement swaps bytes and '
  'updates the referencing row. restore_change_set reverses the group; '
  'restore_revision reverses one field. not null: a revision with no change set '
  'is unreversible as a group and would drop out of every restore.';

comment on column public.content_revisions.table_name is
  'Logical table of the changed row. No foreign key and DELIBERATELY NO CHECK '
  'enumerating table names: write functions roll the whole mutation back if the '
  'audit insert fails, so a constraint listing today''s names would turn a '
  'legitimate future edit into a failed save once a later migration adds a '
  'table.';

comment on column public.content_revisions.row_id is
  'Id of the changed row. Intentionally not a foreign key: a revision must '
  'survive deletion of the row it describes, which is when a restore is most '
  'needed.';

comment on column public.content_revisions.column_name is
  'Column changed, or NULL for a whole-row operation -- create-entry, '
  'delete-entry and force-delete-entry name no single column and carry the row '
  'in value_after or value_before. No check constraint, for the same reason as '
  'table_name.';

comment on column public.content_revisions.value_before is
  'Previous value of the column, as jsonb; null for a create. jsonb because an '
  'arbitrary column''s value is genuinely a string, boolean, integer, date, '
  'uuid or a whole ProseMirror document, and text would confuse the string '
  '"false" with the boolean false.';

comment on column public.content_revisions.value_after is
  'New value of the column, as jsonb; null for a delete. Same justification as '
  'value_before.';

comment on column public.content_revisions.created_at is
  'When the change was recorded, UTC. There is no updated_at counterpart: this '
  'table is append-only.';


-- -----------------------------------------------------------------------------
-- 2. security_events
-- -----------------------------------------------------------------------------
-- The durable, admin-readable record of security-relevant outcomes. Where
-- content_revisions answers "what changed", this answers "what was refused, and
-- why".
--
-- WHAT WRITES HERE, AND WHY EACH WRITE SURVIVES. This is not a detail: a denial
-- raised as an exception inside a write function ROLLS THE TRANSACTION BACK and
-- takes any audit row inserted before it along too. So every emitter below is
-- shaped so that its row actually commits.
--
--   kind             emitter                          why it commits
--   --------------   ------------------------------   -----------------------
--   csp              nextjs/app/api/csp-report        an ordinary route-handler
--                                                     insert; no enclosing
--                                                     transaction to lose
--   rate_limited     migration 16 write functions     RETURNED AS A TYPED
--                                                     RESULT, not raised, so
--                                                     the function inserts the
--                                                     row and commits
--   denied           migration 16 write functions     same: the capability,
--                    (capability, membership, aal      membership, aal and
--                    and conflict checks at the        conflict checks return
--                    rpc boundary)                     ok = false with a reason
--                                                     instead of raising
--   upload_rejected  /api/uploads/finalize            route handler, own
--                                                     transaction
--   media_denied     /api/media/[...path]             route handler, own
--                                                     transaction
--   role_change      set-admin-role                   part of the command's own
--   revocation       disable-admin                     committed change set
--
-- That table is precisely why migration 16's commands return typed results
-- rather than throwing. Where a genuinely exceptional failure must raise — a
-- constraint violation, a serialization failure — the calling Server Action
-- catches the typed error and writes the event in a SEPARATE transaction
-- through the admin client. That is an explicit second write, not an assumption
-- that the first survived.
--
-- WHAT THIS TABLE CANNOT SEE, stated rather than implied. A direct PostgREST
-- call that RLS or a table grant rejects produces NO ROW HERE. Nothing of ours
-- executes on that path — the rejection happens in the privilege layer, before
-- any function body — so no application-layer design can record it. Those
-- rejections are visible in Supabase's own API and Postgres logs, which are the
-- source of truth for that class. nextjs/tests/e2e/security.spec.ts asserts BOTH
-- halves: a write command rejected through the application produces a row here,
-- and a direct REST tampering attempt is rejected with no row. The second is
-- documented behaviour, not a bug. If the school later wants that class in this
-- table the mechanism is a log drain into it; it is named here as a deferred
-- option, never as an implied capability.

create table if not exists public.security_events (
  id           uuid        primary key default extensions.gen_random_uuid(),

  -- Who, when there is a who. Nullable and `on delete set null` for the same
  -- reason as content_revisions.actor_id, plus a structural one: two of the
  -- seven kinds have no actor by nature. A `csp` report arrives from an
  -- anonymous browser, and a `media_denied` is most interesting exactly when the
  -- caller was not signed in.
  actor_id     uuid        references auth.users (id) on delete set null,

  -- Which kind of event. Closed vocabulary, constrained below.
  kind         text        not null,

  -- Where it happened and how to correlate it with a platform log line. Both
  -- nullable: a write function called over rpc has no meaningful request path,
  -- and a request id is only available where the runtime supplied one.
  request_path text,
  request_id   text,

  -- The outcome in the emitter's own words. Nullable, and deliberately NOT
  -- constrained by a check: `kind` is the axis this table is queried and swept
  -- on, and pinning a second vocabulary would create exactly the failure mode
  -- ruled out for content_revisions.table_name — a route handler recording a new
  -- outcome string would start failing instead of recording it.
  outcome      text,

  -- The per-kind payload: a CSP report body, a rate-limit window and ceiling, a
  -- denied capability and reason, a rejected upload's declared versus actual
  -- bytes, a role transition. Genuinely variable by kind, which is why it is
  -- jsonb — see the header's justification.
  --
  -- `not null default '{}'::jsonb` rather than nullable, so a consumer never has
  -- to distinguish "no detail" from "null detail": an emitter that has nothing to
  -- add omits the column and gets an empty object.
  detail       jsonb       not null default '{}'::jsonb,

  -- When. Indexed below, because the nightly retention sweep filters on it.
  created_at   timestamptz not null default timezone('utc', now())
);

-- 2.1 The closed kind vocabulary.
--
-- Exactly the seven emitters in the table above, and no more. Written as
-- drop-then-add rather than inline in the create, so a database whose table
-- predates an edit to this file converges on the current definition —
-- `create table if not exists` skips the whole statement on a second apply and
-- would skip a changed inline constraint with it.
--
-- THE SET IS CLOSED, AND ADDING AN EMITTER IS A MIGRATION. That is the point of
-- the constraint: an unrecognized kind is rejected at write time rather than
-- accumulating as an unswept, unfilterable value that the admin panel silently
-- omits and the retention sweep never ages out. Migration 16's write functions
-- and the three route handlers named above must use these exact strings, and so
-- must the `kind` filter in nextjs/components/cms/AdminUsers.tsx.
alter table public.security_events
  drop constraint if exists security_events_kind_check;
alter table public.security_events
  add constraint security_events_kind_check check (kind in (
    'csp',
    'rate_limited',
    'denied',
    'upload_rejected',
    'media_denied',
    'role_change',
    'revocation'
  ));

-- 2.2 Append-only, and what is deliberately absent.
--
-- NO updated_at and NO trigger, exactly as in section 1.1: a record of something
-- that was refused has no legitimate reason to change afterwards.
--
-- NO ip_address AND NO user_agent COLUMN. This is a decision, not an oversight,
-- and it must not be "fixed" later without a deliberate one: the site's audience
-- includes families, and a school has no need to build a visitor log. Neither
-- column is required by any check this table backs — an admin investigating a
-- denial has the actor, the kind, the path and the detail, and an anonymous
-- CSP report is aggregate data rather than a person.
--
-- NO ALERTING. No trigger, no pg_notify, no webhook url column and no email
-- column. An earlier design promised a weekly digest plus immediate mail on any
-- role change or revocation; it was withdrawn, because delivering that honestly
-- means a mail provider, a stored credential, a send schedule, a retry policy, a
-- recipient configuration and a delivery test — a new outbound dependency for an
-- audience of two accounts who both open the admin UI every time they edit. What
-- ships instead is /admin/users rendering a security-events panel over the
-- trailing 90 days, filterable by kind. If the school later wants mail, the hook
-- is a vercel.json cron calling a route that reads this table.
--
-- RETENTION IS SWEPT BY KIND, nightly, by /api/cleanup/orphans running as the
-- service role: `csp` rows after 30 DAYS, because their only purpose is the
-- Content-Security-Policy report-only rollout window and their volume is
-- unbounded; every other kind after 90 DAYS, matching the window the admin panel
-- shows. That sweep is the one legitimate delete on this table, and it needs no
-- delete policy because the service role bypasses RLS.

-- 2.3 Row level security: enabled here, policies in migration 17.
--
-- `enable` and not `force`, for the reason given in section 1.2.
--
-- Migration 17 owns the `select` policy, and this table is the stricter of the
-- two: reading it requires ADMIN — asked as an admin-only capability such as
-- has_capability('manage_users'), per migration 13, never by subquerying
-- admin_users from a policy — where content_revisions needs only `edit`. An
-- editor can review their own content history; the security log is an admin
-- surface. `anon` reads nothing. Insert is confined to the write functions and
-- route handlers in section 2, and as with content_revisions there must be NO
-- update policy and NO delete policy.
alter table public.security_events enable row level security;

-- 2.4 Indexes.
--
-- Three, and the composite is the considered choice rather than the obvious one.

-- The sweep and the panel, in one index. Retention is per kind — csp at 30 days,
-- everything else at 90 — so the sweep's own predicate is `where kind = $1 and
-- created_at < $2`, equality then range, which is exactly this index. It also
-- serves the admin panel's kind filter over the trailing 90 days.
--
-- A STANDALONE kind INDEX IS THEREFORE NOT CREATED: it would be a redundant
-- btree prefix of this one, so a bare `where kind = $1` already uses this index
-- and a second one would only add insert cost.
create index if not exists security_events_kind_created_at_idx
  on public.security_events (kind, created_at);

-- The all-kinds queries, which the composite above cannot serve because its
-- leading column is kind: the admin panel's unfiltered trailing-90-day view, and
-- any sweep pass that ages rows without naming a kind.
create index if not exists security_events_created_at_idx
  on public.security_events (created_at);

-- Per-actor investigation: every event attributed to one account, which is the
-- first question asked after a suspected compromise or a revocation.
create index if not exists security_events_actor_id_idx
  on public.security_events (actor_id);

-- 2.5 Comments.

comment on table public.security_events is
  'Append-only, admin-readable record of security-relevant outcomes. Written by '
  'seven emitters and no others: csp (/api/csp-report), rate_limited and denied '
  '(migration 16 write functions, which RETURN typed results rather than raising '
  'precisely so the row commits instead of being rolled back with the '
  'transaction), upload_rejected (/api/uploads/finalize), media_denied '
  '(/api/media), and role_change and revocation (set-admin-role, '
  'disable-admin). BOUNDARY: a direct PostgREST call rejected by RLS or a table '
  'grant produces NO ROW HERE, by design -- no function of ours executes on that '
  'path, so nothing can insert one; those rejections live in Supabase''s API and '
  'Postgres logs, and e2e/security.spec.ts asserts both halves. Stores NO ip '
  'address and NO user agent: the audience includes families and a school has no '
  'need for a visitor log. No alerting -- /admin/users renders a panel over the '
  'trailing 90 days instead. Retention is swept nightly by kind: csp at 30 days '
  '(the CSP report-only rollout window), everything else at 90. Migration 17 '
  'grants select to ADMIN only and declares no update and no delete policy.';

comment on column public.security_events.id is
  'Surrogate key, generated at write time. No legacy_ref, for the same reason '
  'as content_revisions.id: there is no source counterpart.';

comment on column public.security_events.actor_id is
  'The auth user responsible, or NULL where the event has no actor by nature -- '
  'a csp report arrives from an anonymous browser, and a media_denied is most '
  'interesting when the caller was not signed in. on delete set null so the log '
  'outlives the account.';

comment on column public.security_events.kind is
  'Closed vocabulary of exactly seven values: csp, rate_limited, denied, '
  'upload_rejected, media_denied, role_change, revocation. ADDING AN EMITTER IS '
  'A MIGRATION -- an unconstrained kind would accumulate values the admin panel '
  'omits and the per-kind retention sweep never ages out. Migration 16 and the '
  'route handlers use these exact strings.';

comment on column public.security_events.request_path is
  'Path of the request that produced the event; null for an rpc write function, '
  'which has none.';

comment on column public.security_events.request_id is
  'Correlation id for the platform log line, where the runtime supplied one.';

comment on column public.security_events.outcome is
  'The emitter''s own short outcome string. Deliberately unconstrained: kind is '
  'the axis this table is queried and swept on, and a second closed vocabulary '
  'would make a new outcome string a write failure rather than a record.';

comment on column public.security_events.detail is
  'Per-kind payload -- a CSP report body, a rate-limit window and ceiling, a '
  'denied capability and reason, a rejected upload''s declared versus actual '
  'bytes, a role transition. jsonb because the shape genuinely differs by kind. '
  'not null default ''{}'' so a consumer never distinguishes absent from null.';

comment on column public.security_events.created_at is
  'When the event was recorded, UTC. Indexed: the nightly retention sweep and '
  'the admin panel both filter on it. No updated_at counterpart -- this table is '
  'append-only.';

