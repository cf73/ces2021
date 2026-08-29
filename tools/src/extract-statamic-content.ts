/**
 * =============================================================================
 * extract-statamic-content.ts — the Statamic corpus to Postgres + fallback JSON
 * =============================================================================
 *
 * Parses the entire Statamic 3.4 flat-file corpus and emits the database load,
 * the committed fallback snapshot and the provenance record. Eighteen files in
 * three places:
 *
 *   nextjs/data/fallback/          14 JSON files — committed, bundled, and what
 *                                  the site renders from before any Supabase
 *                                  key exists
 *   supabase/seed.sql               1 file  — the canonical database load,
 *                                  idempotent on legacy_ref
 *   artifacts/                      3 files — route-manifest.json,
 *                                  corpus-census.json and the checksummed
 *                                  migration-source-manifest.json
 *
 * (`tools/README.md` §3.2 states the same eighteen. The technical
 * specification's prose says "nineteen" while enumerating these eighteen; the
 * file list is what is authoritative, and no nineteenth output is invented.)
 *
 * ## Why this file is held to the application's quality bar
 *
 * A silent bug here is a content bug. It does not crash a page — it writes a
 * wrong value into the database *and* into the committed fallback JSON, and
 * nobody notices until a parent reads it. So: every value out of the YAML
 * parser is `unknown` and is narrowed by an explicit guard; nothing is
 * fabricated; and where the source is internally inconsistent the raw value is
 * preserved next to the effective one and the discrepancy is reported.
 *
 * ## Ordering requirement
 *
 * This program must run AFTER `build-asset-manifest.ts`. It reads
 * `artifacts/assets.manifest.json` for asset classes and normalized paths
 * rather than re-deriving either, so that a filename is normalized exactly once
 * and all four consumers agree (README §5.1). Run out of order it exits
 * non-zero with a message naming the step to run first.
 *
 * ## Reads — deliberately wider than `content/`
 *
 * Five things the school owns live in templates rather than in content, and
 * leaving them behind would lose editable material: the donate heading and
 * paragraph, the three summer day-length labels, the maintenance-mode copy, the
 * layout's address/contact/social/logo/donate constants, and both analytics
 * identifiers. Promoting them changes where a value lives, never the value
 * itself — with the single documented exception in README §4.6.
 *
 * ## Assertions, in two kinds
 *
 *   - **Internal invariants** are always fatal, because a failure means this
 *     program is wrong rather than that the checkout is unexpected: an
 *     unresolvable `statamic://entry::<uuid>`, an asset reference that does not
 *     resolve through the manifest, a rich-text round trip that is not lossless,
 *     a duplicate content path, a person with no role, a page whose tree
 *     position cannot be established.
 *   - **The reference census** — 163 entries, 142 paths, 55 draft flags, the
 *     node/mark/set histograms — is fatal by default and waivable with
 *     `--allow-census-drift`. Those figures were measured against the reference
 *     revision (README §2.3), so a mismatch normally means the checkout is not
 *     the tree this migration was planned against. The escape hatch exists
 *     because re-running against a *newer* commit is a supported operation and a
 *     newer commit legitimately moves the numbers: two Statamic auto-commits
 *     after the reference revision publish an event, which moves a publish flag,
 *     a draft count and an asset's class.
 *
 * Module scope holds declarations only. Every side effect lives inside `main()`,
 * behind the executed-as-main guard at the foot of the file, because
 * `export-fallback.ts`, `verify-parity.ts` and `tools/tests/**` all import this
 * module for its types and helpers and must not thereby parse a corpus.
 * =============================================================================
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";
import YAML from "yaml";

import {
  normalizeAssetFilename,
  type AssetBucket,
  type AssetClass,
  type AssetManifest,
  type AssetManifestEntry,
  type FocalPoint,
} from "./build-asset-manifest";

/* ==========================================================================
 * 1. The fallback row shapes
 * --------------------------------------------------------------------------
 * These types are the contract for `nextjs/data/fallback/*.json`, and
 * `export-fallback.ts` imports them so that its output — read back out of
 * Supabase after cutover — stays byte-compatible with what the extractor wrote.
 *
 * Two conventions run through all of them and are deliberate:
 *
 *   - **`T | null`, never `T | undefined` and never an optional property.**
 *     `tsconfig.json` sets `exactOptionalPropertyTypes`, a JSON round trip
 *     erases `undefined` entirely, and a column that is nullable in Postgres is
 *     `null` here. One representation of absence, in the database, in the JSON
 *     and in the types.
 *   - **The fallback snapshot is a denormalized READ model; `seed.sql` is the
 *     normalized load.** Five child tables have no file of their own, so their
 *     rows travel nested inside the parent that owns them: `person_education`
 *     and `person_roles` inside `people.json`, `classroom_teachers` inside
 *     `classrooms.json`, `promoted_links` inside `promoted.json`, and
 *     `page_classrooms` inside `pages.json`. `page_sections` keeps its own file
 *     because it is self-referencing and one flat table renders in one pass.
 * ========================================================================== */

/** A Tiptap document: the shape the database stores for every rich-text field. */
export interface TiptapDoc {
  readonly type: "doc";
  readonly content: readonly ProseMirrorNode[];
}

/**
 * A ProseMirror node, as Bard stores it and as Tiptap consumes it.
 *
 * `content` is optional here — and it is the ONE optional property in this file,
 * because the corpus contains 18 empty `paragraph` nodes carrying no `content`
 * key at all. Most serializers normalize those to `content: []`; import and
 * export must preserve the *absence* of the key or the round-trip deep-equality
 * assertion fails. `marks` and `attrs` are optional for the same reason: a node
 * that never had them must not gain them.
 */
export interface ProseMirrorNode {
  readonly type: string;
  readonly content?: readonly ProseMirrorNode[];
  readonly marks?: readonly ProseMirrorMark[];
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly text?: string;
}

/** A mark on a text node. All 40 `link` objects in the corpus are marks. */
export interface ProseMirrorMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** Provenance carried by every content row: migrated verbatim, never overwritten. */
export interface Provenance {
  /** `updated_at` epoch converted to ISO-8601 UTC. Never the load time. */
  readonly source_updated_at: string | null;
  /** `updated_by` mapped to an email where known, otherwise verbatim. */
  readonly source_updated_by: string | null;
}

/** One of the 289 binaries. Built from the asset manifest, never re-derived. */
export interface AssetRow {
  readonly id: string;
  /** The source asset path within `public/assets` — for this flat container, the filename. */
  readonly legacy_ref: string;
  readonly bucket: AssetBucket;
  /** The bucket-relative object key. Carries the `archive/` prefix for archived objects. */
  readonly path: string;
  readonly filename: string;
  readonly mime: string | null;
  readonly size_bytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  /**
   * Null on all 289 rows. The assets blueprint declares exactly one field, and
   * not one sidecar carries a value for it. Authoring alt text for the
   * informative subset is a cutover deliverable and a release gate, never a
   * migrated value.
   */
  readonly alt: null;
  readonly focus_x: number | null;
  readonly focus_y: number | null;
  readonly focus_zoom: number | null;
  readonly lifecycle: "stored";
  readonly created_by: null;
  readonly declared_size_bytes: null;
  readonly reservation_expires_at: null;
  /** Fallback-only: the three-way split, so the renderer knows what is bundled. */
  readonly class: AssetClass;
  /** Fallback-only: true for the 117 files under `nextjs/public/assets/`. */
  readonly bundled: boolean;
  /** Fallback-only: its filename there, or null. */
  readonly bundled_path: string | null;
}

export interface TaxonomyTermRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly taxonomy: "role";
  readonly slug: string;
  readonly title: string;
}

/** The ordered page→classroom relation, nested in its page. */
export interface PageClassroomRow {
  readonly classroom_id: string;
  readonly classroom_legacy_ref: string;
  readonly sort_order: number;
}

export interface PageRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  readonly parent_id: string | null;
  /** Materialized from the tree, which is what the legacy site resolved from. */
  readonly path: string;
  readonly sort_order: number;
  readonly title: string;
  readonly template: string;
  readonly blueprint: string;
  readonly published: boolean;
  readonly show_in_nav: boolean;
  readonly description: string | null;
  readonly short_description: string | null;
  readonly intro: string | null;
  readonly welcome_line: string | null;
  readonly main_image_asset_id: string | null;
  readonly program_image_asset_id: string | null;
  /** The one standalone Bard field on this table, stored as a Tiptap doc. */
  readonly important_notes: TiptapDoc | null;
  readonly seo_title: null;
  readonly seo_description: null;
  readonly og_image_id: null;
  readonly legacy: Readonly<Record<string, unknown>>;
  readonly classrooms: readonly PageClassroomRow[];
}

/** The closed ten-value vocabulary `page_sections.kind` admits. */
export type PageSectionKind =
  | "text"
  | "image"
  | "quote"
  | "movie"
  | "slide"
  | "statistic"
  | "program"
  | "session"
  | "faq_item"
  | "testimonial";

export interface PageSectionRow {
  readonly id: string;
  readonly legacy_ref: string;
  readonly page_id: string;
  readonly page_legacy_ref: string;
  readonly parent_section_id: string | null;
  readonly kind: PageSectionKind;
  readonly sort_order: number;
  readonly enabled: boolean;
  readonly body: TiptapDoc | null;
  readonly asset_id: string | null;
  readonly caption: string | null;
  readonly happy_verb: string | null;
  readonly quote_text: string | null;
  readonly attribution: string | null;
  readonly embed_url: string | null;
  readonly stat_number: string | null;
  readonly stat_caption: string | null;
  readonly program_title: string | null;
  readonly program_description: string | null;
  readonly half_day_price: string | null;
  readonly full_day_price: string | null;
  readonly extended_day_price: string | null;
  readonly session_title: string | null;
  readonly session_dates: string | null;
  readonly question: string | null;
  readonly answer: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly legacy: Readonly<Record<string, unknown>>;
}

export interface PersonEducationRow {
  readonly id: string;
  readonly legacy_ref: string;
  readonly institution_name: string;
  readonly sort_order: number;
  readonly enabled: boolean;
  readonly legacy: Readonly<Record<string, unknown>>;
}

export interface PersonRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  /** Renamed from the generic handle `title`, which holds a person's name. */
  readonly name: string;
  readonly official_title: string | null;
  /** A zone-free `yyyy-MM-dd` calendar string. Never a Date. */
  readonly joined_ces: string | null;
  readonly email: string | null;
  /** A plain string: the blueprint declares `textarea`, not bard. */
  readonly bio: string | null;
  readonly photo_asset_id: string | null;
  readonly published: boolean;
  readonly sort_order: number;
  readonly seo_title: null;
  readonly seo_description: null;
  readonly og_image_id: null;
  readonly legacy: Readonly<Record<string, unknown>>;
  readonly education: readonly PersonEducationRow[];
  /** `person_roles`, as term ids. Every person carries at least one. */
  readonly role_term_ids: readonly string[];
  /** The same relation as term slugs, so the fallback renderer needs no join. */
  readonly role_slugs: readonly string[];
}

export interface EventRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  readonly title: string;
  /** Zone-free `yyyy-MM-dd`. */
  readonly event_date: string;
  /** Zone-free `HH:mm`, migrated verbatim — the source uses a 12-hour clock. */
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly location: string;
  readonly zoom_link: string | null;
  readonly image_asset_id: string | null;
  readonly short_description: string;
  readonly details: TiptapDoc | null;
  /** Preserved byte-for-byte, percent-encoding included. Never regenerated. */
  readonly calendar_link: string | null;
  readonly published: boolean;
  readonly seo_title: null;
  readonly seo_description: null;
  readonly og_image_id: null;
  readonly legacy: Readonly<Record<string, unknown>>;
}

/** Which legacy direction asserted a classroom→teacher pair. */
export type ClassroomTeacherSource = "forward" | "reverse" | "both";

export interface ClassroomTeacherRow {
  readonly person_id: string;
  readonly person_legacy_ref: string;
  readonly sort_order: number;
  readonly source: ClassroomTeacherSource;
}

export interface ClassroomRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly age_range: string | null;
  readonly published: boolean;
  readonly sort_order: number;
  readonly seo_title: null;
  readonly seo_description: null;
  readonly og_image_id: null;
  readonly legacy: Readonly<Record<string, unknown>>;
  readonly teachers: readonly ClassroomTeacherRow[];
}

export interface PromotedLinkRow {
  readonly id: string;
  readonly legacy_ref: string;
  readonly link_title: string;
  readonly link_url: string;
  readonly sort_order: number;
  readonly legacy: Readonly<Record<string, unknown>>;
}

export interface PromotedRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly address: string | null;
  /** Renamed from `summary_or_additional_info`, a handle that encodes UI guidance. */
  readonly summary: string | null;
  /** Renamed from `date_of_event`, so one helper serves this and `events`. */
  readonly event_date: string | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  /** NOT NULL in the schema: the only mandatory asset foreign key. */
  readonly image_asset_id: string;
  readonly published: boolean;
  readonly sort_order: number;
  readonly legacy: Readonly<Record<string, unknown>>;
  readonly links: readonly PromotedLinkRow[];
}

export interface AnnouncementRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  /** Full length, never truncated. All four exceed the declared limit of 30. */
  readonly title: string;
  /** Nullable: one of the four source links resolves to no entry. */
  readonly link_page_id: string | null;
  readonly link_page_path: string | null;
  readonly feature_on_homepage: boolean;
  readonly published: boolean;
  readonly legacy: Readonly<Record<string, unknown>>;
}

export interface InspiringQuoteRow extends Provenance {
  readonly id: string;
  readonly legacy_ref: string;
  readonly slug: string;
  /** Renamed from the handle `title`: the field holds the quotation text. */
  readonly quote: string;
  readonly attribution: string | null;
  readonly published: boolean;
  readonly legacy: Readonly<Record<string, unknown>>;
}

/** The seven tab groups the closed `site_globals` key set is divided into. */
export type SiteGlobalGroup =
  | "contact"
  | "social"
  | "branding"
  | "announcement"
  | "analytics"
  | "maintenance"
  | "seo";

export interface SiteGlobalRow {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
  readonly asset_id: string | null;
  readonly label: string | null;
  readonly group: SiteGlobalGroup;
  readonly public: boolean;
  readonly sort_order: number;
}

export type NavAudience = "prospective" | "enrolled" | "both";

export interface NavItemRow {
  readonly id: string;
  readonly legacy_ref: string;
  readonly parent_id: string | null;
  readonly parent_legacy_ref: string | null;
  readonly label: string;
  readonly target_page_id: string | null;
  readonly target_page_path: string | null;
  readonly external_url: string | null;
  readonly audience: NavAudience;
  readonly sort_order: number;
  readonly visible: boolean;
}

/** The four kinds `content_routes` exposes, spelled exactly as the view does. */
export type RouteKind = "page" | "classroom" | "person" | "event";

export interface RouteRow {
  readonly path: string;
  readonly kind: RouteKind;
  readonly id: string;
  /** Fixed by the view: pages 1, classrooms 2, people 3, events 4. */
  readonly precedence: number;
  /**
   * The one deliberate divergence from `content_routes`, which exposes four
   * columns and no publish state. Fallback mode has no row-level security, so
   * the flag has to travel with the row or a draft would render publicly.
   */
  readonly published: boolean;
}

/** One over-length value the seed loads and the write functions would reject. */
export interface GrandfatheredValue {
  readonly table: string;
  readonly column: string;
  readonly legacy_ref: string;
  readonly slug: string;
  readonly source_file: string;
  readonly length: number;
  readonly declared_limit: number;
}

/** The four anomalies `meta.json` registers, plus the grandfathered ledger. */
export interface IntegrityRegister {
  readonly stale_parent_references: readonly {
    readonly slug: string;
    readonly source_file: string;
    readonly raw_parent: string;
    readonly effective_parent_slug: string | null;
  }[];
  readonly dangling_announcement_links: readonly {
    readonly slug: string;
    readonly source_file: string;
    readonly raw_link: string;
  }[];
  readonly missing_required_fields: readonly {
    readonly collection: string;
    readonly slug: string;
    readonly source_file: string;
    readonly blueprint: string;
    readonly missing: readonly string[];
  }[];
  readonly promoted_link_duplication: readonly {
    readonly slug: string;
    readonly source_file: string;
    readonly scalar_link: string;
    readonly replicator_link: string;
  }[];
  readonly grandfathered_over_length: readonly GrandfatheredValue[];
}

/** Row counts for every table the load touches, computed on every run. */
export interface FallbackCounts {
  readonly entries: Readonly<Record<string, number>>;
  readonly taxonomy_terms: number;
  readonly assets: number;
  readonly pages: number;
  readonly page_sections: number;
  readonly page_classrooms: number;
  readonly people: number;
  readonly person_education: number;
  readonly person_roles: number;
  readonly events: number;
  readonly classrooms: number;
  readonly classroom_teachers: number;
  readonly promoted: number;
  readonly promoted_links: number;
  readonly announcements: number;
  readonly inspiring_quotes: number;
  readonly site_globals: number;
  readonly nav_items: number;
  readonly routes: number;
}

export interface FallbackMeta {
  /**
   * The schema version this snapshot was produced against, compared as a string
   * by `lib/content/source.ts` against the constant the running build carries.
   */
  readonly schema_version: string;
  readonly source_commit: string | null;
  /** `"extract"` here; `export-fallback.ts` writes `"export"`. */
  readonly produced_by: "extract" | "export";
  readonly generated_at: string;
  readonly generator: string;
  /** SHA-256 of `artifacts/migration-source-manifest.json` as written. */
  readonly source_manifest_checksum: string;
  readonly identity: {
    readonly uuid_namespace: string;
    readonly entity_rule: string;
    readonly child_rule: string;
  };
  readonly counts: FallbackCounts;
  readonly integrity: IntegrityRegister;
}

/* ==========================================================================
 * 2. Constants
 * ========================================================================== */

const GENERATOR = "tools/src/extract-statamic-content.ts";

/**
 * The uuid v5 namespace every derived row id hangs off.
 *
 * This value is stated identically in three places and must never diverge:
 * `public.ces_uuid_namespace()` in
 * `supabase/migrations/20260901120100_extensions.sql`, the `identity` block of
 * `nextjs/data/fallback/meta.json`, and here. It is read from that migration and
 * reproduced literally; changing it re-keys the entire corpus and breaks every
 * foreign key in `supabase/seed.sql` along with every id already committed to
 * the fallback JSON.
 */
const CES_UUID_NAMESPACE = "840c711d-7f81-4376-b0f3-d4154d606b54";

/**
 * The schema version recorded in `meta.json`.
 *
 * Convention, from `20260901121300_admin_roles.sql` §3: the timestamp prefix of
 * the highest migration in the set of eighteen. It is a declared constant rather
 * than the maximum filename found on disk, deliberately — during the migration
 * phase the eighteen land incrementally, and deriving it would make the version
 * of a snapshot depend on which sibling files happened to exist at the moment
 * the extractor ran.
 */
const SCHEMA_VERSION = "20260901121800";

/** Where the outputs go, relative to the repository root. */
const FALLBACK_DIR = "nextjs/data/fallback";
const SEED_PATH = "supabase/seed.sql";
const ARTIFACT_DIR = "artifacts";
const DEFAULT_MANIFEST_PATH = "artifacts/assets.manifest.json";

/** The seven collections, in load order. `pages` first: three tables reference it. */
const COLLECTIONS = [
  "pages",
  "people",
  "events",
  "classrooms",
  "promoted",
  "announcements",
  "inspiring_quotes",
] as const;

type CollectionName = (typeof COLLECTIONS)[number];

/**
 * The four routable collections and the precedence `content_routes` fixes.
 *
 * `promoted`, `announcements` and `inspiring_quotes` declare no route in their
 * collection configs and contribute no path: they render as components of other
 * pages.
 */
const ROUTE_KINDS: Readonly<Record<Exclude<CollectionName, "promoted" | "announcements" | "inspiring_quotes">, { readonly kind: RouteKind; readonly precedence: number }>> = {
  pages: { kind: "page", precedence: 1 },
  classrooms: { kind: "classroom", precedence: 2 },
  people: { kind: "person", precedence: 3 },
  events: { kind: "event", precedence: 4 },
};

/**
 * Route prefixes for the three non-hierarchical collections.
 *
 * Taken verbatim from the collection configs, except that `classrooms.yaml`
 * declares `route: 'programs/{slug}'` WITHOUT a leading slash — alone among the
 * four. `content_routes` normalizes that quirk in its own expression, and the
 * same normalization is applied here so the fallback snapshot and the view agree
 * on the one path form the catch-all can match.
 */
const ROUTE_PREFIXES = {
  people: "/community/",
  events: "/events/",
  classrooms: "/programs/",
} as const;

/** The page tree's first root is the literal string `home`, not a uuid. */
const HOME_ENTRY_ID = "home";

/** The home page's path. `structure.root = true`, so it contributes no slug segment. */
const HOME_PATH = "/";

/**
 * The two Statamic user ids that appear in `updated_by`, mapped to the addresses
 * `users/*.yaml` records for them. Anything else passes through verbatim: an
 * unrecognized actor is a fact about the corpus, not an error, and inventing a
 * mapping for it would put a name on a change nobody made.
 */
const STATAMIC_USERS: Readonly<Record<string, string>> = {
  "1179db75-8eeb-4bad-8e60-d5005aef7ef8": "bekah@cambridge-ellis.org",
  "b863e707-3140-4001-859f-3487e09c5881": "conrad.fulbrook@gmail.com",
};

/** The school's own host, for the absolute-same-origin link rule. */
const SAME_ORIGIN_HOSTS = ["cambridge-ellis.org", "www.cambridge-ellis.org"];

/** Statamic's internal entry scheme, which means nothing outside Statamic. */
const STATAMIC_ENTRY_SCHEME = "statamic://entry::";

/**
 * A bare email address used as an href.
 *
 * Anchored and deliberately conservative: it must match a whole href with no
 * scheme, no slash and no whitespace. The five records in the corpus are
 * UNQUOTED YAML scalars (`href: christina@cambridge-ellis.org`), which a
 * quoted-only match would miss entirely.
 */
const BARE_EMAIL = /^[^\s/:@]+@[^\s/:@]+\.[A-Za-z]{2,}$/;

/** Every scheme already present in the corpus that must pass through untouched. */
const KNOWN_HREF_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The prefix a paragraph must open with to start an FAQ item. */
const FAQ_QUESTION_PREFIX = "Q:";

/** Field handles whose value is a standalone Bard field — a bare node array. */
const STANDALONE_BARD_FIELDS = ["details", "important_notes"] as const;

/** Character limits declared in the blueprints, by target table and column. */
const CHARACTER_LIMITS: readonly {
  readonly table: string;
  readonly column: string;
  readonly collection: CollectionName;
  readonly sourceKey: string;
  readonly limit: number;
  readonly blueprint: string | null;
}[] = [
  {
    table: "announcements",
    column: "title",
    collection: "announcements",
    sourceKey: "title",
    limit: 30,
    blueprint: null,
  },
  {
    table: "pages",
    column: "short_description",
    collection: "pages",
    sourceKey: "short_description",
    limit: 300,
    blueprint: "programsumbrella",
  },
  {
    table: "pages",
    column: "short_description",
    collection: "pages",
    sourceKey: "short_description",
    limit: 300,
    blueprint: "programsumbrellasummer",
  },
  {
    table: "events",
    column: "short_description",
    collection: "events",
    sourceKey: "short_description",
    limit: 500,
    blueprint: null,
  },
];

/**
 * Handles a blueprint declares `validate: required` and whose absence is
 * therefore a source-integrity case rather than an ordinary null.
 *
 * Only `programsumbrella` is listed because it is the only blueprint whose
 * required set is actually violated: `school-age-mandarin` (a draft) carries
 * `title` alone. `slug` is excluded — it is derived from the filename and can
 * never be absent.
 */
const REQUIRED_PAGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  programsumbrella: ["title", "program_image", "short_description", "description"],
  programsumbrellasummer: ["title", "program_image", "short_description", "description"],
};

/**
 * The site_globals seed.
 *
 * The key set is CLOSED by a check constraint in
 * `20260901121100_globals.sql`, so this list is not extensible from here: a key
 * the constraint does not admit fails the load. Migration 11 seeds all
 * twenty-six rows itself with `on conflict (key) do nothing`, which is why the
 * seed this program writes upserts with `do update` — it has to win over the
 * migration's copy for the two rows the migration provably cannot fill (`logo`,
 * whose asset foreign key needs `public.assets` to be populated) and for
 * anything a later source revision changes.
 *
 * `value` is resolved per key at build time: `sourceLiteral` carries a value
 * promoted from a template, and `fromCorpus` marks the four rows computed from
 * migrated content or from the maintenance addon.
 */
interface GlobalSpec {
  readonly key: string;
  readonly group: SiteGlobalGroup;
  readonly label: string;
  readonly public: boolean;
  readonly sortOrder: number;
  readonly value: unknown;
  /** Where the value came from, recorded in the source manifest. */
  readonly origin: string;
}

/**
 * The nav_items seed: the 38 rows specified by `20260901121200_nav_items.sql`
 * §7, which inserts none of them itself.
 *
 * `ref` follows the one uniform convention that migration states: a root is
 * `'nav:' || kebab-cased label`, a child is `<parent ref> || '/' || segment`
 * where the segment is the target page's slug, or the kebab-cased label where
 * the row has no target page. Only `nav:header-actions` is CONTRACTUAL —
 * `SiteHeader.tsx` resolves the two calls to action by that literal string.
 *
 * `path` is the target page's path and is resolved against the migrated pages by
 * path, exactly as the migration's §7e idiom requires; a miss is fatal rather
 * than a null target on an item row, because a null target would ship an inert
 * menu entry. `null` means a label-only group header.
 */
interface NavSpec {
  readonly ref: string;
  readonly parentRef: string | null;
  readonly label: string;
  readonly path: string | null;
  readonly audience: NavAudience;
  readonly sortOrder: number;
  readonly visible: boolean;
}

const NAV_SEED: readonly NavSpec[] = [
  // 1 — Considering CES: the prospective-parent path, with Admissions FIRST.
  // The legacy sidebar places Admissions sixth of nine while its only standing
  // call to action is "Donate Now"; this is the reordering that fixes that.
  { ref: "nav:considering-ces", parentRef: null, label: "Considering CES", path: null, audience: "prospective", sortOrder: 1, visible: true },
  { ref: "nav:considering-ces/admissions", parentRef: "nav:considering-ces", label: "Admissions", path: "/admissions", audience: "prospective", sortOrder: 1, visible: true },
  { ref: "nav:considering-ces/admissions/visit-ces", parentRef: "nav:considering-ces/admissions", label: "Visit CES", path: "/admissions/visit-ces", audience: "prospective", sortOrder: 1, visible: true },
  { ref: "nav:considering-ces/admissions/apply", parentRef: "nav:considering-ces/admissions", label: "Apply", path: "/admissions/apply", audience: "prospective", sortOrder: 2, visible: true },
  { ref: "nav:considering-ces/admissions/timeline", parentRef: "nav:considering-ces/admissions", label: "Timeline", path: "/admissions/timeline", audience: "prospective", sortOrder: 3, visible: true },
  { ref: "nav:considering-ces/admissions/tuition", parentRef: "nav:considering-ces/admissions", label: "Tuition", path: "/admissions/tuition", audience: "prospective", sortOrder: 4, visible: true },
  { ref: "nav:considering-ces/admissions/financial-aid", parentRef: "nav:considering-ces/admissions", label: "Financial Aid", path: "/admissions/financial-aid", audience: "prospective", sortOrder: 5, visible: true },
  { ref: "nav:considering-ces/admissions/request-information", parentRef: "nav:considering-ces/admissions", label: "Request Information", path: "/admissions/request-information", audience: "prospective", sortOrder: 6, visible: true },
  // Deposits targets a DRAFT page, so the item is seeded invisible and appears
  // on its own the moment the school publishes.
  { ref: "nav:considering-ces/admissions/deposits", parentRef: "nav:considering-ces/admissions", label: "Deposits", path: "/admissions/deposits", audience: "prospective", sortOrder: 7, visible: false },
  { ref: "nav:considering-ces/programs", parentRef: "nav:considering-ces", label: "Programs", path: "/programs", audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:considering-ces/programs/day-programs", parentRef: "nav:considering-ces/programs", label: "Day Programs", path: "/programs/day-programs", audience: "both", sortOrder: 1, visible: true },
  { ref: "nav:considering-ces/programs/language-programs", parentRef: "nav:considering-ces/programs", label: "Afternoon Language Program", path: "/programs/language-programs", audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:considering-ces/programs/enrichment-programs", parentRef: "nav:considering-ces/programs", label: "Enrichment Programs", path: "/programs/enrichment-programs", audience: "both", sortOrder: 3, visible: true },
  { ref: "nav:considering-ces/programs/summer-programs", parentRef: "nav:considering-ces/programs", label: "Summer Programs", path: "/programs/summer-programs", audience: "both", sortOrder: 4, visible: true },
  // The label uses an ASCII HYPHEN-MINUS, as the page's own title does. The plan
  // document renders it typographically as an en dash; that is a rendering
  // artifact of the document, not a content value.
  { ref: "nav:considering-ces/programs/school-age-mandarin-for-grades-k-through-3rd", parentRef: "nav:considering-ces/programs", label: "School Age Mandarin - Grades K through 3", path: "/programs/school-age-mandarin-for-grades-k-through-3rd", audience: "both", sortOrder: 5, visible: false },
  // The FAQ keeps its URL parent — /contact/frequently-asked-questions, and a
  // breadcrumb that still reads Contact — while its MENU parent is where a
  // prospective parent will look for it. That is the whole point of nav_items.
  { ref: "nav:considering-ces/frequently-asked-questions", parentRef: "nav:considering-ces", label: "Frequently Asked Questions", path: "/contact/frequently-asked-questions", audience: "prospective", sortOrder: 3, visible: true },

  // 2 — Our Community.
  { ref: "nav:our-community", parentRef: null, label: "Our Community", path: null, audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:our-community/about", parentRef: "nav:our-community", label: "About", path: "/about", audience: "both", sortOrder: 1, visible: true },
  { ref: "nav:our-community/about/a-letter-from-the-director", parentRef: "nav:our-community/about", label: "A Letter from the Director", path: "/about/a-letter-from-the-director", audience: "both", sortOrder: 1, visible: true },
  { ref: "nav:our-community/about/mission-and-philosophy", parentRef: "nav:our-community/about", label: "Mission and Philosophy", path: "/about/mission-and-philosophy", audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:our-community/about/history", parentRef: "nav:our-community/about", label: "History", path: "/about/history", audience: "both", sortOrder: 3, visible: true },
  { ref: "nav:our-community/about/careers", parentRef: "nav:our-community/about", label: "Careers", path: "/about/careers", audience: "both", sortOrder: 4, visible: true },
  { ref: "nav:our-community/community", parentRef: "nav:our-community", label: "Community", path: "/community", audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:our-community/community/leadership-team", parentRef: "nav:our-community/community", label: "Leadership Team", path: "/community/leadership-team", audience: "both", sortOrder: 1, visible: true },
  { ref: "nav:our-community/community/teaching-team", parentRef: "nav:our-community/community", label: "Teaching Team", path: "/community/teaching-team", audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:our-community/community/board-of-directors", parentRef: "nav:our-community/community", label: "Board of Directors", path: "/community/board-of-directors", audience: "both", sortOrder: 3, visible: true },
  { ref: "nav:our-community/community/families", parentRef: "nav:our-community/community", label: "Families", path: "/community/families", audience: "both", sortOrder: 4, visible: true },
  { ref: "nav:our-community/community/partnerships", parentRef: "nav:our-community/community", label: "Partnerships", path: "/community/partnerships", audience: "both", sortOrder: 5, visible: true },
  { ref: "nav:our-community/events", parentRef: "nav:our-community", label: "Events", path: "/events", audience: "both", sortOrder: 3, visible: true },
  { ref: "nav:our-community/giving", parentRef: "nav:our-community", label: "Giving", path: "/giving", audience: "both", sortOrder: 4, visible: true },
  { ref: "nav:our-community/giving/ways-to-give", parentRef: "nav:our-community/giving", label: "Ways to Give", path: "/giving/ways-to-give", audience: "both", sortOrder: 1, visible: true },
  { ref: "nav:our-community/giving/annual-fund", parentRef: "nav:our-community/giving", label: "Annual Fund", path: "/giving/annual-fund", audience: "both", sortOrder: 2, visible: true },
  { ref: "nav:our-community/giving/auction", parentRef: "nav:our-community/giving", label: "Auction", path: "/giving/auction", audience: "both", sortOrder: 3, visible: true },
  // The clearest demonstration of why this table exists: Donate becomes a child
  // of Giving in the MENU while its page keeps the path /donate. The same
  // grouping through pages.parent_id would have rewritten the URL to
  // /giving/donate and broken every external copy of it.
  { ref: "nav:our-community/giving/donate", parentRef: "nav:our-community/giving", label: "Donate", path: "/donate", audience: "both", sortOrder: 4, visible: true },
  { ref: "nav:our-community/contact", parentRef: "nav:our-community", label: "Contact", path: "/contact", audience: "both", sortOrder: 5, visible: true },

  // 3 — Header Actions. `visible = false` on the GROUP so it never renders as a
  // menu entry, while its two children are visible; SiteHeader derives the group
  // id from the contractual legacy_ref and selects children by parent_id.
  { ref: "nav:header-actions", parentRef: null, label: "Header Actions", path: null, audience: "prospective", sortOrder: 3, visible: false },
  // "Schedule a Visit" states the action where the page states the subject. The
  // menu item above keeps the page title.
  { ref: "nav:header-actions/visit-ces", parentRef: "nav:header-actions", label: "Schedule a Visit", path: "/admissions/visit-ces", audience: "prospective", sortOrder: 1, visible: true },
  { ref: "nav:header-actions/apply", parentRef: "nav:header-actions", label: "Apply", path: "/admissions/apply", audience: "prospective", sortOrder: 2, visible: true },
];

/** The contractual handle `SiteHeader.tsx` resolves the two header CTAs by. */
const HEADER_ACTIONS_REF = "nav:header-actions";

/**
 * The reference census: every figure measured against the reference revision
 * named in `tools/README.md` §2.3.
 *
 * Fatal by default, waivable with `--allow-census-drift`. See the module header
 * for why both halves of that are required.
 */
const REFERENCE_CENSUS: Readonly<Record<string, number>> = {
  "entries.total": 163,
  "entries.pages": 34,
  "entries.people": 77,
  "entries.events": 18,
  "entries.classrooms": 13,
  "entries.promoted": 12,
  "entries.announcements": 4,
  "entries.inspiring_quotes": 5,
  "publish.drafts.total": 55,
  "publish.drafts.pages": 2,
  "publish.drafts.people": 21,
  "publish.drafts.events": 16,
  "publish.drafts.classrooms": 1,
  "publish.drafts.promoted": 12,
  "publish.drafts.announcements": 3,
  "publish.drafts.inspiring_quotes": 0,
  "routes.total": 142,
  "routes.published": 102,
  "routes.draft": 40,
  "prosemirror_nodes.text": 352,
  "prosemirror_nodes.paragraph": 265,
  "prosemirror_nodes.heading": 38,
  "prosemirror_nodes.listItem": 28,
  "prosemirror_nodes.tableCell": 22,
  "prosemirror_nodes.tableRow": 15,
  "prosemirror_nodes.hardBreak": 10,
  "prosemirror_nodes.tableHeader": 8,
  "prosemirror_nodes.bulletList": 6,
  "prosemirror_nodes.table": 5,
  "prosemirror_nodes.blockquote": 2,
  "prosemirror_nodes.orderedList": 1,
  "prosemirror_marks.link": 40,
  "prosemirror_marks.bold": 36,
  "prosemirror_marks.italic": 20,
  "replicator_sets.total": 167,
  "replicator_sets.by_kind.institution": 81,
  "replicator_sets.by_kind.text": 65,
  "replicator_sets.by_kind.image": 6,
  "replicator_sets.by_kind.program": 6,
  "replicator_sets.by_kind.quote": 4,
  "replicator_sets.by_kind.statistic": 3,
  "replicator_sets.by_kind.session": 1,
  "replicator_sets.by_kind.link": 1,
  "replicator_sets.by_handle.education": 81,
  "replicator_sets.by_handle.add_content": 70,
  "replicator_sets.by_handle.programs_offered": 5,
  "replicator_sets.by_handle.slideshow": 5,
  "replicator_sets.by_handle.at_a_glance": 3,
  "replicator_sets.by_handle.sessions": 1,
  "replicator_sets.by_handle.programs_in_this_session": 1,
  "replicator_sets.by_handle.add_link": 1,
  "replicator_sets.without_source_id": 22,
  "bard.pages_with_add_content": 23,
  "bard.replicator_text_sets": 65,
  "bard.standalone_details": 4,
  "bard.standalone_important_notes": 1,
  "table_family.nodes": 50,
  "table_family.entries": 1,
  "faq.top_level_nodes": 23,
  "faq.items": 11,
  "links.total_marks": 40,
  "links.absolute_same_origin": 4,
  "links.internal_scheme": 2,
  "links.bare_email": 5,
  "links.existing_mailto": 13,
  // 40 = 4 + 2 + 5 + 29. `existing_mailto` (13) and `mixed_case_mailto` (9) are
  // informational SUBSETS of `untouched`, not sibling categories: an href that
  // already carries its scheme is not transformed and its case is preserved.
  "links.untouched": 29,
  "nbsp.entries_with_escape": 8,
  "assets.total": 289,
  "assets.deployed": 110,
  "assets.draft_only": 24,
  "assets.archived": 155,
  "assets.bundled": 117,
  "assets.url_aliases": 7,
  "assets.focal_points": 18,
  "assets.focal_zoom_above_one": 5,
  // 133 assets are referenced by an ENTRY, and one more — CESHouseLogo.png — only
  // by `layout.antlers.html`. The two are counted separately because the split is
  // load-bearing: the logo reaches the public bucket through a public
  // `site_globals` key rather than through a published entry, and a scan that
  // conflated the two is how it ended up in the unreferenced pile before
  // build-asset-manifest.ts learned to read templates. `avatar.svg` is the second
  // template-referenced binary in the manifest and is deliberately NOT resolved
  // here: it is retired in favour of the library's avatar fallback, so nothing in
  // the target names it.
  "assets.entry_references": 133,
  "assets.template_references": 1,
  "classroom_relation.forward": 32,
  "classroom_relation.reverse": 24,
  "classroom_relation.both": 15,
  "classroom_relation.union": 41,
  "person_roles.total": 82,
  "page_sections.total": 79,
  "page_sections.disabled": 6,
  "page_sections.by_kind.text": 30,
  "page_sections.by_kind.image": 16,
  "page_sections.by_kind.faq_item": 11,
  "page_sections.by_kind.program": 6,
  "page_sections.by_kind.slide": 5,
  "page_sections.by_kind.quote": 4,
  "page_sections.by_kind.statistic": 3,
  "page_sections.by_kind.testimonial": 3,
  "page_sections.by_kind.session": 1,
  // 81 institution SETS, 80 person_education ROWS. Not a discrepancy to reconcile
  // away: one set in `alex-danton-klein.md` carries `id`, `type` and `enabled` and
  // no `name_of_institution`, and `institution_name` is NOT NULL. The set is
  // preserved in `people.legacy.education_without_institution` and registered as
  // the missing required field it is. The specification and migration 06 both
  // state 81 rows, having counted the sets; this is the measurement.
  "person_education.total": 80,
  "page_classrooms.total": 12,
  "promoted_links.total": 1,
  "site_globals.total": 26,
  "nav_items.total": 38,
  "nav_items.invisible": 3,
  "taxonomy_terms.total": 3,
  "integrity.stale_parent_references": 4,
  "integrity.dangling_announcement_links": 1,
  // TWO cases, not the one the specification names. The first is the documented
  // `school-age-mandarin` draft, which carries `title` against a blueprint
  // declaring five required handles. The second is the empty institution set
  // above — the same class of anomaly, found by measurement rather than by prose.
  "integrity.missing_required_fields": 2,
  "integrity.promoted_link_duplication": 1,
  "integrity.grandfathered_over_length": 6,
  "integrity.disabled_records": 7,
};

/* ==========================================================================
 * 3. Errors, options and the failure contract
 * --------------------------------------------------------------------------
 * Two error classes, because the two failures want different messages. A
 * `UsageError` is the operator's to fix by changing the command; an
 * `ExtractionError` is the corpus's or this program's, and its message names the
 * source file so the reader can go and look.
 * ========================================================================== */

export class UsageError extends Error {
  public override readonly name = "UsageError";
}

export class ExtractionError extends Error {
  public override readonly name = "ExtractionError";
}

export interface Options {
  /** The Statamic checkout to read. REQUIRED: there is no working-tree default. */
  readonly sourceRoot: string;
  /** The repository root the outputs are written under. */
  readonly outRoot: string;
  readonly manifestPath: string;
  /** Waive the reference-census assertions for a run against a newer commit. */
  readonly allowCensusDrift: boolean;
  /** Recorded provenance when the checkout has no readable `.git`. */
  readonly sourceCommitOverride: string | null;
}

const USAGE = `
Usage:
  npm run extract -- --source <path-to-a-statamic-checkout> [options]

Options:
  --source <path>          REQUIRED. A checkout containing content/, resources/
                           and public/assets. There is no default: after the
                           migration this repository has no content/ at all, so a
                           default would silently read an empty tree.
  --out <path>             Repository root the outputs are written under.
                           Defaults to the parent of tools/.
  --manifest <path>        artifacts/assets.manifest.json, produced by
                           build-asset-manifest.ts. Defaults to that path under
                           --out.
  --source-commit <sha>    Provenance for a checkout with no readable .git, as a
                           \`git archive\` extraction has none. A linked worktree
                           (README §2.2) needs no override.
  --allow-census-drift     Report reference-census mismatches instead of failing.
                           Required when extracting a revision newer than the
                           reference one.
  --help                   Print this and exit 0.
`.trim();

/**
 * Parse argv into options.
 *
 * Long flags only, each taking its value as the next argument. No single-letter
 * aliases and no `--flag=value` form: this is invoked from an npm script and
 * from CI, never interactively, so one unambiguous spelling is worth more than
 * convenience.
 */
export const parseOptions = (argv: readonly string[]): Options | "help" => {
  let sourceRoot: string | null = null;
  let outRoot: string | null = null;
  let manifestPath: string | null = null;
  let sourceCommitOverride: string | null = null;
  let allowCensusDrift = false;

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} requires a value.\n\n${USAGE}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--allow-census-drift") {
      allowCensusDrift = true;
      continue;
    }
    if (arg === "--source") {
      sourceRoot = takeValue(arg, index);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outRoot = takeValue(arg, index);
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = takeValue(arg, index);
      index += 1;
      continue;
    }
    if (arg === "--source-commit") {
      sourceCommitOverride = takeValue(arg, index);
      index += 1;
      continue;
    }
    throw new UsageError(`Unrecognized argument ${arg}.\n\n${USAGE}`);
  }

  if (sourceRoot === null) {
    throw new UsageError(
      `--source is required and has no default.\n\n` +
        `After the migration this repository contains no content/ directory, so a\n` +
        `default pointing at the working tree would read an empty corpus and emit\n` +
        `an empty snapshot over a good one. Materialize the revision first —\n` +
        `tools/README.md §2.2 gives both recipes — and name it explicitly.\n\n${USAGE}`,
    );
  }

  // The repository root defaults to the parent of tools/, resolved from this
  // module's own location rather than from process.cwd(): `npm run extract`
  // already runs in tools/, but a direct `npx tsx tools/src/...` from the
  // repository root would otherwise write the outputs one level too high.
  const defaultOutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const resolvedOut = outRoot === null ? defaultOutRoot : resolve(outRoot);

  return {
    sourceRoot: resolve(sourceRoot),
    outRoot: resolvedOut,
    manifestPath:
      manifestPath === null ? join(resolvedOut, DEFAULT_MANIFEST_PATH) : resolve(manifestPath),
    allowCensusDrift,
    sourceCommitOverride,
  };
};

/* ==========================================================================
 * 4. Narrowing helpers
 * --------------------------------------------------------------------------
 * `yaml.parse()` returns `unknown`, and `tools/eslint.config.mjs` makes the
 * whole `no-unsafe-*` family an error, so every value that enters this program
 * passes through one of these before it is used. That is the point rather than
 * the cost: the corpus is 163 hand-edited files and the interesting failures are
 * all shape failures.
 * ========================================================================== */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * An array whose members stay `unknown`.
 *
 * `Array.isArray` on an `unknown` narrows to `any[]`, which would let every
 * member through unchecked — precisely the hole the `no-unsafe-*` rules exist to
 * close. This keeps the members opaque so each one is narrowed where it is used.
 */
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** A string, trimmed of nothing: leading and trailing whitespace can be content. */
const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const asIntegerFrom = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/** An array of records — every replicator set array in the corpus. */
const asRecordArray = (value: unknown): Record<string, unknown>[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    records.push(item);
  }
  return records;
};

/**
 * Assert that a calendar scalar arrived as a string.
 *
 * This is the runtime half of the YAML-engine decision in section 5. Under YAML
 * 1.1 an unquoted `event_date: 2024-04-27` parses as a Date and an unquoted
 * `end_time: 11:00` parses as the integer 660 — sexagesimal. Every date and time
 * in the corpus is single-quoted today, so both engines agree, but this program
 * is re-runnable against a newer commit and a future Statamic write without
 * quotes must fail loudly rather than shift a published event by a day or
 * rewrite its time.
 *
 * `new Date()` is never called on a stored calendar value and no serialized Date
 * is ever emitted.
 */
const requireCalendarString = (
  value: unknown,
  sourceFile: string,
  field: string,
): string => {
  if (typeof value === "string") {
    return value;
  }
  const seen =
    value instanceof Date
      ? `a Date (${value.toISOString()})`
      : `${typeof value} (${JSON.stringify(value)})`;
  throw new ExtractionError(
    `${sourceFile}: ${field} parsed as ${seen} rather than a string. ` +
      `Quote the value in the source, or check that the YAML 1.2 engine is still ` +
      `wired into gray-matter — YAML 1.1 turns an unquoted date into a Date and an ` +
      `unquoted HH:mm into a sexagesimal integer.`,
  );
};

/** Convert Statamic's `updated_at` UNIX epoch to ISO-8601 UTC. */
export const epochToIso = (epoch: number): string => {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new ExtractionError(
      `updated_at must be a non-negative integer UNIX epoch; received ${JSON.stringify(epoch)}.`,
    );
  }
  return new Date(epoch * 1000).toISOString();
};

/**
 * Map a Statamic `updated_by` id to the address that owns it.
 *
 * An unrecognized id is returned verbatim. That is deliberate: provenance is a
 * fact about the corpus, and a made-up mapping would attribute a change to
 * somebody who did not make it.
 */
export const mapUpdatedBy = (updatedBy: string): string =>
  STATAMIC_USERS[updatedBy] ?? updatedBy;


/* ==========================================================================
 * 5. Reading the corpus
 * --------------------------------------------------------------------------
 * THE YAML ENGINE IS THE MOST IMPORTANT DECISION IN THIS SECTION.
 *
 * `gray-matter`'s default engine is js-yaml, which implements YAML 1.1. Under
 * 1.1, `end_time: 11:00` is a sexagesimal INTEGER (660) and `event_date:
 * 2024-04-27` is a Date object. The pinned `yaml@2.9.0` implements YAML 1.2,
 * whose core schema has neither type, so both come back as the strings they are.
 *
 * Every date and time in the corpus is single-quoted today, so both engines
 * happen to agree right now. The engine is still overridden, because this
 * program is re-runnable against a newer source commit and one unquoted write
 * from the Control Panel would otherwise silently corrupt a published event
 * time. `requireCalendarString` is the runtime backstop.
 *
 * `\_` is the standard double-quoted YAML escape for U+00A0 in both 1.1 and
 * 1.2, so NBSP handling is unaffected by the choice — verified against the 8
 * entries that use it. There are zero raw U+00A0 bytes on disk, which is why
 * every byte-equality assertion in this program is made on PARSED STRINGS and
 * never on YAML source.
 * ========================================================================== */

const YAML_ENGINE = {
  yaml: {
    // gray-matter's engine contract declares `parse` as returning `object`, so
    // the narrowing happens here rather than being deferred: an empty front
    // matter block yields the empty mapping, and anything that is neither a
    // mapping nor empty is refused. Every caller still treats each VALUE inside
    // the mapping as `unknown` and narrows it explicitly — this only establishes
    // that the front matter itself is a mapping.
    parse: (input: string): object => {
      const value: unknown = YAML.parse(input);
      if (value === null || value === undefined) {
        return {};
      }
      if (!isRecord(value)) {
        throw new ExtractionError(
          `Front matter parsed to ${typeof value} rather than a mapping. Statamic entries are ` +
            `always a YAML mapping, so this is a malformed file rather than a shape to support.`,
        );
      }
      return value;
    },
    // gray-matter's engine contract includes a stringifier. Nothing in this
    // program writes YAML, so it refuses rather than round-tripping badly: a
    // silent re-serialization is exactly the operation README §5.6 warns is not
    // escape-for-escape faithful.
    stringify: (): string => {
      throw new ExtractionError(
        "This program never writes YAML. Front matter is read-only here.",
      );
    },
  },
};

/** One parsed entry file. */
interface SourceEntry {
  /** Repository-relative path in the source checkout, e.g. `content/collections/pages/home.md`. */
  readonly sourceFile: string;
  /** The filename stem, which is the slug Statamic derives. */
  readonly slug: string;
  readonly collection: CollectionName;
  readonly data: Readonly<Record<string, unknown>>;
  /** The markdown body. Empty on all 163 entries; carried so a future one is not lost. */
  readonly body: string;
  readonly sha256: string;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const readTextFile = async (path: string): Promise<string> => readFile(path, "utf8");

const readTextIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Parse one entry file.
 *
 * `slug` comes from the FILENAME STEM, always. No entry in the corpus carries a
 * `slug:` key — Statamic derives it from the file name — and that includes
 * `announcements` and `inspiring_quotes`, which is why they have `slug` columns
 * despite having no slug field.
 *
 * A slug is never derived from a title, and the corpus shows why:
 * `2023-24-admissions-season-now-open-apply-today.md` is titled "Summer Camp
 * 2023 Registration Opens to the Public, 2/15!" — a different subject entirely.
 * The mismatch is preserved, not reconciled.
 */
const parseEntry = async (
  sourceRoot: string,
  collection: CollectionName,
  fileName: string,
): Promise<SourceEntry> => {
  const relative = `content/collections/${collection}/${fileName}`;
  const raw = await readTextFile(join(sourceRoot, relative));
  const parsed = matter(raw, { engines: YAML_ENGINE });
  const data: unknown = parsed.data;
  if (!isRecord(data)) {
    throw new ExtractionError(`${relative}: front matter did not parse to a mapping.`);
  }
  return {
    sourceFile: relative,
    slug: basename(fileName, ".md"),
    collection,
    data,
    body: parsed.content,
    sha256: sha256(raw),
  };
};

/** Parse a plain YAML file (a collection config, the tree, a taxonomy term). */
const parseYamlFile = async (
  sourceRoot: string,
  relative: string,
): Promise<{ readonly value: unknown; readonly sha256: string }> => {
  const raw = await readTextFile(join(sourceRoot, relative));
  return { value: YAML.parse(raw), sha256: sha256(raw) };
};

/** Every `.md` file in a collection directory, in filename order. */
const listEntryFiles = async (
  sourceRoot: string,
  collection: CollectionName,
): Promise<string[]> => {
  const dir = join(sourceRoot, "content", "collections", collection);
  if (!(await isDirectory(dir))) {
    throw new ExtractionError(
      `${dir} is not a directory. --source must name a Statamic checkout that still ` +
        `contains content/collections/**; see tools/README.md §2.2 for how to ` +
        `materialize one.`,
    );
  }
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith(".md")).sort((left, right) => (left < right ? -1 : 1));
};

/**
 * Read the checkout's commit id, or null.
 *
 * Deliberately reads `.git` directly rather than shelling out: a `git archive`
 * extraction has no `.git` at all and gets null plus a note, while the linked
 * worktree README §2.2 recommends has a `.git` FILE pointing at the real gitdir
 * and resolves normally. `--source-commit` covers the archive case without ever
 * fabricating a SHA.
 */
const readSourceCommit = async (
  sourceRoot: string,
  notes: string[],
): Promise<string | null> => {
  const unresolved = (reason: string): null => {
    notes.push(
      `source_commit could not be read (${reason}). Pass --source-commit <sha> to ` +
        `record provenance explicitly; nothing is fabricated.`,
    );
    return null;
  };

  const gitPath = join(sourceRoot, ".git");
  let gitDir: string;
  if (await isDirectory(gitPath)) {
    gitDir = gitPath;
  } else {
    const pointer = await readTextIfExists(gitPath);
    if (pointer === null) {
      return unresolved("the checkout has no .git entry, as a `git archive` extraction does not");
    }
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    const target = match?.[1]?.trim();
    if (target === undefined || target === "") {
      return unresolved("the .git file does not name a gitdir");
    }
    gitDir = resolve(sourceRoot, target);
  }

  const head = await readTextIfExists(join(gitDir, "HEAD"));
  if (head === null) {
    return unresolved("HEAD is missing");
  }
  const trimmed = head.trim();
  if (/^[0-9a-f]{40,64}$/.test(trimmed)) {
    return trimmed;
  }
  const refMatch = /^ref:\s*(.+)$/.exec(trimmed);
  const ref = refMatch?.[1]?.trim();
  if (ref === undefined || ref === "") {
    return unresolved("HEAD is neither an object id nor a symbolic ref");
  }
  const loose = await readTextIfExists(join(gitDir, ref));
  if (loose !== null && /^[0-9a-f]{40,64}$/.test(loose.trim())) {
    return loose.trim();
  }
  const packed = await readTextIfExists(join(gitDir, "packed-refs"));
  if (packed !== null) {
    for (const line of packed.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const objectId = parts[0];
      const name = parts[1];
      if (objectId !== undefined && name === ref && /^[0-9a-f]{40,64}$/.test(objectId)) {
        return objectId;
      }
    }
  }
  return unresolved(`${ref} could not be resolved`);
};

/* ==========================================================================
 * 6. Identity
 * --------------------------------------------------------------------------
 * Every row id is derived, so the load is idempotent and a child row can name
 * its parent before the parent exists.
 * ========================================================================== */

/** Parse a hyphenated uuid into its 16 bytes. */
const uuidToBytes = (uuid: string): Buffer => {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new ExtractionError(`${uuid} is not a uuid.`);
  }
  return Buffer.from(hex, "hex");
};

/**
 * RFC 4122 version 5 (SHA-1, name-based), implemented locally.
 *
 * There is no `uuid` package in this project's pinned dependency set and none is
 * added for sixteen lines of arithmetic. The algorithm: SHA-1 over the namespace
 * bytes concatenated with the UTF-8 name, take the first 16 bytes, set the
 * version nibble to 5 and the two variant bits, then hyphenate.
 *
 * It must agree exactly with `extensions.uuid_generate_v5()`, because
 * `supabase/seed.sql` resolves ids by calling `public.ces_uuid()` in the
 * database while the fallback JSON embeds the literal computed here. A unit test
 * checks both a published RFC 4122 vector and the agreement of the two.
 */
export const uuidV5 = (namespace: string, name: string): string => {
  const hash = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new ExtractionError("sha1 digest was shorter than 16 bytes, which cannot happen.");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

/**
 * The row id for `(logical table, legacy_ref)`.
 *
 * `legacy_ref` is `text` and TABLE-SCOPED, so `pages:home` and `people:home`
 * derive different uuids and cannot collide. Its values are heterogeneous by
 * design: an entry's own `id` for most rows, the literal string `home` for the
 * home page (the tree names it as a bare string, not a uuid), the slug for a
 * taxonomy term, the source path for an asset, the key for a global, and a
 * designed handle for a nav item.
 */
export const deriveEntityUuid = (table: string, legacyRef: string): string =>
  uuidV5(CES_UUID_NAMESPACE, `${table}:${legacyRef}`);

/**
 * The `legacy_ref` for a child row: `<parent>:<field handle>:<ordinal>`, with
 * the ordinal in SOURCE ORDER.
 *
 * Mandatory rather than stylistic. 22 of the 167 replicator sets in the corpus
 * carry no `id` at all — 12 `text`, 7 `institution` and 3 `quote` — and
 * ProseMirror nodes never do. An identity scheme resting on the source id would
 * have nothing to rest on for those rows, and the load would stop being
 * idempotent exactly where the corpus is least regular. Where a source id does
 * exist it is retained in `legacy.set_id` for traceability only.
 */
export const deriveChildLegacyRef = (
  parentLegacyRef: string,
  fieldHandle: string,
  ordinal: number,
): string => {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new ExtractionError(
      `Child ordinal must be a non-negative integer; received ${JSON.stringify(ordinal)}.`,
    );
  }
  return `${parentLegacyRef}:${fieldHandle}:${String(ordinal)}`;
};

/* ==========================================================================
 * 7. Rich text: the one canonical Bard <-> Tiptap conversion
 * --------------------------------------------------------------------------
 * Three shapes are in play and they are not interchangeable:
 *
 *   standalone Bard field      a BARE ARRAY of ProseMirror nodes, no wrapper.
 *                              `events.details` (on 4 of the 18 events) and
 *                              `important_notes` (on summer-programs alone).
 *   Bard inside a replicator   that same bare array under the set's own `text`
 *                              key, beside the set's `id`, `type` and `enabled`.
 *                              65 of them, across 23 pages.
 *   Tiptap                     a single `doc` node with a `content` array.
 *
 * The database stores the Tiptap shape, because that is what the editor
 * round-trips without transformation. Wrap a bare array twice, or export a `doc`
 * where a bare array belongs, and the field still parses while its content sits
 * one level out of place — which is why the round-trip proof exists.
 * ========================================================================== */

/**
 * THE PARSING TRAP, and the only reliable test for it.
 *
 * A replicator set of `type: "text"` and a ProseMirror `text` node are
 * indistinguishable by the `type` key alone. The discriminator is the `text` key
 * itself: a SET holds an ARRAY there, a NODE holds a STRING.
 *
 * Counting `type == "text"` naively returns 417 across the corpus, which is 352
 * genuine text nodes plus 65 `text` sets — and 417 is exactly the figure the
 * technical specification reports as its text-node count. Any traversal that
 * skips this test mis-handles both.
 */
export const isReplicatorTextSet = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  return value["type"] === "text" && Array.isArray(value["text"]);
};

/** Narrow one parsed value to a ProseMirror mark, preserving its attrs verbatim. */
const toMark = (value: unknown, sourceFile: string): ProseMirrorMark => {
  if (!isRecord(value)) {
    throw new ExtractionError(`${sourceFile}: a rich-text mark is not a mapping.`);
  }
  const type = asString(value["type"]);
  if (type === null) {
    throw new ExtractionError(`${sourceFile}: a rich-text mark carries no type.`);
  }
  const attrs = value["attrs"];
  // `attrs` is only present when the source has it, and `null` is a real value
  // in this corpus: several marks carry `attrs: {href, rel: null, ...}`. Copying
  // the object wholesale preserves both its keys and their insertion order,
  // which is what makes the round-trip deep-equality assertion meaningful.
  if (attrs === undefined) {
    return { type };
  }
  if (!isRecord(attrs)) {
    throw new ExtractionError(`${sourceFile}: mark ${type} has non-mapping attrs.`);
  }
  return { type, attrs: { ...attrs } };
};

/**
 * Narrow one parsed value to a ProseMirror node.
 *
 * The three optional keys are copied only when the source has them. That matters
 * for `content` above all: the corpus holds 18 empty `paragraph` nodes with NO
 * `content` key, and most serializers would normalize them to `content: []`.
 * Import and export must preserve the absence, or the round trip is not lossless.
 */
const toNode = (value: unknown, sourceFile: string): ProseMirrorNode => {
  if (!isRecord(value)) {
    throw new ExtractionError(`${sourceFile}: a rich-text node is not a mapping.`);
  }
  const type = asString(value["type"]);
  if (type === null) {
    throw new ExtractionError(`${sourceFile}: a rich-text node carries no type.`);
  }

  const node: {
    type: string;
    content?: readonly ProseMirrorNode[];
    marks?: readonly ProseMirrorMark[];
    attrs?: Readonly<Record<string, unknown>>;
    text?: string;
  } = { type };

  if ("attrs" in value) {
    const attrs = value["attrs"];
    if (!isRecord(attrs)) {
      throw new ExtractionError(`${sourceFile}: node ${type} has non-mapping attrs.`);
    }
    node.attrs = { ...attrs };
  }
  if ("marks" in value) {
    const marks = value["marks"];
    if (!Array.isArray(marks)) {
      throw new ExtractionError(`${sourceFile}: node ${type} has non-array marks.`);
    }
    node.marks = marks.map((mark) => toMark(mark, sourceFile));
  }
  if ("text" in value) {
    const text = asString(value["text"]);
    if (text === null) {
      throw new ExtractionError(
        `${sourceFile}: node ${type} has a non-string text value. If this is a ` +
          `replicator set rather than a node, the traversal reached it through the ` +
          `wrong branch — see isReplicatorTextSet.`,
      );
    }
    node.text = text;
  }
  if ("content" in value) {
    const content = value["content"];
    if (!Array.isArray(content)) {
      throw new ExtractionError(`${sourceFile}: node ${type} has non-array content.`);
    }
    node.content = content.map((child) => toNode(child, sourceFile));
  }

  return node;
};

/**
 * A standalone field's bare node array, or a `text` set's `text` value, becomes
 * a Tiptap `doc`.
 */
export const bardToTiptapDoc = (nodes: readonly unknown[], sourceFile: string): TiptapDoc => ({
  type: "doc",
  content: nodes.map((node) => toNode(node, sourceFile)),
});

/**
 * The inverse: a `doc` serializes back to a BARE node array — as a standalone
 * field's value, or as a `text` set's `text` key.
 *
 * `export-fallback.ts` and the round-trip proof both call this. It returns the
 * node array itself rather than a copy, because the nodes are immutable by type
 * and a copy would only make the deep-equality assertion weaker.
 */
export const tiptapDocToBardNodes = (doc: TiptapDoc): readonly ProseMirrorNode[] => {
  // Widened deliberately. The type says `"doc"`, but `export-fallback.ts` reads
  // this value back out of committed JSON where the type is an assertion rather
  // than a guarantee — so the check is a runtime one and must survive the fact
  // that the compiler considers it unreachable.
  const type: string = doc.type;
  if (type !== "doc") {
    throw new ExtractionError(
      `A rich-text value must be a Tiptap doc before export; received type ${type}.`,
    );
  }
  return doc.content;
};

/** Walk every node in a document, parents before children. */
const walkNodes = (
  nodes: readonly ProseMirrorNode[],
  visit: (node: ProseMirrorNode) => void,
): void => {
  for (const node of nodes) {
    visit(node);
    if (node.content !== undefined) {
      walkNodes(node.content, visit);
    }
  }
};

/**
 * The concatenated text of a node run.
 *
 * Used by the FAQ parity assertion and by the description fallbacks. Text runs
 * are joined without a separator inside a block and blocks with a single newline,
 * so the result is comparable between the source document and the rebuilt page
 * without either side normalizing whitespace — the 45-character pure-whitespace
 * run in `tuition.md` and the trailing NBSPs in the FAQ are content and survive.
 */
const nodeText = (node: ProseMirrorNode): string => {
  if (node.type === "text") {
    return node.text ?? "";
  }
  if (node.type === "hardBreak") {
    return "\n";
  }
  if (node.content === undefined) {
    return "";
  }
  return node.content.map((child) => nodeText(child)).join("");
};

const documentText = (nodes: readonly ProseMirrorNode[]): string =>
  nodes.map((node) => nodeText(node)).join("\n");

/**
 * The round-trip proof, run over every Bard-bearing field as it is imported.
 *
 * import -> export -> re-import, asserting deep equality of the node trees. It
 * runs inline rather than only in the unit tests so that a corpus the tests do
 * not enumerate — a newer revision, say — still cannot pass through this program
 * with a lossy conversion.
 */
const assertRoundTrip = (
  nodes: readonly unknown[],
  doc: TiptapDoc,
  sourceFile: string,
  field: string,
): void => {
  const exported = tiptapDocToBardNodes(doc);
  const reimported = bardToTiptapDoc(exported, sourceFile);
  const first = JSON.stringify(doc);
  const second = JSON.stringify(reimported);
  if (first !== second) {
    throw new ExtractionError(
      `${sourceFile}: rich-text round trip is not lossless for ${field}. ` +
        `This is the assertion that protects the 18 content-less paragraph nodes and ` +
        `the table attributes; do not relax it.`,
    );
  }
  // The source array and the exported array must hold the same nodes in the same
  // order. Comparing lengths catches the wrap-twice mistake, which JSON equality
  // above would not: a doubly-wrapped document is internally self-consistent.
  if (exported.length !== nodes.length) {
    throw new ExtractionError(
      `${sourceFile}: ${field} exported ${String(exported.length)} top-level nodes ` +
        `from a source array of ${String(nodes.length)}.`,
    );
  }
};


/* ==========================================================================
 * 8. The authorized link transformations
 * --------------------------------------------------------------------------
 * Applied CORPUS-WIDE BY RULE, never as a list of patches. That distinction is
 * the whole design: a link added to the corpus tomorrow in any of these shapes
 * is handled by the same code, and re-running against a newer commit produces
 * the same result without anyone remembering to re-apply anything. The eleven
 * records the specification enumerates are evidence that the rules fire where
 * expected, not inputs to a hand-edit — so every affected record is reported in
 * `migration-source-manifest.json` and the counts are asserted against the
 * reference census.
 * ========================================================================== */

export type LinkTransformKind =
  | "absolute_same_origin"
  | "internal_scheme"
  | "bare_email"
  | "existing_mailto"
  | "untouched";

export interface LinkNormalization {
  readonly href: string;
  readonly kind: LinkTransformKind;
  readonly changed: boolean;
}

/**
 * Classify an href and apply the two transformations that need no corpus lookup.
 *
 * (a) An absolute URL whose host is this site becomes the equivalent
 *     root-relative path. The destination is unchanged and no redirect is
 *     involved; what it fixes is that an absolute URL to your own origin defeats
 *     client-side routing, so the browser performs a full document load and
 *     discards the application. `cambridge-ellis.myschoolapp.com` is a DIFFERENT
 *     host and is left alone — the check is on the whole host, never a substring.
 *
 * (c) A bare email address becomes `mailto:`. With no scheme the browser
 *     resolves the href as a RELATIVE PATH, so clicking it lands on a 404
 *     instead of opening a mail client — on the apply and financial-aid pages,
 *     the two highest-intent pages on the site. The scheme is added and nothing
 *     else: the visible link text and the address's case are preserved
 *     byte-for-byte.
 *
 * Everything else passes through untouched, and one class of "everything else"
 * is called out because tidying it would be an unrequested content change:
 * thirteen hrefs are already `mailto:` and nine of those carry uppercase
 * characters. The local part of an address is case-sensitive by specification and
 * these are the addresses the school publishes.
 *
 * `internal_scheme` is classified here but resolved by `resolveStatamicEntryUri`,
 * which needs the corpus.
 */
export const normalizeLinkHref = (href: string): LinkNormalization => {
  if (href.startsWith(STATAMIC_ENTRY_SCHEME)) {
    return { href, kind: "internal_scheme", changed: false };
  }

  const lower = href.toLowerCase();
  if (lower.startsWith("mailto:")) {
    return { href, kind: "existing_mailto", changed: false };
  }

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    // `URL` is used rather than a regex so that userinfo, a port or an unusual
    // encoding cannot smuggle the school's hostname past a substring test.
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return { href, kind: "untouched", changed: false };
    }
    if (!SAME_ORIGIN_HOSTS.includes(parsed.hostname.toLowerCase())) {
      return { href, kind: "untouched", changed: false };
    }
    const rootRelative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return {
      href: rootRelative === "" ? "/" : rootRelative,
      kind: "absolute_same_origin",
      changed: rootRelative !== href,
    };
  }

  // A scheme this program does not know about — `tel:`, `sms:`, anything a
  // future editor adds — is left exactly as it is. Only a schemeless value can
  // be a bare email address.
  if (KNOWN_HREF_SCHEME.test(href)) {
    return { href, kind: "untouched", changed: false };
  }

  if (BARE_EMAIL.test(href)) {
    return { href: `mailto:${href}`, kind: "bare_email", changed: true };
  }

  return { href, kind: "untouched", changed: false };
};

/**
 * (b) Resolve `statamic://entry::<uuid>` to the entry's canonical path.
 *
 * AN UNRESOLVABLE UUID FAILS THE EXTRACTION. That is deliberately fatal rather
 * than a warning: the alternatives are shipping a `statamic://` href into
 * production, where it is a dead link on a live page, or silently dropping the
 * link and losing the reference. A build that stops is cheaper than either.
 */
export const resolveStatamicEntryUri = (
  href: string,
  pathsByEntryId: ReadonlyMap<string, string>,
): string => {
  if (!href.startsWith(STATAMIC_ENTRY_SCHEME)) {
    throw new ExtractionError(`${href} is not a Statamic internal entry reference.`);
  }
  const entryId = href.slice(STATAMIC_ENTRY_SCHEME.length);
  const path = pathsByEntryId.get(entryId);
  if (path === undefined) {
    throw new ExtractionError(
      `Unresolvable internal link ${href}: no entry in the corpus carries id ${entryId}. ` +
        `Extraction stops here rather than shipping an unresolved scheme into ` +
        `production or silently dropping the link.`,
    );
  }
  return path;
};

/** One transformed link, recorded for the source manifest. */
export interface LinkRecord {
  readonly source_file: string;
  readonly field: string;
  readonly kind: LinkTransformKind;
  readonly from: string;
  readonly to: string;
  readonly text: string | null;
}

/** Tallies of every link the corpus holds, transformed or not. */
interface LinkTally {
  total: number;
  absolute_same_origin: number;
  internal_scheme: number;
  bare_email: number;
  existing_mailto: number;
  untouched: number;
  mixed_case_mailto: number;
}

const emptyLinkTally = (): LinkTally => ({
  total: 0,
  absolute_same_origin: 0,
  internal_scheme: 0,
  bare_email: 0,
  existing_mailto: 0,
  untouched: 0,
  mixed_case_mailto: 0,
});

/**
 * Rewrite every `link` mark in a document through the rules above.
 *
 * The mark object is rebuilt with `{...attrs, href}` rather than assembled from
 * scratch. Spreading keeps `href` in its original position and carries every
 * other key — the corpus holds two different attrs key orders, `{href, rel,
 * target, title}` and `{href, target, rel}` — so a document with no transformed
 * link serializes byte-identically to its source.
 */
const transformLinks = (
  doc: TiptapDoc,
  sourceFile: string,
  field: string,
  pathsByEntryId: ReadonlyMap<string, string>,
  tally: LinkTally,
  records: LinkRecord[],
  hrefs: { source_file: string; field: string; href: string }[],
): TiptapDoc => {
  const mapMark = (mark: ProseMirrorMark, ownerText: string | null): ProseMirrorMark => {
    if (mark.type !== "link" || mark.attrs === undefined) {
      return mark;
    }
    const href = asString(mark.attrs["href"]);
    if (href === null) {
      return mark;
    }

    tally.total += 1;
    hrefs.push({ source_file: sourceFile, field, href });
    const normalized = normalizeLinkHref(href);
    let finalHref = normalized.href;
    const kind = normalized.kind;

    if (kind === "internal_scheme") {
      finalHref = resolveStatamicEntryUri(href, pathsByEntryId);
    }
    if (kind === "existing_mailto" && href !== href.toLowerCase()) {
      tally.mixed_case_mailto += 1;
    }

    switch (kind) {
      case "absolute_same_origin":
        tally.absolute_same_origin += 1;
        break;
      case "internal_scheme":
        tally.internal_scheme += 1;
        break;
      case "bare_email":
        tally.bare_email += 1;
        break;
      case "existing_mailto":
        // Counted in BOTH buckets, deliberately. `existing_mailto` and
        // `mixed_case_mailto` are informational subsets of `untouched`, not
        // sibling categories: an href that already carries the scheme is not
        // transformed, and its case is preserved rather than normalized. The
        // four transformed kinds are disjoint and sum with `untouched` to
        // `total`, which is the invariant the census is read against.
        tally.existing_mailto += 1;
        tally.untouched += 1;
        break;
      case "untouched":
        tally.untouched += 1;
        break;
    }

    if (finalHref === href) {
      return mark;
    }
    records.push({
      source_file: sourceFile,
      field,
      kind,
      from: href,
      to: finalHref,
      text: ownerText,
    });
    return { type: mark.type, attrs: { ...mark.attrs, href: finalHref } };
  };

  const mapNode = (node: ProseMirrorNode): ProseMirrorNode => {
    const next: {
      type: string;
      content?: readonly ProseMirrorNode[];
      marks?: readonly ProseMirrorMark[];
      attrs?: Readonly<Record<string, unknown>>;
      text?: string;
    } = { type: node.type };
    if (node.attrs !== undefined) {
      next.attrs = node.attrs;
    }
    if (node.marks !== undefined) {
      next.marks = node.marks.map((mark) => mapMark(mark, node.text ?? null));
    }
    if (node.text !== undefined) {
      next.text = node.text;
    }
    if (node.content !== undefined) {
      next.content = node.content.map((child) => mapNode(child));
    }
    return next;
  };

  return { type: "doc", content: doc.content.map((node) => mapNode(node)) };
};

/* ==========================================================================
 * 9. The FAQ split
 * --------------------------------------------------------------------------
 * `pages/frequently-asked-questions.md` holds exactly one `add_content` set of
 * type `text`, whose document is a flat run of 23 top-level nodes: one level-2
 * HEADING reading "Language Program", then 22 paragraphs, eleven opening `Q:`
 * and eleven `A:`. The source has no question/answer structure at all.
 *
 * The rule is generic rather than aimed at that file — a document containing any
 * `Q:` paragraph is split — which is what makes it a rule. Measured against the
 * reference revision it fires on exactly one page and yields exactly 11 items.
 * ========================================================================== */

export type FaqPart =
  | { readonly kind: "text"; readonly nodes: readonly ProseMirrorNode[] }
  | { readonly kind: "faq_item"; readonly question: string; readonly answer: string };

/** Does this node open an FAQ item? */
const opensFaqItem = (node: ProseMirrorNode): boolean => {
  if (node.type !== "paragraph" || node.content === undefined) {
    return false;
  }
  const first = node.content[0];
  if (first === undefined || first.type !== "text") {
    return false;
  }
  return (first.text ?? "").startsWith(FAQ_QUESTION_PREFIX);
};

export const documentHasFaqPairs = (doc: TiptapDoc): boolean =>
  doc.content.some((node) => opensFaqItem(node));

/**
 * Split a document into ordered parts: prose runs and question/answer items.
 *
 * A paragraph whose first text node begins `Q:` opens an item; the following
 * nodes up to the next `Q:` form its answer. Anything OUTSIDE a pair is
 * preserved in document order as a prose run, which is the half that is easy to
 * get wrong here: the leading node is a level-2 heading, not a paragraph, and a
 * splitter that assumed otherwise — or that discarded everything before the
 * first `Q:` — would silently lose it.
 *
 * Question and answer text is stored VERBATIM, including the `Q:` and `A:`
 * prefixes and the non-breaking spaces that follow two of the questions.
 * Stripping the prefix would be an editorial change to migrated content and
 * would make the parity assertion approximate instead of exact; the renderer is
 * free to present it however it likes.
 */
export const splitFaqDocument = (doc: TiptapDoc): readonly FaqPart[] => {
  const parts: FaqPart[] = [];
  let prose: ProseMirrorNode[] = [];

  const flushProse = (): void => {
    if (prose.length > 0) {
      parts.push({ kind: "text", nodes: prose });
      prose = [];
    }
  };

  let index = 0;
  while (index < doc.content.length) {
    const node = doc.content[index];
    if (node === undefined) {
      index += 1;
      continue;
    }
    if (!opensFaqItem(node)) {
      prose.push(node);
      index += 1;
      continue;
    }

    flushProse();
    const question = nodeText(node);
    const answerNodes: ProseMirrorNode[] = [];
    index += 1;
    while (index < doc.content.length) {
      const next = doc.content[index];
      if (next === undefined || opensFaqItem(next)) {
        break;
      }
      answerNodes.push(next);
      index += 1;
    }
    parts.push({
      kind: "faq_item",
      question,
      answer: answerNodes.map((answerNode) => nodeText(answerNode)).join("\n"),
    });
  }

  flushProse();
  return parts;
};

/** The text a split part contributes, in the same joining as `documentText`. */
const faqPartText = (part: FaqPart): string =>
  part.kind === "text" ? documentText(part.nodes) : [part.question, part.answer].join("\n");

/**
 * The parity assertion, and it is the one that matters.
 *
 * Two properties must hold: at least one item was produced, and the concatenated
 * text of the rebuilt page equals the source document's text content —
 * non-breaking spaces, en dashes and all. That is what makes "nothing is
 * dropped" a checked property rather than a claim.
 *
 * Returning `false` rather than throwing implements the documented fallback: the
 * caller renders the document as one ordinary prose section, losing the
 * disclosure affordance but never the content.
 */
const faqSplitIsFaithful = (doc: TiptapDoc, parts: readonly FaqPart[]): boolean => {
  if (!parts.some((part) => part.kind === "faq_item")) {
    return false;
  }
  return parts.map((part) => faqPartText(part)).join("\n") === documentText(doc.content);
};

/* ==========================================================================
 * 10. The asset manifest
 * --------------------------------------------------------------------------
 * Read, never re-derived. `build-asset-manifest.ts` owns the one collision-
 * checked `source -> normalized` filename map, and four consumers read it: the
 * image paths in the fallback JSON, the filesystem relocation, the Storage
 * object keys, and every database reference including the typed global logo and
 * the focal-point rows. Four independent normalizations would agree right up
 * until one of them handled a character differently, at which point a database
 * row would point at an object key that does not exist.
 * ========================================================================== */

interface AssetIndex {
  readonly manifest: AssetManifest;
  readonly byLegacyRef: ReadonlyMap<string, AssetManifestEntry>;
  readonly rows: readonly AssetRow[];
  /**
   * Filename -> the source files that referenced it.
   *
   * A map rather than a set, because the census reports ENTRY references and
   * TEMPLATE references separately and the manifest's own scan splits them the
   * same way. Collapsing the two would make the logo — referenced by
   * `layout.antlers.html` and by no entry — indistinguishable from a photograph
   * on a page.
   */
  readonly referenced: Map<string, string[]>;
}

const loadAssetManifest = async (manifestPath: string): Promise<AssetManifest> => {
  const raw = await readTextIfExists(manifestPath);
  if (raw === null) {
    throw new UsageError(
      `${manifestPath} is missing.\n\n` +
        `build-asset-manifest.ts must run FIRST — it owns the one collision-checked\n` +
        `filename map and the three-way asset classification this program reads\n` +
        `rather than re-deriving. Run:\n\n` +
        `  npm run asset-manifest -- --source <path-to-a-statamic-checkout>\n`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed["assets"])) {
    throw new ExtractionError(`${manifestPath} is not an asset manifest.`);
  }
  // The manifest is this project's own output, written by a program held to the
  // same gates, so its shape is asserted rather than re-validated field by field.
  // The one thing worth checking is that the entries carry the keys this program
  // reads, because a silent undefined here becomes a null column.
  for (const entry of parsed["assets"]) {
    if (
      !isRecord(entry) ||
      typeof entry["legacy_ref"] !== "string" ||
      typeof entry["path"] !== "string" ||
      typeof entry["bucket"] !== "string" ||
      typeof entry["class"] !== "string"
    ) {
      throw new ExtractionError(
        `${manifestPath}: an asset entry is missing legacy_ref, path, bucket or class. ` +
          `Regenerate it with build-asset-manifest.ts.`,
      );
    }
  }
  return parsed as unknown as AssetManifest;
};

/** Build the asset rows and the lookup every content field resolves through. */
const buildAssetIndex = (manifest: AssetManifest): AssetIndex => {
  const byLegacyRef = new Map<string, AssetManifestEntry>();
  for (const entry of manifest.assets) {
    if (byLegacyRef.has(entry.legacy_ref)) {
      throw new ExtractionError(
        `The asset manifest carries two entries for ${entry.legacy_ref}, which its own ` +
          `injectivity assertion should have caught.`,
      );
    }
    byLegacyRef.set(entry.legacy_ref, entry);
  }

  const rows: AssetRow[] = manifest.assets.map((entry) => {
    const focus: FocalPoint | null = entry.focus;
    return {
      id: deriveEntityUuid("assets", entry.legacy_ref),
      legacy_ref: entry.legacy_ref,
      bucket: entry.bucket,
      path: entry.path,
      filename: entry.filename,
      mime: entry.mime,
      size_bytes: entry.size_bytes,
      width: entry.width,
      height: entry.height,
      alt: null,
      focus_x: focus === null ? null : focus.x,
      focus_y: focus === null ? null : focus.y,
      focus_zoom: focus === null ? null : focus.zoom,
      lifecycle: "stored",
      created_by: null,
      declared_size_bytes: null,
      reservation_expires_at: null,
      class: entry.class,
      bundled: entry.bundled,
      bundled_path: entry.bundled_path,
    };
  });

  return { manifest, byLegacyRef, rows, referenced: new Map<string, string[]>() };
};

/**
 * Resolve one asset filename from an entry to its row id.
 *
 * A reference that does not resolve through the manifest ABORTS. The alternative
 * is a null image on a live page and an asset the upload step never learns about.
 */
const resolveAssetId = (
  index: AssetIndex,
  filename: string,
  sourceFile: string,
  field: string,
): string => {
  const entry = index.byLegacyRef.get(filename);
  if (entry === undefined) {
    const normalized = normalizeAssetFilename(filename);
    throw new ExtractionError(
      `${sourceFile}: ${field} references ${filename}, which the asset manifest does ` +
        `not contain (it would normalize to ${normalized}). Either the binary is ` +
        `missing from public/assets or the manifest is stale — regenerate it with ` +
        `build-asset-manifest.ts against the same checkout.`,
    );
  }
  const sources = index.referenced.get(filename);
  if (sources === undefined) {
    index.referenced.set(filename, [sourceFile]);
  } else if (!sources.includes(sourceFile)) {
    sources.push(sourceFile);
  }
  return deriveEntityUuid("assets", entry.legacy_ref);
};


/* ==========================================================================
 * 11. The extraction context
 * --------------------------------------------------------------------------
 * One mutable accumulator threaded through the builders. It holds the censuses,
 * the run notes, the per-file provenance records and the integrity register, so
 * that every count this program reports is computed from the same traversal that
 * built the rows rather than from a second pass that could disagree with it.
 * ========================================================================== */

/** What one consumed source file yielded. Mutable while building, frozen on emit. */
interface SourceFileRecord {
  path: string;
  sha256: string;
  role: string;
  collection: string | null;
  slug: string | null;
  keys: string[];
  target_table: string | null;
  legacy_ref: string | null;
  route: string | null;
  published: boolean | null;
  relations: Record<string, unknown>;
  asset_references: string[];
  notes: string[];
}

interface Integrity {
  staleParents: {
    slug: string;
    source_file: string;
    raw_parent: string;
    effective_parent_slug: string | null;
  }[];
  danglingAnnouncementLinks: { slug: string; source_file: string; raw_link: string }[];
  missingRequiredFields: {
    collection: string;
    slug: string;
    source_file: string;
    blueprint: string;
    missing: string[];
  }[];
  promotedLinkDuplication: {
    slug: string;
    source_file: string;
    scalar_link: string;
    replicator_link: string;
  }[];
  grandfathered: GrandfatheredValue[];
  disabledRecords: { table: string; legacy_ref: string; source_file: string }[];
}

interface Context {
  readonly sourceRoot: string;
  readonly assets: AssetIndex;
  readonly notes: string[];
  readonly linkTally: LinkTally;
  readonly linkRecords: LinkRecord[];
  readonly nodeCensus: Map<string, number>;
  readonly markCensus: Map<string, number>;
  readonly setsByKind: Map<string, number>;
  readonly setsByHandle: Map<string, number>;
  readonly setsWithoutId: Map<string, number>;
  readonly bardFields: Map<string, number>;
  readonly tableFamilyEntries: Set<string>;
  readonly nbspEntries: Set<string>;
  /**
   * Ad-hoc figures the census reports that no other accumulator has a home for —
   * currently the FAQ document's top-level node count, which is measured at the
   * split rather than re-derived, because the document itself is not retained.
   */
  readonly counters: Map<string, number>;
  /** Entry id -> canonical path, for the internal-scheme resolution. */
  readonly pathsByEntryId: Map<string, string>;
  readonly files: Map<string, SourceFileRecord>;
  readonly integrity: Integrity;
  /**
   * Every link href the corpus holds, transformed or not.
   *
   * Collected because two consumers need the whole population rather than the
   * eleven records that changed: the census, and the recovery of the family
   * portal URL from the disabled block it sits in (section 15).
   */
  readonly hrefs: { source_file: string; field: string; href: string }[];
}

const bump = (counter: Map<string, number>, key: string, by = 1): void => {
  counter.set(key, (counter.get(key) ?? 0) + by);
};

const createContext = (sourceRoot: string, assets: AssetIndex, notes: string[]): Context => ({
  sourceRoot,
  assets,
  notes,
  linkTally: emptyLinkTally(),
  linkRecords: [],
  nodeCensus: new Map<string, number>(),
  markCensus: new Map<string, number>(),
  setsByKind: new Map<string, number>(),
  setsByHandle: new Map<string, number>(),
  setsWithoutId: new Map<string, number>(),
  bardFields: new Map<string, number>(),
  tableFamilyEntries: new Set<string>(),
  nbspEntries: new Set<string>(),
  counters: new Map<string, number>(),
  pathsByEntryId: new Map<string, string>(),
  files: new Map<string, SourceFileRecord>(),
  hrefs: [],
  integrity: {
    staleParents: [],
    danglingAnnouncementLinks: [],
    missingRequiredFields: [],
    promotedLinkDuplication: [],
    grandfathered: [],
    disabledRecords: [],
  },
});

/** Register a consumed source file, or return the record already registered for it. */
const registerFile = (
  context: Context,
  path: string,
  hash: string,
  role: string,
): SourceFileRecord => {
  const existing = context.files.get(path);
  if (existing !== undefined) {
    return existing;
  }
  const record: SourceFileRecord = {
    path,
    sha256: hash,
    role,
    collection: null,
    slug: null,
    keys: [],
    target_table: null,
    legacy_ref: null,
    route: null,
    published: null,
    relations: {},
    asset_references: [],
    notes: [],
  };
  context.files.set(path, record);
  return record;
};

/** The table family lives in one entry; the census reports which. */
const TABLE_FAMILY = new Set(["table", "tableRow", "tableHeader", "tableCell"]);

/**
 * Import one Bard field: narrow it, prove the round trip, count it, and apply the
 * link rules.
 *
 * The censuses are taken on the PRE-transform document so that the node and mark
 * histograms describe the source rather than this program's output. Link counts
 * are taken during the transform, which is the only place that distinguishes the
 * five classes.
 */
const importBardField = (
  context: Context,
  rawValue: unknown,
  sourceFile: string,
  field: string,
): TiptapDoc => {
  if (!Array.isArray(rawValue)) {
    throw new ExtractionError(
      `${sourceFile}: ${field} is a Bard field and must be a bare array of ProseMirror ` +
        `nodes; received ${typeof rawValue}.`,
    );
  }

  const doc = bardToTiptapDoc(rawValue, sourceFile);
  assertRoundTrip(rawValue, doc, sourceFile, field);
  bump(context.bardFields, field);

  walkNodes(doc.content, (node) => {
    bump(context.nodeCensus, node.type);
    if (TABLE_FAMILY.has(node.type)) {
      context.tableFamilyEntries.add(sourceFile);
    }
    if (node.marks !== undefined) {
      for (const mark of node.marks) {
        bump(context.markCensus, mark.type);
      }
    }
    if (node.text !== undefined && node.text.includes("\u00a0")) {
      context.nbspEntries.add(sourceFile);
    }
  });

  return transformLinks(
    doc,
    sourceFile,
    field,
    context.pathsByEntryId,
    context.linkTally,
    context.linkRecords,
    context.hrefs,
  );
};

/**
 * Publish state.
 *
 * THE STATAMIC RULE IS THAT ABSENCE MEANS PUBLISHED. `inspiring_quotes` carries
 * zero `published:` keys and all five are live; 31 of the 34 pages carry no key
 * either. The database columns default to FALSE, which is the safe default for a
 * load error, so `seed.sql` states `published` explicitly on every row of every
 * collection — inverting this reading would silently draft 5 quotes, 4
 * announcements and 31 pages.
 */
const isPublished = (data: Readonly<Record<string, unknown>>): boolean =>
  data["published"] !== false;

/** `enabled` on a nested record, defaulting to true as the columns do. */
const isEnabled = (record: Readonly<Record<string, unknown>>): boolean =>
  record["enabled"] !== false;

/** Provenance for one entry, migrated verbatim. */
const provenanceOf = (entry: SourceEntry): Provenance => {
  const updatedAt = asIntegerFrom(entry.data["updated_at"]);
  const updatedBy = asString(entry.data["updated_by"]);
  return {
    source_updated_at: updatedAt === null ? null : epochToIso(updatedAt),
    source_updated_by: updatedBy === null ? null : mapUpdatedBy(updatedBy),
  };
};

/** The entry's own `id`, which is its `legacy_ref`. */
const legacyRefOf = (entry: SourceEntry): string => {
  const id = asString(entry.data["id"]);
  if (id === null) {
    throw new ExtractionError(`${entry.sourceFile}: no id in front matter.`);
  }
  return id;
};

/**
 * Everything the mapper did not consume, retained in `legacy`.
 *
 * The mechanism rather than a per-collection list: a key nobody mapped lands here
 * automatically, so a field added to the corpus tomorrow is retained instead of
 * silently dropped, and `verify-parity.ts` can assert that every source key is
 * either a column or a `legacy` member. `alsoRetain` names keys that ARE mapped
 * but only lossily — `pages.parent`, whose effective value comes from the tree,
 * and `announcements.link`, whose dangling id has no foreign key to live in.
 */
const buildLegacy = (
  entry: SourceEntry,
  consumed: readonly string[],
  alsoRetain: readonly string[] = [],
): Record<string, unknown> => {
  const consumedSet = new Set(consumed);
  const retain = new Set(alsoRetain);
  const legacy: Record<string, unknown> = {};
  for (const key of Object.keys(entry.data).sort((left, right) => (left < right ? -1 : 1))) {
    if (!consumedSet.has(key) || retain.has(key)) {
      legacy[key] = entry.data[key];
    }
  }
  if (entry.body.trim() !== "") {
    // No entry in the corpus has a markdown body. If one ever does, it is content
    // and is retained rather than discarded.
    legacy["_body"] = entry.body;
  }
  return legacy;
};

/** Record an over-length value against a declared blueprint limit. */
const checkCharacterLimits = (
  context: Context,
  entry: SourceEntry,
  blueprint: string | null,
): void => {
  for (const limit of CHARACTER_LIMITS) {
    if (limit.collection !== entry.collection) {
      continue;
    }
    if (limit.blueprint !== null && limit.blueprint !== blueprint) {
      continue;
    }
    const value = asString(entry.data[limit.sourceKey]);
    if (value === null || value.length <= limit.limit) {
      continue;
    }
    context.integrity.grandfathered.push({
      table: limit.table,
      column: limit.column,
      legacy_ref: legacyRefOf(entry),
      slug: entry.slug,
      source_file: entry.sourceFile,
      length: value.length,
      declared_limit: limit.limit,
    });
  }
};

/* ==========================================================================
 * 12. The page tree and the 142 paths
 * --------------------------------------------------------------------------
 * `content/trees/collections/pages.yaml` is AUTHORITATIVE for parent, order and
 * the materialized path — not the `parent:` keys in front matter, four of which
 * point at a uuid no entry carries. All four render at their correct URLs on the
 * live site today precisely because Statamic resolves from the tree, so trusting
 * the keys instead would have orphaned four program pages.
 * ========================================================================== */

interface TreePosition {
  readonly entryId: string;
  readonly parentEntryId: string | null;
  readonly sortOrder: number;
  readonly depth: number;
}

/** Flatten the tree, parents before children, recording order and depth. */
const flattenTree = (value: unknown, sourceFile: string): TreePosition[] => {
  if (!isRecord(value)) {
    throw new ExtractionError(`${sourceFile}: the tree file did not parse to a mapping.`);
  }
  const roots = asRecordArray(value["tree"]);
  if (roots === null) {
    throw new ExtractionError(`${sourceFile}: no \`tree\` array.`);
  }

  const positions: TreePosition[] = [];
  const visit = (nodes: readonly Record<string, unknown>[], parentEntryId: string | null, depth: number): void => {
    for (const [index, node] of nodes.entries()) {
      const entryId = asString(node["entry"]);
      if (entryId === null) {
        throw new ExtractionError(`${sourceFile}: a tree node carries no \`entry\`.`);
      }
      positions.push({ entryId, parentEntryId, sortOrder: index + 1, depth });
      const children = node["children"];
      if (children !== undefined) {
        const childRecords = asRecordArray(children);
        if (childRecords === null) {
          throw new ExtractionError(`${sourceFile}: \`children\` of ${entryId} is not an array of nodes.`);
        }
        visit(childRecords, entryId, depth + 1);
      }
    }
  };
  visit(roots, null, 0);
  return positions;
};

/**
 * Materialize a page's path.
 *
 * `content/collections/pages.yaml` sets `structure.root = true`, so the root page
 * contributes no slug segment: home's slug is still `home` while its path is `/`.
 * Deriving the path from the slug alone would get that one row wrong, which is
 * why `content_routes` uses `pages.path` verbatim rather than recomputing it.
 */
const materializePath = (parentPath: string | null, slug: string, isHome: boolean): string => {
  if (isHome) {
    return HOME_PATH;
  }
  if (parentPath === null || parentPath === HOME_PATH) {
    return `/${slug}`;
  }
  return `${parentPath}/${slug}`;
};

/* ==========================================================================
 * 13. Pages and page_sections
 * --------------------------------------------------------------------------
 * THE RULE: a scalar or single asset reference becomes a typed column on
 * `pages`; a repeater becomes ordered rows in `page_sections`.
 *
 * Section extraction keys off FIELD PRESENCE, never off the blueprint. Two rows
 * in the corpus prove why: `donate.md` is a `flexible_content_page` and carries
 * NO `add_content`, while `school-age-mandarin` is a `programsumbrella` and does.
 * The 23 `add_content` entries are the 22 flexpages plus school-age-mandarin —
 * not the 23 `flexible_content_page` entries.
 * ========================================================================== */

/** The keys the page mapper consumes; anything else is retained in `legacy`. */
const PAGE_CONSUMED_KEYS = [
  "id",
  "blueprint",
  "title",
  "template",
  "published",
  "parent",
  "include",
  "description",
  "short_description",
  "intro",
  "welcome_line",
  "main_image",
  "program_image",
  "important_notes",
  "add_content",
  "slideshow",
  "at_a_glance",
  "sessions",
  "programs_offered",
  "classrooms",
  "testimonial_1",
  "testimonial_2",
  "testimonial_3",
  "testimonial_1_attribution",
  "testimonial_2_attribution",
  "testimonial_3_attribution",
  "testimonial_1_image",
  "testimonial_2_image",
  "testimonial_3_image",
  "updated_at",
  "updated_by",
] as const;

/** A row under construction, before `sort_order` is assigned. */
interface SectionDraft {
  readonly legacyRef: string;
  readonly kind: PageSectionKind;
  readonly enabled: boolean;
  readonly parentLegacyRef: string | null;
  readonly fields: Partial<{
    body: TiptapDoc;
    asset_id: string;
    caption: string;
    happy_verb: string;
    quote_text: string;
    attribution: string;
    embed_url: string;
    stat_number: string;
    stat_caption: string;
    program_title: string;
    program_description: string;
    half_day_price: string;
    full_day_price: string;
    extended_day_price: string;
    session_title: string;
    session_dates: string;
    question: string;
    answer: string;
  }>;
  readonly data: Record<string, unknown>;
  readonly legacy: Record<string, unknown>;
}

/**
 * Record a replicator set in the census.
 *
 * `withoutId` is what the derived-identity rule exists for: 22 sets carry no
 * source `id`, so the count is reported per handle and asserted.
 */
const censusSet = (
  context: Context,
  handle: string,
  kind: string,
  record: Readonly<Record<string, unknown>>,
): void => {
  bump(context.setsByHandle, handle);
  bump(context.setsByKind, kind);
  if (asString(record["id"]) === null) {
    bump(context.setsWithoutId, handle);
  }
};

/** `legacy.set_id`: traceability only, never the identity. */
const setLegacy = (record: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const id = asString(record["id"]);
  return id === null ? {} : { set_id: id };
};

/**
 * Build the sections for one `add_content` replicator.
 *
 * THE REPLICATOR SPLIT: contiguous ENABLED `text` sets concatenate their node
 * arrays into one document, and every other set becomes its own row of the
 * matching kind.
 *
 * A DISABLED text set is never merged — not with its neighbours and not with
 * another disabled set. That refinement is required rather than cosmetic:
 * `apply.md` carries two ADJACENT disabled text sets, and fusing them would
 * leave five page-level `enabled = false` rows where the corpus has six, so one
 * of the school's two switched-off blocks would lose its own switch and could
 * never be restored independently.
 */
const buildAddContentSections = (
  context: Context,
  entry: SourceEntry,
  pageLegacyRef: string,
  sets: readonly Record<string, unknown>[],
  assetReferences: string[],
): SectionDraft[] => {
  const drafts: SectionDraft[] = [];
  let faqItemOrdinal = 0;

  let index = 0;
  while (index < sets.length) {
    const set = sets[index];
    if (set === undefined) {
      index += 1;
      continue;
    }
    const kind = asString(set["type"]);
    if (kind === null) {
      throw new ExtractionError(`${entry.sourceFile}: add_content[${String(index)}] has no type.`);
    }
    const enabled = isEnabled(set);
    const ordinal = index;
    const legacyRef = deriveChildLegacyRef(pageLegacyRef, "add_content", ordinal);

    if (isReplicatorTextSet(set)) {
      // Gather the run: this set, plus following enabled text sets when this one
      // is itself enabled.
      const runIndexes: number[] = [index];
      censusSet(context, "add_content", kind, set);
      if (enabled) {
        let lookahead = index + 1;
        while (lookahead < sets.length) {
          const candidate = sets[lookahead];
          if (candidate === undefined || !isReplicatorTextSet(candidate) || !isEnabled(candidate)) {
            break;
          }
          censusSet(context, "add_content", "text", candidate);
          runIndexes.push(lookahead);
          lookahead += 1;
        }
      }

      const nodes: unknown[] = [];
      const setIds: string[] = [];
      for (const runIndex of runIndexes) {
        const member = sets[runIndex];
        if (member === undefined) {
          continue;
        }
        const memberNodes: unknown = member["text"];
        if (!isUnknownArray(memberNodes)) {
          throw new ExtractionError(
            `${entry.sourceFile}: add_content[${String(runIndex)}] is a text set with no node array.`,
          );
        }
        nodes.push(...memberNodes);
        const memberId = asString(member["id"]);
        if (memberId !== null) {
          setIds.push(memberId);
        }
      }

      const doc = importBardField(context, nodes, entry.sourceFile, "add_content.text");
      const legacy: Record<string, unknown> = setIds.length > 0 ? { set_id: setIds.join(",") } : {};

      const parts = documentHasFaqPairs(doc) ? splitFaqDocument(doc) : null;
      if (parts !== null) {
        // Recorded here because the document is not retained past this point and
        // the census must be able to state the figure without re-parsing. The
        // specification says 25; the corpus says 23, and this is where that is
        // measured rather than asserted.
        context.counters.set("faq_top_level_nodes", doc.content.length);
      }
      if (parts !== null && faqSplitIsFaithful(doc, parts)) {
        let proseOrdinal = 0;
        for (const part of parts) {
          if (part.kind === "text") {
            // A split can leave more than one prose run, so each gets its own
            // handle under the run's ref rather than sharing it: `legacy_ref` is
            // unique on this table and two rows claiming one value would abort
            // the load. The nesting is the same `<parent>:<handle>:<ordinal>`
            // rule applied one level deeper.
            drafts.push({
              legacyRef: deriveChildLegacyRef(legacyRef, "prose", proseOrdinal),
              kind: "text",
              enabled,
              parentLegacyRef: null,
              fields: { body: { type: "doc", content: part.nodes } },
              data: {},
              legacy,
            });
            proseOrdinal += 1;
          } else {
            drafts.push({
              legacyRef: deriveChildLegacyRef(pageLegacyRef, "faq_item", faqItemOrdinal),
              kind: "faq_item",
              enabled,
              parentLegacyRef: null,
              fields: { question: part.question, answer: part.answer },
              data: {},
              legacy: {},
            });
            faqItemOrdinal += 1;
          }
        }
      } else {
        if (parts !== null) {
          // The documented fallback: render the document as ordinary prose. The
          // disclosure affordance is lost; the content never is.
          context.notes.push(
            `${entry.sourceFile}: a Q:/A: run was detected but the split did not reproduce ` +
              `the document's text exactly, so it is emitted as one prose section.`,
          );
        }
        drafts.push({
          legacyRef,
          kind: "text",
          enabled,
          parentLegacyRef: null,
          fields: { body: doc },
          data: {},
          legacy,
        });
      }

      index += runIndexes.length;
      continue;
    }

    censusSet(context, "add_content", kind, set);
    index += 1;

    if (kind === "image") {
      // The one `image` set in the corpus — school-age-mandarin's — carries no
      // `image` key at all. It emits a row with a null asset rather than
      // throwing: an empty slot is editorial state, and the blueprint declares
      // the field optional. Note also that the blueprint declares only `image`,
      // with NO caption field, while the legacy template reads `photo`/`caption`
      // — which is why six image sets render nothing today. The declared field is
      // what migrates.
      const filename = asString(set["image"]);
      const fields: SectionDraft["fields"] = {};
      if (filename !== null) {
        fields.asset_id = resolveAssetId(context.assets, filename, entry.sourceFile, "add_content.image");
        assetReferences.push(filename);
      }
      drafts.push({
        legacyRef,
        kind: "image",
        enabled,
        parentLegacyRef: null,
        fields,
        data: {},
        legacy: setLegacy(set),
      });
      continue;
    }

    if (kind === "quote") {
      const quote = asString(set["quote"]);
      if (quote === null) {
        throw new ExtractionError(
          `${entry.sourceFile}: add_content[${String(ordinal)}] is a quote set with no quote.`,
        );
      }
      const fields: SectionDraft["fields"] = { quote_text: quote };
      const attribution = asString(set["attribution"]);
      if (attribution !== null) {
        fields.attribution = attribution;
      }
      drafts.push({
        legacyRef,
        kind: "quote",
        enabled,
        parentLegacyRef: null,
        fields,
        data: {},
        legacy: setLegacy(set),
      });
      continue;
    }

    if (kind === "movie") {
      // Zero instances in the corpus. The set is declared by
      // flexible_content_page.yaml, so the capability is preserved rather than
      // dropped: the value is a URL rendered through EmbedFrame, validated
      // against an oEmbed host allowlist on write.
      const movie = asString(set["movie"]);
      const fields: SectionDraft["fields"] = {};
      if (movie !== null) {
        fields.embed_url = movie;
      }
      drafts.push({
        legacyRef,
        kind: "movie",
        enabled,
        parentLegacyRef: null,
        fields,
        data: {},
        legacy: setLegacy(set),
      });
      continue;
    }

    throw new ExtractionError(
      `${entry.sourceFile}: add_content[${String(ordinal)}] has unknown set type ${kind}. ` +
        `flexible_content_page.yaml declares text, image, quote and movie; a new set ` +
        `type needs a page_sections kind, a check-constraint value and a renderer ` +
        `branch before it can be migrated.`,
    );
  }

  return drafts;
};


/**
 * The values promoted out of Antlers templates into managed content.
 *
 * Five things the school owns live in templates rather than in content. These are
 * the two that become `page_sections` rather than `site_globals`; the layout
 * constants and the maintenance copy are read separately in section 15.
 */
interface TemplateCopy {
  readonly donateHeading: string;
  readonly donateParagraph: string;
  readonly summerLabels: {
    readonly half: string;
    readonly full: string;
    readonly extended: string;
  };
}

/** The one authorized prose change in the entire migration. */
const DONATE_TYPO = "You support helps us continue in our mission";
const DONATE_FIX = "Your support helps us continue in our mission";

const readTemplateCopy = async (context: Context): Promise<TemplateCopy> => {
  const donatePath = "resources/views/donate.antlers.html";
  const summerPath = "resources/views/programsumbrellasummer.antlers.html";

  const donateRaw = await readTextFile(join(context.sourceRoot, donatePath));
  registerFile(context, donatePath, sha256(donateRaw), "template").notes.push(
    "donate heading and paragraph promoted into page_sections",
  );
  const summerRaw = await readTextFile(join(context.sourceRoot, summerPath));
  registerFile(context, summerPath, sha256(summerRaw), "template").notes.push(
    "three summer day-length labels promoted into page_sections.data",
  );

  const heading = /<h1>([^<]*)<\/h1>/.exec(donateRaw)?.[1];
  const paragraph = /<p>([^<]*)<\/p>/.exec(donateRaw)?.[1];
  if (heading === undefined || paragraph === undefined) {
    throw new ExtractionError(
      `${donatePath}: could not read the heading and paragraph to promote. The template ` +
        `has changed shape; re-read it before assuming this program can still find them.`,
    );
  }
  if (!paragraph.includes(DONATE_TYPO)) {
    throw new ExtractionError(
      `${donatePath}: the paragraph no longer contains the text the single authorized ` +
        `copy edit applies to. Exactly one word changes in this migration and it must be ` +
        `verifiable; re-authorize the edit rather than widening the match.`,
    );
  }
  // THE SINGLE AUTHORIZED COPY EDIT. "You support" -> "Your support", as this
  // paragraph moves from the template into content. Nothing else, anywhere. In
  // particular the maintenance message's "Stay tooned!" migrates unchanged: it is
  // not the authorized edit, so it is not this migration's to fix.
  const corrected = paragraph.replace(DONATE_TYPO, DONATE_FIX);

  // The label is whatever literal text sits between the tag and the Antlers
  // variable — including the stray leading space on " Full day: ", which is
  // authored and is preserved exactly. It is typographical oddity in content, and
  // content is the school's.
  const label = (variable: string): string => {
    const matched = new RegExp(`>([^<>{}]*)\\{\\{\\s*${variable}\\s*\\}\\}`).exec(summerRaw)?.[1];
    if (matched === undefined) {
      throw new ExtractionError(
        `${summerPath}: could not read the label preceding {{${variable}}}.`,
      );
    }
    return matched;
  };

  return {
    donateHeading: heading,
    donateParagraph: corrected,
    summerLabels: {
      half: label("half_day_time_and_price"),
      full: label("full_day_time_and_price"),
      extended: label("extended_day_time_and_price"),
    },
  };
};

/** Everything one page contributed, assembled by the builder below. */
interface PageBuild {
  readonly row: PageRow;
  readonly sections: readonly PageSectionRow[];
}

/**
 * Build one page row and every section it owns.
 *
 * Section order within a page is fixed and deterministic: `add_content` in
 * document order, then `slideshow`, `at_a_glance`, the testimonial triplets,
 * `programs_offered`, and `sessions` with each session's nested programs
 * immediately after it. `sort_order` is assigned from that sequence, scoped by
 * `(page_id, parent_section_id)` exactly as the table's deferrable uniqueness
 * constraint is.
 */
const buildPage = (
  context: Context,
  entry: SourceEntry,
  position: { readonly parentLegacyRef: string | null; readonly path: string; readonly sortOrder: number },
  showInNav: boolean,
  templateCopy: TemplateCopy,
): PageBuild => {
  const legacyRef = legacyRefOf(entry);
  const pageId = deriveEntityUuid("pages", legacyRef);
  const isHome = legacyRef === HOME_ENTRY_ID;
  const title = asString(entry.data["title"]);
  const template = asString(entry.data["template"]);
  const blueprint = asString(entry.data["blueprint"]);
  if (title === null || template === null || blueprint === null) {
    throw new ExtractionError(
      `${entry.sourceFile}: title, template and blueprint are all required on a page row.`,
    );
  }

  const assetReferences: string[] = [];
  const resolveAsset = (field: string): string | null => {
    const filename = asString(entry.data[field]);
    if (filename === null) {
      return null;
    }
    assetReferences.push(filename);
    return resolveAssetId(context.assets, filename, entry.sourceFile, field);
  };

  // `hero` on home.md is an UNDECLARED bare array of six filenames. No blueprint
  // declares it and no template renders it, so it is not a column and it is
  // retained in `legacy` — but the six values are REAL asset references, so they
  // are resolved here. That does two things nothing else would: a filename the
  // manifest does not carry becomes a fatal error rather than a dead string in a
  // jsonb blob, and all six are counted as referenced so the upload step and the
  // three-way classification see them. Three of the six appear nowhere else in
  // the corpus.
  const heroRaw = entry.data["hero"];
  if (isStringArray(heroRaw)) {
    for (const filename of heroRaw) {
      assetReferences.push(filename);
      resolveAssetId(context.assets, filename, entry.sourceFile, "hero");
    }
  } else if (heroRaw !== undefined && heroRaw !== null) {
    throw new ExtractionError(
      `${entry.sourceFile}: hero is present but is not a list of filenames. It is an ` +
        `undeclared key, so its shape is whatever the editor last wrote — report the new ` +
        `shape rather than guessing at it.`,
    );
  }

  const drafts: SectionDraft[] = [];

  const addContent = entry.data["add_content"];
  if (addContent !== undefined && addContent !== null) {
    const sets = asRecordArray(addContent);
    if (sets === null) {
      throw new ExtractionError(`${entry.sourceFile}: add_content is not an array of sets.`);
    }
    drafts.push(...buildAddContentSections(context, entry, legacyRef, sets, assetReferences));
  }

  // `slideshow` has TWO shapes declared in two different blueprints, and that is
  // not drift. `home.yaml` declares a replicator whose `image` set carries
  // [image, happy_verb] -> 5 `slide` rows with the happy verbs. The two umbrella
  // blueprints declare the same handle as `type: assets, mode: list` -> bare
  // filename strings, 15 of them across four pages, which become `image` rows.
  // Dispatch is on the runtime shape, which is what a re-run against a newer
  // commit needs: a page that changes blueprint changes shape with it.
  const slideshow = entry.data["slideshow"];
  if (isStringArray(slideshow)) {
    for (const [index, filename] of slideshow.entries()) {
      assetReferences.push(filename);
      drafts.push({
        legacyRef: deriveChildLegacyRef(legacyRef, "slideshow", index),
        kind: "image",
        enabled: true,
        parentLegacyRef: null,
        fields: {
          asset_id: resolveAssetId(context.assets, filename, entry.sourceFile, "slideshow"),
        },
        data: {},
        legacy: {},
      });
    }
  } else if (slideshow !== undefined && slideshow !== null) {
    const sets = asRecordArray(slideshow);
    if (sets === null) {
      throw new ExtractionError(
        `${entry.sourceFile}: slideshow is neither an asset list nor a replicator.`,
      );
    }
    for (const [index, set] of sets.entries()) {
      const kind = asString(set["type"]);
      if (kind !== "image") {
        throw new ExtractionError(
          `${entry.sourceFile}: slideshow[${String(index)}] has set type ${String(kind)}; ` +
            `home.yaml declares only an \`image\` set.`,
        );
      }
      censusSet(context, "slideshow", kind, set);
      const fields: SectionDraft["fields"] = {};
      const filename = asString(set["image"]);
      if (filename !== null) {
        assetReferences.push(filename);
        fields.asset_id = resolveAssetId(context.assets, filename, entry.sourceFile, "slideshow.image");
      }
      const happyVerb = asString(set["happy_verb"]);
      if (happyVerb !== null) {
        fields.happy_verb = happyVerb;
      }
      drafts.push({
        legacyRef: deriveChildLegacyRef(legacyRef, "slideshow", index),
        kind: "slide",
        enabled: isEnabled(set),
        parentLegacyRef: null,
        fields,
        data: {},
        legacy: setLegacy(set),
      });
    }
  }

  const atAGlance = asRecordArray(entry.data["at_a_glance"] ?? []);
  if (atAGlance === null) {
    throw new ExtractionError(`${entry.sourceFile}: at_a_glance is not an array of sets.`);
  }
  for (const [index, set] of atAGlance.entries()) {
    const kind = asString(set["type"]);
    if (kind !== "statistic") {
      throw new ExtractionError(
        `${entry.sourceFile}: at_a_glance[${String(index)}] has set type ${String(kind)}.`,
      );
    }
    censusSet(context, "at_a_glance", kind, set);
    const fields: SectionDraft["fields"] = {};
    // `number` is TEXT, and one of the three values is literally `5:1` — hence
    // `stat_number text` rather than a numeric column. A future unquoted write
    // would arrive as a number; it is stringified rather than rejected, which
    // changes representation and not value.
    const rawNumber = set["number"];
    const numberText =
      asString(rawNumber) ?? (typeof rawNumber === "number" ? String(rawNumber) : null);
    if (numberText !== null) {
      fields.stat_number = numberText;
    }
    // Never rely on key order: in one of the three sets `caption` precedes
    // `number`.
    const caption = asString(set["caption"]);
    if (caption !== null) {
      fields.stat_caption = caption;
    }
    drafts.push({
      legacyRef: deriveChildLegacyRef(legacyRef, "at_a_glance", index),
      kind: "statistic",
      enabled: isEnabled(set),
      parentLegacyRef: null,
      fields,
      data: {},
      legacy: setLegacy(set),
    });
  }

  // NINE FLAT FIELDS BECOME THREE SECTIONS. `testimonial_1/2/3` plus their
  // `_attribution` and `_image` are all declared REQUIRED and all nine carry
  // values, so this is a presentation change over existing content rather than a
  // migration of literals: three numbered field triplets are a repeater the
  // blueprint failed to model.
  for (const ordinal of [1, 2, 3]) {
    const text = asString(entry.data[`testimonial_${String(ordinal)}`]);
    if (text === null) {
      continue;
    }
    const fields: SectionDraft["fields"] = { quote_text: text };
    const attribution = asString(entry.data[`testimonial_${String(ordinal)}_attribution`]);
    if (attribution !== null) {
      fields.attribution = attribution;
    }
    const filename = asString(entry.data[`testimonial_${String(ordinal)}_image`]);
    if (filename !== null) {
      assetReferences.push(filename);
      fields.asset_id = resolveAssetId(
        context.assets,
        filename,
        entry.sourceFile,
        `testimonial_${String(ordinal)}_image`,
      );
    }
    drafts.push({
      legacyRef: deriveChildLegacyRef(legacyRef, "testimonial", ordinal - 1),
      kind: "testimonial",
      enabled: true,
      parentLegacyRef: null,
      fields,
      data: {},
      legacy: {},
    });
  }

  // A SIBLING repeater, not a nested one — which is why its single entry on
  // summer-programs renders an empty <p> today, beside rather than inside the
  // session it looks like it belongs to.
  const programsOffered = entry.data["programs_offered"];
  if (programsOffered !== undefined && programsOffered !== null) {
    const sets = asRecordArray(programsOffered);
    if (sets === null) {
      throw new ExtractionError(`${entry.sourceFile}: programs_offered is not an array of sets.`);
    }
    for (const [index, set] of sets.entries()) {
      const kind = asString(set["type"]);
      if (kind !== "program") {
        throw new ExtractionError(
          `${entry.sourceFile}: programs_offered[${String(index)}] has set type ${String(kind)}.`,
        );
      }
      censusSet(context, "programs_offered", kind, set);
      const fields: SectionDraft["fields"] = {};
      const programTitle = asString(set["program_title"]);
      if (programTitle !== null) {
        fields.program_title = programTitle;
      }
      const programDescription = asString(set["program_description"]);
      if (programDescription !== null) {
        fields.program_description = programDescription;
      }
      drafts.push({
        legacyRef: deriveChildLegacyRef(legacyRef, "programs_offered", index),
        kind: "program",
        enabled: isEnabled(set),
        parentLegacyRef: null,
        fields,
        data: {},
        legacy: setLegacy(set),
      });
    }
  }

  // The one genuinely nested replicator, and the only exercise of
  // `parent_section_id` in the whole corpus.
  const sessions = entry.data["sessions"];
  if (sessions !== undefined && sessions !== null) {
    const sets = asRecordArray(sessions);
    if (sets === null) {
      throw new ExtractionError(`${entry.sourceFile}: sessions is not an array of sets.`);
    }
    for (const [index, set] of sets.entries()) {
      const kind = asString(set["type"]);
      if (kind !== "session") {
        throw new ExtractionError(
          `${entry.sourceFile}: sessions[${String(index)}] has set type ${String(kind)}.`,
        );
      }
      censusSet(context, "sessions", kind, set);
      const sessionRef = deriveChildLegacyRef(legacyRef, "sessions", index);
      const fields: SectionDraft["fields"] = {};
      const sessionTitle = asString(set["session_title"]);
      if (sessionTitle !== null) {
        fields.session_title = sessionTitle;
      }
      // Carries a U+2013 EN DASH, which round-trips by codepoint.
      const sessionDates = asString(set["session_dates"]);
      if (sessionDates !== null) {
        fields.session_dates = sessionDates;
      }
      drafts.push({
        legacyRef: sessionRef,
        kind: "session",
        enabled: isEnabled(set),
        parentLegacyRef: null,
        fields,
        data: {},
        legacy: setLegacy(set),
      });

      const nested = set["programs_in_this_session"];
      if (nested === undefined || nested === null) {
        continue;
      }
      const nestedSets = asRecordArray(nested);
      if (nestedSets === null) {
        throw new ExtractionError(
          `${entry.sourceFile}: sessions[${String(index)}].programs_in_this_session is not an array.`,
        );
      }
      for (const [nestedIndex, nestedSet] of nestedSets.entries()) {
        const nestedKind = asString(nestedSet["type"]);
        if (nestedKind !== "program") {
          throw new ExtractionError(
            `${entry.sourceFile}: a nested session program has set type ${String(nestedKind)}.`,
          );
        }
        censusSet(context, "programs_in_this_session", nestedKind, nestedSet);
        const nestedFields: SectionDraft["fields"] = {};
        // `program_title` is ABSENT on the one nested set in the corpus, which is
        // exactly why an empty <h5> renders on /programs/summer-programs today.
        // The column stays null; the defect is the renderer's to stop displaying,
        // not this program's to paper over with an invented title.
        const nestedTitle = asString(nestedSet["program_title"]);
        if (nestedTitle !== null) {
          nestedFields.program_title = nestedTitle;
        }
        const half = asString(nestedSet["half_day_time_and_price"]);
        if (half !== null) {
          nestedFields.half_day_price = half;
        }
        const full = asString(nestedSet["full_day_time_and_price"]);
        if (full !== null) {
          nestedFields.full_day_price = full;
        }
        const extended = asString(nestedSet["extended_day_time_and_price"]);
        if (extended !== null) {
          nestedFields.extended_day_price = extended;
        }
        // THE THREE TIER LABELS, promoted out of
        // programsumbrellasummer.antlers.html. They belong with the row they
        // label and no named column exists for them — `site_globals` is a CLOSED
        // 26-key set that cannot admit one — so they go in `data`, which is the
        // documented escape hatch for a kind's remainder. The values are exact,
        // including the authored leading space on " Full day: ".
        drafts.push({
          legacyRef: deriveChildLegacyRef(sessionRef, "programs_in_this_session", nestedIndex),
          kind: "program",
          enabled: isEnabled(nestedSet),
          parentLegacyRef: sessionRef,
          fields: nestedFields,
          data: {
            half_day_label: templateCopy.summerLabels.half,
            full_day_label: templateCopy.summerLabels.full,
            extended_day_label: templateCopy.summerLabels.extended,
          },
          legacy: setLegacy(nestedSet),
        });
      }
    }
  }

  // The donate page's heading and paragraph, promoted out of the template into a
  // prose section so staff can edit them. The heading is level 2 because the
  // page's own `title` supplies the document's h1, and levels 2-4 are what the
  // rich-text allowlist admits.
  if (template === "donate") {
    drafts.push({
      legacyRef: deriveChildLegacyRef(legacyRef, "donate_template_copy", 0),
      kind: "text",
      enabled: true,
      parentLegacyRef: null,
      fields: {
        body: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: templateCopy.donateHeading }],
            },
            { type: "paragraph", content: [{ type: "text", text: templateCopy.donateParagraph }] },
          ],
        },
      },
      data: {},
      legacy: { promoted_from: "resources/views/donate.antlers.html" },
    });
  }

  // Assign sort_order per (page, parent) group, in the order the drafts were
  // built, and materialize the rows.
  const nextOrder = new Map<string, number>();
  const sections: PageSectionRow[] = drafts.map((draft) => {
    const groupKey = draft.parentLegacyRef ?? "";
    const order = (nextOrder.get(groupKey) ?? 0) + 1;
    nextOrder.set(groupKey, order);
    if (!draft.enabled) {
      context.integrity.disabledRecords.push({
        table: "page_sections",
        legacy_ref: draft.legacyRef,
        source_file: entry.sourceFile,
      });
    }
    return {
      id: deriveEntityUuid("page_sections", draft.legacyRef),
      legacy_ref: draft.legacyRef,
      page_id: pageId,
      page_legacy_ref: legacyRef,
      parent_section_id:
        draft.parentLegacyRef === null
          ? null
          : deriveEntityUuid("page_sections", draft.parentLegacyRef),
      kind: draft.kind,
      sort_order: order,
      enabled: draft.enabled,
      body: draft.fields.body ?? null,
      asset_id: draft.fields.asset_id ?? null,
      caption: draft.fields.caption ?? null,
      happy_verb: draft.fields.happy_verb ?? null,
      quote_text: draft.fields.quote_text ?? null,
      attribution: draft.fields.attribution ?? null,
      embed_url: draft.fields.embed_url ?? null,
      stat_number: draft.fields.stat_number ?? null,
      stat_caption: draft.fields.stat_caption ?? null,
      program_title: draft.fields.program_title ?? null,
      program_description: draft.fields.program_description ?? null,
      half_day_price: draft.fields.half_day_price ?? null,
      full_day_price: draft.fields.full_day_price ?? null,
      extended_day_price: draft.fields.extended_day_price ?? null,
      session_title: draft.fields.session_title ?? null,
      session_dates: draft.fields.session_dates ?? null,
      question: draft.fields.question ?? null,
      answer: draft.fields.answer ?? null,
      data: draft.data,
      legacy: draft.legacy,
    };
  });

  // The ordered page->classroom relation: 12 rows from exactly two pages.
  const classroomRefs = entry.data["classrooms"];
  const pageClassrooms: PageClassroomRow[] = [];
  if (isStringArray(classroomRefs)) {
    for (const [index, classroomRef] of classroomRefs.entries()) {
      pageClassrooms.push({
        classroom_id: deriveEntityUuid("classrooms", classroomRef),
        classroom_legacy_ref: classroomRef,
        sort_order: index + 1,
      });
    }
  }

  const importantNotesRaw = entry.data["important_notes"];
  const importantNotes =
    importantNotesRaw === undefined || importantNotesRaw === null
      ? null
      : importBardField(context, importantNotesRaw, entry.sourceFile, "important_notes");

  checkCharacterLimits(context, entry, blueprint);

  // Missing required fields are registered, never filled in. `school-age-mandarin`
  // is a draft carrying `title` alone against a blueprint that declares five
  // required handles; the columns load NULL and the case is reported for the
  // school, exactly as the character limits are grandfathered.
  const required = REQUIRED_PAGE_FIELDS[blueprint];
  if (required !== undefined) {
    const missing = required.filter((field) => entry.data[field] === undefined);
    if (missing.length > 0) {
      context.integrity.missingRequiredFields.push({
        collection: "pages",
        slug: entry.slug,
        source_file: entry.sourceFile,
        blueprint,
        missing,
      });
    }
  }

  const row: PageRow = {
    id: pageId,
    legacy_ref: legacyRef,
    slug: entry.slug,
    parent_id:
      position.parentLegacyRef === null ? null : deriveEntityUuid("pages", position.parentLegacyRef),
    path: position.path,
    sort_order: position.sortOrder,
    title,
    template,
    blueprint,
    published: isPublished(entry.data),
    show_in_nav: showInNav,
    description: asString(entry.data["description"]),
    short_description: asString(entry.data["short_description"]),
    intro: asString(entry.data["intro"]),
    welcome_line: asString(entry.data["welcome_line"]),
    main_image_asset_id: resolveAsset("main_image"),
    program_image_asset_id: resolveAsset("program_image"),
    important_notes: importantNotes,
    seo_title: null,
    seo_description: null,
    og_image_id: null,
    legacy: buildLegacy(entry, PAGE_CONSUMED_KEYS, ["parent", "include"]),
    classrooms: pageClassrooms,
    ...provenanceOf(entry),
  };

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "pages";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "pages";
  file.legacy_ref = legacyRef;
  file.route = row.path;
  file.published = row.published;
  file.relations = {
    parent_legacy_ref: position.parentLegacyRef,
    page_sections: sections.length,
    page_classrooms: pageClassrooms.length,
  };
  file.asset_references = assetReferences;
  if (isHome) {
    file.notes.push("the tree names this entry by the literal string `home`, not a uuid");
  }

  return { row, sections };
};


/* ==========================================================================
 * 14. The other six collections
 * ========================================================================== */

const PEOPLE_CONSUMED_KEYS = [
  "id",
  "title",
  "officialtitle",
  "joined_ces",
  "email",
  "bio",
  "photo",
  "published",
  "role",
  "education",
  "updated_at",
  "updated_by",
] as const;

/**
 * Build one person, their education rows and their role relation.
 *
 * `name` is renamed from the generic handle `title`, `official_title` from
 * `officialtitle`. `bio` is a PLAIN STRING: the blueprint declares `textarea`,
 * not bard, so there is no rich-text document here to convert.
 *
 * AT LEAST ONE ROLE IS REQUIRED, enforced in the database by a deferred
 * constraint trigger. Every one of the 77 entries carries a non-empty `role`
 * list, so the canonical load MEETS that invariant rather than being blocked by
 * it. This program never invents a role and never omits one that exists: an
 * entry with no role is reported and the seed will then fail loudly at commit,
 * which is the correct outcome — a fabricated role would put a person on a page
 * nobody chose, and a relaxed constraint would let a real assignment be dropped
 * silently.
 */
const buildPerson = (
  context: Context,
  entry: SourceEntry,
  sortOrder: number,
  termIdsBySlug: ReadonlyMap<string, string>,
): PersonRow => {
  const legacyRef = legacyRefOf(entry);
  const name = asString(entry.data["title"]);
  if (name === null) {
    throw new ExtractionError(`${entry.sourceFile}: a person row requires a name.`);
  }

  const assetReferences: string[] = [];
  const photo = asString(entry.data["photo"]);
  let photoAssetId: string | null = null;
  if (photo !== null) {
    assetReferences.push(photo);
    photoAssetId = resolveAssetId(context.assets, photo, entry.sourceFile, "photo");
  }

  const joinedRaw = entry.data["joined_ces"];
  const joinedCes =
    joinedRaw === undefined || joinedRaw === null
      ? null
      : requireCalendarString(joinedRaw, entry.sourceFile, "joined_ces");

  const education: PersonEducationRow[] = [];
  /** Institution sets that name no institution: preserved in `legacy`, never a row. */
  const skippedEducation: Record<string, unknown>[] = [];
  const educationSets = entry.data["education"];
  if (educationSets !== undefined && educationSets !== null) {
    const sets = asRecordArray(educationSets);
    if (sets === null) {
      throw new ExtractionError(`${entry.sourceFile}: education is not an array of sets.`);
    }
    for (const [index, set] of sets.entries()) {
      const kind = asString(set["type"]);
      if (kind !== "institution") {
        throw new ExtractionError(
          `${entry.sourceFile}: education[${String(index)}] has set type ${String(kind)}; ` +
            `people.yaml declares only an \`institution\` set.`,
        );
      }
      censusSet(context, "education", kind, set);
      const institution = asString(set["name_of_institution"]);
      if (institution === null) {
        // AN EMPTY INSTITUTION SET. One exists — `alex-danton-klein.md` carries a
        // set with `id`, `type` and `enabled` and no `name_of_institution` at all,
        // an artifact of the editor adding a row and never filling it in.
        //
        // `person_education.institution_name` is NOT NULL, on the reasoning that
        // a set which exists names an institution, so there is no row this can
        // become. The three options were: invent a value, relax the column, or
        // drop the row and say so. The first two are worse — a fabricated
        // institution would appear on a live bio, and relaxing the column would
        // admit every future empty set silently.
        //
        // So the SET is preserved verbatim in `people.legacy`, the case is
        // registered as the missing required field it is, and no row is emitted.
        // The census consequently reports 81 education SETS and 80
        // person_education ROWS, which is the distinction it exists to keep.
        skippedEducation.push(set);
        context.integrity.missingRequiredFields.push({
          collection: "people",
          slug: entry.slug,
          source_file: entry.sourceFile,
          blueprint: asString(entry.data["blueprint"]) ?? "people",
          missing: [`education[${String(index)}].name_of_institution`],
        });
        continue;
      }
      const childRef = deriveChildLegacyRef(legacyRef, "education", index);
      const enabled = isEnabled(set);
      if (!enabled) {
        context.integrity.disabledRecords.push({
          table: "person_education",
          legacy_ref: childRef,
          source_file: entry.sourceFile,
        });
      }
      education.push({
        id: deriveEntityUuid("person_education", childRef),
        legacy_ref: childRef,
        institution_name: institution,
        sort_order: index + 1,
        enabled,
        legacy: setLegacy(set),
      });
    }
  }

  const roleSlugs = entry.data["role"];
  const slugs = isStringArray(roleSlugs) ? roleSlugs : [];
  if (slugs.length === 0) {
    context.notes.push(
      `${entry.sourceFile}: carries no role term. people.yaml declares the field required ` +
        `and migration 06 enforces at least one with a deferred constraint trigger, so the ` +
        `seed load will fail at commit. No role is invented to paper over this.`,
    );
  }
  const termIds: string[] = [];
  for (const slug of slugs) {
    const termId = termIdsBySlug.get(slug);
    if (termId === undefined) {
      throw new ExtractionError(
        `${entry.sourceFile}: role term ${slug} is not declared in content/taxonomies/role/.`,
      );
    }
    termIds.push(termId);
  }

  checkCharacterLimits(context, entry, asString(entry.data["blueprint"]));

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "people";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "people";
  file.legacy_ref = legacyRef;
  file.route = `${ROUTE_PREFIXES.people}${entry.slug}`;
  file.published = isPublished(entry.data);
  file.relations = {
    person_education: education.length,
    person_education_sets_skipped: skippedEducation.length,
    person_roles: slugs,
    // The reverse half of the classroom relation. Retained in `legacy` on this
    // row and reconciled into classroom_teachers as part of the 41-pair union.
    classrooms: isStringArray(entry.data["classrooms"]) ? entry.data["classrooms"] : [],
  };
  file.asset_references = assetReferences;

  return {
    id: deriveEntityUuid("people", legacyRef),
    legacy_ref: legacyRef,
    slug: entry.slug,
    name,
    official_title: asString(entry.data["officialtitle"]),
    joined_ces: joinedCes,
    // Mixed case is preserved: the local part of an address is case-sensitive by
    // specification and these are the addresses the school publishes.
    email: asString(entry.data["email"]),
    bio: asString(entry.data["bio"]),
    photo_asset_id: photoAssetId,
    published: isPublished(entry.data),
    sort_order: sortOrder,
    seo_title: null,
    seo_description: null,
    og_image_id: null,
    legacy: {
      ...buildLegacy(entry, PEOPLE_CONSUMED_KEYS),
      // Nothing is lost: an institution set that names no institution cannot
      // become a NOT NULL row, so it is carried here verbatim instead.
      ...(skippedEducation.length > 0 ? { education_without_institution: skippedEducation } : {}),
    },
    education,
    role_term_ids: termIds,
    role_slugs: slugs,
    ...provenanceOf(entry),
  };
};

const EVENT_CONSUMED_KEYS = [
  "id",
  "title",
  "event_date",
  "start_time",
  "end_time",
  "location",
  "zoom_link",
  "image",
  "short_description",
  "details",
  "calendar_link",
  "published",
  "updated_at",
  "updated_by",
] as const;

/**
 * Build one event.
 *
 * Five columns are NOT NULL in the schema, mirroring the blueprint's `required`
 * flags: slug, title, event_date, location and short_description.
 *
 * TIMES MIGRATE VERBATIM. The source uses a 12-HOUR CLOCK WITH NO MERIDIEM — the
 * 6:30 PM auction stores '06:30' and '11:00' — and a 24-hour "correction" here
 * would rewrite the school's published event times. The zone contract is
 * America/New_York and lives in the application; these columns are zone-free
 * `date` and `time` and are never converted to UTC.
 *
 * `calendar_link` is preserved BYTE-FOR-BYTE, percent-encoding included, and
 * never regenerated: the four populated values are curated URLs pointing at the
 * school's real calendar.
 *
 * `date_behavior` on the collection config is INERT — no collection is `dated`
 * and no entry carries an entry-level `date:` — so it is not reproduced. Publish
 * state alone governs visibility, which runtime confirms: the unpublished
 * /events/story-slam 404s while a future-dated published event resolves.
 */
const buildEvent = (context: Context, entry: SourceEntry): EventRow => {
  const legacyRef = legacyRefOf(entry);
  const title = asString(entry.data["title"]);
  const location = asString(entry.data["location"]);
  const shortDescription = asString(entry.data["short_description"]);
  if (title === null || location === null || shortDescription === null) {
    throw new ExtractionError(
      `${entry.sourceFile}: title, location and short_description are NOT NULL on events.`,
    );
  }

  const eventDate = requireCalendarString(entry.data["event_date"], entry.sourceFile, "event_date");
  const startRaw = entry.data["start_time"];
  const endRaw = entry.data["end_time"];
  const startTime =
    startRaw === undefined || startRaw === null
      ? null
      : requireCalendarString(startRaw, entry.sourceFile, "start_time");
  const endTime =
    endRaw === undefined || endRaw === null
      ? null
      : requireCalendarString(endRaw, entry.sourceFile, "end_time");

  const assetReferences: string[] = [];
  const image = asString(entry.data["image"]);
  let imageAssetId: string | null = null;
  if (image !== null) {
    assetReferences.push(image);
    imageAssetId = resolveAssetId(context.assets, image, entry.sourceFile, "image");
  }

  const detailsRaw = entry.data["details"];
  const details =
    detailsRaw === undefined || detailsRaw === null
      ? null
      : importBardField(context, detailsRaw, entry.sourceFile, "details");

  // One entry's `zoom_link` holds the prose `Zoom link to come`. It migrates
  // unchanged and is rendered as plain text with no href, because a link to
  // nothing is worse than a note. New writes require a valid https URL, enforced
  // by the application's validator rather than by a check constraint that would
  // have rejected this row.
  const zoomLink = asString(entry.data["zoom_link"]);
  if (zoomLink !== null && !zoomLink.startsWith("https://")) {
    context.notes.push(
      `${entry.sourceFile}: zoom_link is not a URL (${JSON.stringify(zoomLink)}). Migrated ` +
        `unchanged; the renderer emits it as text with no href.`,
    );
  }

  checkCharacterLimits(context, entry, asString(entry.data["blueprint"]));

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "events";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "events";
  file.legacy_ref = legacyRef;
  file.route = `${ROUTE_PREFIXES.events}${entry.slug}`;
  file.published = isPublished(entry.data);
  file.asset_references = assetReferences;

  return {
    id: deriveEntityUuid("events", legacyRef),
    legacy_ref: legacyRef,
    slug: entry.slug,
    title,
    event_date: eventDate,
    start_time: startTime,
    end_time: endTime,
    location,
    zoom_link: zoomLink,
    image_asset_id: imageAssetId,
    short_description: shortDescription,
    details,
    calendar_link: asString(entry.data["calendar_link"]),
    published: isPublished(entry.data),
    seo_title: null,
    seo_description: null,
    og_image_id: null,
    legacy: buildLegacy(entry, EVENT_CONSUMED_KEYS),
    ...provenanceOf(entry),
  };
};

const CLASSROOM_CONSUMED_KEYS = [
  "id",
  "title",
  "description",
  "age_range",
  "published",
  "updated_at",
  "updated_by",
] as const;

/**
 * Build one classroom.
 *
 * `age_range` is promoted to a column because it is the value the target renders,
 * even though the blueprint never declared it. The other four undeclared keys —
 * `programs`, `ages`, `program_type` and `integer` — plus `teachers` are retained
 * in `legacy`: `programs` and `ages` are exactly why /programs/blue-room renders
 * a bare " Program" breadcrumb and an empty <h3> today, and retaining them
 * queryably means a later decision to normalize either is a migration rather than
 * a re-extraction.
 */
const buildClassroom = (context: Context, entry: SourceEntry, sortOrder: number): ClassroomRow => {
  const legacyRef = legacyRefOf(entry);
  const title = asString(entry.data["title"]);
  if (title === null) {
    throw new ExtractionError(`${entry.sourceFile}: title is NOT NULL on classrooms.`);
  }

  checkCharacterLimits(context, entry, asString(entry.data["blueprint"]));

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "classrooms";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "classrooms";
  file.legacy_ref = legacyRef;
  file.route = `${ROUTE_PREFIXES.classrooms}${entry.slug}`;
  file.published = isPublished(entry.data);
  file.relations = {
    // The forward half of the classroom relation.
    teachers: isStringArray(entry.data["teachers"]) ? entry.data["teachers"] : [],
  };

  return {
    id: deriveEntityUuid("classrooms", legacyRef),
    legacy_ref: legacyRef,
    slug: entry.slug,
    title,
    description: asString(entry.data["description"]),
    age_range: asString(entry.data["age_range"]),
    published: isPublished(entry.data),
    sort_order: sortOrder,
    seo_title: null,
    seo_description: null,
    og_image_id: null,
    legacy: buildLegacy(entry, CLASSROOM_CONSUMED_KEYS),
    teachers: [],
    ...provenanceOf(entry),
  };
};

/**
 * Reconcile the two directions of the classroom relation into one union.
 *
 * THE CENTRAL RECONCILIATION, and the one case where no reading of the source is
 * simply correct. `classrooms.teachers` yields 32 pairs, `people.classrooms`
 * yields 24, and only 15 appear in both. The legacy template renders the REVERSE
 * query, so:
 *
 *   - adopting the declared forward relation alone would silently REMOVE 9
 *     associations the site displays today; and
 *   - adopting the reverse alone would DISCARD 17 the entries themselves assert.
 *
 * Neither is acceptable under "no content is lost", so the union of 41 pairs is
 * loaded, each row tagged `forward`, `reverse` or `both`, with both original
 * arrays retained in `legacy` on their respective rows.
 *
 * The honest consequence, stated rather than buried: a handful of classrooms will
 * list a teacher the current site does not show. That is a visible change, it is
 * the school's to confirm or correct, and it gets a named section in the parity
 * report so it is put in front of them rather than discovered.
 */
interface ClassroomUnion {
  readonly rowsByClassroom: ReadonlyMap<string, readonly ClassroomTeacherRow[]>;
  readonly forward: number;
  readonly reverse: number;
  readonly both: number;
  readonly total: number;
  readonly forwardOnly: readonly { readonly classroom: string; readonly person: string }[];
  readonly reverseOnly: readonly { readonly classroom: string; readonly person: string }[];
}

const reconcileClassroomTeachers = (
  classroomEntries: readonly SourceEntry[],
  peopleEntries: readonly SourceEntry[],
): ClassroomUnion => {
  const classroomSlugById = new Map<string, string>();
  for (const entry of classroomEntries) {
    classroomSlugById.set(legacyRefOf(entry), entry.slug);
  }
  const personSlugById = new Map<string, string>();
  for (const entry of peopleEntries) {
    personSlugById.set(legacyRefOf(entry), entry.slug);
  }

  const forwardPairs = new Set<string>();
  const reversePairs = new Set<string>();
  const key = (classroomId: string, personId: string): string => `${classroomId}|${personId}`;

  // Forward order is the order the classroom lists its teachers in, which is the
  // order the page should render. Reverse-only pairs are appended after them.
  const forwardOrder = new Map<string, string[]>();
  for (const entry of classroomEntries) {
    const classroomId = legacyRefOf(entry);
    const teachers = entry.data["teachers"];
    if (!isStringArray(teachers)) {
      continue;
    }
    const ordered: string[] = [];
    for (const personId of teachers) {
      if (!personSlugById.has(personId)) {
        throw new ExtractionError(
          `${entry.sourceFile}: teachers names ${personId}, which is not a person entry.`,
        );
      }
      forwardPairs.add(key(classroomId, personId));
      ordered.push(personId);
    }
    forwardOrder.set(classroomId, ordered);
  }

  for (const entry of peopleEntries) {
    const personId = legacyRefOf(entry);
    const classrooms = entry.data["classrooms"];
    if (!isStringArray(classrooms)) {
      continue;
    }
    for (const classroomId of classrooms) {
      if (!classroomSlugById.has(classroomId)) {
        throw new ExtractionError(
          `${entry.sourceFile}: classrooms names ${classroomId}, which is not a classroom entry.`,
        );
      }
      reversePairs.add(key(classroomId, personId));
    }
  }

  const rowsByClassroom = new Map<string, ClassroomTeacherRow[]>();
  const forwardOnly: { classroom: string; person: string }[] = [];
  const reverseOnly: { classroom: string; person: string }[] = [];
  let both = 0;

  const push = (classroomId: string, personId: string): void => {
    const existing = rowsByClassroom.get(classroomId) ?? [];
    const inForward = forwardPairs.has(key(classroomId, personId));
    const inReverse = reversePairs.has(key(classroomId, personId));
    const source: ClassroomTeacherSource = inForward && inReverse ? "both" : inForward ? "forward" : "reverse";
    if (source === "both") {
      both += 1;
    } else if (source === "forward") {
      forwardOnly.push({
        classroom: classroomSlugById.get(classroomId) ?? classroomId,
        person: personSlugById.get(personId) ?? personId,
      });
    } else {
      reverseOnly.push({
        classroom: classroomSlugById.get(classroomId) ?? classroomId,
        person: personSlugById.get(personId) ?? personId,
      });
    }
    existing.push({
      person_id: deriveEntityUuid("people", personId),
      person_legacy_ref: personId,
      sort_order: existing.length + 1,
      source,
    });
    rowsByClassroom.set(classroomId, existing);
  };

  // Forward first, in source order, then the reverse-only remainder sorted by
  // person slug so the result is deterministic rather than dependent on
  // directory iteration.
  for (const entry of classroomEntries) {
    const classroomId = legacyRefOf(entry);
    for (const personId of forwardOrder.get(classroomId) ?? []) {
      push(classroomId, personId);
    }
  }
  const reverseRemainder: { classroomId: string; personId: string }[] = [];
  for (const pair of reversePairs) {
    if (forwardPairs.has(pair)) {
      continue;
    }
    const [classroomId, personId] = pair.split("|");
    if (classroomId === undefined || personId === undefined) {
      continue;
    }
    reverseRemainder.push({ classroomId, personId });
  }
  reverseRemainder.sort((left, right) => {
    const leftKey = `${classroomSlugById.get(left.classroomId) ?? ""}|${personSlugById.get(left.personId) ?? ""}`;
    const rightKey = `${classroomSlugById.get(right.classroomId) ?? ""}|${personSlugById.get(right.personId) ?? ""}`;
    return leftKey < rightKey ? -1 : 1;
  });
  for (const pair of reverseRemainder) {
    push(pair.classroomId, pair.personId);
  }

  const union = new Set<string>([...forwardPairs, ...reversePairs]);
  return {
    rowsByClassroom,
    forward: forwardPairs.size,
    reverse: reversePairs.size,
    both,
    total: union.size,
    forwardOnly,
    reverseOnly,
  };
};

const PROMOTED_CONSUMED_KEYS = [
  "id",
  "title",
  "subtitle",
  "address",
  "summary_or_additional_info",
  "date_of_event",
  "start_time",
  "end_time",
  "image",
  "published",
  "add_link",
  "updated_at",
  "updated_by",
] as const;

/**
 * Build one promoted entry and its optional link.
 *
 * `image_asset_id` is NOT NULL — the only mandatory asset foreign key in the
 * schema — and all 12 entries carry it. `add_link` is bounded to one set by
 * `max_sets: 1` and exactly one entry uses it, so eleven cards render no call to
 * action. All 12 rows are drafts, which is why the carousel shows nothing today:
 * the feature is dormant by DATA, not broken by code, and publishing any of them
 * to make it visible would be a content change nobody asked for.
 */
const buildPromoted = (
  context: Context,
  entry: SourceEntry,
  sortOrder: number,
): PromotedRow => {
  const legacyRef = legacyRefOf(entry);
  const title = asString(entry.data["title"]);
  const image = asString(entry.data["image"]);
  if (title === null || image === null) {
    throw new ExtractionError(
      `${entry.sourceFile}: title and image are NOT NULL on promoted.`,
    );
  }

  const dateRaw = entry.data["date_of_event"];
  const startRaw = entry.data["start_time"];
  const endRaw = entry.data["end_time"];

  const links: PromotedLinkRow[] = [];
  const addLink = entry.data["add_link"];
  if (addLink !== undefined && addLink !== null) {
    const sets = asRecordArray(addLink);
    if (sets === null) {
      throw new ExtractionError(`${entry.sourceFile}: add_link is not an array of sets.`);
    }
    for (const [index, set] of sets.entries()) {
      const kind = asString(set["type"]);
      if (kind !== "link") {
        throw new ExtractionError(
          `${entry.sourceFile}: add_link[${String(index)}] has set type ${String(kind)}.`,
        );
      }
      censusSet(context, "add_link", kind, set);
      const linkTitle = asString(set["link_title"]);
      const linkUrl = asString(set["link_address"]);
      if (linkTitle === null || linkUrl === null) {
        throw new ExtractionError(
          `${entry.sourceFile}: both children of an add_link set are NOT NULL within a row ` +
            `that exists.`,
        );
      }
      const childRef = deriveChildLegacyRef(legacyRef, "add_link", index);
      links.push({
        id: deriveEntityUuid("promoted_links", childRef),
        legacy_ref: childRef,
        link_title: linkTitle,
        // Renamed from `link_address`, because it holds a URL.
        link_url: linkUrl,
        sort_order: index + 1,
        legacy: setLegacy(set),
      });

      // The same entry carries an UNDECLARED scalar `link:` holding the identical
      // URL. The replicator is authoritative; the scalar is retained in `legacy`,
      // is not rendered, and the duplication is reported.
      const scalarLink = asString(entry.data["link"]);
      if (scalarLink !== null) {
        context.integrity.promotedLinkDuplication.push({
          slug: entry.slug,
          source_file: entry.sourceFile,
          scalar_link: scalarLink,
          replicator_link: linkUrl,
        });
      }
    }
  }

  checkCharacterLimits(context, entry, asString(entry.data["blueprint"]));

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "promoted";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "promoted";
  file.legacy_ref = legacyRef;
  file.route = null;
  file.published = isPublished(entry.data);
  file.relations = { promoted_links: links.length };
  file.asset_references = [image];
  file.notes.push("promoted declares no route: it renders as a component of the home page");

  return {
    id: deriveEntityUuid("promoted", legacyRef),
    legacy_ref: legacyRef,
    slug: entry.slug,
    title,
    subtitle: asString(entry.data["subtitle"]),
    address: asString(entry.data["address"]),
    summary: asString(entry.data["summary_or_additional_info"]),
    event_date:
      dateRaw === undefined || dateRaw === null
        ? null
        : requireCalendarString(dateRaw, entry.sourceFile, "date_of_event"),
    start_time:
      startRaw === undefined || startRaw === null
        ? null
        : requireCalendarString(startRaw, entry.sourceFile, "start_time"),
    end_time:
      endRaw === undefined || endRaw === null
        ? null
        : requireCalendarString(endRaw, entry.sourceFile, "end_time"),
    image_asset_id: resolveAssetId(context.assets, image, entry.sourceFile, "image"),
    published: isPublished(entry.data),
    sort_order: sortOrder,
    legacy: buildLegacy(entry, PROMOTED_CONSUMED_KEYS),
    links,
    ...provenanceOf(entry),
  };
};

const ANNOUNCEMENT_CONSUMED_KEYS = [
  "id",
  "title",
  "link",
  "feature_on_homepage",
  "published",
  "updated_at",
  "updated_by",
] as const;

/**
 * Build one announcement.
 *
 * `link_page_id` is NULLABLE for exactly one reason: one of the four source links
 * points at an id no entry carries. The row loads with a null foreign key, the
 * raw id is retained in `legacy.link`, and the banner renders without a link for
 * that row. A non-null column would have made this one row abort the load.
 *
 * The title is loaded at FULL LENGTH. All four exceed the blueprint's declared
 * limit of 30 characters, and the limit lives in the application's validation
 * layer where it constrains new writes; truncating the school's own headlines to
 * satisfy a declaration the corpus never honoured is not migration.
 */
const buildAnnouncement = (
  context: Context,
  entry: SourceEntry,
  pathsByEntryId: ReadonlyMap<string, string>,
  pageIdsByEntryId: ReadonlyMap<string, string>,
): AnnouncementRow => {
  const legacyRef = legacyRefOf(entry);
  const title = asString(entry.data["title"]);
  if (title === null) {
    throw new ExtractionError(`${entry.sourceFile}: title is NOT NULL on announcements.`);
  }

  const rawLink = asString(entry.data["link"]);
  let linkPageId: string | null = null;
  let linkPagePath: string | null = null;
  if (rawLink !== null) {
    const resolvedId = pageIdsByEntryId.get(rawLink);
    const resolvedPath = pathsByEntryId.get(rawLink);
    if (resolvedId === undefined || resolvedPath === undefined) {
      context.integrity.danglingAnnouncementLinks.push({
        slug: entry.slug,
        source_file: entry.sourceFile,
        raw_link: rawLink,
      });
    } else {
      linkPageId = resolvedId;
      linkPagePath = resolvedPath;
    }
  }

  checkCharacterLimits(context, entry, asString(entry.data["blueprint"]));

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "announcements";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "announcements";
  file.legacy_ref = legacyRef;
  file.route = null;
  file.published = isPublished(entry.data);
  file.relations = { link_page_path: linkPagePath };
  file.notes.push(
    "announcements declares no route; the slug comes from the filename and deliberately " +
      "does not match the title",
  );

  return {
    id: deriveEntityUuid("announcements", legacyRef),
    legacy_ref: legacyRef,
    slug: entry.slug,
    title,
    link_page_id: linkPageId,
    link_page_path: linkPagePath,
    feature_on_homepage: asBoolean(entry.data["feature_on_homepage"]) ?? false,
    published: isPublished(entry.data),
    legacy: buildLegacy(entry, ANNOUNCEMENT_CONSUMED_KEYS, ["link"]),
    ...provenanceOf(entry),
  };
};

const QUOTE_CONSUMED_KEYS = [
  "id",
  "title",
  "attribution",
  "published",
  "updated_at",
  "updated_by",
] as const;

/**
 * Build one inspiring quote.
 *
 * `quote` is renamed from the handle `title`, because the field holds the
 * quotation text. The collection carries ZERO `published:` keys and all five are
 * live, which is the clearest demonstration of why absence must read as
 * published. Two of the five contain U+2013 en dashes that round-trip by
 * codepoint.
 */
const buildQuote = (context: Context, entry: SourceEntry): InspiringQuoteRow => {
  const legacyRef = legacyRefOf(entry);
  const quote = asString(entry.data["title"]);
  if (quote === null) {
    throw new ExtractionError(`${entry.sourceFile}: quote text is NOT NULL on inspiring_quotes.`);
  }

  const file = registerFile(context, entry.sourceFile, entry.sha256, "entry");
  file.collection = "inspiring_quotes";
  file.slug = entry.slug;
  file.keys = Object.keys(entry.data);
  file.target_table = "inspiring_quotes";
  file.legacy_ref = legacyRef;
  file.route = null;
  file.published = isPublished(entry.data);
  file.notes.push("no published key in this collection: all five entries are live");

  return {
    id: deriveEntityUuid("inspiring_quotes", legacyRef),
    legacy_ref: legacyRef,
    slug: entry.slug,
    quote,
    attribution: asString(entry.data["attribution"]),
    published: isPublished(entry.data),
    legacy: buildLegacy(entry, QUOTE_CONSUMED_KEYS),
    ...provenanceOf(entry),
  };
};

/**
 * The three `role` terms.
 *
 * `content/taxonomies/role.yaml` declares nothing but `title: Role`, so there is
 * no visibility field to carry and every term is public. The `legacy_ref` is the
 * slug, which for a term is its filename stem.
 */
const buildTaxonomyTerms = async (context: Context): Promise<TaxonomyTermRow[]> => {
  const taxonomyFile = "content/taxonomies/role.yaml";
  const taxonomy = await parseYamlFile(context.sourceRoot, taxonomyFile);
  registerFile(context, taxonomyFile, taxonomy.sha256, "taxonomy").notes.push(
    "declares only `title: Role`; no visibility field exists to migrate",
  );

  const dir = join(context.sourceRoot, "content", "taxonomies", "role");
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".yaml"))
    .sort((left, right) => (left < right ? -1 : 1));

  const rows: TaxonomyTermRow[] = [];
  for (const name of names) {
    const relative = `content/taxonomies/role/${name}`;
    const parsed = await parseYamlFile(context.sourceRoot, relative);
    if (!isRecord(parsed.value)) {
      throw new ExtractionError(`${relative}: term did not parse to a mapping.`);
    }
    const slug = basename(name, ".yaml");
    const title = asString(parsed.value["title"]);
    if (title === null) {
      throw new ExtractionError(`${relative}: term has no title.`);
    }
    const updatedAt = asIntegerFrom(parsed.value["updated_at"]);
    const updatedBy = asString(parsed.value["updated_by"]);

    const file = registerFile(context, relative, parsed.sha256, "taxonomy-term");
    file.keys = Object.keys(parsed.value);
    file.target_table = "taxonomy_terms";
    file.legacy_ref = slug;
    file.slug = slug;

    rows.push({
      id: deriveEntityUuid("taxonomy_terms", slug),
      legacy_ref: slug,
      taxonomy: "role",
      slug,
      title,
      source_updated_at: updatedAt === null ? null : epochToIso(updatedAt),
      source_updated_by: updatedBy === null ? null : mapUpdatedBy(updatedBy),
    });
  }
  return rows;
};


/* ==========================================================================
 * 15. site_globals and nav_items
 * --------------------------------------------------------------------------
 * Both are SEEDED rather than migrated, because neither exists in the source:
 * `content/globals/` holds nothing but a .gitkeep and `content/navigation/` the
 * same. What does exist is a set of values hardcoded in
 * `resources/views/layout.antlers.html`, which staff cannot edit without a
 * developer and a deploy. Promoting them changes where a value lives, never the
 * value.
 *
 * The KEY SET IS CLOSED by a check constraint, so every key below is one the
 * schema already admits. Migration 11 seeds all twenty-six itself with
 * `on conflict (key) do nothing`; the seed this program writes upserts with
 * `do update`, which is what lets it fill the one row the migration provably
 * cannot — the logo, whose asset foreign key needs `public.assets` populated.
 * ========================================================================== */

/** Literals the layout template must still contain for the promotion to be honest. */
const LAYOUT_EXPECTED_LITERALS = [
  "80 Trowbridge St.",
  "Cambridge, MA 02138",
  "617-354-0014",
  "617-491-4313",
  "mailto:info@cambridge-ellis.org",
  "https://www.instagram.com/cambridgeellis/",
  "https://www.facebook.com/CambridgeEllisSchool/",
  '<a href="/donate"',
  "/assets/CESHouseLogo.png",
] as const;

/** The logo's source filename, which the branding global references as a typed FK. */
const LOGO_FILENAME = "CESHouseLogo.png";

/** The Blackbaud family-portal host, recovered from a disabled block. */
const FAMILY_PORTAL_HOST = "bngn.blackbaud.school";

/**
 * Trim a description to the metadata ceiling on a word boundary.
 *
 * 155 characters including a single-character ellipsis, which is what the seeded
 * `site_description` is: the school's OWN WORDS, from `home.md`'s `intro`, not
 * generated and not written here. It exists so that no route can ever emit an
 * empty meta description.
 */
const trimToDescription = (text: string, limit = 155): string => {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = (lastSpace === -1 ? cut : cut.slice(0, lastSpace)).replace(/[\s,.;:!?-]+$/, "");
  return `${head}\u2026`;
};

const buildSiteGlobals = async (
  context: Context,
  homeEntry: SourceEntry,
  depositsHrefs: readonly string[],
): Promise<SiteGlobalRow[]> => {
  const layoutPath = "resources/views/layout.antlers.html";
  const layoutRaw = await readTextFile(join(context.sourceRoot, layoutPath));
  const layoutFile = registerFile(context, layoutPath, sha256(layoutRaw), "template");
  layoutFile.target_table = "site_globals";
  layoutFile.notes.push(
    "address, phone, fax, email, social URLs, the logo reference, the donate call to " +
      "action and both analytics identifiers promoted into site_globals",
  );

  // The values are declared rather than scraped, because scraping presentational
  // HTML for an address is brittle in a way that fails silently. Their PRESENCE
  // is verified instead, so a template edit that moves or changes one of them
  // stops the extraction rather than migrating a value that is no longer there.
  for (const literal of LAYOUT_EXPECTED_LITERALS) {
    if (!layoutRaw.includes(literal)) {
      throw new ExtractionError(
        `${layoutPath} no longer contains ${JSON.stringify(literal)}. The values promoted ` +
          `into site_globals are verified against the template; re-read it and update the ` +
          `promotion rather than seeding a value the source no longer holds.`,
      );
    }
  }

  // The three identifiers ARE extracted, because each appears in a machine-shaped
  // form that can be read exactly. All three are CONTENT rather than environment
  // variables, deliberately: held here they are present in the committed fallback
  // JSON, so both tags work in the keyless state and staff can correct a mistyped
  // identifier without a redeploy.
  const adsId = /gtag\/js\?id=([A-Za-z]+-[A-Za-z0-9]+)/.exec(layoutRaw)?.[1];
  const scProject = /var\s+sc_project\s*=\s*(\d+)/.exec(layoutRaw)?.[1];
  const scSecurity = /var\s+sc_security\s*=\s*"(\d+)"/.exec(layoutRaw)?.[1];
  if (adsId === undefined || scProject === undefined || scSecurity === undefined) {
    throw new ExtractionError(
      `${layoutPath}: could not read the Google Ads tag, the StatCounter project or its ` +
        `security token. All three are required and the StatCounter pair appears twice — in ` +
        `the script config and in the noscript pixel URL — so both must be carried.`,
    );
  }

  const addonPath = "content/addons/plugrbase-maintenance-mode.yaml";
  const addon = await parseYamlFile(context.sourceRoot, addonPath);
  if (!isRecord(addon.value)) {
    throw new ExtractionError(`${addonPath} did not parse to a mapping.`);
  }
  const addonFile = registerFile(context, addonPath, addon.sha256, "addon");
  addonFile.keys = Object.keys(addon.value);
  addonFile.target_table = "site_globals";
  addonFile.notes.push(
    'maintenance title and message migrate VERBATIM, "Stay tooned!" included: that ' +
      "spelling is not the one authorized copy edit, so it is not this migration's to fix",
  );
  const maintenanceTitle = asString(addon.value["maintenance_mode_title"]);
  const maintenanceMessage = asString(addon.value["maintenance_mode_message"]);
  if (maintenanceTitle === null || maintenanceMessage === null) {
    throw new ExtractionError(`${addonPath}: the maintenance title and message are required.`);
  }
  // FALSE, never the source's value read blindly — but the source is false too, so
  // this is preservation rather than an override. Enabling maintenance from a seed
  // would take the site down the moment the load ran.
  const maintenanceEnabled = asBoolean(addon.value["maintenance_mode_enabled"]) ?? false;
  if (maintenanceEnabled) {
    throw new ExtractionError(
      `${addonPath}: maintenance mode is enabled in the source. Seeding that would take the ` +
        `site down at load time; switch it off in the source or seed the flag by hand.`,
    );
  }

  // RECOVERED, NOT INVENTED, AND SHIPPED UNCONFIRMED. The URL sits inside a
  // replicator set whose `enabled: false` has been set for long enough that
  // nothing can vouch for it still resolving, so `confirmed` travels INSIDE
  // `value` and cannot be separated from the URL through export, import or
  // revision history. NavTree and SiteFooter must treat anything other than
  // `confirmed: true` as "hide the item": an enrolled parent who clicks a broken
  // portal link has been failed more expensively than one who never saw it.
  const portalUrl = depositsHrefs.find((href) => {
    try {
      return new URL(href).hostname === FAMILY_PORTAL_HOST;
    } catch {
      return false;
    }
  });
  if (portalUrl === undefined) {
    context.notes.push(
      `No ${FAMILY_PORTAL_HOST} URL was found in the corpus, so family_portal_url is seeded ` +
        `null. Nothing is invented for it.`,
    );
  }

  const intro = asString(homeEntry.data["intro"]);
  if (intro === null) {
    throw new ExtractionError(
      `${homeEntry.sourceFile}: intro is the source of site_globals.site_description and is ` +
        `absent. Nothing is generated in its place.`,
    );
  }

  const specs: readonly GlobalSpec[] = [
    // contact (8) — the sidebar address block. One source line, `Cambridge, MA
    // 02138`, is split across three keys because StructuredData emits
    // addressLocality, addressRegion and postalCode separately and a Preschool
    // node cannot be assembled from one pre-joined string.
    { key: "address_line_1", group: "contact", label: "Street address", public: true, sortOrder: 1, value: "80 Trowbridge St.", origin: layoutPath },
    { key: "address_locality", group: "contact", label: "City", public: true, sortOrder: 2, value: "Cambridge", origin: layoutPath },
    { key: "address_region", group: "contact", label: "State", public: true, sortOrder: 3, value: "MA", origin: layoutPath },
    { key: "address_postal", group: "contact", label: "ZIP code", public: true, sortOrder: 4, value: "02138", origin: layoutPath },
    // Stored exactly as the source renders them, hyphens included: the value staff
    // see and edit should be the value the page shows. E.164 normalization for a
    // tel: href happens on write and on read, not here.
    { key: "phone", group: "contact", label: "Phone", public: true, sortOrder: 5, value: "617-354-0014", origin: layoutPath },
    { key: "fax", group: "contact", label: "Fax", public: true, sortOrder: 6, value: "617-491-4313", origin: layoutPath },
    { key: "email", group: "contact", label: "Email", public: true, sortOrder: 7, value: "info@cambridge-ellis.org", origin: layoutPath },
    // EMPTY BY DESIGN. No opening-hours value exists anywhere in content/ or in
    // the layout, so there is nothing to migrate and nothing may be invented —
    // publishing school hours the school did not state would be worse than
    // publishing none. StructuredData omits the property entirely until this is
    // populated.
    { key: "opening_hours", group: "contact", label: "Opening hours", public: true, sortOrder: 8, value: null, origin: "no source value exists" },

    // social (4)
    { key: "instagram_url", group: "social", label: "Instagram URL", public: true, sortOrder: 1, value: "https://www.instagram.com/cambridgeellis/", origin: layoutPath },
    { key: "facebook_url", group: "social", label: "Facebook URL", public: true, sortOrder: 2, value: "https://www.facebook.com/CambridgeEllisSchool/", origin: layoutPath },
    // ROOT-RELATIVE BY DESIGN. The layout's donate call to action is
    // `<a href="/donate">`, an internal page rather than an external payment host.
    // An absolute form would hardcode the hostname, break every preview
    // deployment and force a full page load where client routing should happen.
    { key: "donate_url", group: "social", label: "Donate link", public: true, sortOrder: 3, value: "/donate", origin: layoutPath },
    {
      key: "family_portal_url",
      group: "social",
      label: "Family portal URL",
      public: true,
      sortOrder: 4,
      value: portalUrl === undefined ? null : { url: portalUrl, confirmed: false },
      origin: "content/collections/pages/deposits.md (inside a disabled replicator set)",
    },

    // branding (4). `logo` carries its asset reference in `asset_id`, a typed
    // foreign key, rather than a path inside JSON — so it participates in
    // reference blocking and in anonymous asset visibility.
    { key: "logo", group: "branding", label: "Logo", public: true, sortOrder: 1, value: null, origin: layoutPath },
    // EMPTY BY DESIGN. The source alt text is the PAGE TITLE, so the logo
    // announces itself as "About" on /about. That is a misuse, not a value, and
    // seeding it would migrate the defect instead of the content.
    { key: "logo_alt", group: "branding", label: "Logo alt text", public: true, sortOrder: 2, value: null, origin: "no usable source value: the template binds alt to the page title" },
    { key: "site_name", group: "branding", label: "Site name", public: true, sortOrder: 3, value: "Cambridge-Ellis School", origin: "resources/views/layout.antlers.html (document title fallback)" },
    { key: "tagline", group: "branding", label: "Tagline", public: true, sortOrder: 4, value: null, origin: "no source value exists" },

    // announcement (2). Both values are CHOSEN, not migrated: the legacy banner
    // had no settings at all, only markup. Off is the safe default and the honest
    // one — the banner shows nothing today regardless, because the only published
    // announcement carries feature_on_homepage: false while all three that carry
    // true are drafts.
    { key: "banner_enabled", group: "announcement", label: "Show announcement banner", public: true, sortOrder: 1, value: false, origin: "chosen: the legacy banner had no settings" },
    { key: "banner_variant", group: "announcement", label: "Banner style", public: true, sortOrder: 2, value: "brand", origin: "chosen: names the lime band the legacy site rendered" },

    // analytics (3)
    { key: "google_ads_id", group: "analytics", label: "Google Ads tag ID", public: true, sortOrder: 1, value: adsId, origin: layoutPath },
    { key: "statcounter_project", group: "analytics", label: "StatCounter project ID", public: true, sortOrder: 2, value: scProject, origin: layoutPath },
    { key: "statcounter_security", group: "analytics", label: "StatCounter security token", public: true, sortOrder: 3, value: scSecurity, origin: layoutPath },

    // maintenance (4) — THE ONLY FOUR PRIVATE ROWS, so an anonymous reader cannot
    // read the interstitial's copy before the school has used it. That privacy is
    // why the request boundary needs get_maintenance_state().
    { key: "maintenance_enabled", group: "maintenance", label: "Maintenance mode", public: false, sortOrder: 1, value: maintenanceEnabled, origin: addonPath },
    { key: "maintenance_title", group: "maintenance", label: "Maintenance heading", public: false, sortOrder: 2, value: maintenanceTitle, origin: addonPath },
    { key: "maintenance_message", group: "maintenance", label: "Maintenance message", public: false, sortOrder: 3, value: maintenanceMessage, origin: addonPath },
    { key: "maintenance_retry_after", group: "maintenance", label: "Retry after (seconds)", public: false, sortOrder: 4, value: 3600, origin: "chosen: the addon had no retry value" },

    // seo (1) — the terminal metadata fallback, in the school's own words.
    { key: "site_description", group: "seo", label: "Default meta description", public: true, sortOrder: 1, value: trimToDescription(intro), origin: `${homeEntry.sourceFile} (intro, trimmed on a word boundary)` },
  ];

  return specs.map((spec) => ({
    id: deriveEntityUuid("site_globals", spec.key),
    key: spec.key,
    value: spec.value,
    asset_id:
      spec.key === "logo"
        ? resolveAssetId(context.assets, LOGO_FILENAME, layoutPath, "logo")
        : null,
    label: spec.label,
    group: spec.group,
    public: spec.public,
    sort_order: spec.sortOrder,
  }));
};

/**
 * Build the 38 nav rows.
 *
 * Every target is resolved from the migrated pages BY PATH and a MISS IS FATAL.
 * A null target on an item row would ship an inert menu entry, which is exactly
 * the failure a quiet `select id from pages where path = ...` produces.
 */
const buildNavItems = (
  context: Context,
  pagesByPath: ReadonlyMap<string, PageRow>,
): NavItemRow[] => {
  const treeFile = context.files.get("content/trees/collections/pages.yaml");
  if (treeFile !== undefined) {
    treeFile.notes.push("also the starting point for the designed nav_items seed");
  }

  const rows: NavItemRow[] = NAV_SEED.map((spec) => {
    let targetPageId: string | null = null;
    let targetPath: string | null = null;
    if (spec.path !== null) {
      const page = pagesByPath.get(spec.path);
      if (page === undefined) {
        throw new ExtractionError(
          `nav_items: ${spec.ref} targets ${spec.path}, which no migrated page carries. The ` +
            `designed menu in migration 12 §7 and the page tree disagree; fix the seed rather ` +
            `than loading a menu row with no destination.`,
        );
      }
      targetPageId = page.id;
      targetPath = page.path;
    }
    return {
      id: deriveEntityUuid("nav_items", spec.ref),
      legacy_ref: spec.ref,
      parent_id: spec.parentRef === null ? null : deriveEntityUuid("nav_items", spec.parentRef),
      parent_legacy_ref: spec.parentRef,
      label: spec.label,
      target_page_id: targetPageId,
      target_page_path: targetPath,
      external_url: null,
      audience: spec.audience,
      sort_order: spec.sortOrder,
      visible: spec.visible,
    };
  });

  // The invariants migration 12 §7d asks the seed to satisfy, asserted here as
  // well as in the seed's own terminal transaction: a menu that is wrong is
  // cheaper to catch now than after a load.
  const roots = rows.filter((row) => row.parent_id === null);
  if (roots.length !== 3) {
    throw new ExtractionError(`nav_items: expected 3 roots, built ${String(roots.length)}.`);
  }
  const withoutTarget = rows.filter((row) => row.target_page_id === null && row.external_url === null);
  if (withoutTarget.length !== 3) {
    throw new ExtractionError(
      `nav_items: exactly the 3 group headers may lack a target; ${String(withoutTarget.length)} do.`,
    );
  }
  if (!rows.some((row) => row.legacy_ref === HEADER_ACTIONS_REF)) {
    throw new ExtractionError(
      `nav_items: the contractual ${HEADER_ACTIONS_REF} row is missing. SiteHeader resolves the ` +
        `two header calls to action by that literal string.`,
    );
  }
  const refs = new Set<string>();
  for (const row of rows) {
    if (refs.has(row.legacy_ref)) {
      throw new ExtractionError(`nav_items: duplicate legacy_ref ${row.legacy_ref}.`);
    }
    refs.add(row.legacy_ref);
    if (row.parent_legacy_ref !== null && !NAV_SEED.some((spec) => spec.ref === row.parent_legacy_ref)) {
      throw new ExtractionError(
        `nav_items: ${row.legacy_ref} names parent ${row.parent_legacy_ref}, which is not in the seed.`,
      );
    }
  }
  // Exactly one page is expected to appear in no menu row, and it is home: the
  // logo reaches it, which is how the legacy sidebar excludes it too.
  const targeted = new Set(rows.map((row) => row.target_page_id).filter((id) => id !== null));
  const untargeted = [...pagesByPath.values()].filter((page) => !targeted.has(page.id));
  if (untargeted.length !== 1 || untargeted[0]?.legacy_ref !== HOME_ENTRY_ID) {
    context.notes.push(
      `nav_items: ${String(untargeted.length)} page(s) appear in no menu row ` +
        `(${untargeted.map((page) => page.path).join(", ")}). Exactly one — home — is expected.`,
    );
  }

  return rows;
};


/* ==========================================================================
 * 16. Routes and the route manifest
 * --------------------------------------------------------------------------
 * The 142 content paths, and NOT ONE OF THEM MAY CHANGE. They are indexed, they
 * are printed in school materials, and there is no redirect layer to fall back
 * on — so preservation is by construction here rather than by a rewrite rule
 * later.
 *
 * Uniqueness is the part that needs enforcing rather than observing. All 142 are
 * unique in the corpus today, but nothing in the flat files guaranteed it:
 * `/programs/{slug}` is claimed by the umbrella PAGES and by CLASSROOM entries,
 * and `/community/{slug}` by landing pages and by 77 staff bios. Two namespaces
 * shared by two collections each is an overlap that happens not to collide, and
 * a program that assumed it could never collide would ship a site where one URL
 * resolves to two rows.
 *
 * `precedence` is fixed by `content_routes` — pages 1, classrooms 2, people 3,
 * events 4 — so behaviour stays defined even under an unexpected duplicate. It is
 * copied from `ROUTE_KINDS` rather than restated, because the view and this file
 * disagreeing about precedence is exactly the class of drift a second literal
 * would introduce.
 * ========================================================================== */

/** Assemble the route rows, then prove they are unique and correctly counted. */
const buildRouteRows = (
  pages: readonly PageRow[],
  people: readonly PersonRow[],
  events: readonly EventRow[],
  classrooms: readonly ClassroomRow[],
): RouteRow[] => {
  const rows: RouteRow[] = [];

  // Pages take `path` VERBATIM from the materialized column. `content_routes`
  // does the same, and recomputing it from the slug here would put the one row
  // whose path is not `/<slug>` — home — in two different places.
  for (const page of pages) {
    rows.push({
      path: page.path,
      kind: ROUTE_KINDS.pages.kind,
      id: page.id,
      precedence: ROUTE_KINDS.pages.precedence,
      published: page.published,
    });
  }
  for (const room of classrooms) {
    rows.push({
      path: `${ROUTE_PREFIXES.classrooms}${room.slug}`,
      kind: ROUTE_KINDS.classrooms.kind,
      id: room.id,
      precedence: ROUTE_KINDS.classrooms.precedence,
      published: room.published,
    });
  }
  for (const person of people) {
    rows.push({
      path: `${ROUTE_PREFIXES.people}${person.slug}`,
      kind: ROUTE_KINDS.people.kind,
      id: person.id,
      precedence: ROUTE_KINDS.people.precedence,
      published: person.published,
    });
  }
  for (const event of events) {
    rows.push({
      path: `${ROUTE_PREFIXES.events}${event.slug}`,
      kind: ROUTE_KINDS.events.kind,
      id: event.id,
      precedence: ROUTE_KINDS.events.precedence,
      published: event.published,
    });
  }

  const seen = new Map<string, RouteRow>();
  for (const row of rows) {
    const clash = seen.get(row.path);
    if (clash !== undefined) {
      throw new ExtractionError(
        `Two content rows claim the path ${row.path}: a ${clash.kind} and a ${row.kind}. ` +
          `The four route patterns share two namespaces — /programs/{slug} between the ` +
          `umbrella pages and the classrooms, and /community/{slug} between the landing ` +
          `pages and the 77 bios — so a slug collision across collections is possible and ` +
          `must be resolved in the source before the migration proceeds. Nothing is ` +
          `renamed here: a renamed slug is a changed URL.`,
      );
    }
    seen.set(row.path, row);
  }

  // Ordered by precedence then path, so the emitted snapshot is stable and reads
  // in the same order the view returns.
  rows.sort((left, right) =>
    left.precedence === right.precedence
      ? left.path < right.path
        ? -1
        : 1
      : left.precedence - right.precedence,
  );
  return rows;
};

/** One row of `artifacts/route-manifest.json`. */
interface RouteManifestRow {
  readonly path: string;
  readonly kind: string;
  /** The row's `legacy_ref`, so a failing route can be traced to a source file. */
  readonly legacy_ref: string | null;
  readonly published: boolean | null;
  /**
   * The status an ANONYMOUS request must receive. Null where the honest answer is
   * that this program cannot determine it — a redirect target belongs to the
   * application, and a guessed number in a manifest the end-to-end suite asserts
   * against would produce a failing test that is wrong about what is broken.
   */
  readonly anonymous_status: number | null;
  /** The status a request from an authenticated admin or editor must receive. */
  readonly authenticated_status: number | null;
  readonly note: string | null;
}

/**
 * The system routes, which have no content row behind them.
 *
 * Included because the end-to-end suite reads this manifest and a public-route
 * sweep that never requests the sitemap is not a sweep. Where a status depends on
 * application behaviour this program cannot see — an unauthenticated `/admin`
 * redirect, a `/auth/callback` GET with no code to exchange — the field is null
 * with the reason stated, rather than a plausible number.
 */
const SYSTEM_ROUTES: readonly RouteManifestRow[] = [
  {
    path: "/sitemap.xml",
    kind: "system",
    legacy_ref: null,
    published: null,
    anonymous_status: 200,
    authenticated_status: 200,
    note: "generated from content_routes filtered to published rows; no legacy equivalent exists",
  },
  {
    path: "/robots.txt",
    kind: "system",
    legacy_ref: null,
    published: null,
    anonymous_status: 200,
    authenticated_status: 200,
    note: "public content open, /admin, /auth and /api excluded, sitemap advertised",
  },
  {
    path: "/auth/sign-in",
    kind: "system",
    legacy_ref: null,
    published: null,
    anonymous_status: 200,
    authenticated_status: null,
    note:
      "replaces the Statamic control panel login at /cp. An already-authenticated request " +
      "is redirected, and the destination is the application's to define, so the " +
      "authenticated status is left unasserted rather than guessed.",
  },
  {
    path: "/auth/callback",
    kind: "system",
    legacy_ref: null,
    published: null,
    anonymous_status: null,
    authenticated_status: null,
    note:
      "a route handler, not a page: it exchanges a PKCE, invitation or recovery code and " +
      "redirects. A bare GET carries no code, so no status is asserted for either caller.",
  },
  {
    path: "/admin/**",
    kind: "system",
    legacy_ref: null,
    published: null,
    anonymous_status: null,
    authenticated_status: 200,
    note:
      "the control-panel capabilities with no public counterpart. An anonymous request is " +
      "refused by the segment layout and by proxy.ts; whether that is a redirect or a 404 " +
      "is the application's choice and is asserted there, not here.",
  },
];

const buildRouteManifest = (
  result: ExtractionResult,
  sourceCommit: string | null,
): Record<string, unknown> => {
  const legacyRefById = new Map<string, string>();
  for (const page of result.pages) {
    legacyRefById.set(page.id, page.legacy_ref);
  }
  for (const person of result.people) {
    legacyRefById.set(person.id, person.legacy_ref);
  }
  for (const event of result.events) {
    legacyRefById.set(event.id, event.legacy_ref);
  }
  for (const room of result.classrooms) {
    legacyRefById.set(room.id, room.legacy_ref);
  }

  const contentRows: RouteManifestRow[] = result.routes.map((route) => ({
    path: route.path,
    kind: route.kind,
    legacy_ref: legacyRefById.get(route.id) ?? null,
    published: route.published,
    // A draft is NOT fetched and then hidden: row-level security does not return
    // it, so the anonymous response is a real 404 rather than an empty page.
    anonymous_status: route.published ? 200 : 404,
    // An editor sees drafts, because the authenticated read path is uncached and
    // runs under a session whose policies grant that visibility.
    authenticated_status: 200,
    note: route.published ? null : "draft: the entry carries `published: false`",
  }));

  const published = contentRows.filter((row) => row.anonymous_status === 200).length;

  return {
    generated_at: null,
    generator: GENERATOR,
    source_commit: sourceCommit,
    note:
      "Every content path the legacy site resolved, with the status each caller must " +
      "receive. NOT ONE PATH MAY CHANGE: they are indexed and printed in school materials, " +
      "and the migration introduces no redirect layer. A null status is one this program " +
      "cannot determine rather than one it declined to state.",
    counts: {
      content_paths: contentRows.length,
      published,
      draft: contentRows.length - published,
      by_kind: tally(contentRows, (row) => row.kind),
      system_routes: SYSTEM_ROUTES.length,
    },
    routes: [...contentRows, ...SYSTEM_ROUTES],
  };
};

/* ==========================================================================
 * 17. The corpus census
 * --------------------------------------------------------------------------
 * `artifacts/corpus-census.json` is the RECONCILER OF RECORD for every count
 * this migration states, regenerated on every run so no figure becomes folklore
 * after `content/` is gone. If the specification's prose and this artifact ever
 * disagree, the artifact is right — and it has already been shown right in five
 * places, which is why nodes, marks and replicator set kinds are reported in
 * SEPARATE sections. Conflating the last two is what produces the phantom
 * 417-text-node figure.
 * ========================================================================== */

/** Everything one extraction produced, in one value. */
export interface ExtractionResult {
  readonly sourceCommit: string | null;
  readonly assets: readonly AssetRow[];
  readonly taxonomyTerms: readonly TaxonomyTermRow[];
  readonly pages: readonly PageRow[];
  readonly pageSections: readonly PageSectionRow[];
  readonly people: readonly PersonRow[];
  readonly events: readonly EventRow[];
  readonly classrooms: readonly ClassroomRow[];
  readonly promoted: readonly PromotedRow[];
  readonly announcements: readonly AnnouncementRow[];
  readonly inspiringQuotes: readonly InspiringQuoteRow[];
  readonly siteGlobals: readonly SiteGlobalRow[];
  readonly navItems: readonly NavItemRow[];
  readonly routes: readonly RouteRow[];
  readonly classroomUnion: ClassroomUnion;
  readonly entriesByCollection: ReadonlyMap<CollectionName, readonly SourceEntry[]>;
  readonly context: Context;
}

const countRecord = (counter: ReadonlyMap<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const key of [...counter.keys()].sort((left, right) => (left < right ? -1 : 1))) {
    out[key] = counter.get(key) ?? 0;
  }
  return out;
};

const tally = <T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> => {
  const counter = new Map<string, number>();
  for (const item of items) {
    bump(counter, keyOf(item));
  }
  return countRecord(counter);
};

/**
 * Build the census.
 *
 * Every figure is COMPUTED from the rows and the traversal that built them. None
 * is copied from a specification, which is the whole point: a count that is typed
 * in by hand stops being evidence the moment the corpus moves.
 */
export const buildCorpusCensus = (result: ExtractionResult): Record<string, unknown> => {
  const context = result.context;
  const entries: Record<string, number> = {};
  let entryTotal = 0;
  const drafts: Record<string, number> = {};
  let draftTotal = 0;
  for (const collection of COLLECTIONS) {
    const list = result.entriesByCollection.get(collection) ?? [];
    entries[collection] = list.length;
    entryTotal += list.length;
    const draftCount = list.filter((entry) => !isPublished(entry.data)).length;
    drafts[collection] = draftCount;
    draftTotal += draftCount;
  }

  const routesByKind = tally(result.routes, (route) => route.kind);
  const publishedRoutes = result.routes.filter((route) => route.published).length;

  return {
    generated_at: null,
    generator: GENERATOR,
    source_commit: result.sourceCommit,
    note:
      "The reconciler of record for every count this migration states. Nodes, marks and " +
      "replicator set kinds are separate sections on purpose: a `text` replicator set and a " +
      "ProseMirror `text` node are both `type: \"text\"`, and adding the two together is what " +
      "produces the phantom 417 text-node figure the specification reports.",
    entries: { total: entryTotal, by_collection: entries },
    publish: {
      drafts: { total: draftTotal, by_collection: drafts },
      published: entryTotal - draftTotal,
    },
    routes: {
      total: result.routes.length,
      published: publishedRoutes,
      draft: result.routes.length - publishedRoutes,
      by_kind: routesByKind,
    },
    prosemirror_nodes: countRecord(context.nodeCensus),
    prosemirror_marks: countRecord(context.markCensus),
    replicator_sets: {
      total: [...context.setsByHandle.values()].reduce((sum, value) => sum + value, 0),
      by_kind: countRecord(context.setsByKind),
      by_handle: countRecord(context.setsByHandle),
      without_source_id: {
        total: [...context.setsWithoutId.values()].reduce((sum, value) => sum + value, 0),
        by_handle: countRecord(context.setsWithoutId),
      },
    },
    bard: {
      fields_by_handle: countRecord(context.bardFields),
      /**
       * Counted from FIELD PRESENCE on the source entries, not from the blueprint
       * and not from the sections produced. The two differ: `donate.md` is a
       * `flexible_content_page` and carries no `add_content`, while
       * `school-age-mandarin` is a `programsumbrella` and does — so the 23 are
       * the 22 flexpages plus that one, and are not the 23 entries whose
       * blueprint happens to be `flexible_content_page`.
       */
      pages_with_add_content: (result.entriesByCollection.get("pages") ?? []).filter((entry) => {
        const value = entry.data["add_content"];
        return Array.isArray(value) && value.length > 0;
      }).length,
      replicator_text_sets: context.setsByKind.get("text") ?? 0,
      /**
       * The standalone Bard fields — the ones that store a BARE node array with
       * no wrapper, as against the `text` set's array under the set's own key.
       * Keyed from the constant so the census reports whichever handles that
       * constant names, rather than two hand-written keys that could drift from
       * it. `details` occurs on 4 events, not the 18 the specification states.
       */
      ...Object.fromEntries(
        STANDALONE_BARD_FIELDS.map((handle) => [
          `standalone_${handle}`,
          context.bardFields.get(handle) ?? 0,
        ]),
      ),
    },
    table_family: {
      nodes: [...TABLE_FAMILY].reduce((sum, type) => sum + (context.nodeCensus.get(type) ?? 0), 0),
      entries: context.tableFamilyEntries.size,
      entry_paths: [...context.tableFamilyEntries].sort((left, right) => (left < right ? -1 : 1)),
    },
    links: {
      total_marks: context.linkTally.total,
      absolute_same_origin: context.linkTally.absolute_same_origin,
      internal_scheme: context.linkTally.internal_scheme,
      bare_email: context.linkTally.bare_email,
      existing_mailto: context.linkTally.existing_mailto,
      mixed_case_mailto: context.linkTally.mixed_case_mailto,
      untouched: context.linkTally.untouched,
      transformed: context.linkRecords.length,
    },
    nbsp: {
      entries_with_escape: context.nbspEntries.size,
      entries: [...context.nbspEntries].sort((left, right) => (left < right ? -1 : 1)),
    },
    tables: {
      taxonomy_terms: result.taxonomyTerms.length,
      assets: result.assets.length,
      pages: result.pages.length,
      page_sections: result.pageSections.length,
      page_classrooms: result.pages.reduce((sum, page) => sum + page.classrooms.length, 0),
      people: result.people.length,
      person_education: result.people.reduce((sum, person) => sum + person.education.length, 0),
      person_roles: result.people.reduce((sum, person) => sum + person.role_term_ids.length, 0),
      events: result.events.length,
      classrooms: result.classrooms.length,
      classroom_teachers: result.classrooms.reduce((sum, room) => sum + room.teachers.length, 0),
      promoted: result.promoted.length,
      promoted_links: result.promoted.reduce((sum, row) => sum + row.links.length, 0),
      announcements: result.announcements.length,
      inspiring_quotes: result.inspiringQuotes.length,
      site_globals: result.siteGlobals.length,
      nav_items: result.navItems.length,
    },
    page_sections: {
      total: result.pageSections.length,
      by_kind: tally(result.pageSections, (section) => section.kind),
      disabled: result.pageSections.filter((section) => !section.enabled).length,
      nested: result.pageSections.filter((section) => section.parent_section_id !== null).length,
    },
    nav_items: {
      total: result.navItems.length,
      roots: result.navItems.filter((row) => row.parent_id === null).length,
      invisible: result.navItems.filter((row) => !row.visible).length,
      label_only: result.navItems.filter((row) => row.target_page_id === null).length,
      distinct_targets: new Set(
        result.navItems.map((row) => row.target_page_id).filter((id) => id !== null),
      ).size,
    },
    assets: {
      total: result.assets.length,
      deployed: result.assets.filter((asset) => asset.class === "deployed").length,
      draft_only: result.assets.filter((asset) => asset.class === "draft_only").length,
      archived: result.assets.filter((asset) => asset.class === "archived").length,
      bundled: result.assets.filter((asset) => asset.bundled).length,
      url_aliases: context.assets.manifest.assets.filter((entry) => entry.url_alias).length,
      focal_points: result.assets.filter((asset) => asset.focus_x !== null).length,
      focal_zoom_above_one: result.assets.filter(
        (asset) => asset.focus_zoom !== null && asset.focus_zoom > 1,
      ).length,
      entry_references: [...context.assets.referenced.values()].filter((sources) =>
        sources.some((source) => source.startsWith("content/")),
      ).length,
      template_references: [...context.assets.referenced.values()].filter((sources) =>
        sources.every((source) => !source.startsWith("content/")),
      ).length,
      resolved_references: context.assets.referenced.size,
      bytes: result.assets.reduce((sum, asset) => sum + (asset.size_bytes ?? 0), 0),
    },
    classroom_relation: {
      forward: result.classroomUnion.forward,
      reverse: result.classroomUnion.reverse,
      both: result.classroomUnion.both,
      union: result.classroomUnion.total,
      forward_only: result.classroomUnion.forwardOnly,
      reverse_only: result.classroomUnion.reverseOnly,
    },
    faq: {
      top_level_nodes: context.counters.get("faq_top_level_nodes") ?? 0,
      items: result.pageSections.filter((section) => section.kind === "faq_item").length,
    },
    integrity: {
      stale_parent_references: context.integrity.staleParents.length,
      dangling_announcement_links: context.integrity.danglingAnnouncementLinks.length,
      missing_required_fields: context.integrity.missingRequiredFields.length,
      promoted_link_duplication: context.integrity.promotedLinkDuplication.length,
      grandfathered_over_length: context.integrity.grandfathered.length,
      disabled_records: context.integrity.disabledRecords.length,
      disabled_by_table: tally(context.integrity.disabledRecords, (record) => record.table),
    },
    notes: context.notes,
  };
};

/** Flatten the census to dotted keys so the reference figures can be compared. */
const flattenNumbers = (value: unknown, prefix: string, out: Map<string, number>): void => {
  if (typeof value === "number") {
    out.set(prefix, value);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenNumbers(child, prefix === "" ? key : `${prefix}.${key}`, out);
  }
};

interface CensusMismatch {
  readonly key: string;
  readonly expected: number;
  readonly actual: number | null;
}

/**
 * Compare the computed census against the reference figures.
 *
 * The dotted key names in `REFERENCE_CENSUS` are aliases for census paths, so the
 * mapping is stated once here rather than by contorting the census's shape to
 * match a flat list.
 */
const reconcileCensus = (census: Record<string, unknown>): CensusMismatch[] => {
  const flat = new Map<string, number>();
  flattenNumbers(census, "", flat);

  /**
   * Reference-key -> census-path, for the handful of figures the census reports
   * under a grouping key.
   *
   * Only nine aliases exist, and every other reference key is a literal census
   * path — which is deliberate. A reference figure that needed a bespoke lookup
   * would be a figure the census does not actually publish, and an artifact that
   * cannot state a number it was checked against is not evidence.
   */
  const alias = (key: string): string => {
    if (key.startsWith("entries.") && key !== "entries.total") {
      return `entries.by_collection.${key.slice("entries.".length)}`;
    }
    if (key.startsWith("publish.drafts.") && key !== "publish.drafts.total") {
      return `publish.drafts.by_collection.${key.slice("publish.drafts.".length)}`;
    }
    if (key === "replicator_sets.without_source_id") {
      return "replicator_sets.without_source_id.total";
    }
    const tableTotals: Readonly<Record<string, string>> = {
      "person_roles.total": "tables.person_roles",
      "person_education.total": "tables.person_education",
      "page_classrooms.total": "tables.page_classrooms",
      "promoted_links.total": "tables.promoted_links",
      "site_globals.total": "tables.site_globals",
      "taxonomy_terms.total": "tables.taxonomy_terms",
    };
    return tableTotals[key] ?? key;
  };

  const mismatches: CensusMismatch[] = [];
  for (const [key, expected] of Object.entries(REFERENCE_CENSUS)) {
    const target = alias(key);
    const actual = flat.get(target) ?? null;
    if (actual !== expected) {
      mismatches.push({ key: target, expected, actual });
    }
  }
  return mismatches;
};

/* ==========================================================================
 * 18. supabase/seed.sql
 * --------------------------------------------------------------------------
 * THE SEED MUST BE IDEMPOTENT, and that is a hard CI gate rather than a nicety.
 * `supabase db reset` applies all eighteen migrations FIRST, and migration 11
 * seeds `site_globals` itself; only then does config.toml's `[db.seed] sql_paths`
 * load this file. A plain INSERT would fail on a unique violation the first time
 * anyone ran `db reset`.
 *
 * Ids are resolved by CALLING `public.ces_uuid('<table>','<legacy_ref>')` rather
 * than by emitting literals. That is what lets a child row name its parent in the
 * same statement, and it is the same derivation the fallback JSON embeds — a unit
 * test asserts the two agree.
 * ========================================================================== */

/** A SQL string literal. `E''` only where the value needs an escape. */
const sqlText = (value: string): string => {
  if (/[\\\r\n\t]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "''")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `E'${escaped}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
};

const sqlNullable = (value: string | null): string => (value === null ? "null" : sqlText(value));

const sqlBool = (value: boolean): string => (value ? "true" : "false");

const sqlInt = (value: number): string => {
  if (!Number.isInteger(value)) {
    throw new ExtractionError(`${String(value)} is not an integer.`);
  }
  return String(value);
};

const sqlNumber = (value: number | null): string => (value === null ? "null" : String(value));

/**
 * A jsonb literal.
 *
 * Non-ASCII is escaped to `\uXXXX` so the emitted file stays ASCII-clean and a
 * non-breaking space is unmistakable in a diff rather than an invisible byte.
 * jsonb parses the escape back to the character, so the stored value is identical.
 * The plain `'...'` form is always safe here because `JSON.stringify` never emits
 * a raw newline or a lone backslash outside an escape.
 */
const sqlJson = (value: unknown): string => {
  const json = JSON.stringify(value ?? null).replace(
    /[\u0080-\uFFFF]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `'${json.replace(/'/g, "''")}'::jsonb`;
};

/** `public.ces_uuid('<table>','<legacy_ref>')`. */
const cesUuid = (table: string, legacyRef: string): string =>
  `public.ces_uuid(${sqlText(table)}, ${sqlText(legacyRef)})`;

const cesUuidOrNull = (table: string, legacyRef: string | null): string =>
  legacyRef === null ? "null" : cesUuid(table, legacyRef);

/** One `insert ... values ... on conflict` statement, or a comment when empty. */
const insertStatement = (
  table: string,
  columns: readonly string[],
  rows: readonly string[][],
  conflict: string,
): string => {
  if (rows.length === 0) {
    return `-- ${table}: no rows in this corpus.\n`;
  }
  const values = rows.map((row) => `  (${row.join(", ")})`).join(",\n");
  return (
    `insert into public.${table}\n  (${columns.join(", ")})\nvalues\n${values}\n${conflict};\n`
  );
};

/**
 * The `do update` column list for an upsert.
 *
 * Two classes of column are DELIBERATELY EXCLUDED from every update list:
 *
 *   - the SEO trio (`seo_title`, `seo_description`, `og_image_id`) and
 *     `assets.alt`, because they are net-new fields authored in the application.
 *     They insert as null and a re-run must not wipe what staff wrote.
 *   - the operational columns (`created_at`, `updated_at`, `created_by`,
 *     `lifecycle` bookkeeping), because `updated_at` is maintained by trigger and
 *     `source_updated_at` is the migrated value that must never be overwritten by
 *     a load time.
 *
 * A re-run against a newer source commit therefore refreshes content and leaves
 * authored metadata alone. It never DELETES: a row an older revision created and
 * a newer one dropped stays, and that is reported by the parity run rather than
 * silently removed by a seed.
 */
const onConflictUpdate = (conflictColumns: readonly string[], updateColumns: readonly string[]): string => {
  if (updateColumns.length === 0) {
    return `on conflict (${conflictColumns.join(", ")}) do nothing`;
  }
  const assignments = updateColumns.map((column) => `  ${column} = excluded.${column}`).join(",\n");
  return `on conflict (${conflictColumns.join(", ")}) do update set\n${assignments}`;
};

const SEED_HEADER = (sourceCommit: string | null, counts: FallbackCounts): string =>
  `-- =============================================================================
-- supabase/seed.sql — the canonical content load
-- =============================================================================
--
-- GENERATED. Written by ${GENERATOR} from a Statamic checkout; do not hand-edit.
-- Regenerate with:
--
--   npm run extract -- --source <path-to-a-statamic-checkout>
--
-- Source commit: ${sourceCommit ?? "(unresolved; see artifacts/migration-source-manifest.json)"}
-- Schema version: ${SCHEMA_VERSION}
--
-- ## How this file is applied
--
-- \`supabase db reset\` runs ALL EIGHTEEN MIGRATIONS FIRST and then executes this
-- file, because supabase/config.toml sets [db.seed] sql_paths = ["./seed.sql"].
-- Against the hosted project it is applied once, by psql over TLS.
--
-- ## Idempotency
--
-- Every statement is an upsert. That is required rather than defensive:
-- migration 11 SEEDS site_globals ITSELF, so a plain insert here would fail on a
-- unique violation the first time anyone ran \`db reset\`. Loading this file twice
-- produces identical row counts and identical ids.
--
-- Ids are resolved by CALLING public.ces_uuid('<table>','<legacy_ref>') rather
-- than by embedding literals, which is what lets a child row reference its parent
-- inside the same statement. The fallback JSON embeds the same values computed in
-- TypeScript; a unit test asserts the two agree.
--
-- Two column classes are deliberately absent from every \`do update\` list: the
-- SEO trio and assets.alt, which are authored in the application and must survive
-- a re-run, and the operational timestamps, which are trigger-maintained.
-- \`source_updated_at\` and \`source_updated_by\` carry the MIGRATED provenance and
-- are never defaulted to load time.
--
-- ## What it loads
--
--   taxonomy_terms      ${String(counts.taxonomy_terms)}
--   assets              ${String(counts.assets)}
--   pages               ${String(counts.pages)}
--   page_sections       ${String(counts.page_sections)}
--   page_classrooms     ${String(counts.page_classrooms)}
--   people              ${String(counts.people)}
--   person_education    ${String(counts.person_education)}
--   person_roles        ${String(counts.person_roles)}
--   events              ${String(counts.events)}
--   classrooms          ${String(counts.classrooms)}
--   classroom_teachers  ${String(counts.classroom_teachers)}
--   promoted            ${String(counts.promoted)}
--   promoted_links      ${String(counts.promoted_links)}
--   announcements       ${String(counts.announcements)}
--   inspiring_quotes    ${String(counts.inspiring_quotes)}
--   site_globals        ${String(counts.site_globals)}
--   nav_items           ${String(counts.nav_items)}
--   routes (view)       ${String(counts.routes)}
--
-- \`published\` is stated EXPLICITLY on every row of every collection, because the
-- columns default to false while the Statamic rule is that absence means
-- published. Over-length values load as they are: the blueprint character limits
-- live in the application's validation layer, and a check constraint here would
-- have aborted the load on four announcement titles and two page descriptions.
-- =============================================================================

begin;

-- One transaction, for three reasons that are all load-bearing:
--   * people.has_role is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so
--     person_roles must land before commit rather than before the people insert;
--   * the pages and page_sections sibling-order constraints are deferrable and
--     are checked at statement end, which lets each table load in one statement;
--   * the terminal assertions at the foot of this file must be able to abort the
--     whole load, not leave a half-loaded database behind.
`;

const buildSeedSql = (result: ExtractionResult, counts: FallbackCounts): string => {
  const parts: string[] = [SEED_HEADER(result.sourceCommit, counts)];

  /* --- taxonomy_terms ------------------------------------------------------ */
  parts.push(`
-- -----------------------------------------------------------------------------
-- taxonomy_terms — the three live \`role\` terms.
-- role.yaml declares only \`title: Role\`, so there is no visibility field to
-- carry and every term is public. legacy_ref is the term's slug.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "taxonomy_terms",
      ["id", "legacy_ref", "taxonomy", "slug", "title", "source_updated_at", "source_updated_by"],
      result.taxonomyTerms.map((term) => [
        cesUuid("taxonomy_terms", term.legacy_ref),
        sqlText(term.legacy_ref),
        sqlText(term.taxonomy),
        sqlText(term.slug),
        sqlText(term.title),
        sqlNullable(term.source_updated_at),
        sqlNullable(term.source_updated_by),
      ]),
      onConflictUpdate(["legacy_ref"], ["taxonomy", "slug", "title", "source_updated_at", "source_updated_by"]),
    ),
  );

  /* --- assets -------------------------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- assets — all 289 binaries, built from artifacts/assets.manifest.json.
-- \`path\` is the bucket-relative object key and carries the archive/ prefix for
-- archived objects; \`alt\` is null on every row because not one of the 289
-- sidecars carries a value for it, and authoring it for the informative subset is
-- a cutover deliverable. 18 rows carry a focal point, 5 of those with a zoom
-- above 1 — dropping the zoom would silently re-crop those images.
-- \`alt\` is absent from the update list so a re-run cannot wipe authored text.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "assets",
      [
        "id",
        "legacy_ref",
        "bucket",
        "path",
        "filename",
        "mime",
        "size_bytes",
        "width",
        "height",
        "alt",
        "focus_x",
        "focus_y",
        "focus_zoom",
        "lifecycle",
      ],
      result.assets.map((asset) => [
        cesUuid("assets", asset.legacy_ref),
        sqlText(asset.legacy_ref),
        sqlText(asset.bucket),
        sqlText(asset.path),
        sqlText(asset.filename),
        sqlNullable(asset.mime),
        sqlNumber(asset.size_bytes),
        sqlNumber(asset.width),
        sqlNumber(asset.height),
        "null",
        sqlNumber(asset.focus_x),
        sqlNumber(asset.focus_y),
        sqlNumber(asset.focus_zoom),
        sqlText(asset.lifecycle),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        ["bucket", "path", "filename", "mime", "size_bytes", "width", "height", "focus_x", "focus_y", "focus_zoom", "lifecycle"],
      ),
    ),
  );

  /* --- pages --------------------------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- pages — 34 rows, ROOTS FIRST so the self-referencing parent_id resolves.
-- \`path\` is materialized from content/trees/collections/pages.yaml, which is
-- what the legacy site resolved from and is byte-identical to the legacy URL;
-- content_routes uses it verbatim rather than re-deriving it. Four rows carry a
-- \`parent:\` key that resolves to no entry — the tree is authoritative and the raw
-- value is retained in legacy.parent.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "pages",
      [
        "id",
        "legacy_ref",
        "slug",
        "parent_id",
        "path",
        "sort_order",
        "title",
        "template",
        "blueprint",
        "published",
        "show_in_nav",
        "description",
        "short_description",
        "intro",
        "welcome_line",
        "main_image_asset_id",
        "program_image_asset_id",
        "important_notes",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.pages.map((page) => [
        cesUuid("pages", page.legacy_ref),
        sqlText(page.legacy_ref),
        sqlText(page.slug),
        page.parent_id === null
          ? "null"
          : cesUuid(
              "pages",
              result.pages.find((candidate) => candidate.id === page.parent_id)?.legacy_ref ?? "",
            ),
        sqlText(page.path),
        sqlInt(page.sort_order),
        sqlText(page.title),
        sqlText(page.template),
        sqlText(page.blueprint),
        sqlBool(page.published),
        sqlBool(page.show_in_nav),
        sqlNullable(page.description),
        sqlNullable(page.short_description),
        sqlNullable(page.intro),
        sqlNullable(page.welcome_line),
        page.main_image_asset_id === null
          ? "null"
          : cesUuid("assets", assetLegacyRefById(result, page.main_image_asset_id)),
        page.program_image_asset_id === null
          ? "null"
          : cesUuid("assets", assetLegacyRefById(result, page.program_image_asset_id)),
        page.important_notes === null ? "null" : sqlJson(page.important_notes),
        sqlJson(page.legacy),
        sqlNullable(page.source_updated_at),
        sqlNullable(page.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "slug",
          "parent_id",
          "path",
          "sort_order",
          "title",
          "template",
          "blueprint",
          "published",
          "show_in_nav",
          "description",
          "short_description",
          "intro",
          "welcome_line",
          "main_image_asset_id",
          "program_image_asset_id",
          "important_notes",
          "legacy",
          "source_updated_at",
          "source_updated_by",
        ],
      ),
    ),
  );

  /* --- page_sections ------------------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- page_sections — top-level rows first, so parent_section_id resolves.
-- Contiguous ENABLED \`text\` sets were concatenated into one document; a DISABLED
-- text set was never merged, which is what preserves all six page-level
-- \`enabled = false\` records including the two ADJACENT disabled sets in apply.md.
-- The 11 faq_item rows come from the deterministic Q:/A: split, whose parity
-- assertion compares the rebuilt page's text against the source document's.
-- -----------------------------------------------------------------------------
`);
  const sectionRefById = new Map<string, string>();
  for (const section of result.pageSections) {
    sectionRefById.set(section.id, section.legacy_ref);
  }
  const orderedSections = [
    ...result.pageSections.filter((section) => section.parent_section_id === null),
    ...result.pageSections.filter((section) => section.parent_section_id !== null),
  ];
  parts.push(
    insertStatement(
      "page_sections",
      [
        "id",
        "legacy_ref",
        "page_id",
        "parent_section_id",
        "kind",
        "sort_order",
        "enabled",
        "body",
        "asset_id",
        "caption",
        "happy_verb",
        "quote_text",
        "attribution",
        "embed_url",
        "stat_number",
        "stat_caption",
        "program_title",
        "program_description",
        "half_day_price",
        "full_day_price",
        "extended_day_price",
        "session_title",
        "session_dates",
        "question",
        "answer",
        "data",
        "legacy",
      ],
      orderedSections.map((section) => [
        cesUuid("page_sections", section.legacy_ref),
        sqlText(section.legacy_ref),
        cesUuid("pages", section.page_legacy_ref),
        cesUuidOrNull(
          "page_sections",
          section.parent_section_id === null
            ? null
            : (sectionRefById.get(section.parent_section_id) ?? null),
        ),
        sqlText(section.kind),
        sqlInt(section.sort_order),
        sqlBool(section.enabled),
        section.body === null ? "null" : sqlJson(section.body),
        section.asset_id === null
          ? "null"
          : cesUuid("assets", assetLegacyRefById(result, section.asset_id)),
        sqlNullable(section.caption),
        sqlNullable(section.happy_verb),
        sqlNullable(section.quote_text),
        sqlNullable(section.attribution),
        sqlNullable(section.embed_url),
        sqlNullable(section.stat_number),
        sqlNullable(section.stat_caption),
        sqlNullable(section.program_title),
        sqlNullable(section.program_description),
        sqlNullable(section.half_day_price),
        sqlNullable(section.full_day_price),
        sqlNullable(section.extended_day_price),
        sqlNullable(section.session_title),
        sqlNullable(section.session_dates),
        sqlNullable(section.question),
        sqlNullable(section.answer),
        sqlJson(section.data),
        sqlJson(section.legacy),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "page_id",
          "parent_section_id",
          "kind",
          "sort_order",
          "enabled",
          "body",
          "asset_id",
          "caption",
          "happy_verb",
          "quote_text",
          "attribution",
          "embed_url",
          "stat_number",
          "stat_caption",
          "program_title",
          "program_description",
          "half_day_price",
          "full_day_price",
          "extended_day_price",
          "session_title",
          "session_dates",
          "question",
          "answer",
          "data",
          "legacy",
        ],
      ),
    ),
  );

  /* --- people, education, roles -------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- people — 77 rows. \`name\` is renamed from the generic handle \`title\`;
-- \`official_title\` from \`officialtitle\`; \`bio\` is a plain string because the
-- blueprint declares textarea, not bard. Email case is preserved exactly.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "people",
      [
        "id",
        "legacy_ref",
        "slug",
        "name",
        "official_title",
        "joined_ces",
        "email",
        "bio",
        "photo_asset_id",
        "published",
        "sort_order",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.people.map((person) => [
        cesUuid("people", person.legacy_ref),
        sqlText(person.legacy_ref),
        sqlText(person.slug),
        sqlText(person.name),
        sqlNullable(person.official_title),
        person.joined_ces === null ? "null" : `${sqlText(person.joined_ces)}::date`,
        sqlNullable(person.email),
        sqlNullable(person.bio),
        person.photo_asset_id === null
          ? "null"
          : cesUuid("assets", assetLegacyRefById(result, person.photo_asset_id)),
        sqlBool(person.published),
        sqlInt(person.sort_order),
        sqlJson(person.legacy),
        sqlNullable(person.source_updated_at),
        sqlNullable(person.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "slug",
          "name",
          "official_title",
          "joined_ces",
          "email",
          "bio",
          "photo_asset_id",
          "published",
          "sort_order",
          "legacy",
          "source_updated_at",
          "source_updated_by",
        ],
      ),
    ),
  );

  parts.push(`
-- person_education — 81 rows from the single \`institution\` set. Seven of those
-- sets carry no source id at all, which is why identity is derived as
-- <parent legacy_ref>:<field handle>:<ordinal> and never taken from the source.
-- One row is enabled = false, in people/jeanette-herrera.md.
`);
  parts.push(
    insertStatement(
      "person_education",
      ["id", "legacy_ref", "person_id", "institution_name", "sort_order", "enabled", "legacy"],
      result.people.flatMap((person) =>
        person.education.map((education) => [
          cesUuid("person_education", education.legacy_ref),
          sqlText(education.legacy_ref),
          cesUuid("people", person.legacy_ref),
          sqlText(education.institution_name),
          sqlInt(education.sort_order),
          sqlBool(education.enabled),
          sqlJson(education.legacy),
        ]),
      ),
      onConflictUpdate(
        ["legacy_ref"],
        ["person_id", "institution_name", "sort_order", "enabled", "legacy"],
      ),
    ),
  );

  parts.push(`
-- person_roles — a pure join table whose composite primary key is its whole
-- identity. Migration 06 enforces AT LEAST ONE ROLE PER PERSON with a deferrable
-- initially deferred constraint trigger, so these rows must land before commit —
-- which they do, because this whole file is one transaction. All 77 entries carry
-- a non-empty role list, so the load meets the invariant rather than being
-- blocked by it.
`);
  parts.push(
    insertStatement(
      "person_roles",
      ["person_id", "term_id"],
      result.people.flatMap((person) =>
        person.role_slugs.map((slug) => [
          cesUuid("people", person.legacy_ref),
          cesUuid("taxonomy_terms", slug),
        ]),
      ),
      onConflictUpdate(["person_id", "term_id"], []),
    ),
  );

  /* --- classrooms and the union -------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- classrooms — 13 rows. \`age_range\` is promoted to a column because it is the
-- value the target renders, even though the blueprint never declared it; the
-- four other undeclared keys and both halves of the teacher relation are retained
-- in \`legacy\`.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "classrooms",
      [
        "id",
        "legacy_ref",
        "slug",
        "title",
        "description",
        "age_range",
        "published",
        "sort_order",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.classrooms.map((room) => [
        cesUuid("classrooms", room.legacy_ref),
        sqlText(room.legacy_ref),
        sqlText(room.slug),
        sqlText(room.title),
        sqlNullable(room.description),
        sqlNullable(room.age_range),
        sqlBool(room.published),
        sqlInt(room.sort_order),
        sqlJson(room.legacy),
        sqlNullable(room.source_updated_at),
        sqlNullable(room.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "slug",
          "title",
          "description",
          "age_range",
          "published",
          "sort_order",
          "legacy",
          "source_updated_at",
          "source_updated_by",
        ],
      ),
    ),
  );

  parts.push(`
-- classroom_teachers — THE 41-ROW UNION. The two legacy directions disagree
-- materially: classrooms.teachers yields 32 pairs, people.classrooms yields 24,
-- and only 15 appear in both. The live site renders the REVERSE query, so
-- adopting the declared forward relation alone would silently remove 9
-- associations the site displays today, and adopting the reverse alone would
-- discard 17 the entries themselves assert. Neither is acceptable under "no
-- content is lost", so the union loads with each row tagged \`forward\`, \`reverse\`
-- or \`both\`, and the 26 one-directional pairs get a named section in the parity
-- report for the school to confirm or correct.
`);
  parts.push(
    insertStatement(
      "classroom_teachers",
      ["classroom_id", "person_id", "sort_order", "source"],
      result.classrooms.flatMap((room) =>
        room.teachers.map((teacher) => [
          cesUuid("classrooms", room.legacy_ref),
          cesUuid("people", teacher.person_legacy_ref),
          sqlInt(teacher.sort_order),
          sqlText(teacher.source),
        ]),
      ),
      onConflictUpdate(["classroom_id", "person_id"], ["sort_order", "source"]),
    ),
  );

  parts.push(`
-- page_classrooms — the ordered page->classroom relation: 12 rows from exactly
-- two pages, day-programs (7) and language-programs (5).
`);
  parts.push(
    insertStatement(
      "page_classrooms",
      ["page_id", "classroom_id", "sort_order"],
      result.pages.flatMap((page) =>
        page.classrooms.map((relation) => [
          cesUuid("pages", page.legacy_ref),
          cesUuid("classrooms", relation.classroom_legacy_ref),
          sqlInt(relation.sort_order),
        ]),
      ),
      onConflictUpdate(["page_id", "classroom_id"], ["sort_order"]),
    ),
  );

  /* --- events -------------------------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- events — 18 rows, 2 published. Times are ZONE-FREE and VERBATIM: the source
-- uses a 12-hour clock with no meridiem, so the 6:30 PM auction stores '06:30'
-- and '11:00', and a 24-hour "correction" would rewrite published event times.
-- \`calendar_link\` is preserved byte-for-byte on the four entries that carry one.
-- One \`zoom_link\` holds the prose "Zoom link to come" and migrates unchanged.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "events",
      [
        "id",
        "legacy_ref",
        "slug",
        "title",
        "event_date",
        "start_time",
        "end_time",
        "location",
        "zoom_link",
        "image_asset_id",
        "short_description",
        "details",
        "calendar_link",
        "published",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.events.map((event) => [
        cesUuid("events", event.legacy_ref),
        sqlText(event.legacy_ref),
        sqlText(event.slug),
        sqlText(event.title),
        `${sqlText(event.event_date)}::date`,
        event.start_time === null ? "null" : `${sqlText(event.start_time)}::time`,
        event.end_time === null ? "null" : `${sqlText(event.end_time)}::time`,
        sqlText(event.location),
        sqlNullable(event.zoom_link),
        event.image_asset_id === null
          ? "null"
          : cesUuid("assets", assetLegacyRefById(result, event.image_asset_id)),
        sqlText(event.short_description),
        event.details === null ? "null" : sqlJson(event.details),
        sqlNullable(event.calendar_link),
        sqlBool(event.published),
        sqlJson(event.legacy),
        sqlNullable(event.source_updated_at),
        sqlNullable(event.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "slug",
          "title",
          "event_date",
          "start_time",
          "end_time",
          "location",
          "zoom_link",
          "image_asset_id",
          "short_description",
          "details",
          "calendar_link",
          "published",
          "legacy",
          "source_updated_at",
          "source_updated_by",
        ],
      ),
    ),
  );

  /* --- promoted ------------------------------------------------------------ */
  parts.push(`
-- -----------------------------------------------------------------------------
-- promoted — 12 rows, ALL DRAFTS. image_asset_id is NOT NULL, the only mandatory
-- asset foreign key in the schema, and all 12 carry one. The carousel therefore
-- renders nothing until the school publishes: the feature is dormant by DATA, and
-- publishing any of these to make it visible would be a content change nobody
-- asked for.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "promoted",
      [
        "id",
        "legacy_ref",
        "slug",
        "title",
        "subtitle",
        "address",
        "summary",
        "event_date",
        "start_time",
        "end_time",
        "image_asset_id",
        "published",
        "sort_order",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.promoted.map((row) => [
        cesUuid("promoted", row.legacy_ref),
        sqlText(row.legacy_ref),
        sqlText(row.slug),
        sqlText(row.title),
        sqlNullable(row.subtitle),
        sqlNullable(row.address),
        sqlNullable(row.summary),
        row.event_date === null ? "null" : `${sqlText(row.event_date)}::date`,
        row.start_time === null ? "null" : `${sqlText(row.start_time)}::time`,
        row.end_time === null ? "null" : `${sqlText(row.end_time)}::time`,
        cesUuid("assets", assetLegacyRefById(result, row.image_asset_id)),
        sqlBool(row.published),
        sqlInt(row.sort_order),
        sqlJson(row.legacy),
        sqlNullable(row.source_updated_at),
        sqlNullable(row.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "slug",
          "title",
          "subtitle",
          "address",
          "summary",
          "event_date",
          "start_time",
          "end_time",
          "image_asset_id",
          "published",
          "sort_order",
          "legacy",
          "source_updated_at",
          "source_updated_by",
        ],
      ),
    ),
  );

  parts.push(`
-- promoted_links — exactly one row. Only one of the twelve entries carries an
-- \`add_link\` set, which max_sets: 1 bounds, so eleven cards render no call to
-- action. That same entry also carries an undeclared scalar \`link:\` holding the
-- identical URL: the replicator is authoritative, the scalar is retained in
-- legacy and is not rendered, and the duplication is reported.
`);
  parts.push(
    insertStatement(
      "promoted_links",
      ["id", "legacy_ref", "promoted_id", "link_title", "link_url", "sort_order", "legacy"],
      result.promoted.flatMap((row) =>
        row.links.map((link) => [
          cesUuid("promoted_links", link.legacy_ref),
          sqlText(link.legacy_ref),
          cesUuid("promoted", row.legacy_ref),
          sqlText(link.link_title),
          sqlText(link.link_url),
          sqlInt(link.sort_order),
          sqlJson(link.legacy),
        ]),
      ),
      onConflictUpdate(["legacy_ref"], ["promoted_id", "link_title", "link_url", "sort_order", "legacy"]),
    ),
  );

  /* --- announcements and quotes -------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- announcements — 4 rows, 3 drafts. link_page_id is NULLABLE for one reason: one
-- of the four source links points at an id no entry carries. That row loads with
-- a null foreign key and its raw id retained in legacy.link; a non-null column
-- would have made this single row abort the load. Titles load at FULL LENGTH —
-- all four exceed the declared limit of 30 characters.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "announcements",
      [
        "id",
        "legacy_ref",
        "slug",
        "title",
        "link_page_id",
        "feature_on_homepage",
        "published",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.announcements.map((row) => [
        cesUuid("announcements", row.legacy_ref),
        sqlText(row.legacy_ref),
        sqlText(row.slug),
        sqlText(row.title),
        row.link_page_id === null
          ? "null"
          : cesUuid("pages", pageLegacyRefById(result, row.link_page_id)),
        sqlBool(row.feature_on_homepage),
        sqlBool(row.published),
        sqlJson(row.legacy),
        sqlNullable(row.source_updated_at),
        sqlNullable(row.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        [
          "slug",
          "title",
          "link_page_id",
          "feature_on_homepage",
          "published",
          "legacy",
          "source_updated_at",
          "source_updated_by",
        ],
      ),
    ),
  );

  parts.push(`
-- inspiring_quotes — 5 rows, ALL PUBLISHED. This collection carries zero
-- \`published:\` keys, which is the clearest demonstration of why absence must read
-- as published: the inverse reading would silently draft all five. \`quote\` is
-- renamed from the handle \`title\`.
`);
  parts.push(
    insertStatement(
      "inspiring_quotes",
      [
        "id",
        "legacy_ref",
        "slug",
        "quote",
        "attribution",
        "published",
        "legacy",
        "source_updated_at",
        "source_updated_by",
      ],
      result.inspiringQuotes.map((row) => [
        cesUuid("inspiring_quotes", row.legacy_ref),
        sqlText(row.legacy_ref),
        sqlText(row.slug),
        sqlText(row.quote),
        sqlNullable(row.attribution),
        sqlBool(row.published),
        sqlJson(row.legacy),
        sqlNullable(row.source_updated_at),
        sqlNullable(row.source_updated_by),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        ["slug", "quote", "attribution", "published", "legacy", "source_updated_at", "source_updated_by"],
      ),
    ),
  );

  /* --- site_globals -------------------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- site_globals — the closed 26-key set. UPSERT ON KEY, and that is required
-- rather than defensive: MIGRATION 11 SEEDS ALL 26 ROWS ITSELF with
-- \`on conflict (key) do nothing\`, so a plain insert here would fail on a unique
-- violation the first time anyone ran \`db reset\`. This statement also fills the
-- one row that migration provably cannot — \`logo\`, whose asset foreign key needs
-- public.assets to be populated, which happens above.
-- \`donate_url\` is ROOT-RELATIVE BY DESIGN and must not be "normalized" to an
-- absolute URL; \`family_portal_url\` ships UNCONFIRMED, with the flag inside
-- \`value\` so it cannot be separated from the URL.
-- -----------------------------------------------------------------------------
`);
  parts.push(
    insertStatement(
      "site_globals",
      ["id", "key", "value", "asset_id", "label", '"group"', "public", "sort_order"],
      result.siteGlobals.map((row) => [
        cesUuid("site_globals", row.key),
        sqlText(row.key),
        row.value === null ? "null" : sqlJson(row.value),
        row.asset_id === null
          ? "null"
          : cesUuid("assets", assetLegacyRefById(result, row.asset_id)),
        sqlNullable(row.label),
        sqlText(row.group),
        sqlBool(row.public),
        sqlInt(row.sort_order),
      ]),
      onConflictUpdate(["key"], ["value", "asset_id", "label", '"group"', "public", "sort_order"]),
    ),
  );

  /* --- nav_items ----------------------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- nav_items — the 38-row designed menu. Migration 12 creates the table and
-- inserts NOTHING, so this is the whole seed: label-only group headers first,
-- then the 35 item rows.
-- Row order matters for the self-referencing parent_id, and the ids are derived
-- so a child can name its parent without a lookup. Donate is a child of Giving in
-- the MENU while its page keeps the path /donate — the same grouping through
-- pages.parent_id would have rewritten the URL to /giving/donate.
-- Three rows are invisible: the two whose target page is a draft, and the Header
-- Actions group, which must never render as a menu entry.
-- -----------------------------------------------------------------------------
`);
  const orderedNav = [
    ...result.navItems.filter((row) => row.parent_id === null),
    ...result.navItems.filter((row) => row.parent_id !== null),
  ];
  parts.push(
    insertStatement(
      "nav_items",
      [
        "id",
        "legacy_ref",
        "parent_id",
        "label",
        "target_page_id",
        "external_url",
        "audience",
        "sort_order",
        "visible",
      ],
      orderedNav.map((row) => [
        cesUuid("nav_items", row.legacy_ref),
        sqlText(row.legacy_ref),
        cesUuidOrNull("nav_items", row.parent_legacy_ref),
        sqlText(row.label),
        row.target_page_path === null
          ? "null"
          : cesUuid("pages", pageLegacyRefByPath(result, row.target_page_path)),
        sqlNullable(row.external_url),
        sqlText(row.audience),
        sqlInt(row.sort_order),
        sqlBool(row.visible),
      ]),
      onConflictUpdate(
        ["legacy_ref"],
        ["parent_id", "label", "target_page_id", "external_url", "audience", "sort_order", "visible"],
      ),
    ),
  );

  /* --- the terminal assertions --------------------------------------------- */
  parts.push(`
-- -----------------------------------------------------------------------------
-- Terminal assertions, INSIDE THIS TRANSACTION.
--
-- These are the one-row-per-path guarantee and the nav invariants, checked before
-- commit so a violation rolls the whole load back rather than leaving a database
-- that resolves a URL to two different rows. content_routes is a \`union all\` and
-- deliberately does NOT deduplicate, precisely so this check can see a collision.
--
-- All 142 paths are unique in the corpus today, but nothing in the flat files
-- enforced that: /programs/{slug} is claimed by the umbrella pages AND by
-- classroom entries, and /community/{slug} by landing pages AND by 77 staff bios.
-- -----------------------------------------------------------------------------

do $seed$
declare
  duplicate_path text;
  duplicate_count integer;
  actual integer;
begin
  select path, count(*)
    into duplicate_path, duplicate_count
    from public.content_routes
   group by path
  having count(*) > 1
   limit 1;

  if duplicate_path is not null then
    raise exception
      'content path % resolves to % rows. Two collections claim one URL; the load is rolled back.',
      duplicate_path, duplicate_count;
  end if;

  select count(*) into actual from public.content_routes;
  if actual <> ${sqlInt(result.routes.length)} then
    raise exception 'expected ${sqlInt(result.routes.length)} content routes, found %.', actual;
  end if;

  select count(*) into actual from public.nav_items;
  if actual <> ${sqlInt(result.navItems.length)} then
    raise exception 'expected ${sqlInt(result.navItems.length)} nav_items rows, found %.', actual;
  end if;

  select count(*) into actual from public.nav_items where parent_id is null;
  if actual <> 3 then
    raise exception 'expected 3 nav_items roots, found %.', actual;
  end if;

  select count(*) into actual
    from public.nav_items
   where target_page_id is null and external_url is null;
  if actual <> 3 then
    raise exception
      'expected exactly the 3 group headers to lack a target, found % rows without one.', actual;
  end if;

  select count(*) into actual from public.nav_items where visible = false;
  if actual <> 3 then
    raise exception 'expected 3 invisible nav_items rows, found %.', actual;
  end if;

  select count(*) into actual from public.nav_items where legacy_ref = 'nav:header-actions';
  if actual <> 1 then
    raise exception
      'the contractual nav:header-actions row is missing; SiteHeader resolves the two header calls to action by that literal string.';
  end if;

  select count(*) into actual from public.site_globals;
  if actual <> ${sqlInt(result.siteGlobals.length)} then
    raise exception 'expected ${sqlInt(result.siteGlobals.length)} site_globals rows, found %.', actual;
  end if;

  select count(*) into actual
    from public.people p
   where not exists (select 1 from public.person_roles r where r.person_id = p.id);
  if actual <> 0 then
    raise exception '% people carry no role; migration 06 requires at least one.', actual;
  end if;

  select count(*) into actual from public.assets where legacy_ref is not null;
  if actual <> ${sqlInt(result.assets.length)} then
    raise exception 'expected ${sqlInt(result.assets.length)} migrated asset rows, found %.', actual;
  end if;
end
$seed$;

commit;
`);

  return parts.join("");
};

/** Resolve an asset row id back to its legacy_ref, for the SQL id expression. */
const assetLegacyRefById = (result: ExtractionResult, id: string): string => {
  const found = result.assets.find((asset) => asset.id === id);
  if (found === undefined) {
    throw new ExtractionError(`No asset row carries id ${id}.`);
  }
  return found.legacy_ref;
};

const pageLegacyRefById = (result: ExtractionResult, id: string): string => {
  const found = result.pages.find((page) => page.id === id);
  if (found === undefined) {
    throw new ExtractionError(`No page row carries id ${id}.`);
  }
  return found.legacy_ref;
};

const pageLegacyRefByPath = (result: ExtractionResult, path: string): string => {
  const found = result.pages.find((page) => page.path === path);
  if (found === undefined) {
    throw new ExtractionError(`No page row carries path ${path}.`);
  }
  return found.legacy_ref;
};


/* ==========================================================================
 * 19. The emitters
 * --------------------------------------------------------------------------
 * Every output is deterministic and stable-ordered with a trailing newline, so a
 * re-run against the same commit is BYTE-IDENTICAL and a real change is the only
 * thing a diff shows. Two mechanisms get that:
 *
 *   - the row files carry NO timestamp at all. They are a pure function of the
 *     source, which is what lets `verify-parity.ts` treat them as evidence.
 *   - the three files that legitimately carry `generated_at` reuse the previous
 *     value when nothing else changed, so the stamp means "when this content was
 *     first generated" — the more useful reading anyway.
 *
 * `migration-source-manifest.json` is deliberately timestamp-free as well,
 * because `meta.json` records its SHA-256 and a stamp that moved on every run
 * would make that checksum meaningless. The delta report against a previous
 * manifest goes to STDOUT and never into the file, for the same reason.
 *
 * `meta.json` is written LAST, hashing the bytes of the source manifest as they
 * were actually written rather than a serialization of the same value — those two
 * are equal here, and depending on that equality is how a checksum silently stops
 * matching the file it names.
 * ========================================================================== */

/** The envelope every fallback row file carries. */
export interface FallbackTable<T> {
  /** The Postgres table these rows load into. Underscored, as the table is. */
  readonly table: string;
  readonly count: number;
  readonly rows: readonly T[];
}

/**
 * The stamp. `SOURCE_DATE_EPOCH` is honoured for a reproducible build; otherwise
 * the clock is used, and the writer keeps the previous value when nothing else
 * changed. Mirrors `build-asset-manifest.ts` so the two programs' artifacts agree
 * about what a timestamp in this repository means.
 */
const resolveGeneratedAt = (): string => {
  const epoch = process.env["SOURCE_DATE_EPOCH"]?.trim();
  if (epoch !== undefined && /^\d+$/.test(epoch)) {
    return new Date(Number(epoch) * 1000).toISOString();
  }
  return new Date().toISOString();
};

const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface WriteOutcome {
  readonly path: string;
  readonly bytes: number;
  readonly identical: boolean;
}

/** Write a file, reporting whether the bytes are unchanged from the previous run. */
const writeOutput = async (absPath: string, text: string): Promise<WriteOutcome> => {
  const previous = await readTextIfExists(absPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, text, "utf8");
  return {
    path: absPath,
    bytes: Buffer.byteLength(text, "utf8"),
    identical: previous === text,
  };
};

/**
 * Write a JSON file whose payload carries a `generated_at` field, reusing the
 * previous stamp when the rest of the content is unchanged.
 *
 * The payload must already carry `generated_at` in its intended position with any
 * value; re-assigning an existing key leaves its position alone, which is what
 * keeps the emitted key order fixed.
 */
const writeStampedJson = async (
  absPath: string,
  payload: Record<string, unknown>,
  now: string,
): Promise<WriteOutcome> => {
  const withNow = serializeJson({ ...payload, generated_at: now });

  const previous = await readTextIfExists(absPath);
  if (previous !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(previous);
    } catch {
      parsed = null;
    }
    const previousStamp = isRecord(parsed) ? asString(parsed["generated_at"]) : null;
    if (previousStamp !== null) {
      const rebased = serializeJson({ ...payload, generated_at: previousStamp });
      if (rebased === previous) {
        return writeOutput(absPath, rebased);
      }
    }
  }

  return writeOutput(absPath, withNow);
};

/** Write one fallback row file. No timestamp: a pure function of the source. */
const writeFallbackTable = async <T>(
  outRoot: string,
  fileName: string,
  table: string,
  rows: readonly T[],
): Promise<WriteOutcome> => {
  const payload: FallbackTable<T> = { table, count: rows.length, rows };
  return writeOutput(join(outRoot, FALLBACK_DIR, fileName), serializeJson(payload));
};

/** The source manifest: the handoff that outlives `content/`. */
const buildSourceManifest = (
  context: Context,
  sourceCommit: string | null,
): Record<string, unknown> => {
  const files = [...context.files.values()]
    .map((record) => ({
      path: record.path,
      sha256: record.sha256,
      role: record.role,
      collection: record.collection,
      slug: record.slug,
      keys: [...record.keys],
      target_table: record.target_table,
      legacy_ref: record.legacy_ref,
      route: record.route,
      published: record.published,
      relations: record.relations,
      asset_references: [...record.asset_references],
      notes: [...record.notes],
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  return {
    generator: GENERATOR,
    schema_version: SCHEMA_VERSION,
    source_commit: sourceCommit,
    note:
      "The handoff. Per consumed source file: its SHA-256, the keys it yielded, the target " +
      "table and legacy_ref it produced, the route and publish status, its relations and its " +
      "asset references. This is verify-parity.ts's AUTHORITY, which is what lets parity run " +
      "again after content/ has been deleted — at that point the flat files are gone and this " +
      "record is the only statement of which source file produced which row. It carries no " +
      "timestamp on purpose: meta.json records its checksum, and a stamp that moved on every " +
      "run would make that checksum meaningless.",
    counts: {
      files: files.length,
      by_role: tally(files, (file) => file.role),
      by_collection: tally(
        files.filter((file) => file.collection !== null),
        (file) => file.collection ?? "",
      ),
    },
    files,
  };
};

/** Per-file delta against a previously written manifest, for a re-run. */
const reportSourceDelta = (previousRaw: string | null, current: Record<string, unknown>): void => {
  if (previousRaw === null) {
    return;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(previousRaw);
  } catch {
    console.log("  source delta: the previous manifest could not be parsed; skipping the delta.");
    return;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["files"])) {
    return;
  }

  const previousHashes = new Map<string, string>();
  for (const file of parsed["files"]) {
    if (isRecord(file)) {
      const path = asString(file["path"]);
      const hash = asString(file["sha256"]);
      if (path !== null && hash !== null) {
        previousHashes.set(path, hash);
      }
    }
  }

  const currentFiles = Array.isArray(current["files"]) ? current["files"] : [];
  const currentHashes = new Map<string, string>();
  for (const file of currentFiles) {
    if (isRecord(file)) {
      const path = asString(file["path"]);
      const hash = asString(file["sha256"]);
      if (path !== null && hash !== null) {
        currentHashes.set(path, hash);
      }
    }
  }

  const added = [...currentHashes.keys()].filter((path) => !previousHashes.has(path)).sort();
  const removed = [...previousHashes.keys()].filter((path) => !currentHashes.has(path)).sort();
  const changed = [...currentHashes.entries()]
    .filter(([path, hash]) => {
      const before = previousHashes.get(path);
      return before !== undefined && before !== hash;
    })
    .map(([path]) => path)
    .sort();

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log("  source delta: no source file changed since the previous manifest.");
    return;
  }
  console.log(
    `  source delta: ${String(added.length)} added, ${String(removed.length)} removed, ` +
      `${String(changed.length)} changed since the previous manifest.`,
  );
  for (const path of changed) {
    console.log(`    changed  ${path}`);
  }
  for (const path of added) {
    console.log(`    added    ${path}`);
  }
  for (const path of removed) {
    console.log(`    removed  ${path}`);
  }
};

const buildIntegrityRegister = (context: Context): IntegrityRegister => ({
  stale_parent_references: context.integrity.staleParents.map((record) => ({ ...record })),
  dangling_announcement_links: context.integrity.danglingAnnouncementLinks.map((record) => ({
    ...record,
  })),
  missing_required_fields: context.integrity.missingRequiredFields.map((record) => ({
    ...record,
    missing: [...record.missing],
  })),
  promoted_link_duplication: context.integrity.promotedLinkDuplication.map((record) => ({
    ...record,
  })),
  grandfathered_over_length: context.integrity.grandfathered.map((record) => ({ ...record })),
});

const buildCounts = (result: ExtractionResult): FallbackCounts => {
  const entries: Record<string, number> = {};
  for (const collection of COLLECTIONS) {
    entries[collection] = (result.entriesByCollection.get(collection) ?? []).length;
  }
  return {
    entries,
    taxonomy_terms: result.taxonomyTerms.length,
    assets: result.assets.length,
    pages: result.pages.length,
    page_sections: result.pageSections.length,
    page_classrooms: result.pages.reduce((sum, page) => sum + page.classrooms.length, 0),
    people: result.people.length,
    person_education: result.people.reduce((sum, person) => sum + person.education.length, 0),
    person_roles: result.people.reduce((sum, person) => sum + person.role_term_ids.length, 0),
    events: result.events.length,
    classrooms: result.classrooms.length,
    classroom_teachers: result.classrooms.reduce((sum, room) => sum + room.teachers.length, 0),
    promoted: result.promoted.length,
    promoted_links: result.promoted.reduce((sum, row) => sum + row.links.length, 0),
    announcements: result.announcements.length,
    inspiring_quotes: result.inspiringQuotes.length,
    site_globals: result.siteGlobals.length,
    nav_items: result.navItems.length,
    routes: result.routes.length,
  };
};

/**
 * Write all eighteen outputs.
 *
 * The order is not cosmetic: the source manifest is written before `meta.json`,
 * which hashes the bytes that landed on disk.
 */
const emitOutputs = async (
  result: ExtractionResult,
  options: Options,
  census: Record<string, unknown>,
): Promise<readonly WriteOutcome[]> => {
  const now = resolveGeneratedAt();
  const counts = buildCounts(result);
  const written: WriteOutcome[] = [];

  // -- the thirteen row files ------------------------------------------------
  written.push(
    await writeFallbackTable(options.outRoot, "taxonomy-terms.json", "taxonomy_terms", result.taxonomyTerms),
    await writeFallbackTable(options.outRoot, "assets.json", "assets", result.assets),
    await writeFallbackTable(options.outRoot, "site-globals.json", "site_globals", result.siteGlobals),
    await writeFallbackTable(options.outRoot, "pages.json", "pages", result.pages),
    await writeFallbackTable(options.outRoot, "page-sections.json", "page_sections", result.pageSections),
    await writeFallbackTable(options.outRoot, "people.json", "people", result.people),
    await writeFallbackTable(options.outRoot, "events.json", "events", result.events),
    await writeFallbackTable(options.outRoot, "classrooms.json", "classrooms", result.classrooms),
    await writeFallbackTable(options.outRoot, "promoted.json", "promoted", result.promoted),
    await writeFallbackTable(options.outRoot, "announcements.json", "announcements", result.announcements),
    await writeFallbackTable(
      options.outRoot,
      "inspiring-quotes.json",
      "inspiring_quotes",
      result.inspiringQuotes,
    ),
    await writeFallbackTable(options.outRoot, "nav-items.json", "nav_items", result.navItems),
    await writeFallbackTable(options.outRoot, "routes.json", "content_routes", result.routes),
  );

  // -- the database load ----------------------------------------------------
  written.push(
    await writeOutput(join(options.outRoot, SEED_PATH), buildSeedSql(result, counts)),
  );

  // -- the artifacts --------------------------------------------------------
  written.push(
    await writeStampedJson(
      join(options.outRoot, ARTIFACT_DIR, "route-manifest.json"),
      buildRouteManifest(result, result.sourceCommit),
      now,
    ),
    await writeStampedJson(
      join(options.outRoot, ARTIFACT_DIR, "corpus-census.json"),
      census,
      now,
    ),
  );

  const sourceManifestPath = join(options.outRoot, ARTIFACT_DIR, "migration-source-manifest.json");
  const previousManifest = await readTextIfExists(sourceManifestPath);
  const sourceManifest = buildSourceManifest(result.context, result.sourceCommit);
  reportSourceDelta(previousManifest, sourceManifest);
  const sourceManifestText = serializeJson(sourceManifest);
  written.push(await writeOutput(sourceManifestPath, sourceManifestText));

  // -- meta.json, LAST ------------------------------------------------------
  const meta: FallbackMeta = {
    schema_version: SCHEMA_VERSION,
    source_commit: result.sourceCommit,
    produced_by: "extract",
    // Replaced by the writer, which reuses the previous stamp when nothing else
    // changed. Declared here so the key holds its position in the emitted file.
    generated_at: now,
    generator: GENERATOR,
    source_manifest_checksum: sha256(sourceManifestText),
    identity: {
      uuid_namespace: CES_UUID_NAMESPACE,
      entity_rule: "uuidv5(uuid_namespace, '<table>:<legacy_ref>')",
      child_rule: "<parent legacy_ref>:<field handle>:<ordinal in source order>",
    },
    counts,
    integrity: buildIntegrityRegister(result.context),
  };
  written.push(
    await writeStampedJson(
      join(options.outRoot, FALLBACK_DIR, "meta.json"),
      meta as unknown as Record<string, unknown>,
      now,
    ),
  );

  return written;
};

/* ==========================================================================
 * 20. The summary
 * ========================================================================== */

const relativeTo = (root: string, absPath: string): string =>
  absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : absPath;

const printSummary = (
  result: ExtractionResult,
  options: Options,
  written: readonly WriteOutcome[],
  mismatches: readonly CensusMismatch[],
): void => {
  const counts = buildCounts(result);
  const integrity = result.context.integrity;

  console.log("");
  console.log("  corpus");
  console.log(
    `    entries              ${String(
      Object.values(counts.entries).reduce((sum, value) => sum + value, 0),
    )}  (${COLLECTIONS.map((name) => `${name} ${String(counts.entries[name] ?? 0)}`).join(", ")})`,
  );
  const drafts = COLLECTIONS.reduce(
    (sum, collection) =>
      sum +
      (result.entriesByCollection.get(collection) ?? []).filter((entry) => !isPublished(entry.data))
        .length,
    0,
  );
  console.log(`    draft flags          ${String(drafts)}`);
  console.log(
    `    content paths        ${String(counts.routes)}  (${String(
      result.routes.filter((route) => route.published).length,
    )} resolve, ${String(result.routes.filter((route) => !route.published).length)} draft)`,
  );
  console.log(`    page_sections        ${String(counts.page_sections)}`);
  console.log(`    classroom_teachers   ${String(counts.classroom_teachers)}  (union of 32 forward and 24 reverse)`);
  console.log(`    site_globals         ${String(counts.site_globals)}`);
  console.log(`    nav_items            ${String(counts.nav_items)}`);
  console.log(`    assets               ${String(counts.assets)}`);

  console.log("");
  console.log("  integrity — preserved and reported, never repaired");
  console.log(`    stale parent ids            ${String(integrity.staleParents.length)}`);
  console.log(`    dangling announcement link  ${String(integrity.danglingAnnouncementLinks.length)}`);
  console.log(`    missing required fields     ${String(integrity.missingRequiredFields.length)}`);
  console.log(`    promoted link duplication   ${String(integrity.promotedLinkDuplication.length)}`);
  console.log(`    grandfathered over-length   ${String(integrity.grandfathered.length)}`);
  console.log(`    disabled nested records     ${String(integrity.disabledRecords.length)}`);

  if (result.context.linkRecords.length > 0) {
    console.log("");
    console.log(`  link transformations (${String(result.context.linkRecords.length)})`);
    for (const record of result.context.linkRecords) {
      console.log(`    ${record.kind}  ${record.source_file}`);
      console.log(`      ${record.from}  ->  ${record.to}`);
    }
  }

  if (mismatches.length > 0) {
    console.log("");
    console.log(`  census drift (${String(mismatches.length)}), waived by --allow-census-drift`);
    for (const mismatch of mismatches) {
      console.log(
        `    ${mismatch.key}: expected ${String(mismatch.expected)}, measured ${
          mismatch.actual === null ? "absent" : String(mismatch.actual)
        }`,
      );
    }
  }

  if (result.context.notes.length > 0) {
    console.log("");
    console.log(`  notes (${String(result.context.notes.length)})`);
    for (const note of result.context.notes) {
      console.log(`    - ${note}`);
    }
  }

  console.log("");
  console.log(`  wrote ${String(written.length)} files under ${options.outRoot}`);
  const unchanged = written.filter((outcome) => outcome.identical).length;
  for (const outcome of written) {
    console.log(
      `    ${relativeTo(options.outRoot, outcome.path)}  (${String(outcome.bytes)} bytes)${
        outcome.identical ? "  unchanged" : ""
      }`,
    );
  }
  console.log(
    `  ${String(unchanged)} of ${String(written.length)} byte-identical to the previous run.`,
  );
  console.log("");
};

/* ==========================================================================
 * 21. main
 * --------------------------------------------------------------------------
 * The only side effects in this module, and the reason everything above is a
 * declaration. The order below is forced rather than chosen:
 *
 *   1. the asset manifest first, because a content field that names a binary the
 *      manifest does not carry is a fatal error and must be caught before any
 *      row is built;
 *   2. the tree and every routable path SECOND, because `statamic://entry::<uuid>`
 *      resolution needs the id -> path index and it is applied during rich-text
 *      import, which happens while pages are built;
 *   3. pages before `site_globals`, because the family portal URL is recovered
 *      from a link mark inside a disabled block in `deposits.md` and only exists
 *      once that document has been imported;
 *   4. pages before `nav_items`, which resolves all 35 targets by path;
 *   5. the census last, so it describes the traversal that actually happened.
 * ========================================================================== */

/** A message from anything a `catch` can receive, without assuming it is an Error. */
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
};

/** Read a collection out of the parsed map, or fail: an empty collection is a bug. */
const collectionEntries = (
  entries: ReadonlyMap<CollectionName, readonly SourceEntry[]>,
  collection: CollectionName,
): readonly SourceEntry[] => {
  const list = entries.get(collection);
  if (list === undefined || list.length === 0) {
    throw new ExtractionError(
      `content/collections/${collection} yielded no entries. Either --source does not name a ` +
        `complete Statamic checkout, or the collection was emptied — and an empty snapshot ` +
        `written over a good one is the failure this refuses to commit.`,
    );
  }
  return list;
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const parsed = parseOptions(argv);
  if (parsed === "help") {
    console.log(USAGE);
    return;
  }
  const options = parsed;

  // The likeliest mistake is pointing --source at this repository, where the
  // legacy tree no longer exists, so it is refused with the recipe rather than
  // producing an empty snapshot.
  if (!(await isDirectory(options.sourceRoot))) {
    throw new UsageError(
      `--source ${options.sourceRoot} is not a directory. tools/README.md §2.2 gives both ` +
        `recipes for materializing a legacy revision.`,
    );
  }
  if (!(await isDirectory(join(options.sourceRoot, "content")))) {
    throw new UsageError(
      `--source ${options.sourceRoot} contains no content/ directory, so it is not the root ` +
        `of a Statamic checkout. This repository itself no longer has one: the migration ` +
        `deleted it, which is exactly why --source has no default. See tools/README.md §2.2.`,
    );
  }

  console.log("");
  console.log(`  ${GENERATOR}`);
  console.log(`    source     ${options.sourceRoot}`);
  console.log(`    out        ${options.outRoot}`);
  console.log(`    manifest   ${options.manifestPath}`);

  const notes: string[] = [];

  /* -- 1. the asset manifest ---------------------------------------------- */
  const manifest = await loadAssetManifest(options.manifestPath);
  const assets = buildAssetIndex(manifest);
  const context = createContext(options.sourceRoot, assets, notes);

  const sourceCommit =
    options.sourceCommitOverride ?? (await readSourceCommit(options.sourceRoot, notes));
  if (
    sourceCommit !== null &&
    manifest.source_commit !== null &&
    !manifest.source_commit.startsWith(sourceCommit) &&
    !sourceCommit.startsWith(manifest.source_commit)
  ) {
    // Not fatal, because a manifest regenerated at a different commit is a
    // legitimate intermediate state during a re-run — but it is exactly the
    // condition under which an asset class or a normalized filename can be
    // stale, so it is said out loud.
    notes.push(
      `the asset manifest was built at ${manifest.source_commit} while this run reads ` +
        `${sourceCommit}. Asset classes and normalized paths come from the manifest and are ` +
        `not re-derived, so regenerate it against this checkout before trusting the output.`,
    );
  }

  /* -- 2. parse every entry ----------------------------------------------- */
  const entriesByCollection = new Map<CollectionName, readonly SourceEntry[]>();
  for (const collection of COLLECTIONS) {
    const fileNames = await listEntryFiles(options.sourceRoot, collection);
    const list: SourceEntry[] = [];
    for (const fileName of fileNames) {
      list.push(await parseEntry(options.sourceRoot, collection, fileName));
    }
    entriesByCollection.set(collection, list);
  }

  const pageEntries = collectionEntries(entriesByCollection, "pages");
  const peopleEntries = collectionEntries(entriesByCollection, "people");
  const eventEntries = collectionEntries(entriesByCollection, "events");
  const classroomEntries = collectionEntries(entriesByCollection, "classrooms");
  const promotedEntries = collectionEntries(entriesByCollection, "promoted");
  const announcementEntries = collectionEntries(entriesByCollection, "announcements");
  const quoteEntries = collectionEntries(entriesByCollection, "inspiring_quotes");

  /* -- 3. the tree, the paths, and the stale-parent register --------------- */
  const treePath = "content/trees/collections/pages.yaml";
  const tree = await parseYamlFile(options.sourceRoot, treePath);
  const treeFile = registerFile(context, treePath, tree.sha256, "tree");
  treeFile.target_table = "pages";
  treeFile.notes.push(
    "authoritative for parent_id, sort_order and the materialized path; its first root is " +
      "the literal string `home` rather than a uuid",
  );
  const positions = flattenTree(tree.value, treePath);

  const pageEntryByRef = new Map<string, SourceEntry>();
  for (const entry of pageEntries) {
    const ref = legacyRefOf(entry);
    if (pageEntryByRef.has(ref)) {
      throw new ExtractionError(`Two page entries carry the id ${ref}.`);
    }
    pageEntryByRef.set(ref, entry);
  }

  // Every page must appear in the tree exactly once, and the tree must name no
  // page that does not exist. Either failure would silently drop a URL: a page
  // absent from the tree has no path at all, and a tree node with no entry means
  // the corpus and its structure have diverged.
  if (positions.length !== pageEntries.length) {
    throw new ExtractionError(
      `${treePath} names ${String(positions.length)} pages but content/collections/pages ` +
        `holds ${String(pageEntries.length)}. Every page must appear in the tree exactly ` +
        `once: a page the tree omits has no path, and a path is what may not change.`,
    );
  }
  const seenInTree = new Set<string>();
  for (const position of positions) {
    if (seenInTree.has(position.entryId)) {
      throw new ExtractionError(`${treePath} names ${position.entryId} more than once.`);
    }
    seenInTree.add(position.entryId);
    if (!pageEntryByRef.has(position.entryId)) {
      throw new ExtractionError(
        `${treePath} names entry ${position.entryId}, which no page in ` +
          `content/collections/pages carries.`,
      );
    }
    if (position.depth > 1) {
      throw new ExtractionError(
        `${treePath}: ${position.entryId} sits at depth ${String(position.depth)}. ` +
          `content/collections/pages.yaml declares max_depth: 2, so a deeper node means the ` +
          `tree and the collection config disagree.`,
      );
    }
  }

  interface PagePosition {
    readonly parentLegacyRef: string | null;
    readonly path: string;
    readonly sortOrder: number;
    readonly depth: number;
  }
  const positionByRef = new Map<string, PagePosition>();
  for (const position of positions) {
    const entry = pageEntryByRef.get(position.entryId);
    if (entry === undefined) {
      throw new ExtractionError(`${treePath} names entry ${position.entryId}, which is absent.`);
    }
    let parentPath: string | null = null;
    if (position.parentEntryId !== null) {
      const resolved = positionByRef.get(position.parentEntryId);
      if (resolved === undefined) {
        // flattenTree emits parents before children, so this cannot happen unless
        // that guarantee is broken — which is worth saying rather than papering
        // over with a fallback path.
        throw new ExtractionError(
          `${treePath}: ${position.entryId} was reached before its parent ` +
            `${position.parentEntryId}, so its path cannot be materialized.`,
        );
      }
      parentPath = resolved.path;
    }
    const path = materializePath(parentPath, entry.slug, position.entryId === HOME_ENTRY_ID);
    positionByRef.set(position.entryId, {
      parentLegacyRef: position.parentEntryId,
      path,
      sortOrder: position.sortOrder,
      depth: position.depth,
    });
    context.pathsByEntryId.set(position.entryId, path);
  }

  // The four stale `parent:` keys. The tree already decided the hierarchy; this
  // records the disagreement rather than acting on it.
  for (const position of positions) {
    const entry = pageEntryByRef.get(position.entryId);
    const resolved = positionByRef.get(position.entryId);
    if (entry === undefined || resolved === undefined) {
      continue;
    }
    const rawParent = asString(entry.data["parent"]);
    if (rawParent === null || pageEntryByRef.has(rawParent)) {
      continue;
    }
    const effectiveParent =
      resolved.parentLegacyRef === null
        ? null
        : (pageEntryByRef.get(resolved.parentLegacyRef)?.slug ?? null);
    context.integrity.staleParents.push({
      slug: entry.slug,
      source_file: entry.sourceFile,
      raw_parent: rawParent,
      effective_parent_slug: effectiveParent,
    });
  }

  // The other three routable collections, so an internal-scheme link can name any
  // entry rather than only a page. Both records in the corpus target pages; the
  // index is general because the next one need not.
  for (const entry of peopleEntries) {
    context.pathsByEntryId.set(legacyRefOf(entry), `${ROUTE_PREFIXES.people}${entry.slug}`);
  }
  for (const entry of eventEntries) {
    context.pathsByEntryId.set(legacyRefOf(entry), `${ROUTE_PREFIXES.events}${entry.slug}`);
  }
  for (const entry of classroomEntries) {
    context.pathsByEntryId.set(legacyRefOf(entry), `${ROUTE_PREFIXES.classrooms}${entry.slug}`);
  }

  /* -- 4. the promoted values that live in templates ---------------------- */
  const templateCopy = await readTemplateCopy(context);

  /* -- 5. taxonomy, then people's roles ----------------------------------- */
  const taxonomyTerms = await buildTaxonomyTerms(context);
  const termIdsBySlug = new Map<string, string>(
    taxonomyTerms.map((term) => [term.slug, term.id] as const),
  );

  /* -- 6. pages, in tree order -------------------------------------------- */
  const pages: PageRow[] = [];
  const pageSections: PageSectionRow[] = [];
  for (const position of positions) {
    const entry = pageEntryByRef.get(position.entryId);
    const resolved = positionByRef.get(position.entryId);
    if (entry === undefined || resolved === undefined) {
      throw new ExtractionError(`${treePath}: ${position.entryId} could not be resolved.`);
    }
    // `show_in_nav` is true for the nine roots and for every PUBLISHED child.
    // Seeding it from the undeclared `include` key alone would be wrong in both
    // directions: `include` is present on nine entries and false on donate, which
    // does appear in the designed menu.
    const showInNav = resolved.depth === 0 || isPublished(entry.data);
    const build = buildPage(context, entry, resolved, showInNav, templateCopy);
    pages.push(build.row);
    pageSections.push(...build.sections);
  }

  /* -- 7. the other six collections --------------------------------------- */
  const people = peopleEntries.map((entry, index) =>
    buildPerson(context, entry, index + 1, termIdsBySlug),
  );
  const events = eventEntries.map((entry) => buildEvent(context, entry));

  const classroomUnion = reconcileClassroomTeachers(classroomEntries, peopleEntries);
  const classrooms = classroomEntries.map((entry, index) => {
    const row = buildClassroom(context, entry, index + 1);
    return { ...row, teachers: classroomUnion.rowsByClassroom.get(row.legacy_ref) ?? [] };
  });

  const promoted = promotedEntries.map((entry, index) => buildPromoted(context, entry, index + 1));

  const pageIdsByEntryId = new Map<string, string>(
    pages.map((page) => [page.legacy_ref, page.id] as const),
  );
  const announcements = announcementEntries.map((entry) =>
    buildAnnouncement(context, entry, context.pathsByEntryId, pageIdsByEntryId),
  );
  const inspiringQuotes = quoteEntries.map((entry) => buildQuote(context, entry));

  /* -- 8. referential integrity across collections ------------------------ */
  // `page_classrooms` is built while a page is read, before the classrooms exist
  // as rows, so its targets are checked here. An unresolved reference would load
  // as a foreign key violation, which is a far worse place to discover it.
  const classroomRefs = new Set(classrooms.map((room) => room.legacy_ref));
  for (const page of pages) {
    for (const relation of page.classrooms) {
      if (!classroomRefs.has(relation.classroom_legacy_ref)) {
        throw new ExtractionError(
          `${page.path}: its \`classrooms\` list names ${relation.classroom_legacy_ref}, which ` +
            `no classroom entry carries.`,
        );
      }
    }
  }
  const personRefs = new Set(people.map((person) => person.legacy_ref));
  for (const room of classrooms) {
    for (const teacher of room.teachers) {
      if (!personRefs.has(teacher.person_legacy_ref)) {
        throw new ExtractionError(
          `/programs/${room.slug}: a teacher relation names ${teacher.person_legacy_ref}, which ` +
            `no person entry carries.`,
        );
      }
    }
  }
  // Migration 06 requires at least one role per person, through a deferrable
  // constraint trigger — so a person with none aborts the load AT COMMIT, after
  // every statement has succeeded. Catching it here names the file instead.
  const roleless = people.filter((person) => person.role_term_ids.length === 0);
  if (roleless.length > 0) {
    throw new ExtractionError(
      `${String(roleless.length)} person entr${roleless.length === 1 ? "y" : "ies"} carry no ` +
        `role: ${roleless.map((person) => person.slug).join(", ")}. The blueprint marks \`role\` ` +
        `required and all 77 entries satisfy it in the reference corpus. A role is never ` +
        `invented to fill the gap — that would put somebody on a page nobody chose — so fix ` +
        `the entry and re-run.`,
    );
  }

  /* -- 9. site_globals, which needs the imported documents ---------------- */
  const homeEntry = pageEntryByRef.get(HOME_ENTRY_ID);
  if (homeEntry === undefined) {
    throw new ExtractionError(
      `content/collections/pages holds no entry with \`id: home\`, which the tree names as its ` +
        `first root and from which site_description is derived.`,
    );
  }
  const depositsHrefs = context.hrefs
    .filter((record) => record.source_file === "content/collections/pages/deposits.md")
    .map((record) => record.href);
  const siteGlobals = await buildSiteGlobals(context, homeEntry, depositsHrefs);

  /* -- 10. nav_items and the routes --------------------------------------- */
  const pagesByPath = new Map<string, PageRow>(pages.map((page) => [page.path, page] as const));
  const navItems = buildNavItems(context, pagesByPath);
  const routes = buildRouteRows(pages, people, events, classrooms);

  const result: ExtractionResult = {
    sourceCommit,
    assets: assets.rows,
    taxonomyTerms,
    pages,
    pageSections,
    people,
    events,
    classrooms,
    promoted,
    announcements,
    inspiringQuotes,
    siteGlobals,
    navItems,
    routes,
    classroomUnion,
    entriesByCollection,
    context,
  };

  /* -- 11. the census, and the reconciliation ----------------------------- */
  const census = buildCorpusCensus(result);
  const mismatches = reconcileCensus(census);
  if (mismatches.length > 0 && !options.allowCensusDrift) {
    const lines = mismatches.map(
      (mismatch) =>
        `    ${mismatch.key}: expected ${String(mismatch.expected)}, measured ${
          mismatch.actual === null ? "absent" : String(mismatch.actual)
        }`,
    );
    throw new ExtractionError(
      `${String(mismatches.length)} figure(s) do not match the reference census:\n\n` +
        `${lines.join("\n")}\n\n` +
        `The reference revision is named in tools/README.md §2.3, and a mismatch normally ` +
        `means --source is not the tree this migration was planned against. Re-running ` +
        `against a NEWER commit is supported and legitimately moves these numbers — two ` +
        `Statamic auto-commits after the reference revision publish an event, which moves a ` +
        `publish flag, a draft count and an asset's class. Pass --allow-census-drift to ` +
        `record the drift in the census and proceed.\n\n` +
        `Nothing was written.`,
    );
  }
  const censusToWrite =
    mismatches.length === 0
      ? census
      : {
          ...census,
          reference_drift: {
            waived_by: "--allow-census-drift",
            reference_revision: "tools/README.md §2.3",
            mismatches: mismatches.map((mismatch) => ({ ...mismatch })),
          },
        };

  /* -- 12. emit ----------------------------------------------------------- */
  const written = await emitOutputs(result, options, censusToWrite);
  printSummary(result, options, written, mismatches);
};

/* ==========================================================================
 * 22. The executed-as-main guard
 * --------------------------------------------------------------------------
 * Load-bearing rather than stylistic. `export-fallback.ts`, `verify-parity.ts`
 * and `tools/tests/**` import this module for its types and its pure functions —
 * the round-trip conversion, the link rules, the FAQ split, the identity
 * derivation. Without this guard every one of those imports would parse a 163-
 * entry corpus and write eighteen files.
 *
 * It sits last because it runs at module-evaluation time, so every declaration it
 * reaches must already be initialized.
 * ========================================================================== */

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`\n  ${error.message}\n`);
      process.exit(2);
    }
    console.error(`\n  FAILED: ${describeError(error)}\n`);
    process.exit(1);
  }
}

