-- =============================================================================
-- Cambridge-Ellis School  ·  migration 11 of 18  ·  site globals
-- =============================================================================
-- Creates exactly one table, public.site_globals, and seeds it with all
-- twenty-six keys. It is one of only two migrations that legitimately carry a
-- seed -- the other is migration 12's nav_items tree -- because what both seed
-- is STRUCTURE rather than content: a closed key set and a menu shape. Every
-- collection row comes from supabase/seed.sql instead.
--
-- Why a seed belongs here at all: the twenty-six keys are not data somebody
-- entered, they are the schema of the school's site-wide settings. A key that is
-- absent is not an empty field an editor can fill in -- it is a field the
-- globals sheet cannot render and update-globals cannot address. Shipping the
-- table without its rows would ship a settings screen with nothing on it.
--
-- Source of truth, read rather than assumed:
--
--   content/globals/.gitkeep          the ONLY file in content/globals/. There
--                                     is nothing to migrate and everything to
--                                     build: every value below currently lives
--                                     as a template literal, so this migration
--                                     promotes hardcoded values into managed
--                                     data. The values are identical; only
--                                     their home changes.
--   resources/views/layout.antlers    the address (:46-47), phone (:48), fax
--     .html                           (:49), email (:50), Instagram (:51) and
--                                     Facebook (:52) links, the donate call to
--                                     action (:54), the logo (:33), the Google
--                                     Ads tag (:4) and both StatCounter values
--                                     (:85, :87, and again in the noscript
--                                     pixel at :95).
--   content/addons/plugrbase-         the three maintenance-mode values,
--     maintenance-mode.yaml           carried across verbatim. The whole file is
--                                     three lines.
--   content/collections/pages/        the Blackbaud family-portal URL at :61,
--     deposits.md                     sitting inside a replicator set whose
--                                     `enabled: false` is at :69 -- recovered,
--                                     not invented, and seeded UNCONFIRMED.
--   content/collections/pages/        the `intro` field at :15, trimmed on a
--     home.md                         word boundary for site_description.
--
-- What this file deliberately does NOT do, because another migration or another
-- layer owns it:
--
--   policies          migration 17. RLS is ENABLED here and zero policies are
--                     written, so the table is closed until 17 opens it. That
--                     policy set reads the `public` column created here: anon
--                     gets `select` where public = true, and nothing else.
--   get_maintenance_  migration 16. The four maintenance rows are private, so
--     state()         the cookie-free anonymous client cannot read them, yet
--                     nextjs/proxy.ts must evaluate maintenance on every
--                     request including anonymous ones. A single security
--                     definer function granted to anon resolves that, returning
--                     only the flag and the retry seconds to an unidentified
--                     caller. It is the ONLY privileged read on the anonymous
--                     path in this schema.
--   update-globals    migration 16, discriminated by key. It is also the home of
--                     every per-key validation: phone and fax normalized to
--                     E.164 for tel:, email validated, the absolute-https host
--                     allowlist, the schema.org time specification, and the
--                     banner_variant enumeration. Together with
--                     nextjs/lib/schema.ts, that is why this file carries no URL
--                     or format check constraints -- see section 2.
--   storage buckets   migration 18.
--   the donate page   migration 5. The donate heading and paragraph are promoted
--     copy            out of resources/views/donate.antlers.html:4-5 into
--                     page_sections rows on the donate page, NOT into globals:
--                     they are that one page's content, not a site-wide setting.
--                     (They also carry the single authorized prose change in the
--                     entire corpus, "You support" -> "Your support". No prose
--                     change is authorized in this file; see section 7.)
--
-- Every statement is idempotent -- `create table if not exists`, `drop
-- constraint if exists` before `add constraint`, `create index if not exists`,
-- `drop trigger if exists` before `create trigger`, and a seed guarded by `on
-- conflict (key) do nothing` -- so applying all eighteen migrations twice is
-- clean AND the row count is identical after both runs. That second property is
-- the one that matters here and is the one a seeding migration can get wrong.
--
-- Conventions (lowercase SQL, `text` never varchar(n), the explicit
-- timezone('utc', now()) timestamp form, schema-qualified extensions calls, and
-- jsonb only where the structure is genuinely variable) are stated once in
-- migration 01 and followed here. Migration 01's schema contract names
-- site_globals.value explicitly as one of its six sanctioned jsonb columns.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
-- Column-by-column rationale is carried in the `comment on column` statements in
-- section 6 rather than duplicated here, because those comments survive into the
-- database and remain readable once content/ has been deleted.

create table if not exists public.site_globals (

  -- Identity. gen_random_uuid() is schema-qualified because migration 01 pins
  -- search_path = '' inside its functions and makes qualification the absolute
  -- project rule. Rows are addressed by `key` everywhere in the application, so
  -- this column exists to be a stable primary key and a revision target, not to
  -- be quoted in a query.
  id          uuid primary key default extensions.gen_random_uuid(),

  -- The closed key set. `unique` is load-bearing rather than hygienic: it is the
  -- conflict target the section 7 seed relies on to stay idempotent.
  key         text not null unique,

  -- The value. Genuinely variable in shape across the twenty-six keys, which is
  -- what earns the jsonb; see the column comment for why that is not a licence
  -- to make this table a JSON dump.
  value       jsonb,

  -- The typed logo reference. Nullable, and used by exactly one key. NO on-delete
  -- action on purpose: deleting a referenced asset must be BLOCKED.
  asset_id    uuid references public.assets (id) on delete no action,

  -- The human label the globals sheet renders beside the control.
  label       text,

  -- Which editor tab the key belongs to. GROUP is a reserved keyword in
  -- PostgreSQL and cannot appear unquoted, so it is written "group" in every
  -- statement in this file and must be written that way everywhere else.
  "group"     text not null,

  -- The visibility flag migration 17's anonymous policy reads.
  public      boolean not null default false,

  -- Stable field order within a tab.
  sort_order  integer not null default 0,

  -- Operational timestamps describing target writes. `updated_at` is maintained
  -- exclusively by the trigger in section 4; no application code writes it.
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now())
);


-- -----------------------------------------------------------------------------
-- 2. Check constraints
-- -----------------------------------------------------------------------------
-- Declared as explicitly-named `alter table` statements rather than inline, for
-- the two reasons migration 02 gives: the names are then stable and greppable
-- instead of server-generated, and the `drop constraint if exists` /
-- `add constraint` pair re-asserts each definition on a second apply, so this
-- file converges even against a table that already exists with a drifted
-- constraint.
--
-- There are deliberately NO checks on the SHAPE of `value`, and that is a
-- decision rather than an omission. Every such check would have to be
-- discriminated by key -- phone is E.164, email is an address, opening_hours is
-- a schema.org time specification, banner_variant is an enumeration,
-- maintenance_retry_after is a positive integer -- which is precisely what
-- nextjs/lib/schema.ts and the update-globals function in migration 16 already
-- do. Duplicating that here would give the project two sources of truth for one
-- rule, and the copy in SQL is the one nobody would remember to change.
--
-- One of those would-be checks would also be outright WRONG. A rule requiring
-- every URL key to be absolute https looks obviously correct and would reject
-- donate_url, whose migrated value is the root-relative `/donate`. See section 7.

-- The closed key set. This is what makes the set *closed*: update-globals in
-- migration 16 is discriminated by key, and a key this constraint does not admit
-- cannot be invented at runtime -- an insert naming one fails here rather than
-- appearing as a phantom setting the globals sheet cannot render.
--
-- ADDING A KEY IS A MIGRATION, NOT A DATA ENTRY. A new key needs this list
-- extended, a seed row, a shape in nextjs/lib/schema.ts, a branch in
-- update-globals, and a control in GlobalsSheet.tsx. That cost is intentional:
-- it is what stops site-wide settings accreting into an untyped bag.
--
-- Twenty-six keys, grouped here in tab order to match section 7 and to make the
-- count checkable by eye: 8 + 4 + 4 + 2 + 3 + 4 + 1.
alter table public.site_globals drop constraint if exists site_globals_key_check;
alter table public.site_globals add constraint site_globals_key_check
  check (key in (
    -- contact (8)
    'address_line_1', 'address_locality', 'address_region', 'address_postal',
    'phone', 'fax', 'email', 'opening_hours',
    -- social (4)
    'instagram_url', 'facebook_url', 'donate_url', 'family_portal_url',
    -- branding (4)
    'logo', 'logo_alt', 'site_name', 'tagline',
    -- announcement (2)
    'banner_enabled', 'banner_variant',
    -- analytics (3)
    'google_ads_id', 'statcounter_project', 'statcounter_security',
    -- maintenance (4)
    'maintenance_enabled', 'maintenance_title', 'maintenance_message',
    'maintenance_retry_after',
    -- seo (1)
    'site_description'
  ));

-- The seven groups. Six are the globals sheet's six tabs -- Contact and Address,
-- Social and Portal Links, Branding, Announcement Presentation, Analytics,
-- Maintenance -- and `seo` is the seventh, holding the one terminal fallback
-- description that is site-wide but is not a tab of its own.
alter table public.site_globals drop constraint if exists site_globals_group_check;
alter table public.site_globals add constraint site_globals_group_check
  check ("group" in (
    'contact', 'social', 'branding', 'announcement', 'analytics',
    'maintenance', 'seo'
  ));

-- Deliberately absent: a constraint pairing each key to its group, which would
-- have to restate all twenty-six keys a second time. The pairing is fixed by the
-- section 7 seed and cannot drift afterwards, because update-globals writes
-- `value` and `asset_id` only and never `key` or `"group"`, and migration 17
-- revokes direct DML on this table from `authenticated`. A second copy of the
-- key list would be two things to keep in step for a risk that no code path
-- reaches.

-- `sort_order` is a position within a tab, so zero is the floor. The column
-- default is 0 and every seeded row overrides it; a negative value could only be
-- a bug in a reorder.
alter table public.site_globals drop constraint if exists site_globals_sort_order_check;
alter table public.site_globals add constraint site_globals_sort_order_check
  check (sort_order >= 0);


-- -----------------------------------------------------------------------------
-- 3. Row level security
-- -----------------------------------------------------------------------------
-- Enabled immediately, per the project idiom, and with ZERO policies. That
-- combination is intentional and is not an oversight: until migration 17 adds
-- policies, neither `anon` nor `authenticated` can read or write a single row.
-- For this table the closed default matters more than for most, because four of
-- its rows are the maintenance copy, and the interstitial's wording is something
-- an anonymous reader should not be able to read BEFORE the school has used it.
--
-- The section 7 seed below is unaffected: a migration runs as the table owner,
-- and RLS does not apply to it. `force row level security` is deliberately NOT
-- set -- it would subject the owner to policies too and break both this seed and
-- the canonical supabase/seed.sql load.
--
-- Migration 17 owns the policy set: anon `select` where public = true (which is
-- every row except the four maintenance keys), authenticated `select` over
-- everything given active membership, and write requiring the `admin` role
-- rather than mere authentication -- editing analytics identifiers or switching
-- the site into maintenance is not a day-to-day editorial act.

alter table public.site_globals enable row level security;


-- -----------------------------------------------------------------------------
-- 4. The updated_at trigger
-- -----------------------------------------------------------------------------
-- Attaches the one shared function from migration 01, so `updated_at` can be
-- neither forged nor forgotten: no application code and no write function in
-- migration 16 may set the column. This is the named fidelis weakness the
-- project corrects -- that reference declares the column with a default and then
-- creates no trigger anywhere, leaving it truthful only until the first edit.
--
-- It earns its place here rather than being boilerplate: `updated_at` on this
-- table is what the editor's optimistic conflict check compares, so a stale
-- value would turn a lost edit into a silent one.
--
-- `created_at` is deliberately left as a column default only.

drop trigger if exists set_site_globals_updated_at on public.site_globals;

create trigger set_site_globals_updated_at
  before update on public.site_globals
  for each row
  execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Indexes
-- -----------------------------------------------------------------------------
-- `key` is already indexed by its unique constraint and is the only access path
-- the application uses for a single setting, so it is not repeated here. The
-- three below back specific, named access paths rather than being added
-- speculatively.

-- The globals sheet renders one tab at a time, and the seed and export tooling
-- both walk the table group by group.
create index if not exists site_globals_group_idx
  on public.site_globals ("group");

-- Migration 17's anonymous policy filters on this column, so every anonymous
-- read of a site-wide setting goes through it.
create index if not exists site_globals_public_idx
  on public.site_globals (public);

-- The reverse asset lookup: before deleting an asset the editor must list the
-- rows referencing it, and migration 17's anonymous asset policy asks whether a
-- public site_globals key references the asset -- the clause that keeps the
-- school logo reachable without a session. Both queries search by asset_id.
create index if not exists site_globals_asset_id_idx
  on public.site_globals (asset_id);


-- -----------------------------------------------------------------------------
-- 6. Comments
-- -----------------------------------------------------------------------------
-- These are the durable record. This file deletes nothing, but content/ and
-- resources/ are removed at the end of the migration phase, so after cutover the
-- database itself is the only place a reader can learn why a key exists, where
-- its value came from, or what its shape is meant to be.

comment on table public.site_globals is
  'Site-wide settings: one row per key, twenty-six keys, closed by check '
  'constraint. Everything here was a hardcoded template literal in '
  'resources/views/layout.antlers.html or content/addons/'
  'plugrbase-maintenance-mode.yaml -- content/globals/ held nothing but a '
  '.gitkeep -- so this table is the requirement that site data appearing in '
  'multiple places be edited in one place and NOT edited in place on the page. '
  'It is not an arbitrary JSON store: the key set is closed, each key declares '
  'its shape, update-globals in migration 16 is discriminated by key, and the '
  'logo is a typed foreign key rather than a path inside a jsonb value. The '
  'four maintenance rows are the only private ones.';

comment on column public.site_globals.key is
  'The setting name, and the only identifier the application uses -- '
  'update-globals in migration 16 is discriminated by this value, and '
  'GlobalsSheet.tsx addresses a control by it. Closed by '
  'site_globals_key_check, which enumerates all twenty-six permitted keys. '
  'ADDING A KEY IS A MIGRATION, NOT A DATA ENTRY: it needs the check extended, '
  'a seed row, a shape in nextjs/lib/schema.ts, a branch in update-globals and '
  'a control in the globals sheet. The unique constraint is also the conflict '
  'target that keeps this migration''s own seed idempotent.';

comment on column public.site_globals.value is
  'The setting''s value. jsonb because the shape is GENUINELY variable across '
  'the key set and no single typed column could serve it: twenty-one keys hold '
  'text, three hold a boolean or an integer, family_portal_url holds an object '
  'carrying its own confirmation flag, and opening_hours will hold a structured '
  'schema.org time specification. That is the whole justification, and it is '
  'deliberately narrow -- this is NOT licence to treat the table as a JSON '
  'dump. It is the correction of the fidelis reference''s `store_hours jsonb '
  'default ''[]''::jsonb`, an untyped bag with no closed key set, no per-key '
  'shape and no visibility column. Here the key set is closed by check, each '
  'key''s shape is declared and validated by nextjs/lib/schema.ts and '
  'update-globals, and any value that has a name and a type of its own gets a '
  'real column instead -- which is exactly why asset_id exists. Nullable: '
  'opening_hours and three branding keys seed empty rather than inventing a '
  'value.';

comment on column public.site_globals.asset_id is
  'Typed reference to public.assets, used by exactly one key: logo. It is a '
  'foreign key rather than a path inside `value` for two concrete reasons. '
  'First, reference blocking -- deleting an asset that any row references is '
  'refused and the editor lists the referencing rows, and a path buried in '
  'jsonb could not participate in that, so the school logo could be deleted out '
  'from under the header. Second, anonymous visibility -- migration 17 grants '
  'anon `select` on an asset referenced by a published row OR by a public '
  'site_globals key, and that second clause is a join on this column, so it is '
  'what keeps the logo reachable without a session. NO on-delete action is '
  'declared, which means NO ACTION: the delete is blocked. NO ACTION rather '
  'than RESTRICT on purpose -- both refuse a bare `delete from assets`, but NO '
  'ACTION is checked at end of statement, so migration 16''s atomic asset '
  'replacement can repoint this column and delete the outgoing row inside one '
  'transaction, which RESTRICT''s immediate check would refuse.';

comment on column public.site_globals."group" is
  'Which editor surface the key belongs to: contact, social, branding, '
  'announcement, analytics, maintenance, or seo. The first six are the globals '
  'sheet''s six tabs; seo holds the one terminal fallback description, which is '
  'site-wide but not a tab. GROUP is a reserved keyword in PostgreSQL and '
  'CANNOT appear unquoted -- it is written "group" throughout this migration '
  'and must be written that way in every policy, function and query. The name '
  'is kept because the plan names the column `group` and because '
  'supabase gen types and every PostgREST filter follow whatever is chosen '
  'here; renaming it later is a breaking change for the globals sheet.';

comment on column public.site_globals.public is
  'Whether an anonymous visitor may read the row. Migration 17''s anon policy '
  'is `select` where public = true and nothing more, so this column IS the '
  'anonymous read boundary for site-wide settings. Twenty-two rows are true; '
  'the four maintenance keys are false, because the interstitial''s title and '
  'message should not be readable before the school has used them. Default '
  'FALSE is deliberate: a key added by a later migration is private until '
  'somebody says otherwise, so the failure mode of forgetting this column is a '
  'setting that does not render rather than one that leaks. This column is the '
  'correction of the fidelis reference''s `site_business_info ... for select '
  'using (true)`, which had no visibility column at all and therefore no way to '
  'hold anything back.';

comment on column public.site_globals.label is
  'The human label the globals sheet renders beside the control. Held in the '
  'database rather than in the component so the tab that lists the keys and the '
  'words describing them cannot drift apart, and so a wording fix is a data '
  'edit rather than a deploy.';

comment on column public.site_globals.sort_order is
  'Position within the key''s own tab, one-based in the seed. It exists so the '
  'globals sheet renders a stable, deliberate field order -- address before '
  'phone before email -- instead of whatever order a select happens to return. '
  'Ordering is per group, so values repeat across groups and are not unique.';


-- -----------------------------------------------------------------------------
-- 7. The seed -- all twenty-six keys
-- -----------------------------------------------------------------------------
-- Idempotency: ONE insert, guarded by `on conflict (key) do nothing` against the
-- unique constraint on `key`. One idiom, used for every row. A second apply
-- inserts nothing and updates nothing, so the row count after two runs is
-- identical to the count after one -- the property this file is most able to get
-- wrong and the highest-value assertion against it.
--
-- `do nothing` rather than `do update` is the right half of that choice: this
-- migration establishes the school's STARTING values, it does not own them
-- afterwards. Once staff have corrected a phone number through the globals
-- sheet, a re-apply of the schema must not quietly reinstate the migrated one.
--
-- Values are built with to_jsonb(<literal>::text) rather than hand-written jsonb
-- string literals. That is not stylistic: two of these values contain an
-- apostrophe, and nesting SQL quoting inside JSON quoting inside a SQL literal
-- is exactly how a byte-for-byte migration stops being byte-for-byte. to_jsonb
-- does the JSON quoting, so the only escaping in this file is SQL''s own doubled
-- apostrophe.
--
-- FIDELITY: every value below is the source value, unchanged. No prose in this
-- file is edited, corrected or improved -- see the maintenance_message note.
-- Where a key has no source value at all it is seeded EMPTY and says so; the
-- three cases where a default had to be chosen are labelled CHOSEN so a reader
-- can tell an invention from a migration.

insert into public.site_globals (key, "group", label, public, sort_order, value) values

  -- --- contact (8) · tab "Contact and Address" -------------------------------
  -- resources/views/layout.antlers.html:46-50, the sidebar address block. The
  -- single source line `Cambridge, MA 02138` (:47) is split into three keys
  -- because StructuredData emits schema.org addressLocality, addressRegion and
  -- postalCode separately, and a Preschool node cannot be assembled from one
  -- pre-joined string.
  ('address_line_1',   'contact', 'Street address',   true, 1,
    to_jsonb('80 Trowbridge St.'::text)),
  ('address_locality', 'contact', 'City',             true, 2,
    to_jsonb('Cambridge'::text)),
  ('address_region',   'contact', 'State',            true, 3,
    to_jsonb('MA'::text)),
  ('address_postal',   'contact', 'ZIP code',         true, 4,
    to_jsonb('02138'::text)),

  -- Stored exactly as the source renders them, hyphens included. The E.164
  -- normalization for tel: hrefs happens in nextjs/lib/schema.ts on write and in
  -- the renderer on read -- not here, because the value staff see and edit
  -- should be the value the page shows.
  ('phone',            'contact', 'Phone',            true, 5,
    to_jsonb('617-354-0014'::text)),
  ('fax',              'contact', 'Fax',              true, 6,
    to_jsonb('617-491-4313'::text)),
  ('email',            'contact', 'Email',            true, 7,
    to_jsonb('info@cambridge-ellis.org'::text)),

  -- EMPTY BY DESIGN, and this one is worth being explicit about. No opening-hours
  -- value exists anywhere in content/ or in the layout, so there is nothing to
  -- migrate and nothing may be invented -- publishing school hours the school did
  -- not state would be worse than publishing none. Null, not an empty structure,
  -- so the absence is unambiguous. StructuredData omits the schema.org
  -- openingHours property ENTIRELY until this is populated: an absent
  -- structured-data property is correct, a wrong one actively misleads a parent.
  -- When populated it must validate as a schema.org time specification, enforced
  -- by nextjs/lib/schema.ts.
  ('opening_hours',    'contact', 'Opening hours',    true, 8,
    null::jsonb),

  -- --- social (4) · tab "Social and Portal Links" ----------------------------
  -- resources/views/layout.antlers.html:51-52. Absolute https, and validated
  -- against a host allowlist on write.
  ('instagram_url',    'social',  'Instagram URL',    true, 1,
    to_jsonb('https://www.instagram.com/cambridgeellis/'::text)),
  ('facebook_url',     'social',  'Facebook URL',     true, 2,
    to_jsonb('https://www.facebook.com/CambridgeEllisSchool/'::text)),

  -- ROOT-RELATIVE BY DESIGN. resources/views/layout.antlers.html:54 is
  -- `<a href="/donate">`, an internal page, not an external payment host. DO NOT
  -- "normalize" this to an absolute https URL: the target is this site's own
  -- /donate route, so an absolute form would hardcode the hostname, break every
  -- preview deployment, and force a full page load where client routing should
  -- happen. This is the documented exception to the absolute-https rule the other
  -- three URL keys follow, and it is exactly why no URL check constraint exists
  -- in section 2 -- a plausible one would reject this row.
  ('donate_url',       'social',  'Donate link',      true, 3,
    to_jsonb('/donate'::text)),

  -- RECOVERED, NOT INVENTED, AND SHIPPED UNCONFIRMED. The URL was found at
  -- content/collections/pages/deposits.md:61, inside a replicator set whose
  -- `enabled: false` sits at :69 -- so it is real, the school authored it, and it
  -- has been switched off for long enough that nothing can vouch for it still
  -- resolving. This is the ONE key in this group whose value is an object rather
  -- than a string: `{"url": ..., "confirmed": false}`. The flag is inside `value`
  -- so it travels with the URL through export, import and revision history and
  -- cannot be separated from it. CONTRACT FOR RENDERERS: NavTree and SiteFooter
  -- must treat `confirmed` being anything other than true as "hide the item"
  -- entirely. Shipping a dead link into an enrolled-family journey would be worse
  -- than shipping nothing, and an enrolled parent who clicks a broken portal link
  -- has been failed more expensively than one who never saw it.
  ('family_portal_url', 'social', 'Family portal URL', true, 4,
    jsonb_build_object(
      'url', 'https://bngn.blackbaud.school/?id=yrwunmzuxfg#/home/',
      'confirmed', false
    )),

  -- --- branding (4) · tab "Branding" -----------------------------------------
  -- LOGO: value AND asset_id are both null here, necessarily. The source is
  -- resources/views/layout.antlers.html:33, `/assets/CESHouseLogo.png`, but
  -- public.assets is EMPTY when migration 11 runs -- the 289 asset rows arrive
  -- with supabase/seed.sql -- so any non-null asset_id would violate the foreign
  -- key and abort this migration. The row exists now so the key set is complete
  -- and the globals sheet has a control to render; the reference is bound later.
  -- BINDING CONTRACT, which supabase/seed.sql must match: after inserting the
  -- asset rows, seed.sql sets this row's asset_id to the asset whose legacy_ref
  -- is 'CESHouseLogo.png', equivalently public.ces_uuid('assets',
  -- 'CESHouseLogo.png') from migration 01. Deliberately NOT done by parking the
  -- path in `value` as a hint for the loader to consume and clear: ces_uuid makes
  -- the id derivable without one, and a transitional value somebody must remember
  -- to erase is a transitional value that survives to production.
  ('logo',             'branding', 'Logo',            true, 1,
    null::jsonb),

  -- EMPTY BY DESIGN. The source alt text is `alt="{{title}}"` -- the PAGE TITLE,
  -- so the logo announces itself as "About" on /about and "Tuition" on
  -- /admissions/tuition. That is a misuse, not a value, and seeding it would
  -- migrate the defect instead of the content. A real description is authored at
  -- cutover, alongside the alt text for the informative published assets.
  ('logo_alt',         'branding', 'Logo alt text',   true, 2,
    null::jsonb),

  ('site_name',        'branding', 'Site name',       true, 3,
    to_jsonb('Cambridge-Ellis School'::text)),

  -- EMPTY BY DESIGN. No tagline exists in the source. Inventing one would be
  -- writing brand copy for the school, which is not this migration's to write.
  ('tagline',          'branding', 'Tagline',         true, 4,
    null::jsonb),

  -- --- announcement (2) · tab "Announcement Presentation" --------------------
  -- Both values are CHOSEN, not migrated: the legacy banner had no settings at
  -- all, only markup. Off is the safe default and also the honest one -- the
  -- announcement banner shows nothing today regardless, because the only
  -- published announcement carries feature_on_homepage: false while all three
  -- that carry true are drafts. Switching it on here would promise a banner with
  -- no content behind it.
  -- This tab holds ONLY the switch and the style. The banner's text and target
  -- live in the announcements table (migration 10) and are edited there, so a
  -- single announcement has a single owner and a single editing path.
  ('banner_enabled',   'announcement', 'Show announcement banner', true, 1,
    to_jsonb(false)),

  -- CHOSEN. 'brand' names the lime band the legacy site actually rendered
  -- (--color-brand-banner), so the default reproduces the look staff already
  -- know; it is the only variant with a legacy precedent, which is why no others
  -- are invented here. The permitted set is nextjs/lib/schema.ts's to define and
  -- update-globals's to enforce -- deliberately not a check constraint, so adding
  -- a style is a front-end change rather than a migration.
  ('banner_variant',   'announcement', 'Banner style', true, 2,
    to_jsonb('brand'::text)),

  -- --- analytics (3) · tab "Analytics" ---------------------------------------
  -- These are CONTENT, not environment variables, and that is a deliberate
  -- design choice: held here they are present in the committed fallback JSON, so
  -- both tags work in the keyless state before any Supabase key exists, and staff
  -- can correct a mistyped identifier without a redeploy.
  -- google_ads_id is resources/views/layout.antlers.html:4, where AW-11332213588
  -- appears twice -- in the gtag script's querystring and in gtag('config', ...).
  -- One source value, two render sites.
  ('google_ads_id',        'analytics', 'Google Ads tag ID', true, 1,
    to_jsonb('AW-11332213588'::text)),

  -- statcounter_project is :85 (`var sc_project=12673899;`) and
  -- statcounter_security is :87 (`var sc_security="24719029";`). BOTH appear a
  -- second time, together, in the noscript pixel URL at :95 --
  -- https://c.statcounter.com/12673899/0/24719029/1/ -- so both must be carried
  -- in both places or the noscript fallback silently stops counting. Stored as
  -- text, not numbers, even though sc_project is a JS numeric literal: both are
  -- opaque identifiers that go into a URL path, and text is what forbids
  -- arithmetic on them or a leading zero being eaten.
  ('statcounter_project',  'analytics', 'StatCounter project ID', true, 2,
    to_jsonb('12673899'::text)),
  ('statcounter_security', 'analytics', 'StatCounter security token', true, 3,
    to_jsonb('24719029'::text)),

  -- --- maintenance (4) · tab "Maintenance" -----------------------------------
  -- THE ONLY FOUR PRIVATE ROWS IN THIS TABLE: public = false on all of them, so
  -- an anonymous reader cannot read the interstitial's copy before the school has
  -- used it. That privacy is why migration 16 needs get_maintenance_state(): the
  -- request boundary must evaluate maintenance on every request, including
  -- anonymous ones, and the cookie-free anon client cannot read these rows.
  --
  -- Source: content/addons/plugrbase-maintenance-mode.yaml, whole file, three
  -- lines. FALSE, never true -- enabling maintenance in a migration would take
  -- the site down the moment the schema is pushed.
  ('maintenance_enabled', 'maintenance', 'Maintenance mode', false, 1,
    to_jsonb(false)),

  ('maintenance_title',   'maintenance', 'Maintenance heading', false, 2,
    to_jsonb('We''ll be right back'::text)),

  -- VERBATIM, INCLUDING THE TYPO. The source reads "Stay tooned!" and it is
  -- copied byte for byte: 102 characters, the apostrophe in "We're" is ASCII 0x27
  -- doubled for SQL, the exclamation mark is the source's. DO NOT CORRECT
  -- "tooned" TO "tuned". Exactly one prose change is authorized in this entire
  -- migration -- the donate page's "You support" -> "Your support", which belongs
  -- to migration 5 -- and this is not it. A parity test diffs this value against
  -- the source YAML while that file still exists.
  ('maintenance_message', 'maintenance', 'Maintenance message', false, 3,
    to_jsonb('We''re making some changes on our site, and expect to be back online in the next 24 hours. Stay tooned!'::text)),

  -- CHOSEN, not migrated: the addon had no retry value. 3600 seconds, emitted by
  -- nextjs/proxy.ts as Retry-After beside the 503. One hour rather than the
  -- 86400 the message's "next 24 hours" might suggest, and the two do not
  -- conflict: Retry-After is a backoff hint telling a crawler when to come back,
  -- not a promise about the outage window, and a short value means the site is
  -- re-crawled promptly once it returns instead of being left stale for a day.
  -- Editable from the globals panel if a longer window is genuinely planned.
  ('maintenance_retry_after', 'maintenance', 'Retry after (seconds)', false, 4,
    to_jsonb(3600)),

  -- --- seo (1) · the terminal metadata fallback ------------------------------
  -- The school's OWN WORDS, from content/collections/pages/home.md:15's `intro`
  -- field -- 281 characters of real prose -- trimmed on a word boundary to 154
  -- characters including a single-character ellipsis. Not generated, not written
  -- here.
  -- It exists so that no route can EVER emit an empty meta description. It is the
  -- last step of the per-template description chain in nextjs/lib/seo.ts, reached
  -- only when a page has no prose of its own to offer. The chain also applies a
  -- guard that this key is the reason for: a candidate is rejected if it is empty,
  -- shorter than 50 characters, or entirely enclosed in square brackets -- because
  -- content/collections/pages/events.md's description is literally "[no need to
  -- put anything here; use the Events collection to add events]", a staff note to
  -- themselves that an ungated fallback would publish into Google's results. That
  -- guard lives in seo.ts, not here; this value is what the guard falls back TO,
  -- and it passes every clause of it.
  ('site_description', 'seo', 'Default meta description', true, 1,
    to_jsonb('We are a small, non-profit preschool located in the heart of Cambridge. Our mission is to provide a joyful, warm, and stimulating first school experience…'::text))

on conflict (key) do nothing;
