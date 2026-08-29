# Migration tooling (`tools/`)

The six TypeScript programs in `src/` are the whole of the Cambridge-Ellis School
migration off Statamic 3.4 / Laravel 8 and onto Next.js, Supabase and Vercel:
they read the flat-file corpus, emit the database load and the committed
fallback snapshot, push the media, prove that nothing was lost, and provision
the two administrator accounts.

This file is the **authoritative home of the tooling's input contract** —
section 2 — and the per-script CLI reference. It is not a second copy of the
runbook; see [Who owns what](#14-who-owns-what) below.

| Script | npm script | Produces | Runs |
| --- | --- | --- | --- |
| `build-asset-manifest.ts` | `asset-manifest` | `artifacts/assets.manifest.json` | first, against a Statamic checkout |
| `extract-statamic-content.ts` | `extract` | 14 fallback JSON files, `supabase/seed.sql`, 3 artifacts | second, against the same checkout |
| `upload-assets.ts` | `upload-assets` | objects in Storage | after the school supplies keys |
| `verify-parity.ts` | `verify:parity` | `artifacts/parity-report.json` | at every gate, before and after cutover |
| `bootstrap-admins.ts` | `bootstrap-admins` | two invitations, two `admin_users` rows | once, after keys |
| `export-fallback.ts` | `export-fallback` | the same 14 fallback JSON files | after cutover, then monthly |

---

## 1. What this project is

### 1.1 A second, self-contained npm project

`tools/` is its own npm project, with its own `package.json`,
`package-lock.json`, `tsconfig.json` and `eslint.config.mjs`. It is **not** a
workspace member of the application and shares no dependency tree with it.

It is **never installed by the deployment.** The Vercel Root Directory is
`nextjs/`, so Vercel installs and builds inside that directory and this project
is outside it by construction — nothing here can reach a visitor's browser or a
production server.

That bounds the blast radius; it does not lower the bar. These programs decide
what the school's content becomes, so they are still typechecked, linted, tested
and dependency-audited on every commit (section 7).

The separation is deliberate rather than incidental. These programs need
filesystem access, a YAML parser, a zip reader and a service-role Supabase
client; the application needs none of those, and folding the two together would
put the tooling's dependencies on the deployment's critical path.

### 1.2 Permanent, not scaffolding

A reader's default assumption about a folder called `tools/` is that it can be
deleted once the migration is done. That assumption is wrong here, and acting on
it would destroy capability the project depends on.

**Nothing under `tools/` is ever deleted.**

Four of the six scripts have not even run by the time the migration code is
finished, because they need credentials that arrive afterwards:

- `upload-assets.ts` — pushes the 289 media binaries into Storage.
- `bootstrap-admins.ts` — creates the two administrator accounts.
- `verify-parity.ts` — gates every step of cutover, and writes the readiness row
  that is the only thing that makes `CONTENT_SOURCE=supabase` mean anything.
- `export-fallback.ts` — refreshes the committed rollback snapshot, immediately
  after cutover and monthly thereafter, for as long as the site is live.

The two extraction programs are retained for two further reasons:

- **The content freeze can be lifted.** Extraction is rerunnable against a newer
  source commit (section 2.3), so a late content edit is a re-run and a
  re-verify rather than a lost change.
- **Provenance.** Anyone auditing a migrated value — asking why a row holds what
  it holds — needs to read the code that produced it. Deleting the extractor
  would leave `supabase/seed.sql` as an unexplained artifact.

What changes after the migration is not whether these programs exist but **what
they are pointed at**, which is exactly what section 2 specifies.

### 1.3 Prerequisites

```bash
cd tools
npm ci
```

- **Node.js ≥ 22.22.2.** `nextjs/.nvmrc` is the single source of truth for that
  version; `engines.node` in both `package.json` files mirrors it and must not
  be edited here alone. The floor is imposed by the application's test
  toolchain, not by anything in this project.
- **`npm ci`, not `npm install`.** The lockfile is committed and every version
  in `package.json` is an exact pin — no `^`, no `~`, no ranges. A range would
  let a transitive change alter extracted content, and a content-transformation
  bug is a content bug.

**A container runtime and the Supabase CLI are *not* prerequisites of this
project.** They belong to `supabase/` and to the CI jobs that start a local
stack. Nothing in `tools/` starts a database, and only the four scripts in
section 6 talk to one at all.

### 1.4 Who owns what

This file and the root `README.md` are kept deliberately disjoint, because a
runbook duplicated in two places becomes two runbooks that disagree.

| Owned by the root `README.md` | Owned by this file |
| --- | --- |
| The environment contract, and the hosted Supabase configuration | The per-script CLI reference (section 3) |
| The ordered cutover runbook, with per-step verification | The input contract (section 2) |
| The production-domain runbook | The tooling's own invariants (section 5) |
| The CSP and HSTS promotion procedures | The authorized content transformations (section 4) |
| The school-approval gates | The known source-integrity cases (section 8) |

Canonical environment-variable names live in `nextjs/.env.example`, which
documents each one's exposure, its default and its behaviour when absent. This
file names the variables each script needs and points there rather than
restating their semantics — see section 6.

Where a step genuinely has to appear in both documents, it is restated
identically rather than paraphrased.

---

## 2. The input contract

> **The two extraction programs read a Statamic checkout that this repository no
> longer contains.** They take a required `--source <path>` argument naming the
> root of that checkout. There is no default.

This is the one section to read before running anything.

### 2.1 The argument

```bash
npm run asset-manifest -- --source <path-to-a-statamic-checkout>
npm run extract        -- --source <path-to-a-statamic-checkout>
```

`--source` is **required**, and the programs exit with a non-zero status and a
message naming this section if it is missing or if the directory it names does
not contain `content/`.

There is deliberately **no implicit default to the current working tree**,
because after the migration the working tree does not hold the inputs. The
migration removed `content/`, `resources/`, `public/assets/`, `config/`, `users/`
and the rest of the Laravel and Statamic layer. A program that silently fell
back to `.` would not fail — it would find nothing, and emit an empty corpus
over a good one. Requiring the argument converts that silent catastrophe into an
immediate error.

The path must be the **root** of the checkout, not a subdirectory: the inputs
span `content/`, `resources/views/`, `resources/sass/`, `public/css/` and
`public/assets/`, and section 3.1 explains why the set is wider than `content/`.

The other four programs take no `--source`. They read the artifacts these two
produce, and Supabase.

### 2.2 Producing the path

**Before deletion — during the migration phase only, and that phase is over.**
Recorded for provenance rather than for use: while the legacy tree was still
checked out, it *was* the working tree, so the argument pointed at the repository
root. This form no longer resolves in this repository and is not the path to
reach for.

```bash
cd tools
npm run asset-manifest -- --source ..
npm run extract        -- --source ..
```

**After deletion — the normal case from now on.** The inputs are still in git
history; they are simply not checked out. Materialise the revision into a
temporary directory and point at that.

A linked worktree is the cheapest option, because it shares the object store and
copies nothing:

```bash
# from the repository root
git worktree add --detach /tmp/ces-src 052173f

cd tools
npm run asset-manifest -- --source /tmp/ces-src
npm run extract        -- --source /tmp/ces-src

# when finished
cd .. && git worktree remove /tmp/ces-src
```

Pass `--detach` explicitly. The revision is a commit rather than a branch, and
being explicit about the detached checkout keeps the command honest about what
it is doing. The worktree never changes the branch you are on, and
`git worktree list` confirms it disappeared after the removal.

If you would rather have a detached copy with no link to the repository — to
hand to another tool, or to keep after the branch moves on:

```bash
mkdir -p /tmp/ces-src
git archive 052173f | tar -x -C /tmp/ces-src
```

Both produce an identical tree. Use the worktree for routine work and the
archive when you want something that outlives the repository state; delete
whichever you made when you are done, since it is a full copy of a corpus
containing about 363 MB of media.

### 2.3 The reference revision, the freeze, and re-running

**Commit `052173f` is the reference revision.** Every count in the technical
specification and in section 9 of this file was measured against it, and it
carries the intact 982-file legacy tree.

**`artifacts/migration-source-manifest.json` records the commit SHA that was
actually extracted**, together with a SHA-256 for every file consumed. That
record — not this paragraph — is the authority for what a given load came from.
Read it before drawing any conclusion about a migrated value.

**The freeze.** Content editing in Statamic is frozen from the extraction commit
until cutover. This is a process commitment the school agrees to, not something
the code can enforce, and the runbook in the root `README.md` states it to them.
The alternative is silent divergence: staff keep editing a CMS whose contents
have already been copied, and nobody discovers the gap until a parent notices a
missing paragraph.

The risk is not hypothetical in this repository. Two Statamic auto-commits sit
after the reference revision — `1a6d129` and `ebf2853`, both titled
`Entry saved`, both touching only
`content/collections/events/festival-of-lights.md`. Statamic's git integration
defaults `enabled`, `automatic` and `push` to true, so an ordinary save in the
Control Panel committed and pushed itself. Between the two revisions that entry
was **published** and its `event_date` moved. Two headline figures move with it:

| Measured at | Draft publish flags | Routable paths, published / draft |
| --- | --- | --- |
| `052173f` (reference) | 55 | 102 / 40 |
| `ebf2853` (two saves later) | 54 | 103 / 39 |

Neither number is wrong. They describe different revisions, which is precisely
why the manifest records which one was read.

**Re-running is supported and is the correct response to a late edit.**
Extraction against a newer commit reports a per-file delta against the
checksums in the existing manifest, so a change that arrived after the freeze
shows up as a named file rather than as a discrepancy discovered later. The
sequence is a re-run and a re-verify, in that order:

```bash
git worktree add --detach /tmp/ces-src <newer-revision>
cd tools
npm run asset-manifest -- --source /tmp/ces-src
npm run extract        -- --source /tmp/ces-src   # reports the per-file delta
npm run verify:parity
cd .. && git worktree remove /tmp/ces-src
```

Because the load is idempotent on `legacy_ref` (section 5.2), re-running does
not duplicate rows.

### 2.4 Why `verify-parity.ts` does not read `content/`

`verify-parity.ts` takes no `--source`, and that is a design decision rather
than an omission. **Its authority is the source manifest, not the flat files.**

The manifest records, per consumed file, its checksum, the keys it yielded, the
route and publish status it produced, its relations and its asset references.
Everything the parity check needs to assert is therefore in a committed
artifact — which is what lets the same program run again, unchanged, after
`content/` is gone, comparing the manifest against both the committed fallback
JSON and the Supabase tables.

That property is the whole reason the manifest exists. A parity tool that read
`content/` would have been usable exactly once.

---

## 3. The six scripts

Presented in the order they run. The first two need a Statamic checkout and no
credentials; the last four need credentials and no checkout.

```text
  --source <checkout>                          after the school supplies keys
  ┌──────────────────────┐                     ┌────────────────────┐
  │ 3.1 asset-manifest   │──assets.manifest──▶ │ 3.4 upload-assets  │
  └──────────┬───────────┘                     └────────────────────┘
             │ (required input)                ┌────────────────────┐
  ┌──────────▼───────────┐   seed.sql ───────▶ │ 3.3 bootstrap-     │
  │ 3.2 extract          │   fallback/*.json   │     admins         │
  └──────────────────────┘   source manifest   └────────────────────┘
                                               ┌────────────────────┐
                                               │ 3.5 verify:parity  │
                                               │ 3.6 export-fallback│
                                               └────────────────────┘
```

### 3.1 `build-asset-manifest.ts`

Classifies every media binary and fixes the one filename map the whole migration
depends on.

```bash
npm run asset-manifest -- --source <path-to-a-statamic-checkout>
```

**Runs first.** Section 3.2 consumes its output.

**Reads** — the binaries themselves, plus **four** separate places a reference to
them can live:

| Root | Why |
| --- | --- |
| `content/collections/**` | the 163 entries that reference images |
| `resources/views/**` | templates referencing assets directly |
| `resources/sass/**` | stylesheets referencing assets |
| `public/css/**` | compiled stylesheets, checked so nothing is missed |
| `public/assets/**` | the binaries themselves, and their `.meta/*.yaml` sidecars |

Scanning templates and stylesheets is not thoroughness for its own sake. It is
the only way `CESHouseLogo.png` is classified correctly: the logo is referenced
by the layout template and by no content entry, so a content-only scan would
place the school's own logo in the unreferenced pile and drop it from the
deployed set.

**Writes** — `artifacts/assets.manifest.json`, holding for all 289 binaries:

- the three classes — deployed (110), draft-only (24), archived (155);
- byte size and SHA-256 per file;
- the seven URL-preserving alias designations (section 5.5);
- the injective `source → normalized` filename map (section 5.1), collision-checked.

**Credentials** — none. This program is a pure function of the checkout.

**Failure modes** — a collision in the filename map is a **hard failure**: two
source files normalizing to one name aborts the run rather than silently
overwriting one with the other. A binary present on disk with no `.meta` sidecar,
or a sidecar with no binary, is reported.

### 3.2 `extract-statamic-content.ts`

Parses the flat-file corpus and emits the database load, the committed fallback
snapshot and the provenance record.

```bash
npm run extract -- --source <path-to-a-statamic-checkout>
```

**Ordering requirement — this program must run *after* section 3.1.** It reads
`artifacts/assets.manifest.json` for asset classes and normalized paths rather
than re-deriving them, so that a filename is normalized exactly once and every
consumer agrees (section 5.1). Run out of order, it exits with a message telling
you to run `asset-manifest` first.

**Reads — deliberately wider than `content/`.** Five things the school owns live
in templates rather than in content, and leaving them behind would lose editable
material:

| Value | Source |
| --- | --- |
| The donate heading and paragraph | `resources/views/donate.antlers.html` |
| The three summer day-length labels | `resources/views/programsumbrellasummer.antlers.html` |
| The maintenance-mode title and message | `content/addons/plugrbase-maintenance-mode.yaml` and the two vendor maintenance views |
| The address, phone, fax, email, social URLs, logo and donate call to action | `resources/views/layout.antlers.html` |
| Both analytics identifiers | `resources/views/layout.antlers.html` |

Promoting these into `site_globals` and `page_sections` changes where a value
lives, never the value itself — with the single documented exception in
section 4.6.

Also read: `content/trees/collections/pages.yaml` (authoritative for the page
hierarchy), `content/taxonomies/**`, and `public/assets/.meta/**` for dimensions
and focal points.

**Writes** — 18 files in three places.

The 14 fallback files, in `nextjs/data/fallback/` — committed, bundled, and what
the site renders from before any key exists:

```text
meta.json          pages.json           promoted.json
taxonomy-terms.json  page-sections.json   announcements.json
assets.json        people.json          inspiring-quotes.json
site-globals.json  events.json          nav-items.json
                   classrooms.json      routes.json
```

Plus:

- `supabase/seed.sql` — the canonical database load. Idempotent on `legacy_ref`,
  and **not** a runtime input; it is applied once, by `psql` (section 6.4).
- `artifacts/route-manifest.json` — all 142 paths with expected anonymous and
  authenticated status.
- `artifacts/corpus-census.json` — every count this migration states,
  regenerated on each run so no figure becomes folklore (section 9).
- `artifacts/migration-source-manifest.json` — the checksummed provenance record
  described in section 2.3.

**Credentials** — none.

**Failure modes** — the program fails loudly rather than degrading:

- An **unresolvable `statamic://entry::<uuid>`** aborts the extraction. Shipping
  an unresolved internal scheme into production would produce a dead link on a
  live page, so this is deliberately fatal rather than a warning (section 4.2).
- A missing `artifacts/assets.manifest.json`, or an asset reference that does not
  resolve through its filename map, aborts.
- A rich-text document that fails the round-trip assertion aborts.

### 3.3 `bootstrap-admins.ts`

Creates the two administrator accounts. One-time, after keys.

```bash
npm run bootstrap-admins
```

**What it does** — invites both addresses through the Auth admin API, carries
their display names into Auth user metadata, and inserts the `admin_users` rows
keyed on the UUIDs the invitations return:

| Address | Role | Display name |
| --- | --- | --- |
| `bekah@cambridge-ellis.org` | `editor` | Bekah |
| `conrad.fulbrook@gmail.com` | `admin` | Conrad |

**Idempotent on email.** Running it twice does not create a second account or a
second `admin_users` row, so an interrupted cutover step is simply re-run.

**Identity, display name and role migrate — credentials never do.** Both legacy
accounts hold bcrypt `$2y$10$` password hashes and no plaintext exists anywhere,
so there is nothing to import even in principle. Each user sets their own
password from the invitation, then enrols a second factor.

Two constraints worth stating because they explain why this program exists at
all rather than a SQL insert:

- `admin_users.user_id` references `auth.users`, so **no row can exist until an
  account does** — and accounts are created only by invitation.
- **No self-service signup path exists and no policy is weakened to allow the
  first insert.** This program runs with the service-role credential precisely
  so that the application's own rules never have to be relaxed to bootstrap it.

**Credentials** — the project URL and the service-role secret key (section 6).

**Failure modes** — a missing or unconfigured SMTP sender is the failure that
matters: the program reports success in creating the users while the invitation
emails never arrive. The root `README.md` requires one live send-and-accept test
per template for that reason.

### 3.4 `upload-assets.ts`

Pushes the media into Storage. After keys.

```bash
npm run upload-assets
```

**Reads** `artifacts/assets.manifest.json` and the relocated binaries under
`archive/`. It **never** reads `public/assets/**`, which no longer exists — this
is the same input-contract discipline as section 2, applied to bytes.

**Writes** — objects in two buckets, by class:

| Class | Count | Destination |
| --- | --- | --- |
| Deployed | 110 | public `media` bucket |
| Draft-only | 24 | private `media-private` bucket |
| Archived | 155 | `media-private` under an `archive/` prefix |

It records each object's dimensions and MIME type through the same normalized
filename map as the database paths, so a file is renamed once and every
reference to it agrees.

**This is the trusted ingestion path, and it is deliberately separate from
editor upload policy.** The legacy asset container declared no restriction at
all, and staff used that freedom: the corpus contains 3 HEIC images, 2 JS files,
2 CSS files and 1 SVG alongside the 274 web images and 7 documents. The editor's
MIME allowlist excludes every one of those — SVG in particular is refused
outright as a script vector. Running this program under the service role against
buckets whose MIME restrictions do not apply to the archive prefix is what
preserves all 289 objects byte-for-byte **without weakening the policy that
governs what staff can upload tomorrow.** Those are two different questions, and
conflating them would trade a permanent security property for a one-time
convenience.

**Credentials** — the project URL and the service-role secret key (section 6).

**Rate limits** — the service role is **exempt** from the per-account write and
upload ceilings, so this bulk load is not throttled. The exemption is recorded
rather than hidden: it applies to the service role only, no user role is exempt,
and a bulk load is precisely the case the ceilings are not meant to catch.

**Failure modes** — every upload is verified after the fact by size and
checksum against the manifest. A mismatch is reported per object and the run
exits non-zero. Re-running skips objects already present and verified, so a
partial upload is resumable.

### 3.5 `verify-parity.ts`

Proves that nothing was lost. This is the migration's gate, not a report.

```bash
npm run verify:parity                     # assert (default)
npm run verify:parity -- --release        # + the launch-only alt-text gate
npm run verify:parity -- --write-readiness
```

> The npm script name `verify:parity` is a **hard contract**. CI's
> `db-and-parity` job runs `npm ci && npm run verify:parity` in this directory,
> and the cutover runbook names it. Do not rename it.

**Reads** the source manifest (section 2.4), the committed fallback JSON and —
when credentials are present — the Supabase tables. **Writes**
`artifacts/parity-report.json`.

**Default mode** asserts that every one of the 142 paths resolves with its
expected status, that every mapped field is populated, that every unmapped source
key is retained in a queryable legacy column, that every asset reference binds,
and that the filename map is injective. It also emits the integrity sections in
section 8 for school review — those are reported, never treated as failures.

**`--release`** adds the launch-only gate: it fails while any **informative**
asset in published content has empty alt text. This is separated from the default
mode on purpose. No legacy sidecar carries alt text, so source parity for `alt`
means *empty*, and folding the two together would make CI red for the entire
build phase for a reason no commit could fix. Alt text is authored once, at
cutover.

**`--write-readiness`** writes the `site_readiness` row, and only after every
gate has passed: schema version, all migrations applied, the source-manifest
checksum, the 142-path count, the three asset class counts, and at least one
active admin.

> **Only after that row exists does `CONTENT_SOURCE=supabase` do anything.**
> Presence of a URL and a key is deliberately not sufficient — keys can arrive
> before the schema is pushed, and a bare presence check would flip a working
> site onto an empty database.

**Credentials** — none in default mode against the fallback JSON. The Supabase
comparison needs the project URL and a key; `--write-readiness` needs the
service-role secret key.

### 3.6 `export-fallback.ts`

The inverse of the extractor: reads Supabase and rewrites the committed
snapshot.

```bash
npm run export-fallback
```

**Writes the same 14 files** in `nextjs/data/fallback/` that section 3.2 emits,
with `meta.produced_by` set to `"export"` rather than `"extract"` so it is always
clear which program produced a given snapshot.

**Why it matters.** `CONTENT_SOURCE=fallback` is the one-variable rollback: set
it, redeploy, and the public site returns to the committed snapshot without
touching the database. That makes this program the thing that keeps the rollback
**bounded** rather than a return to migration-day content.

The guarantee is precise, and it is worth stating in the form that makes its
limit obvious:

> Rollback restores the site to its **last exported snapshot**, losing any
> content edited after it.

Two consequences follow:

- **It must run *after* the alt-text authoring step**, so the snapshot carries
  the authored alt text rather than the empty source values.
- **Schedule.** Immediately after cutover, and monthly thereafter. The editor
  surfaces the snapshot date in the admin shell so nobody assumes it is live.

For a loss-free recovery after heavy editing the correct instrument is
point-in-time recovery or a database dump — not this program.

**Credentials** — the project URL and the service-role secret key, because the
export must read draft rows and private relations that row-level security
correctly hides from an anonymous key.

**Failure modes** — refuses to overwrite the snapshot if the readiness row is
absent or its schema version does not match, so it cannot silently export from a
half-migrated database over a good snapshot.

---

## 4. The authorized mechanical transformations

**Content is migrated, not rewritten.** Copy, headings and body prose cross over
as they are. Six classes of mechanical change are nevertheless required, and each
is authorized here so that no one has to decide case by case.

Every class is applied **corpus-wide, by rule** — never as a list of patches.
That distinction is the whole design: a link added to the corpus tomorrow in any
of these shapes is handled by the same code, and re-running the extractor against
a newer commit (section 2.3) produces the same result without anyone
remembering to re-apply anything. The `file:line` references below are evidence
that the rule fires where expected, not the inputs to a hand-edit.

All eleven link records below were verified against the reference revision.

### 4.1 Absolute same-origin links → root-relative paths

Four Bard links point at this site by absolute URL:

| Record | `href` in the source | Becomes |
| --- | --- | --- |
| `pages/contact.md:30` | `https://cambridge-ellis.org/contact/frequently-asked-questions` | `/contact/frequently-asked-questions` |
| `pages/apply.md:318` | `https://cambridge-ellis.org/admissions/financial-aid` | `/admissions/financial-aid` |
| `pages/visit-ces.md:33` | `https://cambridge-ellis.org/community/christina-isidoro` | `/community/christina-isidoro` |
| `pages/ways-to-give.md:129` | `https://cambridge-ellis.org/donate` | `/donate` |

**The destination is unchanged; only the href form changes.** No redirect is
involved and no URL moves. What it fixes is that an absolute URL to your own
origin defeats client-side routing: the browser treats it as an external
navigation and performs a full document load, discarding the application. The
root-relative form navigates in-app.

### 4.2 The Statamic internal scheme → resolved canonical URIs

Two Bard links use Statamic's internal entry scheme, which means nothing outside
Statamic:

| Record | `href` in the source | Resolves to | Becomes |
| --- | --- | --- | --- |
| `pages/families.md:29` | `statamic://entry::2d2dfb77-be33-43a8-8b81-ea5fb25d09f3` | `pages/ways-to-give.md` | `/giving/ways-to-give` |
| `pages/request-information.md:35` | `statamic://entry::80db4d25-4d83-49ad-8d90-62f26c47a7b9` | `pages/contact.md` | `/contact` |

Each uuid is resolved against the corpus at extraction time and the entry's
canonical path is emitted.

**An unresolvable uuid fails the extraction.** This is deliberately fatal rather
than a warning: the alternatives are shipping a `statamic://` href into
production, where it is a dead link on a live page, or silently dropping the
link and losing the reference. A build that stops is cheaper than either.

### 4.3 Bare email addresses as hrefs → `mailto:`

Five Bard links carry a raw email address in `href`, with no scheme:

| Record | `href` in the source |
| --- | --- |
| `pages/apply.md:56` | `christina@cambridge-ellis.org` |
| `pages/apply.md:145` | `elisabeth@cambridge-ellis.org` |
| `pages/apply.md:165` | `christina@cambridge-ellis.org` |
| `pages/financial-aid.md:90` | `andy@cambridge-ellis.org` |
| `pages/visit-ces.md:52` | `christina@cambridge-ellis.org` |

**These are broken today, and the stakes are high.** With no scheme the browser
resolves each one as a *relative path*, so clicking it navigates to a 404 instead
of opening a mail client — on the apply and financial-aid pages, which are the
two highest-intent pages on the site. A prospective parent trying to reach the
admissions director currently lands on an error page.

The transformation adds the scheme and nothing else. **The visible link text and
the address's case are preserved byte-for-byte.**

**Do not "tidy" the addresses that are already links.** Thirteen hrefs in the
corpus are already `mailto:`, and **nine of them carry uppercase characters** —
`mailto:Info@Cambridge-Ellis.org`, `mailto:Christina@Cambridge-Ellis.org` and
similar. The local part of an address is case-sensitive by specification, these
are the addresses the school publishes, and normalizing them would be an
unrequested content change. They pass through untouched.

### 4.4 Hardcoded template values → managed data

Values the school owns but that live in template literals are promoted into
`site_globals` and `page_sections`. The inventory and its sources are the table
in section 3.2.

**The values are identical; only their home changes.** The point is not to edit
anything but to make it editable: an address hardcoded in a layout template
cannot be changed by staff without a developer and a deploy.

### 4.5 The FAQ split

`pages/frequently-asked-questions.md` holds exactly one `add_content` set of type
`text`, whose Bard document is a flat run of **23 top-level nodes**. Eleven
paragraphs open with `Q:` and eleven with `A:`, as ordinary prose — the source has
no question/answer structure at all.

A deterministic split reconstructs it: within that document, a paragraph whose
first text node begins `Q:` opens an item, and the following paragraphs up to the
next `Q:` form its answer. That yields **11 `page_sections` rows of kind
`faq_item`**, each with a question and an answer.

**Nothing is dropped.** Any node outside a pair is preserved in document order as
a `text` section. There is exactly one such node here and it is easy to
mis-assume: the **leading node is a level-2 `heading`** reading "Language
Program", not a paragraph. A splitter that assumed every node was a paragraph, or
that discarded anything before the first `Q:`, would silently lose it.

Two parity assertions cover this, and both must hold:

1. the split produces exactly **11** items; and
2. the concatenated text of the rebuilt page equals the source document's text
   content.

The second is the one that matters. It is what makes "nothing is dropped" a
checked property rather than a claim. If either assertion cannot be satisfied the
documented fallback is to render the document as ordinary prose through the
rich-text renderer — losing the disclosure affordance, never the content.

### 4.6 The single copy edit

One word changes in the entire migration.

`resources/views/donate.antlers.html:5` reads:

```text
Thank you for considering donating to Cambridge-Ellis! You support helps us continue in our mission to enrich the lives of those we care for.
```

(One line in the source; not wrapped.)

As that paragraph moves from the template into content, **"You" becomes
"Your"**. That is the sole prose change anywhere in this migration. No other
wording is altered.

**Corollary, and it is not a bug report.** The maintenance-mode message in
`content/addons/plugrbase-maintenance-mode.yaml` ends "…expect to be back online
in the next 24 hours. Stay tooned!" That spelling **migrates unchanged.** It is
not the authorized edit, so it is not this migration's to fix — and once the copy
is managed data the school can change it themselves in seconds. The same applies
to the stray leading space in the summer "Full day" label and to every other
typographical oddity in the corpus: they are content, and content is the
school's.

---

## 5. Invariants a reader must not break

Each of these is load-bearing. Anyone extending or re-running the tooling needs
to know why it is the way it is, because each one looks like an arbitrary
complication until you know what it prevents.

### 5.1 One filename map, four consumers

Legacy asset filenames are not URL-safe. **25 of the 289 contain literal
spaces** — `Liz McKillop-Segura.jpg`, `Andy Griswold.jpg` — and **58 carry an
uppercase extension** (55 `.JPG`, 3 `.HEIC`). Normalization is therefore
unavoidable.

**It must happen exactly once.** `build-asset-manifest.ts` emits a single
collision-checked `source → normalized` map, and four consumers read it rather
than normalizing independently:

1. the image paths in the fallback JSON;
2. the filesystem relocation (section 5.5);
3. the Storage object keys;
4. every database reference — including the typed global logo and the focal-point
   rows.

Four independent normalizations would agree right up until one of them handled a
character differently, at which point a database row would point at an object key
that does not exist. One map cannot disagree with itself.

**Two files normalizing to one name is a hard failure, not a silent overwrite.**
The manifest step aborts. Silently overwriting would destroy one image and leave
every reference to it resolving to the other — the kind of loss that is invisible
in a diff and obvious on the website.

`verify-parity.ts` asserts the map is **injective** and that every reference
resolves through it.

**The seven URL-preserving aliases are the one deliberate exception.** They keep
their exact current filenames — spaces, capitals and all — because a normalized
name is a *different URL*, and preserving the URL is the entire point of aliasing
them. See section 5.5.

### 5.2 Deterministic child identity

Child rows are identified by a derived value, never by a source id:

```text
legacy_ref = <parent legacy_ref>:<field handle>:<ordinal within that field>
```

The ordinal is source order. Where a source `id` exists it is retained in
`legacy.set_id` **for traceability only** — it is not the identity.

That is not a stylistic preference. **22 replicator sets in the corpus carry no
`id` at all**: 12 `text`, 7 `institution` and 3 `quote`. ProseMirror nodes inside
a rich-text field never carry one. An identity scheme resting on the source id
would have nothing to rest on for those rows, and the load would stop being
idempotent exactly where the corpus is least regular.

The property this buys is checked: **a rerun test loads the seed twice and
asserts row counts and ids are identical.** Everything about the idempotent load
depends on it — including the re-run path in section 2.3, which would otherwise
duplicate every child row on a second extraction.

### 5.3 Rich text has two source shapes, and they are not interchangeable

Bard and Tiptap do not store the same thing. Three shapes are in play:

| Shape | Where | Structure |
| --- | --- | --- |
| Standalone Bard field | `events.details`, `important_notes` | a **bare array** of ProseMirror nodes, no wrapper |
| Bard field inside a replicator | `add_content[i].text` | that **same bare array**, under the set's own key |
| Tiptap | the editor, and the database | a single `doc` node with a `content` array |

The database stores the **Tiptap shape**, because that is what the editor
round-trips without transformation. Import wraps a bare array as
`{ type: 'doc', content: [...] }`; export unwraps it back to a bare array.

**Glossing over the difference is how a round trip silently corrupts a
document** — wrap a bare array twice, or export a `doc` where a bare array is
expected, and the field still parses while its content is one level out of place.
The round-trip proof in section 7.2 exists for this reason.

### 5.4 Extract before delete, and verify against the manifest

`artifacts/migration-source-manifest.json` records, per consumed source file:

- the source commit SHA and a SHA-256 of the file;
- the keys it yielded;
- the route and publish status it produced;
- its relations and its asset references.

That is what lets a later reader **prove which source file produced which row
without the source files still being present** — and what lets `verify-parity.ts`
keep working afterwards (section 2.4). Extraction runs against an intact tree;
the manifest is the handoff.

### 5.5 Relocate before delete

> These are supervised procedures, each gated on a verified prior step. They are
> written out here so the ordering is auditable — **not** as commands to paste.
> The root `README.md` runbook is what sequences them, with the verification
> required at each step.

The 289 binaries are **moved, never deleted**:

| Step | Files | Destination |
| --- | --- | --- |
| 1 | 110 deployed | `nextjs/public/assets/` |
| 2 | 24 draft-only | `archive/draft-media/` |
| 3 | 155 archived | `archive/unreferenced/` |
| 4 | 7 of those 155, **copied** | `nextjs/public/assets/`, under their exact original filenames |

Step 4 is a **copy, not a move.** Those seven documents — 2 PDFs, 4 ZIPs and 1
DOCX — remain members of the archived class and are still uploaded to the private
bucket; the copy exists so that `/assets/<filename>` keeps resolving for
documents that may have been mailed to families or printed on a handout. That
leaves `nextjs/public/assets/` holding **117 files** (110 + 7), while
`archive/unreferenced/` still holds all 155.

Only then is the source directory `public/assets/` removed, in full.

The rule behind the ordering: **nothing is deleted while it is still the only
copy of bytes the site needs.** A manifest entry is a record, not a file, and
cannot substitute for the image. This is also why `upload-assets.ts` reads from
`archive/` (section 3.4) — the bytes have to still exist somewhere the tool can
reach when the keys finally arrive, which may be weeks later.

### 5.6 Two parsing traps

Both of these will bite anyone extending the tooling, and one of them has already
produced a wrong number in the specification.

**A `text` replicator set and a ProseMirror `text` node are both `type: "text"`.**
The only thing distinguishing them is the `text` key itself: a *set* holds an
**array** there, a *node* holds a **string**. There are 65 such sets in the
corpus. Counting `type == "text"` naively returns **417**, which is
`352` genuine text nodes plus those `65` sets — and 417 is exactly the figure the
specification reports as its text-node count. The measured split is in
section 9.2. Any traversal that does not apply the array-versus-string test will
mis-handle both.

**Non-breaking spaces enter the corpus only through YAML.** There are **zero raw
U+00A0 bytes** anywhere in `content/`; every NBSP arrives via the YAML `\_`
escape, in 8 entries. Consequently **round-trip byte equality is asserted on
parsed strings, never on YAML source.** Comparing raw YAML would report a
difference for a value that is byte-identical once parsed, and re-serializing to
match the source escape-for-escape is not a property any YAML emitter guarantees.

---

## 6. Credentials

### 6.1 The rule

> **No secret is ever committed, and no script in this project reads a
> credential from a file in the repository.** Credentials arrive as environment
> variables or command-line arguments at invocation time, and nowhere else.

There is no `tools/.env`, no config file holding a key, and no default that
happens to work. A program without the credential it needs exits with a message
naming the variable it wanted — it never falls back to a weaker one.

Two supporting facts, because the rule is only as good as its enforcement:

- CI runs `gitleaks` over the full history **and** the diff. A committed
  service-role key is the single worst outcome available to this migration:
  that credential bypasses row-level security entirely.
- The publishable key is safe in a browser bundle and the secret key is not.
  They are not interchangeable, and section 6.2 says which programs need which.

### 6.2 What each program needs

Two of the six need nothing at all. The other four are listed with the least
authority that actually works:

| Program | Project URL | Publishable key | Secret key |
| --- | --- | --- | --- |
| `build-asset-manifest.ts` | — | — | — |
| `extract-statamic-content.ts` | — | — | — |
| `verify:parity` (default, fallback JSON) | — | — | — |
| `verify:parity` (comparing Supabase) | yes | yes | — |
| `verify:parity --write-readiness` | yes | — | **yes** |
| `bootstrap-admins.ts` | yes | — | **yes** |
| `upload-assets.ts` | yes | — | **yes** |
| `export-fallback.ts` | yes | — | **yes** |

The three programs that require the secret key require it for a reason that is
worth knowing rather than assuming:

- `bootstrap-admins.ts` creates users, which is an Auth admin operation.
- `upload-assets.ts` writes to a private bucket in bulk.
- `export-fallback.ts` must read **draft rows and private relations** that
  row-level security correctly hides from an anonymous key. Exporting with a
  publishable key would silently produce a snapshot missing every draft — a
  fallback that looks fine and has lost 55 entries' worth of publish state.

**Canonical variable names, exposure, defaults and absent-behaviour live in
`nextjs/.env.example`**, which documents each one in full; the root `README.md`
mirrors the same set. This table names *which programs need what*, and points
there for *what each variable means*. If this file and those two ever disagree,
that is a defect in one of them — not licence to introduce a fourth spelling.

One scoping rule is repeated here because getting it wrong is a single checkbox
and the consequence is total: **the secret key is scoped to Production only,
never to Preview.** A Vercel Preview variable is readable by any deployment of
any branch, including a branch from a fork.

### 6.3 Local development

Run everything against the local containerised stack, never the hosted project.
The stack is started from `nextjs/`, where the pinned Supabase CLI lives:

```bash
cd nextjs
npm run db:start
npx supabase status -o env
```

That prints the local API URL and the local keys. Map them into the environment
of whichever tools command you are running:

```text
API_URL          -> the project URL variable
PUBLISHABLE_KEY  -> the publishable key variable
SECRET_KEY       -> the secret key variable
```

These are well-known development values with no authority over anything real —
which is exactly why they must still never be committed. Committing them trains
everyone to ignore the secret scanner, and the next thing ignored is a real key.

### 6.4 Loading `supabase/seed.sql` is a `psql` step, not a tools script

`extract-statamic-content.ts` *writes* `supabase/seed.sql`. **Nothing in this
project applies it.** The load is a one-time operator action, deliberately kept
outside the tooling so that no program in `tools/` ever needs a database
superuser connection string.

From the repository root:

```bash
read -rsp 'connection string (must include sslmode=require): ' CES_DB_URI && echo
psql "$CES_DB_URI" -v ON_ERROR_STOP=1 -f supabase/seed.sql
unset CES_DB_URI
```

Three properties of that invocation are the point of it:

- **TLS.** The connection string must carry `sslmode=require`. The load contains
  the school's entire content corpus.
- **`-v ON_ERROR_STOP=1`.** Without it `psql` continues past a failed statement
  and reports success at the end, leaving a partially-loaded database that looks
  fine until a foreign key is missing. With it, the first error stops the load.
- **The string is typed at the prompt.** `read -rs` keeps it off the terminal and
  out of shell history; `unset` drops it afterwards. It is never written to a
  file, never passed as a command-line argument where `ps` would show it, and
  never added to `.env`.

Verify with `npm run verify:parity` immediately afterwards. The root `README.md`
runbook sequences this step and states its verification.

### 6.5 The inspection account must never appear in any output

A Statamic Control Panel account was created locally during planning, purely to
observe legacy behaviour:

```text
blitzy.admin@example.com
```

**It must not appear in any artifact, seed file, fallback JSON, test fixture or
`admin_users` row this project produces.** It is not a school account, it never
existed in the school's own installation, and a migration that carried it would
be creating an administrator nobody authorized.

The only two accounts this project provisions are the two in section 3.3.
Anyone extending the tooling — adding a fixture, widening a query over `users/`,
writing a new export — needs to know this, which is why it is stated here rather
than left as an absence somebody might helpfully fill in.

### 6.6 The service-role rate-limit exemption

The application enforces per-account ceilings on content writes and uploads. The
**service role is exempt**, so the bulk migration load is not throttled.

The exemption is recorded rather than hidden, and its boundaries are exact:

- it applies to the service role only;
- **no user role is exempt** — not `admin`, not `editor`;
- a bulk load of 289 objects is precisely the case the ceilings are not meant to
  catch, and a limit that blocked the migration would be a limit nobody could
  ship.

---

## 7. Quality gates

This project is held to the **same bar as the application**, and the reason is
worth stating plainly: a silent bug in the extractor is a content bug. It does
not crash a page — it writes a wrong value into the database and the fallback
JSON, and nobody notices until a parent reads it.

### 7.1 The three gates

```bash
cd tools
npm run typecheck    # tsc --noEmit
npm run lint         # eslint . --max-warnings=0
npm run test         # vitest run
```

| Gate | Standard | CI job |
| --- | --- | --- |
| `typecheck` | strict mode, zero errors | `tools-quality` |
| `lint` | **zero warnings**, not just zero errors | `tools-quality` |
| `test` | all pass | `tools-quality` |
| `npm audit --audit-level=high` | no high or critical advisory | `deps-audit` |

`tools-quality` runs the first three. `deps-audit` runs the audit against **both**
of the repository's npm manifests — `nextjs/` and this one — so a vulnerable
transitive dependency in the migration tooling fails the build exactly as it
would in the application. Advisory suppressions live in
`.github/audit-allowlist.yml`, one entry per advisory with a reason and an
**expiry date**, and an expired entry fails the job. That is the discipline whose
absence let jQuery 3.4.1 sit in the legacy site past two published XSS
advisories.

`--max-warnings=0` is not pedantry. A warning nobody has to fix is a warning
everybody stops reading.

### 7.2 What the unit tests protect

Five subjects, chosen because each one is a place where a plausible-looking
change silently alters migrated content:

| Subject | What it asserts | Breaks if… |
| --- | --- | --- |
| Link normalization (section 4.1–4.3) | each of the three classes transforms, and a well-formed link of any other shape is left **untouched** | someone "helpfully" normalizes the 9 mixed-case `mailto:` addresses |
| The FAQ split (section 4.5) | exactly 11 items, **and** the rebuilt page's concatenated text equals the source document's | the leading level-2 heading is dropped |
| The filename map (section 5.1) | the `source → normalized` map is **injective** | two files are allowed to collide onto one name |
| Child identity (section 5.2) | the derivation is deterministic; loading the seed twice yields identical row counts and ids | identity is taken from a source `id` that 22 sets do not have |
| The rich-text round trip (section 5.3) | import → export → re-import is lossless, with deep equality of node trees and byte equality of every text run | a bare array is confused with a `doc` |

The round-trip test enumerates **every Bard-bearing field in the corpus**: the 65
`add_content[].text` sets across 23 pages, the 4 `events.details` fields, and
`important_notes`. Note that figure — `events.details` exists on **4** events,
not on all 18 (section 9.2).

### 7.3 The dual-source test corpus

This is surprising and load-bearing, so it is documented rather than left to be
discovered. The tests resolve their corpus in this order:

1. `CES_SOURCE_ROOT`, if set — an explicit checkout path, as in section 2.2;
2. otherwise the repository's own `content/`, **if it still exists**;
3. otherwise the committed `nextjs/data/fallback/*.json`.

```bash
# against a materialised legacy revision
CES_SOURCE_ROOT=/tmp/ces-src npm run test

# with no source available, against the committed fallback JSON
npm run test
```

Step 2 is why the tests were meaningful during the migration: they ran against
the real flat files. Step 3 is why they are **still** meaningful now that
`content/` has been deleted — the same assertions run against the committed
snapshot, so the round-trip guarantee survives the deletion and `tools-quality`
keeps passing indefinitely rather than becoming a job that tests nothing.

A test suite that could only run against inputs the migration removes would have
protected the corpus for exactly as long as it did not need protecting.

### 7.4 Reading the reference archive

`fidelis3-main.zip` is the inline-CMS implementation this project was pointed at
as a reference. It has **209 members, all under `fidelis3-main/`**.

`adm-zip` is pinned in this project for exactly this purpose. Run from `tools/`:

```bash
npx tsx -e "import AdmZip from 'adm-zip'; new AdmZip('../fidelis3-main.zip').getEntries().forEach(e => console.log(e.entryName));"
```

Two practical notes:

- **Run it from `tools/`.** Node resolves `adm-zip` relative to the script's
  location, not the current working directory, so invoking it from the repository
  root fails with a module-not-found error even though the package is installed.
- Adjust the path if the archive is not adjacent — after the migration it is not
  in the working tree at all, and must be read from a materialised revision
  (section 2.2), the same as any other legacy input.

This deliberately **replaces an ad-hoc `python3 -m zipfile` invocation.** Keeping
the toolchain to a single pinned runtime is the point: there is no unpinned
Python dependency anywhere in this project, and one fewer language means one
fewer thing to install, version and audit.

Two boundaries on the archive itself:

- **It is a reference only.** No file is copied from it verbatim. Its patterns
  informed the design and several of its weaknesses were deliberately corrected
  rather than reproduced.
- **It is deleted from the repository at the end of the migration**, after the
  reference readings are complete — which is why it must be read before that
  step, and why this recipe exists in writing.

---

## 8. Known source-integrity cases

**These are properties of the source corpus, not defects in the tooling.** Each
one is expected, each is preserved deliberately, and each is reported in
`artifacts/parity-report.json` — so an operator reading that report will meet
them and needs to know they are not failures.

The common principle: where the source is internally inconsistent, the tooling
**preserves both the effective behaviour and the raw value** and reports the
discrepancy for the school to decide on. It does not silently coerce, and it does
not abort a migration over a stale value the live site already copes with.

### 8.1 Four stale `parent:` ids

Four page entries carry a `parent:` value that resolves to no entry. All four
point at the same uuid, and it matches nothing in the corpus:

```text
261c91f6-648b-409b-8457-02a740156d6a   ← referenced by, and resolving to nothing:

  pages/day-programs.md
  pages/enrichment-programs.md
  pages/language-programs.md
  pages/summer-programs.md
```

**`content/trees/collections/pages.yaml` is authoritative for the hierarchy**,
not these keys — which is precisely why all four render at their correct URLs on
the live site today. `pages.parent_id` is therefore seeded from the tree, the raw
value is retained in `pages.legacy.parent`, and the case is listed under stale
parent references for school review.

Trusting the `parent:` key instead of the tree would have orphaned four program
pages.

### 8.2 One dangling announcement link

`announcements/2023-24-admissions-season-now-open-apply-today.md` carries, at
line 5:

```text
link: 53cf3d97-1b19-4551-a080-30b69ec56ef6
```

No entry carries that id. `announcements.link_page_id` is **nullable** for
exactly this reason: the row loads with a null foreign key, the raw id is
retained in `legacy.link`, and the banner renders without a link for that row.

The alternative — a non-null column — would have made this one row abort the
canonical load.

### 8.3 Seven `enabled: false` nested records

Seven nested records are disabled in the source. This is real editorial state
that **no blueprint declares**, so it is easy to lose by simply not looking for
it:

| Entry | Count |
| --- | --- |
| `pages/apply.md` | 2 |
| `pages/enrichment-programs.md` | 1 |
| `pages/auction.md` | 1 |
| `pages/deposits.md` | 1 |
| `pages/careers.md` | 1 |
| `people/jeanette-herrera.md` | 1 |

Statamic honours the flag, so the target does too: `page_sections.enabled` and
`person_education.enabled` carry it, disabled records are suppressed from public
rendering, they remain visible and toggleable in edit mode, and they round-trip
through export.

### 8.4 The classroom relation disagrees with itself

This is the one case where no reading of the source is simply correct, so the
resolution is worth understanding rather than accepting.

The relation is recorded in **both** directions and they do not match:

| Direction | Source field | Pairs |
| --- | --- | --- |
| Forward | `classrooms.teachers` | 32 |
| Reverse | `people.classrooms` | 24 |
| In both | — | 15 |
| **Union** | — | **41** |

So 17 pairs are forward-only and 9 are reverse-only. The live site renders the
*reverse* query, which means:

- adopting the declared forward relation alone would **silently remove 9
  associations the site displays today**; and
- adopting the reverse alone would **discard 17 the entries themselves assert**.

Neither is acceptable under "no content is lost", so **the union of 41 pairs is
loaded**, each row tagged `source` as `forward` (17), `reverse` (9) or `both`
(15), with both original arrays retained in `legacy` on their respective rows.

**The honest consequence, stated rather than buried:** a handful of classrooms
will list a teacher the current site does not show. That is a visible change, it
is the school's to confirm or correct, and `artifacts/parity-report.json` gives
it a named section so it is put in front of them rather than discovered. Nothing
is dropped, and the additions are visible rather than silent.

### 8.5 Grandfathered over-length values

The blueprints declare `character_limit` values that the existing content
violates. All four `announcements.title` values are over the declared limit of
30 characters:

| Length | Title |
| --- | --- |
| 44 | Summer Camp registration is now open to all! |
| 55 | Now Accepting Applications for the 2025-26 School Year! |
| 56 | Summer Camp 2023 Registration Opens to the Public, 2/15! |
| 69 | Tickets now on Sale for our Annual Auction and Community Celebration! |

The same applies to three of four umbrella `description` values against a
declared limit of 300.

**A bare `CHECK` constraint would therefore have aborted the canonical load.**
Instead the limits live in the application's validation layer and the write
functions, where they are enforced on any create or edit, while **the seed load
is exempt** and each over-length row is listed in the parity report for the
school to shorten at leisure.

New writes are constrained; the migrated corpus is grandfathered. That asymmetry
is deliberate: the alternative is either truncating the school's own headlines or
refusing to migrate them.

### 8.6 A correction: `people.role` is present on all 77

The technical specification contains a claim that the corpus does not support,
and it is recorded here because the cost of "fixing" the code to match the prose
would be real content loss.

**The claim:** that `content/collections/people/gwladys-latreme.md` carries no
`role` key, leaving 76 of 77 people with a role.

**The measurement:** every one of the 77 people entries carries a `role:` key
with **at least one term**. `gwladys-latreme.md` carries `role: [teacher]`. No
entry has an empty role list. The distribution:

| Term | People |
| --- | --- |
| `teacher` | 49 |
| `board-of-directors` | 23 |
| `leadership` | 10 |

That is 82 assignments across 77 people, since some hold more than one role.

**Why it matters.** `supabase/migrations/20260901120600_people.sql` enforces "at
least one role" with a `deferrable initially deferred` constraint trigger,
because `people.yaml` declares `validate: [required]` on the field. The canonical
seed load **meets** that invariant rather than being blocked by it. An extractor
"corrected" to emit zero `person_roles` for that entry would abort the seed load
on the constraint — and if the constraint were then relaxed to accommodate the
fabricated gap, a real role assignment would be silently dropped.

**The rule that follows: the extractor must never invent a role, and must never
omit one that exists.** There is no grandfathered exception here, because there
is nothing to grandfather.

---

## 9. The verified corpus census

### 9.1 Figures

Every figure below was measured against the reference revision (section 2.3),
not estimated. `artifacts/corpus-census.json` is the machine-readable
reconciler — regenerated by the extractor on every run, so each count stays
reproducible after `content/` is gone. **If this table and that artifact ever
disagree, the artifact is right.**

| Quantity | Value |
| --- | --- |
| Tracked files in the legacy repository | 982 |
| Files under `content/` | 182 |
| Entries | 163 — pages 34, people 77, events 18, classrooms 13, promoted 12, announcements 4, inspiring_quotes 5 |
| Routable paths | 142 — 102 published, 40 draft |
| Draft publish flags | 55 — pages 2, people 21, events 16, classrooms 1, promoted 12 (all), announcements 3 |
| Asset binaries | 289, totalling **362,904,172 bytes** |
| Asset sidecars, plus a placeholder | 289 `.meta/*.yaml`, plus `public/assets/.gitkeep` |
| Asset classes | deployed 110, draft-only 24, archived 155 |
| Deployed directory after aliasing | 117 files (110 + 7 copies) |
| Focal points | 18, of which **5** carry a zoom above 1 |
| Filenames needing normalization | 25 with literal spaces, 58 with an uppercase extension |
| Replicator sets with no source `id` | 22 — text 12, institution 7, quote 3 |
| Pages carrying `add_content` | 23 |
| Table-family nodes | 50, **all in `pages/tuition.md`** |
| Bard link records transformed | 11 — 4 absolute, 2 internal-scheme, 5 bare-email |
| Existing `mailto:` hrefs | 13, of which 9 are mixed-case |
| Entries using the YAML `\_` escape | 8 (and zero raw U+00A0 bytes) |
| Reference archive members | 209 |

### 9.2 Corrections to the specification

Five figures in the technical specification disagree with the corpus. They are
listed here so that nobody reconciles the difference in the wrong direction —
**by changing the code to match the prose.** In each case the measurement is
authoritative.

| Figure | Specification says | Corpus holds | Consequence of believing the prose |
| --- | --- | --- | --- |
| Focal points with zoom > 1 | 4 | **5** | one image silently re-cropped |
| `events.details` fields | 18 | **4** | a round-trip proof that enumerates fields which do not exist |
| Id-less replicator sets | "22 (7 institution, 3 quote, 1 text)" — which sums to 11 | **22 — text 12, institution 7, quote 3** | an identity scheme that misses 11 sets |
| ProseMirror `text` nodes | 417 | **352 nodes + 65 `text` sets** = 417 | the section 5.6 parsing trap, uncaught |
| `people.role` coverage | 76 of 77 | **77 of 77** | see section 8.6 — an aborted seed load, or real content loss |

The fourth row is the informative one: 417 is not wrong so much as *conflated*.
It is the exact sum of the genuine text nodes and the `text` replicator sets, and
it is what a traversal that skips the array-versus-string test reports.
