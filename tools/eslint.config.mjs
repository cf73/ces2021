/**
 * ESLint flat configuration for the Cambridge-Ellis School migration tooling.
 *
 * This file, together with `nextjs/eslint.config.mjs`, replaces `.styleci.yml` —
 * a hosted-service configuration for a PHP codebase (`php.preset: laravel` with
 * `no_unused_imports` disabled, a JS finder that excluded only
 * `webpack.mix.js`, and `css: true`). Nothing in it governed a TypeScript
 * project and nothing in it is carried forward. The legacy repository had no
 * lint, typecheck or test script of any kind, so this is a new baseline rather
 * than a migration of an old one.
 *
 * CI invokes it exactly as `package.json`'s `lint` script does:
 *
 *     npx eslint . --max-warnings=0
 *
 * `--max-warnings=0` is the single most important fact about this file: a
 * warning is exactly as fatal as an error. Nothing may be switched on here that
 * the code in this project cannot satisfy cleanly.
 *
 * ## Why this project is linted as strictly as the application
 *
 * `tools/` is a self-contained npm project that the deployment never installs —
 * the Vercel Root Directory is `nextjs/`. It would be easy to argue it deserves
 * a lighter touch. The opposite is true, and it is the reason the `tools-quality`
 * CI job exists: these six programs decide what 163 Statamic entries, 142 routed
 * paths, 55 publish flags and 289 asset binaries *become*. A silent bug in the
 * extractor is not a tooling bug, it is a content bug, and it ships as missing
 * or corrupted school content that nobody is watching for.
 *
 * Three properties of the corpus drive the specific rule choices below, because
 * each is a shape hazard that types alone do not catch:
 *
 *   - Everything enters as `unknown`-shaped parsed YAML and Markdown front
 *     matter. The `no-unsafe-*` family is what forces a validating narrow
 *     instead of a hopeful cast.
 *   - A replicator set of `type: "text"` is indistinguishable from a ProseMirror
 *     `text` node except by whether `text` holds an array or a string — 65 such
 *     sets across 23 pages. Coercion and loose equality both hide that.
 *   - `colwidth` is an array, `null`, or an absent key; `programs_offered` is an
 *     explicit `null` on one page. A truthiness shortcut silently drops the
 *     tuition fee schedule's column widths.
 *
 * ## What this file is deliberately NOT for
 *
 * Formatting. Prettier owns it for the repository, and `.editorconfig` sets the
 * 2-space rule for `*.ts`. No stylistic rule appears below, so there is nothing
 * for Prettier to fight and `eslint-config-prettier` is not needed. Duplicating
 * formatting opinions across two lint configs is how they drift.
 *
 * `eslint-config-next` is also deliberately absent. This is a filesystem and
 * database script project with no React, no JSX and no browser; that preset
 * would drag the React, hooks, a11y and Next plugins in for no benefit.
 *
 * The sibling `nextjs/eslint.config.mjs` carries a large set of
 * `no-restricted-imports` boundaries — the consolidated `radix-ui` package, the
 * four Supabase client factories, the StarterKit-bundled Tiptap extensions,
 * `next/headers` under `lib/content/cached/**`, cache-tag construction,
 * namespace `lucide-react` imports. Every one of those describes application
 * architecture that does not exist here, so none is copied. Carrying them across
 * would be cargo-culting. The one boundary worth mirroring is its confinement of
 * `process.env`: `nextjs/` funnels the environment through `lib/env.ts`, and the
 * equivalent discipline here is the secret-literal ban below plus the convention
 * `tools/README.md` §6 states — credentials arrive as environment variables or
 * command-line arguments at invocation time, and nowhere else.
 *
 * No user-specified rules were provided for this project (`review_rules` returns
 * none), so nothing here originates from a project rule document. Every rule
 * traces to the technical specification or to enterprise-standard practice.
 */

// `@eslint/js` supplies the 61-rule core `recommended` set, and `globals` the
// Node global list. Both are declared as exact-pinned devDependencies in
// `tools/package.json` rather than being relied on as transitive dependencies of
// `eslint`: `globals` in particular reaches this project only through
// `@eslint/eslintrc`, and a package manager is free to nest a second-level
// transitive where a direct import cannot see it. We import them, so we declare
// them.
import js from "@eslint/js";
import globals from "globals";
// The `typescript-eslint` meta-package exports the parser, the plugin, the
// shared configs and the `config()` helper that gives flat config `extends`.
import tseslint from "typescript-eslint";

/* ==========================================================================
 * File globs
 * ========================================================================== */

/**
 * Everything ESLint should treat as project source. Stated explicitly so the
 * blocks below apply to a known set rather than to whatever ESLint defaults to,
 * and written wide enough that a future `.cjs` helper or plain `.js` script is
 * linted the day it appears rather than silently exempt.
 */
const ALL_SOURCE_FILES = ["**/*.{js,cjs,mjs,ts,mts,cts}"];

/** TypeScript only: where the type-aware rules and the TS plugin rules apply. */
const TYPESCRIPT_FILES = ["**/*.{ts,mts,cts}"];

/**
 * Plain JavaScript, which in this project means this configuration file and
 * nothing else. See the `ces-tools/plain-javascript` block for why it needs its
 * own treatment.
 */
const JAVASCRIPT_FILES = ["**/*.{js,cjs,mjs}"];

/* ==========================================================================
 * Restriction messages
 * --------------------------------------------------------------------------
 * Hoisted to named constants so a selector list stays readable and so the same
 * explanation cannot drift between the two places it is used.
 * ========================================================================== */

const SECRET_LITERAL_MESSAGE =
  "A credential must never appear as a literal in this repository. `tools/README.md` §6 is explicit: no script here reads a credential from a file in the repository — the project URL, the service-role secret key and any connection string arrive as an environment variable or a command-line argument at invocation time, and nowhere else. Four of the six programs run under the service role, which the specification exempts from every per-account write and upload rate limit, so a leaked service-role literal is the single worst outcome available to this migration. If this is genuinely a documentation example rather than a real value, add a line-scoped `eslint-disable-next-line no-restricted-syntax` carrying a comment that says why — do not remove or widen the rule.";

const REQUIRE_MESSAGE =
  '`tools/package.json` sets `"type": "module"` and `tsconfig.json` sets `verbatimModuleSyntax`, so this project is ESM: `require` is not defined at runtime and `module`, `exports` and `__dirname` do not exist. Use a static `import` declaration.';

const DYNAMIC_IMPORT_MESSAGE =
  "A dynamic `import()` must name its module with a string literal. A computed specifier means the module graph cannot be read from the source, which defeats both bundling and review, and a specifier assembled from parsed content would let the corpus decide what code runs.";

/* ==========================================================================
 * Restriction selectors
 * --------------------------------------------------------------------------
 * `no-restricted-syntax` takes options, and flat config REPLACES a rule's
 * options rather than merging them. A later block that re-declares the rule
 * silently discards every selector an earlier block established — a failure
 * with no symptom, because the rule still appears to be enabled.
 *
 * The selectors are therefore built here as reusable arrays and composed per
 * block through `restrictSyntax()`. Each block states its complete selector set
 * in one place, so nothing can be lost by ordering.
 * ========================================================================== */

/**
 * Build the two selectors that catch a pattern wherever a string can hide: a
 * plain string literal, and a chunk of a template literal. Checking only
 * `Literal` would miss a connection string or key assembled in a template with
 * an interpolated user and password, which is exactly the shape a hand-rolled
 * credential takes — the fixed scheme-and-host prefix still lands in a
 * `TemplateElement`, so that is where it is caught.
 *
 * @param {string} pattern An esquery regex literal, as source text.
 * @param {string} message The explanation reported at the match.
 * @returns {{selector: string, message: string}[]}
 */
const stringPatternSelectors = (pattern, message) => [
  { selector: `Literal[value=${pattern}]`, message },
  { selector: `TemplateElement[value.raw=${pattern}]`, message },
];

/**
 * Mechanical enforcement of the "no secret in any committed file" requirement.
 *
 * Two details of these regexes are deliberate and easy to break:
 *
 *   - `/` is written `\x2f`. An esquery attribute regex is delimited by `/`, so
 *     a literal slash inside it is at best parser-dependent. `\x2f\x2f` is the
 *     unambiguous way to say `//`.
 *   - The Supabase host pattern requires at least eight `[a-z0-9-]` characters
 *     immediately before `.supabase.co`, which matches a real 20-character
 *     project ref while leaving the documentation placeholder
 *     `<project-ref>.supabase.co` alone — the `>` breaks the run.
 *
 * This is a prefix-and-shape check, not a secret scanner. The `secret-scan` CI
 * job runs gitleaks over the full history and the diff, and that is what covers
 * the classes a static selector cannot see. This rule exists to fail the build
 * at the moment the literal is typed, in the editor, before it is ever staged.
 */
const SECRET_LITERAL_SYNTAX = [
  // A JSON Web Token: every legacy Supabase anon and service-role key is one,
  // and `eyJ` is the base64url encoding of the opening `{"` of its header.
  ...stringPatternSelectors(
    "/eyJ[A-Za-z0-9_-]{8,}/",
    SECRET_LITERAL_MESSAGE,
  ),
  // The current Supabase key format, which is not a JWT and so is not caught
  // above. `sb_secret_` is the service-role successor; `sb_publishable_` is
  // public but still belongs in configuration rather than in source.
  ...stringPatternSelectors(
    "/sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/",
    SECRET_LITERAL_MESSAGE,
  ),
  // The Postgres role whose bearer bypasses every RLS policy in the schema.
  ...stringPatternSelectors("/service_role/i", SECRET_LITERAL_MESSAGE),
  // A Postgres connection string, which carries its own credentials inline.
  ...stringPatternSelectors(
    "/postgres(ql)?:\\x2f\\x2f/i",
    SECRET_LITERAL_MESSAGE,
  ),
  // A concrete Supabase project host. The project ref is not a secret on its
  // own, but hardcoding it defeats the environment contract and pins the
  // tooling to one project.
  ...stringPatternSelectors(
    "/[a-z0-9-]{8,}\\.supabase\\.(co|in)/i",
    SECRET_LITERAL_MESSAGE,
  ),
  // A PEM private key body, in case one is ever pasted in whole.
  ...stringPatternSelectors(
    "/-----BEGIN [A-Z ]*PRIVATE KEY-----/",
    SECRET_LITERAL_MESSAGE,
  ),
];

/**
 * Code-loading constructs that have no place in a program whose input is
 * untrusted content. The `eval` family is covered by the dedicated core rules
 * in the baseline block; these two cover what those rules do not.
 */
const DANGEROUS_SYNTAX = [
  { selector: 'CallExpression[callee.name="require"]', message: REQUIRE_MESSAGE },
  {
    selector: 'ImportExpression[source.type!="Literal"]',
    message: DYNAMIC_IMPORT_MESSAGE,
  },
];

/**
 * Compose a complete `no-restricted-syntax` setting from one or more selector
 * arrays.
 *
 * @param {...{selector: string, message: string}[]} selectorGroups
 * @returns {[string, ...{selector: string, message: string}[]]}
 */
const restrictSyntax = (...selectorGroups) => [
  "error",
  ...selectorGroups.flat(),
];

/* ==========================================================================
 * Configuration
 * ========================================================================== */

const config = tseslint.config(
  /**
   * Global ignores. A block carrying only `ignores` applies project-wide.
   *
   * `node_modules/**` is the only entry, and that is a decision rather than an
   * oversight. In particular:
   *
   *   - `tests/**` is NOT ignored. The unit tests cover link normalization, the
   *     11-pair FAQ split, the filename map's injectivity, deterministic child
   *     identity and the rich-text round trip — assertions about what the
   *     school's content becomes. A bug in a test is a false guarantee, so the
   *     tests are held to the same rules as the code they check.
   *   - No build or coverage directory is listed, because this project emits
   *     nothing: `tsconfig.json` sets `noEmit`, and the programs run through
   *     `tsx`. Adding speculative ignores would only hide output that, if it
   *     ever appeared, should be noticed.
   */
  { ignores: ["node_modules/**"] },

  // The 61-rule core `recommended` set. Carries no `files` key, so it applies
  // to every file ESLint lints here.
  js.configs.recommended,

  // The TypeScript layer: registers the parser and the `@typescript-eslint`
  // plugin, disables the core rules the compiler already enforces (`no-undef`
  // among them), and enables the type-aware recommended set — which is where
  // the whole `no-unsafe-*` family, `no-floating-promises`, `no-misused-promises`
  // and `await-thenable` come from. Those four matter as much as the unsafe
  // family in an async CLI: an unawaited upload or database write in
  // `upload-assets.ts` or `bootstrap-admins.ts` would let the process exit 0
  // having done only part of its work.
  //
  // Note that its `recommended-type-checked` block carries no `files` key
  // either, so its rules reach this configuration file too. That is precisely
  // why the `ces-tools/plain-javascript` block at the end of this array is
  // required rather than decorative.
  ...tseslint.configs.recommendedTypeChecked,

  /**
   * Project-wide baseline: language options for every file, plus the core rules
   * that hold everywhere.
   *
   * Deliberately carries no `files` key, so `languageOptions` — and above all
   * `parserOptions` — are global. Type-aware linting resolves against
   * `tools/tsconfig.json` through the TypeScript project service, which is
   * preferred over an explicit `project` array because it tracks the same file
   * set the compiler sees without a second list to keep in step.
   *
   * `tsconfig.json` includes exactly `src/**\/*.ts` and `tests/**\/*.ts`. A new
   * TypeScript file outside those two trees will fail to lint with a message
   * naming the project service, which is the correct and loud failure: add the
   * file to `include` rather than loosening anything here.
   */
  {
    name: "ces-tools/baseline",
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // Node globals only. This project reads the filesystem, spawns nothing
      // and never runs in a browser, so no browser global is declared — a
      // stray `window` or `document` reference should be an error, not a
      // silently-known name.
      //
      // `nodeBuiltin` rather than `node`: the latter also declares the CommonJS
      // wrapper names `require`, `module`, `exports` and `__dirname`, none of
      // which exist in an ESM package. Declaring them would contradict the
      // `require` ban below and let a genuine mistake pass `no-undef`.
      globals: { ...globals.nodeBuiltin },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // An `eslint-disable` that no longer suppresses anything is a comment
      // asserting a risk that has moved. Reporting it as an error keeps the
      // scoped disables this file asks for from rotting into noise — and under
      // `--max-warnings=0` the default `warn` would fail the build anyway, so
      // this states the intent instead of relying on the flag.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      /* -- Deliberately OFF. Both would be actively wrong here. ------------ */

      // These are command-line programs whose entire user interface is stdout
      // and stderr: progress lines, the per-file delta against the recorded
      // checksums, the parity report summary. `no-console` would be a rule
      // against the project working. Do not "fix" this.
      "no-console": "off",

      // The programs must exit non-zero on failure, and that is a specified
      // behaviour rather than a convenience: an unresolvable
      // `statamic://entry::<uuid>` link has to fail the extraction rather than
      // ship a dead scheme into production, and `verify-parity.ts` has to fail
      // the `db-and-parity` CI job. `process.exit(1)` is how a `tsx` script
      // does that.
      "no-process-exit": "off",

      /* -- Code loading ---------------------------------------------------- */

      // The input to these programs is untrusted content. Nothing derived from
      // it may become executable code.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": restrictSyntax(DANGEROUS_SYNTAX),

      /* -- Transformation-bug guards --------------------------------------- */

      // `null: "ignore"` is the one concession, and it is earned: the corpus
      // contains explicit YAML nulls — `programs_offered` is `null` on one page
      // and `colwidth` is an array, `null`, or an absent key — so `x == null`
      // as a deliberate "null or undefined" test is clearer than spelling both
      // out. Every other loose comparison is an error.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // `!!value`, `+value` and `"" + value` are exactly how a replicator set
      // of `type: "text"` gets confused with a ProseMirror `text` node: one
      // holds an array, the other a string, and both are truthy. Forcing the
      // explicit check makes the distinction visible at the call site.
      "no-implicit-coercion": "error",

      "prefer-const": ["error", { destructuring: "all" }],
      "no-var": "error",

      // `props: false` bans rebinding a parameter while still allowing
      // property mutation, so an accumulator threaded through a `reduce` — the
      // natural shape for building the filename map or the corpus census —
      // stays idiomatic. The banned half is the one that silently discards a
      // caller's value.
      "no-param-reassign": ["error", { props: false }],
    },
  },

  /**
   * TypeScript rules. Scoped to TypeScript files because several of them read
   * type information and none of them has anything to say about this
   * configuration file.
   */
  {
    name: "ces-tools/typescript",
    files: TYPESCRIPT_FILES,
    rules: {
      // Verified against the installed 8.47.0: `recommended-type-checked`
      // already turns the core rule off, while `eslint-recommended` — the block
      // that disables the core rules the compiler subsumes — pointedly does not
      // list it. Restating it here keeps the base-rule/extension-rule pairing
      // explicit at the point the extension is configured, so a preset change
      // cannot quietly leave both enabled and double-report every unused
      // symbol. The TypeScript rule understands type positions, generics and
      // overloads; the core rule does not.
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

      // Everything this project reads is untyped YAML or Markdown front matter,
      // so `any` is both the path of least resistance and the path by which a
      // content bug ships: it switches off every check below at the exact
      // boundary where the data is least trustworthy. `unknown` plus a
      // narrowing check is the required alternative, and `fixToUnknown` lets
      // `--fix` perform the first half of that conversion.
      //
      // A parse boundary that genuinely needs `any` takes a line-scoped
      // disable carrying a comment that says why.
      "@typescript-eslint/no-explicit-any": [
        "error",
        { fixToUnknown: true, ignoreRestArgs: false },
      ],

      // The five rules that actually force parsed YAML to be validated rather
      // than trusted. They arrive as errors from `recommendedTypeChecked`; they
      // are restated here so that switching one off is a visible edit to this
      // file rather than an invisible consequence of a preset change, and so
      // that the reason survives next to them.
      //
      // Making the first commit pass by blanket-disabling this family is the
      // single most likely shortcut in this project, and it would remove the
      // whole benefit of type-aware linting. Narrow the value instead.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // With `noUncheckedIndexedAccess` on, `nodes[0]!` is the tempting way to
      // silence the compiler — and a wrong non-null assertion on parsed content
      // is a content bug that throws at migration time or, worse, writes a
      // partial row. Write the guard.
      "@typescript-eslint/no-non-null-assertion": "error",

      // The renderer and the extractor dispatch on closed vocabularies: the
      // ProseMirror node types (`paragraph`, `heading`, `text`, `hardBreak`,
      // `bulletList`, `orderedList`, `listItem`, `blockquote`, and the table
      // family `table`, `tableRow`, `tableHeader`, `tableCell`) and the
      // replicator set kinds (`text`, `image`, `quote`, `movie`, `institution`,
      // `program`, `statistic`, `session`, `link`). An unhandled member does
      // not raise — it silently drops content, and all 50 table-family nodes in
      // the corpus live in one entry, so a missing `tableCell` case costs the
      // tuition page its entire fee schedule.
      //
      // `allowDefaultCaseForExhaustiveSwitch: false` keeps a `default` from
      // absorbing a newly-added member, and `requireDefaultForNonUnion: true`
      // means a switch over a plain `string` must still say what it does with
      // an unrecognized value.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],

      // `tsconfig.json` sets `verbatimModuleSyntax`, which emits imports as
      // written and therefore requires type-only imports to be marked as such.
      // These two rules keep that mechanical instead of leaving it to the
      // compiler error: `separate-type-imports` produces a top-level
      // `import type { … }`, and `no-import-type-side-effects` catches the
      // inline form that would otherwise leave a runtime import of a
      // types-only module behind.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: true,
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },

  /**
   * The secret-literal ban, applied to every source file except this one.
   *
   * The exemption is not a loophole, it is the only way the rule can exist: the
   * selectors above are themselves string literals containing `service_role`
   * and the JWT and Supabase host patterns, so a project-wide ban would flag
   * its own configuration on every run. Scoping the rule to the code it governs
   * keeps the selectors readable — the alternative is assembling every pattern
   * from concatenated fragments to hide it from itself.
   *
   * This file is not thereby unguarded: the `secret-scan` CI job runs gitleaks
   * over the full history and the diff, which covers this path and every other.
   *
   * `DANGEROUS_SYNTAX` is repeated rather than inherited because flat config
   * replaces rule options instead of merging them — omitting it here would
   * silently drop the `require` and dynamic-`import()` bans for every file this
   * block matches, which is every file that matters.
   */
  {
    name: "ces-tools/secret-literals",
    files: ALL_SOURCE_FILES,
    ignores: ["eslint.config.mjs"],
    rules: {
      "no-restricted-syntax": restrictSyntax(
        DANGEROUS_SYNTAX,
        SECRET_LITERAL_SYNTAX,
      ),
    },
  },

  /**
   * Plain JavaScript — in practice this file alone — opts out of type-aware
   * linting. Last in the array so it wins.
   *
   * This is required, not defensive. `tsconfig.json` includes only
   * `src/**\/*.ts` and `tests/**\/*.ts`, so `eslint.config.mjs` belongs to no
   * TypeScript project; with the project service enabled globally by the
   * baseline block, parsing it would fail outright. `disableTypeChecked` turns
   * the type-aware rules off *and* sets `project: false` and
   * `projectService: false`, which is the half that actually prevents the parse
   * error.
   *
   * It is the one scoped relaxation in this file, and it relaxes nothing that
   * applies: there is no `any`, no promise and no type import in a flat config
   * module. Every rule in the baseline block — the `eval` family, the `require`
   * ban, `eqeqeq`, `no-implicit-coercion`, `prefer-const`, `no-param-reassign`
   * — still holds here, and this file is linted on every CI run like any other.
   */
  {
    name: "ces-tools/plain-javascript",
    files: JAVASCRIPT_FILES,
    extends: [tseslint.configs.disableTypeChecked],
  },
);

export default config;
