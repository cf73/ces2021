-- =============================================================================
-- Cambridge-Ellis School  ·  migration 13 of 18  ·  admin roles and readiness
-- =============================================================================
-- The authorization foundation. Five objects, and the three functions among them
-- are the most security-sensitive in the schema because migration 17's policies
-- and every write function in migration 16 resolve authority through them:
--
--   public.admin_users              -> membership, role and the revocation flag
--   public.is_active_admin_user()   -> "is the caller an active member?"
--   public.has_capability(text)     -> "may the caller do this specific thing?"
--   public.current_aal()            -> the caller's authenticator assurance level
--   public.site_readiness           -> the cutover gate that lets the site leave
--                                      fallback mode (see section 4)
--
-- These five names are a contract. Migration 16 (write functions), migration 17
-- (rls policies), migration 18 (storage policies) and nextjs/lib/auth.ts all
-- reference them verbatim, as do the capability strings in section 3. Renaming
-- anything here breaks four other files silently, because a policy referencing a
-- missing function fails at query time rather than at create time.
--
-- Ported from resources/users/roles.yaml and the two users/*.yaml accounts.
-- Credentials are NOT ported: both accounts hold bcrypt `$2y$10$` hashes with no
-- plaintext available, Supabase Auth cannot import them, and auth.users is the
-- only account table. This migration carries identity, role and lifecycle state;
-- passwords belong to Supabase Auth and appear nowhere in this schema.
--
-- No user-specified rules were provided for this project — review_rules returns
-- none. Enterprise-standard practice is therefore applied and is not relaxed:
-- every security definer function pins search_path and schema-qualifies its
-- identifiers, no policy is weakened to admit a bootstrap insert, RLS is enabled
-- with no policy written here, and every statement is idempotent so the full
-- eighteen apply twice cleanly.
--
-- PostgreSQL 17, per supabase/config.toml [db] major_version. All SQL lowercase.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. admin_users — membership, role and revocation
-- -----------------------------------------------------------------------------
-- The primary key IS the Supabase Auth user id. There is no surrogate key, and
-- that is the load-bearing design decision on this table rather than a
-- normalization preference: because user_id references auth.users, a membership
-- row CANNOT EXIST BEFORE AN ACCOUNT DOES. The invitation-only lifecycle is
-- therefore enforced by a foreign key rather than by convention, and the
-- question "how does the first admin get in?" has a structural answer instead of
-- a policy loophole.
--
-- How the first rows arrive: tools/src/bootstrap-admins.ts, run once by the
-- operator after the user supplies keys, invites both addresses through the Auth
-- admin API, carries their display names into Auth user metadata, and inserts
-- these rows keyed on the returned uuids. It runs under the service role, which
-- bypasses RLS legitimately. That is the whole bootstrap path. NO policy in this
-- schema grants anon or authenticated an insert on this table, no self-service
-- signup route exists, and public signup is disabled at the project level.
--
-- Seeding from the legacy accounts, for the record and NOT as rows in this file:
--   bekah@cambridge-ellis.org      roles: [editor]  -> 'editor'
--   conrad.fulbrook@gmail.com      super: true      -> 'admin'
-- Neither can be inserted by a migration, because their auth.users rows do not
-- exist until the invitations are accepted. supabase/seed.sql deliberately
-- contains no admin_users rows for the same reason.

create table if not exists public.admin_users (
  -- The auth user id, and the primary key. `on delete cascade` means removing an
  -- Auth account removes its membership in the same statement, so a deleted user
  -- can never leave an orphaned grant of authority behind.
  user_id     uuid        primary key references auth.users (id) on delete cascade,

  -- 'admin' or 'editor', constrained below. The legacy model is inverted —
  -- resources/users/roles.yaml gives `editor` a strictly broader permission set
  -- than `admin` — which is an authoring error rather than an intention, and the
  -- target resolves it as admin superset-of editor. Section 3 is the matrix.
  role        text        not null,

  -- THE revocation flag, and what every authorization check actually reads.
  -- Clearing it removes all capability from the account on its NEXT REQUEST:
  -- nextjs/lib/supabase/session.ts consults is_active_admin_user() on every
  -- proxied request and each write function in migration 16 consults
  -- has_capability() again, so both gates close before the account's existing
  -- access token expires.
  --
  -- This is deliberately NOT an attempt to invalidate an already-issued JWT.
  -- Supabase access tokens are verified statelessly and the Auth admin sign-out
  -- API takes that session's own JWT rather than a user id, so an operator
  -- revoking somebody else's access cannot reach their token. The residual token
  -- stays cryptographically valid for up to its hour and still authenticates as
  -- that user — but it authorizes nothing, because authorization is decided here
  -- on every request. Migration 16's disable_admin additionally bans the user
  -- through the Auth admin API, which stops the refresh-token exchange.
  is_active   boolean     not null default true,

  -- When is_active last became false; null while the account is active. This
  -- column records *when*, and is maintained by the trigger in section 1.3 so it
  -- stays truthful whether the caller supplies it or not. It is never consulted
  -- by an authorization check — that is is_active's job, and conflating the two
  -- is how a revoked account keeps working.
  disabled_at timestamptz,

  -- Who issued the invitation. `on delete set null` so removing an inviter's
  -- account does not remove the invitee's membership.
  invited_by  uuid        references auth.users (id) on delete set null,

  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now())
);

-- 1.1 Constrained vocabulary.
-- Two roles, closed set. Written as drop-then-add rather than inline in the
-- create above so that a database whose table predates an edit to this file
-- converges on the current definition instead of silently keeping the old one —
-- `create table if not exists` skips the whole statement on a second apply, and
-- would skip a changed constraint with it.
alter table public.admin_users
  drop constraint if exists admin_users_role_check;
alter table public.admin_users
  add constraint admin_users_role_check check (role in ('admin', 'editor'));

-- Consistency between the two revocation columns, so the pair cannot contradict
-- itself: an active account has no disabled_at, and an inactive one has one. The
-- trigger in 1.3 maintains this; the constraint is what makes it a guarantee
-- rather than a hope, including against a direct service-role write.
alter table public.admin_users
  drop constraint if exists admin_users_disabled_at_check;
alter table public.admin_users
  add constraint admin_users_disabled_at_check
  check ((is_active and disabled_at is null) or (not is_active and disabled_at is not null));

-- 1.2 The shared updated_at trigger from migration 01.
-- No application code sets updated_at: neither nextjs/lib/actions/* nor the
-- security definer write functions in migration 16 may touch the column, so the
-- timestamp can be neither forged nor forgotten.
drop trigger if exists admin_users_set_updated_at on public.admin_users;
create trigger admin_users_set_updated_at
  before update on public.admin_users
  for each row
  execute function public.set_updated_at();

-- 1.3 disabled_at is derived, not remembered.
-- Migration 16's disable_admin sets is_active and disabled_at together, but
-- relying on that leaves the column truthful only for as long as every future
-- write path remembers to. Deriving it here makes the audit answer to the data.
--
-- Deliberately NOT security definer: this function reads and writes nothing but
-- the row already in flight, so it needs no elevated rights and does not get
-- any. search_path is pinned regardless, per the project rule that every
-- function pins it — an unpinned path is a latent escalation vector even where
-- today's body happens not to resolve a table name.
create or replace function public.admin_users_stamp_disabled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A row invited straight into a disabled state still needs a timestamp.
    if new.is_active then
      new.disabled_at := null;
    elsif new.disabled_at is null then
      new.disabled_at := timezone('utc', now());
    end if;
    return new;
  end if;

  -- Update: only a transition matters. An edit that leaves is_active alone must
  -- not restamp an existing disabled_at, or every unrelated write would rewrite
  -- the revocation history.
  if new.is_active is distinct from old.is_active then
    if new.is_active then
      new.disabled_at := null;
    elsif new.disabled_at is not distinct from old.disabled_at then
      -- The caller did not supply one, so derive it. An explicitly supplied
      -- value is honoured, which is what lets migration 16 record a precise
      -- instant inside its own transaction.
      new.disabled_at := timezone('utc', now());
    end if;
  end if;

  return new;
end;
$$;

comment on function public.admin_users_stamp_disabled_at() is
  'Before insert/update trigger keeping admin_users.disabled_at consistent with '
  'is_active: stamped on deactivation, cleared on reactivation, untouched by '
  'edits that do not change is_active.';

drop trigger if exists admin_users_stamp_disabled_at on public.admin_users;
create trigger admin_users_stamp_disabled_at
  before insert or update on public.admin_users
  for each row
  execute function public.admin_users_stamp_disabled_at();

-- 1.4 Row level security: enabled here, policies in migration 17.
--
-- `enable` and not `force`. Forcing RLS would apply it to the table owner too,
-- which is precisely the role migration 16's security definer write functions
-- and the section 3 helpers below run as — forcing it would break every one of
-- them.
--
-- With RLS enabled and NO policy present, non-owner roles see zero rows and can
-- write nothing. That is the correct default and it is also why the helpers in
-- section 3 must be security definer: authenticated cannot read this table
-- directly, so membership can only be resolved through a function that runs as
-- the owner.
--
-- Migration 17 owns the read policy, which is deliberately narrow: a row is
-- readable only by its own user_id or by an admin. That admin test MUST go
-- through public.is_active_admin_user() rather than a subquery on admin_users,
-- or the policy recurses on the table it is protecting. Migration 17 also owns
-- the table-level grants and the revocation of direct DML from authenticated;
-- this file deliberately does neither, so nobody should read it as having
-- finished that job.
alter table public.admin_users enable row level security;

create index if not exists admin_users_role_idx on public.admin_users (role);
create index if not exists admin_users_is_active_idx on public.admin_users (is_active);

comment on table public.admin_users is
  'Editor and admin membership for the inline editing surface, keyed on the '
  'Supabase Auth user id. Invitation-only: the foreign key to auth.users makes a '
  'membership row impossible before an account exists, and no policy anywhere '
  'grants anon or authenticated an insert. Rows are created by '
  'tools/src/bootstrap-admins.ts and /admin/users under the service role.';

comment on column public.admin_users.user_id is
  'auth.users.id, and the primary key. No surrogate: this is what makes the '
  'invitation-only lifecycle a structural guarantee rather than a convention.';
comment on column public.admin_users.role is
  'admin or editor. admin is a strict superset of editor — see has_capability(). '
  'Resolves the inverted legacy model in resources/users/roles.yaml, where '
  'editor held broader permissions than admin.';
comment on column public.admin_users.is_active is
  'The revocation flag every authorization check reads. Clearing it removes all '
  'capability on the next request, without depending on invalidating an '
  'already-issued stateless JWT.';
comment on column public.admin_users.disabled_at is
  'When is_active last became false; null while active. Maintained by trigger. '
  'Never consulted by an authorization check.';
comment on column public.admin_users.invited_by is
  'The auth user who issued the invitation; nulled if that account is deleted.';


-- -----------------------------------------------------------------------------
-- 2. Why these are functions, and why every one pins search_path
-- -----------------------------------------------------------------------------
-- Two independent reasons, and both are structural rather than stylistic.
--
-- SECURITY DEFINER IS WHAT MAKES THEM WORK AT ALL. Section 1.4 enables RLS on
-- admin_users with no policy, so the `authenticated` role reads zero rows from
-- it. A membership test written as an inline subquery in application code or in
-- a policy would therefore always be false. These functions run as the table
-- owner, which is the only way the check can see the row it needs.
--
-- SECURITY DEFINER IS ALSO WHAT AVOIDS MIGRATION 17'S RECURSION TRAP. The read
-- policy on admin_users has to answer "is the caller an admin?", and answering
-- it with `exists (select 1 from public.admin_users ...)` inside a policy ON
-- admin_users makes the policy recurse on the table it is protecting.
-- Postgres evaluates the inner select under the same policy and the query either
-- errors or silently returns nothing. Routing the test through a security
-- definer function breaks the cycle because the function's own reads are not
-- subject to the policy. Migration 17 must call is_active_admin_user(); it must
-- never subquery admin_users from a policy on admin_users.
--
-- AND THAT IS EXACTLY WHY search_path IS PINNED ON EVERY ONE. A security definer
-- function resolves unqualified names against the CALLER's search_path while
-- running with the OWNER's privileges. A caller who can create a schema on their
-- own path can define their own `admin_users` there, shadow the real table, and
-- have an owner-privileged function read it — a straight privilege escalation.
-- `set search_path = ''` removes the entire resolution path, so every identifier
-- in these bodies is schema-qualified: public.admin_users, auth.uid(),
-- auth.jwt(). (pg_catalog remains implicitly searched even under an empty path,
-- so unqualified built-ins such as coalesce, nullif and exists are unambiguous
-- and cannot be shadowed.)
--
-- All three are `stable`: they read database and session state that cannot change
-- within a statement, which lets the planner evaluate a no-argument call once per
-- query rather than once per row — the difference that keeps migration 17's
-- policies cheap.


-- 2.1 Membership: is the caller an active member of the editing surface?
--
-- SEMANTICS, stated unmistakably because three other migrations depend on this
-- function and the name alone is ambiguous: this returns true for ANY ACTIVE
-- MEMBER — role 'admin' OR role 'editor'. It is the membership gate, not the
-- admin gate. It answers "may this session see the editing surface and read
-- draft content at all", which is what nextjs/lib/supabase/session.ts asks on
-- every proxied request and what migration 17's authenticated read policies ask.
-- The role distinction is has_capability()'s job and belongs nowhere else; a
-- caller wanting "is this specifically an admin" asks
-- has_capability('manage_users') or another admin-only capability, so there is
-- exactly one place where the matrix lives.
--
-- Total and non-raising by construction: auth.uid() returns null for an
-- anonymous caller rather than raising, an equality against null matches no row,
-- and exists() always yields a real boolean — never null. So an anonymous
-- caller gets false, a member whose is_active was cleared gets false on the
-- caller's very next request, and neither path can turn a denial into a 500.
create or replace function public.is_active_admin_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users au
    where au.user_id = auth.uid()
      and au.is_active
  )
$$;

comment on function public.is_active_admin_user() is
  'True when the current auth.uid() has an admin_users row with is_active. Means '
  'ANY ACTIVE MEMBER (admin or editor) — the membership gate, not the admin '
  'gate; use has_capability() for role distinctions. Security definer because '
  'RLS hides admin_users from authenticated, and because migration 17 must not '
  'subquery admin_users from a policy on admin_users. Returns false, never null '
  'and never an error, for anonymous and revoked callers.';


-- 2.2 Capability: may the caller do this specific thing?
--
-- THE CAPABILITY MATRIX. These twelve strings are the project's authorization
-- vocabulary, shared verbatim by the write functions in migration 16, the
-- policies in migration 17, the Storage policies in migration 18 and
-- requireCapability(cap) in nextjs/lib/auth.ts. `upload`, `delete_asset` and
-- `edit` are fixed by the Storage policy table in the technical specification
-- and must not be renamed under any circumstances.
--
--   capability        editor  admin   what it gates
--   ---------------   ------  -----   ----------------------------------------
--   edit             yes     yes     update-text, update-rich-text,
--                                     update-media, update-focal-point,
--                                     update-section, alt text; reading
--                                     content_revisions; media-private access
--   upload            yes     yes     finalize-upload and replace-asset; insert
--                                     into media-quarantine
--   publish           yes     yes     set-published, set-section-enabled
--   create_entry      yes     yes     create-entry AND duplicate-entry (a
--                                     duplicate creates a row, so it needs no
--                                     separate capability)
--   reorder           yes     yes     reorder-entries, reorder-sections
--   restore           yes     yes     restore-revision, restore-change-set
--   delete_entry      no      yes     delete-entry and force-delete-entry
--   delete_asset      no      yes     the whole destructive and organizational
--                                     asset authority: rename-asset,
--                                     retire-asset, restore-asset (recovering
--                                     bytes from media-trash) and asset
--                                     deletion. The name is narrower than the
--                                     authority it gates, deliberately, because
--                                     the Storage policy table fixes the string
--   manage_taxonomy   no      yes     upsert-term, delete-term, force-delete-term
--   manage_globals    no      yes     update-globals, including maintenance mode
--   manage_nav        no      yes     update-nav-tree and reparent-page (page
--                                     hierarchy is navigation authority because
--                                     a reparent rewrites descendant paths)
--   manage_users      no      yes     invite-admin, set-admin-role, disable-admin
--
-- Note the deliberate split on the word "restore": `restore` covers restoring a
-- revision or a change set and BOTH roles hold it, while recovering trashed
-- asset BYTES is admin-only under delete_asset. Those are two different
-- authorities that happen to share a verb.
--
-- `configure asset containers`, which the legacy editor role held
-- (resources/users/roles.yaml:103), HAS NO CAPABILITY HERE AND NONE FOR ANYONE.
-- That is deliberate, not an omission: bucket configuration — size limits, MIME
-- sets, public or private — is operator-owned, living in migration 18 and the
-- README runbook under the operator's service-role credentials. A UI letting an
-- editor widen the MIME allowlist would undo the upload policy it is there to
-- enforce. Do not add one.
--
-- admin superset-of editor BY CONSTRUCTION: the role check constraint in section
-- 1.1 admits only 'admin' and 'editor', so the shared list below is satisfied by
-- either role without testing role at all, and 'admin' additionally satisfies the
-- admin-only list. There is no arrangement of this function in which an editor
-- holds something an admin does not — which is the inversion in the legacy model
-- being structurally ruled out rather than merely corrected.
--
-- FAILS CLOSED. An unrecognized capability string matches neither list, so the
-- whole predicate is false and the answer is NO. A typo in a call site therefore
-- denies the operation rather than permitting it, and a capability added to
-- migration 16 before it is added here is refused rather than silently allowed.
-- Anonymous callers and revoked members are false for the same reasons as 2.1.
--
-- The matrix lives in this function rather than in a role-capability table on
-- purpose. A table would need RLS and policies of its own — migration 17's
-- territory — plus seed rows, and it would put the authorization model on a
-- readable, writable surface. Twelve constants in one owner-privileged function
-- body are auditable in a single screen and cannot be edited by any application
-- role.
create or replace function public.has_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users au
    where au.user_id = auth.uid()
      and au.is_active
      and (
        -- held by editor and admin alike
        p_capability in (
          'edit',
          'upload',
          'publish',
          'create_entry',
          'reorder',
          'restore'
        )
        or (
          -- admin only
          au.role = 'admin'
          and p_capability in (
            'delete_entry',
            'delete_asset',
            'manage_taxonomy',
            'manage_globals',
            'manage_nav',
            'manage_users'
          )
        )
      )
  )
$$;

comment on function public.has_capability(text) is
  'Resolves the capability matrix for the current caller. Shared by editor and '
  'admin: edit, upload, publish, create_entry, reorder, restore. Admin only: '
  'delete_entry, delete_asset, manage_taxonomy, manage_globals, manage_nav, '
  'manage_users. admin is a strict superset of editor by construction. Fails '
  'closed: an unknown capability string, an anonymous caller or a member with '
  'is_active cleared all return false. No capability exists for configuring '
  'asset containers, which is operator-owned.';


-- 2.3 Assurance level: did the caller present a second factor?
--
-- TOTP enrolment is mandatory and every write function in migration 16 requires
-- aal2, so this is consulted on every mutation. Two properties matter more than
-- the one-line body suggests.
--
-- IT NEVER RAISES. A raise here would convert an authorization denial into a
-- 500, losing the typed `denied` result the editor surfaces and the
-- security_events row that records it. auth.jwt() reads request.jwt.claims with
-- missing_ok, so an anonymous caller yields null rather than an error; the
-- explicit exception block additionally contains the one remaining failure mode,
-- a claims payload that is present but not valid json, whose ::jsonb cast inside
-- auth.jwt() would otherwise raise. `when others` is broader than that single
-- case on purpose: this function's only job is to report an assurance level, and
-- there is no failure of it that should be more disruptive than reporting the
-- lowest one.
--
-- IT RETURNS 'aal1', NEVER NULL, when the claim is absent. That choice is
-- load-bearing. With null, `current_aal() = 'aal2'` evaluates to null, and a
-- guard written the natural way — `if not (public.current_aal() = 'aal2') then
-- raise ...` — would NOT fire, because `not null` is null and not true. A
-- missing claim would silently pass the very check meant to stop it. Returning
-- the weakest level keeps every comparison a real boolean, so both the positive
-- and the negated form of the check fail closed. Treating "unknown" as "weakest"
-- is also the honest reading: a caller who presented no second factor has not
-- reached aal2.
create or replace function public.current_aal()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_aal text;
begin
  begin
    v_aal := nullif(auth.jwt() ->> 'aal', '');
  exception
    when others then
      -- A malformed claims payload is an absent assurance level, not an error.
      v_aal := null;
  end;

  return coalesce(v_aal, 'aal1');
end;
$$;

comment on function public.current_aal() is
  'The caller''s authenticator assurance level from the aal jwt claim. Returns '
  '''aal1'' — never null and never an error — for an anonymous caller, a missing '
  'claim or a malformed claims payload, so that both `= ''aal2''` and its '
  'negation stay real booleans and fail closed.';


-- 2.4 Execute privileges: least privilege, stated rather than inherited.
--
-- TWO revokes are required, and the second one is the one that is easy to miss.
-- Verified against the local stack rather than assumed, because the default here
-- is not the plain PostgreSQL default:
--
--   * `create function` grants execute to PUBLIC, and both anon and
--     authenticated are members of PUBLIC. So granting to authenticated alone
--     would change nothing at all.
--   * Supabase additionally ships `alter default privileges in schema public
--     grant execute on functions to postgres, anon, authenticated,
--     service_role`. That is a DIRECT grant to the anon role, recorded in the
--     function's acl as `anon=X/postgres` — and a `revoke ... from public`
--     CANNOT remove it, because PUBLIC and anon are different grantees.
--
-- Revoking only from PUBLIC therefore leaves anon holding execute on all three
-- of these functions while looking, in the migration, as though it does not.
-- Both revokes are present below for that reason, and both are idempotent so a
-- second apply is clean. The `from public` revoke is not redundant: it is what
-- holds the line on any database that does not carry Supabase's default
-- privileges, where PUBLIC rather than anon is the grantee.
--
-- anon is deliberately EXCLUDED from all three. The only privileged read on the
-- anonymous path in this schema is get_maintenance_state() in migration 16;
-- anonymous visitors are served entirely by `published = true` predicates and
-- need no membership, capability or assurance test. This is a HARD CONSTRAINT ON
-- MIGRATION 17: an anon policy that referenced one of these functions would fail
-- with permission denied at query time for every anonymous visitor. The
-- specified anon policies (published = true, nav_items.visible,
-- site_globals.public) do not reference them, so the constraint holds.
--
-- service_role is included because it is privilege-checked for execute like any
-- other role despite bypassing RLS, and the migration tooling runs as it.
revoke execute on function public.is_active_admin_user() from public;
revoke execute on function public.has_capability(text) from public;
revoke execute on function public.current_aal() from public;

revoke execute on function public.is_active_admin_user() from anon;
revoke execute on function public.has_capability(text) from anon;
revoke execute on function public.current_aal() from anon;

grant execute on function public.is_active_admin_user() to authenticated, service_role;
grant execute on function public.has_capability(text) to authenticated, service_role;
grant execute on function public.current_aal() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. site_readiness — the one row that lets the site leave fallback mode
-- -----------------------------------------------------------------------------
-- WHY THIS TABLE LIVES IN THIS MIGRATION. The readiness gate needs a home, the
-- migration set is exactly eighteen files, and this is the natural one: the
-- gate's final condition is "at least one active admin exists", which is a fact
-- about the table created in section 1. Without this row the gate cannot
-- function and the site can never leave fallback mode, so it is not optional.
--
-- WHY THE GATE IS NOT A PRESENCE CHECK — the design point to preserve. The user
-- supplies Supabase keys after project completion, and those keys can arrive
-- BEFORE the schema is pushed, before the seed is loaded, before admins are
-- bootstrapped and before assets are uploaded. So "use Supabase if the url and
-- key exist" would flip a working, fallback-rendered site onto an empty
-- database. A row count is no better: content_routes becomes non-empty partway
-- through the seed load, so a count crosses zero long before the data is
-- coherent. The switch is therefore TWO things that must both hold — an explicit
-- CONTENT_SOURCE environment variable, which DEFAULTS TO `fallback`, and this
-- row.
--
-- WHO WRITES IT. tools/src/verify-parity.ts --write-readiness, and only after
-- every gate below passes. It is the last step of the cutover runbook: after the
-- schema push, after the seed load, after tools/src/bootstrap-admins.ts, after
-- tools/src/upload-assets.ts, after the informative alt text is authored, and
-- after the eTapestry donation is verified over https on a preview deployment.
-- Nothing else writes it; no migration seeds it, because at migration time not
-- one of those conditions can be true.
--
-- WHO READS IT, AND HOW IT FAILS. nextjs/lib/content/source.ts reads it on first
-- use of the Supabase backend. If the row is ABSENT, or if its schema_version
-- does not match the version the running build expects, the adapter FALLS BACK
-- TO THE COMMITTED JSON AND LOGS A WARNING — it does not throw and it does not
-- serve an empty page. That is the difference between a partially-migrated
-- database being a non-event and being an outage.
--
-- Each column below is one gate condition, so a half-passed gate is impossible
-- to express. The partial states this defends against are explicitly tested:
-- schema without seed, seed without assets, and assets without an admin — in
-- each case the row is absent, and each case is a test in the suite rather than
-- a hypothetical.

create table if not exists public.site_readiness (
  -- Singleton. Fixed at 1 by the check in 3.1, so `insert ... on conflict (id)`
  -- is the natural upsert and there is never ambiguity about which row the
  -- adapter read.
  id                     integer     primary key default 1,

  -- The schema version this database was verified at, compared as a string
  -- against the constant the running build carries. Convention: the timestamp
  -- prefix of the highest migration in the set — '20260901121800' for the
  -- eighteen as they stand — so it advances on its own whenever the schema does
  -- and a build deployed against an older schema declines to use it.
  schema_version         text        not null,

  -- Gate: every migration in the set is applied. Constrained to at least the
  -- eighteen this schema requires; a nineteenth would only raise it.
  migrations_applied     integer     not null,

  -- Gate: the content loaded came from the source tree that was actually
  -- migrated. The sha256 recorded in artifacts/migration-source-manifest.json,
  -- which pins the extraction to a specific source commit.
  source_manifest_sha256 text        not null,

  -- Gate: every content path resolves. 142 at cutover — commented, not frozen;
  -- see 3.1.
  route_count            integer     not null,

  -- Gate: all three asset classes are uploaded. 110 deployed, 24 draft-only and
  -- 155 archived at cutover, totalling the 289 legacy binaries.
  assets_deployed_count  integer     not null,
  assets_draft_count     integer     not null,
  assets_archived_count  integer     not null,

  -- Gate: somebody can actually administer the site. At least one row in
  -- admin_users with role 'admin' and is_active — which is why this table
  -- belongs in this migration.
  active_admin_count     integer     not null,

  -- The parity run's genuinely variable diagnostics and nothing else: the
  -- integrity sections whose shape depends on what the corpus turned out to
  -- contain — stale parent references, the dangling announcement link, the
  -- classroom-relation union, over-length grandfathered values. Every value that
  -- has a name is a typed column above; this is the remainder, kept tight and
  -- constrained to an object in 3.1.
  detail                 jsonb       not null default '{}'::jsonb,

  -- When the gate last passed, which is the question an operator asks. Distinct
  -- from updated_at, which is row bookkeeping maintained by trigger, and from
  -- created_at, which records when readiness was first ever reached. The admin
  -- shell surfaces this so nobody mistakes a stale snapshot for a live one.
  written_at             timestamptz not null default timezone('utc', now()),

  created_at             timestamptz not null default timezone('utc', now()),
  updated_at             timestamptz not null default timezone('utc', now())
);

-- 3.1 Constraints.
--
-- Singleton enforced on both approaches to a second row: an insert that omits id
-- takes the default of 1 and collides on the primary key, and an insert that
-- names any other id fails this check. Neither path can leave two rows behind for
-- the adapter to choose between.
alter table public.site_readiness
  drop constraint if exists site_readiness_singleton_check;
alter table public.site_readiness
  add constraint site_readiness_singleton_check check (id = 1);

-- These are INVARIANTS, deliberately not a frozen snapshot of the cutover
-- numbers. Baking `route_count = 142` in would abort a legitimate re-run of
-- verify-parity the first time the school adds a page — turning a routine
-- verification into a failure and stranding the site in fallback mode. What is
-- genuinely invariant is asserted; the expected cutover values are documented
-- above and asserted by verify-parity, which is the right place for a
-- point-in-time expectation.
alter table public.site_readiness
  drop constraint if exists site_readiness_schema_version_check;
alter table public.site_readiness
  add constraint site_readiness_schema_version_check
  check (length(btrim(schema_version)) > 0);

alter table public.site_readiness
  drop constraint if exists site_readiness_migrations_applied_check;
alter table public.site_readiness
  add constraint site_readiness_migrations_applied_check
  check (migrations_applied >= 18);

-- Lower-case hex sha256, exactly 64 characters. A truncated or placeholder
-- checksum is a broken provenance claim, and a broken provenance claim is worse
-- than an absent row: the row is what tells the adapter to trust the database.
alter table public.site_readiness
  drop constraint if exists site_readiness_source_manifest_sha256_check;
alter table public.site_readiness
  add constraint site_readiness_source_manifest_sha256_check
  check (source_manifest_sha256 ~ '^[0-9a-f]{64}$');

-- A site with no routes is not ready, whatever else passed.
alter table public.site_readiness
  drop constraint if exists site_readiness_route_count_check;
alter table public.site_readiness
  add constraint site_readiness_route_count_check check (route_count >= 1);

-- Asset classes may legitimately reach zero as the corpus changes — an empty
-- archive is a valid future state — so these are floors, not expectations.
alter table public.site_readiness
  drop constraint if exists site_readiness_asset_counts_check;
alter table public.site_readiness
  add constraint site_readiness_asset_counts_check
  check (
    assets_deployed_count >= 0
    and assets_draft_count >= 0
    and assets_archived_count >= 0
  );

-- The gate's last condition, as a constraint rather than a convention: readiness
-- cannot be recorded for a site nobody can administer.
alter table public.site_readiness
  drop constraint if exists site_readiness_active_admin_count_check;
alter table public.site_readiness
  add constraint site_readiness_active_admin_count_check
  check (active_admin_count >= 1);

-- `detail` is a bag of diagnostics, so it must be a bag: a bare scalar or array
-- would break every reader that treats it as one.
alter table public.site_readiness
  drop constraint if exists site_readiness_detail_object_check;
alter table public.site_readiness
  add constraint site_readiness_detail_object_check
  check (jsonb_typeof(detail) = 'object');

-- 3.2 The shared updated_at trigger from migration 01.
drop trigger if exists site_readiness_set_updated_at on public.site_readiness;
create trigger site_readiness_set_updated_at
  before update on public.site_readiness
  for each row
  execute function public.set_updated_at();

-- 3.3 Row level security: enabled, no policy.
-- Migration 17 decides who may read this row. The adapter reads it server-side
-- and there is no reason for anon to see the schema version, the source
-- checksum or the corpus counts, so RLS-on-with-no-policy is the correct state
-- to leave it in — closed by default, opened deliberately and elsewhere.
alter table public.site_readiness enable row level security;

comment on table public.site_readiness is
  'Single-row cutover gate. Its presence, plus CONTENT_SOURCE=supabase, is the '
  'ONLY thing that makes the Supabase content backend active; without it '
  'nextjs/lib/content/source.ts serves the committed fallback JSON. Written by '
  'tools/src/verify-parity.ts --write-readiness as the last step of the cutover '
  'runbook, after the schema push, seed load, admin bootstrap, asset upload, alt '
  'text authoring and the eTapestry verification. Absent or version-mismatched '
  'means fall back with a logged warning, never throw.';

comment on column public.site_readiness.id is
  'Always 1. Singleton enforced by the primary key and a check, so there is never '
  'ambiguity about which row the adapter read.';
comment on column public.site_readiness.schema_version is
  'Schema version verified, compared as a string against the running build''s '
  'expected constant. Convention: the timestamp prefix of the highest migration.';
comment on column public.site_readiness.migrations_applied is
  'Gate: count of applied migrations, at least the 18 this schema requires.';
comment on column public.site_readiness.source_manifest_sha256 is
  'Gate: sha256 from artifacts/migration-source-manifest.json, pinning the load '
  'to the source commit that was actually migrated.';
comment on column public.site_readiness.route_count is
  'Gate: resolving content paths. 142 at cutover; not frozen, because the school '
  'will add pages.';
comment on column public.site_readiness.assets_deployed_count is
  'Gate: objects in the public media bucket. 110 at cutover.';
comment on column public.site_readiness.assets_draft_count is
  'Gate: draft-only objects in media-private. 24 at cutover.';
comment on column public.site_readiness.assets_archived_count is
  'Gate: archived objects under the media-private archive prefix. 155 at cutover.';
comment on column public.site_readiness.active_admin_count is
  'Gate: active admin_users rows with role admin. Must be at least 1 — readiness '
  'cannot be recorded for a site nobody can administer.';
comment on column public.site_readiness.detail is
  'The parity run''s variable diagnostics only — the integrity sections whose '
  'shape depends on the corpus. Never a value that has a name; those are typed '
  'columns.';
comment on column public.site_readiness.written_at is
  'When the gate last passed. Distinct from updated_at (row bookkeeping) and '
  'created_at (first ever readiness).';


-- -----------------------------------------------------------------------------
-- 4. Deliberately absent from this file
-- -----------------------------------------------------------------------------
-- Stated so that a later reader does not mistake an intentional boundary for an
-- oversight and fill it in.
--
--   No policy of any kind. Migration 17 owns every policy, the table-level
--   grants, and the revocation of direct DML from `authenticated`. In
--   particular there is NO INSERT POLICY ON admin_users FOR anon OR
--   authenticated, here or anywhere — the named correction of a reference
--   implementation that shipped `create policy ... to anon, authenticated with
--   check (true)`. Nor is there any `to authenticated using (true)`.
--
--   No set_admin_role and no disable_admin. Those are migration 16's, together
--   with the invariants they must carry: at least one is_active admin must
--   always remain, and an admin may neither disable nor demote themselves.
--
--   No password column, no hash column, no credential of any kind. Supabase Auth
--   owns credentials; the legacy bcrypt hashes are unimportable and are not
--   reproduced.
--
--   No admin_users rows. They cannot exist before their auth.users rows do. This
--   file creates the table the bootstrap writes into, and nothing more.
--
--   No capability for configuring asset containers — see section 2.2.
--
--   No nineteenth migration file: site_readiness is resolved here, in section 3.
-- =============================================================================

