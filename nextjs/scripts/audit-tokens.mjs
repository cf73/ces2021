/**
 * `npm run audit:tokens` — the post-generation design-token audit.
 *
 * ## Authority
 *
 * No user-specified rules were provided for this project: `review_rules`
 * returns `No user rules provided.`, and §0.8 of the technical specification
 * states the same independently. Nothing in this file originates from a project
 * rule document, and nothing here may be described as a "user rule". The
 * absence of rules is not licence to lower the bar, so this audit is held to
 * the specification and to enterprise-standard practice. Its governing sections
 * are:
 *
 *   §0.3.5  "Precedence and Non-Negotiable Rules" — the literal specification
 *           of this script, and the scope exemption that makes it necessary.
 *   §0.3.3  The closed token contract, including the two-layer `:root` +
 *           `@theme inline` declaration mechanism this file must parse.
 *   §0.3.4  The five authored `components/ui/` files and why each is authored
 *           rather than generated.
 *
 * ## Why this script exists: the asymmetry is the whole design
 *
 * §0.3.5 scopes the "zero hardcoded values" rule to authored code and
 * deliberately exempts unmodified registry output: "Unmodified shadcn output
 * contains arbitrary values by design — `ring-[3px]`, `text-[0.8rem]`, internal
 * flex and grid utilities — and a rule that forbade them would require
 * rewriting every generated file, which defeats the point of pinning the
 * registry and makes the next `shadcn add` a merge conflict."
 *
 * Generated files are governed instead by this audit, whose behaviour §0.3.5
 * states verbatim: it "walks `components/ui/**`, lists every arbitrary value
 * and every colour literal, and fails if one appears in an authored file or if
 * a colour literal appears in a generated one — colour being the axis where a
 * stray literal breaks the brand contract, unlike a 3 px focus ring". §0.3.5
 * adds a second obligation: "every `--size-*`, `--space-*`, `--radius-*`,
 * `--shadow-*` and `--text-*` reference anywhere in the tree resolves to a
 * declared token, so a future addition cannot be made silently."
 *
 * The resulting matrix, implemented exactly:
 *
 *   | Finding                                  | authored | generated    |
 *   | ---------------------------------------- | -------- | ------------ |
 *   | Arbitrary value, e.g. `text-[0.8rem]`    | FAIL     | inventoried  |
 *   | Colour literal, e.g. `bg-[#fff]`, white  | FAIL     | FAIL         |
 *   | Unresolved `var(--size-*)` reference     | FAIL     | FAIL         |
 *
 * A non-colour arbitrary value in a generated file is recorded and reported as
 * a permitted finding, not a failure. That is intentional, not a bug.
 *
 * ## The one non-negotiable
 *
 * This script may not weaken a threshold to make a run green. It reports the
 * measured value instead. Consequently it has, and must never gain:
 *
 *   - no violations allowlist, suppression file, ignore comment or baseline;
 *     the authored/generated asymmetry above is the only differentiation, and
 *     it comes from §0.3.5 rather than being an escape hatch;
 *   - no environment variable and no flag that downgrades a failure to a
 *     warning — the only environment read is cosmetic colour control;
 *   - no "fix" mode. This is an audit. The single file it writes is the
 *     inventory it owns; it never modifies a scanned file;
 *   - no skipped file and no silent tolerance for a file it cannot parse — an
 *     unparseable file is a failure, and every `catch` below rethrows or fails.
 *
 * ## Deliberate scope limits, each with its reason
 *
 * Utility class names are NOT resolved back to tokens: `rounded-md` is not
 * mapped to `--radius-md`, nor `bg-background` to `--color-background`. That
 * would mean reimplementing Tailwind's resolver. It is safe to omit because
 * Tailwind 4 already enforces that path — §0.3.3: "a colour utility such as
 * `bg-background` exists only if a `--color-*` entry exists in the theme; a
 * bare `--background` custom property creates no utility at all" — so an
 * undeclared token produces no utility and the build fails on its own. This
 * script covers the literal-reference path Tailwind cannot see.
 *
 * Detection runs over the contents of string and template literals, after
 * comments have been masked. A CSS value can only reach the browser through a
 * string, and this codebase documents itself heavily: a header comment quoting
 * `oklch(55% 0.162 140.6)` must not fail the audit, or someone would weaken
 * the audit.
 *
 * `app/globals.css` is exempt from the literal ban and from the arbitrary-value
 * ban, because that file *is* the token definition — every `oklch()` value, the
 * `#fff8d4` warmth palette and the three `--gradient-event` stops legitimately
 * live there. It is still parsed as the sole source of declared tokens, and its
 * own `var()` references still have to resolve.
 *
 * ## Output
 *
 * The human report goes to stdout; diagnostics go to stderr. Exit 0 only when
 * every scan is clean, no structural (anti-vacuous-pass) condition tripped and,
 * under `--check`, the committed inventory matches byte for byte. Exit 1
 * otherwise.
 *
 * The `.mjs` extension is load-bearing: `package.json` does not set
 * `"type": "module"`, so the extension — not a package field — is what makes
 * `import` correct here. `tsconfig.json` includes only `.ts`/`.tsx`, so this
 * file is deliberately outside `tsc --noEmit`; do not convert it to TypeScript
 * and do not add a `.d.ts`. Only `node:` builtins are imported: the project
 * declares no CSS parser and no AST tool, and this script must not add one.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { parseArgs } from "node:util";

/* ==========================================================================
 * Constants
 * ========================================================================== */

/**
 * Bumped whenever the inventory's shape changes, so a reviewer reading a diff
 * can tell a shape change from a content change.
 */
const SCHEMA_VERSION = 1;

/** The inventory this script owns, relative to the audited root. */
const INVENTORY_RELATIVE_PATH = "scripts/token-audit-inventory.json";

/**
 * The five files in `components/ui/` that this project authors rather than
 * generates (§0.3.4). Everything else in that directory is `shadcn add`
 * output. Each is authored for a stated reason; the reasons are recorded here
 * so a future maintainer does not "correct" the list.
 *
 * §0.3.5 fixes the directory at "43 files in `nextjs/components/ui/` — 38
 * generated from the registry, 5 authored".
 */
const AUTHORED_UI_FILES = [
  // The registry has no dropzone or file-drop primitive, and Radix exposes
  // none — the one genuine absence in the system.
  "dropzone.tsx",
  // The registry has no general layout primitive (Grid, Stack, Flex,
  // Container), which is what makes the no-hand-rolled-layout rule
  // enforceable at all.
  "layout.tsx",
  // shadcn/ui's Typography page is a documentation recipe, not an installable
  // registry item.
  "typography.tsx",
  // Documented as a composition of Popover + Calendar + Button, not a single
  // registry item.
  "date-picker.tsx",
  // Documented as a composition of Table + @tanstack/react-table, not a
  // registry item.
  "data-table.tsx",
];

/**
 * The expected file count in `components/ui/`. A mismatch is reported as an
 * anomaly worth reviewing, NOT a failure: §0.3.1 confirms registry membership
 * against the pinned CLI at generation time, so a legitimate drift in the
 * generated set is possible. The five authored names above are fixed by the
 * specification, and their absence *is* a failure.
 */
const EXPECTED_UI_FILE_COUNT = 43;

/**
 * The complete closed list of permitted literals from §0.3.5, and nothing
 * else. Compared case-insensitively, because CSS keywords are
 * case-insensitive. The `--gradient-event` stops are permitted only inside
 * that token's own definition, which lives in `app/globals.css` — a file
 * exempted wholesale below — so no gradient-stop literal is ever legitimate in
 * the files these scans police.
 */
const PERMITTED_LITERALS = new Set([
  "0",
  "none",
  "auto",
  "inherit",
  "currentcolor",
  "transparent",
]);

/**
 * Colour keywords that are permitted literals and must therefore never be
 * reported by the colour detector. `current` is Tailwind's spelling of
 * `currentColor` (`text-current`, `border-current`).
 */
const PERMITTED_COLOUR_KEYWORDS = new Set([
  "transparent",
  "currentcolor",
  "current",
]);

/**
 * The CSS named colours. `white` is the single most likely detector gap and it
 * is not hypothetical: the legacy source carries `color: white`
 * (`resources/sass/typography.scss:12`) and `background-color: white`
 * (`resources/sass/elements.scss:41`). `white` is not on §0.3.5's permitted
 * list and it *is* available as a token (`--card`, `--primary-foreground` are
 * both `oklch(100% 0 0)`), so `bg-white` / `text-white` / `border-white` are
 * violations. The full set is listed rather than just white and black, because
 * a partial list is a gap by construction.
 */
const CSS_NAMED_COLOURS = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);

/**
 * Tailwind's built-in palette families. A raw palette utility such as
 * `bg-stone-100` or `text-slate-500` bypasses the brand contract: §0.3.3's
 * token set is closed, and `baseColor: stone` supplies the neutral ramp
 * *through* the semantic tokens (`--muted`, `--border`, `--input`), not through
 * raw palette utilities. That is exactly the axis §0.3.5 says must fail even in
 * generated files.
 */
const TAILWIND_PALETTES = new Set([
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);

/**
 * The token namespaces whose references must resolve (§0.3.5).
 *
 * Both `--space-` and `--spacing-` are checked, and that reconciles a genuine
 * wording discrepancy in the specification rather than silently resolving it
 * one way: §0.3.5 names the check over "`--space-*`", while §0.3.3's actually
 * declared spacing tokens use the Tailwind namespace `--spacing-*`
 * (`--spacing-45`, `--spacing-75`, `--spacing-110`), because Tailwind 4
 * generates spacing utilities from that namespace directly. Covering both
 * prefixes honours the wording and the reality at once. Do not "tidy" one away.
 */
const CHECKED_TOKEN_NAMESPACES = [
  "--size-",
  "--space-",
  "--spacing-",
  "--radius-",
  "--shadow-",
  "--text-",
];

/** The stylesheet that declares every token, relative to the audited root. */
const GLOBALS_CSS_RELATIVE_PATH = "app/globals.css";

/** Scan A: the registry directory, where the authored/generated split lives. */
const UI_DIRECTORY_RELATIVE_PATH = "components/ui";

/**
 * Scan B: the directories §0.3.5 names in its first non-negotiable bullet —
 * "Every CSS property value in `app/**`, `components/site/**`,
 * `components/templates/**` and `components/cms/**` resolves to a token".
 * Every file here is authored by definition, so the authored ruleset applies:
 * an arbitrary value fails and a colour literal fails.
 *
 * `components/cms/**` is deliberately included. §0.3.5 names it, and the edit
 * chrome is exactly where improvised pixel values would otherwise accumulate.
 */
const AUTHORED_SCAN_ROOTS = [
  "app",
  "components/site",
  "components/templates",
  "components/cms",
];

/**
 * Scan C also reads these, for token references only. `hooks/**` and `lib/**`
 * are named by the specification. `app/api/**` is reached through the `app`
 * walk above with literal scanning disabled, so it too contributes references —
 * a deliberate strengthening, since §0.3.5 states the reference check over the
 * whole tree.
 */
const REFERENCE_ONLY_SCAN_ROOTS = ["hooks", "lib"];

/**
 * Directory names skipped everywhere, each because it cannot contain authored
 * styling for the shipped site:
 *   node_modules, .next, out, build   — dependencies and build output;
 *   .git                             — version-control metadata;
 *   coverage, playwright-report,
 *   test-results, .lighthouseci      — generated test and audit output;
 *   tests                            — the suite asserts behaviour and is not
 *                                      shipped styling;
 *   scripts                          — this audit's own source contains every
 *                                      token-namespace prefix as a detector
 *                                      pattern, so scanning it would be
 *                                      circular and would guarantee false
 *                                      findings. It contains no CSS.
 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".lighthouseci",
  ".next",
  "build",
  "coverage",
  "node_modules",
  "out",
  "playwright-report",
  "scripts",
  "test-results",
  "tests",
]);

/**
 * Paths (relative to the audited root, POSIX separators) excluded from literal
 * scanning while remaining in scope for token references. `app/api/**` holds
 * Route Handlers, which return data rather than markup and carry no CSS
 * property values.
 */
const LITERAL_SCAN_EXCLUDED_PREFIXES = ["app/api/"];

/** Extensions carrying markup, class strings or inline styles. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Stylesheets. Only `app/globals.css` is expected; any other is an anomaly. */
const STYLE_EXTENSIONS = new Set([".css"]);

/* --------------------------------------------------------------------------
 * Colour-notation patterns
 *
 * A hex-only regex is insufficient. The legacy token layer uses five distinct
 * notations, verified in the source rather than assumed:
 *   6-digit hex            resources/sass/colors.scss  (#fff3e5, #edecdf)
 *   8-digit hex with alpha resources/sass/colors.scss:15 (#de1237d6)
 *   space-slash rgb()      resources/sass/colors.scss:25 (rgb(165 197 68 / 84%))
 *   comma rgba()           resources/sass/elements.scss:57 (rgba(14,226,211,1))
 *   hsla()                 resources/sass/colors.scss:28
 * plus the bare named colour `white`, which a hex-only detector would miss
 * entirely.
 * -------------------------------------------------------------------------- */

/**
 * Hex colours at 3, 4, 6 and 8 digits. The alternation is ordered longest
 * first so `#de1237d6` is captured whole rather than as `#de1237` followed by
 * stray digits, and the trailing boundary rejects a 5- or 7-digit run that is
 * not a colour at all.
 */
const HEX_COLOUR_PATTERN =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;

/**
 * Functional colour notations. Both argument syntaxes are covered by matching
 * the function name and its opening parenthesis: the legacy comma form and the
 * modern space-slash form differ only inside the parentheses. `color-mix`
 * precedes `color` in the alternation so the longer name wins, and `oklch`,
 * `oklab` precede `lch`, `lab` for the same reason — though `\b` would reject
 * the short forms inside them regardless.
 */
const COLOUR_FUNCTION_PATTERN =
  /\b(?:color-mix|oklch|oklab|rgba|rgb|hsla|hsl|hwb|lch|lab|color)\(/g;

/** `var(--token)`, however spaced. The canonical form of a token reference. */
const VAR_REFERENCE_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * Tailwind 4's shorthand for the same thing: `bg-(--brand)` and
 * `text-(length:--headline)` are equivalent to the bracketed `var()` form, so
 * they are references and not arbitrary values.
 */
const TAILWIND_VAR_SHORTHAND_PATTERN =
  /-\((?:[a-zA-Z-]+:)?(--[A-Za-z0-9_-]+)\)/g;

/** A bracket group whose entire content is a single permitted `var()` call. */
const PURE_VAR_BRACKET_PATTERN =
  /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)$/;

/** `<palette>-<shade>`, e.g. `stone-100`. Shades are two or three digits. */
const PALETTE_SHADE_PATTERN = /^([a-z]+)-(\d{2,3})$/;

/* ==========================================================================
 * Deterministic utilities
 *
 * Determinism is the point of the committed inventory: a diff is only
 * reviewable if identical inputs produce identical bytes.
 * ========================================================================== */

/**
 * A byte-order comparator. `Array.prototype.sort` without a comparator, and
 * `String.prototype.localeCompare`, are both locale-sensitive and would make
 * the inventory depend on the machine that produced it. This does not.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareAscii(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sort a list of strings into a stable, unique, locale-independent order.
 *
 * @param {Iterable<string>} values
 * @returns {string[]}
 */
function sortedUnique(values) {
  return [...new Set(values)].sort(compareAscii);
}

/**
 * Convert an absolute path into a root-relative POSIX path. The inventory must
 * carry no absolute path, no machine name and no separator that varies by
 * platform.
 *
 * @param {string} root
 * @param {string} absolutePath
 * @returns {string}
 */
function toRelativePosix(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

/**
 * Recursively rebuild a value with every object key in ASCII order, so
 * `JSON.stringify` emits a canonical form regardless of insertion order.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(value).sort(compareAscii)) {
      result[key] = canonicalise(
        /** @type {Record<string, unknown>} */ (value)[key],
      );
    }
    return result;
  }
  return value;
}

/**
 * Serialise the inventory: canonical key order, two-space indent, LF endings
 * and exactly one trailing newline.
 *
 * @param {unknown} value
 * @returns {string}
 */
function serialiseInventory(value) {
  return `${JSON.stringify(canonicalise(value), null, 2)}\n`;
}

/**
 * Build an index of line-start offsets so a character offset can be turned
 * into a 1-based line number.
 *
 * @param {string} text
 * @returns {number[]}
 */
function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Resolve a character offset to a 1-based line number by binary search.
 *
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {number}
 */
function lineAtOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/* ==========================================================================
 * Command line
 * ========================================================================== */

const USAGE = `Usage: node scripts/audit-tokens.mjs [options]

The post-generation design-token audit (technical specification §0.3.5).

Walks components/ui/** and the authored application tree, lists every
arbitrary Tailwind value and every colour literal, and fails when one appears
in an authored file or when a colour literal appears in a generated one. Also
asserts that every --size-*, --space-*, --spacing-*, --radius-*, --shadow-* and
--text-* reference resolves to a token declared in app/globals.css.

Options:
  --check          Verify the committed ${INVENTORY_RELATIVE_PATH}
                   matches what this run computes, and fail on any drift.
                   Nothing is written in this mode. The full audit still runs
                   and still fails on violations independently of the drift
                   check.
  --json <path>    Additionally write a machine-readable report, including line
                   numbers and the violation list, to <path>. Not committed, so
                   this report may carry detail the inventory deliberately
                   omits.
  --root <path>    Audit a different tree. Intended for testing this script
                   against fixtures; it changes where files are read from and
                   cannot relax any check.
  --help           Print this message and exit 0.

Exit codes:
  0  Every scan clean, no structural failure, and (with --check) no drift.
  1  Any violation, any unparseable file, any structural failure, or drift.

This audit never modifies a scanned file. The only file it writes is the
inventory named above, which is committed deliberately so that a diff after a
registry upgrade is reviewable — never add it to .gitignore.
`;

/**
 * A fatal condition. Carrying its own type keeps the top-level handler honest:
 * everything it catches is either an `AuditFailure` it reports and exits 1 on,
 * or an unexpected error it also exits 1 on. Nothing is downgraded.
 */
class AuditFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AuditFailure";
  }
}

/**
 * Parse the command line. `strict: true` is deliberate: an unrecognised or
 * misspelled flag must abort rather than being ignored, because a silently
 * ignored `--check` would turn a drift failure into a pass.
 *
 * @param {string[]} argv
 * @returns {{ check: boolean, help: boolean, json: string | undefined, root: string | undefined }}
 */
function parseCommandLine(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        check: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        json: { type: "string" },
        root: { type: "string" },
      },
    });
  } catch (error) {
    // Rethrown as a fatal, reported error rather than swallowed: an
    // unparseable command line is a failure, never a default-behaviour run.
    const message = error instanceof Error ? error.message : String(error);
    throw new AuditFailure(`Invalid command line: ${message}\n\n${USAGE}`);
  }

  const values = /** @type {Record<string, unknown>} */ (parsed.values);
  return {
    check: values.check === true,
    help: values.help === true,
    json: typeof values.json === "string" ? values.json : undefined,
    root: typeof values.root === "string" ? values.root : undefined,
  };
}

/* --------------------------------------------------------------------------
 * The only environment read in this file, and it is cosmetic.
 *
 * Colour is applied to the report when the stream is a TTY, honouring the
 * NO_COLOR and FORCE_COLOR conventions. No environment variable in this script
 * can affect which findings are produced, how they are classified, or the exit
 * code — §0.3.5's contract is not configurable.
 * -------------------------------------------------------------------------- */
const USE_COLOUR = (() => {
  const env = process.env;
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
  if (typeof env.FORCE_COLOR === "string" && env.FORCE_COLOR !== "0") {
    return true;
  }
  return process.stdout.isTTY === true;
})();

/**
 * Wrap text in an ANSI colour when the stream supports it.
 *
 * @param {"red" | "yellow" | "green" | "dim" | "bold"} style
 * @param {string} text
 * @returns {string}
 */
function paint(style, text) {
  if (!USE_COLOUR) return text;
  const codes = { red: 31, yellow: 33, green: 32, dim: 2, bold: 1 };
  return `\u001B[${codes[style]}m${text}\u001B[0m`;
}

/* ==========================================================================
 * Phase 3 — the declared-token set, parsed from app/globals.css
 *
 * The token list is never hardcoded. That is what makes §0.3.5's promise —
 * "a future addition cannot be made silently" — actually true: adding a token
 * means adding it to app/globals.css, this audit then accepts references to
 * it, and the committed inventory diff makes the addition visible.
 *
 * app/globals.css is the ONLY source, because the project has no JavaScript
 * Tailwind config at all: components.json sets `tailwind.config` to the empty
 * string, and §0.3.3 states "There is no `tailwind.config.js` and no `@config`
 * directive." (The legacy tailwind.config.js had an empty `theme.extend` and
 * Tailwind was not even in the live build pipeline, so no token has ever come
 * from a JS config on this project.)
 * ========================================================================== */

/**
 * Blank out `/* … *\/` comments, preserving both length and line breaks so
 * offsets and line numbers stay exact. Quoted strings are skipped so a `/*`
 * inside a `content: "…"` value or a `url("…")` cannot open a phantom comment.
 *
 * @param {string} css
 * @returns {string}
 */
function maskCssComments(css) {
  const out = css.split("");
  let index = 0;
  /** @type {'"' | "'" | null} */
  let quote = null;

  while (index < css.length) {
    const char = css[index];

    if (quote !== null) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = /** @type {'"' | "'"} */ (char);
      index += 1;
      continue;
    }

    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let i = index; i < stop; i += 1) {
        if (out[i] !== "\n") out[i] = " ";
      }
      index = stop;
      continue;
    }

    index += 1;
  }

  return out.join("");
}

/**
 * Does a block prelude open a token-declaring block?
 *
 * §0.3.3 describes exactly three:
 *   `:root { … }`          the semantic values (`--background`, `--foreground`,
 *                          `--primary`, `--border`, `--ring`, the sidebar set,
 *                          the warmth palette, `--gradient-event`, …);
 *   `@theme inline { … }`  the alias layer, one `--color-*` per semantic value,
 *                          which is what makes the utilities resolve;
 *   `@theme { … }`         the namespaces declared directly with no alias —
 *                          `--radius-*`, `--font-*`, `--text-*`,
 *                          `--breakpoint-*`, `--spacing-*`, `--shadow-*`,
 *                          `--aspect-*`, `--ease-*`, `--z-*` — "because those
 *                          namespaces generate their utilities directly".
 *
 * A `:root` nested inside `@layer base` or a media query still counts, because
 * the check runs against every prelude on the current block stack.
 *
 * @param {string} prelude
 * @returns {boolean}
 */
function preludeDeclaresTokens(prelude) {
  const normalised = prelude.replace(/\s+/g, " ").trim();
  if (normalised.startsWith("@theme")) return true;
  // `:root`, `:root:where(…)`, `html, :root` — a selector list containing the
  // root pseudo-class. The boundary check stops a hypothetical `:rootish`.
  return /(^|[\s,>+~])(:root)(\b|[\s,{:])/.test(`${normalised} `);
}

/**
 * Parse `app/globals.css` into the set of declared custom-property names.
 *
 * The scanner is deliberately defensive: comments are masked first; quoted
 * strings and parentheses are tracked so a `;` inside `url(…)` or a
 * `linear-gradient(…)` cannot split a declaration; brace depth is tracked with
 * a stack of preludes so a nested at-rule does not confuse block boundaries;
 * multi-line values are handled because the buffer simply accumulates; and a
 * final declaration with no trailing semicolon before `}` is flushed on the
 * closing brace.
 *
 * Only names are recorded, never values. §0.6.6 already assigns "token/contrast
 * assertions" to the `unit` job — that is where values belong. Recording them
 * here would churn the committed inventory on every colour tweak.
 *
 * @param {string} css
 * @returns {{ declared: Set<string>, strayDeclarations: string[] }}
 */
function parseDeclaredTokens(css) {
  const masked = maskCssComments(css);
  const declared = new Set();
  /** @type {string[]} */
  const strayDeclarations = [];
  /** @type {string[]} */
  const stack = [];

  let prelude = "";
  let buffer = "";
  let parenDepth = 0;
  /** @type {'"' | "'" | null} */
  let quote = null;

  /** Record whatever the buffer holds, if it is a custom-property declaration. */
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (!text.startsWith("--")) return;
    const colon = text.indexOf(":");
    if (colon === -1) return;
    const name = text.slice(0, colon).trim();
    if (!/^--[A-Za-z0-9_-]+$/.test(name)) return;
    if (stack.some(preludeDeclaresTokens)) {
      declared.add(name);
    } else {
      // A custom property declared outside :root and @theme is scoped to that
      // selector rather than being a design token. Reported as an anomaly so it
      // is visible, never silently treated as a declared token.
      strayDeclarations.push(name);
    }
  };

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];

    if (quote !== null) {
      buffer += char;
      if (char === "\\") {
        buffer += masked[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = /** @type {'"' | "'"} */ (char);
      buffer += char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      buffer += char;
      continue;
    }

    if (char === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      buffer += char;
      continue;
    }

    if (parenDepth > 0) {
      buffer += char;
      continue;
    }

    if (char === "{") {
      stack.push(buffer.trim() || prelude);
      buffer = "";
      continue;
    }

    if (char === "}") {
      flush();
      stack.pop();
      continue;
    }

    if (char === ";") {
      flush();
      continue;
    }

    buffer += char;
  }

  // Anything left at end of file: a trailing declaration with neither a
  // semicolon nor a closing brace. Flushed rather than dropped.
  flush();

  // References are deliberately not returned here. `app/globals.css` is scanned
  // as a file in its own right below, so its `var()` references reach the
  // resolution check through the same path as every other file's rather than
  // through a second, divergent one.
  return { declared, strayDeclarations: sortedUnique(strayDeclarations) };
}

/**
 * Every `var(--token)` reference in a block of text, in source order.
 *
 * Only `var()` (and Tailwind 4's equivalent `-(--token)` shorthand) counts as a
 * reference. A bare `--token` occurrence is deliberately not treated as one: in
 * an inline style object `style={{ "--index": i }}` it is a local declaration,
 * and flagging that as an unresolved reference would be a false failure.
 *
 * @param {string} text
 * @param {number} [baseOffset] Absolute offset of `text` in its file.
 * @returns {Array<{ name: string, offset: number }>}
 */
function collectVarReferences(text, baseOffset = 0) {
  /** @type {Array<{ name: string, offset: number }>} */
  const found = [];
  for (const pattern of [
    VAR_REFERENCE_PATTERN,
    TAILWIND_VAR_SHORTHAND_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push({ name: match[1], offset: baseOffset + match.index });
    }
  }
  return found;
}

/** Is this token name inside one of the namespaces whose references must resolve? */
function isCheckedNamespace(name) {
  return CHECKED_TOKEN_NAMESPACES.some((prefix) => name.startsWith(prefix));
}

/* ==========================================================================
 * The TypeScript / TSX scanner
 *
 * Two outputs, both needed:
 *
 *   `masked`  the source with every comment and regular-expression body
 *             replaced by spaces, preserving length and line breaks so offsets
 *             and line numbers remain exact. Used for structural work such as
 *             locating a `style={{ … }}` prop.
 *   `spans`   the character ranges of string-literal contents and of the
 *             static chunks of template literals. Detection runs over these,
 *             because a CSS value can only reach the browser through a string,
 *             and because this codebase documents itself heavily — a header
 *             comment quoting `oklch(55% 0.162 140.6)` must not fail the audit.
 *
 * Regular-expression literals are handled rather than ignored, because
 * mistaking `/` for a comment start would blank live code and could hide a
 * violation. Two safeguards make a misfire harmless: a `/` only opens a regex
 * in a value position (the standard preceding-token heuristic), and the
 * candidate must terminate on the same line, which a real regex literal always
 * does. If either test fails the `/` is treated as division.
 *
 * An unterminated string, template literal or block comment is a PARSE
 * FAILURE. §0.3.5's contract admits no silent tolerance for a file this script
 * cannot read.
 * ========================================================================== */

/** Characters after which a `/` begins a regular expression, not a division. */
const REGEX_PRECEDING_CHARS = new Set([
  "(",
  ",",
  ";",
  "=",
  "!",
  "&",
  "|",
  "?",
  ":",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "[",
  "{",
]);

/** Keywords after which a `/` begins a regular expression. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Scan a TypeScript or TSX source file.
 *
 * @param {string} text
 * @param {string} relativePath Used only in failure messages.
 * @returns {{ masked: string, spans: Array<{ start: number, end: number }> }}
 */
function scanTypeScriptSource(text, relativePath) {
  const out = text.split("");
  /** @type {Array<{ start: number, end: number }>} */
  const spans = [];

  /** Replace a range with spaces, leaving newlines in place. */
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  /**
   * The last two meaningful characters before `index`, read from the already
   * processed portion of `out` so masked comments cannot influence the answer.
   */
  const precedingChars = (index) => {
    let j = index - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    const first = j >= 0 ? out[j] : "";
    j -= 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    const second = j >= 0 ? out[j] : "";
    return { first, second };
  };

  /** The identifier immediately preceding `index`, if any. */
  const precedingWord = (index) => {
    let j = index - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(out[j])) j -= 1;
    return out.slice(j + 1, end).join("");
  };

  /**
   * Where does a regular-expression literal starting at `index` end? Returns
   * -1 when there is no same-line terminator, which means the `/` was
   * division.
   */
  const regexEnd = (index) => {
    let inClass = false;
    for (let j = index + 1; j < text.length; j += 1) {
      const c = text[j];
      if (c === "\n") return -1;
      if (c === "\\") {
        j += 1;
        continue;
      }
      if (inClass) {
        if (c === "]") inClass = false;
        continue;
      }
      if (c === "[") {
        inClass = true;
        continue;
      }
      if (c === "/") return j;
    }
    return -1;
  };

  /** @type {Array<{ kind: "code" | "template", braceDepth: number }>} */
  const frames = [];
  let mode = /** @type {"code" | "template"} */ ("code");
  let braceDepth = 0;
  let templateChunkStart = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (mode === "template") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        spans.push({ start: templateChunkStart, end: index });
        const frame = frames.pop();
        braceDepth = frame ? frame.braceDepth : 0;
        mode = "code";
        index += 1;
        continue;
      }
      if (char === "$" && text[index + 1] === "{") {
        spans.push({ start: templateChunkStart, end: index });
        frames.push({ kind: "template", braceDepth });
        braceDepth = 0;
        mode = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    // Line comment.
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      const stop = newline === -1 ? text.length : newline;
      blank(index, stop);
      index = stop;
      continue;
    }

    // Block comment. An unterminated one is a parse failure.
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) {
        throw new AuditFailure(
          `${relativePath}: unterminated block comment starting at offset ${index}. ` +
            "A file this audit cannot parse is a failure, not a pass.",
        );
      }
      blank(index, end + 2);
      index = end + 2;
      continue;
    }

    // Quoted string. A newline before the closing quote is a parse failure,
    // matching JavaScript's own rule for single- and double-quoted strings.
    if (char === '"' || char === "'") {
      let j = index + 1;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") {
          throw new AuditFailure(
            `${relativePath}: unterminated string literal on line ` +
              `${lineAtOffset(buildLineIndex(text), index)}. ` +
              "A file this audit cannot parse is a failure, not a pass.",
          );
        }
        if (c === char) break;
        j += 1;
      }
      if (j >= text.length) {
        throw new AuditFailure(
          `${relativePath}: unterminated string literal at end of file. ` +
            "A file this audit cannot parse is a failure, not a pass.",
        );
      }
      spans.push({ start: index + 1, end: j });
      index = j + 1;
      continue;
    }

    // Template literal.
    if (char === "`") {
      frames.push({ kind: "code", braceDepth });
      mode = "template";
      templateChunkStart = index + 1;
      index += 1;
      continue;
    }

    // Closing brace of a template interpolation.
    if (
      char === "}" &&
      braceDepth === 0 &&
      frames.length > 0 &&
      frames[frames.length - 1].kind === "template"
    ) {
      frames.pop();
      mode = "template";
      templateChunkStart = index + 1;
      index += 1;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }

    if (char === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      index += 1;
      continue;
    }

    // Division, or a regular-expression literal.
    if (char === "/") {
      const { first, second } = precedingChars(index);
      const isArrow = first === ">" && second === "=";
      const startsRegex =
        first === "" ||
        isArrow ||
        REGEX_PRECEDING_CHARS.has(first) ||
        REGEX_PRECEDING_KEYWORDS.has(precedingWord(index));
      if (startsRegex) {
        const end = regexEnd(index);
        if (end !== -1) {
          // Blank the body and any flags: a regular expression is never a CSS
          // value, and its brackets would otherwise confuse the bracket
          // classifier.
          let flagsEnd = end + 1;
          while (flagsEnd < text.length && /[a-z]/.test(text[flagsEnd])) {
            flagsEnd += 1;
          }
          blank(index, flagsEnd);
          index = flagsEnd;
          continue;
        }
      }
      index += 1;
      continue;
    }

    index += 1;
  }

  if (mode === "template" || frames.length > 0) {
    throw new AuditFailure(
      `${relativePath}: unterminated template literal at end of file. ` +
        "A file this audit cannot parse is a failure, not a pass.",
    );
  }

  return { masked: out.join(""), spans };
}

/* ==========================================================================
 * Phase 5 — detection
 *
 * Bracket syntax in Tailwind means three different things and only some of
 * them are "arbitrary values". Getting this wrong is how a naive
 * implementation either fails on legitimate code or passes on real violations.
 *
 *   5a  Arbitrary value    `text-[0.8rem]`, `ring-[3px]`, `w-[42px]`,
 *                          `grid-cols-[1fr_auto]`, and an arbitrary *property*
 *                          such as `[mask-image:linear-gradient(…)]`.
 *                          Fails in authored code; inventoried in generated.
 *   5b  Arbitrary variant  `[&>svg]:size-4`, `data-[state=open]:rotate-180`,
 *                          `has-[>svg]:px-3`, `supports-[…]:…`. A selector is
 *                          not a CSS property value, and §0.3.5's rule is
 *                          stated over values, so these are inventoried and
 *                          never fail — in either file class.
 *   5c  Colour literal     Fails in BOTH file classes.
 *
 * The heuristic separating 5a from 5b, stated honestly including its limits:
 *   - a bracket group whose `]` is followed by `:` — optionally after a `/…`
 *     group modifier, as in `group-data-[collapsible=icon]/sidebar:` — is a
 *     VARIANT, because that colon is the variant separator;
 *   - a bracket group whose content contains `&` is a VARIANT, because `&` is a
 *     selector reference and can never be a CSS property value;
 *   - otherwise it is an arbitrary VALUE only when it sits in a Tailwind
 *     utility position: immediately after a `-` (the utility prefix), or at the
 *     start of the utility with a `:` inside the bracket (an arbitrary
 *     property).
 *   - a bracket in any other position is not Tailwind syntax at all and is
 *     ignored. This is what keeps a react-hook-form field path such as
 *     `education[0].name` from being reported as a hardcoded value, and it is
 *     the brief's own rule: "Value brackets sit after a utility prefix and
 *     a `-`."
 *
 * The classification is biased toward strictness where it is genuinely
 * ambiguous, because misclassifying a variant as a value produces a false
 * failure a human resolves in seconds, whereas the reverse hides a violation —
 * and the no-weakening rule resolves that tie.
 *
 * Colour detection runs over the whole string independently of bracket
 * classification, which is why `supports-[backdrop-filter]:bg-white/20` is
 * inventoried as a variant AND fails on its `white`.
 * ========================================================================== */

/**
 * A single finding.
 *
 * @typedef {object} Finding
 * @property {"arbitraryValue" | "arbitraryVariant" | "colourLiteral"} category
 * @property {string} text   The offending source text, as a reviewer would grep for it.
 * @property {number} offset Absolute character offset in the file.
 * @property {string} rule   Which rule the finding relates to, for the report.
 */

/**
 * Locate the top-level bracket groups in a class token.
 *
 * @param {string} token
 * @returns {Array<{ start: number, end: number, content: string }>}
 */
function topLevelBracketGroups(token) {
  /** @type {Array<{ start: number, end: number, content: string }>} */
  const groups = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    if (char === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        groups.push({ start, end: i, content: token.slice(start + 1, i) });
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return groups;
}

/**
 * Index of the last `:` in a class token that sits outside every bracket
 * group — the boundary between the variant chain and the utility.
 *
 * @param {string} token
 * @returns {number}
 */
function lastTopLevelColon(token) {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    if (char === "[") depth += 1;
    else if (char === "]") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) last = i;
  }
  return last;
}

/**
 * Is the bracket group at `group` followed by a variant separator? Accepts an
 * optional `/modifier` between the `]` and the `:`, because
 * `group-data-[collapsible=icon]/sidebar:` is one variant, not a value.
 *
 * @param {string} token
 * @param {{ end: number }} group
 * @returns {boolean}
 */
function bracketIsVariant(token, group) {
  let i = group.end + 1;
  if (token[i] === "/") {
    i += 1;
    while (i < token.length && /[A-Za-z0-9_.%-]/.test(token[i])) i += 1;
  }
  return token[i] === ":";
}

/**
 * Does a bracket group sit in a Tailwind utility position, making it an
 * arbitrary value rather than incidental bracket syntax?
 *
 * @param {string} token
 * @param {{ start: number, content: string }} group
 * @returns {boolean}
 */
function bracketIsUtilityValue(token, group) {
  const before = group.start === 0 ? "" : token[group.start - 1];
  // `text-[0.8rem]` — a bracket immediately after the utility prefix's dash.
  if (before === "-") return true;
  // `[mask-image:…]` or `md:[mask-image:…]` — an arbitrary property, which is a
  // whole declaration in brackets and therefore a value.
  if ((before === "" || before === ":") && group.content.includes(":")) {
    return true;
  }
  return false;
}

/**
 * Is a bracket group's content a single permitted token reference?
 *
 * This exception is required rather than convenient. §0.3.5 adds
 * `--size-hero-max: 80dvh` to the Control sizes group precisely "because the
 * §0.4.5 hero row needs a maximum height and an inline `80dvh` would be exactly
 * the literal this rule forbids" — so the intended authored form *is* a
 * bracketed `var()` reference, and `max-h-[var(--size-hero-max)]` must pass. A
 * fallback is accepted only when it is itself a permitted literal, so
 * `[var(--x,12px)]` remains a violation.
 *
 * @param {string} content
 * @returns {{ token: string } | null}
 */
function pureVarReference(content) {
  const match = PURE_VAR_BRACKET_PATTERN.exec(content.trim());
  if (match === null) return null;
  const fallback = (match[2] ?? "").trim();
  if (fallback !== "" && !PERMITTED_LITERALS.has(fallback.toLowerCase())) {
    return null;
  }
  return { token: match[1] };
}

/**
 * Is a Tailwind utility naming a colour literal rather than a design token?
 *
 * The check is driven by the declared tokens, not by a hardcoded list of
 * utility prefixes, and that ordering matters: §0.3.3 declares
 * `--color-accent-coral`, so `bg-accent-coral` is a legitimate token reference
 * even though `coral` is a CSS named colour. Declared tokens are therefore
 * tested first, across every dash-boundary suffix of the utility; only then is
 * the remainder tested for a named colour or a raw `<palette>-<shade>` pair.
 *
 * @param {string} utility
 * @param {Set<string>} declaredTokens
 * @returns {string | null} The offending colour text, or null when clean.
 */
function utilityColourLiteral(utility, declaredTokens) {
  const parts = utility.split("-").filter((part) => part !== "");
  if (parts.length === 0) return null;

  for (let i = 0; i < parts.length; i += 1) {
    if (declaredTokens.has(`--color-${parts.slice(i).join("-")}`)) return null;
  }

  for (let i = 0; i < parts.length; i += 1) {
    const candidate = parts.slice(i).join("-");
    const lower = candidate.toLowerCase();
    if (PERMITTED_COLOUR_KEYWORDS.has(lower)) return null;
    const shade = PALETTE_SHADE_PATTERN.exec(lower);
    if (shade !== null && TAILWIND_PALETTES.has(shade[1])) return candidate;
    if (CSS_NAMED_COLOURS.has(lower)) return candidate;
  }

  return null;
}

/**
 * Strip the trailing `/modifier` (an opacity or group name) from a utility,
 * leaving `bg-white` from `bg-white/20`. Brackets are respected, so a slash
 * INSIDE a bracketed arbitrary value — a background utility whose bracketed
 * value is a path containing a separator, or an aspect ratio written as one
 * number over another — is not mistaken for a modifier, and the utility is
 * returned untouched.
 *
 * Those examples are described rather than written out as classes, and
 * deliberately so. There is no `tailwind.config.js` on this project (§0.3.3),
 * so Tailwind 4 uses automatic source detection and harvests class candidates
 * from the raw text of every file it scans — this one included, comments
 * included, because the extractor is content agnostic. Spelling out a
 * background-image utility with a bracketed relative path therefore mints a
 * real utility whose declaration is that same path, which Turbopack then tries
 * to resolve as a module, failing the production build with "Module not
 * found". Observed, not theorised: it broke `next build` the moment
 * `app/layout.tsx` imported `app/globals.css`. It is a build-breaking false
 * positive with no runtime cause. Keep example class names out of this file's
 * prose — describe them instead.
 *
 * `app/globals.css` additionally excludes this directory from source detection.
 * The two defences are complementary rather than alternatives, and both are
 * kept: the exclusion covers any future script that documents a utility, and
 * this paraphrasing keeps the file safe if the exclusion is ever narrowed or
 * a scanner reaches it by another path.
 *
 * @param {string} utility
 * @returns {string}
 */
function stripUtilityModifier(utility) {
  let depth = 0;
  for (let i = 0; i < utility.length; i += 1) {
    const char = utility[i];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === "/" && depth === 0) return utility.slice(0, i);
  }
  return utility;
}

/**
 * Analyse one whitespace-delimited class-like token.
 *
 * @param {string} token
 * @param {number} tokenOffset Absolute offset of the token in the file.
 * @param {Set<string>} declaredTokens
 * @returns {{ findings: Finding[], references: Array<{ name: string, offset: number }> }}
 */
function analyseClassToken(token, tokenOffset, declaredTokens) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Array<{ name: string, offset: number }>} */
  const references = [];

  for (const group of topLevelBracketGroups(token)) {
    const bracket = token.slice(group.start, group.end + 1);

    if (bracketIsVariant(token, group) || group.content.includes("&")) {
      findings.push({
        category: "arbitraryVariant",
        // The whole class is recorded rather than the bracket alone, so the
        // inventory reads the way §0.3.5 writes these — `[&>svg]:size-4`, not
        // `[&>svg]` — and so a reviewer can grep for it verbatim.
        text: token,
        offset: tokenOffset + group.start,
        rule:
          `arbitrary variant \`${bracket}\` — a selector, not a CSS property ` +
          "value; inventoried, never a failure",
      });
      continue;
    }

    if (!bracketIsUtilityValue(token, group)) continue;

    const pure = pureVarReference(group.content);
    if (pure !== null) {
      // The permitted form. The referenced token still has to resolve, so it is
      // handed to the reference check rather than simply accepted.
      references.push({ name: pure.token, offset: tokenOffset + group.start });
      continue;
    }

    findings.push({
      category: "arbitraryValue",
      // As above: `text-[0.8rem]`, the form §0.3.5 itself uses.
      text: token,
      offset: tokenOffset + group.start,
      rule:
        `arbitrary Tailwind value \`${bracket}\` — every CSS property value ` +
        "must resolve to a token in the §0.3.3 contract",
    });
  }

  // The utility half of the token, for the colour check. Variants are peeled at
  // the last top-level colon, then the important modifier, a negative sign and
  // any trailing `/modifier` are removed.
  const colon = lastTopLevelColon(token);
  let utility = colon === -1 ? token : token.slice(colon + 1);
  utility = utility.replace(/^!+/, "").replace(/^-/, "");
  utility = stripUtilityModifier(utility);

  const colour = utilityColourLiteral(utility, declaredTokens);
  if (colour !== null) {
    findings.push({
      category: "colourLiteral",
      text: token,
      offset: tokenOffset,
      rule:
        `colour literal \`${colour}\` — colour must come from the §0.3.3 token ` +
        "contract, and this axis fails in generated files too",
    });
  }

  return { findings, references };
}

/**
 * Find every colour literal written out in full inside a block of text: hex at
 * 3, 4, 6 or 8 digits, and every functional notation in either argument
 * syntax.
 *
 * @param {string} text The text to scan.
 * @param {number} baseOffset Absolute offset of `text` in the file.
 * @returns {Finding[]}
 */
function detectColourNotations(text, baseOffset) {
  /** @type {Finding[]} */
  const findings = [];

  HEX_COLOUR_PATTERN.lastIndex = 0;
  let hex;
  while ((hex = HEX_COLOUR_PATTERN.exec(text)) !== null) {
    findings.push({
      category: "colourLiteral",
      text: hex[0],
      offset: baseOffset + hex.index,
      rule:
        "hex colour literal — colour must come from the §0.3.3 token contract, " +
        "and this axis fails in generated files too",
    });
  }

  COLOUR_FUNCTION_PATTERN.lastIndex = 0;
  let fn;
  while ((fn = COLOUR_FUNCTION_PATTERN.exec(text)) !== null) {
    // Extend the reported text to the matching parenthesis so a reviewer sees
    // the whole value rather than a bare function name.
    let depth = 0;
    let end = fn.index;
    for (let i = fn.index; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
      end = i + 1;
    }
    const full = text.slice(fn.index, end);
    findings.push({
      category: "colourLiteral",
      text: full.length > 80 ? `${full.slice(0, 77)}...` : full,
      offset: baseOffset + fn.index,
      rule:
        "functional colour literal — colour must come from the §0.3.3 token " +
        "contract, and this axis fails in generated files too",
    });
  }

  return findings;
}

/**
 * Does a piece of text contain a colour literal? Used to avoid reporting the
 * same value twice, once as a colour and once as a hardcoded inline-style
 * value.
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsColourNotation(text) {
  HEX_COLOUR_PATTERN.lastIndex = 0;
  COLOUR_FUNCTION_PATTERN.lastIndex = 0;
  return HEX_COLOUR_PATTERN.test(text) || COLOUR_FUNCTION_PATTERN.test(text);
}

/**
 * Replace every string-literal and template-chunk span with spaces, giving a
 * view of the file in which brace, bracket and comma matching is safe because
 * no delimiter inside a string can be mistaken for structure.
 *
 * @param {string} masked
 * @param {Array<{ start: number, end: number }>} spans
 * @returns {string}
 */
function blankStringSpans(masked, spans) {
  const out = masked.split("");
  for (const span of spans) {
    for (let i = span.start; i < span.end; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}

/**
 * Match the brace opened at `open` in a structural view of the source.
 *
 * @param {string} structural
 * @param {number} open
 * @returns {number} Index of the matching `}`, or -1.
 */
function matchBrace(structural, open) {
  let depth = 0;
  for (let i = open; i < structural.length; i += 1) {
    if (structural[i] === "{") depth += 1;
    else if (structural[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split an object body into its top-level entries, returning index ranges into
 * the structural view.
 *
 * @param {string} structural
 * @param {number} from
 * @param {number} to
 * @returns {Array<{ start: number, end: number }>}
 */
function splitTopLevelEntries(structural, from, to) {
  /** @type {Array<{ start: number, end: number }>} */
  const entries = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const char = structural[i];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      entries.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < to) entries.push({ start, end: to });
  return entries;
}

/**
 * Check the values of every `style={{ … }}` JSX prop in a file.
 *
 * A hardcoded pixel value in an inline style is exactly the defect class this
 * gate exists to prevent — `public/css/ces.css` sized a photograph in `vh`
 * (`.polaroid { width: 50vh; height: 60vh }` at lines 152-153) and pushed 76 px
 * of frame off a 390 px screen.
 *
 * Only *literal* values are reported. A value computed from data is legitimate
 * and in places required: §0.4.2 has `Media` apply a migrated focal point as
 * `object-position` and its zoom as a `scale()`, both of which are per-row
 * numbers rather than tokens. So an identifier, a member expression, a call or
 * an interpolated template passes, while a string or numeric literal must be a
 * token reference or a permitted literal.
 *
 * The limit of that rule, stated rather than left to be discovered: a literal
 * reached through one level of indirection — `const W = "16rem"` used as
 * `style={{ width: W }}` — is not reported, because following an identifier to
 * its definition would mean data-flow analysis, and the same identifier is
 * indistinguishable from a prop or an imported value that legitimately carries
 * data. Values written at the CSS-value site are covered; a named constant is
 * a code-review matter. This is a scope boundary, not a suppression: no
 * mechanism here can silence a literal that IS written at the value site.
 *
 * Class strings inside `cva()` variant maps need no separate handling: they are
 * string literals, so the class-token scan above already covers them.
 *
 * @param {string} text
 * @param {string} structural
 * @param {Array<{ start: number, end: number }>} spans
 * @returns {{ findings: Finding[], references: Array<{ name: string, offset: number }> }}
 */
function scanInlineStyles(text, structural, spans) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Array<{ name: string, offset: number }>} */
  const references = [];

  const stylePattern = /\bstyle\s*=\s*\{\s*\{/g;
  let match;
  while ((match = stylePattern.exec(structural)) !== null) {
    const innerBrace = structural.indexOf(
      "{",
      match.index + match[0].length - 1,
    );
    if (innerBrace === -1) continue;
    const objectEnd = matchBrace(structural, innerBrace);
    if (objectEnd === -1) continue;

    for (const entry of splitTopLevelEntries(
      structural,
      innerBrace + 1,
      objectEnd,
    )) {
      // The first top-level colon separates the property from its value.
      let depth = 0;
      let colon = -1;
      for (let i = entry.start; i < entry.end; i += 1) {
        const char = structural[i];
        if (char === "{" || char === "[" || char === "(") depth += 1;
        else if (char === "}" || char === "]" || char === ")") {
          depth = Math.max(0, depth - 1);
        } else if (char === ":" && depth === 0) {
          colon = i;
          break;
        }
      }
      if (colon === -1) continue;

      const valueStart = colon + 1;
      const valueEnd = entry.end;
      const structuralValue = structural.slice(valueStart, valueEnd).trim();
      const rawValue = text.slice(valueStart, valueEnd);

      // A bare numeric literal. React appends `px` to a unitless number, so
      // this is a hardcoded length. `0` is on the permitted list.
      if (/^-?\d+(?:\.\d+)?$/.test(structuralValue)) {
        if (structuralValue !== "0") {
          findings.push({
            category: "arbitraryValue",
            text: `${rawValue.trim()}`,
            offset: valueStart,
            rule:
              "hardcoded numeric value in an inline style — it must resolve to " +
              "a token in the §0.3.3 contract",
          });
        }
        continue;
      }

      // An interpolated template is data-driven; its static text is still
      // colour-checked by the string scan.
      if (rawValue.includes("`")) continue;

      for (const span of spans) {
        if (span.start < valueStart || span.end > valueEnd) continue;
        const content = text.slice(span.start, span.end).trim();
        if (content === "") continue;

        const pure = pureVarReference(content);
        if (pure !== null) {
          references.push({ name: pure.token, offset: span.start });
          continue;
        }
        if (PERMITTED_LITERALS.has(content.toLowerCase())) continue;
        // Already reported by the colour scan; not duplicated here.
        if (containsColourNotation(content)) continue;

        findings.push({
          category: "arbitraryValue",
          text: content,
          offset: span.start,
          rule:
            "hardcoded value in an inline style — it must resolve to a token " +
            "in the §0.3.3 contract",
        });
      }
    }
  }

  return { findings, references };
}

/* ==========================================================================
 * File discovery and per-file scanning
 * ========================================================================== */

/**
 * Recursively list files under `directory` whose extension is wanted.
 *
 * A hand-rolled walk is used rather than `fs.globSync`, which is still marked
 * experimental on the Node 22 line this project pins and would emit a warning
 * on every run. Results are sorted so the inventory does not depend on
 * directory-entry order.
 *
 * @param {string} directory
 * @param {Set<string>} extensions
 * @returns {string[]} Absolute paths, sorted.
 */
function listFiles(directory, extensions) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const queue = [directory];

  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.pop());
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // Not swallowed: a directory this audit was told to read but cannot is a
      // failure, because a silently empty scan is a vacuous pass.
      const message = error instanceof Error ? error.message : String(error);
      throw new AuditFailure(`Cannot read directory ${current}: ${message}`);
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.has(path.extname(entry.name).toLowerCase())) {
        found.push(absolute);
      }
    }
  }

  return found.sort(compareAscii);
}

/**
 * Does a path exist and is it a directory?
 *
 * Only "does not exist" is answered with `false`. Any other error — a
 * permission problem above all — is rethrown as a failure, because a directory
 * that exists but cannot be read would otherwise be silently indistinguishable
 * from one that is legitimately absent, and the caller treats absence of an
 * optional scan root as a mere anomaly. That is the one path by which an
 * unreadable tree could have produced a green run.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String(/** @type {{ code: unknown }} */ (error).code)
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new AuditFailure(`Cannot inspect ${candidate}: ${message}`);
  }
}

/**
 * A scanned file's result.
 *
 * @typedef {object} FileResult
 * @property {string} path Root-relative POSIX path.
 * @property {"authored" | "generated" | "reference-only" | "tokens"} classification
 * @property {Finding[]} findings
 * @property {Array<{ name: string, offset: number }>} references
 * @property {number[]} lineStarts
 */

/**
 * Scan one file.
 *
 * @param {string} absolutePath
 * @param {string} relativePath
 * @param {FileResult["classification"]} classification
 * @param {Set<string>} declaredTokens
 * @param {boolean} literalScan Whether the literal bans apply to this file.
 * @returns {FileResult}
 */
function scanFile(
  absolutePath,
  relativePath,
  classification,
  declaredTokens,
  literalScan,
) {
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AuditFailure(`Cannot read ${relativePath}: ${message}`);
  }

  const lineStarts = buildLineIndex(text);
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Array<{ name: string, offset: number }>} */
  const references = [];

  if (STYLE_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
    // A stylesheet. Comments are masked so a documented value is not reported,
    // then the whole remaining text is in scope — a stylesheet has no
    // distinction between "a string" and "a value".
    const masked = maskCssComments(text);
    references.push(...collectVarReferences(masked, 0));
    if (literalScan) {
      findings.push(...detectColourNotations(masked, 0));
    }
    return {
      path: relativePath,
      classification,
      findings,
      references,
      lineStarts,
    };
  }

  const { masked, spans } = scanTypeScriptSource(text, relativePath);

  for (const span of spans) {
    const content = text.slice(span.start, span.end);
    if (content === "") continue;

    references.push(...collectVarReferences(content, span.start));
    if (!literalScan) continue;

    findings.push(...detectColourNotations(content, span.start));

    // Whitespace-delimited class-like tokens. Tailwind requires `_` in place of
    // a space inside an arbitrary value, so splitting on whitespace never
    // divides a single utility.
    const tokenPattern = /\S+/g;
    let token;
    while ((token = tokenPattern.exec(content)) !== null) {
      const analysed = analyseClassToken(
        token[0],
        span.start + token.index,
        declaredTokens,
      );
      findings.push(...analysed.findings);
      references.push(...analysed.references);
    }
  }

  const structural = blankStringSpans(masked, spans);
  const inline = scanInlineStyles(text, structural, spans);
  references.push(...inline.references);
  if (literalScan) findings.push(...inline.findings);

  return {
    path: relativePath,
    classification,
    findings,
    references,
    lineStarts,
  };
}

/** Is a root-relative path excluded from literal scanning? */
function isLiteralScanExcluded(relativePath) {
  return LITERAL_SCAN_EXCLUDED_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix),
  );
}

/**
 * Is a finding a violation for the file class it was found in?
 *
 * This single function is the §0.3.5 matrix. Nothing else in this script
 * decides pass or fail for a literal finding, so the asymmetry exists in
 * exactly one place and cannot drift.
 *
 * @param {Finding} finding
 * @param {FileResult["classification"]} classification
 * @returns {boolean}
 */
function isViolation(finding, classification) {
  // An arbitrary variant is a selector, never a CSS property value. Never fails.
  if (finding.category === "arbitraryVariant") return false;
  // Colour fails in both authored and generated files — the axis where a stray
  // literal breaks the brand contract.
  if (finding.category === "colourLiteral") return true;
  // A non-colour arbitrary value fails only in authored code. Unmodified
  // registry output contains these by design, and §0.3.5 exempts it.
  return classification === "authored";
}

/* ==========================================================================
 * Orchestration
 * ========================================================================== */

/**
 * @typedef {object} Violation
 * @property {string} path
 * @property {number} line
 * @property {string} category
 * @property {string} text
 * @property {string} rule
 */

/**
 * Run every scan against `root`.
 *
 * @param {string} root Absolute path to the audited tree.
 * @returns {{
 *   declaredTokens: Set<string>,
 *   results: FileResult[],
 *   violations: Violation[],
 *   permitted: Violation[],
 *   structuralFailures: string[],
 *   anomalies: string[],
 *   uiFileCount: number,
 * }}
 */
function runAudit(root) {
  /** @type {string[]} */
  const structuralFailures = [];
  /** @type {string[]} */
  const anomalies = [];
  /** @type {FileResult[]} */
  const results = [];
  /** @type {Set<string>} */
  let declaredTokens = new Set();
  let uiFileCount = 0;

  /* ---- Phase 3: the declared-token set ---------------------------------- */

  const globalsAbsolute = path.join(root, GLOBALS_CSS_RELATIVE_PATH);
  if (!fs.existsSync(globalsAbsolute)) {
    structuralFailures.push(
      `${GLOBALS_CSS_RELATIVE_PATH} is missing. It is the sole source of ` +
        "declared tokens, so without it every reference would appear to " +
        "resolve against an empty set and the audit would pass vacuously.",
    );
  } else {
    let css;
    try {
      css = fs.readFileSync(globalsAbsolute, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AuditFailure(
        `Cannot read ${GLOBALS_CSS_RELATIVE_PATH}: ${message}`,
      );
    }
    const parsed = parseDeclaredTokens(css);
    declaredTokens = parsed.declared;
    if (declaredTokens.size === 0) {
      structuralFailures.push(
        `${GLOBALS_CSS_RELATIVE_PATH} declares no custom properties in ` +
          "`:root`, `@theme` or `@theme inline`. A token audit with an empty " +
          "token set would pass everything, so this is a failure.",
      );
    }
    for (const stray of parsed.strayDeclarations) {
      anomalies.push(
        `${GLOBALS_CSS_RELATIVE_PATH} declares \`${stray}\` outside \`:root\`, ` +
          "`@theme` and `@theme inline`, so it is scoped to a selector rather " +
          "than being a design token and does not satisfy a reference.",
      );
    }
  }

  /* ---- Phase 4, Scan A: components/ui, the authored/generated split ----- */

  const uiAbsolute = path.join(root, UI_DIRECTORY_RELATIVE_PATH);
  if (!isDirectory(uiAbsolute)) {
    structuralFailures.push(
      `${UI_DIRECTORY_RELATIVE_PATH}/ does not exist. This audit's primary ` +
        "scope is that directory; a run that cannot find it has audited " +
        "nothing and must not report success.",
    );
  } else {
    const uiFiles = listFiles(uiAbsolute, SOURCE_EXTENSIONS);
    uiFileCount = uiFiles.length;

    if (uiFiles.length === 0) {
      structuralFailures.push(
        `${UI_DIRECTORY_RELATIVE_PATH}/ contains no .ts or .tsx files. An ` +
          "empty scope is a vacuous pass, not a clean audit.",
      );
    }

    const basenames = new Set(uiFiles.map((file) => path.basename(file)));
    const missingAuthored = AUTHORED_UI_FILES.filter(
      (name) => !basenames.has(name),
    );
    if (missingAuthored.length > 0) {
      structuralFailures.push(
        `${UI_DIRECTORY_RELATIVE_PATH}/ is missing ${missingAuthored.length} ` +
          `of the ${AUTHORED_UI_FILES.length} authored files fixed by §0.3.4: ` +
          `${missingAuthored.join(", ")}. A rename or a deletion must not ` +
          "silently convert an authored file into no file at all — the audit " +
          "cannot pass because the file it was policing vanished.",
      );
    }

    if (uiFiles.length !== 0 && uiFiles.length !== EXPECTED_UI_FILE_COUNT) {
      // An anomaly, not a failure: §0.3.1 confirms registry membership against
      // the pinned CLI at generation time, so a legitimate drift in the
      // generated set is possible and a human should look rather than a build
      // stop.
      anomalies.push(
        `${UI_DIRECTORY_RELATIVE_PATH}/ holds ${uiFiles.length} files; §0.3.5 ` +
          `states ${EXPECTED_UI_FILE_COUNT} (${EXPECTED_UI_FILE_COUNT - AUTHORED_UI_FILES.length}` +
          ` generated + ${AUTHORED_UI_FILES.length} authored). Worth reviewing.`,
      );
    }

    for (const absolute of uiFiles) {
      const relative = toRelativePosix(root, absolute);
      const classification = AUTHORED_UI_FILES.includes(path.basename(absolute))
        ? "authored"
        : "generated";
      results.push(
        scanFile(absolute, relative, classification, declaredTokens, true),
      );
    }
  }

  /* ---- Phase 6, Scan B: the authored application tree ------------------- */

  const literalExtensions = new Set([
    ...SOURCE_EXTENSIONS,
    ...STYLE_EXTENSIONS,
  ]);
  for (const scanRoot of AUTHORED_SCAN_ROOTS) {
    const absoluteRoot = path.join(root, scanRoot);
    if (!isDirectory(absoluteRoot)) {
      anomalies.push(
        `${scanRoot}/ does not exist, so the §0.3.5 value contract was not ` +
          "checked there. Expected once that part of the tree is populated.",
      );
      continue;
    }

    for (const absolute of listFiles(absoluteRoot, literalExtensions)) {
      const relative = toRelativePosix(root, absolute);
      const isCss = STYLE_EXTENSIONS.has(path.extname(absolute).toLowerCase());

      if (relative === GLOBALS_CSS_RELATIVE_PATH) {
        // The token definition itself. Exempt from the literal ban — every
        // `oklch()` value, the `#fff8d4` warmth palette and the three
        // `--gradient-event` stops legitimately live here, and a script that
        // failed on its own token file is a script nobody can run. Still
        // scanned for references, which must resolve.
        results.push(
          scanFile(absolute, relative, "tokens", declaredTokens, false),
        );
        continue;
      }

      if (isCss) {
        // Not exempted, only reported: a second stylesheet is either a second
        // token definition, which the specification does not allow, or authored
        // CSS, which the value contract governs. Either way a human should see
        // it, and it is scanned under the authored ruleset meanwhile.
        anomalies.push(
          `${relative} is a stylesheet other than ${GLOBALS_CSS_RELATIVE_PATH}. ` +
            "§0.3.3 declares one token layer; this file is scanned under the " +
            "authored ruleset rather than being exempted.",
        );
      }

      if (isLiteralScanExcluded(relative)) {
        // Route Handlers return data, not markup, so they carry no CSS property
        // values — but their token references are still checked.
        results.push(
          scanFile(absolute, relative, "reference-only", declaredTokens, false),
        );
        continue;
      }

      results.push(
        scanFile(absolute, relative, "authored", declaredTokens, true),
      );
    }
  }

  /* ---- Phase 7, Scan C: the rest of the tree, for references ------------ */

  for (const scanRoot of REFERENCE_ONLY_SCAN_ROOTS) {
    const absoluteRoot = path.join(root, scanRoot);
    if (!isDirectory(absoluteRoot)) continue;
    for (const absolute of listFiles(absoluteRoot, SOURCE_EXTENSIONS)) {
      results.push(
        scanFile(
          absolute,
          toRelativePosix(root, absolute),
          "reference-only",
          declaredTokens,
          false,
        ),
      );
    }
  }

  results.sort((a, b) => compareAscii(a.path, b.path));

  /* ---- Verdicts --------------------------------------------------------- */

  /** @type {Violation[]} */
  const violations = [];
  /** @type {Violation[]} */
  const permitted = [];

  for (const result of results) {
    for (const finding of result.findings) {
      const entry = {
        path: result.path,
        line: lineAtOffset(result.lineStarts, finding.offset),
        category: finding.category,
        text: finding.text,
        rule: finding.rule,
      };
      if (isViolation(finding, result.classification)) violations.push(entry);
      else permitted.push(entry);
    }

    // Reference resolution, in every file class. Tailwind 4 ships default
    // `--radius-*` and `--text-*` values, so a generated component may
    // reference a default this project does not declare. Failing is the
    // CORRECT outcome: the fix is to declare the token in app/globals.css,
    // which makes the addition visible in a diff, or to change the component.
    // No exemption for Tailwind defaults exists here, because that would
    // reopen exactly the silent-addition hole this check closes.
    for (const reference of result.references) {
      if (!isCheckedNamespace(reference.name)) continue;
      if (declaredTokens.has(reference.name)) continue;
      violations.push({
        path: result.path,
        line: lineAtOffset(result.lineStarts, reference.offset),
        category: "unresolvedReference",
        text: `var(${reference.name})`,
        rule:
          `\`${reference.name}\` is not declared in ${GLOBALS_CSS_RELATIVE_PATH} — ` +
          "every --size-*, --space-*, --spacing-*, --radius-*, --shadow-* and " +
          "--text-* reference must resolve to a declared token",
      });
    }
  }

  const sortViolations = (a, b) =>
    compareAscii(a.path, b.path) ||
    a.line - b.line ||
    compareAscii(a.category, b.category) ||
    compareAscii(a.text, b.text);
  violations.sort(sortViolations);
  permitted.sort(sortViolations);

  return {
    declaredTokens,
    results,
    violations,
    permitted,
    structuralFailures,
    anomalies: sortedUnique(anomalies),
    uiFileCount,
  };
}

/* ==========================================================================
 * Phase 8 — the committed inventory
 *
 * §0.3.5: "The audit's inventory is committed so a diff after a registry
 * upgrade is reviewable." It lives beside this script rather than in
 * `artifacts/`, which is a closed six-file set in both §0.4.1 and §0.5.1
 * (route-manifest.json, assets.manifest.json, corpus-census.json,
 * migration-source-manifest.json, parity-report.json,
 * accessibility-record.md); a seventh entry would introduce a file the
 * specification does not call for.
 *
 * It is generated output that is committed DELIBERATELY. Never add it to
 * .gitignore — an uncommitted inventory makes `--check` meaningless and
 * removes the reviewable diff that is the whole point.
 *
 * Determinism is the point, so the inventory carries no timestamp, no absolute
 * path, no machine or user name and no Node version, every object key and
 * every array is sorted with a locale-independent comparator, and every path is
 * root-relative with POSIX separators.
 *
 * Findings are recorded as sorted unique STRINGS rather than as line-annotated
 * objects: a reviewer needs to know WHICH values appear after a registry
 * upgrade, and line numbers would churn the file on any unrelated edit. The
 * console report carries file, line, text and rule, which is where that detail
 * belongs.
 * ========================================================================== */

/**
 * Build the inventory from an audit run.
 *
 * @param {ReturnType<typeof runAudit>} audit
 * @returns {Record<string, unknown>}
 */
function buildInventory(audit) {
  const textsFor = (result, category) =>
    sortedUnique(
      result.findings
        .filter((finding) => finding.category === category)
        .map((finding) => finding.text),
    );

  const files = audit.results.map((result) => ({
    path: result.path,
    classification: result.classification,
    arbitraryValues: textsFor(result, "arbitraryValue"),
    arbitraryVariants: textsFor(result, "arbitraryVariant"),
    colourLiterals: textsFor(result, "colourLiteral"),
    tokenReferences: sortedUnique(
      result.references.map((reference) => reference.name),
    ),
  }));

  const sum = (key) =>
    files.reduce((total, file) => total + file[key].length, 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    authoredFiles: sortedUnique(AUTHORED_UI_FILES),
    declaredTokens: sortedUnique(audit.declaredTokens),
    files: files.sort((a, b) => compareAscii(a.path, b.path)),
    anomalies: audit.anomalies,
    counts: {
      filesTotal: files.length,
      filesAuthored: files.filter((f) => f.classification === "authored")
        .length,
      filesGenerated: files.filter((f) => f.classification === "generated")
        .length,
      // Counts match the arrays above: unique entries per file, summed.
      arbitraryValues: sum("arbitraryValues"),
      arbitraryVariants: sum("arbitraryVariants"),
      colourLiterals: sum("colourLiterals"),
      unresolvedReferences: audit.violations.filter(
        (violation) => violation.category === "unresolvedReference",
      ).length,
    },
  };
}

/**
 * Compare a freshly computed inventory against the committed one and describe
 * the drift in terms a reviewer can act on.
 *
 * @param {string} committed Serialised committed inventory, or null when absent.
 * @param {Record<string, unknown>} fresh
 * @returns {string[]} Empty when there is no drift.
 */
function describeInventoryDrift(committed, fresh) {
  if (committed === null) {
    return [
      `${INVENTORY_RELATIVE_PATH} does not exist. Run \`npm run audit:tokens\` ` +
        "without --check and commit the result.",
    ];
  }

  const serialisedFresh = serialiseInventory(fresh);
  if (committed === serialisedFresh) return [];

  /** @type {string[]} */
  const drift = [];
  /** @type {Record<string, unknown> | null} */
  let previous = null;
  try {
    previous = JSON.parse(committed);
  } catch (error) {
    // Not swallowed: an unreadable inventory is drift of the worst kind.
    const message = error instanceof Error ? error.message : String(error);
    return [
      `${INVENTORY_RELATIVE_PATH} is not valid JSON (${message}), so it cannot ` +
        "be compared. Regenerate and commit it.",
    ];
  }

  const listDelta = (label, before, after) => {
    const beforeSet = new Set(Array.isArray(before) ? before : []);
    const afterSet = new Set(Array.isArray(after) ? after : []);
    const added = [...afterSet]
      .filter((v) => !beforeSet.has(v))
      .sort(compareAscii);
    const removed = [...beforeSet]
      .filter((v) => !afterSet.has(v))
      .sort(compareAscii);
    if (added.length > 0) drift.push(`${label}: added ${added.join(", ")}`);
    if (removed.length > 0)
      drift.push(`${label}: removed ${removed.join(", ")}`);
  };

  if (previous.schemaVersion !== fresh.schemaVersion) {
    drift.push(
      `schemaVersion: committed ${String(previous.schemaVersion)}, computed ` +
        `${String(fresh.schemaVersion)}`,
    );
  }
  listDelta("authoredFiles", previous.authoredFiles, fresh.authoredFiles);
  listDelta("declaredTokens", previous.declaredTokens, fresh.declaredTokens);

  const previousFiles = new Map(
    (Array.isArray(previous.files) ? previous.files : []).map((file) => [
      file.path,
      file,
    ]),
  );
  const freshFiles = new Map(
    /** @type {Array<Record<string, unknown>>} */ (fresh.files).map((file) => [
      file.path,
      file,
    ]),
  );

  listDelta("files", [...previousFiles.keys()], [...freshFiles.keys()]);

  for (const [filePath, freshFile] of freshFiles) {
    const previousFile = previousFiles.get(filePath);
    if (previousFile === undefined) continue;
    if (previousFile.classification !== freshFile.classification) {
      drift.push(
        `${filePath}: classification ${String(previousFile.classification)} -> ` +
          `${String(freshFile.classification)}`,
      );
    }
    for (const key of [
      "arbitraryValues",
      "arbitraryVariants",
      "colourLiterals",
      "tokenReferences",
    ]) {
      listDelta(`${filePath} ${key}`, previousFile[key], freshFile[key]);
    }
  }

  if (drift.length === 0) {
    // Byte inequality with no structural difference: formatting or key order.
    drift.push(
      `${INVENTORY_RELATIVE_PATH} differs byte for byte with no structural ` +
        "change — regenerate it so its formatting matches this script's output.",
    );
  }

  return drift;
}

/* ==========================================================================
 * Phase 9 — reporting
 *
 * Every violation prints its file, line, offending text and the rule it
 * breaks: a bare count teaches nothing. Permitted findings print separately
 * and are labelled as such, so a reader understands the asymmetry is intended
 * rather than reading an inventoried `ring-[3px]` as a missed failure.
 * ========================================================================== */

/** Write a line of report output to stdout. */
function report(line = "") {
  process.stdout.write(`${line}\n`);
}

/** Write a diagnostic to stderr. */
function diagnostic(line = "") {
  process.stderr.write(`${line}\n`);
}

/**
 * Print the grouped violation list.
 *
 * @param {Violation[]} violations
 */
function reportViolations(violations) {
  report(paint("bold", `Violations (${violations.length})`));
  report();
  let currentPath = "";
  for (const violation of violations) {
    if (violation.path !== currentPath) {
      currentPath = violation.path;
      report(`  ${paint("bold", currentPath)}`);
    }
    report(
      `    ${paint("red", "x")} line ${String(violation.line).padStart(4)}  ` +
        `${violation.category}  ${JSON.stringify(violation.text)}`,
    );
    report(`      ${paint("dim", violation.rule)}`);
  }
  report();
}

/**
 * Print the findings that are recorded but deliberately do not fail.
 *
 * @param {Violation[]} permitted
 */
function reportPermitted(permitted) {
  const values = permitted.filter((p) => p.category === "arbitraryValue");
  const variants = permitted.filter((p) => p.category === "arbitraryVariant");

  report(paint("bold", `Inventoried, NOT failures (${permitted.length})`));
  report(
    paint(
      "dim",
      "  §0.3.5 exempts unmodified registry output from the arbitrary-value " +
        "ban, and a\n  selector is not a CSS property value. Both are recorded " +
        "so a diff after a\n  registry upgrade is reviewable.",
    ),
  );
  report();
  report(
    `  ${values.length} non-colour arbitrary value(s) in generated files` +
      (values.length > 0
        ? `, e.g. ${sortedUnique(values.map((v) => v.text))
            .slice(0, 6)
            .map((text) => JSON.stringify(text))
            .join(", ")}`
        : ""),
  );
  report(
    `  ${variants.length} arbitrary variant(s)` +
      (variants.length > 0
        ? `, e.g. ${sortedUnique(variants.map((v) => v.text))
            .slice(0, 6)
            .map((text) => JSON.stringify(text))
            .join(", ")}`
        : ""),
  );
  report();
}

/**
 * Print the run summary and the per-category verdicts.
 *
 * @param {ReturnType<typeof runAudit>} audit
 * @param {string[]} drift
 * @param {boolean} checkMode
 */
function reportSummary(audit, drift, checkMode) {
  const byClass = (classification) =>
    audit.results.filter((result) => result.classification === classification)
      .length;

  const countViolations = (category) =>
    audit.violations.filter((violation) => violation.category === category)
      .length;

  const verdict = (count) =>
    count === 0 ? paint("green", "PASS") : paint("red", `FAIL (${count})`);

  report(paint("bold", "Summary"));
  report();
  const row = (label, value) => report(`  ${label.padEnd(36)}${value}`);
  row("Files scanned", audit.results.length);
  row("  authored (full ban)", byClass("authored"));
  row("  generated (colour axis only)", byClass("generated"));
  row("  reference-only", byClass("reference-only"));
  row("  token definition", byClass("tokens"));
  row(
    "components/ui/ file count",
    `${audit.uiFileCount} (§0.3.5 states ${EXPECTED_UI_FILE_COUNT})`,
  );
  row("Declared tokens", audit.declaredTokens.size);
  report();
  row(
    "Arbitrary values in authored code",
    verdict(countViolations("arbitraryValue")),
  );
  row(
    "Colour literals (both classes)",
    verdict(countViolations("colourLiteral")),
  );
  row(
    "Token references resolve",
    verdict(countViolations("unresolvedReference")),
  );
  row(
    "Structural (anti-vacuous-pass)",
    verdict(audit.structuralFailures.length),
  );
  if (checkMode) {
    row("Committed inventory matches", verdict(drift.length));
  }
  report();
}

/* ==========================================================================
 * Entry point
 * ========================================================================== */

/**
 * The audited root defaults to this script's parent directory — the `nextjs/`
 * project root — rather than `process.cwd()`, so the audit behaves identically
 * whether it is invoked through `npm run audit:tokens`, from a subdirectory, or
 * by absolute path from anywhere on the filesystem.
 */
const SCRIPT_DIRECTORY = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

function main() {
  const options = parseCommandLine(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // `--root` moves where files are read from, for testing this script against
  // fixtures. It cannot relax a check: every threshold, classification and
  // verdict below is identical whichever root is audited.
  const root = options.root
    ? path.resolve(process.cwd(), options.root)
    : DEFAULT_ROOT;

  report(paint("bold", "Design-token audit — technical specification §0.3.5"));
  report(
    paint("dim", `  root: ${toRelativePosix(process.cwd(), root) || "."}`),
  );
  report();

  const audit = runAudit(root);
  const inventory = buildInventory(audit);
  const serialised = serialiseInventory(inventory);
  const inventoryAbsolute = path.join(root, INVENTORY_RELATIVE_PATH);

  /** @type {string[]} */
  let drift = [];
  const structurallySound = audit.structuralFailures.length === 0;

  if (options.check) {
    let committed = null;
    if (fs.existsSync(inventoryAbsolute)) {
      try {
        committed = fs.readFileSync(inventoryAbsolute, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AuditFailure(
          `Cannot read ${INVENTORY_RELATIVE_PATH}: ${message}`,
        );
      }
    }
    drift = describeInventoryDrift(committed, inventory);
  } else if (structurallySound) {
    // Written only when the run was structurally sound. A structural failure
    // means the audit found nothing to audit, and recording an empty inventory
    // would replace a real one with a vacuous one.
    try {
      fs.mkdirSync(path.dirname(inventoryAbsolute), { recursive: true });
      fs.writeFileSync(inventoryAbsolute, serialised, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AuditFailure(
        `Cannot write ${INVENTORY_RELATIVE_PATH}: ${message}`,
      );
    }
  }

  if (options.json !== undefined) {
    const jsonPath = path.resolve(process.cwd(), options.json);
    // The extra report is not committed, so it may carry the line-level detail
    // the inventory deliberately omits.
    const extra = {
      ...inventory,
      structuralFailures: audit.structuralFailures,
      violations: audit.violations,
      permittedFindings: audit.permitted,
      inventoryDrift: drift,
    };
    try {
      fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
      fs.writeFileSync(jsonPath, serialiseInventory(extra), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AuditFailure(`Cannot write ${options.json}: ${message}`);
    }
  }

  if (audit.violations.length > 0) reportViolations(audit.violations);
  reportPermitted(audit.permitted);

  if (audit.anomalies.length > 0) {
    report(
      paint(
        "bold",
        `Anomalies — review, not failures (${audit.anomalies.length})`,
      ),
    );
    report();
    for (const anomaly of audit.anomalies) {
      report(`  ${paint("yellow", "!")} ${anomaly}`);
    }
    report();
  }

  reportSummary(audit, drift, options.check);

  if (audit.structuralFailures.length > 0) {
    diagnostic(
      paint("red", "Structural failure — the audit could not do its job:"),
    );
    for (const failure of audit.structuralFailures) {
      diagnostic(`  - ${failure}`);
    }
    diagnostic();
  }

  if (drift.length > 0) {
    diagnostic(paint("red", `Inventory drift (${drift.length}):`));
    for (const entry of drift) diagnostic(`  - ${entry}`);
    diagnostic(
      "  Run `npm run audit:tokens` without --check and commit the result.",
    );
    diagnostic();
  }

  const failed =
    audit.violations.length > 0 ||
    audit.structuralFailures.length > 0 ||
    drift.length > 0;

  if (failed) {
    report(paint("red", "audit:tokens FAILED"));
    return 1;
  }

  report(paint("green", "audit:tokens passed"));
  if (!options.check) {
    report(paint("dim", `  inventory written to ${INVENTORY_RELATIVE_PATH}`));
  }
  return 0;
}

// Top-level error handling. Nothing is downgraded: an `AuditFailure` is
// reported and exits 1, and an unexpected error also exits 1 with its stack, so
// no defect in this script can produce a false pass.
try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof AuditFailure) {
    diagnostic(paint("red", `audit:tokens FAILED: ${error.message}`));
  } else {
    diagnostic(paint("red", "audit:tokens FAILED with an unexpected error:"));
    diagnostic(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
  process.exitCode = 1;
}
