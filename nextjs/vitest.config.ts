/**
 * Vitest configuration — the unit half of the test strategy.
 *
 * This file and `playwright.config.ts` together replace the deleted
 * `phpunit.xml`, which bootstrapped `vendor/autoload.php`, discovered
 * `*Test.php` under `./tests/Unit` and `./tests/Feature`, enabled coverage over
 * `./app`, and set `APP_ENV=testing` with array cache/mail/session drivers.
 * Only the *shape* of that file carries over: a directory-scoped discovery
 * contract. Its coverage block and its seven Laravel driver variables do not —
 * `./app` holds no PHP any more, and the CI `unit` job's gate is the assertion
 * list below, not a coverage percentage.
 *
 * The split is strict, and it is the reason this file is more opinionated than a
 * generated default would be:
 *
 *   - Vitest owns `tests/unit/**` — pure functions, schemas, renderers and
 *     source/CSS assertions that need no server and no database.
 *   - Playwright owns `tests/e2e/**` — every spec that needs a served build or a
 *     real Supabase stack. The legacy `tests/Feature/ExampleTest.php` (GET `/`,
 *     assert 200) belongs to that half, not this one.
 *
 * Consumed by `npm test` (`vitest run`), `npm run test:watch` and the CI `unit`
 * job, which runs `npx vitest run` from this directory.
 *
 * One expected notice, recorded so nobody "fixes" it destructively: Vite prints
 * a forward-compatibility warning that this config uses "ESM syntax in a file
 * loaded as CommonJS", because `package.json` has no `"type": "module"`. It is
 * triggered by the `import` statements themselves — verified by removing every
 * other ESM construct, after which the notice persists — so it is a property of
 * authoring a TypeScript ESM config in a CJS-typed package, not of anything
 * chosen below. It is informational, concerns a *planned* future default of
 * Vite's native config loader, and fails no gate. Do not answer it by adding
 * `"type": "module"` to `package.json`: a Next.js app is deliberately CJS-typed,
 * which is precisely why `postcss.config.mjs` and `eslint.config.mjs` carry the
 * `.mjs` extension instead.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The application root: the directory holding this file, i.e. `nextjs/`.
 *
 * Derived from `import.meta.url` rather than written as a literal so the value
 * cannot drift from the file's own location if the project root ever moves.
 * This is the single anchor for the `@` alias below.
 */
const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  /**
   * The JSX transform. Four unit specs render React trees
   * (`prose-renderer`, `prose-tables`, `date-picker`, `structured-data`), and
   * `@vitejs/plugin-react` is the manifest's declared owner of that transform
   * for Vitest. It pins the automatic runtime that `tsconfig.json`'s
   * `jsx: "react-jsx"` asks for, so `.tsx` specs need no `React` import and
   * behave identically whatever the ambient esbuild defaults happen to be.
   */
  plugins: [react()],

  resolve: {
    /**
     * Mirrors `"paths": { "@/*": ["./*"] }` in `tsconfig.json`. That entry has
     * no `baseUrl`, so TypeScript resolves it relative to the tsconfig's own
     * directory — which is exactly `projectRoot`. The two must agree: if they
     * diverge, `@/lib/...` imports typecheck and then fail to resolve at test
     * time, which reads as a missing module rather than a configuration bug.
     *
     * A bare `"@"` key is prefix-matched by Vite (an importer matches when it
     * equals the key or starts with the key plus a slash), so `@/lib/utils`
     * resolves while scoped package names such as `@testing-library/react` are
     * untouched.
     */
    alias: {
      "@": projectRoot,
    },
  },

  test: {
    /**
     * `jsdom@30.0.1` is the binding constraint on this project's Node floor
     * (`engines.node >= 22.22.2`, which is why `.nvmrc` reads `22.22.2`).
     *
     * A DOM is the right default because component specs outnumber the pure
     * ones. The specs that would rather have none — the cached-reader import
     * assertion and the token/contrast assertions, which only read files — are
     * unaffected by it, and any spec that genuinely needs a bare Node global
     * scope can opt out per file with a `// @vitest-environment node` docblock.
     * That docblock is the supported escape hatch; `environmentMatchGlobs` was
     * removed in Vitest 4 and is not reintroduced by any other means.
     */
    environment: "jsdom",

    /**
     * Enabled for two reasons, the second of which is load-bearing:
     *
     *   1. Specs may use `describe`/`it`/`expect` without importing them.
     *   2. `@testing-library/react@16` registers its automatic DOM cleanup only
     *      when a global `afterEach` exists. With globals on, that registration
     *      happens on import, so no `setupFiles` entry is needed — which
     *      matters because `tests/support/` deliberately contains no setup
     *      module (only `test-db.ts`, `test-admin.ts` and `fixtures/`), and
     *      pointing at a file that does not exist would fail every run.
     *
     * Note for spec authors: `tsconfig.json` has no `types` array, so the
     * `vitest/globals` type declarations are not in the type graph. Specs
     * should therefore `import { describe, it, expect } from "vitest"` to stay
     * green under `tsc --noEmit`; the globals remain available at runtime
     * regardless. Adding `types` to `tsconfig.json` is deliberately *not* the
     * fix — it would displace the automatically included `@types/node` and
     * `@types/react` and break the whole module's typecheck.
     */
    globals: true,

    /**
     * Narrowed to the unit directory. Vitest's default is
     * `['**\/*.{test,spec}.?(c|m)[jt]s?(x)']`, which would also match the
     * seventeen Playwright specs under `tests/e2e/`.
     *
     * `tests/unit/**` is authored as `*.test.ts` / `*.test.tsx`; `spec` is
     * accepted here too so a spec-named unit test is still collected rather
     * than silently ignored.
     */
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],

    /**
     * Setting `exclude` REPLACES Vitest's defaults, so the standard entries are
     * restated here rather than assumed. Two of these are the point of the
     * list:
     *
     *   - `tests/e2e/**` — the seventeen Playwright specs (`public-routes`,
     *     `security`, `edit-mode`, `upload`, `revisions`, the five `admin-*`,
     *     `maintenance`, `seo`, `responsive`, `visual`, `a11y`, `performance`,
     *     `analytics`) all `import { test, expect } from "@playwright/test"`.
     *     Collected by Vitest they fail with an import error that looks like a
     *     dependency problem, and their `test.describe` bodies would never run
     *     — a suite that appears to pass while testing nothing. Excluded here
     *     as well as absent from `include`, so neither a widened glob nor a
     *     `--dir` override can pull them in.
     *   - `tests/support/**` — the shared harness (`test-db.ts`,
     *     `test-admin.ts`, `fixtures/index.ts`). It exists to be imported, not
     *     run.
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".next/**",
      "out/**",
      "tests/e2e/**",
      "tests/support/**",
      "playwright-report/**",
      "blob-report/**",
      "test-results/**",
      "coverage/**",
      ".lighthouseci/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],

    /**
     * Child processes, one per test file, with isolation on.
     *
     * Both are Vitest 4 defaults and both are pinned anyway, because the
     * timezone contract depends on them rather than merely benefiting from
     * them. `tests/unit/timezone-runner-zones.test.ts` sets `process.env.TZ` to
     * `America/Los_Angeles` and to `Asia/Tokyo` to prove that an event date —
     * a zone-free Postgres `date` carried as an ISO `yyyy-MM-dd` string —
     * round-trips unchanged, plus both DST boundaries. A per-file `TZ` mutation
     * is only containable when each file owns its own process: under the
     * `threads` pool the assignment leaks across workers and does not reliably
     * re-arm the date formatter. A silent default change would turn those
     * assertions into false passes, so the values are stated explicitly.
     *
     * No `TZ` is set here, deliberately. Pinning one is the obvious hardening
     * instinct and it is wrong: it would defeat the specs whose whole purpose
     * is to vary the runner's zone. The content timezone contract
     * (`America/New_York`) belongs to `lib/timezone.ts`, which applies it
     * explicitly and must not depend on the ambient zone of whatever machine
     * runs the tests.
     */
    pool: "forks",
    isolate: true,

    /**
     * A green run over zero tests is the worst outcome available to this
     * config: the CI `unit` gate would report success while asserting nothing.
     * `false` is today's default; pinning it makes the guarantee a property of
     * this file, so an empty collection fails loudly instead of passing.
     */
    passWithNoTests: false,

    /**
     * Per-test hygiene, so ordering can never leak state between specs. This
     * matters most to `env.test.ts` and `content-source.test.ts`, which stub
     * `CSP_MODE`, `HSTS_MAX_AGE` and `CONTENT_SOURCE` to assert that an
     * out-of-enumeration value fails validation at import and that the source
     * adapter stays on fallback.
     */
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,

    /**
     * A unit test may read from disk: the cached-reader assertion walks
     * `lib/content/cached/**` looking for a forbidden `next/headers`,
     * `lib/supabase/server`, `lib/supabase/client` or `lib/supabase/admin`
     * import, and the token/contrast assertions parse `app/globals.css`.
     * Nothing here restricts `fs`, and nothing should be added that does.
     *
     * Four further omissions are intentional:
     *
     *   - No coverage block. `@vitest/coverage-v8` is not in the pinned
     *     dependency set, so coverage cannot run; configuring reporters for an
     *     absent provider would only fail when someone passed `--coverage`.
     *     The `unit` gate is the assertion list, not a percentage, and a
     *     threshold nobody specified would be an invented gate.
     *   - No `SUPABASE_*` environment and no `ANALYTICS_DISABLED`. Unit tests
     *     must not need a database, and that flag governs the served-build jobs
     *     (`lighthouse`, the route sweep) rather than this one.
     *   - No `setupFiles`, for the reason given under `globals` above.
     *   - No `deps.inline`. Nothing in the pinned dependency set has an
     *     ESM/CJS interop failure that needs one.
     */
  },
});
