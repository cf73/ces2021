/**
 * build-asset-manifest.ts — classify, measure and fix the identity of every
 * legacy media binary.
 *
 * This is the **first** program in the migration pipeline and the foundational
 * module of `tools/src`. It reads a Statamic checkout and emits
 * `artifacts/assets.manifest.json`, which is the single authority for two things
 * nothing else in the pipeline may re-derive:
 *
 *   1. **the class of every asset** — `deployed`, `draft_only` or `archived`;
 *   2. **the normalized name of every asset** — the one collision-checked
 *      `source → normalized` map.
 *
 * `tools/README.md` §5.1 names the four consumers of that map, and the reason it
 * has to be produced exactly once:
 *
 *   1. the image paths in the committed fallback JSON;
 *   2. the filesystem relocation (README §5.5);
 *   3. the Storage object keys;
 *   4. every database reference — including the typed globals logo and the
 *      focal-point rows.
 *
 * Four independent normalizations would agree right up until one of them handled
 * a character differently, at which point a database row would point at an
 * object key that does not exist. One map cannot disagree with itself. That is
 * also why `nextjs/lib/image.ts` resolving `/assets/<filename>` in fallback mode
 * means **the normalized filenames are live public URLs**: a change to
 * `normalizeAssetFilename` changes a URL, and is not a cosmetic edit.
 *
 * ## What it does not do
 *
 * It does not move, rename or delete a single file. Relocation is a separate,
 * supervised step (README §5.5), and it is driven by the manifest this program
 * writes. The ordering rule behind that separation is worth restating because it
 * is the whole reason this program runs before anything is deleted: *nothing is
 * deleted while it is still the only copy of bytes the site needs. A manifest
 * entry is a record, not a file, and cannot substitute for the image.*
 *
 * It also touches no credential of any kind. This program is a pure function of
 * the checkout, which is why README §6.2 lists no environment variable for it.
 *
 * ## Measure, never assume
 *
 * Three source-of-truth rules are applied without exception, because each one
 * has a counter-example in this corpus:
 *
 *   - **Bytes come from the filesystem, never from the sidecar.** One sidecar
 *     disagrees: `avatar.svg` records `size: 915` for a 1,001-byte file.
 *   - **Dimensions are measured with sharp, never copied.** Fourteen sidecars
 *     carry `width: null`, and one expresses its dimensions with an explicit
 *     `!!float` tag that YAML 1.2 leaves unresolved — so the parsed value is the
 *     *string* `"261"`, not a number.
 *   - **MIME comes from the magic bytes plus the extension, never from the
 *     sidecar.** Three extensions in this corpus lie: `openhouse.jpg` holds PNG
 *     bytes, and two of the three `.HEIC` files hold JPEG bytes — which is
 *     precisely why only one of the three sidecars says `image/heic`.
 *
 * Where a sidecar disagrees with the file, the measurement wins and the
 * disagreement is recorded in the entry's `notes` and in `sidecar_mime`. Nothing
 * is ever fabricated: an undecodable file gets `width: null`, and an
 * unresolvable source commit gets `source_commit: null`, each with a note
 * saying so.
 *
 * ## Assertions
 *
 * Two kinds, and the distinction matters:
 *
 *   - **Internal invariants** are always fatal. The three classes must reconcile
 *     to the corpus total, `bundled` must equal deployed plus aliases, the
 *     filename map must be injective, and every binary must have a sidecar.
 *     These are properties of a correct run against *any* checkout.
 *   - **The reference census** — 289 binaries, 362,904,172 bytes, the extension
 *     histogram, the class splits, the seven aliases — is fatal by default and
 *     waivable with `--allow-census-drift`. Those figures were measured against
 *     the reference revision named in README §2.3, so a mismatch normally means
 *     the checkout is not the tree this migration was planned against. The
 *     escape hatch exists because README §2.3 makes re-running against a *newer*
 *     commit a supported operation, and a newer commit legitimately moves the
 *     numbers: two Statamic auto-commits after the reference revision publish an
 *     event, which moves both a publish flag and an asset's class.
 *
 * Module scope holds declarations only. Every side effect lives inside `main()`,
 * behind the executed-as-main guard at the foot of the file, because three
 * sibling programs import this module for its types and helpers and an
 * unguarded side effect would make those imports run a filesystem scan.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";

/* ==========================================================================
 * 1. Public types
 * --------------------------------------------------------------------------
 * Exported because `extract-statamic-content.ts`, `upload-assets.ts` and
 * `verify-parity.ts` narrow the parsed manifest with them rather than
 * re-declaring the shape. A second declaration of `AssetManifestEntry` is a
 * second thing to keep in step with the schema, and the field names below are
 * deliberately the column names in `supabase/migrations/20260901120200_assets.sql`
 * so the mapping is readable in both directions.
 * ========================================================================== */

/**
 * The three-way split in AAP §0.7.1. It is the `published_reference_count()`
 * visibility predicate from `20260901121600_write_functions.sql` evaluated once,
 * at extraction time, rather than a separate rule that could drift from it.
 */
export type AssetClass = "deployed" | "draft_only" | "archived";

/** The buckets migration 18 creates. `media-quarantine` never holds a migrated object. */
export type AssetBucket = "media" | "media-private";

/**
 * Statamic's `data.focus` string `x-y-zoom`, split into the three numeric
 * columns the schema declares. `x` and `y` are percentages of the image;
 * `zoom` is a multiplier at or above 1.
 */
export interface FocalPoint {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Which of the four scanned roots a reference was found in. */
export type ReferenceSource = "entry" | "view" | "sass" | "css";

/**
 * One occurrence of an asset filename in a source file.
 *
 * `published` carries the referencing entry's publish state, and is `null` for a
 * template or stylesheet reference — not `false`, and not `true`. A template has
 * no publish state, and collapsing "not applicable" onto either boolean is how a
 * classifier ends up treating the school's logo as a draft.
 */
export interface AssetReference {
  readonly path: string;
  readonly source: ReferenceSource;
  readonly published: boolean | null;
}

/**
 * One binary. Every field the committed fallback `assets.json` needs is present,
 * because the extractor reads this manifest instead of re-deriving anything.
 */
export interface AssetManifestEntry {
  /**
   * The identity the whole load hangs off: the asset's path within
   * `public/assets`, which for this flat container is its exact original
   * filename. `20260901120200_assets.sql` documents it as "the source asset
   * path, e.g. `IMG_4369.jpg`", and it is what content entries store, so a
   * relation resolves without a second lookup. The seed derives the row's uuid
   * from it via `public.ces_uuid('assets', legacy_ref)`.
   */
  readonly legacy_ref: string;
  /** Repository-relative POSIX path in the source checkout, for provenance. */
  readonly source_path: string;
  /** The exact original filename, spaces and capitals intact. */
  readonly filename: string;
  /** The normalized, URL- and key-safe filename. Injective across the corpus. */
  readonly normalized_path: string;
  readonly class: AssetClass;
  /** Decided by the class, not chosen: see `bucketForClass`. */
  readonly bucket: AssetBucket;
  /** The bucket-relative object key. Carries the `archive/` prefix for archived objects. */
  readonly path: string;
  /** True when the file belongs under `nextjs/public/assets/`. */
  readonly bundled: boolean;
  /** Its filename there, or null. Deployed files use the normalized name; aliases keep the original. */
  readonly bundled_path: string | null;
  /** True for the seven documents whose current `/assets/...` URL is preserved verbatim. */
  readonly url_alias: boolean;
  /** Measured from the filesystem. Authoritative over the sidecar. */
  readonly size_bytes: number;
  readonly sha256: string;
  /** Derived from magic bytes plus the lower-cased extension. */
  readonly mime: string;
  /** What the sidecar claimed, recorded for the parity report even when it agrees. */
  readonly sidecar_mime: string | null;
  /** Measured with sharp. Null for anything sharp cannot decode. */
  readonly width: number | null;
  readonly height: number | null;
  readonly focus: FocalPoint | null;
  /**
   * Always null. The assets blueprint declares exactly one field, `alt`, and not
   * one of the 289 sidecars carries a value for it. Authoring alt text for the
   * informative subset is a cutover deliverable and a release gate (AAP §0.4.5),
   * never a migrated value.
   */
  readonly alt: null;
  readonly referenced_by: readonly AssetReference[];
  /** Sidecar disagreements, decode failures and other recorded facts. */
  readonly notes: readonly string[];
}

/** A file-and-byte pair, used for every subtotal so the two never separate. */
export interface AssetTally {
  readonly files: number;
  readonly bytes: number;
}

export interface AssetManifestCounts {
  readonly total: AssetTally;
  readonly by_class: Readonly<Record<AssetClass, AssetTally>>;
  readonly by_extension: Readonly<Record<string, number>>;
  readonly bundled: AssetTally;
  readonly url_aliases: AssetTally;
  readonly sidecars: number;
  readonly focal_points: {
    readonly total: number;
    readonly zoom_above_one: number;
  };
  readonly references: {
    readonly content: number;
    readonly template_or_stylesheet: number;
    readonly unreferenced: number;
  };
}

export interface AssetManifest {
  /**
   * ISO-8601, and deliberately sticky: a re-run that produces identical content
   * reuses the previous stamp so the file stays byte-identical and a real change
   * is the only thing that shows in a diff. `SOURCE_DATE_EPOCH` overrides it.
   */
  readonly generated_at: string;
  readonly generator: string;
  /** The source checkout's commit, or null with a note when it cannot be read. */
  readonly source_commit: string | null;
  readonly counts: AssetManifestCounts;
  /** The one map. Keys are original filenames, values normalized ones. */
  readonly filename_map: Readonly<Record<string, string>>;
  /** Run-level facts: orphan sidecars, an unresolvable commit, waived census drift. */
  readonly notes: readonly string[];
  /** One entry per binary, sorted by `source_path`. */
  readonly assets: readonly AssetManifestEntry[];
}

/* ==========================================================================
 * 2. Constants
 * ========================================================================== */

/** Where the binaries and their sidecars live, relative to the source root. */
const ASSET_DIR = "public/assets";
const META_DIR = "public/assets/.meta";

/** The directory entry name that holds the sidecars, excluded from the binary walk. */
const META_DIR_NAME = ".meta";

/**
 * The four roots a reference to an asset can live in.
 *
 * The set is deliberately wider than `content/`, and that is not thoroughness
 * for its own sake: `CESHouseLogo.png` is referenced by `layout.antlers.html`
 * and by no content entry, so a content-only scan would put the school's own
 * logo in the unreferenced pile and drop it from the deployed set. `avatar.svg`
 * reaches the site the same way, from `_peoplecard.antlers.html` and
 * `bio.antlers.html`.
 *
 * `resources/sass/**` and `public/css/**` are scanned even though neither
 * currently references a binary — README §3.1 lists them, and confirming the
 * absence costs one pass over 544 KB.
 */
interface ScanRoot {
  readonly source: ReferenceSource;
  readonly dir: string;
  readonly extensions: readonly string[];
}

const SCAN_ROOTS: readonly ScanRoot[] = [
  { source: "entry", dir: "content/collections", extensions: [".md"] },
  { source: "view", dir: "resources/views", extensions: [".antlers.html", ".blade.php"] },
  { source: "sass", dir: "resources/sass", extensions: [".scss"] },
  { source: "css", dir: "public/css", extensions: [".css"] },
];

/**
 * Template-referenced but retired, and therefore archived rather than deployed.
 *
 * `avatar.svg` is the default portrait in `_peoplecard.antlers.html:5` and
 * `bio.antlers.html:44`. The target replaces it with the shadcn `AvatarFallback`
 * component, so the binary is never served again — AAP §0.7.1 archives it
 * explicitly. This is the ONE exception to "a template reference means deployed",
 * hard-coded rather than generalised: there is no property of the file that
 * distinguishes it, only a decision about the target's markup.
 */
const RETIRED_FILENAMES: ReadonlySet<string> = new Set(["avatar.svg"]);

/**
 * The seven archived documents whose current `/assets/<filename>` URL is
 * preserved verbatim, with the byte size each must have.
 *
 * These may have been mailed to families, printed on a handout or linked from
 * the family portal, and nothing in the repository can prove they were not, so
 * AAP §0.7.1 makes retention the default and per-file school approval the
 * precondition for retiring one. Marking them here is what makes the copy step
 * in README §5.5 data-driven instead of a list in prose.
 *
 * They stay members of the `archived` class — aliasing is a disposition layered
 * on top of a class, not a reclassification — and they are the one deliberate
 * exception to normalization, because a normalized name is a *different URL* and
 * preserving the URL is the entire point.
 */
const URL_ALIAS_FILENAMES: ReadonlyMap<string, number> = new Map([
  ["2024-25-school-year-calendar---sheet1.pdf", 24_848],
  ["Story-Slam.pdf", 120_843],
  ["Photos-(4).zip", 6_962_762],
  ["Photos-(5).zip", 4_334_022],
  ["Photos-(9).zip", 2_263_836],
  ["Staff.zip", 5_041_941],
  ["lindsey-freedman-headshot.docx", 505_807],
]);

/**
 * The reference census, measured against the revision README §2.3 names. Fatal
 * by default; waivable with `--allow-census-drift` for the supported re-run
 * against a newer commit.
 */
const REFERENCE_REVISION = "052173f";
const EXPECTED_BINARIES = 289;
const EXPECTED_BYTES = 362_904_172;
const EXPECTED_SIDECARS = 289;
const EXPECTED_FOCAL_POINTS = 18;

/**
 * Five, not four. AAP §0.4.2 and §0.4.5 both say four; the corpus holds five
 * (zooms 1.6, 1.3, 1.3, 1.2, 1.2) and README §9.2 lists this as one of the five
 * figures where the measurement is authoritative and warns against reconciling
 * it "in the wrong direction — by changing the code to match the prose".
 * Believing the prose silently re-crops one image.
 */
const EXPECTED_ZOOM_ABOVE_ONE = 5;

const EXPECTED_EXTENSIONS: ReadonlyMap<string, number> = new Map([
  ["jpg", 220],
  ["png", 28],
  ["jpeg", 26],
  ["zip", 4],
  ["heic", 3],
  ["pdf", 2],
  ["js", 2],
  ["css", 2],
  ["svg", 1],
  ["docx", 1],
]);

const EXPECTED_CLASSES: Readonly<Record<AssetClass, AssetTally>> = {
  deployed: { files: 110, bytes: 122_715_298 },
  draft_only: { files: 24, bytes: 19_168_929 },
  archived: { files: 155, bytes: 221_019_945 },
};

const EXPECTED_BUNDLED: AssetTally = { files: 117, bytes: 141_969_357 };
const EXPECTED_ALIASES: AssetTally = { files: 7, bytes: 19_254_059 };

/** Content-referenced 133, template- or stylesheet-referenced 2, unreferenced 154. */
const EXPECTED_REFERENCES = {
  content: 133,
  template_or_stylesheet: 2,
  unreferenced: 154,
} as const;

/** The seven collections hold 163 entries between them. */
const EXPECTED_ENTRIES = 163;

/**
 * The only two assets any template or stylesheet references, as a sorted list.
 * Asserted by name rather than by count: a count of two would still pass if the
 * scan found two entirely different files, and this pair is the whole reason the
 * scan reaches beyond `content/`.
 */
const EXPECTED_TEMPLATE_REFERENCED = "CESHouseLogo.png, avatar.svg";

/** Extension to MIME type. The `heif` and OOXML rows exist for completeness. */
const OOXML_WORD =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OOXML_SHEET =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const OOXML_SLIDES =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["svg", "image/svg+xml"],
  ["heic", "image/heic"],
  ["heif", "image/heic"],
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["docx", OOXML_WORD],
  ["xlsx", OOXML_SHEET],
  ["pptx", OOXML_SLIDES],
  ["js", "text/javascript"],
  ["css", "text/css"],
  ["json", "application/json"],
  ["txt", "text/plain"],
]);

/**
 * Extensions whose files legitimately carry a ZIP signature, because the format
 * is a ZIP container. A ZIP magic on one of these is agreement, not a lie, and
 * must not raise a note — the corpus has exactly one, the DOCX.
 */
const ZIP_CONTAINER_EXTENSIONS: ReadonlySet<string> = new Set([
  "docx",
  "xlsx",
  "pptx",
]);

/** Used when neither the magic bytes nor the extension identifies the file. */
const FALLBACK_MIME = "application/octet-stream";

/** How many leading bytes are needed to identify every format below. */
const MAGIC_PREFIX_BYTES = 64;

/** ISO base media file format brands that mean HEIF/HEIC, and the two that mean AVIF. */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
]);
const AVIF_BRANDS: ReadonlySet<string> = new Set(["avif", "avis"]);


/* ==========================================================================
 * 3. Narrowing guards and small pure utilities
 * --------------------------------------------------------------------------
 * Everything this program reads from disk arrives as `unknown`: a parsed YAML
 * sidecar, and Markdown front matter whose values gray-matter types loosely.
 * These four guards are what turn that into something the compiler and the
 * `no-unsafe-*` rules will accept, and they are the only place a shape check
 * happens — no call site reaches into a parsed value directly.
 * ========================================================================== */

/** True for a plain object. Arrays are excluded: none of the shapes read here is one. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A finite number, or null.
 *
 * Numeric strings are accepted deliberately. `avatar.svg.yaml` writes
 * `width: !!float 261`, and YAML 1.2's core schema does not resolve an explicit
 * `!!float` tag, so `yaml@2` hands back the string `"261"` (and warns, which is
 * why every parse below runs with `logLevel: "silent"`). Rejecting it would
 * report a phantom disagreement against a sidecar that is in fact correct.
 */
const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** A trimmed, non-empty string, or null. */
const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * A stable, locale-independent string order.
 *
 * `localeCompare` is deliberately avoided: its result depends on the ICU data
 * the runtime was built with, and the manifest has to sort identically on every
 * machine for a re-run to be byte-identical.
 */
const compareStrings = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

/** Windows separators to POSIX. The manifest records POSIX paths only. */
const toPosix = (path: string): string => path.split("\\").join("/");

/**
 * Split a filename into its stem and its extension, excluding the dot.
 *
 * The search starts at index 1 so a dotfile such as `.gitkeep` is treated as a
 * stem with no extension rather than as an empty stem — the distinction matters
 * because the placeholder in `public/assets` is exactly that shape.
 */
const splitFilename = (filename: string): { stem: string; extension: string } => {
  const dot = filename.lastIndexOf(".");
  if (dot < 1 || dot === filename.length - 1) {
    return { stem: filename, extension: "" };
  }
  return {
    stem: filename.slice(0, dot),
    extension: filename.slice(dot + 1),
  };
};

/** The lower-cased extension of a filename, without the dot. `""` when there is none. */
const extensionOf = (filename: string): string =>
  splitFilename(filename).extension.toLowerCase();

/**
 * The last segment of a POSIX path. Identical to the whole path while the asset
 * container stays flat, which it is in this corpus — `public/assets` holds 289
 * files, one placeholder and the `.meta` tree, and no other directory.
 */
const basenameOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
};

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

/** `1,234,567` — thousands separators, so a nine-digit byte total stays readable. */
const formatCount = (value: number): string =>
  value.toLocaleString("en-US", { useGrouping: true });

/** An empty tally, so a subtotal never starts as undefined. */
const emptyTally = (): { files: number; bytes: number } => ({ files: 0, bytes: 0 });

/**
 * Raised when the command line is wrong rather than the corpus. The guard at the
 * foot of the file prints the usage text and exits 2 for this, and exits 1 for
 * everything else, so a scripted caller can tell a bad invocation from a failed
 * run.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/* ==========================================================================
 * 4. The command line
 * --------------------------------------------------------------------------
 * `--source` is required and has no default. README §2.1 is the authoritative
 * statement of that contract and explains the reason: after the migration the
 * working tree holds none of the inputs, so a program that silently fell back to
 * `.` would not fail — it would find nothing and emit an empty corpus over a
 * good one.
 * ========================================================================== */

/** Resolved from `import.meta.url`, so `--out` does not depend on the caller's cwd. */
const MODULE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(MODULE_PATH), "..", "..");
const DEFAULT_OUT = "artifacts/assets.manifest.json";
const GENERATOR = "tools/src/build-asset-manifest.ts";

const USAGE = `
Usage: npm run asset-manifest -- --source <path-to-a-statamic-checkout> [options]

  --source <path>          Required. The ROOT of a Statamic checkout, holding
                           content/, resources/ and public/assets/. There is no
                           default: see tools/README.md section 2.1.
  --out <path>             Where to write the manifest. Relative paths resolve
                           against the repository root.
                           Default: ${DEFAULT_OUT}
  --allow-census-drift     Report a mismatch against the reference census as a
                           warning instead of failing. Use this only for the
                           re-run against a newer source commit that
                           tools/README.md section 2.3 describes. Internal
                           invariants stay fatal either way.
  --help                   Print this text.

The checkout is read; nothing in it is written, moved or deleted. No credential
is used. Reference revision for the census: ${REFERENCE_REVISION}.
`.trimStart();

interface Options {
  readonly sourceRoot: string;
  readonly outPath: string;
  readonly allowCensusDrift: boolean;
}

/**
 * Parse argv. Deliberately strict: an unrecognized flag is an error rather than
 * something ignored, because a typo in `--allow-census-drift` would otherwise
 * silently re-enable an assertion the caller meant to waive, and a typo in
 * `--out` would write the manifest somewhere nobody looks.
 */
export const parseOptions = (argv: readonly string[]): Options => {
  let source: string | null = null;
  let out: string | null = null;
  let allowCensusDrift = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      throw new UsageError("Help requested.");
    }
    if (argument === "--allow-census-drift") {
      allowCensusDrift = true;
      continue;
    }
    if (argument === "--source" || argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${argument} requires a path.`);
      }
      if (argument === "--source") {
        source = value;
      } else {
        out = value;
      }
      index += 1;
      continue;
    }
    throw new UsageError(`Unrecognized argument: ${argument}`);
  }

  if (source === null) {
    throw new UsageError(
      "--source is required. It must name the root of a Statamic checkout; see tools/README.md section 2.1 for how to materialise one with `git worktree add`.",
    );
  }

  return {
    sourceRoot: resolve(source),
    outPath: resolve(REPO_ROOT, out ?? DEFAULT_OUT),
    allowCensusDrift,
  };
};


/* ==========================================================================
 * 5. Expectation accounting
 * --------------------------------------------------------------------------
 * Mismatches are collected rather than thrown at the first one. A run against
 * the wrong checkout typically fails several expectations at once, and a report
 * naming all of them tells the operator what tree they actually pointed at;
 * failing on the first tells them almost nothing.
 * ========================================================================== */

interface Expectation {
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
}

/** Record a mismatch. Agreement is silent — the summary reports totals anyway. */
const expectEqual = (
  into: Expectation[],
  label: string,
  actual: number | string,
  expected: number | string,
): void => {
  const actualText = typeof actual === "number" ? formatCount(actual) : actual;
  const expectedText =
    typeof expected === "number" ? formatCount(expected) : expected;
  if (actualText !== expectedText) {
    into.push({ label, expected: expectedText, actual: actualText });
  }
};

/* ==========================================================================
 * 6. MIME: magic bytes first, extension second, sidecar never
 * --------------------------------------------------------------------------
 * The sidecar's `mime_type` is not trustworthy. Measured across the 289
 * sidecars it reads `image/jpeg` 247, `image/png` 29, `text/plain` 3,
 * `application/zip` 3, `application/pdf` 2, `text/x-c` 1, `image/svg+xml` 1,
 * `image/heic` 1 and the OOXML type once — so the two stylesheets and two
 * scripts are described as plain text (one as C source), only three of the four
 * ZIP archives are called ZIPs, and only one of the three `.HEIC` files is
 * called HEIC.
 *
 * That last one is not a sidecar bug. Two of the three `.HEIC` files really do
 * hold JPEG bytes, and `openhouse.jpg` really does hold PNG bytes. The bytes are
 * therefore the authority, the extension refines a container format the bytes
 * cannot distinguish, and the sidecar's claim is recorded for the parity report
 * without ever being believed.
 * ========================================================================== */

interface MagicMatch {
  /** Human-readable, for the note text. */
  readonly label: string;
  readonly mime: string;
}

/** Read a fixed-length ASCII window, for the ISO base media file format boxes. */
const asciiAt = (head: Buffer, start: number, end: number): string =>
  head.length >= end ? head.subarray(start, end).toString("latin1") : "";

const startsWithBytes = (head: Buffer, bytes: readonly number[]): boolean => {
  if (head.length < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => head[index] === byte);
};

/**
 * Identify a file from its leading bytes, or return null when the format has no
 * signature — which is the case for the two `.css` and two `.js` files, whose
 * classification therefore rests on the extension alone.
 */
const detectMagic = (head: Buffer): MagicMatch | null => {
  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) {
    return { label: "JPEG", mime: "image/jpeg" };
  }
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { label: "PNG", mime: "image/png" };
  }
  if (asciiAt(head, 0, 6) === "GIF87a" || asciiAt(head, 0, 6) === "GIF89a") {
    return { label: "GIF", mime: "image/gif" };
  }
  if (asciiAt(head, 0, 4) === "RIFF" && asciiAt(head, 8, 12) === "WEBP") {
    return { label: "WebP", mime: "image/webp" };
  }
  if (asciiAt(head, 4, 8) === "ftyp") {
    const brand = asciiAt(head, 8, 12);
    if (AVIF_BRANDS.has(brand)) {
      return { label: `AVIF (brand ${brand})`, mime: "image/avif" };
    }
    if (HEIF_BRANDS.has(brand)) {
      return { label: `HEIF (brand ${brand})`, mime: "image/heic" };
    }
    return null;
  }
  if (asciiAt(head, 0, 5) === "%PDF-") {
    return { label: "PDF", mime: "application/pdf" };
  }
  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04])) {
    return { label: "ZIP", mime: "application/zip" };
  }
  return null;
};

/**
 * A text sniff, used only to confirm a `.svg` extension and never to claim SVG
 * for anything else. SVG has no binary signature, and guessing it from content
 * would risk mislabelling any XML or HTML file that ever entered the container.
 */
const looksLikeSvg = (head: Buffer): boolean => {
  const text = head.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return text.startsWith("<svg") || text.startsWith("<?xml");
};

interface DerivedMime {
  readonly mime: string;
  readonly notes: readonly string[];
}

/**
 * Resolve the MIME type, and say so when the file and its name disagree.
 *
 * The precedence is: a concrete magic match wins; a ZIP magic under an OOXML
 * extension resolves to the OOXML type without a note, because an OOXML file
 * *is* a ZIP container and that is agreement rather than a lie; otherwise the
 * extension decides, with `application/octet-stream` and a note as the last
 * resort.
 */
const deriveMime = (
  filename: string,
  head: Buffer,
  sidecarMime: string | null,
): DerivedMime => {
  const extension = extensionOf(filename);
  const expected = EXTENSION_MIME.get(extension) ?? null;
  const magic = detectMagic(head);
  const notes: string[] = [];
  let mime: string;

  if (magic !== null) {
    if (magic.mime === "application/zip" && ZIP_CONTAINER_EXTENSIONS.has(extension)) {
      mime = expected ?? magic.mime;
    } else if (expected !== null && magic.mime !== expected) {
      mime = magic.mime;
      notes.push(
        `magic bytes are ${magic.label} (${magic.mime}) but the .${extension} extension implies ${expected}; the measured type wins and the file is not renamed`,
      );
    } else {
      mime = magic.mime;
    }
  } else if (extension === "svg" && looksLikeSvg(head)) {
    mime = "image/svg+xml";
  } else if (expected !== null) {
    mime = expected;
  } else {
    mime = FALLBACK_MIME;
    notes.push(
      `no magic signature and no known mapping for the .${extension} extension; recorded as ${FALLBACK_MIME}`,
    );
  }

  if (sidecarMime !== null && sidecarMime !== mime) {
    notes.push(
      `sidecar declares mime_type ${sidecarMime}; the measured type is ${mime}`,
    );
  }

  return { mime, notes };
};

/* ==========================================================================
 * 7. Filesystem inventory
 * ========================================================================== */

/**
 * Recursively list files under `dir`, returning POSIX paths relative to it.
 *
 * Hand-rolled rather than reached for from a package: the pinned dependency set
 * has no glob, and `fs.glob` is still experimental on the Node 22 floor this
 * project targets, so it would print a runtime warning into an interface whose
 * whole contract is stdout.
 *
 * `skipDirectories` excludes a directory name at any depth, which is how the
 * sidecar tree is kept out of the binary walk. Entries whose name begins with a
 * dot are skipped too: the only one in the asset container is the `.gitkeep`
 * placeholder, which the census counts separately and which is not a binary.
 */
const walkRelative = async (
  dir: string,
  options: { readonly skipDirectories?: ReadonlySet<string> } = {},
): Promise<string[]> => {
  const skip = options.skipDirectories ?? new Set<string>();
  const found: string[] = [];

  const visit = async (absolute: string, prefix: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) {
          continue;
        }
        await visit(join(absolute, entry.name), relative);
      } else if (entry.isFile()) {
        // A leading dot marks a placeholder rather than content. The only one in
        // the asset container is `.gitkeep`, which the census counts separately
        // and which is not a binary.
        if (entry.name.startsWith(".")) {
          continue;
        }
        found.push(relative);
      }
    }
  };

  await visit(dir, "");
  found.sort(compareStrings);
  return found;
};

/** Read a file, returning null for "does not exist" and rethrowing anything else. */
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

/** True when `path` names an existing directory. */
const isDirectory = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
};

interface SidecarFacts {
  /** Repository-relative path of the sidecar itself. */
  readonly path: string;
  readonly mime: string | null;
  readonly size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  /** Statamic's raw `data.focus` string, unparsed. */
  readonly focusRaw: string | null;
  readonly notes: readonly string[];
}

/**
 * Parse one `.meta/<filename>.yaml` sidecar. Returns null when there is none.
 *
 * Every parse runs with `logLevel: "silent"`. `avatar.svg.yaml` writes its
 * dimensions with an explicit `!!float` tag, which YAML 1.2's core schema leaves
 * unresolved, and the parser's default behaviour is to warn on stderr about it —
 * noise in a program whose interface is its output. The fact is not swallowed:
 * `asFiniteNumber` still reads the value, and a genuinely unreadable dimension
 * becomes a recorded note.
 */
const readSidecar = async (
  sourceRoot: string,
  relativePath: string,
): Promise<SidecarFacts | null> => {
  const sidecarRelative = `${META_DIR}/${relativePath}.yaml`;
  const text = await readTextIfExists(join(sourceRoot, sidecarRelative));
  if (text === null) {
    return null;
  }

  const notes: string[] = [];
  const document: unknown = parseYaml(text, { logLevel: "silent" });
  if (!isRecord(document)) {
    notes.push(`sidecar ${sidecarRelative} is not a YAML mapping; ignored`);
    return {
      path: sidecarRelative,
      mime: null,
      size: null,
      width: null,
      height: null,
      focusRaw: null,
      notes,
    };
  }

  const readDimension = (key: "width" | "height"): number | null => {
    const raw = document[key];
    const value = asFiniteNumber(raw);
    if (value === null && raw != null) {
      notes.push(
        `sidecar ${key} is not a number (${JSON.stringify(raw)}); the measured value is used`,
      );
    }
    return value;
  };

  const data = document["data"];
  const focusRaw = isRecord(data) ? asNonEmptyString(data["focus"]) : null;
  if (data != null && !isRecord(data)) {
    notes.push(`sidecar data is not a mapping (${JSON.stringify(data)}); no focal point read`);
  }

  return {
    path: sidecarRelative,
    mime: asNonEmptyString(document["mime_type"]),
    size: asFiniteNumber(document["size"]),
    width: readDimension("width"),
    height: readDimension("height"),
    focusRaw,
    notes,
  };
};

interface MeasuredBytes {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly head: Buffer;
}

/**
 * Read one binary once, and take everything the bytes can give: its length, its
 * SHA-256 and the prefix the magic-byte check needs.
 *
 * Reading whole files rather than streaming is a bounded choice, not a careless
 * one: the largest asset in the corpus is `open-house-website-banner.jpg` at
 * 10,619,043 bytes, so peak memory is one file at a time and the loop is
 * sequential. The alternative — an async iterator over a read stream — yields
 * `any`-typed chunks, which is exactly the boundary this project's lint rules
 * exist to keep honest.
 */
const measureBytes = async (absolutePath: string): Promise<MeasuredBytes> => {
  const bytes = await readFile(absolutePath);
  return {
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    head: Buffer.from(bytes.subarray(0, MAGIC_PREFIX_BYTES)),
  };
};

interface MeasuredImage {
  readonly width: number | null;
  readonly height: number | null;
  /** Null on success. The first line of the decoder's own message otherwise. */
  readonly failure: string | null;
}

/**
 * Intrinsic dimensions, measured rather than copied from the sidecar — fourteen
 * of which carry `width: null`.
 *
 * A decode failure is never fatal. The corpus holds four ZIPs, two PDFs, a DOCX,
 * two scripts and two stylesheets that no image decoder can read, and that is
 * expected rather than exceptional. The caller decides whether the failure is
 * worth a note, by asking whether the derived MIME type claimed to be an image.
 */
const measureImage = async (absolutePath: string): Promise<MeasuredImage> => {
  try {
    const metadata = await sharp(absolutePath).metadata();
    const width = typeof metadata.width === "number" ? metadata.width : null;
    const height = typeof metadata.height === "number" ? metadata.height : null;
    if (width === null || height === null) {
      return {
        width: null,
        height: null,
        failure: "decoded, but the file reports no intrinsic dimensions",
      };
    }
    return { width, height, failure: null };
  } catch (error) {
    const firstLine = describeError(error).split("\n")[0];
    return {
      width: null,
      height: null,
      failure: firstLine === undefined || firstLine === "" ? "unreadable" : firstLine,
    };
  }
};


/**
 * One binary as the filesystem describes it, before references, classes and
 * normalized names are known. Exported because `verify-parity.ts` re-measures
 * this same set when it re-runs against a materialised revision.
 */
export interface InventoriedAsset {
  /**
   * The container-relative POSIX path, which for this flat container is the
   * exact original filename — and which is therefore the value content entries
   * store and the value `assets.legacy_ref` holds.
   */
  readonly relativePath: string;
  /** The basename. Identical to `relativePath` while the container stays flat. */
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mime: string;
  readonly sidecarMime: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** The unparsed `x-y-zoom` string, or null. Parsed by `parseFocus` at assembly. */
  readonly focusRaw: string | null;
  readonly notes: readonly string[];
}

interface Inventory {
  readonly assets: readonly InventoriedAsset[];
  readonly sidecarCount: number;
  readonly runNotes: readonly string[];
}

/**
 * Walk the container, measure every binary, and read every sidecar.
 *
 * Sequential by design. Concurrency would speed up 362,904,172 bytes of hashing
 * a little, and would make the progress output and the decoder's own diagnostics
 * interleave unpredictably — a poor trade for a program that runs once per
 * source commit and whose interface is what it prints.
 */
const inventoryAssets = async (
  sourceRoot: string,
  expectations: Expectation[],
): Promise<Inventory> => {
  const assetRoot = join(sourceRoot, ASSET_DIR);
  if (!(await isDirectory(assetRoot))) {
    throw new Error(
      `${ASSET_DIR} does not exist under ${sourceRoot}. --source must name the ROOT of a Statamic checkout; see tools/README.md section 2.1.`,
    );
  }

  const relativePaths = await walkRelative(assetRoot, {
    skipDirectories: new Set([META_DIR_NAME]),
  });

  const runNotes: string[] = [];
  const metaRoot = join(sourceRoot, META_DIR);
  const sidecarPaths = (await isDirectory(metaRoot))
    ? await walkRelative(metaRoot)
    : [];
  const sidecarNames = sidecarPaths.filter((path) => path.endsWith(".yaml"));
  if (sidecarPaths.length === 0) {
    runNotes.push(
      `${META_DIR} holds no sidecars; every mime type, size and focal point is measured from the binaries alone`,
    );
  }

  // A sidecar describing a binary that is not there is a real finding: it means
  // a file was removed from the container without the Control Panel noticing.
  const binarySet = new Set(relativePaths);
  const orphanSidecars = sidecarNames
    .map((name) => name.slice(0, -".yaml".length))
    .filter((name) => !binarySet.has(name));
  for (const orphan of orphanSidecars) {
    runNotes.push(
      `sidecar ${META_DIR}/${orphan}.yaml describes a binary that is not present in ${ASSET_DIR}`,
    );
  }

  console.log(
    `  reading ${formatCount(relativePaths.length)} binaries and ${formatCount(sidecarNames.length)} sidecars…`,
  );

  const assets: InventoriedAsset[] = [];
  let bytesTotal = 0;
  const extensionCounts = new Map<string, number>();

  for (const relativePath of relativePaths) {
    const absolutePath = join(assetRoot, relativePath);
    const notes: string[] = [];

    const measured = await measureBytes(absolutePath);
    const sidecar = await readSidecar(sourceRoot, relativePath);
    if (sidecar === null) {
      notes.push(
        `no sidecar at ${META_DIR}/${relativePath}.yaml; mime and dimensions come from the bytes alone`,
      );
    } else {
      notes.push(...sidecar.notes);
      if (sidecar.size !== null && sidecar.size !== measured.sizeBytes) {
        notes.push(
          `sidecar records size ${formatCount(sidecar.size)} but the file is ${formatCount(measured.sizeBytes)} bytes; the filesystem is authoritative`,
        );
      }
    }

    const derived = deriveMime(
      relativePath,
      measured.head,
      sidecar?.mime ?? null,
    );
    notes.push(...derived.notes);

    const image = await measureImage(absolutePath);
    if (image.failure !== null && derived.mime.startsWith("image/")) {
      notes.push(
        `sharp could not read dimensions for a file measured as ${derived.mime}: ${image.failure}`,
      );
    }
    if (
      sidecar !== null &&
      image.width !== null &&
      sidecar.width !== null &&
      sidecar.width !== image.width
    ) {
      notes.push(
        `sidecar records width ${formatCount(sidecar.width)} but the image measures ${formatCount(image.width)}; the measurement is authoritative`,
      );
    }
    if (
      sidecar !== null &&
      image.height !== null &&
      sidecar.height !== null &&
      sidecar.height !== image.height
    ) {
      notes.push(
        `sidecar records height ${formatCount(sidecar.height)} but the image measures ${formatCount(image.height)}; the measurement is authoritative`,
      );
    }

    const extension = extensionOf(relativePath);
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
    bytesTotal += measured.sizeBytes;

    assets.push({
      relativePath,
      filename: basenameOf(relativePath),
      sizeBytes: measured.sizeBytes,
      sha256: measured.sha256,
      mime: derived.mime,
      sidecarMime: sidecar?.mime ?? null,
      width: image.width,
      height: image.height,
      focusRaw: sidecar?.focusRaw ?? null,
      notes,
    });

    if (assets.length % 50 === 0) {
      console.log(
        `    ${formatCount(assets.length)} / ${formatCount(relativePaths.length)}`,
      );
    }
  }

  // The reference census, for the parts of it the inventory alone can see.
  expectEqual(expectations, "asset binaries", assets.length, EXPECTED_BINARIES);
  expectEqual(expectations, "total bytes", bytesTotal, EXPECTED_BYTES);
  expectEqual(expectations, "sidecars", sidecarNames.length, EXPECTED_SIDECARS);
  for (const [extension, expected] of EXPECTED_EXTENSIONS) {
    expectEqual(
      expectations,
      `.${extension} files`,
      extensionCounts.get(extension) ?? 0,
      expected,
    );
  }
  // An extension the census does not know about is a finding in its own right,
  // reported as "expected none" rather than silently tolerated.
  for (const [extension, count] of extensionCounts) {
    if (!EXPECTED_EXTENSIONS.has(extension)) {
      expectEqual(expectations, `.${extension} files (unexpected)`, count, 0);
    }
  }

  return { assets, sidecarCount: sidecarNames.length, runNotes };
};


/* ==========================================================================
 * 8. Focal points
 * --------------------------------------------------------------------------
 * Statamic stores a focal point as one string under `data.focus`, in the form
 * `x-y-zoom` — `50-33-1`. Exactly 18 of the 289 sidecars carry one; the other
 * 271 carry a literally empty map, rendered `data: {  }`.
 *
 * The 18 measured values are, in order:
 *
 *   30-33-1.6  36-79-1    38-40-1.3  39-42-1    41-58-1    43-36-1
 *   43-46-1    43-53-1    44-48-1    47-43-1.2  48-53-1    49-59-1
 *   50-33-1    50-50-1.3  51-54-1    56-48-1    59-29-1.2  62-23-1
 *
 * FIVE of them carry a zoom above 1 — 1.6, 1.3, 1.3, 1.2 and 1.2. AAP §0.4.2
 * and §0.4.5 both say four. The corpus is right, and README §9.2 lists this
 * among the five figures where the measurement is authoritative, with the
 * consequence of believing the prose stated plainly: one image silently
 * re-cropped. The number this program emits is always the computed one.
 *
 * Zoom matters at render time and is not decoration: `Media` applies x and y as
 * `object-position` and zoom as a `scale()` inside an overflow-hidden frame, so
 * dropping a zoom above 1 changes the crop of a real photograph.
 * ========================================================================== */

/** Matches an unsigned integer or decimal. No sign: `-` is the field separator. */
const NUMERIC_PART = /^\d+(?:\.\d+)?$/;

/** x and y are percentages of the image. Mirrors the assets migration's check constraints. */
const FOCUS_AXIS_MIN = 0;
const FOCUS_AXIS_MAX = 100;
/** zoom is a multiplier at or above 1, capped where `focus_zoom numeric(5,2)` is capped. */
const FOCUS_ZOOM_MIN = 1;
const FOCUS_ZOOM_MAX = 10;

const focusPart = (
  parts: readonly string[],
  index: number,
  axis: string,
  raw: string,
): number => {
  const text = parts[index]?.trim() ?? "";
  if (!NUMERIC_PART.test(text)) {
    throw new Error(
      `focal point ${JSON.stringify(raw)} has a non-numeric ${axis} component ${JSON.stringify(text)}; the expected form is x-y-zoom, for example 50-33-1`,
    );
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(
      `focal point ${JSON.stringify(raw)} has an unreadable ${axis} component ${JSON.stringify(text)}`,
    );
  }
  return value;
};

const assertFocusRange = (
  value: number,
  axis: string,
  minimum: number,
  maximum: number,
  raw: string,
): void => {
  if (value < minimum || value > maximum) {
    throw new Error(
      `focal point ${JSON.stringify(raw)} has ${axis} ${String(value)}, outside the permitted range ${String(minimum)}–${String(maximum)}. The assets migration puts a check constraint on this column, so the value would abort the seed load; failing here is cheaper.`,
    );
  }
};

/**
 * Split Statamic's `x-y-zoom` string into the three numeric columns the schema
 * declares.
 *
 * Throws rather than returning null on anything malformed. That is deliberate:
 * `20260901120200_assets.sql` constrains all three columns — x and y to 0–100,
 * zoom to 1–10 — so a bad value fails the load anyway, and failing at extraction
 * names the sidecar that caused it instead of surfacing as a constraint
 * violation halfway through a seed.
 */
export const parseFocus = (raw: string): FocalPoint => {
  const trimmed = raw.trim();
  const parts = trimmed.split("-");
  if (parts.length !== 3) {
    throw new Error(
      `focal point ${JSON.stringify(raw)} has ${String(parts.length)} hyphen-separated components; exactly three are required, in the form x-y-zoom`,
    );
  }

  const x = focusPart(parts, 0, "x", trimmed);
  const y = focusPart(parts, 1, "y", trimmed);
  const zoom = focusPart(parts, 2, "zoom", trimmed);

  assertFocusRange(x, "x", FOCUS_AXIS_MIN, FOCUS_AXIS_MAX, trimmed);
  assertFocusRange(y, "y", FOCUS_AXIS_MIN, FOCUS_AXIS_MAX, trimmed);
  assertFocusRange(zoom, "zoom", FOCUS_ZOOM_MIN, FOCUS_ZOOM_MAX, trimmed);

  return { x, y, zoom };
};

/**
 * Parse the focal point of one inventoried asset, naming the asset if the value
 * is malformed. A run must not fail with a bare `50-33` and no clue which of 289
 * sidecars produced it.
 */
const focusForAsset = (asset: InventoriedAsset): FocalPoint | null => {
  if (asset.focusRaw === null) {
    return null;
  }
  try {
    return parseFocus(asset.focusRaw);
  } catch (error) {
    throw new Error(
      `${META_DIR}/${asset.relativePath}.yaml: ${describeError(error)}`,
    );
  }
};

/** Count focal points and how many crop with a zoom above 1. Exported for the unit tests. */
export const summarizeFocalPoints = (
  focals: readonly (FocalPoint | null)[],
): { total: number; zoomAboveOne: number } => {
  let total = 0;
  let zoomAboveOne = 0;
  for (const focus of focals) {
    if (focus === null) {
      continue;
    }
    total += 1;
    if (focus.zoom > 1) {
      zoomAboveOne += 1;
    }
  }
  return { total, zoomAboveOne };
};


/* ==========================================================================
 * 9. Normalization, and the one filename map
 * --------------------------------------------------------------------------
 * Legacy asset filenames are not URL-safe. Measured across the 289: 25 contain
 * literal spaces (`Andy Griswold.jpg`, `Liz McKillop-Segura.jpg`), 58 carry an
 * uppercase extension (55 `.JPG`, 3 `.HEIC`), and the remainder of the unsafe
 * characters are parentheses (`Photos-(4).zip`), apostrophes
 * (`dee's-headshot.png`) and one `+`. Normalization is unavoidable.
 *
 * It must also happen exactly once. README §5.1 names the four consumers of the
 * map this section produces:
 *
 *   1. the image paths in the committed fallback JSON;
 *   2. the filesystem relocation into `nextjs/public/assets/`;
 *   3. the Storage object keys;
 *   4. every database reference — including the typed globals logo and the 18
 *      focal-point rows.
 *
 * Four independent normalizations would agree until one of them handled a
 * character differently, at which point a database row would point at an object
 * key that does not exist. And because `nextjs/lib/image.ts` resolves
 * `/assets/<filename>` in fallback mode, **these names are live public URLs**:
 * editing this function changes a URL.
 *
 * ## Why the rule is a plain character substitution
 *
 * The obvious refinements are both wrong, and the corpus proves it rather than
 * theory. Collapsing runs of `-`, or deleting apostrophes instead of replacing
 * them, maps
 *
 *     yu-shiuan-'carol'-shie.jpeg   →   yu-shiuan-carol-shie.jpeg
 *
 * onto `yu-shiuan-carol-shie.jpeg`, which is a DIFFERENT file that also exists
 * in this container. That is a real collision, and under `assertInjective` it
 * aborts the run — correctly, since silently overwriting one with the other
 * would destroy an image and leave every reference to it resolving to the wrong
 * face. A one-character-for-one-character substitution cannot do that: it
 * preserves length and position, so two distinct stems can only collide if they
 * differ solely at positions where both hold an unsafe character. Verified
 * injective over all 289 names, case-sensitively and case-insensitively.
 *
 * Repeated hyphens therefore survive — `2024-25-school-year-calendar---sheet1.pdf`
 * keeps its three — and that is a feature, not an oversight: repeated hyphens are
 * perfectly legal in a URL path and in an object key, and this particular file is
 * one of the seven whose original URL is preserved anyway.
 *
 * ## What is deliberately NOT changed
 *
 * The case of the stem. AAP §0.4.2 specifies "no leading slash, lower-cased
 * extension, spaces and other unsafe characters replaced, the `/assets/` prefix
 * stripped" — the extension, and nothing more. Preserving stem case keeps
 * `CESHouseLogo.png` at exactly the URL it has today, limits 58 of the changes to
 * the extension alone, and is strictly safer for injectivity than lower-casing
 * would be.
 * ========================================================================== */

/** The characters an asset name may keep. Everything else becomes a hyphen. */
const UNSAFE_CHARACTERS = /[^A-Za-z0-9._-]/g;
/** Separators trimmed from the ends of a stem, where they read as noise. */
const TRIMMABLE_STEM_EDGES = /^[-.\s]+|[-.\s]+$/g;
/** Applied to an extension: lower-case, then keep only alphanumerics. */
const NON_ALPHANUMERIC = /[^a-z0-9]/g;
/** Used when a stem consists entirely of characters that are stripped. */
const EMPTY_STEM_REPLACEMENT = "asset";

/** Normalize one path segment that is not the filename — a directory name. */
const normalizeSegment = (segment: string): string => {
  const substituted = segment.replace(UNSAFE_CHARACTERS, "-");
  const trimmed = substituted.replace(TRIMMABLE_STEM_EDGES, "");
  return trimmed === "" ? EMPTY_STEM_REPLACEMENT : trimmed;
};

/**
 * Produce the bucket-relative POSIX path for one asset.
 *
 * Accepts any of the forms a reference can take — `/assets/Foo Bar.JPG`,
 * `public/assets/Foo Bar.JPG`, `assets/Foo Bar.JPG` or the bare
 * `Foo Bar.JPG` — and returns the same normalized name for all of them, because
 * a container-relative name is the only thing a bucket key or a fallback URL can
 * be built from.
 *
 * Pure, total and deterministic: the same input always gives the same output,
 * with no dependence on the corpus, the filesystem or the order of the run.
 * Four consumers rely on precisely that.
 */
export const normalizeAssetFilename = (sourcePath: string): string => {
  const posix = toPosix(sourcePath).trim();
  if (posix === "") {
    throw new Error("cannot normalize an empty asset path");
  }

  // Strip a leading slash, then the `public/` and `assets/` prefixes, so a
  // template's `/assets/x.jpg` and a manifest's `x.jpg` converge.
  let remainder = posix.replace(/^\/+/, "");
  const prefixes = ["public/", "assets/"];
  for (const prefix of prefixes) {
    if (remainder.toLowerCase().startsWith(prefix)) {
      remainder = remainder.slice(prefix.length);
    }
  }

  // `.` is a no-op segment and is dropped; `..` could escape the container and is
  // refused outright, because a normalized path becomes an object key and a
  // filesystem destination.
  const rawSegments = remainder
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (rawSegments.includes("..")) {
    throw new Error(
      `refusing to normalize ${JSON.stringify(sourcePath)}: a "..'" segment could escape the asset container`,
    );
  }
  if (rawSegments.length === 0) {
    throw new Error(
      `cannot normalize ${JSON.stringify(sourcePath)}: it names no file inside the asset container`,
    );
  }

  const directories = rawSegments.slice(0, -1).map(normalizeSegment);
  const filename = rawSegments[rawSegments.length - 1];
  if (filename === undefined) {
    throw new Error(`cannot normalize ${JSON.stringify(sourcePath)}: no filename`);
  }

  const { stem, extension } = splitFilename(filename);
  const normalizedStem = normalizeSegment(stem);
  const normalizedExtension = extension
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "");
  const normalizedFilename =
    normalizedExtension === ""
      ? normalizedStem
      : `${normalizedStem}.${normalizedExtension}`;

  return [...directories, normalizedFilename].join("/");
};

/**
 * Build the complete `source → normalized` map for a set of asset paths.
 *
 * A `Map` rather than an object, so a filename that happens to read like
 * `constructor` or `__proto__` cannot collide with a prototype member. It is
 * converted to a sorted plain object only at serialization time.
 */
export const buildFilenameMap = (
  sourcePaths: readonly string[],
): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const sourcePath of sourcePaths) {
    map.set(sourcePath, normalizeAssetFilename(sourcePath));
  }
  return map;
};

/**
 * Throw unless the map is injective — one normalized name per source file.
 *
 * README §5.1: "Two files normalizing to one name is a hard failure, not a
 * silent overwrite. The manifest step aborts. Silently overwriting would destroy
 * one image and leave every reference to it resolving to the other — the kind of
 * loss that is invisible in a diff and obvious on the website." The message names
 * every colliding source so the operator can see which two files are involved
 * without re-deriving the map.
 *
 * Case-insensitive collisions are rejected as well, and that is not
 * over-caution: object keys and a case-insensitive local checkout both conflate
 * `Photo.jpg` with `photo.jpg`, so a pair that differs only in case would
 * survive this check and then destroy one of the two files during relocation.
 */
export const assertInjective = (map: ReadonlyMap<string, string>): void => {
  /** normalized name → the source paths that produced it. */
  const byNormalized = new Map<string, string[]>();
  /** lower-cased normalized name → the distinct normalized names folding onto it. */
  const byFolded = new Map<string, Set<string>>();

  for (const [sourcePath, normalized] of map) {
    const sources = byNormalized.get(normalized) ?? [];
    sources.push(sourcePath);
    byNormalized.set(normalized, sources);

    const folded = normalized.toLowerCase();
    const variants = byFolded.get(folded) ?? new Set<string>();
    variants.add(normalized);
    byFolded.set(folded, variants);
  }

  const quotedSources = (normalized: string): string =>
    [...(byNormalized.get(normalized) ?? [])]
      .sort(compareStrings)
      .map((source) => JSON.stringify(source))
      .join(" and ");

  const failures: string[] = [];

  for (const normalized of [...byNormalized.keys()].sort(compareStrings)) {
    const sources = byNormalized.get(normalized) ?? [];
    if (sources.length > 1) {
      failures.push(
        `  exact collision on ${JSON.stringify(normalized)}: ${quotedSources(normalized)}`,
      );
    }
  }

  // Only a genuine case-only difference is reported here. A group whose members
  // all normalize to the same string is already covered by the exact pass above,
  // and reporting it twice would obscure how many distinct problems there are.
  for (const folded of [...byFolded.keys()].sort(compareStrings)) {
    const variants = byFolded.get(folded) ?? new Set<string>();
    if (variants.size > 1) {
      const detail = [...variants]
        .sort(compareStrings)
        .map((variant) => `${JSON.stringify(variant)} (from ${quotedSources(variant)})`)
        .join(" and ");
      failures.push(`  case-insensitive collision on ${JSON.stringify(folded)}: ${detail}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `the source → normalized filename map is not injective, so relocating the corpus would overwrite a file:\n${failures.join(
        "\n",
      )}\nResolve this by renaming a source file, never by letting one win.`,
    );
  }
};


/* ==========================================================================
 * 10. References, publish state, and the three classes
 * --------------------------------------------------------------------------
 * The heart of the file. Two rules make it correct, and both have a
 * counter-example in this corpus if they are broken.
 *
 * **The reference set is wider than `content/`.** `CESHouseLogo.png` — the
 * school's own logo, 42,215 bytes — is referenced by `layout.antlers.html:33`
 * and by no content entry. A content-only scan would put it in the unreferenced
 * pile and drop it from the deployed set, which is to say the site would ship
 * without its logo.
 *
 * **Matching is whole-filename and boundary-checked, never token-based.** A
 * shell-style scan word-splits `Andy Griswold.jpg` and then reports a match for
 * the fragment `An` against every entry containing the word "And". The matcher
 * below searches for the complete filename and requires a separator on the left
 * and a non-alphanumeric on the right, which also stops `hands.jpg` matching
 * inside a hypothetical `two-hands.jpg`. The percent-encoded form is searched
 * too, because a stylesheet or template may encode a space as `%20`; the corpus
 * happens to contain no encoded reference, and the check costs one extra
 * `indexOf` per file.
 * ========================================================================== */

/**
 * A character that, immediately before a match, means the match is the tail of a
 * longer name rather than the name itself.
 */
const REFERENCE_PREFIX_BOUNDARY = /[A-Za-z0-9._~-]/;
/** A character that, immediately after a match, means the name continues. */
const REFERENCE_SUFFIX_BOUNDARY = /[A-Za-z0-9]/;

/**
 * The forms a reference to one asset can take: the literal path, and the same
 * path percent-encoded segment by segment so a `/` separator survives.
 */
const referenceCandidates = (relativePath: string): readonly string[] => {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return encoded === relativePath ? [relativePath] : [relativePath, encoded];
};

/**
 * Does `text` reference the asset at `relativePath`?
 *
 * Exported because it is the single most defect-prone rule in this program and
 * the unit tests assert it directly: a fragment must not match, and the
 * percent-encoded form must.
 */
export const referencesFilename = (
  relativePath: string,
  text: string,
): boolean => {
  for (const candidate of referenceCandidates(relativePath)) {
    if (candidate === "") {
      continue;
    }
    let index = text.indexOf(candidate);
    while (index !== -1) {
      const before = index === 0 ? "" : text.charAt(index - 1);
      const afterIndex = index + candidate.length;
      const after = afterIndex >= text.length ? "" : text.charAt(afterIndex);
      const boundedLeft = before === "" || !REFERENCE_PREFIX_BOUNDARY.test(before);
      const boundedRight = after === "" || !REFERENCE_SUFFIX_BOUNDARY.test(after);
      if (boundedLeft && boundedRight) {
        return true;
      }
      index = text.indexOf(candidate, index + 1);
    }
  }
  return false;
};

/**
 * Statamic's publish rule, which is the one place an inverted condition would
 * silently reclassify most of the corpus: **the absence of the key means
 * published.** Only an explicit `published: false` makes an entry a draft, and
 * 55 of the 163 entries carry exactly that.
 *
 * Front matter is parsed with gray-matter rather than pattern-matched, so a
 * `published: false` appearing inside a nested replicator set or in body prose
 * cannot be mistaken for the entry's own flag.
 */
export const isPublishedEntry = (entrySource: string): boolean => {
  const parsed = matter(entrySource);
  const data: unknown = parsed.data;
  if (!isRecord(data)) {
    return true;
  }
  return data["published"] !== false;
};

interface SourceDocument {
  /** Repository-relative POSIX path, as it will appear in `referenced_by`. */
  readonly path: string;
  readonly source: ReferenceSource;
  readonly text: string;
  /** The entry's publish state, or null where the concept does not apply. */
  readonly published: boolean | null;
}

/**
 * Read every file in the four scan roots once.
 *
 * A missing optional root is a recorded note rather than a failure: a checkout
 * could legitimately lack `public/css` if the compiled stylesheets were never
 * committed, and that must not stop the corpus being classified. A missing
 * `content/collections` is different, and `main` refuses the checkout before
 * this point.
 */
const loadScanCorpus = async (
  sourceRoot: string,
  expectations: Expectation[],
  runNotes: string[],
): Promise<readonly SourceDocument[]> => {
  const documents: SourceDocument[] = [];
  let entryCount = 0;

  for (const root of SCAN_ROOTS) {
    const absoluteRoot = join(sourceRoot, root.dir);
    if (!(await isDirectory(absoluteRoot))) {
      runNotes.push(
        `${root.dir} does not exist in the source checkout; no ${root.source} references were scanned`,
      );
      continue;
    }
    const relativePaths = await walkRelative(absoluteRoot);
    for (const relativePath of relativePaths) {
      const lower = relativePath.toLowerCase();
      if (!root.extensions.some((extension) => lower.endsWith(extension))) {
        continue;
      }
      const text = await readFile(join(absoluteRoot, relativePath), "utf8");
      const path = `${root.dir}/${relativePath}`;
      let published: boolean | null = null;
      if (root.source === "entry") {
        entryCount += 1;
        try {
          published = isPublishedEntry(text);
        } catch (error) {
          throw new Error(
            `${path}: front matter could not be parsed, so its publish state is unknown and no asset referencing it can be classified: ${describeError(error)}`,
          );
        }
      }
      documents.push({ path, source: root.source, text, published });
    }
  }

  expectEqual(expectations, "content entries scanned", entryCount, EXPECTED_ENTRIES);
  return documents;
};

/**
 * Find every reference to every asset. Returns a map keyed by the asset's
 * container-relative path, with references in scan order — entries first, then
 * views, sass and css — and stable within each root because `walkRelative`
 * sorts.
 */
const scanReferences = (
  assets: readonly InventoriedAsset[],
  corpus: readonly SourceDocument[],
): ReadonlyMap<string, readonly AssetReference[]> => {
  const found = new Map<string, readonly AssetReference[]>();
  for (const asset of assets) {
    const references: AssetReference[] = [];
    for (const document of corpus) {
      if (referencesFilename(asset.relativePath, document.text)) {
        references.push({
          path: document.path,
          source: document.source,
          published: document.published,
        });
      }
    }
    found.set(asset.relativePath, references);
  }
  return found;
};

/** The minimum an asset must present to be classified. */
export interface ClassifiableAsset {
  /** The container-relative path, which is the key in the returned map. */
  readonly relativePath: string;
  readonly references: readonly AssetReference[];
}

/**
 * Classify one asset.
 *
 * This mirrors the `published_reference_count()` visibility predicate in
 * `20260901121600_write_functions.sql`: an asset belongs in the public bucket if
 * and only if at least one *published* thing references it. The migration's
 * three-way split is that same predicate evaluated once, at seed time — which is
 * why this function exists here and not as a second, drifting rule.
 *
 * A template or stylesheet reference counts as published unconditionally,
 * because a template has no publish state: whatever it renders is live on every
 * request.
 */
const classifyOne = (asset: ClassifiableAsset): AssetClass => {
  const basename = basenameOf(asset.relativePath);

  // The ONE exception, hard-coded and not generalised. `avatar.svg` is the
  // default portrait in `_peoplecard.antlers.html:5` and `bio.antlers.html:44`,
  // so it is template-referenced and would otherwise be deployed — but the
  // target replaces it with the shadcn `AvatarFallback` component, so it is
  // never served again. AAP §0.7.1 archives it explicitly. Nothing about the
  // file distinguishes it; only a decision about the target's markup does,
  // which is exactly why this is a named constant rather than a rule.
  if (RETIRED_FILENAMES.has(basename)) {
    return "archived";
  }

  let hasEntryReference = false;
  let hasPublishedReference = false;
  for (const reference of asset.references) {
    if (reference.source === "entry") {
      hasEntryReference = true;
      if (reference.published === true) {
        hasPublishedReference = true;
      }
    } else {
      hasPublishedReference = true;
    }
  }

  if (hasPublishedReference) {
    return "deployed";
  }
  if (hasEntryReference) {
    return "draft_only";
  }
  return "archived";
};

/**
 * Classify a whole corpus, keyed by container-relative path.
 *
 * Exported and pure so the classification rule can be tested without a
 * filesystem: the three classes are the single most consequential output of this
 * program, since they decide what is deployed publicly, what is kept private and
 * what is archived out of the deployed artifact entirely.
 */
export const classifyAssets = (
  assets: readonly ClassifiableAsset[],
): ReadonlyMap<string, AssetClass> => {
  const classes = new Map<string, AssetClass>();
  for (const asset of assets) {
    classes.set(asset.relativePath, classifyOne(asset));
  }
  return classes;
};

/** Which bucket a class implies. Not a free choice: see AAP §0.7.5. */
const bucketForClass = (assetClass: AssetClass): AssetBucket =>
  assetClass === "deployed" ? "media" : "media-private";

/**
 * The Storage object key.
 *
 * Archived objects take an `archive/` prefix inside the private bucket, per AAP
 * §0.7.5: they are uploaded "under an `archive/` prefix with the triage
 * manifest, so the school can review and restore them rather than lose them".
 * Deployed and draft-only objects sit at the root of their bucket. The prefix
 * cannot introduce a collision, because a normalized container-relative name
 * never begins with `archive/` unless the source container had such a directory,
 * and injectivity is asserted on the normalized names themselves.
 */
const objectKeyFor = (assetClass: AssetClass, normalizedPath: string): string =>
  assetClass === "archived" ? `archive/${normalizedPath}` : normalizedPath;


/** The classification totals the census is asserted against. */
interface ClassificationCensus {
  readonly byClass: Record<AssetClass, { files: number; bytes: number }>;
  readonly contentReferenced: number;
  /** Sorted names, so the assertion can name the files rather than count them. */
  readonly templateReferenced: readonly string[];
  readonly unreferenced: number;
  readonly total: { files: number; bytes: number };
}

const tallyClassification = (
  assets: readonly InventoriedAsset[],
  references: ReadonlyMap<string, readonly AssetReference[]>,
  classes: ReadonlyMap<string, AssetClass>,
): ClassificationCensus => {
  const byClass: Record<AssetClass, { files: number; bytes: number }> = {
    deployed: emptyTally(),
    draft_only: emptyTally(),
    archived: emptyTally(),
  };
  const templateReferenced: string[] = [];
  let contentReferenced = 0;
  let unreferenced = 0;
  const total = emptyTally();

  for (const asset of assets) {
    const assetReferences = references.get(asset.relativePath) ?? [];
    const assetClass = classes.get(asset.relativePath);
    if (assetClass === undefined) {
      throw new Error(
        `internal error: ${asset.relativePath} was measured but never classified`,
      );
    }

    const tally = byClass[assetClass];
    tally.files += 1;
    tally.bytes += asset.sizeBytes;
    total.files += 1;
    total.bytes += asset.sizeBytes;

    const hasEntry = assetReferences.some(
      (reference) => reference.source === "entry",
    );
    const hasOther = assetReferences.some(
      (reference) => reference.source !== "entry",
    );
    if (hasEntry) {
      contentReferenced += 1;
    }
    if (hasOther) {
      templateReferenced.push(asset.relativePath);
    }
    if (!hasEntry && !hasOther) {
      unreferenced += 1;
    }
  }

  templateReferenced.sort(compareStrings);
  return {
    byClass,
    contentReferenced,
    templateReferenced,
    unreferenced,
    total,
  };
};

/**
 * File the census expectations that only classification can see, and assert the
 * reconciliation that must hold for any checkout.
 *
 * The reconciliation is separated from the census deliberately: "the three
 * classes sum to the corpus" is a property of a correct program and is fatal
 * whatever `--allow-census-drift` says, while "deployed is 110 files" is a
 * property of one particular source commit.
 */
const expectClassification = (
  census: ClassificationCensus,
  expectations: Expectation[],
): void => {
  for (const assetClass of ["deployed", "draft_only", "archived"] as const) {
    expectEqual(
      expectations,
      `${assetClass} files`,
      census.byClass[assetClass].files,
      EXPECTED_CLASSES[assetClass].files,
    );
    expectEqual(
      expectations,
      `${assetClass} bytes`,
      census.byClass[assetClass].bytes,
      EXPECTED_CLASSES[assetClass].bytes,
    );
  }
  expectEqual(
    expectations,
    "content-referenced files",
    census.contentReferenced,
    EXPECTED_REFERENCES.content,
  );
  expectEqual(
    expectations,
    "template- or stylesheet-referenced files",
    census.templateReferenced.join(", "),
    EXPECTED_TEMPLATE_REFERENCED,
  );
  expectEqual(
    expectations,
    "unreferenced files",
    census.unreferenced,
    EXPECTED_REFERENCES.unreferenced,
  );
};

/**
 * The invariant that holds for every checkout: the three classes partition the
 * corpus exactly, in both files and bytes. A failure here means the program is
 * wrong, not that the tree is unexpected, so it is always fatal.
 */
const assertClassesReconcile = (census: ClassificationCensus): void => {
  const summed = (["deployed", "draft_only", "archived"] as const).reduce(
    (accumulator, assetClass) => ({
      files: accumulator.files + census.byClass[assetClass].files,
      bytes: accumulator.bytes + census.byClass[assetClass].bytes,
    }),
    emptyTally(),
  );
  if (
    summed.files !== census.total.files ||
    summed.bytes !== census.total.bytes
  ) {
    throw new Error(
      `the three asset classes do not partition the corpus: they sum to ${formatCount(summed.files)} files and ${formatCount(summed.bytes)} bytes, against ${formatCount(census.total.files)} files and ${formatCount(census.total.bytes)} bytes measured`,
    );
  }
};


/* ==========================================================================
 * 11. The seven URL-preserving aliases, and what gets bundled
 * --------------------------------------------------------------------------
 * Seven of the 155 archived binaries are documents sitting at stable
 * `/assets/...` URLs: two PDFs, four ZIPs and a DOCX, 19,254,059 bytes between
 * them, 5.3% of the corpus. Nothing in this repository references any of them —
 * a search of every tracked file outside `public/assets/` finds no occurrence of
 * a `.pdf`, `.zip` or `.docx` path — but "referenced by no page" is not "fetched
 * by nobody". Any of them could have been mailed to families, printed on a
 * handout or linked from the family portal, and the repository cannot prove
 * otherwise.
 *
 * AAP §0.7.1 therefore makes **retention the default and per-file school
 * approval the precondition for retiring one**. Each is copied byte-for-byte to
 * `nextjs/public/assets/` under its exact current filename, so
 * `/assets/<filename>` resolves as it does today with no rewrite, no routing
 * code and no dependency on Supabase keys.
 *
 * Two consequences are easy to get wrong:
 *
 *   - **They are the one deliberate exception to normalization.** A normalized
 *     name is a *different URL*, and preserving the URL is the entire point. The
 *     entry therefore carries both values: `filename` for the static copy, and
 *     `normalized_path`/`path` for the private-bucket object, which they still
 *     get like any other archived file.
 *   - **They remain `archived`.** The alias is a disposition layered on top of a
 *     class, not a reclassification, so the three-way split stays 110 / 24 / 155
 *     while the deployed directory holds 117 files.
 *
 * The other 148 archived binaries are not aliased, and that is a judgment rather
 * than an oversight: an unreferenced image at an unguessable filename is not a
 * handout. All 155 remain recoverable from `archive/unreferenced/` and from the
 * private bucket.
 * ========================================================================== */

/** True for one of the seven documents whose current URL is preserved verbatim. */
const isUrlAlias = (relativePath: string): boolean =>
  URL_ALIAS_FILENAMES.has(basenameOf(relativePath));

/**
 * Everything that belongs under `nextjs/public/assets/`: the deployed class,
 * plus the seven aliases. 117 files, 141,969,357 bytes.
 */
const isBundled = (relativePath: string, assetClass: AssetClass): boolean =>
  assetClass === "deployed" || isUrlAlias(relativePath);

/**
 * The filename the bundled copy takes inside `nextjs/public/assets/`.
 *
 * An alias keeps its exact original name — that is what preserves the URL — and
 * every other bundled file uses its normalized name, which is what
 * `nextjs/lib/image.ts` resolves in fallback mode. The two cases cannot overlap
 * in this corpus, because all seven aliases are archived rather than deployed,
 * and the census below asserts that so a future drift is reported rather than
 * quietly serving one name where a reference expects the other.
 */
const bundledPathFor = (
  relativePath: string,
  normalizedPath: string,
  assetClass: AssetClass,
): string | null => {
  if (!isBundled(relativePath, assetClass)) {
    return null;
  }
  return isUrlAlias(relativePath) ? relativePath : normalizedPath;
};

interface DispositionCensus {
  readonly aliases: { files: number; bytes: number };
  readonly bundled: { files: number; bytes: number };
}

/**
 * Tally the aliases and the bundled set, and check each alias individually.
 *
 * Per-file checks matter more than the totals here. Two of the seven could swap
 * sizes and a totals-only check would pass, so every alias is asserted present
 * with its own expected byte count, and asserted to be archived.
 */
const tallyDispositions = (
  assets: readonly InventoriedAsset[],
  classes: ReadonlyMap<string, AssetClass>,
  expectations: Expectation[],
): DispositionCensus => {
  const aliases = emptyTally();
  const bundled = emptyTally();
  const seenAliases = new Map<string, InventoriedAsset>();

  for (const asset of assets) {
    const assetClass = classes.get(asset.relativePath);
    if (assetClass === undefined) {
      throw new Error(
        `internal error: ${asset.relativePath} was measured but never classified`,
      );
    }
    if (isUrlAlias(asset.relativePath)) {
      aliases.files += 1;
      aliases.bytes += asset.sizeBytes;
      seenAliases.set(basenameOf(asset.relativePath), asset);
    }
    if (isBundled(asset.relativePath, assetClass)) {
      bundled.files += 1;
      bundled.bytes += asset.sizeBytes;
    }
  }

  for (const [filename, expectedBytes] of URL_ALIAS_FILENAMES) {
    const found = seenAliases.get(filename);
    if (found === undefined) {
      expectEqual(
        expectations,
        `url alias ${filename}`,
        "absent from the checkout",
        "present",
      );
      continue;
    }
    expectEqual(
      expectations,
      `url alias ${filename} bytes`,
      found.sizeBytes,
      expectedBytes,
    );
    expectEqual(
      expectations,
      `url alias ${filename} class`,
      classes.get(found.relativePath) ?? "unclassified",
      "archived",
    );
  }

  expectEqual(expectations, "url alias files", aliases.files, EXPECTED_ALIASES.files);
  expectEqual(expectations, "url alias bytes", aliases.bytes, EXPECTED_ALIASES.bytes);
  expectEqual(expectations, "bundled files", bundled.files, EXPECTED_BUNDLED.files);
  expectEqual(expectations, "bundled bytes", bundled.bytes, EXPECTED_BUNDLED.bytes);

  return { aliases, bundled };
};

/**
 * The invariant behind the bundled set: it is exactly the deployed class plus
 * the aliases, in both files and bytes. Always fatal, because it is a property
 * of a correct program rather than of one source commit — and because getting it
 * wrong means either shipping an archived document nobody asked for or dropping
 * a URL the school still hands out.
 */
const assertBundledReconciles = (
  classCensus: ClassificationCensus,
  dispositions: DispositionCensus,
): void => {
  const expectedFiles = classCensus.byClass.deployed.files + dispositions.aliases.files;
  const expectedBytes = classCensus.byClass.deployed.bytes + dispositions.aliases.bytes;
  if (
    dispositions.bundled.files !== expectedFiles ||
    dispositions.bundled.bytes !== expectedBytes
  ) {
    throw new Error(
      `the bundled set is not the deployed class plus the aliases: bundled is ${formatCount(dispositions.bundled.files)} files / ${formatCount(dispositions.bundled.bytes)} bytes, against ${formatCount(expectedFiles)} files / ${formatCount(expectedBytes)} bytes from ${formatCount(classCensus.byClass.deployed.files)} deployed and ${formatCount(dispositions.aliases.files)} aliases`,
    );
  }
};


/* ==========================================================================
 * 12. Provenance: which commit was read
 * --------------------------------------------------------------------------
 * Read from the checkout's own git metadata, by reading files rather than by
 * spawning `git`. This project reads the filesystem and spawns nothing, and
 * keeping it that way means the program behaves identically wherever it runs and
 * needs no git binary on the PATH.
 *
 * Three checkout shapes are handled, because README §2.2 offers all three: a
 * normal clone, whose `.git` is a directory; a linked worktree created with
 * `git worktree add --detach <revision>`, whose `.git` is a file pointing at
 * `…/.git/worktrees/<name>` and whose refs live in the common directory; and a
 * `git archive` extraction, which has no git metadata at all. The last one
 * yields null and a note — never a fabricated SHA.
 * ========================================================================== */

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** Read the resolved commit id of a checkout, or null with a note explaining why not. */
const readSourceCommit = async (
  sourceRoot: string,
  runNotes: string[],
): Promise<string | null> => {
  const unresolved = (reason: string): null => {
    runNotes.push(
      `source_commit could not be read (${reason}); provenance for this manifest rests on the checkout the operator supplied`,
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
  const headText = head.trim();
  // A worktree checked out at a revision has a detached HEAD, which holds the id
  // directly. This is the normal case for the procedure README §2.2 describes.
  if (OBJECT_ID.test(headText)) {
    return headText;
  }

  const refMatch = /^ref:\s*(.+)$/.exec(headText);
  const ref = refMatch?.[1]?.trim();
  if (ref === undefined || ref === "") {
    return unresolved(`HEAD is neither an object id nor a ref: ${JSON.stringify(headText)}`);
  }

  // For a linked worktree the refs live in the main repository's git directory,
  // which `commondir` names.
  const commonPointer = await readTextIfExists(join(gitDir, "commondir"));
  const searchRoots =
    commonPointer === null
      ? [gitDir]
      : [gitDir, resolve(gitDir, commonPointer.trim())];

  for (const base of searchRoots) {
    const loose = await readTextIfExists(join(base, ref));
    const value = loose?.trim();
    if (value !== undefined && OBJECT_ID.test(value)) {
      return value;
    }
  }

  for (const base of searchRoots) {
    const packed = await readTextIfExists(join(base, "packed-refs"));
    if (packed === null) {
      continue;
    }
    for (const line of packed.split("\n")) {
      const text = line.trim();
      if (text === "" || text.startsWith("#") || text.startsWith("^")) {
        continue;
      }
      const [objectId, name] = text.split(/\s+/);
      if (name === ref && objectId !== undefined && OBJECT_ID.test(objectId)) {
        return objectId;
      }
    }
  }

  return unresolved(`the ref ${ref} could not be resolved in this checkout`);
};

/* ==========================================================================
 * 13. Assembly and serialization
 * ========================================================================== */

interface AssemblyInput {
  readonly assets: readonly InventoriedAsset[];
  readonly references: ReadonlyMap<string, readonly AssetReference[]>;
  readonly classes: ReadonlyMap<string, AssetClass>;
  readonly filenameMap: ReadonlyMap<string, string>;
  readonly classCensus: ClassificationCensus;
  readonly dispositions: DispositionCensus;
  readonly sidecarCount: number;
  readonly sourceCommit: string | null;
  readonly generatedAt: string;
  readonly runNotes: readonly string[];
  readonly expectations: Expectation[];
}

/**
 * Turn everything measured into the manifest.
 *
 * Every field the committed fallback `assets.json` needs is present, because the
 * extractor reads this file rather than re-deriving a class or a normalized path
 * — that is the invariant in README §5.1, and it is why the entry carries
 * `bucket`, `path` and `legacy_ref` alongside the measurements.
 */
const assembleManifest = (input: AssemblyInput): AssetManifest => {
  const entries: AssetManifestEntry[] = [];
  const focals: (FocalPoint | null)[] = [];
  const extensionCounts = new Map<string, number>();

  for (const asset of input.assets) {
    const assetClass = input.classes.get(asset.relativePath);
    if (assetClass === undefined) {
      throw new Error(
        `internal error: ${asset.relativePath} was measured but never classified`,
      );
    }
    const normalizedPath = input.filenameMap.get(asset.relativePath);
    if (normalizedPath === undefined) {
      throw new Error(
        `internal error: ${asset.relativePath} is missing from the filename map`,
      );
    }

    const focus = focusForAsset(asset);
    focals.push(focus);
    const extension = extensionOf(asset.relativePath);
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);

    entries.push({
      legacy_ref: asset.relativePath,
      source_path: `${ASSET_DIR}/${asset.relativePath}`,
      filename: asset.filename,
      normalized_path: normalizedPath,
      class: assetClass,
      bucket: bucketForClass(assetClass),
      path: objectKeyFor(assetClass, normalizedPath),
      bundled: isBundled(asset.relativePath, assetClass),
      bundled_path: bundledPathFor(asset.relativePath, normalizedPath, assetClass),
      url_alias: isUrlAlias(asset.relativePath),
      size_bytes: asset.sizeBytes,
      sha256: asset.sha256,
      mime: asset.mime,
      sidecar_mime: asset.sidecarMime,
      width: asset.width,
      height: asset.height,
      focus,
      // Never migrated: no sidecar carries alt text. Authoring it for the
      // informative subset is a cutover deliverable and a release gate.
      alt: null,
      referenced_by: input.references.get(asset.relativePath) ?? [],
      notes: asset.notes,
    });
  }

  entries.sort((left, right) => compareStrings(left.source_path, right.source_path));

  const focalSummary = summarizeFocalPoints(focals);
  expectEqual(
    input.expectations,
    "focal points",
    focalSummary.total,
    EXPECTED_FOCAL_POINTS,
  );
  expectEqual(
    input.expectations,
    "focal points with zoom above 1",
    focalSummary.zoomAboveOne,
    EXPECTED_ZOOM_ABOVE_ONE,
  );

  // Sorted plain objects, so the serialized key order is stable across runs and
  // machines rather than dependent on insertion order or on the filesystem.
  const sortedRecord = <T>(source: ReadonlyMap<string, T>): Record<string, T> => {
    const record: Record<string, T> = {};
    for (const key of [...source.keys()].sort(compareStrings)) {
      const value = source.get(key);
      if (value !== undefined) {
        record[key] = value;
      }
    }
    return record;
  };

  return {
    generated_at: input.generatedAt,
    generator: GENERATOR,
    source_commit: input.sourceCommit,
    counts: {
      total: input.classCensus.total,
      by_class: input.classCensus.byClass,
      by_extension: sortedRecord(extensionCounts),
      bundled: input.dispositions.bundled,
      url_aliases: input.dispositions.aliases,
      sidecars: input.sidecarCount,
      focal_points: {
        total: focalSummary.total,
        zoom_above_one: focalSummary.zoomAboveOne,
      },
      references: {
        content: input.classCensus.contentReferenced,
        template_or_stylesheet: input.classCensus.templateReferenced.length,
        unreferenced: input.classCensus.unreferenced,
      },
    },
    filename_map: sortedRecord(input.filenameMap),
    notes: [...input.runNotes],
    assets: entries,
  };
};

/** Two-space indent and a trailing newline: reviewable, and stable byte for byte. */
const serializeManifest = (manifest: AssetManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/**
 * The stamp. `SOURCE_DATE_EPOCH` is honoured for a reproducible build; otherwise
 * the clock is used, and `writeManifest` keeps the previous value when nothing
 * else changed.
 */
const resolveGeneratedAt = (): string => {
  const epoch = process.env["SOURCE_DATE_EPOCH"]?.trim();
  if (epoch !== undefined && /^\d+$/.test(epoch)) {
    return new Date(Number(epoch) * 1000).toISOString();
  }
  return new Date().toISOString();
};

/**
 * Write the manifest, reusing the previous timestamp when the content is
 * otherwise unchanged.
 *
 * That reconciles two requirements that would otherwise contradict each other:
 * the manifest carries a `generated_at` stamp, and a re-run must produce a
 * byte-identical file so that a real change is the only thing a diff shows. A
 * wall-clock stamp rewritten on every run would defeat the second, and dropping
 * the field would defeat the first. So the stamp means "when this content was
 * first generated", which is the more useful of the two readings anyway.
 */
const writeManifest = async (
  outPath: string,
  manifest: AssetManifest,
): Promise<{ readonly bytes: number; readonly reusedStamp: boolean }> => {
  let text = serializeManifest(manifest);
  let reusedStamp = false;

  const previous = await readTextIfExists(outPath);
  if (previous !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(previous);
    } catch {
      parsed = null;
    }
    const previousStamp = isRecord(parsed)
      ? asNonEmptyString(parsed["generated_at"])
      : null;
    if (previousStamp !== null) {
      const rebased = serializeManifest({
        ...manifest,
        generated_at: previousStamp,
      });
      if (rebased === previous) {
        text = rebased;
        reusedStamp = true;
      }
    }
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, "utf8");
  return { bytes: Buffer.byteLength(text, "utf8"), reusedStamp };
};


/* ==========================================================================
 * 14. The summary
 * --------------------------------------------------------------------------
 * stdout is this program's interface, which is why `no-console` is deliberately
 * off in `tools/eslint.config.mjs`. The summary is what an operator reads to
 * decide whether the run is trustworthy, so it states the numbers a reviewer
 * would otherwise have to grep the manifest for.
 * ========================================================================== */

/** How many asset notes to print before deferring to the manifest. */
const MAX_PRINTED_NOTES = 25;

const tallyRow = (label: string, tally: AssetTally): string =>
  `  ${label.padEnd(12)}${formatCount(tally.files).padStart(6)}  ${formatCount(tally.bytes).padStart(13)}`;

const printSummary = (
  manifest: AssetManifest,
  outPath: string,
  reusedStamp: boolean,
  bytesWritten: number,
): void => {
  const counts = manifest.counts;
  console.log("");
  console.log("  class          files          bytes");
  console.log("  ------------------------------------");
  console.log(tallyRow("deployed", counts.by_class.deployed));
  console.log(tallyRow("draft-only", counts.by_class.draft_only));
  console.log(tallyRow("archived", counts.by_class.archived));
  console.log("  ------------------------------------");
  console.log(tallyRow("total", counts.total));
  console.log("");
  console.log(tallyRow("url aliases", counts.url_aliases));
  console.log(tallyRow("bundled", counts.bundled));
  console.log("");
  console.log(
    `  sidecars                ${formatCount(counts.sidecars)}`,
  );
  console.log(
    `  focal points            ${formatCount(counts.focal_points.total)} (${formatCount(counts.focal_points.zoom_above_one)} with a zoom above 1)`,
  );
  console.log(
    `  references              ${formatCount(counts.references.content)} content, ${formatCount(counts.references.template_or_stylesheet)} template or stylesheet, ${formatCount(counts.references.unreferenced)} unreferenced`,
  );
  console.log(
    `  source commit           ${manifest.source_commit ?? "unresolved (see notes)"}`,
  );

  const noted = manifest.assets.filter((asset) => asset.notes.length > 0);
  console.log(
    `  recorded notes          ${formatCount(manifest.notes.length)} run-level, ${formatCount(noted.length)} assets`,
  );
  for (const note of manifest.notes) {
    console.log(`    - ${note}`);
  }
  const totalAssetNotes = noted.reduce(
    (total, entry) => total + entry.notes.length,
    0,
  );
  let printed = 0;
  for (const asset of noted) {
    for (const note of asset.notes) {
      if (printed >= MAX_PRINTED_NOTES) {
        break;
      }
      console.log(`    - ${asset.filename}: ${note}`);
      printed += 1;
    }
    if (printed >= MAX_PRINTED_NOTES) {
      break;
    }
  }
  // Only mention a remainder when there is one: a corpus with exactly
  // MAX_PRINTED_NOTES notes must not be told that nothing further awaits it.
  const unprinted = totalAssetNotes - printed;
  if (unprinted > 0) {
    console.log(
      `    … ${formatCount(unprinted)} further ${unprinted === 1 ? "note is" : "notes are"} in the manifest`,
    );
  }

  console.log("");
  console.log(
    `  wrote ${outPath} (${formatCount(bytesWritten)} bytes)${reusedStamp ? ", byte-identical to the previous run" : ""}`,
  );
  console.log("");
};

/** Render the collected expectation mismatches as an aligned block. */
const formatExpectations = (failures: readonly Expectation[]): string => {
  const width = failures.reduce(
    (longest, failure) => Math.max(longest, failure.label.length),
    0,
  );
  return failures
    .map(
      (failure) =>
        `  ${failure.label.padEnd(width)}  expected ${failure.expected}, measured ${failure.actual}`,
    )
    .join("\n");
};

/* ==========================================================================
 * 15. main
 * ========================================================================== */

/**
 * Build the manifest for one Statamic checkout.
 *
 * Exported so a caller — a test, or a future orchestrator — can run the whole
 * program without a subprocess. Every side effect in this module lives here or
 * below it.
 */
export const main = async (argv: readonly string[]): Promise<void> => {
  const options = parseOptions(argv);

  // README §2.1: the program refuses a directory that does not hold `content/`,
  // because the most likely mistake is pointing it at a subdirectory or at this
  // repository, where the legacy tree no longer exists.
  if (!(await isDirectory(options.sourceRoot))) {
    throw new UsageError(
      `--source ${options.sourceRoot} is not a directory. See tools/README.md section 2.2 for how to materialise a legacy revision with \`git worktree add\`.`,
    );
  }
  if (!(await isDirectory(join(options.sourceRoot, "content")))) {
    throw new UsageError(
      `--source ${options.sourceRoot} does not contain content/, so it is not the root of a Statamic checkout. See tools/README.md section 2.1.`,
    );
  }

  console.log(`  source   ${options.sourceRoot}`);
  console.log(`  out      ${options.outPath}`);

  const expectations: Expectation[] = [];
  const runNotes: string[] = [];

  const sourceCommit = await readSourceCommit(options.sourceRoot, runNotes);
  const inventory = await inventoryAssets(options.sourceRoot, expectations);
  runNotes.push(...inventory.runNotes);

  const corpus = await loadScanCorpus(options.sourceRoot, expectations, runNotes);
  const references = scanReferences(inventory.assets, corpus);
  const classes = classifyAssets(
    inventory.assets.map((asset) => ({
      relativePath: asset.relativePath,
      references: references.get(asset.relativePath) ?? [],
    })),
  );

  // Invariants first. Each of these is fatal whatever `--allow-census-drift`
  // says, because a failure means this program is wrong rather than that the
  // checkout is unexpected.
  const classCensus = tallyClassification(inventory.assets, references, classes);
  assertClassesReconcile(classCensus);
  expectClassification(classCensus, expectations);

  const dispositions = tallyDispositions(inventory.assets, classes, expectations);
  assertBundledReconciles(classCensus, dispositions);

  const filenameMap = buildFilenameMap(
    inventory.assets.map((asset) => asset.relativePath),
  );
  assertInjective(filenameMap);

  const manifest = assembleManifest({
    assets: inventory.assets,
    references,
    classes,
    filenameMap,
    classCensus,
    dispositions,
    sidecarCount: inventory.sidecarCount,
    sourceCommit,
    generatedAt: resolveGeneratedAt(),
    runNotes,
    expectations,
  });

  // Now the census. A mismatch normally means the checkout is not the tree this
  // migration was planned against, which is a hard failure; the waiver exists
  // for the re-run against a newer commit that README §2.3 describes, where the
  // numbers legitimately move.
  const driftNotes: string[] = [];
  if (expectations.length > 0) {
    const block = formatExpectations(expectations);
    if (!options.allowCensusDrift) {
      throw new Error(
        `the checkout does not match the reference census for revision ${REFERENCE_REVISION}:\n${block}\nIf this is the deliberate re-run against a newer source commit described in tools/README.md section 2.3, pass --allow-census-drift. Otherwise check that --source names the right tree.`,
      );
    }
    console.log("");
    console.log(
      `  WARNING: ${formatCount(expectations.length)} deviations from the reference census, waived by --allow-census-drift:`,
    );
    console.log(block);
    for (const failure of expectations) {
      driftNotes.push(
        `census drift waived: ${failure.label} — expected ${failure.expected}, measured ${failure.actual}`,
      );
    }
  }

  // A waived deviation belongs in the manifest as well as on the terminal: the
  // artifact is committed, and a reader months later has only the file.
  const published: AssetManifest =
    driftNotes.length === 0
      ? manifest
      : { ...manifest, notes: [...manifest.notes, ...driftNotes] };

  const written = await writeManifest(options.outPath, published);
  printSummary(published, options.outPath, written.reusedStamp, written.bytes);
};

/* ==========================================================================
 * 16. The executed-as-main guard
 * --------------------------------------------------------------------------
 * Load-bearing rather than stylistic. Three sibling programs —
 * `extract-statamic-content.ts`, `upload-assets.ts` and `verify-parity.ts` —
 * import this module for its types and helpers, and `tools/tests/**` imports the
 * pure functions directly. Without this guard, every one of those imports would
 * run a filesystem scan over 362,904,172 bytes.
 *
 * It is also why it sits last: the guard runs at module-evaluation time, so every
 * declaration it reaches must already be initialised.
 * ========================================================================== */

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`\n  ${error.message}\n`);
      console.error(USAGE);
      // 2 for a bad invocation, so a scripted caller can tell it from a failed run.
      process.exit(2);
    }
    console.error(`\n  FAILED: ${describeError(error)}\n`);
    process.exit(1);
  }
}

