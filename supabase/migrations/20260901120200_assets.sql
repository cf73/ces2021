-- =============================================================================
-- Cambridge-Ellis School  ·  migration 02 of 18  ·  assets
-- =============================================================================
-- Creates exactly one table: public.assets. It is the first table in the schema
-- and it is second in the sequence because almost every other content table
-- carries a foreign key to it: pages, page_sections, people, events,
-- classrooms and promoted all reference assets.id, and so does the typed logo
-- key in site_globals. Every one of those migrations (04-11) therefore depends
-- on this file having already run.
--
-- Source of truth for the field set, read rather than assumed:
--
--   resources/blueprints/assets/assets.yaml   declares exactly ONE field --
--                                             `alt`, type text, display
--                                             'Alt Text', and NOT required.
--   content/assets/assets.yaml                is two lines, `title: Assets`
--                                             and `disk: assets`. The legacy
--                                             container declares no MIME
--                                             restriction and no size limit.
--   config/statamic/assets.php                sets Glide `auto_crop => true`
--                                             with `presets => []`, which is
--                                             why the focal point genuinely
--                                             drove cropping and must migrate
--                                             faithfully.
--   public/assets/.meta/*.yaml                289 sidecars supply mime, size
--                                             and dimensions; 18 also carry a
--                                             focal point. Not one carries alt
--                                             text.
--
-- What this file deliberately does NOT do, because another migration owns it:
--
--   policies          migration 17. RLS is ENABLED here and zero policies are
--                     written, so the table is closed until 17 opens it. The
--                     anonymous read there is gated on published_reference_count
--                     rather than a blanket `using (true)`.
--   storage buckets   migration 18, which is also where per-bucket size and
--                     MIME limits live. supabase/config.toml delegates bucket
--                     configuration to it.
--   write functions   migration 16, which owns the sign, finalize, replace,
--                     rename, retire and restore orchestrations and the single
--                     visibility predicate that decides `bucket`.
--   inbound FKs       the referencing tables. See the note at the end of this
--                     file: deleting a referenced asset is BLOCKED, and that
--                     must not be weakened from this side.
--
-- Every statement is idempotent -- `create table if not exists`, `create index
-- if not exists`, `drop constraint if exists` before `add constraint`, and
-- `drop trigger if exists` before `create trigger` -- so applying all eighteen
-- migrations twice is clean. Conventions (lowercase SQL, `text` never
-- varchar(n), the explicit timezone('utc', now()) timestamp form, and jsonb
-- only where the structure is genuinely variable) are stated once in migration
-- 01 and followed here. This table needs no jsonb column at all: every value it
-- holds has a name.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
-- Column-by-column rationale is carried in the `comment on column` statements
-- in section 6 rather than duplicated here, because those comments survive into
-- the database and remain readable once content/ has been deleted.

create table if not exists public.assets (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule; an unqualified call would fail at runtime, not at create
  -- time. Seeded rows do not rely on this default -- they derive their id from
  -- public.ces_uuid('assets', legacy_ref), which is what makes the load
  -- idempotent -- so the default serves editor-created rows.
  id                      uuid primary key default extensions.gen_random_uuid(),

  -- The source asset path, e.g. `IMG_4369.jpg`. Null for editor-created rows.
  legacy_ref              text unique,

  -- Which of the three buckets holds the object. Not a free choice; see the
  -- column comment.
  bucket                  text not null,

  -- The bucket-relative POSIX object key, normalized once at extraction time.
  path                    text not null unique,

  -- The display filename staff see and rename. Distinct from `path`.
  filename                text not null,

  -- Nullable, and deliberately unconstrained. A check here would reject the
  -- legacy corpus at seed time.
  mime                    text,

  -- bigint rather than integer: headroom for the rolling 24-hour quota ledger.
  size_bytes              bigint,

  -- Null for the non-image assets in the corpus (pdf, zip, docx, js, css).
  width                   integer,
  height                  integer,

  -- Starts null on every one of the 289 migrated rows. Authoring it is a
  -- cutover deliverable, not a migration step.
  alt                     text,

  -- Statamic's `x-y-zoom` string, split into three numbers at extraction time.
  focus_x                 numeric(5,2),
  focus_y                 numeric(5,2),
  focus_zoom              numeric(5,2),

  -- The upload state machine. Default justified in the column comment.
  lifecycle               text not null default 'stored',

  -- Why finalize trashed the row, surfaced to the editor as a typed error.
  trashed_reason          text,

  -- Per-account upload accounting. `on delete set null` so an asset outlives
  -- the account that uploaded it.
  created_by              uuid references auth.users (id) on delete set null,

  -- The reservation ledger. Both columns are load-bearing; see their comments.
  declared_size_bytes     bigint,
  reservation_expires_at  timestamptz,

  -- Operational timestamps describing target writes. `updated_at` is
  -- maintained exclusively by the trigger in section 4; no application code
  -- writes it.
  created_at              timestamptz not null default timezone('utc', now()),
  updated_at              timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Check constraints
-- -----------------------------------------------------------------------------
-- Declared as explicitly-named `alter table` statements rather than inline, for
-- two reasons: the names are then stable and greppable instead of
-- server-generated, and the `drop constraint if exists` / `add constraint` pair
-- re-asserts each definition on a second apply, so this file converges even
-- against a table that already exists with a drifted constraint. Each
-- definition appears exactly once.
--
-- There is deliberately NO constraint on `mime`. The legacy container declared
-- no MIME restriction and staff used that freedom: the 289 stored binaries are
-- 220 .jpg, 28 .png, 26 .jpeg, 4 .zip, 3 .heic, 2 .pdf, 2 .js, 2 .css, 1 .svg
-- and 1 .docx. A check here would abort the canonical seed load. MIME
-- restriction is a property of the media-quarantine bucket in migration 18 and
-- therefore applies to editor uploads only, never to trusted service-role
-- ingestion.

-- `bucket` must name one of the three buckets migration 18 creates, spelled
-- exactly as their ids are spelled there.
alter table public.assets drop constraint if exists assets_bucket_check;
alter table public.assets add constraint assets_bucket_check
  check (bucket in ('media', 'media-private', 'media-quarantine'));

-- `lifecycle` is the upload state machine. Transition order is
-- reserved -> uploaded -> inspecting -> stored -> (trashed).
alter table public.assets drop constraint if exists assets_lifecycle_check;
alter table public.assets add constraint assets_lifecycle_check
  check (lifecycle in ('reserved', 'uploaded', 'inspecting', 'stored', 'trashed'));

-- Byte counts are non-negative where present. The `is null or` clause is
-- redundant against SQL null semantics and is written anyway, so the intent is
-- legible to a reader who is checking whether nullability was considered.
alter table public.assets drop constraint if exists assets_size_bytes_check;
alter table public.assets add constraint assets_size_bytes_check
  check (size_bytes is null or size_bytes >= 0);

alter table public.assets drop constraint if exists assets_declared_size_bytes_check;
alter table public.assets add constraint assets_declared_size_bytes_check
  check (declared_size_bytes is null or declared_size_bytes >= 0);

-- Dimensions are positive where present, and absent entirely for the fifteen
-- non-image assets. Zero is rejected rather than treated as unknown: null is
-- how this table says unknown.
alter table public.assets drop constraint if exists assets_width_check;
alter table public.assets add constraint assets_width_check
  check (width is null or width > 0);

alter table public.assets drop constraint if exists assets_height_check;
alter table public.assets add constraint assets_height_check
  check (height is null or height > 0);

-- Focal point. x and y are percentages of the image box, so [0, 100].
alter table public.assets drop constraint if exists assets_focus_x_check;
alter table public.assets add constraint assets_focus_x_check
  check (focus_x is null or (focus_x >= 0 and focus_x <= 100));

alter table public.assets drop constraint if exists assets_focus_y_check;
alter table public.assets add constraint assets_focus_y_check
  check (focus_y is null or (focus_y >= 0 and focus_y <= 100));

-- Zoom is a multiplier, so 1 is the floor -- there is no such thing as zooming
-- out past the frame. The ceiling is 10, chosen to sit far above every value
-- the corpus actually carries (the largest migrated zoom is 1.6) while still
-- rejecting a value that could only be a unit error or a corrupted parse.
alter table public.assets drop constraint if exists assets_focus_zoom_check;
alter table public.assets add constraint assets_focus_zoom_check
  check (focus_zoom is null or (focus_zoom >= 1 and focus_zoom <= 10));


-- -----------------------------------------------------------------------------
-- 3. Row level security
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies, neither `anon` nor `authenticated` can read or write a single row,
-- which is the correct closed default for a table that will hold references to
-- unpublished content and to private archive objects.
--
-- The canonical seed load is unaffected because supabase/seed.sql runs as
-- service_role, which bypasses RLS. `force row level security` is deliberately
-- NOT set: it would subject the table owner to policies too and break that
-- load.
--
-- Migration 17 owns the policy set, and it is not trivial: anonymous `select`
-- is granted where the asset is referenced by a published row OR by a public
-- site_globals key -- that second clause is what keeps the school logo
-- reachable anonymously -- authenticated `select` covers everything given
-- active membership, and writes require the `upload` or `delete_asset`
-- capability.

alter table public.assets enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01. `updated_at` therefore
-- cannot be forged and cannot be forgotten: no application code and no write
-- function in migration 16 may set the column. This is the named fidelis
-- weakness this project corrects -- that reference declares the column with a
-- default and then creates no trigger anywhere, leaving it truthful only until
-- the first edit.
--
-- `created_at` is deliberately left as a column default only.

drop trigger if exists set_assets_updated_at on public.assets;

create trigger set_assets_updated_at
  before update on public.assets
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes
-- -----------------------------------------------------------------------------
-- `path` and `legacy_ref` are already indexed by their unique constraints, so
-- they are not repeated here. The four below back specific, named access paths
-- rather than being added speculatively.

-- The guarded cleanup sweep in /api/cleanup/orphans filters on lifecycle to
-- find expired `reserved` and `uploaded` rows.
create index if not exists assets_lifecycle_idx
  on public.assets (lifecycle);

-- Upload accounting: the per-account hourly upload count and the rolling
-- 24-hour byte quota both group by actor.
create index if not exists assets_created_by_idx
  on public.assets (created_by);

-- The same sweep scans for lapsed reservations, and the quota query excludes
-- reservations that have already expired.
create index if not exists assets_reservation_expires_at_idx
  on public.assets (reservation_expires_at);

-- Bucket membership is recomputed and objects are moved on finalize, publish,
-- unpublish, replace and delete, so the set of rows in a given bucket is
-- queried directly.
create index if not exists assets_bucket_idx
  on public.assets (bucket);


-- -----------------------------------------------------------------------------
-- 6. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. This file deletes nothing, but content/ and
-- public/assets/ are removed at the end of the migration phase, so after
-- cutover the database itself is the only place a reader can learn why a
-- column exists or what its values mean.

comment on table public.assets is
  'Every media object the school owns: the 289 binaries migrated from '
  'public/assets plus everything staff upload afterwards. One row per object. '
  'Referenced by pages, page_sections, people, events, classrooms, promoted '
  'and the typed logo key in site_globals, always by id and never by path.';

comment on column public.assets.id is
  'Primary key. Seeded rows derive theirs from public.ces_uuid(''assets'', '
  'legacy_ref) so the load is idempotent and a referencing row can be written '
  'before this one; the default serves editor-created rows.';

comment on column public.assets.legacy_ref is
  'The source asset path from public/assets, e.g. IMG_4369.jpg. Set on all 289 '
  'migrated rows; null on editor-created ones. Load-bearing for safety, not '
  'merely provenance: the guarded cleanup sweep in /api/cleanup/orphans never '
  'touches a row whose legacy_ref is set, which is what protects the 289 '
  'seeded rows during the multi-day window before tools/src/upload-assets.ts '
  'runs and puts their bytes in Storage. Do not drop this column as redundant.';

comment on column public.assets.bucket is
  'Which of the three buckets from migration 18 holds the object: media '
  '(public), media-private, or media-quarantine. NOT a free choice and not a '
  'field anybody sets by preference -- it is a function of the single '
  'visibility predicate, published_reference_count(id) > 0, evaluated by the '
  'write functions in migration 16. At zero the object belongs in '
  'media-private. Finalize, publish, unpublish, replace and delete each '
  'recompute it and move the object only if the required bucket differs from '
  'this value.';

comment on column public.assets.path is
  'Bucket-relative POSIX object key. Normalization contract: no leading slash, '
  'lower-cased extension, spaces and other unsafe characters replaced, and the '
  '/assets/ prefix stripped -- legacy filenames genuinely contain spaces and '
  'uppercase extensions. One collision-checked source-to-normalized map in '
  'artifacts/assets.manifest.json drives the filesystem move, the Storage '
  'object key, this column, the fallback JSON reference, the typed globals '
  'logo and the 18 focal-point rows, so a file is renamed once and every '
  'reference to it agrees. Two files normalizing to one name is a hard failure '
  'in the manifest step; this unique constraint is the last line of defence.';

comment on column public.assets.filename is
  'The display filename staff see and edit through the rename-asset command. '
  'Deliberately distinct from path: every consumer references assets.id, never '
  'a path, so a rename breaks nothing.';

comment on column public.assets.mime is
  'Media type, from the sidecar for migrated rows or from real byte inspection '
  'in /api/uploads/finalize for uploads. Nullable and deliberately '
  'unconstrained: the legacy container declared no MIME restriction and the '
  'corpus includes heic, zip, pdf, docx, js, css and svg objects, so a check '
  'here would abort the seed load. Editor uploads are restricted instead by '
  'the media-quarantine bucket policy in migration 18.';

comment on column public.assets.size_bytes is
  'Actual object length in bytes, written by finalize once the bytes exist. '
  'bigint rather than integer purely for headroom: the rolling 24-hour upload '
  'quota sums this column against a 500,000,000-byte ceiling.';

comment on column public.assets.width is
  'Intrinsic pixel width. Null for the non-image assets in the corpus, which '
  'have no dimensions.';

comment on column public.assets.height is
  'Intrinsic pixel height. Null for the non-image assets in the corpus, which '
  'have no dimensions.';

comment on column public.assets.alt is
  'Alternative text. The assets blueprint declared exactly one field, alt, and '
  'did not mark it required; not one of the 289 sidecars carries a value. This '
  'column therefore starts NULL on every migrated row, and that is faithful '
  'migration rather than a gap in it -- the automated source-parity gate '
  'asserts precisely that the empty source values were carried across. '
  'Authoring alt for the informative subset of published assets is a cutover '
  'deliverable and a separate release gate. Decorative assets render alt="" '
  'and are correct as they stand.';

comment on column public.assets.focus_x is
  'Focal point X as a percentage of the image box, so the valid range is '
  '[0, 100]. The legacy sidecar stored a single x-y-zoom string; '
  'tools/src/extract-statamic-content.ts splits it and this database stores '
  'three numbers. Rendered by nextjs/components/site/Media.tsx as part of '
  'object-position.';

comment on column public.assets.focus_y is
  'Focal point Y as a percentage of the image box, so the valid range is '
  '[0, 100]. Rendered by nextjs/components/site/Media.tsx as part of '
  'object-position.';

comment on column public.assets.focus_zoom is
  'Focal point zoom multiplier. Valid range [1, 10]; the largest value in the '
  'migrated corpus is 1.6. It matters because Glide ran with auto_crop => '
  'true, so the focal point genuinely drove cropping on the legacy site: '
  'nextjs/components/site/Media.tsx applies x and y as object-position and '
  'this value as a scale() on the image inside its overflow-hidden frame. '
  'Discarding zoom would silently recrop every asset whose value is above 1.';

comment on column public.assets.lifecycle is
  'Upload state machine: reserved -> uploaded -> inspecting -> stored -> '
  '(trashed). It exists because an upload is an orchestration and not an '
  'atomic transaction -- Postgres cannot execute sharp, and a Storage copy '
  'plus a row insert plus an object delete span two systems with no shared '
  'commit -- so every step is observable and every failure recoverable. Each '
  'transition is idempotent and keyed on the reservation id, so a retried '
  'finalize converges instead of duplicating. Default is stored, chosen '
  'deliberately: the upload path sets reserved explicitly at '
  '/api/uploads/sign, so the default is never exercised there, while every '
  'other route into this table -- the 289-row seed, an export or import round '
  'trip, an admin restore -- is by definition an already-durable object. The '
  'cleanup sweep and the migration 16 sign and finalize functions both reason '
  'about this column, and both treat stored as protected.';

comment on column public.assets.trashed_reason is
  'Why finalize rejected the object and marked the row trashed -- a failed '
  'magic-byte check, a failed decode, a pixel ceiling, or a declared-length '
  'mismatch. Surfaced to the editor as a typed error.';

comment on column public.assets.created_by is
  'The account that uploaded the object, which the per-account hourly upload '
  'limit and the rolling byte quota both count from. Null on migrated rows and '
  'on delete set null, so an asset outlives the account that created it.';

comment on column public.assets.declared_size_bytes is
  'The byte length the client declared at sign time. Required by the design '
  'rather than informational: the quota CANNOT be counted from size_bytes '
  'after the fact, because /api/uploads/sign returns a URL and the client then '
  'pushes straight to Storage, so at the moment the ceiling has to be enforced '
  'the bytes do not exist yet -- counting afterwards would let an account sign '
  'fifty URLs and upload every one. The reservation is therefore taken at sign '
  'time in the same transaction as the quota check, and the quota query sums '
  'this column for rows in reserved, uploaded or inspecting whose reservation '
  'has not expired, plus size_bytes for stored rows, across a rolling 24 '
  'hours. Finalize then requires the actual object length to match this value '
  'within 1%, so it cannot be understated to slip past the ceiling.';

comment on column public.assets.reservation_expires_at is
  'When the sign-time reservation lapses. The other half of the quota ledger: '
  'the quota query ignores expired reservations, so an abandoned upload stops '
  'consuming quota the moment this passes, with no reconciliation job needed. '
  'The guarded cleanup sweep then removes the row and any orphan quarantine '
  'object. Null once the row reaches stored.';

comment on column public.assets.created_at is
  'When this row was written to the target database. An operational timestamp, '
  'not migrated provenance.';

comment on column public.assets.updated_at is
  'Maintained exclusively by the set_assets_updated_at trigger. No application '
  'code and no write function may set this column.';


-- -----------------------------------------------------------------------------
-- A note on inbound foreign keys, for whoever writes migrations 04-11
-- -----------------------------------------------------------------------------
-- Deleting an asset that any row still references is BLOCKED. That is a
-- deliberate contract and it must not be weakened from either side:
--
--   * `on delete set null` is not merely undesirable, it is impossible for
--     promoted.image_asset_id, which is NOT NULL. Silently nulling a required
--     image is worse than refusing the delete.
--   * `on delete cascade` would let removing one photograph delete the content
--     row that displays it.
--
-- So inbound references are plain `references public.assets (id)` with no
-- referential action, and the editor answers a blocked delete by listing the
-- referencing rows. Replacement is an atomic swap inside one transaction, and
-- the outgoing bytes are copied to the media-trash/ prefix first. All of that
-- lives in migration 16 and in the referencing tables, not here.
-- =============================================================================
