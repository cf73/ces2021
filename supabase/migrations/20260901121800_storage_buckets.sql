-- =============================================================================
-- Cambridge-Ellis School  ·  migration 18 of 18  ·  Storage
-- =============================================================================
-- The three Storage buckets, the fourteen policies on storage.objects, and the
-- media-trash/ prefix. Nothing else: no table, no column, no index, no view, no
-- function, no trigger and no seed row. This is the last file in the set.
--
-- It sits at 18 because its policies call public.has_capability() from
-- migration 13, and because its bucket ids must match the check constraint
-- migration 02 already put on public.assets:
--
--   assets_bucket_check check (bucket in ('media','media-private',
--                                        'media-quarantine'))
--                                        [migration 02:149-151]
--
-- so the three ids below are FIXED BY AN EXISTING CONSTRAINT rather than chosen
-- here. Renaming one would make every assets row unwritable.
--
-- This file is the SOLE owner of Storage in the schema. Verified by grepping
-- storage.buckets and storage.objects across migrations 01 to 17: the only
-- occurrence is migration 17:180-182 saying it deliberately creates none.
-- supabase/config.toml likewise declares no bucket -- its
-- [storage.buckets.*] block is the CLI's commented-out template -- so bucket
-- `public`, `file_size_limit` and `allowed_mime_types` are owned here and are
-- not duplicated anywhere.
--
--
-- WHAT IS BEING STORED -- 289 binaries, 362,904,172 bytes, three classes
--
--   class        count  bytes        bucket after keys
--   ----------   -----  -----------  ------------------------------------------
--   deployed       110  122,715,298  media          (public)
--   draft-only      24   19,168,929  media-private
--   archived       155  221,019,945  media-private, under an archive/ prefix
--   ----------   -----  -----------
--   total          289  362,904,172
--
-- The deployed class is the 109 binaries referenced by published entries plus
-- the template-referenced logo. So on day one 110 objects are public and 179
-- are private.
--
-- Seven of the archived 155 are ALSO copied into nextjs/public/assets/ as
-- URL-preserving static aliases, because an unreferenced document may still be
-- in circulation on a handout or from the family portal. Those aliases are
-- STATIC FILES, NOT STORAGE OBJECTS -- deliberately outside the bucket model,
-- because their whole purpose is to resolve with no keys, no signature and no
-- reference count. Nothing in this file addresses them.
--
--
-- THE SINGLE VISIBILITY PREDICATE -- STATED IN MIGRATION 16, NOT HERE
--
--   An asset belongs in the public `media` bucket if and only if
--   published_reference_count(asset_id) > 0. At zero it belongs in
--   media-private.
--
-- public.published_reference_count(uuid) and public.ces_required_bucket(uuid)
-- are migration 16:1431-1519. THIS FILE ENCODES NO SECOND RULE. The migration's
-- own three-way classification above is that same predicate evaluated once at
-- seed time, which is why the counts come out 110 public and 179 private rather
-- than from a rule of their own. A policy here that recomputed visibility would
-- be a second, drifting copy of an existing decision -- and would run the
-- eleven-source count once per row.
--
-- Consequently NO POLICY BELOW LOOKS AT public.assets AT ALL. Bucket membership
-- is decided by the five operations that recompute it -- finalize, publish,
-- unpublish, replace, delete -- each of which asks ces_required_bucket() and
-- then performs a copy, a verification and only then a delete. What a policy
-- here decides is narrower and is the only thing RLS can honestly decide: WHO
-- may touch an object in WHICH bucket.
--
--
-- THE TRUSTED-INGESTION SPLIT -- WHY allowed_mime_types IS UNSET ON TWO OF THE
-- THREE BUCKETS. This is the whole design of this file.
--
-- The legacy container declared NO restriction of any kind:
-- content/assets/assets.yaml is exactly two lines, `title: Assets` and
-- `disk: assets`. Staff USED that freedom, and requirement 12 protects what
-- they used. The 289 stored binaries by extension:
--
--   220 .jpg   28 .png   26 .jpeg   4 .zip   3 .heic
--     2 .pdf    2 .js     2 .css    1 .svg   1 .docx
--
-- So HEIC, JS, CSS and SVG objects exist that the editor MIME set deliberately
-- excludes. The resolution is a SPLIT, not a reconciliation:
--
--   * MIGRATION INGESTION IS A SEPARATE, TRUSTED PATH. tools/src/upload-assets.ts
--     runs under the service role, which bypasses row level security, straight
--     into `media` and `media-private`. Those two buckets therefore leave
--     allowed_mime_types UNSET, so all 289 objects are preserved byte-for-byte.
--     A restrictive list on either one would reject the migration load itself --
--     bucket MIME checking happens in the Storage API and applies to the service
--     role too, so bypassing RLS does not bypass this.
--   * EDITOR UPLOADS ARE NARROW, AND THE RESTRICTION LIVES ON media-quarantine.
--     Every editor upload lands there first and is admitted only if its declared
--     type is one of the seven in section 1.3. NO BUCKET POLICY IS WEAKENED FOR
--     EDITOR UPLOADS TO ACCOMMODATE ANY LEGACY FILE.
--
-- Disposition of every non-image extension is already decided and is not
-- reopened here: the 2 PDFs, 4 ZIPs and 1 DOCX are archived, because nothing
-- references them -- a search of every tracked file outside public/assets/ finds
-- zero occurrences of any .pdf, .zip or .docx path. The 3 HEIC files are
-- archived and flagged for conversion if the school wants them published. The
-- 2 JS, 2 CSS and 1 SVG are archived as historical artifacts and are never
-- served. SVG IS REFUSED OUTRIGHT FOR EDITOR UPLOADS BECAUSE IT IS A SCRIPT
-- VECTOR, and next.config.ts keeps dangerouslyAllowSVG off for the same reason.
--
--
-- THE CEILINGS, AND WHICH ONE THIS FILE ACTUALLY ENFORCES
--
--   limit                        value          enforced by
--   --------------------------   ------------   ---------------------------------
--   image bytes                  15 MB          lib/upload-limits.ts, the sign
--                                               route, finalize -- NOT a bucket
--   image pixels                 50 MP, and     finalize, with sharp
--                                12,000 px/edge
--   image MIME set               4 types        this file, on media-quarantine
--   document bytes               25 MB          this file, as file_size_limit
--   document MIME set            3 types        this file, on media-quarantine
--   archive inspection           depth <= 2,    finalize
--                                <= 500 members,
--                                <= 200 MB uncompressed,
--                                no absolute or .. member paths
--   signed private read URL      15 minutes     app/api/media/[...path]
--   quarantine reservation       1 hour         assets.reservation_expires_at
--                                               [migration 02] + the guarded
--                                               sweep
--
-- THE 15 MB IMAGE CEILING IS NOT A BUCKET LIMIT AND MUST NOT BE READ AS ONE.
-- media-quarantine receives BOTH images and documents, so its file_size_limit
-- has to be the larger of the two ceilings or every legitimate document upload
-- would be rejected. The per-type distinction is made upstream, against the
-- DECLARED MIME TYPE, by lib/upload-limits.ts and the sign route, and again by
-- finalize once the real bytes are readable. A bucket cannot make that
-- distinction: it sees one size limit for all types.
--
-- Both ceilings are set above the largest object of their kind already in the
-- corpus, so re-uploading existing material can never be rejected:
-- public/assets/open-house-website-banner.jpg is 10,619,043 bytes and
-- Photos-(4).zip is 6,962,762 bytes.
--
-- supabase/config.toml's [storage] file_size_limit is the GLOBAL cap and every
-- per-bucket limit must sit at or below it. Verified against the committed file:
-- it is "50MiB" (config.toml:117), comfortably above the 25 MiB set here.
--
--
-- GENERAL FILES ARE IN SCOPE FOR EDITORS, AND CONTENT SCANNING IS NOT
--
-- Documents are admitted deliberately, not by oversight: the legacy container
-- accepted any file and removing that capability would breach requirement 12.
-- They take the same signed path under the document ceiling, skip image
-- inspection in favour of magic-byte and extension agreement, and are served
-- with content-disposition: attachment.
--
-- WHAT IS NOT IN SCOPE IS CONTENT SCANNING, and the gap is named rather than
-- papered over: magic-byte agreement does NOT detect a PDF with embedded
-- JavaScript or a malicious Office macro, and no scanning vendor is selected.
-- What ships instead is the archive-bomb limits above, attachment disposition, a
-- CSP that gives an attachment no script rights on our origin, and an explicit
-- note in README.md that accepting staff-uploaded documents is a SCHOOL-APPROVED
-- RISK. Executables, SVG and HTML are refused outright for editor uploads.
--
--
-- BYTE HISTORY IS APPLICATION-OWNED, BECAUSE THE PROVIDER OFFERS NO VERSIONING
--
-- Supabase Storage has no S3-style object versioning, and a deleted object is
-- gone. An earlier draft of the design assumed otherwise; that assumption is
-- WITHDRAWN, and nothing here relies on it. storage.buckets in this Storage
-- version does carry a versioning_status column, and it is left at its default
-- of 'DISABLED' -- not set, not enabled, and not depended on.
--
-- Byte history is therefore ours to keep. Replacing or deleting an asset copies
-- the outgoing bytes to
--
--   media-trash/<asset_id>/<iso-timestamp>/<filename>
--
-- inside media-private BEFORE the new bytes land, records the move in the
-- change set, and exposes restore-asset to admins. RETENTION IS 90 DAYS, swept
-- by app/api/cleanup/orphans. Two differences from the Git-backed history this
-- replaces are stated rather than glossed: Git retained prior bytes
-- indefinitely where the trash expires at 90 days, and Git history survives the
-- database where content_revisions does not. Whole-database rollback rests on
-- point-in-time recovery or the pg_dump fallback, not on this prefix.
--
-- media-trash IS A PREFIX, NOT A BUCKET. There are exactly three buckets. A
-- fourth would need its own policy set, its own limits and its own entry in
-- migration 02's check constraint, and would buy nothing: the prefix already
-- carries a distinct policy family (section 4) that no editor can satisfy.
--
--
-- PRIVATE OBJECTS ARE NEVER SERVED THROUGH THE IMAGE OPTIMIZER
--
-- This is why media-private has NO anon policy at all, and why a design built on
-- signed URLs would be wrong. A signed Supabase URL handed to next/image
-- produces a durable, cacheable, UNAUTHENTICATED /_next/image URL, and the
-- optimizer's cache OUTLIVES THE SIGNATURE -- so a draft photograph would become
-- permanently public, which is the exact disclosure the draft-only class exists
-- to prevent. Private media is delivered exclusively through
-- app/api/media/[...path]/route.ts: same-origin, session-checked,
-- Cache-Control: private, no-store, streamed server-side, rendered unoptimized.
--
-- createSignedUploadUrl HAS NO CONFIGURABLE EXPIRY. The provider's own lifetime
-- applies and no promise is made about it here. What is bounded is the
-- RESERVATION: assets.reservation_expires_at, one hour, from migration 02 -- and
-- that is what the guarded cleanup sweep reads.
--
--
-- BUCKET CONFIGURATION IS OPERATOR-OWNED, AND THAT IS ENFORCED HERE
--
-- The legacy Control Panel let the editor role `configure asset containers`
-- (resources/users/roles.yaml:103). That is THE ONE Control Panel capability
-- with no target equivalent FOR ANYONE, and its removal is a recorded decision
-- rather than an oversight -- migration 13:367-373 says so from the capability
-- matrix's side, and there is deliberately no capability string for it.
--
-- The target equivalent is this file plus the README runbook, under the
-- operator's service-role credentials. A UI that let an editor widen the MIME
-- allowlist would undo the upload policy the allowlist exists to enforce.
--
-- AND THE DATABASE ENFORCES IT, not just the absence of a screen: row level
-- security is enabled on storage.buckets and THIS FILE CREATES NO POLICY ON IT.
-- Table-level grants there are wide open to anon and authenticated by Supabase
-- default, so RLS with zero policies is the only thing standing between an
-- authenticated caller and the MIME allowlist -- and it is sufficient. Neither
-- anon nor authenticated can read or write a single bucket row; only the service
-- role, which bypasses RLS, can. Do not add a policy on storage.buckets.
--
-- What staff keep is everything they actually used -- browsing, uploading,
-- replacing, renaming, retiring, alt text and focal point -- through
-- components/cms/AssetLibrary.tsx.
--
--
-- THE NAMING SCHEME: <bucket>_<role>_<operation>_<qualifier>
--
-- Migration 17's scheme with the bucket standing in for the table, since the
-- table is always storage.objects. Applied to all fourteen policies without
-- exception, so that
--
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--    order by policyname;
--
-- reads as the access matrix itself. <role> is the single role in the policy's
-- `to` clause -- anon or authenticated, never both -- so one row of that output
-- is one decision about one role. <qualifier> is the capability the predicate
-- requires: `public` for the unconditional public read, `upload`, `edit`,
-- `delete_asset`, and `admin` on the trash family, where `admin` names
-- has_capability('delete_asset') because that capability is admin-only by
-- construction in migration 13.
--
-- THE ACCESS MATRIX, which sections 2 to 5 implement row for row:
--
--   bucket / prefix     anon      authenticated
--   -----------------   -------   -----------------------------------------
--   media               select    select; insert+update need `upload`;
--                                 delete needs `delete_asset`
--   media-private       NONE      select+insert+update+delete need `edit`,
--                                 excluding the media-trash/ prefix
--   media-trash/        NONE      select+insert+update+delete need
--    (in media-private)           `delete_asset` -- admin only
--   media-quarantine    NONE      insert needs `upload`. NO select, NO
--                                 update, NO delete for any client
--
-- NOT ONE POLICY IS `using (true)`, and not one grants a write to "any
-- authenticated user". Every write predicate names a capability, and an
-- authenticated caller with no admin_users row satisfies none of them.
--
--
-- WHAT THE TRASH PARTITION DOES AND DOES NOT GUARANTEE -- MEASURED, NOT ASSUMED
--
-- An earlier draft of this file claimed, on the update policies, that "both
-- clauses carry the prefix test, so an object cannot be renamed across the trash
-- boundary". TESTING DISPROVED IT FOR ONE ACTOR, and the claim is corrected here
-- rather than left to mislead the next reader.
--
-- POSTGRES EVALUATES `using` AND `with check` INDEPENDENTLY, EACH ORed ACROSS ALL
-- APPLICABLE PERMISSIVE POLICIES. They are not matched pairs. So on an update, a
-- caller may satisfy `using` from one policy family and `with check` from
-- another:
--
--   admin renames media-trash/... -> restored.jpg
--     using      satisfied by section 4 (old name IS trash, has delete_asset)
--     with check satisfied by section 3 (new name is NOT trash, has edit)
--     -> ALLOWED
--
-- An admin can therefore move an object across the boundary in either
-- direction, because an admin holds both `edit` and `delete_asset` and so
-- qualifies under both families. This is NOT fixable with a restrictive policy:
-- `with check` sees only the new row and `using` only the old, so "trash-ness
-- unchanged" is not expressible in RLS at all. It would take a trigger on
-- storage.objects, which this file must not add.
--
-- WHAT DOES HOLD, and it is the property that matters -- EDITOR CONTAINMENT IS
-- ABSOLUTE. A caller holding `edit` but not `delete_asset`:
--
--   * cannot read any trash object            (section 3 excludes the prefix)
--   * cannot insert into the prefix           (refused, SQLSTATE 42501)
--   * cannot rename an object INTO the prefix (refused, 42501 -- `with check`)
--   * cannot rename an object OUT of it       (no `using` match, zero rows)
--   * cannot update or delete a trash object  (no `using` match, zero rows)
--
-- All five verified against the local stack as real sessions. So "the trash
-- prefix is admin-only in effect" is true as stated. What is bounded differently
-- is an ADMIN addressing Storage directly: crossing the boundary in place is
-- within the authority `delete_asset` already gates -- the capability that covers
-- rename-asset, retire-asset and restore-asset -- and it is not a privilege
-- escalation. It is simply outside the command set: restore-asset copies bytes
-- back and records the move in a change set, and an in-place rename leaves no
-- such record.
--
--
-- AAL2 IS DELIBERATELY NOT TESTED HERE, WHICH DIFFERS FROM MIGRATION 17
--
-- Migration 17's content policies read `is_active_admin_user() and current_aal()
-- = 'aal2'`. These Storage policies test capability ALONE, because the
-- specification's Storage matrix is written in capabilities and names
-- has_capability() as the instrument. The difference is recorded rather than
-- left to be discovered.
--
-- It is a narrow boundary, not a hole. Every real mutation path runs through
-- /api/uploads/* and migration 16's write functions, and THOSE require aal2 on
-- every call. A member at aal1 addressing Storage directly could put bytes in
-- quarantine and nothing more: finalize would refuse them, so they would never
-- acquire a visibility, never be referenced, and be removed by the guarded sweep
-- as an orphan, with the durable reservation quota bounding the volume
-- meanwhile. A caller with no active membership holds no capability at all and
-- is refused outright.
--
--
-- ANON MUST NOT MEET has_capability() -- A HARD CONSTRAINT, NOT A STYLE CHOICE
--
-- Migration 13:530-540 revokes execute on has_capability(), is_active_admin_user()
-- and current_aal() from PUBLIC and, separately, from `anon` -- separately
-- because Supabase's default privileges make anon a DIRECT grantee, so a revoke
-- from PUBLIC alone would leave it holding execute while appearing not to.
--
-- So an anon policy that called has_capability() would fail with `permission
-- denied for function` AT QUERY TIME, FOR EVERY ANONYMOUS VISITOR -- not at
-- migration time, where it would have been caught. The public read in section
-- 2.1 is therefore a bare bucket_id comparison and calls no function at all.
-- That is also all it needs to be: `media` is a public bucket and the anonymous
-- read is the entire point of it.
--
--
-- IDEMPOTENCY. `create policy` has no `if not exists` form, so EVERY create
-- below is preceded by `drop policy if exists`. Without that guard the second
-- apply of the eighteen fails outright. The bucket rows use
-- `on conflict (id) do update` rather than `do nothing`, deliberately: see 1.0.
-- Applying all eighteen twice is clean, and `supabase db reset` run twice
-- yields identical storage.buckets and pg_policies output.
--
-- NO security definer function and no pinned search_path anywhere in this file,
-- because it adds no function at all -- it calls migration 13's, which is
-- security definer with `set search_path = ''` as every function in this schema
-- is.
--
-- No user-specified rules were provided for this project -- review_rules
-- returns none. Enterprise-standard practice is applied and not relaxed: least
-- privilege on every grant with a named capability behind every write, no
-- "any authenticated user" shortcut, full idempotency, and every non-obvious
-- decision documented in the database itself with `comment on policy`.
--
-- PostgreSQL 17, per supabase/config.toml [db] major_version. All SQL
-- lowercase. Section 6 carries the queries that verify each claim above.
-- =============================================================================


-- =============================================================================
-- 1. The three buckets
-- =============================================================================
-- 1.0 Why `on conflict (id) do update` and not `do nothing`.
--
-- These limits are a security control, so a re-apply must CONVERGE the database
-- onto the values declared here. With `do nothing`, a bucket hand-edited in the
-- Supabase dashboard -- an allowlist widened to unblock one upload, a size limit
-- raised once -- would survive every subsequent `supabase db push` silently, and
-- the migration would keep asserting a policy the database no longer had. With
-- `do update` the file is the source of truth on every apply, and drift is
-- corrected rather than preserved.
--
-- The three columns that matter are reasserted and nothing else is touched:
-- `type` stays at its 'STANDARD' default and `versioning_status` at 'DISABLED',
-- neither being set here nor relied on anywhere.
--
-- The ids are not free choices -- migration 02:149-151 already constrains
-- public.assets.bucket to exactly these three strings.

-- 1.1 media -- public, 110 objects on day one.
--
-- public = true is what makes an anonymous visitor able to fetch a photograph
-- without a signature, and it is the bucket next/image is pointed at through the
-- narrowly-scoped remotePatterns in next.config.ts.
--
-- file_size_limit is the DOCUMENT ceiling, 25 MiB, not the 15 MB image ceiling,
-- and the reason is a promote path rather than a preference: the visibility
-- predicate moves ANY asset with a published reference into this bucket, and
-- documents are in scope for editors. A 15 MB cap here would reject the
-- copy-and-verify promotion of a legitimately published document larger than
-- that -- a latent break, for no benefit, since the per-type ceiling is already
-- enforced against the declared MIME type at sign time and again at finalize.
--
-- allowed_mime_types is UNSET. tools/src/upload-assets.ts writes the deployed
-- class here under the service role, and that class is 220 jpg / 28 png /
-- 26 jpeg among others; more to the point, the promote path can move any
-- admitted type into this bucket later. A list here would reject those writes at
-- the Storage API, which checks MIME for the service role too.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 26214400, null)
on conflict (id) do update
   set name               = excluded.name,
       public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- 1.2 media-private -- not public, 179 objects on day one.
--
-- Holds two populations and one prefix: the 24 draft-only binaries, the 155
-- archived ones under an archive/ prefix, and the media-trash/ prefix that
-- carries byte history. public = false, so there is no unauthenticated URL for
-- any of them and no anon policy in section 3 to reach them either.
--
-- allowed_mime_types is UNSET, and here that is what preserves the corpus
-- byte-for-byte. The archived class is precisely where the 3 HEIC, 2 JS, 2 CSS
-- and 1 SVG objects land -- every extension the editor MIME set excludes. A
-- restrictive list on this bucket would reject the archived load and lose the
-- files that the whole no-content-lost constraint exists to keep. The archive
-- prefix's freedom is deliberate and is not a hole: nothing serves those objects,
-- and reaching them at all requires `edit`.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media-private', 'media-private', false, 26214400, null)
on conflict (id) do update
   set name               = excluded.name,
       public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- 1.3 media-quarantine -- not public, and THE ONE BUCKET THAT RESTRICTS TYPE.
--
-- Every editor upload lands here first, is inspected by finalize with sharp, and
-- is copied out to media or media-private according to the section-16 predicate.
-- Nothing is ever served from this bucket and no client may read it (section 5).
--
-- THE SEVEN EDITOR TYPES, and they are exactly the union of the two editor MIME
-- sets -- four image, three document. This list is the enforcement point for the
-- narrow editor policy; the trusted ingestion path in 1.1 and 1.2 does not pass
-- through here, which is what lets the two coexist without either being
-- weakened. HEIC, JS, CSS, SVG and HTML are absent BY DESIGN and must not be
-- added to unblock a legacy file: the legacy files arrive by the trusted path.
--
-- file_size_limit is 25 MiB because this bucket receives both images and
-- documents and a bucket sees only one limit for all types. The 15 MB image
-- ceiling is applied upstream against the declared type -- see the header.
--
-- The intent is 24-hour retention, but NOTHING HERE SWEEPS: the actual sweep is
-- app/api/cleanup/orphans, which deletes quarantine objects with no matching
-- assets row plus rows still in `reserved` or `uploaded` whose reservation
-- expiry has passed by at least an hour, and which never touches a row whose
-- lifecycle is `stored` or whose legacy_ref is set. That last exclusion is what
-- protects the 289 seeded rows through the multi-day window before
-- tools/src/upload-assets.ts runs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media-quarantine',
  'media-quarantine',
  false,
  26214400,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'application/pdf',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
   set name               = excluded.name,
       public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;


-- =============================================================================
-- 2. media -- the public bucket
-- =============================================================================
-- Read alongside the matrix in the header. Anonymous callers read and nothing
-- else; writing requires a named capability every time.
--
-- Row level security is already enabled on storage.objects by the platform, with
-- zero policies before this file applies. That is the least-privilege starting
-- point rather than an oversight: table-level grants on storage.objects are wide
-- open to anon and authenticated by Supabase default, so RLS is the ONLY gate,
-- and until section 2 runs only the service role can reach an object.

-- 2.1 The public read -- two policies, one per role, and NEITHER calls a
-- function.
--
-- Split by role to honour the naming scheme, so that pg_policies shows one row
-- per role rather than one row covering two. The predicates are identical and
-- both are a bare bucket comparison.
--
-- The anon policy CANNOT call has_capability(): migration 13 revokes execute on
-- it from anon, so the call would fail with permission denied at query time for
-- every anonymous visitor. See the header. It also does not need to -- this is a
-- public bucket and unconditional anonymous read is its purpose.
--
-- Note what the predicate does NOT do: it does not consult public.assets or
-- published_reference_count(). An object is readable here because it is IN this
-- bucket, and it is in this bucket because the promote path put it there. That
-- is the single visibility predicate being honoured by placement rather than
-- re-evaluated per row.
drop policy if exists media_anon_select_public on storage.objects;
create policy media_anon_select_public
  on storage.objects
  for select
  to anon
  using (bucket_id = 'media');

comment on policy media_anon_select_public on storage.objects is
  'Unconditional anonymous read of the public media bucket -- the 110 deployed '
  'binaries. Deliberately calls no function: migration 13 revokes execute on '
  'has_capability() from anon, so a capability call here would fail with '
  'permission denied for every anonymous visitor. Objects are readable by '
  'virtue of being in this bucket; the promote path decides what gets in, using '
  'published_reference_count() from migration 16.';

drop policy if exists media_authenticated_select_public on storage.objects;
create policy media_authenticated_select_public
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'media');

comment on policy media_authenticated_select_public on storage.objects is
  'The same unconditional read for an authenticated caller, so that a signed-in '
  'account -- member or not -- sees exactly what an anonymous visitor sees in '
  'this bucket. Without it, RLS would leave a signed-in editor unable to read '
  'the public images on the page being edited.';


-- 2.2 Writing to media requires `upload`.
--
-- `upload` is held by editor and admin alike (migration 13's matrix). What it
-- does NOT include is any destructive or organizational authority -- that is
-- 2.3.
--
-- In practice the writer here is the server: finalize copies the inspected bytes
-- out of quarantine into this bucket, and the promote path copies them in when a
-- draft is published. Both run under the service role and bypass RLS entirely.
-- This policy is therefore the CLIENT-SIDE CEILING -- what a browser holding a
-- user JWT may do if it addresses Storage directly, without going through
-- /api/uploads/*. It is not decoration: the table grants are open, so absent
-- this policy pair the ceiling would be "nothing", and absent a capability in
-- them it would be "anything an authenticated user likes".
drop policy if exists media_authenticated_insert_upload on storage.objects;
create policy media_authenticated_insert_upload
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'media'
    and public.has_capability('upload')
  );

comment on policy media_authenticated_insert_upload on storage.objects is
  'Insert into the public bucket requires the `upload` capability -- editor or '
  'admin, never merely "any authenticated user". The real writer is the service '
  'role in the finalize and promote paths, which bypasses RLS; this is the '
  'client-side ceiling for a browser addressing Storage directly.';

drop policy if exists media_authenticated_update_upload on storage.objects;
create policy media_authenticated_update_upload
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'media'
    and public.has_capability('upload')
  )
  with check (
    bucket_id = 'media'
    and public.has_capability('upload')
  );

comment on policy media_authenticated_update_upload on storage.objects is
  'Overwriting an object in place requires `upload`, the same capability as '
  'creating one, because replace-asset is an upload. Both `using` and `with '
  'check` carry the predicate: `using` decides which existing rows may be '
  'targeted, `with check` decides what they may become, and omitting the second '
  'would let a permitted row be updated into a bucket the caller cannot write.';


-- 2.3 Deleting from media requires `delete_asset` -- admin only.
--
-- The capability is admin-only in migration 13's matrix, and its name is
-- narrower than the authority it gates: it covers rename-asset, retire-asset,
-- restore-asset and deletion. The string is fixed by the specification's Storage
-- policy table and must not be renamed.
--
-- An editor cannot reach this. That is the deliberate reduction the school
-- approves at cutover: the legacy editor role could move, rename and delete
-- assets, and the account used every day should not also be the one that can
-- destroy a photograph.
--
-- Note that a direct SQL delete is additionally blocked by the platform's own
-- protect_objects_delete trigger unless storage.allow_delete_query is set, which
-- the Storage API sets for its own delete path. The two are independent: the
-- trigger stops accidental DML, this policy decides authorization.
drop policy if exists media_authenticated_delete_delete_asset on storage.objects;
create policy media_authenticated_delete_delete_asset
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'media'
    and public.has_capability('delete_asset')
  );

comment on policy media_authenticated_delete_delete_asset on storage.objects is
  'Deletion from the public bucket requires `delete_asset`, which migration 13 '
  'grants to admin only -- an editor holding `edit` and `upload` is refused. '
  'Deletion is also expected to route through replace/retire, which copies the '
  'outgoing bytes to the media-trash/ prefix first; this policy is the '
  'authorization gate, not the retention mechanism.';


-- =============================================================================
-- 3. media-private -- draft-only and archived media, EXCLUDING the trash prefix
-- =============================================================================
-- NO ANON POLICY EXISTS IN THIS SECTION, AND THAT IS THE POINT. 24 of these
-- objects are referenced only by unpublished entries, so an anonymous read would
-- disclose unpublished content -- the precise failure the draft-only class was
-- separated out to prevent. There is no anon policy for anything in this bucket
-- and none may be added.
--
-- Delivery to an authorized human is through app/api/media/[...path]/route.ts:
-- same-origin, session-checked, Cache-Control: private, no-store, streamed
-- server-side and rendered unoptimized. NOT through a signed URL handed to
-- next/image, which would mint a durable, cacheable, unauthenticated
-- /_next/image URL whose cache outlives the signature. See the header.
--
-- THE ARCHIVE PREFIX IS COVERED BY `edit`, STATED EXPLICITLY RATHER THAN LEFT TO
-- INFERENCE. The 155 archived binaries live under an archive/ prefix in this
-- bucket and are browsable through AssetLibrary so the school can review and
-- restore rather than lose them. Reviewing is editing work, `edit` is held by
-- editor and admin, and the matrix puts media-private behind `edit` -- so the
-- archive gets no narrower policy of its own. It is deliberately NOT admin-only:
-- an editor asked to triage 155 files should not need an admin for every look.
-- The trash prefix is the one exception, and section 4 is why.
--
-- ONE PREDICATE, FOUR OPERATIONS, AND THE EXCLUSION IS IN ALL FOUR. The
-- media-trash/ prefix must be unreachable here, or the general `edit` policy
-- would hand an editor the byte history that section 4 reserves for admins. The
-- exclusion is written with coalesce so that sections 3 and 4 are EXACT
-- COMPLEMENTS over storage.objects.name: every object in this bucket satisfies
-- exactly one of the two families, with no gap and no overlap. storage.objects.name
-- is nullable, and `null not like '...'` is null rather than true -- which would
-- silently deny an editor a legitimate object -- so coalesce(name, '') makes both
-- predicates real booleans and keeps the partition total.
drop policy if exists media_private_authenticated_select_edit on storage.objects;
create policy media_private_authenticated_select_edit
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'media-private'
    and coalesce(name, '') not like 'media-trash/%'
    and public.has_capability('edit')
  );

comment on policy media_private_authenticated_select_edit on storage.objects is
  'Reading draft-only and archived media requires `edit` -- editor or admin, '
  'never anonymous and never a signed-in non-member. The media-trash/ prefix is '
  'excluded here and granted only by the admin-only family in section 4; the '
  'two predicates are exact complements over name, so no object is both '
  'reachable and unreachable and none is neither. Delivery is through '
  '/api/media/** and never the image optimizer.';

drop policy if exists media_private_authenticated_insert_edit on storage.objects;
create policy media_private_authenticated_insert_edit
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'media-private'
    and coalesce(name, '') not like 'media-trash/%'
    and public.has_capability('edit')
  );

comment on policy media_private_authenticated_insert_edit on storage.objects is
  'Writing a private object requires `edit`. The exclusion matters as much on '
  'insert as on select: without it a caller with `edit` could WRITE INTO the '
  'trash prefix and fabricate byte history it cannot read back.';

drop policy if exists media_private_authenticated_update_edit on storage.objects;
create policy media_private_authenticated_update_edit
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'media-private'
    and coalesce(name, '') not like 'media-trash/%'
    and public.has_capability('edit')
  )
  with check (
    bucket_id = 'media-private'
    and coalesce(name, '') not like 'media-trash/%'
    and public.has_capability('edit')
  );

comment on policy media_private_authenticated_update_edit on storage.objects is
  'Updating a private object requires `edit`. Both clauses carry the trash '
  'exclusion, so a caller holding ONLY `edit` cannot rename an object into the '
  'trash prefix: `using` admits the old name and `with check` refuses the new '
  'one. An admin, holding `edit` AND `delete_asset`, can cross that boundary -- '
  'see the header section on how Postgres ORs using and with check '
  'independently across policies. That is within admin authority and is not '
  'reachable by an editor.';

drop policy if exists media_private_authenticated_delete_edit on storage.objects;
create policy media_private_authenticated_delete_edit
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'media-private'
    and coalesce(name, '') not like 'media-trash/%'
    and public.has_capability('edit')
  );

comment on policy media_private_authenticated_delete_edit on storage.objects is
  'Deleting a private object requires `edit`, and cannot touch the trash '
  'prefix. Narrower than it looks: retiring or replacing an ASSET is '
  '`delete_asset` and admin-only in the application''s command set -- this is '
  'only the Storage-level ceiling for the private bucket.';



-- =============================================================================
-- 4. media-trash/ -- byte history, admin only, a PREFIX inside media-private
-- =============================================================================
-- THE SUBTLEST THING IN THIS FILE, and the one most easily got wrong. Section 3
-- puts the whole of media-private behind `edit`, which editors hold. If that
-- were the only family on the bucket, an editor would be able to read every
-- superseded and deleted byte the school ever had -- including images retired
-- precisely because they should no longer be seen. The prefix therefore needs a
-- policy family of its own AND an exclusion from section 3's; one without the
-- other achieves nothing.
--
-- HOW THE TWO FAMILIES DIVIDE, exactly:
--
--   coalesce(name,'') like     'media-trash/%'  ->  section 4, `delete_asset`
--   coalesce(name,'') not like 'media-trash/%'  ->  section 3, `edit`
--
-- Complementary by construction, over a value coalesce has already made
-- non-null. Every object in media-private falls in exactly one family, so there
-- is no object both families admit and none that neither does. Postgres ORs
-- permissive policies, so overlap would mean the weaker capability won -- which
-- is exactly how this protection would silently evaporate.
--
-- `admin` IS THE QUALIFIER, has_capability('delete_asset') IS THE PREDICATE.
-- There is no 'admin' capability string and none is invented here: migration 13
-- grants delete_asset to admin ONLY, and its matrix names "restore-asset
-- (recovering bytes from media-trash)" as one of the authorities it gates. So
-- asking for delete_asset IS asking for admin, through the vocabulary the
-- schema already has, with no role literal in a policy and no second place where
-- the role model is written down.
--
-- Note the deliberate split on the word "restore" that migration 13 records:
-- `restore` covers restoring a revision or a change set and BOTH roles hold it,
-- while recovering trashed asset BYTES is admin-only under delete_asset. Two
-- different authorities sharing a verb. An editor may undo a text edit; only an
-- admin may resurrect a deleted photograph.
--
-- KEY SHAPE, and why a `like` prefix test is the right instrument:
--
--   media-trash/<asset_id>/<iso-timestamp>/<filename>
--
-- The <asset_id>/<iso-timestamp> segments mean one asset accumulates one entry
-- per replacement, ordered, without collision. `like 'media-trash/%'` requires
-- the separator, so an object named exactly `media-trash` -- no slash, not
-- inside the prefix -- is correctly NOT trash and falls to section 3. This
-- Storage version has no storage.prefixes table and storage.objects has no
-- `level` column, so name is the whole truth about an object's path and there is
-- no second surface to police.
--
-- RETENTION IS 90 DAYS AND NOTHING HERE ENFORCES IT. app/api/cleanup/orphans
-- sweeps keys past 90 days. A policy cannot express retention, and pretending
-- otherwise would leave the sweep unwritten.
--
-- THE REAL WRITER IS THE SERVICE ROLE. Copying outgoing bytes here happens
-- inside the replace and delete orchestrations, which bypass RLS. The insert and
-- update policies below are the client-side ceiling, set at admin so that the
-- ceiling matches the read: nobody who cannot read the history may manufacture
-- it.
drop policy if exists media_trash_authenticated_select_admin on storage.objects;
create policy media_trash_authenticated_select_admin
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'media-private'
    and coalesce(name, '') like 'media-trash/%'
    and public.has_capability('delete_asset')
  );

comment on policy media_trash_authenticated_select_admin on storage.objects is
  'Reading byte history requires `delete_asset`, which is admin-only in '
  'migration 13 -- an editor holding `edit` is refused, because section 3''s '
  'policy excludes this prefix. That exclusion and this policy are one '
  'mechanism: either alone leaves the trash readable by every editor or '
  'readable by nobody. Supabase Storage has no object versioning, so this '
  'prefix IS the byte history, retained 90 days by the cleanup sweep.';

drop policy if exists media_trash_authenticated_insert_admin on storage.objects;
create policy media_trash_authenticated_insert_admin
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'media-private'
    and coalesce(name, '') like 'media-trash/%'
    and public.has_capability('delete_asset')
  );

comment on policy media_trash_authenticated_insert_admin on storage.objects is
  'Writing into the trash prefix requires `delete_asset`. The genuine writer is '
  'the service role inside the replace and delete orchestrations, which bypasses '
  'RLS; this sets the client-side ceiling at admin so that no caller can '
  'fabricate history it is not allowed to read.';

drop policy if exists media_trash_authenticated_update_admin on storage.objects;
create policy media_trash_authenticated_update_admin
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'media-private'
    and coalesce(name, '') like 'media-trash/%'
    and public.has_capability('delete_asset')
  )
  with check (
    bucket_id = 'media-private'
    and coalesce(name, '') like 'media-trash/%'
    and public.has_capability('delete_asset')
  );

comment on policy media_trash_authenticated_update_admin on storage.objects is
  'Updating a trashed object requires `delete_asset`, so an editor cannot touch '
  'byte history at all. It does NOT prevent an admin renaming an object out of '
  'the trash prefix: Postgres ORs using and with check independently across '
  'policies, so an admin holding both capabilities satisfies one side from each '
  'family -- verified by test, documented in the header, and NOT expressible in '
  'RLS, which cannot compare the old name to the new. Restoration is still the '
  'restore-asset command, which copies bytes back and records the move in a '
  'change set; a bare in-place rename is outside the command set rather than a '
  'privilege escalation.';

drop policy if exists media_trash_authenticated_delete_admin on storage.objects;
create policy media_trash_authenticated_delete_admin
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'media-private'
    and coalesce(name, '') like 'media-trash/%'
    and public.has_capability('delete_asset')
  );

comment on policy media_trash_authenticated_delete_admin on storage.objects is
  'Purging byte history requires `delete_asset`. Expiry is normally the cleanup '
  'sweep''s work at 90 days under the service role; this is the authorization '
  'gate for a deliberate early purge, and it is admin-only because a deleted '
  'object is gone -- the provider offers no versioning to fall back on.';


-- =============================================================================
-- 5. media-quarantine -- insert only, and DELIBERATELY UNREADABLE BY CLIENTS
-- =============================================================================
-- One policy for this bucket. That is not an omission, and the three missing
-- operations are the substance of the design.
--
-- NO SELECT POLICY, FOR ANY ROLE. Uploads land here and are read ONLY
-- server-side, by the finalize orchestration, which runs under the service role
-- and bypasses RLS. A client able to select from this bucket could enumerate and
-- read ANOTHER ACCOUNT'S IN-FLIGHT UPLOAD -- bytes that have not been inspected,
-- not been type-checked against their real content, and not been assigned a
-- visibility yet. There is no legitimate client-side reader: the uploader
-- already has the bytes it just sent, and everything downstream of the upload is
-- a server concern.
--
-- Consequently a `select` from storage.objects where bucket_id =
-- 'media-quarantine' returns ZERO ROWS for an editor even for an object that
-- same editor inserted a moment earlier. That is correct and is asserted by
-- test rather than assumed.
--
-- NO UPDATE AND NO DELETE POLICY EITHER. An upload is write-once: finalize
-- copies the object out and then deletes it from quarantine, and the guarded
-- sweep removes orphans. Neither runs as a client. Allowing a client to
-- overwrite a quarantined object would let it swap the bytes AFTER the sign
-- route recorded a declared type and length and BEFORE finalize inspects them --
-- a check-then-use gap in the one place the pipeline is meant to be
-- authoritative about what it received.
--
-- WHAT THE INSERT POLICY IS FOR, given that the browser uploads to a signed URL
-- whose signature -- not RLS -- authorizes it. It is the ceiling on a client
-- addressing Storage directly with its own user JWT, bypassing
-- /api/uploads/sign entirely. Without a capability there, the wide-open table
-- grants would let any authenticated account fill the bucket. With it, only an
-- editor or admin can, and the durable reservation quota bounds how much.
--
-- The type and size restriction on what may land here is the bucket
-- configuration in 1.3, not this policy: allowed_mime_types refuses HEIC, SVG,
-- HTML and everything else outside the seven editor types, and file_size_limit
-- refuses anything over 25 MiB, both at the Storage API and both regardless of
-- which role is writing.
drop policy if exists media_quarantine_authenticated_insert_upload on storage.objects;
create policy media_quarantine_authenticated_insert_upload
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'media-quarantine'
    and public.has_capability('upload')
  );

comment on policy media_quarantine_authenticated_insert_upload on storage.objects is
  'The ONLY policy on media-quarantine: insert requires `upload`. There is '
  'deliberately no select policy for any role -- finalize reads the bucket under '
  'the service role, and a client that could list it would be able to read '
  'another account''s uninspected in-flight upload. No update or delete policy '
  'either, so a quarantined object cannot be swapped between the sign route '
  'recording its declared type and finalize inspecting its real bytes.';


-- =============================================================================
-- 6. Verification
-- =============================================================================
-- Every claim this file makes is checkable with the queries below. They are
-- comments rather than statements: a migration that asserted its own postconditions
-- would fail an apply for a reason no commit could fix, and these belong in the
-- db-and-parity CI job and the cutover runbook.
--
-- 6.1 Exactly three buckets, with the shape section 1 declares. Expect three
-- rows: media / t / 26214400 / null, media-private / f / 26214400 / null,
-- media-quarantine / f / 26214400 / the seven editor types. `media-trash` must
-- NOT appear -- it is a prefix inside media-private, not a bucket.
--
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets order by id;
--   select count(*) from storage.buckets;   -- expect exactly 3
--
-- 6.2 The access matrix, read back as itself. Expect fourteen rows, and confirm
-- no write policy has a qual or with_check of the literal `true`.
--
--   select policyname, cmd, roles, qual, with_check
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--    order by policyname;
--
-- Expect exactly ONE `{anon}` row -- a select, not a write, and referencing no
-- function at all. Anything else means anon has been granted more than the
-- public bucket, or an anon policy has acquired a has_capability() call that
-- will fail at query time:
--
--   select policyname, cmd, qual from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and 'anon' = any (roles);          -- expect 1 row: media_anon_select_public
--
-- And nothing at all on storage.buckets, which is what makes bucket
-- configuration operator-owned in the database rather than only by convention:
--
--   select count(*) from pg_policies
--    where schemaname = 'storage' and tablename = 'buckets';   -- expect 0
--
-- 6.3 Capability enforcement, as real sessions rather than as reasoning. Set the
-- role and the claims, then read. An editor sees media and non-trash
-- media-private; an admin additionally sees the trash prefix; anon sees only
-- media; a signed-in account with no admin_users row sees only media.
--
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated","aal":"aal2"}';
--   select count(*) from storage.objects where bucket_id = 'media-private';
--
-- 6.4 THE TRASH TRAP -- the assertion that catches the mistake this file is
-- written to avoid. As an editor holding `edit`, selecting an object at
-- media-trash/<uuid>/<ts>/<file> must return ZERO rows; as an admin it must
-- return it. If the editor sees it, section 3's exclusion is missing or its
-- coalesce is wrong.
--
--   select count(*) from storage.objects
--    where bucket_id = 'media-private' and name like 'media-trash/%';
--
-- 6.5 No quarantine listing. As an editor, zero rows -- even for an object that
-- editor just inserted.
--
--   select count(*) from storage.objects where bucket_id = 'media-quarantine';
--
-- 6.6 MIME and size enforcement live in the Storage API, so they are exercised
-- over HTTP against the bucket, not by SQL insert. Through /storage/v1/object:
-- image/jpeg succeeds; image/heic, image/svg+xml and text/html are refused on
-- media-quarantine; a 26 MB body is refused; a 20 MB application/zip succeeds.
-- A 12 MB JPEG succeeds, which is what proves the largest legacy image at
-- 10,619,043 bytes would be accepted and that the 15 MB image ceiling is
-- enforced upstream rather than by a bucket limit set too low.
--
-- 6.7 THE TRUSTED PATH STILL WORKS -- the assertion that proves the split. As
-- the service role, an image/heic object and a text/css object must BOTH upload
-- successfully to media-private. If a restrictive allowed_mime_types ever creeps
-- onto media or media-private, this is what fails, and with it the byte-for-byte
-- preservation of all 289 legacy objects.
--
-- 6.8 Idempotency. Apply all eighteen migrations twice: `supabase db reset` run
-- twice must yield identical storage.buckets and pg_policies output, with no
-- duplicate-key error from section 1 and no "policy already exists" from
-- sections 2 to 5.
--
-- 6.9 A direct SQL delete against storage.objects is refused by the platform's
-- protect_objects_delete trigger with SQLSTATE 42501 unless
-- storage.allow_delete_query is set to 'true' -- which the Storage API sets on
-- its own delete path. Exercising the delete policies at SQL level therefore
-- requires `set local storage.allow_delete_query = 'true'` first. The trigger and
-- these policies are independent controls: it stops accidental DML, they decide
-- authorization.
-- =============================================================================

