/**
 * ESLint flat configuration for the Cambridge-Ellis School Next.js application.
 *
 * This file replaces `.styleci.yml`, which configured a hosted PHP formatting
 * service (`php.preset: laravel`, a JS finder that excluded only
 * `webpack.mix.js`, `css: true`) and governed nothing in a TypeScript
 * application. Next 16 removes the `next lint` command, so linting runs through
 * the ESLint CLI and CI invokes it as:
 *
 *     npx eslint . --max-warnings=0
 *
 * `--max-warnings=0` is the single most important fact about this file: a
 * warning is exactly as fatal as an error. `eslint-config-next` ships 26 of its
 * rules at `warn` severity — `@next/next/no-img-element`, the `jsx-a11y` set,
 * `react-hooks/exhaustive-deps` and `import/no-anonymous-default-export` among
 * them — and every one of those therefore fails the build. Nothing may be
 * switched on here that the code in this repository cannot satisfy.
 *
 * That constraint applies to this module too, which is why the configuration is
 * assigned to a named `config` binding before being exported:
 * `import/no-anonymous-default-export` is enabled, `.mjs` is inside its file
 * glob, and a bare `export default [ ... ]` would flag this very file. Sibling
 * `postcss.config.mjs` uses the same named-const form.
 *
 * The `.mjs` extension is load-bearing. `package.json` does not set
 * `"type": "module"`, so the extension — not a package field — is what makes
 * `import`/`export default` correct here. Do not rename this file to `.js`.
 *
 * ## What this file is for
 *
 * Beyond the framework presets, this configuration is the enforcement mechanism
 * for the import boundaries the technical specification states as prose and
 * then explicitly delegates to lint (§0.6.5 "Import Refactoring Rules" and
 * §0.5.2 "Cross-File Dependencies and Import Changes"). A boundary that is
 * described in a document but not enforced here is a boundary that will be
 * crossed as the tree is populated. Each block below names the boundary it
 * implements and why it exists.
 *
 * No user-specified rules were provided for this project (`review_rules`
 * returns none, and §0.8 states the same), so nothing here originates from a
 * project rule document; every rule traces to the specification or to
 * enterprise-standard practice.
 *
 * ## What this file is deliberately NOT for
 *
 * The "zero hardcoded values" design-system rule (§0.3.5) is not an ESLint
 * concern. Unmodified shadcn/ui registry output contains arbitrary Tailwind
 * values by design (`ring-[3px]`, `text-[0.8rem]`), and that axis is governed by
 * a separate committed token audit — `npm run audit:tokens` — which walks
 * `components/ui/**` and distinguishes generated files from authored ones. Do
 * not reimplement it here.
 *
 * Formatting is likewise out of scope: `prettier@3.9.6` owns it, configured
 * through the `prettier` key in `package.json` together with
 * `prettier-plugin-tailwindcss`. No stylistic rule appears below, so there is
 * nothing for Prettier to fight and `eslint-config-prettier` is not needed.
 */

// `eslint-config-next@16.3.3` ships a native flat config: each of these entry
// points resolves to a `Linter.Config[]`. No `FlatCompat` shim and therefore no
// `@eslint/eslintrc` dependency is required.
//
// `/core-web-vitals` is a strict superset of the package's default export — it
// is the same three blocks plus the `next/core-web-vitals` rule block — so only
// one of the two may be spread here. Spreading both would register every plugin
// twice.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
// `/typescript` adds the TypeScript-aware layer: the `typescript-eslint` parser
// and its `recommended` rule set, which resolve against `tsconfig.json` (strict,
// with `@/*` mapped to `./*`). It is also the only route to unused-variable
// enforcement that does not require importing a package this project does not
// declare — core `no-unused-vars` is disabled for TypeScript, and
// `typescript-eslint` itself is merely a transitive dependency.
import nextTypeScript from "eslint-config-next/typescript";

/**
 * Every extension ESLint should treat as project source. Stated explicitly so
 * the blocks below apply to a known set rather than to whatever ESLint happens
 * to default to.
 */
const SOURCE_FILES = ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"];

/* ==========================================================================
 * Restriction primitives
 * --------------------------------------------------------------------------
 * `no-restricted-imports` and `no-restricted-syntax` take options, and flat
 * config REPLACES a rule's options rather than merging them. An override block
 * that re-declares either rule therefore silently discards every restriction
 * the base block established.
 *
 * That is why the restrictions are built here as reusable values and composed
 * per block through `restrictImports` / `restrictSyntax`. A `lib/content/cached`
 * override adding one path keeps the Radix, Tiptap and relative-depth bans
 * instead of dropping them.
 * ========================================================================== */

const RADIX_MESSAGE =
  'Import Radix primitives from the consolidated `radix-ui` package instead, as `import { X as XPrimitive } from "radix-ui"`. The February 2026 shadcn/ui consolidation collapsed the thirteen `@radix-ui/react-*` packages into this single dependency; a single `@radix-ui/react-*` import reintroduces the fragmented dependency the consolidation removed.';

const SUPABASE_DIRECT_MESSAGE =
  "Do not construct a Supabase client directly. `@supabase/supabase-js` may only be imported by the four client factories in `lib/supabase/`. Use `@/lib/supabase/server` from Server Components, Server Actions and Route Handlers; `@/lib/supabase/client` from Client Components; `@/lib/supabase/public` from cached content readers; and `@/lib/supabase/admin` from privileged server paths only.";

const TIPTAP_STARTERKIT_MESSAGE =
  "This extension is already registered by `@tiptap/starter-kit`; importing it by path duplicates it, which Tiptap reports as a schema conflict at runtime. Configure it through `StarterKit.configure({ ... })` instead — and note that `underline` is configured OFF, because no source Bard button declares it and the rich-text validator rejects it.";

const TIPTAP_DIRECT_IMPORT_MESSAGE =
  "Only `@tiptap/extension-table` and `@tiptap/extension-image` may be imported directly, because StarterKit does not provide them. Every other node and mark comes from `StarterKit.configure({ ... })`, whose enabled set is derived from the server-side allowlist in `lib/richtext-validate.ts` so the editor cannot offer a node the validator refuses.";

const PHANTOM_MODULE_MESSAGE =
  "This module does not exist in this project and must not be created. There is no custom image loader — the built-in Next.js optimizer is used, and the reference implementation's loader was a verified no-op passthrough. There is no sanitizer either: the migrated corpus contains zero raw HTML nodes and zero HTML tags, so the rich-text renderer maps a JSON node tree straight to React elements. The one place markup is written directly is the JSON-LD emitter, which owns its own escaping contract.";

const DEEP_RELATIVE_MESSAGE =
  "A relative import may not climb more than one level. Use the `@/*` path alias, which `tsconfig.json` maps to the project root, so a file can move without rewriting its imports.";

const COMPONENT_DATA_ACCESS_MESSAGE =
  "No React component or hook may reach Supabase directly. Reads go through the typed functions in `@/lib/content/*`; writes go through the Server Actions in `@/lib/actions/*` onto authorization-checking database functions. This is the correction of both the legacy Antlers pattern, which embedded queries in templates, and of the reference implementation, which wrote to the database from the browser.";

const SUPABASE_ADMIN_IN_CLIENT_MESSAGE =
  'The service-role client must never be reachable from a client bundle. `@/lib/supabase/admin` is additionally guarded by `import "server-only"`, so this rule is defence in depth rather than the only line — but a client module that imports it is a defect. Perform the privileged operation in a Server Action under `@/lib/actions/*`.';

const APP_DATA_ACCESS_MESSAGE =
  "Presenters and route segments read through `@/lib/content/*` and never construct a query. Only Route Handlers — `app/api/**` and any `route.ts` — may reach a Supabase client factory directly.";

const ROUTE_HANDLER_CLIENT_MESSAGE =
  "A Route Handler runs on the server and has no browser session to attach. Use `@/lib/supabase/server` for a cookie-bound request client, `@/lib/supabase/admin` for a privileged one, or `@/lib/supabase/public` for an anonymous read — never the browser client.";

const CACHED_READER_MESSAGE =
  "A cached content reader may not touch request state. `use cache` functions must use the cookie-free `@/lib/supabase/public` client: a request-bound cookie client inside a cached function would either poison the cache with one user's view of the site or silently force the function dynamic, and neither failure is visible without an explicit check. Authenticated reads that need draft and private visibility under real RLS belong in the uncached `lib/content/live/*` counterpart. A unit test asserts this same constraint independently — the redundancy is deliberate.";

const PROCESS_ENV_MESSAGE =
  "`lib/env.ts` is the only module that may read `process.env`. It validates against separate public and server schemas and returns `undefined` instead of throwing, which is what lets the site build and render with no Supabase keys present at all. Reading the environment anywhere else risks pulling a server-only key — the service-role secret above all — into a client bundle by accident. Note that `next.config.ts` and `proxy.ts` are deliberately NOT exempt: both read their configuration through `lib/env.ts`.";

const CACHE_TAG_MESSAGE =
  "Cache tags are constructed only in `lib/cache-tags.ts`; no call site may concatenate or interpolate a tag string. Import the helper for the tag you need, so a tag written by a Server Action and a tag read by a cached function cannot drift apart.";

const REVALIDATE_TAG_ARITY_MESSAGE =
  'The single-argument `revalidateTag(tag)` form is deprecated in Next 16 and appears nowhere in this project. Pass a `cacheLife` profile as the second argument — `revalidateTag(tag, "max")` — or use `updateTag(tag)` when a Server Action needs read-your-writes on its own next render.';

const LUCIDE_NAMESPACE_MESSAGE =
  'Import icons by name — `import { Pencil, Check, X } from "lucide-react"` — never as a namespace. A namespace import defeats tree-shaking and pulls the whole icon set into the bundle, against a performance budget that allows 180 KB of compressed JavaScript for the entire page.';

/** Boundary §0.6.5: the consolidated primitive package, never the thirteen. */
const RADIX_PATTERN = {
  group: ["@radix-ui/react-*"],
  message: RADIX_MESSAGE,
};

/** Boundary §0.6.5: no client is constructed outside the four factories. */
const SUPABASE_DIRECT_PATH = {
  name: "@supabase/supabase-js",
  message: SUPABASE_DIRECT_MESSAGE,
};

/**
 * Boundary §0.6.5: the two extensions StarterKit already registers. These are
 * named individually so the message can explain the runtime schema conflict,
 * and they are excluded from `TIPTAP_OTHER_PATTERN` below so a single import
 * produces one precise report rather than two overlapping ones.
 */
const TIPTAP_BUNDLED_PATHS = [
  { name: "@tiptap/extension-link", message: TIPTAP_STARTERKIT_MESSAGE },
  { name: "@tiptap/extension-underline", message: TIPTAP_STARTERKIT_MESSAGE },
];

/**
 * Every other `@tiptap/extension-*` package. `table` and `image` are the only
 * two legitimately imported by path; `link` and `underline` are excluded
 * because the entries above already report them with a better message.
 */
const TIPTAP_OTHER_PATTERN = {
  regex: "^@tiptap/extension-(?!table$|image$|link$|underline$)",
  message: TIPTAP_DIRECT_IMPORT_MESSAGE,
};

/** Modules this project deliberately does not create. */
const PHANTOM_MODULE_PATHS = [
  { name: "@/lib/image-loader", message: PHANTOM_MODULE_MESSAGE },
  { name: "@/lib/sanitize", message: PHANTOM_MODULE_MESSAGE },
];

/**
 * The same two modules reached by a relative or bare specifier. The `(?!@/)`
 * lookahead excludes the aliased form, which the `paths` entries above already
 * report by exact name — without it, one `@/lib/sanitize` import would produce
 * two identical diagnostics.
 */
const PHANTOM_MODULE_PATTERN = {
  regex: "^(?!@/)(?:.*/)?lib/(?:image-loader|sanitize)$",
  message: PHANTOM_MODULE_MESSAGE,
};

/**
 * Boundary §0.6.5: no relative import climbs more than one level. An anchored
 * regex is used rather than a glob because glob negation over `..` segments is
 * ambiguous, whereas `^\.\./\.\./` is exactly "two or more levels up".
 */
const DEEP_RELATIVE_PATTERN = {
  regex: "^\\.\\./\\.\\./",
  message: DEEP_RELATIVE_MESSAGE,
};

/**
 * Matches a `lib/supabase/*` module however it is addressed — through the `@/`
 * alias, through a relative path, or bare. One regex covers all three forms, so
 * an override cannot be defeated by switching specifier style.
 */
const supabaseModulePattern = (suffix, message) => ({
  regex: `(?:^|/)lib/supabase/${suffix}`,
  message,
});

const BASE_RESTRICTED_PATHS = [
  SUPABASE_DIRECT_PATH,
  ...TIPTAP_BUNDLED_PATHS,
  ...PHANTOM_MODULE_PATHS,
];

const BASE_RESTRICTED_PATTERNS = [
  RADIX_PATTERN,
  TIPTAP_OTHER_PATTERN,
  PHANTOM_MODULE_PATTERN,
  DEEP_RELATIVE_PATTERN,
];

/**
 * Compose `no-restricted-imports` options from the project-wide set plus a
 * block's own additions.
 *
 * @param {object}   [options]
 * @param {object[]} [options.paths]      Extra `paths` entries for this block.
 * @param {object[]} [options.patterns]   Extra `patterns` entries for this block.
 * @param {string[]} [options.allowPaths] Base `paths` names this block permits.
 */
const restrictImports = ({
  paths = [],
  patterns = [],
  allowPaths = [],
} = {}) => [
  "error",
  {
    paths: [
      ...BASE_RESTRICTED_PATHS.filter(
        (entry) => !allowPaths.includes(entry.name),
      ),
      ...paths,
    ],
    patterns: [...BASE_RESTRICTED_PATTERNS, ...patterns],
  },
];

/* ==========================================================================
 * Syntax restrictions
 * --------------------------------------------------------------------------
 * Three of the specification's boundaries are not expressible as an import
 * ban, because what they constrain is a call or a member expression rather
 * than a module specifier.
 * ========================================================================== */

/**
 * Boundary §0.6.5: `process.env` has exactly one reader.
 *
 * The selector matches the `process.env` member expression itself rather than
 * `process.env.FOO`, so it also catches destructuring (`const { X } =
 * process.env`) and enumeration (`Object.keys(process.env)`). Matching only the
 * outer expression would miss both. `object.name` requires a bare `process`
 * identifier, so an unrelated `config.process.env` is not reported.
 */
const PROCESS_ENV_SYNTAX = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: PROCESS_ENV_MESSAGE,
  },
  {
    // The computed form, `process["env"]`.
    selector: "MemberExpression[object.name='process'][property.value='env']",
    message: PROCESS_ENV_MESSAGE,
  },
];

/**
 * Boundary §0.6.5: cache tags are built in one module.
 *
 * A template literal or a concatenation passed straight to a tag function is a
 * tag constructed at the call site. A plain string literal is not flagged —
 * call sites legitimately pass a constant returned from `lib/cache-tags.ts`.
 */
const CACHE_TAG_SYNTAX = [
  {
    selector:
      "CallExpression[callee.name=/^(?:cacheTag|updateTag|revalidateTag)$/] > TemplateLiteral",
    message: CACHE_TAG_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.name=/^(?:cacheTag|updateTag|revalidateTag)$/] > BinaryExpression",
    message: CACHE_TAG_MESSAGE,
  },
];

/** Boundary §0.4.4: the deprecated single-argument `revalidateTag` form. */
const REVALIDATE_TAG_ARITY_SYNTAX = {
  selector: "CallExpression[callee.name='revalidateTag'][arguments.length=1]",
  message: REVALIDATE_TAG_ARITY_MESSAGE,
};

/** Boundary §0.6.5: named icon imports only, so tree-shaking holds. */
const LUCIDE_NAMESPACE_SYNTAX = {
  selector:
    "ImportDeclaration[source.value='lucide-react'] > ImportNamespaceSpecifier",
  message: LUCIDE_NAMESPACE_MESSAGE,
};

const BASE_RESTRICTED_SYNTAX = [
  ...PROCESS_ENV_SYNTAX,
  ...CACHE_TAG_SYNTAX,
  REVALIDATE_TAG_ARITY_SYNTAX,
  LUCIDE_NAMESPACE_SYNTAX,
];

/** `no-restricted-syntax` takes its entries as variadic options. */
const restrictSyntax = (entries) => ["error", ...entries];

/* ==========================================================================
 * Configuration
 * ========================================================================== */

const config = [
  /**
   * Global ignores. A block carrying only `ignores` applies project-wide.
   *
   * `eslint-config-next` already ignores `.next/**`, `out/**`, `build/**` and
   * `next-env.d.ts`; they are repeated here so this file states its own
   * boundary rather than depending on a framework preset's internals.
   *
   * `next-env.d.ts` is framework-generated yet committed — uniquely in this
   * project, because the `lint-types` CI job runs `tsc --noEmit` on a clean
   * checkout with no build before it and `tsconfig.json` lists the file in
   * `include`. `next build` rewrites it, so any edit would be lost; it is
   * ignored rather than corrected.
   *
   * `components/ui/**` is deliberately NOT ignored. Those 43 files — 38
   * generated by `shadcn add` and 5 authored — are project source and are
   * reviewed like any other file. A blanket ignore would also blind the linter
   * to the five authored files that share the directory. If unmodified registry
   * output ever produces an unavoidable violation, the fix is a narrowly scoped
   * override naming the specific rule, not an ignore.
   */
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "public/**",
      "data/fallback/**",
      "next-env.d.ts",
    ],
  },

  // The framework presets. Order matters: the TypeScript layer comes second so
  // its parser applies to the files the base layer has already matched.
  ...nextCoreWebVitals,
  ...nextTypeScript,

  /**
   * Project-wide baseline: the import and syntax boundaries that hold
   * everywhere, plus unused-symbol enforcement.
   *
   * Every rule `eslint-config-next` enables is left at the severity it chose.
   * `@next/next/no-img-element` in particular stays on: replacing raw `<img>`
   * tags and inline `background-image` declarations with the `Media` component
   * over `next/image` is the migration's central performance fix, against a
   * measured baseline of zero `srcset` attributes anywhere on the site. Under
   * `--max-warnings=0` its `warn` severity already fails the build.
   */
  {
    name: "ces/baseline",
    files: SOURCE_FILES,
    rules: {
      // Superseded by the TypeScript-aware rule below, which understands type
      // positions and generics. Both enabled would double-report on plain JS.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-restricted-imports": restrictImports(),
      "no-restricted-syntax": restrictSyntax(BASE_RESTRICTED_SYNTAX),
    },
  },

  /**
   * The four Supabase client factories are the only modules permitted to
   * construct a client, so the direct-import ban is lifted for exactly these
   * paths — and for no others. Every other restriction still applies.
   */
  {
    name: "ces/supabase-client-factories",
    files: [
      "lib/supabase/public.ts",
      "lib/supabase/client.ts",
      "lib/supabase/server.ts",
      "lib/supabase/admin.ts",
    ],
    rules: {
      "no-restricted-imports": restrictImports({
        allowPaths: ["@supabase/supabase-js"],
      }),
    },
  },

  /**
   * Cached content readers. The highest-value rule in this file: a cookie-bound
   * client inside a `use cache` function either serves one visitor another's
   * view of the site or silently makes the function dynamic.
   *
   * `next/headers` is banned by name. The three request-bound clients are
   * banned by regex instead, which covers the aliased, relative and bare
   * specifier forms in one entry and reports each violation exactly once.
   * `@/lib/supabase/public` — the cookie-free client these modules must use —
   * is intentionally not matched.
   */
  {
    name: "ces/cached-content-readers",
    files: ["lib/content/cached/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        paths: [{ name: "next/headers", message: CACHED_READER_MESSAGE }],
        patterns: [
          supabaseModulePattern(
            "(?:server|client|admin)$",
            CACHED_READER_MESSAGE,
          ),
        ],
      }),
    },
  },

  /**
   * The cache-tag factory itself must be free to build the strings every other
   * module imports. Only the tag-construction selectors are lifted; the
   * `process.env`, `revalidateTag` arity and icon-namespace bans still apply.
   */
  {
    name: "ces/cache-tag-factory",
    files: ["lib/cache-tags.ts"],
    rules: {
      "no-restricted-syntax": restrictSyntax([
        ...PROCESS_ENV_SYNTAX,
        REVALIDATE_TAG_ARITY_SYNTAX,
        LUCIDE_NAMESPACE_SYNTAX,
      ]),
    },
  },

  /**
   * React components and hooks never reach the data layer directly. The
   * service-role client gets its own entry so the message can explain the
   * bundle-leak stakes; the negative lookahead keeps the two from overlapping
   * and double-reporting.
   */
  {
    name: "ces/components-no-direct-data-access",
    files: ["components/**", "hooks/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        patterns: [
          supabaseModulePattern("admin$", SUPABASE_ADMIN_IN_CLIENT_MESSAGE),
          supabaseModulePattern("(?!admin$)", COMPONENT_DATA_ACCESS_MESSAGE),
        ],
      }),
    },
  },

  /**
   * Route segments — layouts, pages and the metadata files — read through
   * `@/lib/content/*`. Route Handlers are the documented exception and are
   * restored in the next block, which must therefore follow this one.
   */
  {
    name: "ces/app-router-no-direct-data-access",
    files: ["app/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        patterns: [supabaseModulePattern("", APP_DATA_ACCESS_MESSAGE)],
      }),
    },
  },

  /**
   * Route Handlers legitimately need a server or privileged client: the upload
   * sign and finalize routes, the private-media proxy, the guarded cleanup
   * sweep and the tag-revalidation endpoint all perform real data access.
   *
   * Any `route.ts` under `app/` is matched alongside `app/api/**`, because two
   * handlers live outside the API namespace — `app/auth/callback/route.ts`
   * exchanges the PKCE, invitation and recovery codes, and
   * `app/auth/sign-out/route.ts` revokes the session. Both are Route Handlers
   * in every sense; only their URL prefix differs. The browser client stays
   * banned here, since a handler has no browser session to attach.
   */
  {
    name: "ces/route-handlers",
    files: ["app/api/**", "app/**/route.ts"],
    rules: {
      "no-restricted-imports": restrictImports({
        patterns: [
          supabaseModulePattern("client$", ROUTE_HANDLER_CLIENT_MESSAGE),
        ],
      }),
    },
  },

  /**
   * The modules permitted to read `process.env`.
   *
   * `lib/env.ts` is the application's sole reader. The rest run outside the
   * application module graph — build tooling, test runners and standalone
   * scripts — and legitimately read `CI`, `PORT`, `BASE_URL` and the local
   * Supabase keys that `supabase status` emits.
   *
   * `next.config.ts` and `proxy.ts` are pointedly absent. Both read their
   * configuration through `lib/env.ts` — `proxy.ts` for `CSP_MODE`,
   * `HSTS_MAX_AGE` and the Supabase project host, `next.config.ts` for the
   * image `remotePatterns` host — and keeping them inside the rule is what
   * makes the single-reader invariant true where it actually matters.
   */
  {
    name: "ces/environment-readers",
    files: [
      "lib/env.ts",
      "eslint.config.mjs",
      "postcss.config.mjs",
      "vitest.config.ts",
      "playwright.config.ts",
      "scripts/**",
      "tests/**",
    ],
    rules: {
      "no-restricted-syntax": restrictSyntax([
        ...CACHE_TAG_SYNTAX,
        REVALIDATE_TAG_ARITY_SYNTAX,
        LUCIDE_NAMESPACE_SYNTAX,
      ]),
    },
  },

  /**
   * The test suite, last so it can relax what the preceding blocks set.
   *
   * `tests/support/test-db.ts` and `test-admin.ts` bootstrap the local Supabase
   * stack — applying migrations and the seed, then creating the deterministic
   * admin and editor accounts through the service role — which requires
   * constructing a client directly. Nothing else is relaxed: the Radix, Tiptap,
   * phantom-module and relative-depth bans all still hold, and so does the
   * `process.env` allowance granted above.
   */
  {
    name: "ces/tests",
    files: ["tests/**"],
    rules: {
      "no-restricted-imports": restrictImports({
        allowPaths: ["@supabase/supabase-js"],
      }),
    },
  },
];

export default config;
