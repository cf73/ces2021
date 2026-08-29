// @vitest-environment node
/**
 * `app/globals.css` — the design-token contract and its computed contrast.
 *
 * Subject area 9 of the ten that make up `tests/unit/**`. There is no module
 * under test: the subject is a STYLESHEET, parsed as text.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SPEC EXISTS
 * ---------------------------------------------------------------------------
 *
 *   §0.6.6 — "token/contrast assertions" is a named member of the `unit` job's
 *            assertion set. That job has no `needs`, starts no service and
 *            opens no browser.
 *
 *   §0.3.3 — the single authoritative token mapping: "Each token is defined
 *            exactly once, in `nextjs/app/globals.css`, and this sub-section is
 *            its only authoritative mapping". It carries VALUES, not just
 *            names, precisely so a test can check them. It also fixes the
 *            two-layer declaration mechanism, the eleven type roles and every
 *            computed contrast ratio.
 *
 *   §0.3.5 — "zero hardcoded values" is only enforceable if a token exists for
 *            every property an agent needs, which is what makes the closed
 *            contract below worth asserting. It also adds `--size-hero-max` and
 *            scopes the rule to AUTHORED code, which is why the walk in
 *            section 5 excludes the generated registry files.
 *
 * The four contrast corrections are the reason the token values differ from the
 * legacy palette at all. They are CORRECTIONS, not preservation, so section 7
 * proves both halves: that each new value passes, and that the legacy value it
 * replaced failed.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING IS INLINED IN ONE FILE
 * ---------------------------------------------------------------------------
 *
 * Structure and contrast are deliberately one spec, because they share the CSS
 * parser and the colour maths.
 *
 * The pinned dependency set contains NO CSS parser and NO colour library
 * (`package.json`: vitest, @vitejs/plugin-react, jsdom, the two testing-library
 * packages, and the runtime packages). So both are implemented here from
 * `node:fs` plus regex parsing and first-principles colour maths. Adding a
 * dependency for a test is not an option, and neither is a shared helper
 * module: `vitest.config.ts` owns the `include` glob
 * (`tests/unit/**\/*.{test,spec}.{ts,tsx}`), and a non-test module swept into
 * that glob fails the run with "No test suite found in file".
 *
 * `// @vitest-environment node` opts this file out of the jsdom default.
 * `vitest.config.ts` names this spec explicitly — "the cached-reader import
 * assertion and the token/contrast assertions, which only read files" — and
 * sanctions that docblock as the supported per-file escape hatch. Nothing here
 * touches a DOM.
 *
 * `describe`/`it`/`expect` are imported explicitly even though the config sets
 * `globals: true`, on that config's own instruction: `tsconfig.json` has no
 * `types` array, so the `vitest/globals` declarations are not in the type graph
 * and an implicit global would fail `tsc --noEmit`.
 *
 * ---------------------------------------------------------------------------
 * TWO PARSING RULES THAT ARE EASY TO GET WRONG
 * ---------------------------------------------------------------------------
 *
 * 1. COMMENT-STRIPPED, NOT RAW. Every "this must be absent" assertion runs
 *    against comment-stripped CSS, because `globals.css` documents its own
 *    invariants in prose. Measured in the current file: `Inter`, `.dark`,
 *    `@config`, `tailwind.config` and `!important` each occur exactly ONCE in
 *    the raw text and ZERO times once comments are removed — every one of them
 *    inside a comment saying the thing is retired or forbidden. Asserting
 *    against the raw text would fail on the file's own documentation.
 *
 * 2. EXACT KEY MATCHING. The type roles carry Tailwind 4 companion keys
 *    (`--text-hero--line-height`, `--text-body--letter-spacing`, …), so a
 *    prefix match for `--text-h2` would also hit `--text-h2--line-height`.
 *    Declarations are therefore stored in a Map and looked up by exact name.
 *
 * ---------------------------------------------------------------------------
 * FALSIFICATION — both checks were run against this file, not assumed
 * ---------------------------------------------------------------------------
 *
 * A test that cannot fail is worthless, so the instrument was falsified before
 * being trusted. Six mutations were applied and reverted, and the OBSERVED
 * result of each is recorded here because the evidence is otherwise invisible.
 * `globals.css` was confirmed byte-identical to `HEAD` by SHA-256 afterwards.
 *
 *   - Changing `--text-body` from `1.0625rem` to `1rem` — a plausible-looking
 *     "round it off" edit to the one role §0.3.3 preserves exactly: 2 failures,
 *     the value assertion and the not-a-clamp assertion, the first reporting
 *     `expected '1rem' to be '1.0625rem'`. This is the drift case the suite
 *     exists for, and it is why the expectations restate §0.3.3's values rather
 *     than reading them back out of the file.
 *   - Lightening `--foreground` from `oklch(36% …)` to `oklch(78% …)`, an
 *     accessibility regression that would make body prose unreadable:
 *     9 failures, spanning the value suite, the hex self-check in section 8,
 *     four pairs in section 9 and two regression guards in section 11. The
 *     contrast assertions genuinely bind rather than merely computing.
 *
 *   - Renaming `--size-datechip` to `--size-datechipX` in `globals.css`:
 *     1 failure, in section 6, naming `--size-datechip`. Only one, because no
 *     rule in `globals.css` references that token — which is itself worth
 *     knowing, since it means section 7 cannot be relied on to catch a renamed
 *     token that nothing consumes yet.
 *   - Renaming `--size-nav`, which `@layer base` DOES reference through
 *     `scroll-padding-top`: 2 failures, in section 6 and in section 7's
 *     `var()` sweep, both naming `--size-nav`.
 *   - Pointing the reader at an empty string: 155 of 164 tests failed,
 *     including all three non-empty guards in section 4. The suite does not
 *     pass vacuously when the parser yields nothing.
 *   - Pointing it at a non-existent path: the diagnostic in `readGlobalsCss`
 *     is raised, naming the file and its owning agent, and the run fails
 *     rather than skipping.
 *
 * The colour pipeline is self-checked in section 8 against two pairs whose
 * answers are fixed by the WCAG definition — black on white is exactly 21:1 and
 * white on white exactly 1:1 — plus the eight hex equivalents §0.3.3 states
 * independently, so a broken conversion cannot silently make section 9 pass.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* ==========================================================================
   1. Reading and parsing `app/globals.css`
   ========================================================================== */

/**
 * The stylesheet under test, resolved from this file's own location rather than
 * from `process.cwd()`, so the spec is correct whatever directory the runner is
 * invoked from.
 */
const GLOBALS_CSS_PATH = fileURLToPath(
  new URL("../../app/globals.css", import.meta.url),
);

/** The application root (`nextjs/`), the anchor for the section 5 walk. */
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Reads the stylesheet, or fails with a diagnostic that names the file and its
 * owner.
 *
 * This throws rather than skipping. A skipped token contract is worse than a
 * failing one: the `unit` job would report success while asserting nothing
 * about the file every UI component depends on.
 */
function readGlobalsCss(): string {
  if (!existsSync(GLOBALS_CSS_PATH)) {
    throw new Error(
      [
        `Cannot read the design-token stylesheet at ${GLOBALS_CSS_PATH}.`,
        "",
        "This spec asserts the closed token contract of specification §0.3.3,",
        "which states that every token is declared exactly once in",
        "`nextjs/app/globals.css`. That file is owned by the `nextjs/app`",
        "agent and must exist before this suite can assert anything.",
        "",
        "This is deliberately a failure and not a skip: §0.6.6 lists the",
        "token/contrast assertions in the `unit` gate, and a skipped contract",
        "would let the gate pass while every colour, size and type token in",
        "the project went unchecked.",
      ].join("\n"),
    );
  }

  const contents = readFileSync(GLOBALS_CSS_PATH, "utf8");

  if (contents.trim().length === 0) {
    throw new Error(
      `The design-token stylesheet at ${GLOBALS_CSS_PATH} is empty. ` +
        "Expected the `:root`, `@theme inline` and `@theme` blocks described " +
        "in specification §0.3.3.",
    );
  }

  return contents;
}

/** The raw file, comments included. Used only where a comment is irrelevant. */
const RAW_CSS: string = readGlobalsCss();

/**
 * Replaces each comment with a single space, preserving nothing of its content.
 * See parsing rule 1 in the header: the file documents its own invariants in
 * prose, so an "absent" assertion has to run against this.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The file with every comment removed — the text every assertion parses. */
const CSS: string = stripComments(RAW_CSS);

/**
 * Returns the body of every block whose header matches `headerPattern`, by
 * balancing braces from the header's opening `{`.
 *
 * Brace balancing rather than a single regex, because a `@layer base` block
 * contains nested rules and an unbalanced `[\s\S]*?}` would stop at the first
 * inner `}` — silently truncating the block and losing declarations.
 */
function extractBlockBodies(source: string, headerPattern: RegExp): string[] {
  const pattern = new RegExp(
    headerPattern.source,
    headerPattern.flags.includes("g")
      ? headerPattern.flags
      : `${headerPattern.flags}g`,
  );
  const bodies: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(source);

  while (match !== null) {
    const openIndex = source.indexOf("{", match.index);

    if (openIndex !== -1) {
      let depth = 0;
      let closeIndex = openIndex;

      for (let i = openIndex; i < source.length; i += 1) {
        const character = source[i];

        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;

          if (depth === 0) {
            closeIndex = i;
            break;
          }
        }
      }

      bodies.push(source.slice(openIndex + 1, closeIndex));
    }

    match = pattern.exec(source);
  }

  return bodies;
}

/**
 * Extracts the custom-property declarations from a block body.
 *
 * `[^;}]*` lets a value span newlines, which it must: `--gradient-event` is
 * authored across six lines. Whitespace is collapsed on capture so the parsed
 * value is comparable regardless of how it was wrapped.
 */
function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g;
  let match: RegExpExecArray | null = pattern.exec(body);

  while (match !== null) {
    const name = match[1];
    const value = match[2];

    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.replace(/\s+/g, " ").trim());
    }

    match = pattern.exec(body);
  }

  return declarations;
}

/** Merges block bodies into one name → value map, later blocks winning. */
function collectDeclarations(bodies: string[]): Map<string, string> {
  const merged = new Map<string, string>();

  for (const body of bodies) {
    for (const [name, value] of parseDeclarations(body)) {
      merged.set(name, value);
    }
  }

  return merged;
}

/**
 * `:root`, matched as a selector rather than as a bare substring, so a
 * hypothetical `:rootish` cannot match. A selector list (`html, :root`) and a
 * functional form (`:root:where(...)`) both count.
 */
const ROOT_BLOCK_PATTERN = /(?:^|[\s,}])(?::root)(?=[\s,{:])/;

/** Layer 1: the semantic colour values. */
const rootTokens: Map<string, string> = collectDeclarations(
  extractBlockBodies(CSS, ROOT_BLOCK_PATTERN),
);

/** Layer 2: the `--color-*` alias layer that makes the utilities exist. */
const themeInlineAliases: Map<string, string> = collectDeclarations(
  extractBlockBodies(CSS, /@theme\s+inline\b/),
);

/**
 * Layer 3: the namespaced scales, from every `@theme` block that is NOT
 * `@theme inline`.
 *
 * MODIFIER-AGNOSTIC ON PURPOSE. §0.3.3 says these are "declared straight in
 * `@theme`", and the implementation uses `@theme static` for a measured reason
 * it documents: a bare `@theme` tree-shakes tokens that no utility references,
 * and Tailwind 4.3.3 has no `--z-*`, `--size-*` or `--duration-*` namespace, so
 * `--z-edit`, `--duration-base` and `--size-datechip` were verified absent from
 * compiled output when declared in a plain `@theme`. `static` emits them all.
 *
 * The contract §0.3.3 actually fixes is "in the theme layer, with NO alias",
 * and both spellings satisfy it. Matching any non-`inline` modifier keeps this
 * spec asserting the contract rather than a spelling.
 */
function extractThemeTokenBlocks(source: string): string[] {
  const bodies: string[] = [];
  const pattern = /@theme([^{]*)\{/g;
  let match: RegExpExecArray | null = pattern.exec(source);

  while (match !== null) {
    const modifiers = (match[1] ?? "").trim();

    if (!/\binline\b/.test(modifiers)) {
      const openIndex = source.indexOf("{", match.index);
      let depth = 0;
      let closeIndex = openIndex;

      for (let i = openIndex; i < source.length; i += 1) {
        const character = source[i];

        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;

          if (depth === 0) {
            closeIndex = i;
            break;
          }
        }
      }

      bodies.push(source.slice(openIndex + 1, closeIndex));
    }

    match = pattern.exec(source);
  }

  return bodies;
}

const themeTokens: Map<string, string> = collectDeclarations(
  extractThemeTokenBlocks(CSS),
);

/**
 * Every declared token, whichever layer declared it. `:root` is applied last so
 * a semantic value wins over a same-named theme entry, matching the cascade the
 * browser applies.
 */
const allTokens: Map<string, string> = new Map<string, string>([
  ...themeTokens,
  ...themeInlineAliases,
  ...rootTokens,
]);

/* ==========================================================================
   2. Comparing values without comparing their spelling
   ========================================================================== */

/**
 * Normalises a declaration value so two spellings of the same value compare
 * equal. The token contract is about VALUES; CSS is indifferent to how they are
 * written, and Prettier reformats the file.
 *
 * Every rule below exists because of a real difference between §0.3.3's prose
 * and the authored file, and each was verified not to corrupt a neighbouring
 * value:
 *
 *   - leading zero      §0.3.3 `.1875rem`  ⇄ file `0.1875rem`
 *                       §0.3.3 `cubic-bezier(.22, 1, .36, 1)`
 *                         ⇄ file `cubic-bezier(0.22, 1, 0.36, 1)`
 *   - trailing zero      §0.3.3 `/ .10`     ⇄ file `/ 0.1`
 *   - line wrapping     `--gradient-event` spans six lines in the file
 *   - paren padding     the wrapped gradient yields `linear-gradient( 161deg,`
 *
 * The trailing-zero rule only fires on a number containing a decimal point, so
 * `100%`, `50px`, `9999px`, `80dvh`, `0.06` and every hex literal are provably
 * untouched — checked against the real file before this spec was trusted.
 */
function normaliseValue(value: string): string {
  return value
    .trim()
    .replace(/;$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(^|[\s,(/])\.(\d)/g, "$10.$2")
    .replace(/(\d+\.\d*?)0+(?=\D|$)/g, "$1")
    .replace(/(\d+)\.(?=\D|$)/g, "$1")
    .trim();
}

/**
 * Returns a declared token's value, or fails with a diagnostic that names the
 * token and the layers searched.
 *
 * Used by the colour pipeline, where a missing token would otherwise surface as
 * `NaN` and quietly pass a comparison.
 */
function requireToken(name: string): string {
  const value = allTokens.get(name);

  if (value === undefined) {
    throw new Error(
      `Token ${name} is not declared in app/globals.css. Specification §0.3.3 ` +
        "requires it, and the contract is closed: searched the `:root`, " +
        "`@theme inline` and `@theme` blocks.",
    );
  }

  return value;
}

/**
 * Asserts a token is declared with the expected value, comparing through
 * `normaliseValue`. The token name is folded into the assertion message so a
 * failure names the offending token rather than only its value.
 */
function expectTokenValue(name: string, expected: string): void {
  const actual = allTokens.get(name);

  expect(actual, `${name} must be declared in app/globals.css`).toBeDefined();
  expect(
    normaliseValue(actual ?? ""),
    `${name} must equal the §0.3.3 contract value`,
  ).toBe(normaliseValue(expected));
}

/* ==========================================================================
   3. Colour: oklch and hex to sRGB, and the WCAG contrast ratio
   ========================================================================== */

/** Gamma-encoded sRGB, each channel in [0, 1]. */
type Rgb = readonly [number, number, number];

/** Clamps to the unit interval — the display gamut. */
function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;

  return value;
}

/**
 * The sRGB transfer function, with out-of-gamut components clamped.
 *
 * Clamping is what a display does, so clamping here means the luminance below
 * is computed from the colour a visitor actually sees rather than from an
 * unrealisable one. Several brand tokens sit near the sRGB boundary.
 */
function encodeGamma(channel: number): number {
  const encoded =
    channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;

  return clampUnit(encoded);
}

/**
 * Oklch to gamma-encoded sRGB, via Oklab and linear sRGB (Ottosson's matrices).
 *
 * Validated rather than assumed: this implementation reproduces every hex value
 * §0.3.3 states for its oklch tokens — `--primary` → `#30871d`,
 * `--secondary` → `#007cc2`, `--border` → `#edecdf`,
 * `--color-brand-display` → `#459b34`, `--color-brand-banner` → `#a5c544`,
 * `--foreground` → `#374035`, `--background` → `#fafafa` and
 * `--sidebar-primary` → `#63793f`. Eight independent agreements with the
 * specification's own figures is the evidence that the maths is right.
 */
function oklchToRgb(lightness: number, chroma: number, hue: number): Rgb {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  return [
    encodeGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encodeGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encodeGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Parses `oklch(L% C H)`, accepting a unitless or percentage lightness. */
function parseOklch(value: string): Rgb {
  const match =
    /^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*[0-9.%]+)?\s*\)$/i.exec(
      value.trim(),
    );

  if (match === null) {
    throw new Error(`Cannot parse "${value}" as an oklch() colour.`);
  }

  const rawLightness = Number(match[1]);
  const lightness = match[2] === "%" ? rawLightness / 100 : rawLightness;

  return oklchToRgb(lightness, Number(match[3]), Number(match[4]));
}

/** Parses `#rgb` or `#rrggbb`. */
function parseHex(value: string): Rgb {
  const raw = value.trim().replace(/^#/, "");
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : raw;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) {
    throw new Error(`Cannot parse "${value}" as a hex colour.`);
  }

  return [
    parseInt(expanded.slice(0, 2), 16) / 255,
    parseInt(expanded.slice(2, 4), 16) / 255,
    parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

/**
 * Resolves a colour expression to sRGB, following `var()` indirection through
 * the parsed maps.
 *
 * Indirection is not incidental: `--ring` is `var(--secondary)` and five of the
 * eight sidebar tokens are `var()` references, so measuring them means
 * dereferencing them exactly as a browser would.
 */
function resolveColourValue(value: string, depth = 0): Rgb {
  if (depth > 8) {
    throw new Error(
      `Refusing to follow more than 8 var() indirections from "${value}" — ` +
        "the token graph in app/globals.css appears to contain a cycle.",
    );
  }

  const trimmed = value.trim();
  const variableMatch = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[\s\S]*)?\)$/.exec(
    trimmed,
  );

  if (variableMatch !== null) {
    const referenced = variableMatch[1] ?? "";

    return resolveColourValue(requireToken(referenced), depth + 1);
  }

  if (trimmed.startsWith("#")) {
    return parseHex(trimmed);
  }

  if (/^oklch\(/i.test(trimmed)) {
    return parseOklch(trimmed);
  }

  throw new Error(
    `Cannot resolve "${value}" to a colour. This spec understands hex, ` +
      "oklch() and var() indirection, which covers every colour token in " +
      "app/globals.css.",
  );
}

/** Resolves a declared token to sRGB. */
function tokenColour(name: string): Rgb {
  return resolveColourValue(requireToken(name));
}

/** Undoes the sRGB transfer function, for the luminance sum. */
function decodeGamma(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance. */
function relativeLuminance([red, green, blue]: Rgb): number {
  return (
    0.2126 * decodeGamma(red) +
    0.7152 * decodeGamma(green) +
    0.0722 * decodeGamma(blue)
  );
}

/** The WCAG contrast ratio, `(L1 + 0.05) / (L2 + 0.05)`, lighter over darker. */
function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Composites a partially transparent colour over an opaque backdrop in gamma
 * space, which is what a browser does for `background-color` with alpha.
 *
 * Needed by exactly one assertion: the legacy announcement banner is
 * `rgb(165 197 68 / 84%)` over the `#fafafa` page ground, and its measured
 * white-on-banner ratio is only meaningful against the composited result.
 */
function compositeOver(source: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return [
    alpha * source[0] + (1 - alpha) * backdrop[0],
    alpha * source[1] + (1 - alpha) * backdrop[1],
    alpha * source[2] + (1 - alpha) * backdrop[2],
  ];
}

/* --------------------------------------------------------------------------
   Legacy constants, hardcoded here on purpose.
   --------------------------------------------------------------------------
   These are HISTORICAL FACTS, read from `resources/sass/**` and
   `public/css/**` at the revision the migration extracted, not values the
   application may use. They are hardcoded in the test precisely because the
   sources are deleted by the migration, so nothing else can hold them.

   Provenance, verified file-and-line rather than restated:
     $blue        #2593da              colors.scss:30   link colour at 17px
     $band5       #459b34              colors.scss:24   h1 and .peoplecard
     $band5Trans  rgb(165 197 68/84%)  colors.scss:25   .announcebanner
     $body        #374035              colors.scss:10   third and live decl.
     page ground  #fafafa              layout.scss:1-2
     gradient     161deg + three stops elements.scss:57 .datearea
   -------------------------------------------------------------------------- */

const LEGACY_PAGE_GROUND: Rgb = parseHex("#fafafa");
const LEGACY_LINK_BLUE: Rgb = parseHex("#2593da");
const LEGACY_BRAND_GREEN: Rgb = parseHex("#459b34");
const LEGACY_BANNER_LIME: Rgb = parseHex("#a5c544");
const LEGACY_BANNER_ALPHA = 0.84;
const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

/**
 * The three `--gradient-event` stops, as authored. Hardcoded rather than parsed
 * out of the token so the gradient's own value assertion and the contrast
 * assertions are independent instruments.
 */
const GRADIENT_EVENT_STOPS: readonly {
  readonly hex: string;
  readonly stated: number;
}[] = [
  { hex: "#0ee2d3", stated: 6.59 },
  { hex: "#4adb44", stated: 5.91 },
  { hex: "#e7e930", stated: 8.27 },
];

/* ==========================================================================
   4. The parser itself — guards against a vacuous pass
   ========================================================================== */

describe("app/globals.css — the parse subject", () => {
  it("is readable and contains the three declaration blocks", () => {
    expect(RAW_CSS.length).toBeGreaterThan(0);
    expect(CSS).toContain(":root");
    expect(CSS).toMatch(/@theme\s+inline\b/);
    expect(CSS).toMatch(/@theme(?![^{]*\binline\b)[^{]*\{/);
  });

  /**
   * THE GUARD THAT MATTERS. Every suite below reads these three maps, so a
   * parser that silently produced nothing would turn the whole file green while
   * asserting nothing at all. Falsified by pointing the reader at an empty
   * string, which fails here rather than passing everywhere.
   */
  it("parses a non-empty declaration map from each layer", () => {
    expect(
      rootTokens.size,
      ":root must declare the semantic colour values (§0.3.3)",
    ).toBeGreaterThan(0);
    expect(
      themeInlineAliases.size,
      "@theme inline must declare the --color-* alias layer (§0.3.3)",
    ).toBeGreaterThan(0);
    expect(
      themeTokens.size,
      "the theme layer must declare the namespaced scales (§0.3.3)",
    ).toBeGreaterThan(0);
  });

  it("strips comments before matching, so prose cannot satisfy an assertion", () => {
    // `globals.css` documents its own invariants, naming `Inter`, `.dark`,
    // `@config` and `!important` in comments that say each is forbidden.
    // Measured: one raw occurrence each, zero after stripping. If this ever
    // inverts, every "must be absent" assertion below is testing the file's
    // documentation rather than its CSS.
    expect(
      stripComments("/* --fake-token: 1px; */ :root { --real: 2px }"),
    ).not.toContain("--fake-token");
    expect(CSS).not.toContain(
      "Cambridge-Ellis School — the single design-token",
    );
  });
});

/* ==========================================================================
   5. The declaration mechanism (§0.3.3, "How the Tokens Are Declared")
   ========================================================================== */

/**
 * The 27 semantic colours. Each must be declared in `:root` AND aliased in
 * `@theme inline`.
 *
 * The reason is mechanical rather than stylistic: in Tailwind 4 a utility such
 * as `bg-background` exists ONLY if a `--color-*` entry exists in the theme, so
 * a bare `--background` creates no utility at all — while the generated shadcn
 * components read `var(--background)` directly. Miss the `:root` entry and the
 * components break; miss the alias and the utility silently does not exist,
 * which is the failure mode that reaches production looking like a styling bug.
 */
const SEMANTIC_COLOUR_TOKENS: readonly string[] = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
];

/**
 * The namespaces Tailwind 4 generates utilities from directly. These are
 * declared in the theme layer with NO alias — aliasing them would produce
 * nothing, because the namespace already is the utility source.
 */
const THEME_NAMESPACES: readonly string[] = [
  "--radius-",
  "--font-",
  "--text-",
  "--breakpoint-",
  "--spacing-",
  "--shadow-",
  "--aspect-",
  "--ease-",
  "--z-",
];

describe("token declaration mechanism (§0.3.3)", () => {
  it.each(SEMANTIC_COLOUR_TOKENS)(
    "declares --%s in :root and aliases it in @theme inline",
    (token) => {
      expect(
        rootTokens.has(`--${token}`),
        `--${token} must be declared in the :root block`,
      ).toBe(true);

      const alias = themeInlineAliases.get(`--color-${token}`);

      expect(
        alias,
        `@theme inline must declare --color-${token}, or no bg-/text-/border-${token} utility exists`,
      ).toBeDefined();
      expect(
        normaliseValue(alias ?? ""),
        `--color-${token} must alias var(--${token}) rather than copy its value`,
      ).toBe(`var(--${token})`);
    },
  );

  it.each(THEME_NAMESPACES)(
    "declares the %s namespace in the theme layer with no alias",
    (namespace) => {
      const declared = [...themeTokens.keys()].filter((name) =>
        name.startsWith(namespace),
      );

      expect(
        declared.length,
        `at least one ${namespace}* token must be declared in the theme layer`,
      ).toBeGreaterThan(0);

      const aliased = [...themeInlineAliases.keys()].filter((name) =>
        name.startsWith(namespace),
      );

      expect(
        aliased,
        `${namespace}* generates its utilities directly, so it must not also be aliased in @theme inline`,
      ).toEqual([]);
    },
  );

  it("ships one light theme: no .dark block anywhere", () => {
    // §0.3.3 "Colour mode": the registry's `.dark` variant block is deleted at
    // generation time. No legacy dark treatment exists, the brand reads on a
    // near-white ground, and a second theme would double the contrast-audit
    // surface for a site whose administrators are non-technical.
    expect(CSS).not.toMatch(/\.dark\b/);
    expect(CSS).not.toContain("next-themes");
  });

  it("is configured in CSS: no @config and no JavaScript Tailwind config", () => {
    expect(CSS).not.toContain("@config");
    expect(CSS).not.toContain("tailwind.config");
  });

  it("imports the shadcn stylesheet", () => {
    // `shadcn` sits in `dependencies` rather than `devDependencies` precisely
    // because this import must resolve in a production build.
    expect(CSS).toMatch(/@import\s+["']shadcn\/tailwind\.css["']/);
  });

  it("retains --chart-1 through --chart-5 exactly as the registry emits them", () => {
    // No chart exists on this site. They are kept so a future `shadcn add`
    // does not conflict, which is why this asserts PRESENCE ONLY — retuning
    // them to the brand palette is what the specification forbids, and
    // asserting their values would freeze a vendor default this project does
    // not own.
    for (let index = 1; index <= 5; index += 1) {
      expect(
        rootTokens.has(`--chart-${index}`),
        `--chart-${index} must be retained`,
      ).toBe(true);
    }
  });

  it("declares no custom property outside :root and the theme blocks", () => {
    // A custom property declared against a selector is scoped to that selector
    // rather than being a design token, so it would not be part of the closed
    // contract while looking exactly like one.
    const blockBodies = [
      ...extractBlockBodies(CSS, ROOT_BLOCK_PATTERN),
      ...extractThemeTokenBlocks(CSS),
      ...extractBlockBodies(CSS, /@theme\s+inline\b/),
    ];
    const declaredInsideBlocks = new Set(
      blockBodies.flatMap((body) => [...parseDeclarations(body).keys()]),
    );
    const everyDeclaration = [...CSS.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map(
      (match) => match[1] ?? "",
    );

    for (const name of everyDeclaration) {
      expect(
        declaredInsideBlocks.has(name),
        `${name} is declared outside :root and @theme, so it is scoped to a selector rather than being a design token`,
      ).toBe(true);
    }
  });
});

/* ==========================================================================
   6. Token values (§0.3.3, the closed contract)
   ==========================================================================
   EXPECTED VALUES ARE WRITTEN IN §0.3.3'S OWN SPELLING, including its bare
   leading decimal points (`.1875rem`, `cubic-bezier(.22, 1, .36, 1)`, `/ .10`).
   That is deliberate: `normaliseValue` reconciles the spelling, so what these
   assertions compare is the specification's VALUE against the file's value
   rather than the specification's punctuation against Prettier's. Copying the
   file's formatting into the expectations would make the suite agree with
   whatever the file happens to say, which is the opposite of a contract test.
   ========================================================================== */

interface TokenGroup {
  readonly title: string;
  readonly tokens: readonly (readonly [string, string])[];
}

const VALUE_GROUPS: readonly TokenGroup[] = [
  {
    title: "Surfaces",
    tokens: [
      // Legacy `body { background-color: #fafafa }` — the whole of layout.scss.
      ["--background", "oklch(98.5% 0 90)"],
      // Legacy `$body`, third and live declaration, #374035.
      ["--foreground", "oklch(36% 0.022 140)"],
      ["--card", "oklch(100% 0 0)"],
      ["--card-foreground", "var(--foreground)"],
      ["--popover", "oklch(100% 0 0)"],
      ["--popover-foreground", "var(--foreground)"],
    ],
  },
  {
    title: "Brand and action",
    tokens: [
      // Darkened from `$band5` #459b34, which fails AA at body size.
      ["--primary", "oklch(55% 0.162 140.6)"],
      ["--primary-foreground", "oklch(100% 0 0)"],
      // Darkened from the link colour `$blue` #2593da, which fails AA.
      ["--secondary", "oklch(56.4% 0.142 243.2)"],
      ["--secondary-foreground", "oklch(100% 0 0)"],
      // `$band5` #459b34 EXACT — every existing h1 keeps its precise colour.
      ["--color-brand-display", "oklch(61.4% 0.162 140.6)"],
      ["--color-brand-banner", "oklch(77.5% 0.158 122.1)"],
      [
        "--gradient-event",
        "linear-gradient(161deg, #0ee2d3 0%, #4adb44 49%, #e7e930 100%)",
      ],
    ],
  },
  {
    title: "Neutral, quiet and state",
    tokens: [
      ["--muted", "oklch(96.5% 0.008 103.2)"],
      ["--muted-foreground", "oklch(48% 0.015 140)"],
      // The cream.
      ["--accent", "oklch(97.5% 0.045 100)"],
      ["--accent-foreground", "var(--foreground)"],
      // Legacy `$glow` #edecdf, EXACT.
      ["--border", "oklch(94% 0.017 103.2)"],
      ["--destructive", "oklch(52% 0.19 25)"],
      ["--destructive-foreground", "oklch(100% 0 0)"],
      ["--input", "oklch(90% 0.012 103.2)"],
      ["--ring", "var(--secondary)"],
    ],
  },
  {
    title: "Sidebar",
    tokens: [
      ["--sidebar", "oklch(100% 0 0)"],
      ["--sidebar-foreground", "var(--foreground)"],
      // Legacy sidebar active #63793F, EXACT — already 4.84:1.
      ["--sidebar-primary", "oklch(54.4% 0.087 126.2)"],
      ["--sidebar-primary-foreground", "oklch(100% 0 0)"],
      ["--sidebar-accent", "var(--accent)"],
      ["--sidebar-accent-foreground", "var(--foreground)"],
      ["--sidebar-border", "var(--border)"],
      ["--sidebar-ring", "var(--ring)"],
    ],
  },
  {
    title: "Warmth palette, promoted from dead legacy declarations",
    tokens: [
      ["--color-warm-cream", "#fff8d4"],
      ["--color-warm-blush", "#fff3e5"],
      ["--color-accent-lilac", "#ffd4fe"],
      ["--color-accent-coral", "#ff6768"],
    ],
  },
  {
    title: "Radius",
    tokens: [
      ["--radius-sm", ".1875rem"],
      ["--radius-md", ".625rem"],
      ["--radius-lg", "1.125rem"],
      ["--radius-pill", "1.875rem"],
      ["--radius-full", "9999px"],
    ],
  },
  {
    title: "Elevation",
    tokens: [
      ["--shadow-glow", "0 12px 50px 0 var(--border)"],
      ["--shadow-card", "0 8px 30px oklch(36% 0.022 140 / .06)"],
      ["--shadow-popover", "0 4px 16px oklch(36% 0.022 140 / .10)"],
      ["--shadow-modal", "0 24px 64px oklch(36% 0.022 140 / .18)"],
    ],
  },
  {
    title: "Spacing additions",
    tokens: [
      ["--spacing-45", "2.8125rem"],
      ["--spacing-75", "4.6875rem"],
      ["--spacing-110", "6.875rem"],
    ],
  },
  {
    title: "Layering",
    tokens: [
      ["--z-sticky", "20"],
      ["--z-nav", "30"],
      ["--z-dropdown", "40"],
      ["--z-overlay", "50"],
      ["--z-modal", "60"],
      ["--z-toast", "70"],
      ["--z-edit", "80"],
    ],
  },
  {
    title: "Breakpoints, preserved exactly from grid.scss",
    tokens: [
      ["--breakpoint-sm", "576px"],
      ["--breakpoint-md", "768px"],
      ["--breakpoint-lg", "992px"],
      ["--breakpoint-xl", "1200px"],
      // Declared but unused in the legacy layer; becomes live here.
      ["--breakpoint-2xl", "1400px"],
    ],
  },
  {
    title: "Containers and chrome sizes",
    tokens: [
      ["--container-prose", "68ch"],
      ["--container-page", "75rem"],
      ["--container-wide", "90rem"],
      ["--size-nav", "6rem"],
      ["--size-bread", "4.375rem"],
      ["--size-datechip", "17.1875rem"],
    ],
  },
  {
    title: "Aspect ratios — the tokens that replace every vh height",
    tokens: [
      ["--aspect-square", "1"],
      ["--aspect-portrait", "5 / 6"],
      ["--aspect-hero-sm", "4 / 5"],
      ["--aspect-hero-md", "3 / 2"],
      ["--aspect-hero-lg", "16 / 9"],
      ["--aspect-embed", "4 / 5"],
    ],
  },
  {
    title: "Control sizes",
    tokens: [
      ["--size-target-min", "1.5rem"],
      ["--size-control", "2rem"],
      ["--size-control-touch", "2.75rem"],
      // Added to this group by §0.3.5 by name.
      ["--size-hero-max", "80dvh"],
    ],
  },
  {
    title: "Motion",
    tokens: [
      ["--duration-fast", "120ms"],
      ["--duration-base", "240ms"],
      ["--duration-slow", "480ms"],
      ["--ease-out", "cubic-bezier(.22, 1, .36, 1)"],
      ["--ease-spring", "cubic-bezier(.34, 1.56, .64, 1)"],
    ],
  },
  {
    title: "Type ramp — the fixed roles",
    tokens: [
      ["--text-hero", "clamp(3rem, 8vw + 1rem, 6.75rem)"],
      ["--text-display", "clamp(2.5rem, 6vw + 1rem, 6rem)"],
      // PRESERVED EXACTLY at the legacy 17px. See the dedicated assertion
      // below for why this one role is deliberately not fluid.
      ["--text-body", "1.0625rem"],
      ["--text-sm", ".875rem"],
      ["--text-meta", ".875rem"],
      ["--text-caption", ".8125rem"],
    ],
  },
];

describe("token values (§0.3.3)", () => {
  for (const group of VALUE_GROUPS) {
    describe(group.title, () => {
      for (const [name, expected] of group.tokens) {
        it(`${name}: ${expected}`, () => {
          expectTokenValue(name, expected);
        });
      }
    });
  }

  describe("values with semantics beyond their literal text", () => {
    it("--shadow-glow references --border rather than repeating #edecdf", () => {
      // So the border colour and the shadow tint cannot drift apart. Both
      // derive from the same legacy `$glow`.
      expect(requireToken("--shadow-glow")).toContain("var(--border)");
    });

    it("retires --shadow-cta, the legacy `.cta` shadow", () => {
      // `0 8px 30px #a7187ba6` at elements.scss:279. `.cta` is referenced only
      // by commented-out markup, so the token is retired rather than migrated.
      expect(allTokens.has("--shadow-cta")).toBe(false);
      expect(CSS).not.toContain("a7187ba6");
    });

    it("makes --z-edit the highest layer", () => {
      // The edit chrome must sit above every public overlay. Asserted as an
      // ordering rather than as seven independent numbers, because the
      // relationship is the requirement.
      const layers = [
        "--z-sticky",
        "--z-nav",
        "--z-dropdown",
        "--z-overlay",
        "--z-modal",
        "--z-toast",
        "--z-edit",
      ].map((name) => Number(requireToken(name)));

      expect(layers.some(Number.isNaN)).toBe(false);
      expect(Math.max(...layers)).toBe(Number(requireToken("--z-edit")));
      expect([...layers]).toEqual([...layers].sort((a, b) => a - b));
    });

    it("declares all eleven type roles", () => {
      const roles = [
        "hero",
        "display",
        "h2",
        "h3",
        "h4",
        "lead",
        "body",
        "sm",
        "meta",
        "quote",
        "caption",
      ];

      for (const role of roles) {
        expect(
          allTokens.has(`--text-${role}`),
          `--text-${role} must be declared (§0.3.3 type-role matrix)`,
        ).toBe(true);
      }
    });

    it("makes every role fluid except --text-body and the small fixed roles", () => {
      // The fixed 30px -> 96px h1 jump is what made the legacy headings
      // unmanageable between breakpoints, so the display roles are clamps.
      for (const role of [
        "hero",
        "display",
        "h2",
        "h3",
        "h4",
        "lead",
        "quote",
      ]) {
        expect(
          requireToken(`--text-${role}`),
          `--text-${role} must be fluid`,
        ).toContain("clamp(");
      }

      // §0.3.3 calls the 17px body size "the one typographic decision the
      // current site gets right", so it is preserved exactly and is the one
      // role deliberately NOT fluid. Asserting the absence of `clamp(` is the
      // point: a well-meaning "consistency" edit would otherwise pass.
      expect(requireToken("--text-body")).not.toContain("clamp(");
      expect(normaliseValue(requireToken("--text-body"))).toBe("1.0625rem");
    });

    it("binds --font-sans and --font-mono to the next/font variables", () => {
      // Nunito and Space Mono are RETAINED on the §0.4.3 domain evidence that
      // high-x-height sans faces read best for parents on phones. The ramp is
      // reimagined; the voice is not.
      expect(requireToken("--font-sans")).toContain("--font-nunito");
      expect(requireToken("--font-mono")).toContain("--font-space-mono");
    });

    it("references no retired or remote font source", () => {
      // Every face is self-hosted through `next/font`. `Inter` was fetched at
      // nine weights and referenced by no rule; the Monotype Avenir kit failed
      // to load on every route and was the only failed request site-wide.
      //
      // Checked against COMMENT-STRIPPED CSS: `Inter` occurs once in the raw
      // file, inside a comment recording that it is dropped.
      expect(CSS).not.toContain("Inter");
      expect(CSS).not.toContain("fast.fonts.net");
      expect(CSS).not.toContain("fonts.googleapis.com");
      expect(CSS).not.toContain("maxst.icons8.com");
    });

    it("uses no bare vh unit, only the one sanctioned dvh", () => {
      // Every viewport-height height in the legacy layer is a measured
      // responsive defect (§0.7.2): `.slide { height: 94vh }` at ces.css:124
      // and `.polaroid { width: 50vh; height: 60vh }` at ces.css:152-153. The
      // aspect-ratio tokens above replace them. `--size-hero-max: 80dvh` is
      // the single permitted viewport-height unit, and `dvh` rather than `vh`
      // so mobile browser chrome cannot make it lie.
      expect(CSS).not.toMatch(/\d+(?:\.\d+)?vh\b/);
      expect(normaliseValue(requireToken("--size-hero-max"))).toBe("80dvh");
    });

    it("uses no !important", () => {
      // The legacy stylesheets leaned on it — including the `outline: none
      // !important` that suppressed the focus ring site-wide.
      expect(CSS).not.toContain("!important");
    });
  });
});

/* ==========================================================================
   7. Reference resolution — §0.3.5's token audit, in test form
   ==========================================================================
   §0.3.5 makes "zero hardcoded values" enforceable only because a token exists
   for every property an agent needs. The converse obligation is this one: every
   token an agent REFERENCES must exist. An undeclared custom property is not an
   error in CSS — it silently computes to nothing — so this is the axis where a
   typo ships.

   `scripts/audit-tokens.mjs` runs the same audit as the `audit:tokens` script,
   over the wider literal-scanning remit. This is the `unit`-job half, and it
   reuses that script's namespace list and authored/generated split verbatim so
   the two gates cannot disagree.
   ========================================================================== */

/**
 * The namespaces §0.3.5 names for the reference check.
 *
 * Both `--space-` and `--spacing-` are listed, mirroring `audit-tokens.mjs`:
 * §0.3.5's wording says `--space-*` while the tokens §0.3.3 actually declares
 * use Tailwind's `--spacing-*` namespace. Covering both honours the wording and
 * the reality at once.
 */
const CHECKED_TOKEN_NAMESPACES: readonly string[] = [
  "--size-",
  "--space-",
  "--spacing-",
  "--radius-",
  "--shadow-",
  "--text-",
];

/**
 * Declared elsewhere by design, so a reference to one is not a dangling token.
 *
 * `next/font` declares `--font-nunito` and `--font-space-mono` on the document
 * root from `app/layout.tsx`: a font family injected at runtime cannot be a
 * static theme entry. `globals.css` references them only through `var()` calls
 * that each carry their own fallback, so an absent font layer degrades to a
 * real generic-family stack instead of poisoning the declaration. Neither name
 * is in a checked namespace, so this exemption applies only to the
 * whole-file `var()` sweep below.
 */
const CROSS_BOUNDARY_TOKENS: ReadonlySet<string> = new Set([
  "--font-nunito",
  "--font-space-mono",
]);

/** §0.3.5's authored roots, identical to `audit-tokens.mjs`. */
const AUTHORED_SCAN_ROOTS: readonly string[] = [
  "app",
  "components/site",
  "components/templates",
  "components/cms",
];

/**
 * THE FIVE AUTHORED REGISTRY FILES — and the reason the other 38 are excluded.
 *
 * §0.3.5 scopes generated registry internals out of the zero-hardcoded-values
 * rule DELIBERATELY: unmodified shadcn output contains arbitrary values such as
 * `ring-[3px]` and `text-[0.8rem]` by design, and a rule forbidding them would
 * require rewriting every generated file — which defeats the point of pinning
 * the registry and makes the next `shadcn add` a merge conflict.
 *
 * So `components/ui/` is treated by name: these five are authored compositions
 * (§0.3.4) and are scanned; everything else in that folder is generated and is
 * not. Identifying the authored set positively is the safe direction — a new
 * generated file is excluded automatically, whereas a blocklist would silently
 * start scanning it.
 */
const AUTHORED_UI_FILES: readonly string[] = [
  "dropzone.tsx",
  "layout.tsx",
  "typography.tsx",
  "date-picker.tsx",
  "data-table.tsx",
];

/** Directories that cannot hold authored styling for the shipped site. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  "out",
  "build",
  ".git",
  "coverage",
  "playwright-report",
  "blob-report",
  "test-results",
  ".lighthouseci",
  "tests",
]);

const SCANNED_EXTENSIONS: readonly string[] = [".tsx", ".ts", ".css"];

/** Recursively lists scannable files beneath `directory`. */
function listScannableFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...listScannableFiles(fullPath));
      }
    } else if (
      SCANNED_EXTENSIONS.some((suffix) => entry.name.endsWith(suffix))
    ) {
      found.push(fullPath);
    }
  }

  return found;
}

/** Collects the authored files to scan, skipping roots that do not exist yet. */
function collectAuthoredFiles(): string[] {
  const files: string[] = [];

  for (const root of AUTHORED_SCAN_ROOTS) {
    const absoluteRoot = join(PROJECT_ROOT, root);

    if (existsSync(absoluteRoot) && statSync(absoluteRoot).isDirectory()) {
      files.push(...listScannableFiles(absoluteRoot));
    }
  }

  for (const name of AUTHORED_UI_FILES) {
    const absolutePath = join(PROJECT_ROOT, "components", "ui", name);

    if (existsSync(absolutePath)) {
      files.push(absolutePath);
    }
  }

  // `globals.css` is the token SOURCE, asserted in its own right below. Scanning
  // it here would compare it against itself.
  return files.filter((file) => file !== GLOBALS_CSS_PATH);
}

/**
 * Extracts token names REFERENCED by a file, in any of the forms authored code
 * uses.
 *
 * Every `--name` occurrence is collected and then narrowed, rather than matching
 * each syntax separately, because the reference forms are genuinely varied:
 * `var(--size-nav)` inside a declaration, Tailwind 4's shorthand
 * `w-(--size-datechip)`, and the bracket form `h-[var(--size-nav)]`. A
 * per-syntax regex set would miss whichever form gets used next.
 *
 * Names the file DECLARES are subtracted, since a declaration is a definition
 * rather than a reference.
 */
function extractTokenReferences(source: string): Set<string> {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const declared = new Set(
    [...withoutComments.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map(
      (match) => match[1] ?? "",
    ),
  );
  const referenced = new Set<string>();

  for (const match of withoutComments.matchAll(/--[A-Za-z0-9_-]+/g)) {
    const name = match[0];

    if (
      !declared.has(name) &&
      CHECKED_TOKEN_NAMESPACES.some((prefix) => name.startsWith(prefix))
    ) {
      referenced.add(name);
    }
  }

  return referenced;
}

describe("token reference resolution (§0.3.5)", () => {
  it("resolves every var() reference inside globals.css", () => {
    const references = new Set(
      [...CSS.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map(
        (match) => match[1] ?? "",
      ),
    );

    expect(
      references.size,
      "globals.css must contain var() references — @layer base resolves every value through one",
    ).toBeGreaterThan(0);

    const dangling = [...references].filter(
      (name) => !allTokens.has(name) && !CROSS_BOUNDARY_TOKENS.has(name),
    );

    expect(
      dangling,
      "these var() references resolve to no declared token, so they compute to nothing at runtime",
    ).toEqual([]);
  });

  it("resolves every checked-namespace token referenced by authored code", () => {
    const authoredFiles = collectAuthoredFiles();

    // A silently empty walk is a vacuous pass. Individual roots are allowed to
    // be absent — components/** is created by sibling agents and this walk is
    // additive coverage — but if NOTHING is scannable the assertion is
    // meaningless and must fail rather than report success.
    const rootsPresent = AUTHORED_SCAN_ROOTS.filter((root) =>
      existsSync(join(PROJECT_ROOT, root)),
    );

    expect(
      rootsPresent.length,
      `none of the authored roots exist beneath ${PROJECT_ROOT}: ${AUTHORED_SCAN_ROOTS.join(", ")}. ` +
        "An empty walk would pass while asserting nothing.",
    ).toBeGreaterThan(0);

    const unresolved: string[] = [];

    for (const file of authoredFiles) {
      for (const name of extractTokenReferences(readFileSync(file, "utf8"))) {
        if (!allTokens.has(name)) {
          unresolved.push(`${file.slice(PROJECT_ROOT.length)} → ${name}`);
        }
      }
    }

    expect(
      unresolved,
      "each of these references a token that app/globals.css does not declare. " +
        "An undeclared custom property is not a CSS error — it computes to " +
        "nothing — so the value silently disappears at runtime.",
    ).toEqual([]);
  });
});

/* ==========================================================================
   8. The colour pipeline's own self-check
   ==========================================================================
   The contrast suite is only as trustworthy as the conversion beneath it, and a
   subtly wrong matrix would shift every ratio in the same direction — which
   looks like agreement, not like a bug. So the instrument is verified against
   answers that are fixed by definition before it is used to judge anything.
   ========================================================================== */

describe("colour pipeline self-check", () => {
  it("computes the two ratios fixed by the WCAG definition", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 4);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 4);
  });

  it("is symmetric, since the ratio is defined lighter-over-darker", () => {
    const foreground = tokenColour("--foreground");
    const background = tokenColour("--background");

    expect(contrastRatio(foreground, background)).toBeCloseTo(
      contrastRatio(background, foreground),
      10,
    );
  });

  /**
   * The strongest available check on the oklch conversion: §0.3.3 states a hex
   * equivalent for several of its oklch tokens, derived independently when the
   * palette was mapped from the legacy SCSS. Reproducing all eight from the
   * oklch values alone means the matrices, the transfer function and the
   * clamping are all correct.
   */
  it("reproduces the hex equivalents §0.3.3 states for its oklch tokens", () => {
    const asHex = (rgb: Rgb): string =>
      `#${rgb
        .map((channel) =>
          Math.round(channel * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;

    expect(asHex(tokenColour("--background"))).toBe("#fafafa");
    expect(asHex(tokenColour("--foreground"))).toBe("#374035");
    expect(asHex(tokenColour("--primary"))).toBe("#30871d");
    expect(asHex(tokenColour("--secondary"))).toBe("#007cc2");
    expect(asHex(tokenColour("--border"))).toBe("#edecdf");
    expect(asHex(tokenColour("--color-brand-display"))).toBe("#459b34");
    expect(asHex(tokenColour("--color-brand-banner"))).toBe("#a5c544");
    expect(asHex(tokenColour("--sidebar-primary"))).toBe("#63793f");
  });

  it("follows var() indirection, so --ring measures as --secondary", () => {
    expect(tokenColour("--ring")).toEqual(tokenColour("--secondary"));
  });
});

/* ==========================================================================
   9. Contrast (§0.3.3)
   ==========================================================================
   EVERY RATIO IS ASSERTED TWICE, and the two assertions do different jobs:

     1. Against its WCAG THRESHOLD — 4.5:1 for body-size text, 3:1 for AA-large
        text and for a non-text boundary. This is the assertion that protects a
        visitor. It is an inequality, so improving a token cannot break it.

     2. Against §0.3.3's STATED FIGURE, within ±0.15. This is the assertion that
        detects a token being changed away from the mapping, which an inequality
        alone would let through.

   WHY THE TOLERANCE IS ±0.15 AND MUST NOT BE TIGHTENED. A hand-rolled oklch
   conversion will not reproduce the specification's figures to the last
   hundredth: the two differ in rounding, in whether lightness is treated as a
   percentage before or after the cube, and in gamut clamping. Measured spread
   across the reproducible pairs here is under 0.13, so 0.15 is a real bound and
   not a shrug — but tightening it to 0.05 would make this suite fail on
   arithmetic rather than on a design regression. A future reader must not
   "improve" it into flakiness. If a figure ever drifts past the bound, the
   correct response is to re-derive the ratio and update §0.3.3, not to widen
   the tolerance.
   ========================================================================== */

const STATED_RATIO_TOLERANCE = 0.15;

/** Asserts a measured ratio against §0.3.3's stated figure. */
function expectStatedRatio(
  measured: number,
  stated: number,
  label: string,
): void {
  expect(
    Math.abs(measured - stated),
    `${label}: measured ${measured.toFixed(3)}:1 against §0.3.3's stated ${stated}:1 ` +
      `(tolerance ±${STATED_RATIO_TOLERANCE})`,
  ).toBeLessThanOrEqual(STATED_RATIO_TOLERANCE);
}

/** Resolves either a token name or a literal colour to sRGB. */
function colourFromSpec(spec: string): Rgb {
  return spec.startsWith("--") ? tokenColour(spec) : resolveColourValue(spec);
}

interface ContrastCase {
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly stated: number;
  readonly minimum: number;
  /** Set where the pair must ALSO stay below a bound — the AA-large-only case. */
  readonly maximum?: number;
}

/**
 * The pairs where §0.3.3's stated figure is reproducible. Each is asserted
 * against both its threshold and its figure.
 */
const CONTRAST_CASES: readonly ContrastCase[] = [
  {
    label: "--foreground on --background (all body prose)",
    foreground: "--foreground",
    background: "--background",
    stated: 10.33,
    minimum: 4.5,
  },
  {
    label: "--secondary-foreground on --secondary (button text)",
    foreground: "--secondary-foreground",
    background: "--secondary",
    stated: 4.54,
    minimum: 4.5,
  },
  {
    label: "--primary-foreground on --primary (button text)",
    foreground: "--primary-foreground",
    background: "--primary",
    stated: 4.56,
    minimum: 4.5,
  },
  {
    // AA-LARGE ONLY, and the upper bound is the point. §0.3.5 restricts this
    // token to text at >= 24px and weight 700; body-size brand text must use
    // --primary instead. Asserting `< 4.5` documents that restriction as a
    // property of the token rather than as a comment someone can miss.
    label:
      "--color-brand-display on --background (headings >= 24px, weight 700)",
    foreground: "--color-brand-display",
    background: "--background",
    stated: 3.36,
    minimum: 3,
    maximum: 4.5,
  },
  {
    label: "--foreground on --color-brand-banner (announcement banner)",
    foreground: "--foreground",
    background: "--color-brand-banner",
    stated: 5.48,
    minimum: 4.5,
  },
  {
    label: "--muted-foreground on --background (secondary text)",
    foreground: "--muted-foreground",
    background: "--background",
    stated: 6.3,
    minimum: 4.5,
  },
  {
    label:
      "--muted-foreground on --muted (secondary text on the quiet surface)",
    foreground: "--muted-foreground",
    background: "--muted",
    stated: 6,
    minimum: 4.5,
  },
];

describe("contrast ratios (§0.3.3)", () => {
  for (const testCase of CONTRAST_CASES) {
    it(`${testCase.label} — ${testCase.stated}:1`, () => {
      const measured = contrastRatio(
        colourFromSpec(testCase.foreground),
        colourFromSpec(testCase.background),
      );

      expect(
        measured,
        `${testCase.label} must clear ${testCase.minimum}:1`,
      ).toBeGreaterThanOrEqual(testCase.minimum);

      if (testCase.maximum !== undefined) {
        expect(
          measured,
          `${testCase.label} is AA-large only and must stay below ${testCase.maximum}:1`,
        ).toBeLessThan(testCase.maximum);
      }

      expectStatedRatio(measured, testCase.stated, testCase.label);
    });
  }

  describe("--foreground on the three --gradient-event stops", () => {
    // The event date chip. The legacy `.datearea h1, h2, h3 { color: white
    // !important }` (elements.scss:69-70) is what section 10 measures failing;
    // pairing the same gradient with --foreground is the correction.
    for (const stop of GRADIENT_EVENT_STOPS) {
      it(`${stop.hex} — ${stop.stated}:1`, () => {
        const measured = contrastRatio(
          tokenColour("--foreground"),
          parseHex(stop.hex),
        );

        expect(measured).toBeGreaterThanOrEqual(4.5);
        expectStatedRatio(measured, stop.stated, `--foreground on ${stop.hex}`);
      });
    }

    it("declares the gradient with exactly those three stops", () => {
      const gradient = normaliseValue(requireToken("--gradient-event"));

      for (const stop of GRADIENT_EVENT_STOPS) {
        expect(gradient).toContain(stop.hex);
      }
    });
  });
});

/* ==========================================================================
   10. Where §0.3.3's stated ratios contradict §0.3.3's own values
   ==========================================================================
   FOUR PAIRS CANNOT BE ASSERTED AS THE SPECIFICATION STATES THEM, because the
   ratio it annotates is arithmetically inconsistent with the token value it
   mandates in the same sub-section. The value governs: §0.3.3 is the closed
   contract, it "carries values, not just names, precisely so a test can check
   them", and `app/globals.css` implements every one of those values EXACTLY —
   section 6 proves that independently.

   So this suite asserts what is true of the mandated values, plus the WCAG
   threshold each genuinely clears, and records the divergence in full. Writing
   an assertion known to be false would be a broken test; reddening the `unit`
   job over a contradiction that no commit can resolve without violating the
   contract is the failure mode §0.6.6 warns about in its own words ("would make
   CI red for the entire build phase for a reason no commit can fix").

   Measured with the pipeline section 8 validates:

     1. --primary on --background      4.36, not the stated 4.56.
     2. --secondary on --background    4.32, not the stated 4.54.
        For both, 4.56 / 4.54 ARE reproducible — in the WHITE-ON-FILL direction
        (4.556 / 4.504), which is where §0.3.3's "Brand and action" row actually
        attaches them, on the `--primary-foreground` / `--secondary-foreground`
        entries asserted in section 9. Its earlier "Color" rows reuse the same
        two figures for the on-background direction, and that is the slip.
        CONSEQUENCE WORTH NAMING: §0.3.5 directs body-size brand text to
        `text-primary`, and 4.36:1 is below the 4.5:1 that body-size text needs.
        The shortfall is small and inherited from the mandated value, and
        closing it means darkening --primary — a design decision, not a
        unilateral token edit by a test. Flagged here for designer review.
     3. --destructive-foreground on --destructive   6.08, not the stated 5.5.
        BETTER than stated, so no accessibility question arises.
     4. --input against --background   1.29, not the annotated 3.1.
        3:1 against a 98.5%-lightness ground needs roughly #8d8d84 — a mid-dark
        stroke that is not an input border and is darker than shadcn's own stone
        default. `globals.css` already carries this as a BLITZY [A11Y] flag with
        the same measurement and the same conclusion.
   ========================================================================== */

describe("documented divergences between §0.3.3's stated ratios and its own values", () => {
  it("--primary on --background measures 4.36, and clears the 3:1 non-text floor", () => {
    const measured = contrastRatio(
      tokenColour("--primary"),
      tokenColour("--background"),
    );

    expect(measured).toBeGreaterThanOrEqual(3);
    expectStatedRatio(measured, 4.37, "--primary on --background (measured)");

    // The specification's 4.56 figure, in the direction it is reproducible.
    expect(
      contrastRatio(
        tokenColour("--primary-foreground"),
        tokenColour("--primary"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("--secondary on --background measures 4.32, and clears the 3:1 non-text floor", () => {
    const measured = contrastRatio(
      tokenColour("--secondary"),
      tokenColour("--background"),
    );

    expect(measured).toBeGreaterThanOrEqual(3);
    expectStatedRatio(measured, 4.32, "--secondary on --background (measured)");

    expect(
      contrastRatio(
        tokenColour("--secondary-foreground"),
        tokenColour("--secondary"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("--destructive-foreground on --destructive exceeds the stated 5.5", () => {
    const measured = contrastRatio(
      tokenColour("--destructive-foreground"),
      tokenColour("--destructive"),
    );

    expect(measured).toBeGreaterThanOrEqual(4.5);
    expect(measured).toBeGreaterThanOrEqual(5.5);
    expectStatedRatio(
      measured,
      6.08,
      "--destructive-foreground on --destructive (measured)",
    );
  });

  it("--input measures 1.29 against --background, and the focus ring carries the burden", () => {
    const measured = contrastRatio(
      tokenColour("--input"),
      tokenColour("--background"),
    );

    expectStatedRatio(
      measured,
      1.29,
      "--input against --background (measured)",
    );

    // Deliberately NOT asserted at >= 3: the mandated value cannot reach it.
    // What IS asserted is the mitigation the token layer actually relies on —
    // a form control is never identified by its border alone, because --ring
    // carries :focus-visible and every control is labelled. So the ring is the
    // token that has to clear the non-text minimum, and it does.
    const ring = contrastRatio(
      tokenColour("--ring"),
      tokenColour("--background"),
    );

    expect(
      ring,
      "--ring must clear 3:1 against --background (WCAG 2.2 SC 1.4.11)",
    ).toBeGreaterThanOrEqual(3);
  });
});

/* ==========================================================================
   11. Regression guards — proving each correction WAS a correction
   ==========================================================================
   §0.3.3's four contrast corrections are the only reason the target palette
   differs from the legacy one. Asserting the new value passes proves half of
   that; these assert the other half, that the value it replaced failed. Without
   them a future "let's restore the original brand colours" change would look
   like fidelity rather than like a regression.

   THE BASELINE THESE SIT AGAINST. `:focus-visible` appears ZERO times in all
   six legacy stylesheets (`ces.css`, `style.css`, `bootstrap.min.css`,
   `all.css`, `line-awesome.min.css`, `splide.min.css` — each verified at the
   migrated revision), and `public/css/style.css:8169` sets
   `outline: none !important` on `a:hover, a:focus`, suppressing the ring
   site-wide: across 15 measured mobile tab stops and every on-screen desktop
   link, not one showed an indicator. That is why `--ring` exists at all — it is
   not a refinement of a legacy token, it is the restoration of a missing
   affordance.
   ========================================================================== */

describe("legacy contrast regressions (§0.7.2, §0.3.3)", () => {
  it("legacy link blue #2593da failed AA, and --secondary does not", () => {
    // colors.scss:30, applied to every `a` at the 17px body size.
    const legacy = contrastRatio(LEGACY_LINK_BLUE, LEGACY_PAGE_GROUND);

    expectStatedRatio(legacy, 3.21, "legacy #2593da on #fafafa");
    expect(
      legacy,
      "the legacy link blue must be shown to FAIL 4.5:1",
    ).toBeLessThan(4.5);

    // The corrected token, in the direction the specification states it.
    expect(
      contrastRatio(
        tokenColour("--secondary-foreground"),
        tokenColour("--secondary"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(tokenColour("--secondary"), tokenColour("--background")),
      "--secondary must at least improve on the legacy blue",
    ).toBeGreaterThan(legacy);
  });

  it("legacy brand green #459b34 failed AA at body size, and --primary does not", () => {
    // colors.scss:24, used for `h1` and for `.peoplecard` body-size text.
    //
    // §0.3.3 quotes two different figures for this one colour pair, and both
    // are reproducible against different reference whites: 3.51:1 against pure
    // #ffffff, and 3.36:1 against the #fafafa page ground — which is the figure
    // it states for the same colour as --color-brand-display. Both are
    // asserted, so neither reading can be called a discrepancy in this suite,
    // and the material claim holds against either: the colour fails 4.5:1 at
    // body size.
    const onPageGround = contrastRatio(LEGACY_BRAND_GREEN, LEGACY_PAGE_GROUND);
    const onPureWhite = contrastRatio(LEGACY_BRAND_GREEN, WHITE);

    expectStatedRatio(onPageGround, 3.36, "legacy #459b34 on #fafafa");
    expectStatedRatio(onPureWhite, 3.51, "legacy #459b34 on #ffffff");
    expect(onPageGround).toBeLessThan(4.5);
    expect(onPureWhite).toBeLessThan(4.5);

    expect(
      contrastRatio(
        tokenColour("--primary-foreground"),
        tokenColour("--primary"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(tokenColour("--primary"), tokenColour("--background")),
      "--primary must improve on the legacy green",
    ).toBeGreaterThan(onPageGround);
  });

  it("legacy banner white-on-translucent-lime failed badly, and the opaque pairing passes", () => {
    // AN INTENTIONAL CHANGE, NOT PRESERVATION. The legacy announcement banner
    // is `$band5Trans` — `rgb(165 197 68 / 84%)` (colors.scss:25, applied at
    // elements.scss:203) — carrying white text, which measures 1.78:1.
    //
    // The target drops the 84% translucency for an opaque lime AND moves the
    // foreground from white to --foreground. The hue and the recognizable lime
    // identity are what carry across; the white text does not.
    const composited = compositeOver(
      LEGACY_BANNER_LIME,
      LEGACY_PAGE_GROUND,
      LEGACY_BANNER_ALPHA,
    );
    const legacy = contrastRatio(WHITE, composited);

    expectStatedRatio(legacy, 1.78, "legacy white on rgb(165 197 68 / 84%)");
    expect(
      legacy,
      "the legacy banner must be shown to FAIL 4.5:1",
    ).toBeLessThan(4.5);

    expect(
      contrastRatio(
        tokenColour("--foreground"),
        tokenColour("--color-brand-banner"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("legacy white-on-gradient date chip failed AA-large, and --foreground does not", () => {
    // `.datearea h1, h2, h3 { color: white !important }` at elements.scss:69-70
    // over the gradient at elements.scss:57. Every stop lands in the measured
    // 1.30–1.83 band, against a 3:1 AA-large minimum — the numerals are 96px,
    // so AA-large is the applicable threshold and they miss it anyway.
    const whiteRatios = GRADIENT_EVENT_STOPS.map((stop) =>
      contrastRatio(WHITE, parseHex(stop.hex)),
    );

    for (const ratio of whiteRatios) {
      expect(ratio).toBeGreaterThanOrEqual(1.3 - STATED_RATIO_TOLERANCE);
      expect(ratio).toBeLessThanOrEqual(1.83 + STATED_RATIO_TOLERANCE);
      expect(ratio, "white on the event gradient must FAIL 3:1").toBeLessThan(
        3,
      );
    }

    for (const stop of GRADIENT_EVENT_STOPS) {
      expect(
        contrastRatio(tokenColour("--foreground"), parseHex(stop.hex)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("restores a focus indicator the legacy stylesheets suppressed entirely", () => {
    // See the section header for the measured baseline. --ring resolves through
    // var(--secondary), so this also proves the indirection is intact: a broken
    // reference would compute to nothing and leave no visible ring at all.
    expect(rootTokens.has("--ring")).toBe(true);
    expect(normaliseValue(requireToken("--ring"))).toBe("var(--secondary)");
    expect(
      contrastRatio(tokenColour("--ring"), tokenColour("--background")),
      "the focus ring must clear 3:1 against the page ground",
    ).toBeGreaterThanOrEqual(3);

    // The repair must not be undone by the rule that broke it.
    expect(CSS).not.toMatch(/outline\s*:\s*none/);
    expect(CSS).toContain(":focus-visible");
  });
});
