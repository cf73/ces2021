/**
 * Static build-output budget gate for the Cambridge-Ellis School application.
 *
 * This script turns the byte ceilings in the technical specification (§0.9.3,
 * "Performance and Scalability Expectations") into an enforced CI gate. It
 * measures the JavaScript, CSS and font bytes a production `next build` emits
 * and exits non-zero when a ceiling is breached. CI invokes it as:
 *
 *     node scripts/check-budget.mjs        (npm run check:budget)
 *
 * ## THE SCOPE BOUNDARY — READ THIS BEFORE EXTENDING THE FILE
 *
 * §0.9.3 divides budget enforcement three ways because no single tool can
 * observe everything, and its reasoning is worth restating verbatim: "a
 * directory of build output contains no transferred sizes, no request list, no
 * optimizer responses and no origins — those exist only when a server answers a
 * real request."
 *
 * THIS SCRIPT OBSERVES THE BUILD OUTPUT ONLY — the emitted asset files under
 * `.next`, their compressed sizes, and the `next/font` output. IT MAKES NO
 * CLAIM ABOUT WHAT A BROWSER TRANSFERS. A compressed size computed here is what
 * the file compresses to, not what any client actually pulled.
 *
 * The following are therefore NOT this script's job. Each is owned elsewhere,
 * and duplicating one here would create two sources of truth that drift:
 *
 *   - Lighthouse Performance / Accessibility / Best Practices / SEO scores
 *     → `lighthouserc.json` via `@lhci/cli`, in the CI `lighthouse` job.
 *   - Largest Contentful Paint, Cumulative Layout Shift, Total Blocking Time
 *     → the same Lighthouse run.
 *   - Transferred bytes and their first-party / third-party split
 *     → Playwright, from the network log of a real navigation, in that job.
 *   - Request count, per-image response sizes, `srcset` presence
 *     → the same Playwright run.
 *   - Distinct origins checked against the Content Security Policy allowlist
 *     → the same Playwright run.
 *
 * `lighthouserc.json` states the same division from the other side. If you find
 * yourself wanting to assert a score, a transferred byte, a request count or an
 * origin here, that is the signal you have crossed this boundary.
 *
 * Consequently this script STARTS NO SERVER. It does not run `next start`, bind
 * a port, open a socket, call `fetch`, or read a Lighthouse report. It reads
 * files and exits. §0.9.3: "`check-budget.mjs` needs no server and starts
 * none."
 *
 * ## THE ONE NON-NEGOTIABLE
 *
 * THIS SCRIPT MAY NOT WEAKEN A THRESHOLD TO MAKE A RUN GREEN. It reports the
 * measured value instead. That rule forbids, and this file deliberately
 * contains none of:
 *
 *   - any environment variable, flag, config file or allowlist that can raise a
 *     ceiling or suppress a violation;
 *   - any "warn instead of fail" mode for a genuine ceiling breach;
 *   - rounding, truncating or floor-dividing a measured value in a way that
 *     flatters it;
 *   - excluding a category of emitted bytes in order to get under a ceiling.
 *
 * If a real build breaches a ceiling the correct outcome is a red job and a
 * report naming the offending files. The fix belongs in the application — a
 * smaller dependency, a dynamic import, a narrower font subset — never here.
 *
 * Two consequences of that rule are visible in the code below and are easy to
 * mistake for oversights. The `polyfills` chunk is counted in the JavaScript
 * total even though it is served only to legacy browsers, because a budget that
 * omits conditionally-served bytes understates the worst case. And a font file
 * that cannot be attributed to a declared `@font-face` still counts toward the
 * font total.
 *
 * ## NO ENVIRONMENT IS READ
 *
 * This script reads no environment variable at all. `scripts/**` is exempt from
 * the project's single-`process.env`-reader rule — `eslint.config.mjs` lists it
 * in the `ces/environment-readers` block precisely because standalone scripts
 * run outside the application module graph — so a read here would be permitted.
 * It is nonetheless avoided, because reading nothing is what makes "incapable
 * of relaxing a threshold" a property of the code rather than a promise about
 * it. Every input arrives as a command-line flag, and no flag can move a
 * ceiling: `--dir` relocates what is measured, never what it is measured
 * against.
 *
 * ## AUTHORITY FOR EVERY THRESHOLD
 *
 * The three aggregate ceilings are quoted from §0.9.3 and are immovable. The
 * sub-ceilings are this script's own, derived from those aggregates, and each
 * carries its derivation at its declaration. No user-specified rules were
 * provided for this project — `review_rules` returns none, and §0.8 states the
 * same — so nothing here originates from a project rule document, and the
 * absence of such rules is not treated as licence to lower the bar. §0.9.3 is
 * the governing standard.
 *
 * ## FILE CONVENTIONS
 *
 * The `.mjs` extension is load-bearing. `package.json` does not set
 * `"type": "module"`, so the extension — not a package field — is what makes
 * `import` and top-level `await` correct here. Do not rename this file to
 * `.js`. There is no shebang because the file is not marked executable; it is
 * always invoked as an argument to `node`, and a shebang on a non-executable
 * file only misleads.
 *
 * Indentation is two spaces, per `.editorconfig`'s `[*]` block, which applies
 * to `.mjs` through the wildcard. Formatting is owned by Prettier.
 *
 * This file is deliberately outside the TypeScript project: `tsconfig.json`
 * includes only the recursive TypeScript globs — `.ts` and `.tsx` — so `.mjs`
 * is not seen by `tsc --noEmit` and the CI `lint-types` job does not
 * typecheck it. (Those glob patterns are described rather than written out
 * because a `**` followed by a `*` embeds a comment terminator and would end
 * this block early — a real bug caught while authoring this file.) Do not add
 * a declaration file and do not convert it to TypeScript — it must stay
 * runnable by `node` with no build step and no dependency resolution, which is
 * what lets the CI `budget` job run it against a downloaded artifact.
 *
 * Only `node:` builtins are imported. This script has no npm dependency and
 * must never acquire one: the eighteen development dependencies contain no
 * size, bundle-analysis or compression tool, which is positive evidence that it
 * is expected to stand alone.
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Ceilings
//
// Every threshold in this script is declared here as a named constant with its
// authority or its derivation. Nothing below compares against a bare number.
// ---------------------------------------------------------------------------

/**
 * JavaScript, Brotli-compressed, summed over every client chunk.
 *
 * Authority: AAP §0.9.3 — "JavaScript … ≤ 180,000 compressed". Immovable.
 *
 * Legacy baseline for scale: 1,496,522 bytes of unmanaged vendored script.
 */
const JS_BROTLI_CEILING_BYTES = 180_000;

/**
 * CSS, Brotli-compressed, summed over every emitted stylesheet.
 *
 * Authority: AAP §0.9.3 — "CSS … ≤ 40,000 compressed". Immovable.
 *
 * Legacy baseline for scale: 543,998 bytes across six stylesheets, of which
 * 461,257 bytes were unused.
 */
const CSS_BROTLI_CEILING_BYTES = 40_000;

/**
 * Fonts, RAW bytes, summed over every emitted font file.
 *
 * Authority: AAP §0.9.3 — "Fonts … ≤ 120,000 (2 families, woff2, latin
 * subset)". Immovable.
 *
 * Note the asymmetry against the two ceilings above, which is deliberate rather
 * than an omission in the specification: they carry the qualifier "compressed"
 * and this one does not. woff2 is already Brotli-compressed internally, so
 * re-compressing it gains essentially nothing and would misstate the figure
 * against a ceiling that never asked for it. Fonts are measured raw.
 */
const FONT_RAW_CEILING_BYTES = 120_000;

/**
 * The largest any single JavaScript chunk may be, Brotli-compressed.
 *
 * Derivation: 50% of `JS_BROTLI_CEILING_BYTES`. The framework and shared
 * runtime chunk is the largest single item in an App Router build, and no one
 * chunk may consume the whole budget and leave nothing for the routes.
 *
 * This is this script's own sub-ceiling rather than a figure quoted from
 * §0.9.3, which names "per-chunk and per-family ceilings" without setting them.
 * It may be TIGHTENED if real measurements allow. It may never be LOOSENED to
 * make a run green.
 */
const JS_CHUNK_BROTLI_CEILING_BYTES = 90_000;

/**
 * Per-family font ceilings, RAW bytes, keyed by canonical family name.
 *
 * Derivation: a 2:1 split of `FONT_RAW_CEILING_BYTES`, following the weights
 * §0.3.3 specifies — Nunito ships two (400 and 700) and Space Mono ships one
 * (400, used for the `--text-meta` role). Two thirds of the budget to the
 * family carrying twice the faces.
 *
 * Same standing as the chunk sub-ceiling above: may be tightened, never
 * loosened. The two values sum to exactly the aggregate, so the aggregate can
 * only be reached if both families are simultaneously at their limit.
 */
const FONT_FAMILY_RAW_CEILING_BYTES = new Map([
  ["nunito", 80_000],
  ["space mono", 40_000],
]);

/**
 * The font families this build is permitted to ship, canonical and lowercased.
 *
 * §0.3.3 retains Nunito as the site's voice and Space Mono for the `.meta`
 * role, and self-hosts both through `next/font`. Any third family is precisely
 * the regression that section retires: a nine-weight Google Fonts `Inter`
 * request "referenced by no rule", and a paid Monotype Avenir kit that "fails
 * to load on every route". A third family appearing here means one of them, or
 * something like it, has come back.
 */
const EXPECTED_FONT_FAMILIES = new Set(FONT_FAMILY_RAW_CEILING_BYTES.keys());

/**
 * The maximum number of distinct families that may ship font bytes.
 *
 * Authority: AAP §0.9.3's parenthetical "(2 families, woff2, latin subset)".
 * Held separately from `EXPECTED_FONT_FAMILIES` so the count is asserted even
 * if the expected set is ever widened.
 */
const MAX_FONT_FAMILIES = 2;

/**
 * The only font container format this build may emit.
 *
 * Authority: the same parenthetical. The legacy site is the cautionary case:
 * `public/webfonts` held 15 files totalling 2,929,598 bytes — three Font
 * Awesome families in five formats each (`.eot`, `.svg`, `.ttf`, `.woff`,
 * `.woff2`) — for an icon set the target replaces with `lucide-react`. Any
 * format other than woff2 here means the font pipeline is misconfigured.
 */
const REQUIRED_FONT_EXTENSION = ".woff2";

/**
 * Extensions treated as font files. Deliberately wider than
 * `REQUIRED_FONT_EXTENSION`: a format that must not be emitted still has to be
 * DETECTED in order to be reported, so the collector recognises all of them and
 * the assertion rejects the ones that are not woff2.
 */
const FONT_EXTENSIONS = new Set([".woff2", ".woff", ".ttf", ".otf", ".eot"]);

// ---------------------------------------------------------------------------
// Compression parameters
//
// Fixed constants, not options. Nothing in the CLI surface can reach them,
// because changing the compression of a measurement changes the measurement.
// ---------------------------------------------------------------------------

/**
 * Brotli quality, pinned at the maximum.
 *
 * Set explicitly rather than left to the default for two reasons. It documents
 * the measurement — the numbers this script prints are reproducible by anyone
 * running `brotli -q 11` over the same file — and it removes any dependence on
 * a library default that could change under a Node upgrade and silently move
 * every reported figure.
 *
 * Maximum quality is also the honest choice for what is being modelled. Next
 * emits immutable, content-hashed static assets, which a CDN compresses once at
 * high quality and serves from cache thereafter; a lower quality here would
 * model a compression pass that never happens for these files.
 */
const BROTLI_QUALITY = zlib.constants.BROTLI_MAX_QUALITY;

/**
 * Gzip level for the diagnostic column only. No ceiling is asserted against
 * gzip — §0.9.3 states one compressed ceiling per group, and asserting two
 * algorithms would mean two definitions of the same budget. Gzip is printed
 * because a reader debugging a breach benefits from seeing both.
 */
const GZIP_LEVEL = zlib.constants.Z_BEST_COMPRESSION;

// ---------------------------------------------------------------------------
// Formatting
//
// Declared before the legacy baselines below, which call `formatBytes` at
// module-evaluation time. A `const` is not hoisted the way a function
// declaration is, so the formatter has to be initialised first.
// ---------------------------------------------------------------------------

/**
 * The locale is pinned rather than left to the host so the report does not
 * change shape on a runner configured for a different one. A grouped figure is
 * for human legibility only; the exact integer is always what is compared, and
 * `--json` carries unformatted numbers throughout.
 */
const BYTE_FORMATTER = new Intl.NumberFormat("en-US");

function formatBytes(value) {
  return BYTE_FORMATTER.format(value);
}

/**
 * Pads a cell to a fixed width for the fixed-column report. Over-long values
 * are never truncated — a truncated byte count is a misreported byte count — so
 * a wide value simply widens its row.
 */
function padEnd(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text, width) {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

// ---------------------------------------------------------------------------
// Legacy baselines, printed as context
//
// Verified byte counts of the source repository, recovered from the tracked
// tree at the commit preceding its retirement. They are stated as fact because
// each was measured, and they exist in the report so a reviewer can see the
// scale of the change rather than an unanchored "pass".
// ---------------------------------------------------------------------------

const LEGACY_BASELINES = [
  {
    group: "JavaScript",
    detail:
      "1,496,522 bytes of vendored script across 9 files under public/js, " +
      "of which all.js alone is 1,262,826 (Font Awesome).",
    target: `${formatBytes(JS_BROTLI_CEILING_BYTES)} bytes Brotli.`,
  },
  {
    group: "CSS",
    detail:
      "543,998 bytes across six stylesheets under public/css (excluding the " +
      "5,242-byte ces.css.map), of which 461,257 bytes were unused and " +
      "all.css was 100% unused at 73,577 of 73,577 bytes.",
    target: `${formatBytes(CSS_BROTLI_CEILING_BYTES)} bytes Brotli.`,
  },
  {
    group: "Fonts",
    detail:
      "15 Font Awesome webfont files totalling 2,929,598 bytes on disk under " +
      "public/webfonts. Separately, a runtime Chrome measurement (§0.7.2) " +
      "found only 4 of 95 registered font faces actually loaded — that is a " +
      "runtime figure, not a file count, and cannot be reproduced with grep.",
    target: `${formatBytes(FONT_RAW_CEILING_BYTES)} bytes raw, two families.`,
  },
];

/**
 * Renders a path for the report: relative to the `nextjs/` project root and
 * POSIX-separated, so output is identical on any platform and carries no
 * absolute path that would differ between a developer's machine and CI.
 *
 * For the default build directory this yields exactly `.next/static/...`. For a
 * directory outside the project root — a test fixture, say — the result is a
 * `../`-prefixed relative path, which is still relative, still free of machine
 * specifics, and still identical across runs with the same input.
 */
function toReportPath(absolutePath) {
  const relative = path.relative(PROJECT_ROOT, absolutePath);
  return relative.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Compressed size under Brotli, at the pinned quality.
 *
 * `BROTLI_PARAM_SIZE_HINT` is supplied because Brotli uses it to size its
 * internal window: without it the encoder makes a different decision for the
 * same input depending on how it was handed the data, and the byte count can
 * differ run to run. With both parameters fixed the figure is stable, which is
 * what makes a budget diff meaningful rather than noise.
 */
function brotliSize(contents) {
  return zlib.brotliCompressSync(contents, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length,
    },
  }).length;
}

/** Compressed size under gzip. Diagnostic only — no ceiling asserts on it. */
function gzipSize(contents) {
  return zlib.gzipSync(contents, { level: GZIP_LEVEL }).length;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Recursively lists every regular file beneath `directory`.
 *
 * Symbolic links are resolved with `stat` so a linked file is measured rather
 * than skipped, and a link to a directory is descended. `readdir` failures
 * propagate: an unreadable build directory is a reason to fail loudly, never to
 * report a smaller total.
 */
async function listFiles(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });

  // Sorted at every level so the traversal order — and therefore every array
  // in the report — is deterministic regardless of filesystem ordering.
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      const linked = await stat(absolute);
      isDirectory = linked.isDirectory();
      isFile = linked.isFile();
    }

    if (isDirectory) {
      found.push(...(await listFiles(absolute)));
    } else if (isFile) {
      found.push(absolute);
    }
  }

  return found;
}

/**
 * Classifies one emitted file into a budget group.
 *
 * Source maps are recognised so they can be reported as an anomaly, and are
 * deliberately not counted as JavaScript. `next.config.ts` does not set
 * `productionBrowserSourceMaps`, so the framework default of `false` applies
 * and no browser source map should exist at all; one appearing means that
 * configuration changed. Excluding them also matches how the legacy CSS
 * baseline was counted — 543,998 bytes over six stylesheets, with the
 * 5,242-byte `ces.css.map` left out.
 */
function classify(absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === ".map") {
    return "sourcemap";
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "javascript";
  }
  if (extension === ".css") {
    return "css";
  }
  if (FONT_EXTENSIONS.has(extension)) {
    return "font";
  }

  return "other";
}

/**
 * True for the legacy-browser polyfill bundle.
 *
 * It is INCLUDED in the JavaScript total. Excluding it is tempting — modern
 * browsers never request it — but a budget that omits conditionally-served
 * bytes understates the worst case, and the no-weakening rule resolves that tie
 * toward the conservative reading. It is reported on its own line so the report
 * stays honest about why the total is what it is.
 */
function isPolyfill(absolutePath) {
  return path.basename(absolutePath).startsWith("polyfills");
}

// ---------------------------------------------------------------------------
// Font family attribution
//
// A font file's family is not recoverable from its name. `next/font` emits
// content-hashed filenames such as `a1b2c3d4-s.p.woff2`, and the only place the
// association exists is the generated stylesheet:
//
//     @font-face {
//       font-family: '__Nunito_e66fe9';
//       font-style: normal;
//       font-weight: 400;
//       src: url(/_next/static/media/a1b2c3d4-s.p.woff2) format('woff2');
//     }
//
// So attribution means parsing the emitted CSS. Two properties of that output
// would each produce a permanently-red gate on a perfectly correct build if
// they were not handled here, and both are handled below:
//
//   1. THE FAMILY NAME IS MANGLED. It is not `Nunito`, it is
//      `__Nunito_e66fe9` — namespaced with a leading `__` and suffixed with a
//      hash of the loader options. A literal comparison against `Nunito` would
//      never match. `canonicalFontFamily` undoes exactly that transformation.
//
//   2. THERE ARE MORE DECLARED FAMILIES THAN SHIPPED ONES. `next/font` emits a
//      metric-override fallback alongside each real family —
//      `'__Nunito_Fallback_e66fe9'`, with `src: local("Arial")` and the
//      `ascent-override` group — which ships no file at all. Counting DECLARED
//      families would see four where two are shipped, and fail. The family set
//      is therefore built from ATTRIBUTION: a family counts only if it owns at
//      least one emitted font file. That is not a weakening — a genuine third
//      family such as `Inter` ships woff2 files and is still caught — it only
//      excludes declarations that carry zero bytes, which is the right
//      behaviour for a ceiling denominated in bytes.
// ---------------------------------------------------------------------------

/**
 * Removes CSS block comments before any structural parsing.
 *
 * Two reasons, not one: a commented-out `@font-face` must not be mistaken for a
 * live declaration, and a brace inside a comment would desynchronise the
 * brace-matching below. Each comment becomes a single space so the tokens on
 * either side of it cannot fuse into one.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Returns the body of every `@font-face` block in a stylesheet.
 *
 * Brace-matched rather than regex-terminated, so a nested block cannot truncate
 * a declaration early. Written to tolerate the two shapes that actually occur:
 * the pretty-printed form above, and the minified single-line form Next emits
 * in production, where there is no whitespace and no quoting at all
 * (`@font-face{font-family:__Nunito_e66fe9;src:url(/x.woff2) format('woff2')}`).
 */
function extractFontFaceBlocks(css) {
  const blocks = [];
  const atRule = /@font-face\s*/gi;
  let match;

  while ((match = atRule.exec(css)) !== null) {
    const open = css.indexOf("{", match.index);
    if (open === -1) {
      break;
    }

    let depth = 0;
    let close = -1;

    for (let index = open; index < css.length; index += 1) {
      const character = css[index];
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }

    if (close === -1) {
      // An unterminated block means the stylesheet is truncated. Stop rather
      // than guess; the missing attribution surfaces as an unattributed font,
      // which fails.
      break;
    }

    blocks.push(css.slice(open + 1, close));
    atRule.lastIndex = close;
  }

  return blocks;
}

/**
 * Normalises a declared `font-family` value to a comparable canonical form.
 *
 * Returns the value as declared alongside the canonical form, because a failure
 * message needs both: if a family is reported as unexpected, the reader has to
 * be able to tell a genuine third font from a naming shape this function did
 * not anticipate.
 *
 * The de-mangling is applied ONLY to names beginning with `__`, which is
 * `next/font`'s own namespace. An authored family name never enters that
 * branch, so the heuristic cannot corrupt one. Within the branch, a trailing
 * segment is dropped only when it looks like the loader's hash — four or more
 * lowercase hex characters — which no word in either expected family name can
 * satisfy (`mono` and `nunito` both contain non-hex letters).
 */
function canonicalFontFamily(rawValue) {
  let name = rawValue.trim();

  // `@font-face` takes a single family, but tolerate a list and use the first.
  const comma = name.indexOf(",");
  if (comma !== -1) {
    name = name.slice(0, comma);
  }
  name = name.trim();

  const quoted =
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"));
  if (quoted && name.length >= 2) {
    name = name.slice(1, -1);
  }

  const declared = name.trim();
  name = declared;

  if (name.startsWith("__")) {
    const segments = name
      .slice(2)
      .split("_")
      .filter((segment) => segment.length > 0);

    if (segments.length > 1) {
      const last = segments[segments.length - 1];
      if (/^[0-9a-f]{4,}$/.test(last)) {
        segments.pop();
      }
    }

    name = segments.join(" ");
  }

  const display = name.replace(/\s+/g, " ").trim();

  return { declared, display, canonical: display.toLowerCase() };
}

/**
 * Extracts every `url(...)` target from a declaration block.
 *
 * Scans the whole block rather than only the `src` property, which covers
 * several `src` declarations and several comma-separated entries within one
 * without special-casing either. `local("Arial")` is not a `url()` and so
 * yields nothing, which is exactly how a metric-override fallback block comes
 * to own no files.
 */
function extractBlockUrls(block) {
  const urls = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
  let match;

  while ((match = pattern.exec(block)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value.length > 0) {
      urls.push(value);
    }
  }

  return urls;
}

/**
 * Reduces a stylesheet URL to the on-disk basename it refers to.
 *
 * Query strings and fragments are stripped because a cache-busting suffix is
 * not part of the filename. A `data:` URI carries no file and is discarded: it
 * ships its bytes inside the stylesheet, where they are already counted against
 * the CSS ceiling, so treating it as a font file would double-count it.
 */
function urlToBasename(value) {
  if (/^data:/i.test(value)) {
    return undefined;
  }

  const withoutFragment = value.split("#")[0].split("?")[0];
  const basename = withoutFragment.split("/").pop();

  return basename !== undefined && basename.length > 0 ? basename : undefined;
}

/**
 * Builds the attribution map from every emitted stylesheet.
 *
 * Produces the basename-to-family map used to attribute font files, the set of
 * families that actually own files, the set of families declared but shipping
 * nothing (informational), and any basename claimed by two different families
 * (ambiguous, and therefore a failure — an attribution that cannot be trusted
 * cannot support the family assertions).
 */
function buildFontAttribution(stylesheets) {
  const familyByBasename = new Map();
  const declaredFamilies = new Map();
  const conflicts = [];

  for (const sheet of stylesheets) {
    const css = stripCssComments(sheet.contents);

    for (const block of extractFontFaceBlocks(css)) {
      const familyMatch = /font-family\s*:\s*([^;]+)/i.exec(block);
      if (familyMatch === null) {
        continue;
      }

      const family = canonicalFontFamily(familyMatch[1]);
      if (family.canonical.length === 0) {
        continue;
      }

      if (!declaredFamilies.has(family.canonical)) {
        declaredFamilies.set(family.canonical, {
          display: family.display,
          declaredAs: new Set(),
          fileCount: 0,
        });
      }
      const record = declaredFamilies.get(family.canonical);
      record.declaredAs.add(family.declared);

      for (const url of extractBlockUrls(block)) {
        const basename = urlToBasename(url);
        if (basename === undefined) {
          continue;
        }
        if (!FONT_EXTENSIONS.has(path.extname(basename).toLowerCase())) {
          continue;
        }

        const existing = familyByBasename.get(basename);
        if (existing !== undefined && existing !== family.canonical) {
          conflicts.push({
            file: basename,
            families: [existing, family.canonical].sort(),
          });
          continue;
        }

        familyByBasename.set(basename, family.canonical);
        record.fileCount += 1;
      }
    }
  }

  return { familyByBasename, declaredFamilies, conflicts };
}

// ---------------------------------------------------------------------------
// Paths and command line
// ---------------------------------------------------------------------------

/**
 * The `nextjs/` project root, derived from this file's own location rather than
 * from `process.cwd()`.
 *
 * Self-location is what makes the script robust to how it is invoked. The npm
 * script and the CI job both happen to run with the working directory set to
 * `nextjs/`, but `actions/download-artifact` places the `next-build` artifact
 * at whatever path the workflow chooses, and a developer may well run the file
 * by absolute path from somewhere else entirely. `cwd` is an accident of
 * invocation; `import.meta.url` is not.
 */
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The build directory a production `next build` writes. */
const DEFAULT_BUILD_DIRECTORY = path.join(PROJECT_ROOT, ".next");

const USAGE = `Usage: node scripts/check-budget.mjs [options]

Enforces the static build-output byte budgets from the technical specification
(§0.9.3) against an emitted Next.js build. Measures JavaScript and CSS
Brotli-compressed and fonts raw, then exits non-zero if any ceiling is breached.

Options:
  --dir <path>    Build directory to measure. Default: .next relative to the
                  nextjs/ project root. Relocates WHAT is measured; it cannot
                  change what it is measured against.
  --json <path>   Additionally write a deterministic JSON report to <path>.
  --help          Print this message and exit 0.

Ceilings (§0.9.3, immovable):
  JavaScript   ${padStart(formatBytes(JS_BROTLI_CEILING_BYTES), 9)} bytes  Brotli, all client chunks
  CSS          ${padStart(formatBytes(CSS_BROTLI_CEILING_BYTES), 9)} bytes  Brotli, all stylesheets
  Fonts        ${padStart(formatBytes(FONT_RAW_CEILING_BYTES), 9)} bytes  raw, 2 families, woff2 only

Sub-ceilings (derived; may be tightened, never loosened):
  Per JS chunk ${padStart(formatBytes(JS_CHUNK_BROTLI_CEILING_BYTES), 9)} bytes  Brotli
  Nunito       ${padStart(formatBytes(FONT_FAMILY_RAW_CEILING_BYTES.get("nunito")), 9)} bytes  raw
  Space Mono   ${padStart(formatBytes(FONT_FAMILY_RAW_CEILING_BYTES.get("space mono")), 9)} bytes  raw

This script observes build output only. Lighthouse scores, Core Web Vitals,
transferred bytes, request counts and distinct origins are asserted elsewhere,
from a real navigation. It starts no server.

Exit codes:
  0  every ceiling, sub-ceiling and structural assertion passed
  1  a breach, a failed structural assertion, or an unmeasurable build
`;

/**
 * Parses the command line.
 *
 * `strict` is left at its default of true so an unrecognised flag is an error
 * rather than being ignored. That matters here more than it usually would: a
 * mistyped `--dir` that were silently dropped would send the script at the
 * default directory and could report a pass for a build nobody measured.
 */
function parseCommandLine(argv) {
  return parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  }).values;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Reads and measures every file in the build directory's `static` tree.
 *
 * Only `static` is walked. `<dir>/server/**` is excluded ENTIRELY and
 * deliberately: server bundles are never sent to a browser, they are far larger
 * than any client budget, and counting them would produce a permanently red
 * gate that measured the wrong thing.
 */
async function measureBuild(buildDirectory) {
  const staticDirectory = path.join(buildDirectory, "static");

  const javascript = [];
  const stylesheets = [];
  const fonts = [];
  const sourcemaps = [];

  for (const absolute of await listFiles(staticDirectory)) {
    const group = classify(absolute);

    if (group === "other") {
      continue;
    }

    if (group === "sourcemap") {
      sourcemaps.push({ path: toReportPath(absolute) });
      continue;
    }

    const contents = await readFile(absolute);
    const raw = contents.length;

    if (group === "font") {
      // Raw only. woff2 is Brotli-compressed internally, and the ceiling
      // carries no "compressed" qualifier.
      fonts.push({
        path: toReportPath(absolute),
        basename: path.basename(absolute),
        extension: path.extname(absolute).toLowerCase(),
        raw,
      });
      continue;
    }

    const measured = {
      path: toReportPath(absolute),
      raw,
      gzip: gzipSize(contents),
      brotli: brotliSize(contents),
    };

    if (group === "javascript") {
      javascript.push({ ...measured, polyfill: isPolyfill(absolute) });
    } else {
      stylesheets.push({ ...measured, contents: contents.toString("utf8") });
    }
  }

  return { javascript, stylesheets, fonts, sourcemaps };
}

/** Sums one numeric field across a list of measured files. */
function sumBy(items, field) {
  return items.reduce((total, item) => total + item[field], 0);
}

/** Descending by a numeric field, then by path, so ordering is total. */
function byMeasureDescending(field) {
  return (left, right) =>
    right[field] - left[field] || (left.path < right.path ? -1 : 1);
}

/**
 * Groups measured font files by attributed family and totals each.
 *
 * A file whose basename appears in no `@font-face` block is collected as
 * unattributed. It is still counted toward the aggregate font total — the
 * conservative reading the no-weakening rule requires — and it additionally
 * fails, because attribution is the mechanism by which the "2 families"
 * assertion is verified: a file that cannot be attributed is a file for which
 * that assertion cannot be made, and a gate that cannot verify its own
 * assertion must fail rather than pass. The same principle as the
 * anti-vacuous-pass checks.
 */
function groupFontsByFamily(fonts, familyByBasename) {
  const families = new Map();
  const unattributed = [];

  for (const font of fonts) {
    const canonical = familyByBasename.get(font.basename);

    if (canonical === undefined) {
      unattributed.push(font);
      continue;
    }

    if (!families.has(canonical)) {
      families.set(canonical, { canonical, files: [], raw: 0 });
    }
    const family = families.get(canonical);
    family.files.push(font);
    family.raw += font.raw;
  }

  for (const family of families.values()) {
    family.files.sort(byMeasureDescending("raw"));
  }

  return { families, unattributed };
}

// ---------------------------------------------------------------------------
// Assertions
//
// Two kinds of finding, both fatal and both exiting 1, but reported distinctly
// because they call for different fixes. A BREACH means the application shipped
// too many bytes: the fix is in the application. A STRUCTURAL failure means the
// measurement itself could not be trusted — a missing group, an unrecognised
// font format, an unattributable file: the fix is the build configuration, or
// this script's understanding of it.
//
// There is no third, non-fatal kind for either. Anomalies (below) are a
// separate list and are informational by design, never a downgraded breach.
// ---------------------------------------------------------------------------

function evaluate(measurement) {
  const { javascript, stylesheets, fonts, sourcemaps } = measurement;
  const attribution = buildFontAttribution(stylesheets);

  const failures = [];
  const anomalies = [];
  const notes = [];

  const breach = (code, message) =>
    failures.push({ kind: "breach", code, message });
  const structural = (code, message) =>
    failures.push({ kind: "structural", code, message });

  // -- Anti-vacuous-pass ----------------------------------------------------
  //
  // A budget that passes because it found nothing is worse than no budget at
  // all, and it is the single most likely way this gate stops working without
  // anyone noticing. Each of the three groups MUST be present in a correct
  // build: `app/layout.tsx` imports `app/globals.css` so CSS is emitted, two
  // `next/font` families are self-hosted so woff2 is emitted, and any App
  // Router build emits client chunks. A zero count means the artifact is wrong,
  // not that the budget passed.

  if (javascript.length === 0) {
    structural(
      "no-javascript",
      "No JavaScript chunks found. Every App Router build emits client " +
        "chunks, so an empty result means the measured directory is not a " +
        "complete build artifact — not that the JavaScript budget passed.",
    );
  }

  if (stylesheets.length === 0) {
    structural(
      "no-css",
      "No CSS found. app/layout.tsx imports app/globals.css, so a correct " +
        "build always emits at least one stylesheet. An empty result means " +
        "the measured directory is not a complete build artifact — not that " +
        "the CSS budget passed.",
    );
  }

  if (fonts.length === 0) {
    structural(
      "no-fonts",
      "No font files found. Two families are self-hosted through next/font " +
        "(§0.3.3), so a correct build always emits woff2. An empty result " +
        "means either the measured directory is incomplete or font " +
        "self-hosting regressed to a remote stylesheet — the exact defect the " +
        "migration removed. It does not mean the font budget passed.",
    );
  }

  // -- JavaScript -----------------------------------------------------------

  javascript.sort(byMeasureDescending("brotli"));

  const jsBrotli = sumBy(javascript, "brotli");
  const polyfills = javascript.filter((file) => file.polyfill);

  if (jsBrotli > JS_BROTLI_CEILING_BYTES) {
    breach(
      "javascript-total",
      `JavaScript is ${formatBytes(jsBrotli)} bytes Brotli against a ceiling ` +
        `of ${formatBytes(JS_BROTLI_CEILING_BYTES)} — over by ` +
        `${formatBytes(jsBrotli - JS_BROTLI_CEILING_BYTES)} bytes.`,
    );
  }

  const oversizedChunks = javascript.filter(
    (file) => file.brotli > JS_CHUNK_BROTLI_CEILING_BYTES,
  );

  for (const chunk of oversizedChunks) {
    breach(
      "javascript-chunk",
      `Chunk ${chunk.path} is ${formatBytes(chunk.brotli)} bytes Brotli ` +
        `against a per-chunk ceiling of ` +
        `${formatBytes(JS_CHUNK_BROTLI_CEILING_BYTES)} — over by ` +
        `${formatBytes(chunk.brotli - JS_CHUNK_BROTLI_CEILING_BYTES)} bytes. ` +
        `No single chunk may consume half the JavaScript budget.`,
    );
  }

  if (polyfills.length > 0) {
    notes.push(
      `${polyfills.length} polyfill bundle(s) totalling ` +
        `${formatBytes(sumBy(polyfills, "brotli"))} bytes Brotli are INCLUDED ` +
        `in the JavaScript total. They are served only to legacy browsers, ` +
        `but a budget that omits conditionally-served bytes understates the ` +
        `worst case.`,
    );
  }

  // -- CSS ------------------------------------------------------------------
  //
  // Aggregate only. No per-stylesheet sub-ceiling is invented here: §0.9.3
  // names "per-chunk and per-family ceilings", where a chunk is a JavaScript
  // concept and a family a font one. A per-file CSS ceiling would be a
  // constraint the specification does not state.

  stylesheets.sort(byMeasureDescending("brotli"));

  const cssBrotli = sumBy(stylesheets, "brotli");

  if (cssBrotli > CSS_BROTLI_CEILING_BYTES) {
    breach(
      "css-total",
      `CSS is ${formatBytes(cssBrotli)} bytes Brotli against a ceiling of ` +
        `${formatBytes(CSS_BROTLI_CEILING_BYTES)} — over by ` +
        `${formatBytes(cssBrotli - CSS_BROTLI_CEILING_BYTES)} bytes.`,
    );
  }

  // -- Fonts ----------------------------------------------------------------

  fonts.sort(byMeasureDescending("raw"));

  const fontRaw = sumBy(fonts, "raw");
  const { families, unattributed } = groupFontsByFamily(
    fonts,
    attribution.familyByBasename,
  );

  if (fontRaw > FONT_RAW_CEILING_BYTES) {
    breach(
      "fonts-total",
      `Fonts are ${formatBytes(fontRaw)} bytes raw against a ceiling of ` +
        `${formatBytes(FONT_RAW_CEILING_BYTES)} — over by ` +
        `${formatBytes(fontRaw - FONT_RAW_CEILING_BYTES)} bytes.`,
    );
  }

  const wrongFormat = fonts.filter(
    (font) => font.extension !== REQUIRED_FONT_EXTENSION,
  );

  if (wrongFormat.length > 0) {
    const formats = [...new Set(wrongFormat.map((font) => font.extension))]
      .sort()
      .join(", ");
    structural(
      "font-format",
      `${wrongFormat.length} font file(s) are not ${REQUIRED_FONT_EXTENSION} ` +
        `(found: ${formats}). §0.9.3 specifies woff2; any other format means ` +
        `the font pipeline is misconfigured. The legacy site shipped five ` +
        `formats of every icon family — 2,929,598 bytes — which is the case ` +
        `this assertion exists to prevent recurring. Offending files: ` +
        `${wrongFormat.map((font) => font.path).join(", ")}.`,
    );
  }

  for (const conflict of attribution.conflicts) {
    structural(
      "font-attribution-conflict",
      `Font file ${conflict.file} is claimed by two @font-face families ` +
        `(${conflict.families.join(" and ")}), so its family cannot be ` +
        `determined and the per-family ceilings cannot be applied to it.`,
    );
  }

  if (unattributed.length > 0) {
    structural(
      "font-unattributed",
      `${unattributed.length} font file(s) totalling ` +
        `${formatBytes(sumBy(unattributed, "raw"))} bytes could not be ` +
        `attributed to any @font-face declaration in the emitted CSS. They ` +
        `ARE counted in the font total above, but their family is unknown, so ` +
        `the "2 families" assertion cannot be made for them. Either a ` +
        `stylesheet was not emitted where this script looks (under ` +
        `<dir>/static), or a non-font asset landed among the fonts. ` +
        `Unattributed files: ` +
        `${unattributed.map((font) => font.path).join(", ")}.`,
    );
  }

  const shipped = [...families.keys()].sort();

  if (shipped.length > MAX_FONT_FAMILIES) {
    structural(
      "font-family-count",
      `${shipped.length} font families ship bytes, against a maximum of ` +
        `${MAX_FONT_FAMILIES} (§0.9.3). Families found: ` +
        `${shipped.join(", ")}.`,
    );
  }

  for (const canonical of shipped) {
    if (EXPECTED_FONT_FAMILIES.has(canonical)) {
      continue;
    }

    const declared = attribution.declaredFamilies.get(canonical);
    const declaredAs =
      declared === undefined
        ? "unknown"
        : [...declared.declaredAs].sort().join(", ");

    structural(
      "font-family-unexpected",
      `Unexpected font family "${canonical}" ships ` +
        `${formatBytes(families.get(canonical).raw)} bytes. Only ` +
        `${[...EXPECTED_FONT_FAMILIES].sort().join(" and ")} are permitted ` +
        `(§0.3.3). Declared in the emitted CSS as: ${declaredAs}. If that ` +
        `declared name is a next/font mangled name that should have reduced ` +
        `to a permitted family, the fault is this script's canonicalisation ` +
        `and not the build; otherwise a third family has been reintroduced — ` +
        `the Inter or Monotype regression §0.3.3 retires.`,
    );
  }

  for (const [canonical, family] of families) {
    const ceiling = FONT_FAMILY_RAW_CEILING_BYTES.get(canonical);
    if (ceiling === undefined) {
      // Already reported as an unexpected family; there is no ceiling to
      // apply, and inventing one would understate the problem.
      continue;
    }

    if (family.raw > ceiling) {
      breach(
        "font-family-total",
        `Font family "${canonical}" is ${formatBytes(family.raw)} bytes raw ` +
          `against a per-family ceiling of ${formatBytes(ceiling)} — over by ` +
          `${formatBytes(family.raw - ceiling)} bytes.`,
      );
    }
  }

  // Declared families that ship nothing are informational, not failures.
  // `next/font` emits a metric-override fallback per real family, with
  // `src: local(...)` and no file, and that is correct output.
  const declaredWithoutFiles = [...attribution.declaredFamilies.entries()]
    .filter(([, record]) => record.fileCount === 0)
    .map(([canonical]) => canonical)
    .sort();

  if (declaredWithoutFiles.length > 0) {
    notes.push(
      `${declaredWithoutFiles.length} @font-face family/families are declared ` +
        `but ship no font file, and are therefore not counted as shipped ` +
        `families: ${declaredWithoutFiles.join(", ")}. This is expected — ` +
        `next/font emits a metric-override fallback per family using a local ` +
        `system font.`,
    );
  }

  // -- Anomalies ------------------------------------------------------------
  //
  // Reported, never fatal, and never a downgraded breach. A source map is not
  // an over-budget condition: it is excluded from the JavaScript total (as the
  // legacy CSS baseline likewise excluded ces.css.map), and its mere presence
  // signals that `productionBrowserSourceMaps` was switched on, which is worth
  // a reviewer's attention but is not a byte the budget governs.

  if (sourcemaps.length > 0) {
    anomalies.push(
      `${sourcemaps.length} source map(s) are present and are EXCLUDED from ` +
        `the JavaScript total. next.config.ts does not set ` +
        `productionBrowserSourceMaps, so the default of false applies and a ` +
        `production build should emit none. Their presence means that ` +
        `configuration changed. Files: ` +
        `${sourcemaps.map((file) => file.path).join(", ")}.`,
    );
  }

  return {
    failures,
    anomalies,
    notes,
    javascript: {
      files: javascript,
      raw: sumBy(javascript, "raw"),
      gzip: sumBy(javascript, "gzip"),
      brotli: jsBrotli,
      ceiling: JS_BROTLI_CEILING_BYTES,
      oversizedChunks,
    },
    css: {
      files: stylesheets,
      raw: sumBy(stylesheets, "raw"),
      gzip: sumBy(stylesheets, "gzip"),
      brotli: cssBrotli,
      ceiling: CSS_BROTLI_CEILING_BYTES,
    },
    fonts: {
      files: fonts,
      raw: fontRaw,
      ceiling: FONT_RAW_CEILING_BYTES,
      families,
      unattributed,
      declaredWithoutFiles,
    },
    sourcemaps,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * How many files to list for a group that PASSED. A breached group always lists
 * every contributing file, however many, because that list is the fix.
 */
const MAX_LISTED_FILES_WHEN_PASSING = 10;

const COLUMNS = { group: 13, metric: 8, measured: 12, ceiling: 12, delta: 18 };

function summaryRow(group, metric, measured, ceiling) {
  const over = measured > ceiling;
  const delta = over
    ? `over by ${formatBytes(measured - ceiling)}`
    : `${formatBytes(ceiling - measured)} free`;

  return (
    padEnd(group, COLUMNS.group) +
    padEnd(metric, COLUMNS.metric) +
    padStart(formatBytes(measured), COLUMNS.measured) +
    padStart(formatBytes(ceiling), COLUMNS.ceiling) +
    padStart(delta, COLUMNS.delta) +
    "  " +
    (over ? "FAIL" : "PASS")
  );
}

/** Lists measured files, capped only when the group passed. */
function fileLines(files, field, breached, marker) {
  const listed = breached
    ? files
    : files.slice(0, MAX_LISTED_FILES_WHEN_PASSING);

  const lines = listed.map((file) => {
    const flag = marker === undefined ? "" : marker(file);
    return `    ${padStart(formatBytes(file[field]), 11)}  ${file.path}${flag}`;
  });

  const hidden = files.length - listed.length;
  if (hidden > 0) {
    lines.push(`    ${padStart("", 11)}  … and ${hidden} smaller file(s)`);
  }

  return lines;
}

function renderHumanReport(result, buildDirectory) {
  const lines = [];
  const failed = result.failures.length > 0;

  // Whether a group breached decides only how many of its files are listed:
  // a breached group lists every contributor, because that list is the fix.
  // The font section always lists every file regardless, grouped by family, so
  // it needs no such flag — the per-family ceilings make each line meaningful
  // even when the aggregate passes.
  const jsBreached = result.javascript.brotli > result.javascript.ceiling;
  const cssBreached = result.css.brotli > result.css.ceiling;

  lines.push("Cambridge-Ellis School — static build-output budget");
  lines.push(
    "Authority: technical specification §0.9.3. Build output only — this " +
      "report makes no claim",
  );
  lines.push(
    "about transferred bytes, request counts, origins or Lighthouse scores.",
  );
  lines.push("");
  lines.push(`Build directory: ${toReportPath(buildDirectory)}`);
  lines.push(
    `Compression:     Brotli quality ${BROTLI_QUALITY} with an explicit size ` +
      `hint (deterministic)`,
  );
  lines.push("");

  lines.push(
    padEnd("Group", COLUMNS.group) +
      padEnd("Metric", COLUMNS.metric) +
      padStart("Measured", COLUMNS.measured) +
      padStart("Ceiling", COLUMNS.ceiling) +
      padStart("Headroom", COLUMNS.delta) +
      "  Verdict",
  );
  lines.push("-".repeat(78));
  lines.push(
    summaryRow(
      "JavaScript",
      "brotli",
      result.javascript.brotli,
      result.javascript.ceiling,
    ),
  );
  lines.push(
    summaryRow("CSS", "brotli", result.css.brotli, result.css.ceiling),
  );
  lines.push(
    summaryRow("Fonts", "raw", result.fonts.raw, result.fonts.ceiling),
  );
  lines.push("");

  // -- JavaScript detail ----------------------------------------------------
  lines.push(
    `JavaScript — ${result.javascript.files.length} client chunk(s); ` +
      `raw ${formatBytes(result.javascript.raw)} · ` +
      `gzip ${formatBytes(result.javascript.gzip)} · ` +
      `brotli ${formatBytes(result.javascript.brotli)} (asserted)`,
  );
  lines.push(
    `  per-chunk ceiling ${formatBytes(JS_CHUNK_BROTLI_CEILING_BYTES)} ` +
      `bytes brotli`,
  );
  lines.push(
    ...fileLines(
      result.javascript.files,
      "brotli",
      jsBreached || result.javascript.oversizedChunks.length > 0,
      (file) => {
        const flags = [];
        if (file.polyfill) {
          flags.push("polyfills — legacy browsers only, still counted");
        }
        if (file.brotli > JS_CHUNK_BROTLI_CEILING_BYTES) {
          flags.push("OVER per-chunk ceiling");
        }
        return flags.length > 0 ? `  <- ${flags.join("; ")}` : "";
      },
    ),
  );
  lines.push("");

  // -- CSS detail -----------------------------------------------------------
  lines.push(
    `CSS — ${result.css.files.length} stylesheet(s); ` +
      `raw ${formatBytes(result.css.raw)} · ` +
      `gzip ${formatBytes(result.css.gzip)} · ` +
      `brotli ${formatBytes(result.css.brotli)} (asserted)`,
  );
  lines.push("  aggregate ceiling only — no per-stylesheet sub-ceiling exists");
  lines.push(...fileLines(result.css.files, "brotli", cssBreached));
  lines.push("");

  // -- Fonts detail ---------------------------------------------------------
  const familyNames = [...result.fonts.families.keys()].sort();
  lines.push(
    `Fonts — ${result.fonts.files.length} file(s) in ` +
      `${familyNames.length} shipped family/families; ` +
      `raw ${formatBytes(result.fonts.raw)} (asserted). ` +
      `woff2 only, max ${MAX_FONT_FAMILIES} families.`,
  );

  for (const canonical of familyNames) {
    const family = result.fonts.families.get(canonical);
    const ceiling = FONT_FAMILY_RAW_CEILING_BYTES.get(canonical);
    const verdict =
      ceiling === undefined
        ? "no ceiling — family not permitted"
        : family.raw > ceiling
          ? `FAIL, over by ${formatBytes(family.raw - ceiling)}`
          : `PASS, ${formatBytes(ceiling - family.raw)} free`;
    const limit =
      ceiling === undefined ? "n/a" : `${formatBytes(ceiling)} bytes`;

    lines.push(
      `  ${canonical}: ${formatBytes(family.raw)} bytes raw ` +
        `of ${limit} — ${verdict}`,
    );
    lines.push(...fileLines(family.files, "raw", true));
  }

  if (result.fonts.unattributed.length > 0) {
    lines.push(
      `  unattributed (counted in the total, family unknown): ` +
        `${formatBytes(sumBy(result.fonts.unattributed, "raw"))} bytes`,
    );
    lines.push(...fileLines(result.fonts.unattributed, "raw", true));
  }
  lines.push("");

  // -- Notes, anomalies -----------------------------------------------------
  if (result.notes.length > 0) {
    lines.push("Notes");
    for (const note of result.notes) {
      lines.push(...wrapBullet(note));
    }
    lines.push("");
  }

  if (result.anomalies.length > 0) {
    lines.push("Anomalies — reported, not budget failures");
    for (const anomaly of result.anomalies) {
      lines.push(...wrapBullet(anomaly));
    }
    lines.push("");
  }

  // -- Legacy context -------------------------------------------------------
  lines.push("Legacy baseline, for scale (measured, not estimated)");
  for (const baseline of LEGACY_BASELINES) {
    lines.push(`  ${baseline.group}`);
    lines.push(...wrapText(baseline.detail, 74, "    "));
    lines.push(`    Target: ${baseline.target}`);
  }
  lines.push("");

  // -- Verdict --------------------------------------------------------------
  if (failed) {
    const breaches = result.failures.filter((item) => item.kind === "breach");
    const structural = result.failures.filter(
      (item) => item.kind === "structural",
    );

    lines.push(`BUDGET FAILED — ${result.failures.length} finding(s)`);
    lines.push("");

    if (breaches.length > 0) {
      lines.push(
        `Ceiling breaches (${breaches.length}) — too many bytes shipped; ` +
          `fix belongs in the application:`,
      );
      for (const item of breaches) {
        lines.push(...wrapBullet(`[${item.code}] ${item.message}`));
      }
      lines.push("");
    }

    if (structural.length > 0) {
      lines.push(
        `Structural failures (${structural.length}) — the measurement could ` +
          `not be trusted; fix the build or this script's assumptions:`,
      );
      for (const item of structural) {
        lines.push(...wrapBullet(`[${item.code}] ${item.message}`));
      }
      lines.push("");
    }

    lines.push(
      "No flag, environment variable or configuration file can raise a " +
        "ceiling or suppress a finding above. That is deliberate.",
    );
  } else {
    lines.push("BUDGET PASSED — every ceiling, sub-ceiling and structural");
    lines.push("assertion holds, and no group was empty.");
  }

  return lines.join("\n") + "\n";
}

/** Wraps prose to a width, prefixing each line. Never truncates. */
function wrapText(text, width, prefix) {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(prefix + current);
      current = word;
    }
  }

  if (current.length > 0) {
    lines.push(prefix + current);
  }

  return lines;
}

/** A wrapped bullet: "  - " on the first line, aligned after. */
function wrapBullet(text) {
  const wrapped = wrapText(text, 72, "");
  return wrapped.map((line, index) =>
    index === 0 ? `  - ${line}` : `    ${line}`,
  );
}

// ---------------------------------------------------------------------------
// JSON report
// ---------------------------------------------------------------------------

/** Recursively orders object keys so serialisation is canonical. */
function withSortedKeys(value) {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (value !== null && typeof value === "object") {
    const ordered = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = withSortedKeys(value[key]);
    }
    return ordered;
  }
  return value;
}

const byPath = (left, right) => (left.path < right.path ? -1 : 1);

/**
 * Builds the machine-readable report.
 *
 * Deterministic by construction: keys are sorted recursively, every file array
 * is ordered by path rather than by size, paths are project-root-relative and
 * POSIX-separated, and there is NO timestamp anywhere. A timestamp would make
 * every run of an unchanged build produce a diff, which would make the report
 * useless as a committed or compared artifact.
 */
function buildJsonReport(result, buildDirectory) {
  const jsFile = (file) => ({
    path: file.path,
    rawBytes: file.raw,
    gzipBytes: file.gzip,
    brotliBytes: file.brotli,
    polyfill: file.polyfill === true,
    overPerChunkCeiling: file.brotli > JS_CHUNK_BROTLI_CEILING_BYTES,
  });

  const cssFile = (file) => ({
    path: file.path,
    rawBytes: file.raw,
    gzipBytes: file.gzip,
    brotliBytes: file.brotli,
  });

  const fontFile = (file) => ({
    path: file.path,
    rawBytes: file.raw,
    format: file.extension,
  });

  return withSortedKeys({
    verdict: result.failures.length > 0 ? "fail" : "pass",
    buildDirectory: toReportPath(buildDirectory),
    compression: {
      brotliQuality: BROTLI_QUALITY,
      brotliSizeHint: "input length",
      gzipLevel: GZIP_LEVEL,
    },
    groups: {
      javascript: {
        assertedMetric: "brotli",
        ceilingBytes: result.javascript.ceiling,
        perChunkCeilingBytes: JS_CHUNK_BROTLI_CEILING_BYTES,
        rawBytes: result.javascript.raw,
        gzipBytes: result.javascript.gzip,
        brotliBytes: result.javascript.brotli,
        fileCount: result.javascript.files.length,
        files: [...result.javascript.files].sort(byPath).map(jsFile),
      },
      css: {
        assertedMetric: "brotli",
        ceilingBytes: result.css.ceiling,
        rawBytes: result.css.raw,
        gzipBytes: result.css.gzip,
        brotliBytes: result.css.brotli,
        fileCount: result.css.files.length,
        files: [...result.css.files].sort(byPath).map(cssFile),
      },
      fonts: {
        assertedMetric: "raw",
        ceilingBytes: result.fonts.ceiling,
        maxFamilies: MAX_FONT_FAMILIES,
        requiredFormat: REQUIRED_FONT_EXTENSION,
        rawBytes: result.fonts.raw,
        fileCount: result.fonts.files.length,
        shippedFamilies: [...result.fonts.families.keys()]
          .sort()
          .map((canonical) => ({
            family: canonical,
            permitted: EXPECTED_FONT_FAMILIES.has(canonical),
            ceilingBytes: FONT_FAMILY_RAW_CEILING_BYTES.get(canonical) ?? null,
            rawBytes: result.fonts.families.get(canonical).raw,
            files: [...result.fonts.families.get(canonical).files]
              .sort(byPath)
              .map(fontFile),
          })),
        declaredWithoutFiles: result.fonts.declaredWithoutFiles,
        unattributed: [...result.fonts.unattributed].sort(byPath).map(fontFile),
      },
    },
    failures: result.failures,
    anomalies: result.anomalies,
    notes: result.notes,
    sourceMaps: [...result.sourcemaps].sort(byPath).map((file) => file.path),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `stat` that reports absence as `undefined` and rethrows everything else.
 *
 * The distinction matters: a missing directory is a condition this script
 * handles with a specific diagnostic, whereas a permission error or an I/O
 * fault is not something to interpret as "nothing here". Swallowing the latter
 * would let an unreadable build report as an empty one, which the
 * anti-vacuous-pass rule exists to prevent.
 */
async function statOrUndefined(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** Writes a structural diagnostic to stderr. Never to stdout. */
function reportUnmeasurable(message) {
  process.stderr.write(
    `check-budget: BUDGET FAILED — the build could not be measured\n` +
      `  ${message}\n` +
      `  An unmeasurable build is a failure, not a pass: a budget that ` +
      `succeeded\n` +
      `  because it found nothing would silently stop protecting anything.\n`,
  );
}

/**
 * Returns the process exit code. 0 only when everything passed.
 *
 * Note the absence of any branch that could return 0 in the presence of a
 * finding. There is no `--force`, no severity threshold and no allowlist,
 * because §0.9.3's ceilings are the gate's whole purpose.
 */
async function main() {
  let options;

  try {
    options = parseCommandLine(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-budget: ${error.message}\n\n`);
    process.stderr.write(USAGE);
    return 1;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const buildDirectory =
    options.dir === undefined
      ? DEFAULT_BUILD_DIRECTORY
      : path.resolve(process.cwd(), options.dir);

  const buildStat = await statOrUndefined(buildDirectory);
  if (buildStat === undefined || !buildStat.isDirectory()) {
    reportUnmeasurable(
      `Build directory not found: ${buildDirectory}\n` +
        `  Run \`next build\` first, or pass --dir <path> to point at a ` +
        `downloaded build artifact.`,
    );
    return 1;
  }

  const staticDirectory = path.join(buildDirectory, "static");
  const staticStat = await statOrUndefined(staticDirectory);
  if (staticStat === undefined || !staticStat.isDirectory()) {
    reportUnmeasurable(
      `No static directory inside the build: ${staticDirectory}\n` +
        `  A complete Next.js build always emits one. The directory given is ` +
        `not a build artifact,\n  or the artifact was uploaded or extracted ` +
        `without its static assets.`,
    );
    return 1;
  }

  const measurement = await measureBuild(buildDirectory);
  const result = evaluate(measurement);

  // The report goes to stdout so it can be piped or captured; every diagnostic
  // that is not the report itself goes to stderr.
  process.stdout.write(renderHumanReport(result, buildDirectory));

  if (options.json !== undefined) {
    const target = path.resolve(process.cwd(), options.json);
    const payload = buildJsonReport(result, buildDirectory);
    // Two spaces, LF endings and a trailing newline, so a committed report
    // diffs cleanly and a re-run over an unchanged build produces no diff.
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stderr.write(`check-budget: JSON report written to ${target}\n`);
  }

  for (const anomaly of result.anomalies) {
    process.stderr.write(`check-budget: anomaly — ${anomaly}\n`);
  }

  if (result.failures.length > 0) {
    process.stderr.write(
      `check-budget: FAILED with ${result.failures.length} finding(s) — ` +
        `see the report above.\n`,
    );
    return 1;
  }

  return 0;
}

/**
 * `process.exitCode` rather than `process.exit()`: the latter can terminate the
 * process before a large stdout write has flushed, which would truncate the
 * very report a failing run needs to show.
 *
 * The catch is a backstop, and it fails closed. An unexpected exception means
 * the budget was not verified, and an unverified budget must never report
 * success — so this returns 1 and prints the stack rather than swallowing it.
 */
try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `check-budget: BUDGET FAILED — unexpected error while measuring the ` +
      `build.\n` +
      `An unverified budget is never a pass.\n` +
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
