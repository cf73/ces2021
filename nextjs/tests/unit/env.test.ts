/**
 * `lib/env` — the environment contract.
 *
 * Subject area 7 of the ten that make up `tests/unit/**`. Module under test:
 * `lib/env.ts`, the only module in the repository that reads `process.env`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SPEC EXISTS
 * ---------------------------------------------------------------------------
 *
 * Three clauses of the specification meet in this one module, and each one is
 * the reason for a group of assertions below.
 *
 *   §0.9.2 — the environment contract, key by key, including which keys are
 *            server-only. Requirement 14 ("I will add keys for access after
 *            project completion") makes it load-bearing rather than tidy: the
 *            Vercel build and the public render must BOTH succeed with no
 *            Supabase variables present at all, which is what the CI
 *            `build-no-env` job proves at the build level and what the keyless
 *            group below proves at the module level.
 *
 *   §0.7.5 — the staged-policy contract: `CSP_MODE` and `HSTS_MAX_AGE` are
 *            CLOSED enumerations with safe defaults, and "tests pin all four
 *            states". An out-of-enumeration value must fail validation rather
 *            than reach a response, and the HSTS enumeration must admit no
 *            value carrying `includeSubDomains` or `preload`.
 *
 *   §0.6.6 — "env schema" is a named member of the `unit` job's assertion set.
 *            That job has no `needs`, starts no service and opens no browser,
 *            so nothing here may touch Supabase, an account or the filesystem
 *            beyond reading two committed text files.
 *
 * The central property is inherited from a specific defect the migration was
 * told to correct: the reference implementation this project was pointed at
 * read two variables at module scope and called `throw new Error(...)` when
 * either was missing, which under this project's constraints crashes the build.
 * So the through-line of this file is FAILS SOFT, NEVER THROWS.
 *
 * ---------------------------------------------------------------------------
 * TWO TECHNIQUES, AND WHY EACH IS THE RIGHT ONE
 * ---------------------------------------------------------------------------
 *
 * 1. `loadEnv()` — stub, reset, dynamic import. The module memoizes each scope
 *    on first read, so the environment has to be established BEFORE the module
 *    is evaluated. Every case therefore stubs all twelve names, clears the
 *    module registry and imports fresh, which also makes each case independent
 *    of whatever the runner's ambient environment happens to hold.
 *
 *    `vi.stubEnv` is the only mechanism used. Boundary §0.6.5 states that no
 *    module outside `@/lib/env` references `process.env`; `tests/**` is in fact
 *    exempted by `eslint.config.mjs` (it has to be, for the harness that reads
 *    the local Supabase keys), but the boundary is honoured here anyway because
 *    a spec that reaches around the mechanism it is testing is a spec that can
 *    leak into its neighbours.
 *
 * 2. Static inspection of the two committed files. Two obligations cannot be
 *    observed by importing anything — that `lib/env.ts` stays loadable from a
 *    plain Node config context, and that `.env.example` documents the same key
 *    set the module implements. Both are read from disk and asserted against
 *    their text. Where that is done, the instrument is verified first: the
 *    comment stripper is proved to have removed something before its silence is
 *    treated as evidence, because every occurrence of `throw`, `server-only`,
 *    `next/headers` and `ADMIN_EMAILS` in `lib/env.ts` today sits inside a
 *    comment, and a naive text search would report four false failures.
 *
 * Runner notes. `vitest.config.ts` is owned elsewhere and is not edited by this
 * file. It enables `globals: true`, but `tsconfig.json` carries no `types`
 * array, so `vitest/globals` is outside the type graph and every helper is
 * imported explicitly to stay green under `tsc --noEmit`. It also sets
 * `unstubEnvs` and `restoreMocks`; the explicit `afterEach` below is kept
 * regardless, so this file does not depend on a neighbour's configuration for
 * its own isolation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvIssue, EnvVariableName } from "@/lib/env";

/** The module's own type, for the dynamically imported instances below. */
type EnvModule = typeof import("@/lib/env");

/** The overrides a case applies on top of the fully cleared environment. */
type EnvOverrides = Partial<Record<EnvVariableName, string>>;

/**
 * Every name the application reads, browser-safe scope first.
 *
 * `satisfies` ties the list to the module's own `EnvVariableName` union at
 * compile time, so a name removed there fails `tsc` here rather than silently
 * leaving a case stubbing nothing. The reverse direction — a name ADDED to the
 * module but missing from this list — is caught at runtime by the scope group,
 * which asserts this list equals the union of the two schema shapes.
 */
const ENV_VARIABLE_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "VERCEL_URL",
  "CONTENT_SOURCE",
  "SUPABASE_SECRET_KEY",
  "REVALIDATE_SECRET",
  "CRON_SECRET",
  "ANALYTICS_DISABLED",
  "CSP_MODE",
  "HSTS_MAX_AGE",
] as const satisfies readonly EnvVariableName[];

/** The ten keys `.env.example` carries as active assignments. */
const DOCUMENTED_KEYS = [
  "CONTENT_SOURCE",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "REVALIDATE_SECRET",
  "CRON_SECRET",
  "ANALYTICS_DISABLED",
  "CSP_MODE",
  "HSTS_MAX_AGE",
] as const satisfies readonly EnvVariableName[];

/** The three keys that must never be reachable from a browser bundle. */
const SERVER_ONLY_CREDENTIALS = [
  "SUPABASE_SECRET_KEY",
  "REVALIDATE_SECRET",
  "CRON_SECRET",
] as const satisfies readonly EnvVariableName[];

/**
 * Legacy Laravel and Statamic variable names.
 *
 * Taken from the files this migration read and retired: `config/app.php`
 * (`APP_NAME`, `APP_ENV`, `APP_DEBUG`, `APP_URL`), `config/statamic/git.php`
 * (the `STATAMIC_GIT_*` family) and `config/statamic/editions.php`, whose
 * `pro: true` is what made `STATAMIC_LICENSE_KEY` apply at all. No PHP executes
 * after the migration, so none of these may survive as a target key — and the
 * Git flags in particular are not merely unused, since their capability moved
 * into the database as an append-only revision trail.
 */
const RETIRED_LEGACY_KEYS = [
  "APP_NAME",
  "APP_ENV",
  "APP_DEBUG",
  "APP_KEY",
  "APP_URL",
  "DB_CONNECTION",
  "DB_DATABASE",
  "CP_ENABLED",
  "CP_ROUTE",
  "STATAMIC_LICENSE_KEY",
  "STATAMIC_GIT_ENABLED",
  "STATAMIC_GIT_AUTOMATIC",
  "STATAMIC_GIT_PUSH",
  "STATAMIC_GIT_DISPATCH_DELAY",
] as const;

/**
 * The analytics identifiers, with their real values.
 *
 * They are CONTENT, owned by `site_globals` and present in the fallback JSON,
 * which is exactly what lets them work in the keyless state and lets staff edit
 * them without a redeploy. `ANALYTICS_DISABLED` gates whether the tags render;
 * it does not carry what they report to. Their presence as an environment
 * variable — or as a literal in either file — would undo that.
 */
const ANALYTICS_IDENTIFIER_VALUES = [
  "AW-11332213588",
  "12673899",
  "24719029",
] as const;

/** Key-name fragments that would signal an analytics identifier variable. */
const ANALYTICS_IDENTIFIER_FRAGMENTS = [
  "STATCOUNTER",
  "GTAG",
  "GTM",
  "GOOGLE",
  "ADS_ID",
  "TRACKING_ID",
  "MEASUREMENT_ID",
] as const;

/* ==========================================================================
 * Helpers
 * ========================================================================== */

/**
 * Clears all twelve names, applies `overrides`, then imports a fresh instance.
 *
 * Clearing first is what makes a case deterministic: the runner's own
 * environment is not guaranteed to be free of `VERCEL_URL` or `CONTENT_SOURCE`,
 * and a case that only sets what it cares about would silently inherit the rest.
 */
async function loadEnv(overrides: EnvOverrides = {}): Promise<EnvModule> {
  for (const name of ENV_VARIABLE_NAMES) {
    vi.stubEnv(name, undefined);
  }

  for (const name of Object.keys(overrides) as readonly EnvVariableName[]) {
    const value = overrides[name];
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }

  vi.resetModules();
  return import("@/lib/env");
}

/**
 * The single typed issue recorded for `variable`, failing with a diagnostic
 * that names the variable when there is none.
 *
 * Asserting on a found-or-undefined value would let a missing issue pass as
 * `undefined === undefined` further down; this fails at the point the
 * expectation was actually violated.
 */
function requireIssue(
  issues: readonly EnvIssue[],
  variable: EnvVariableName,
): EnvIssue {
  const matches = issues.filter((issue) => issue.variable === variable);

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one recorded EnvIssue for ${variable}, found ` +
        `${String(matches.length)}. Recorded issues: ` +
        `${issues.map((issue) => issue.variable).join(", ") || "(none)"}. ` +
        `An out-of-enumeration or malformed value must be recorded as a typed ` +
        `issue by lib/env.ts (specification §0.7.5), never swallowed and never ` +
        `thrown.`,
    );
  }

  const [issue] = matches;
  return issue;
}

/**
 * Reads a committed file from the `nextjs/` root, failing with a diagnostic
 * that names the file and its owner rather than skipping.
 *
 * A spec that skips when an artifact is missing reports success for work nobody
 * did. The path is resolved from `import.meta.url` so it cannot drift if this
 * directory moves, and it is a URL rather than an import specifier, so the
 * project's ban on import specifiers climbing two levels does not apply.
 */
function readProjectFile(relativePath: string, owner: string): string {
  const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));

  try {
    return readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new Error(
      `Could not read ${relativePath} (resolved to ${absolutePath}), which is ` +
        `required by tests/unit/env.test.ts. That file is owned by ${owner}. ` +
        `This is a hard failure rather than a skipped assertion: the ` +
        `environment contract in specification §0.9.2 is only verifiable ` +
        `against it. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Removes comments while preserving string and template literals.
 *
 * The literals are matched FIRST and returned untouched, which is the whole
 * point: a genuine `import "server-only"` keeps its specifier and is still
 * caught, while the seven places `lib/env.ts` mentions `server-only` in prose
 * disappear. Without this, the boundary assertions below would report failures
 * against a module that is entirely correct.
 */
function stripComments(source: string): string {
  const literalOrComment =
    /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\[\s\S]|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

  return source.replace(
    literalOrComment,
    (
      _match,
      doubleQuoted?: string,
      singleQuoted?: string,
      templated?: string,
    ) => doubleQuoted ?? singleQuoted ?? templated ?? "",
  );
}

/**
 * The literal members of a `z.enum([...]).default(...)` field on an exported
 * schema.
 *
 * `unwrap()` is Zod's public accessor for stepping past the `.default(...)`
 * wrapper, and `options` is the enum's public member list — so the closed
 * enumerations are read off the module's own declaration rather than restated
 * here. That is the difference between asserting the contract and asserting a
 * copy of it: if somebody widens `HSTS_MAX_AGE` to admit a third value, this
 * fails, which is precisely the reviewed change §0.7.5 requires it to be.
 *
 * Typed structurally rather than against `z.ZodDefault<z.ZodEnum<…>>` so the
 * helper serves all three enumerations without importing Zod's generics into a
 * spec that has no other use for them.
 */
function enumOptions(field: {
  unwrap: () => { readonly options: readonly string[] };
}): readonly string[] {
  return field.unwrap().options;
}

/** Every module specifier imported by a source file, in source order. */
function importedSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const importPattern = /\bimport\b[^;'"]*?["']([^"']+)["']/g;

  for (const match of source.matchAll(importPattern)) {
    const [, specifier] = match;
    specifiers.push(specifier);
  }

  return specifiers;
}

/**
 * The active `KEY=` assignments in a dotenv-style template, in file order.
 *
 * Deliberately a regex rather than a parser: `dotenv` is not in the pinned
 * dependency set, and adding a dependency to read ten lines would be the wrong
 * trade. Commented lines are excluded, which matters because `.env.example`
 * documents both a key alias and its own deliberately-absent list in comments —
 * so a raw text search would contradict the very thing those comments say.
 */
function activeEnvKeys(template: string): readonly string[] {
  const keys: string[] = [];

  for (const line of templateLines(template)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match !== null) {
      const [, key] = match;
      keys.push(key);
    }
  }

  return keys;
}

/** The verbatim value assigned to `key`, or `undefined` when it is not active. */
function activeEnvValue(template: string, key: string): string | undefined {
  for (const line of templateLines(template)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1);
    }
  }

  return undefined;
}

/**
 * The template's lines, with any carriage return removed.
 *
 * The committed file uses LF, and `.gitattributes` is the reason it should stay
 * that way — but a checkout on a machine configured otherwise would leave a
 * trailing `\r` on every line, which would turn "ships empty" into "ships
 * `\r`" and fail a correct template. Stripping it here keeps the assertions
 * about the contract rather than about line endings.
 */
function templateLines(template: string): readonly string[] {
  return template.split("\n").map((line) => line.replace(/\r$/, ""));
}

const ENV_MODULE_OWNER = "the nextjs root agent (lib/env.ts)";
const ENV_TEMPLATE_OWNER = "the nextjs root agent (.env.example)";

const envModuleSource = readProjectFile("../../lib/env.ts", ENV_MODULE_OWNER);
const envModuleCode = stripComments(envModuleSource);
const envTemplate = readProjectFile("../../.env.example", ENV_TEMPLATE_OWNER);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/* ==========================================================================
 * The keyless state — specification §0.9.2 and requirement 14
 * ========================================================================== */

describe("lib/env in the keyless state", () => {
  it("imports without throwing when no variable is set at all", async () => {
    // The single most important assertion in this file. The reference
    // implementation threw at module scope on a missing variable; here the
    // absence of every variable is a supported, documented state, and the
    // `build-no-env` CI job depends on it holding.
    await expect(loadEnv()).resolves.toBeDefined();
  });

  it("reports no Supabase configuration rather than inventing one", async () => {
    const env = await loadEnv();

    expect(env.getSupabaseUrl()).toBeUndefined();
    expect(env.getSupabasePublishableKey()).toBeUndefined();
    expect(env.getSupabaseProjectHost()).toBeUndefined();
    expect(env.isSupabaseConfigured()).toBe(false);
  });

  it("withholds every server-only credential", async () => {
    const env = await loadEnv();

    expect(env.getSupabaseSecretKey()).toBeUndefined();
    expect(env.getRevalidateSecret()).toBeUndefined();
    expect(env.getCronSecret()).toBeUndefined();
  });

  it("resolves every default to the safe end of its range", async () => {
    const env = await loadEnv();

    expect(env.getContentSource()).toBe("fallback");
    expect(env.isSupabaseContentSourceRequested()).toBe(false);
    expect(env.isAnalyticsDisabled()).toBe(false);
    expect(env.getCspMode()).toBe("report-only");
    expect(env.getHstsMaxAge()).toBe("300");
    expect(env.getHstsMaxAgeSeconds()).toBe(300);
    expect(env.getSiteUrl()).toBe("http://localhost:3000");
  });

  it("records no issue, because absent is not invalid", async () => {
    const env = await loadEnv();

    expect(env.getEnvIssues()).toEqual([]);
    expect(env.isEnvValid()).toBe(true);
  });

  it("treats a verbatim copy of .env.example as the keyless state", async () => {
    // `.env.example` ships every credential and URL key EMPTY. A developer who
    // copies it unedited must land in the keyless state with zero issues — if
    // an empty string counted as a present-but-invalid value, a clean install
    // would log four failures on its first run.
    const asShipped: EnvOverrides = {};
    for (const key of DOCUMENTED_KEYS) {
      asShipped[key] = activeEnvValue(envTemplate, key) ?? "";
    }

    const env = await loadEnv(asShipped);

    expect(env.getEnvIssues()).toEqual([]);
    expect(env.isEnvValid()).toBe(true);
    expect(env.getContentSource()).toBe("fallback");
    expect(env.getCspMode()).toBe("report-only");
    expect(env.getHstsMaxAge()).toBe("300");
  });

  it("treats whitespace as absent rather than as a value", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "   ",
      SUPABASE_SECRET_KEY: "\t",
      CSP_MODE: " ",
    });

    expect(env.getSupabaseUrl()).toBeUndefined();
    expect(env.getSupabaseSecretKey()).toBeUndefined();
    expect(env.getCspMode()).toBe("report-only");
    expect(env.getEnvIssues()).toEqual([]);
  });
});

/* ==========================================================================
 * CSP_MODE — a closed enumeration, specification §0.7.5
 * ========================================================================== */

describe("CSP_MODE", () => {
  it("defaults to report-only when absent", async () => {
    const env = await loadEnv();

    expect(env.getCspMode()).toBe("report-only");
  });

  it("resolves report-only verbatim", async () => {
    const env = await loadEnv({ CSP_MODE: "report-only" });

    expect(env.getCspMode()).toBe("report-only");
    expect(env.isEnvValid()).toBe(true);
  });

  it("resolves enforce verbatim", async () => {
    const env = await loadEnv({ CSP_MODE: "enforce" });

    expect(env.getCspMode()).toBe("enforce");
    expect(env.isEnvValid()).toBe(true);
  });

  it("admits exactly two members", async () => {
    // Read off the exported schema rather than restated, so widening the
    // enumeration cannot leave this file agreeing with itself while the module
    // has moved.
    const env = await loadEnv();
    const options = enumOptions(env.serverEnvSchema.shape.CSP_MODE);

    expect(options).toEqual(["report-only", "enforce"]);
    expect(options).toHaveLength(2);
  });

  it("refuses a plausible typo and applies the safe default instead", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const env = await loadEnv({ CSP_MODE: "enforcing" });

    // The behaviour the implementation actually has, and the behaviour §0.7.5
    // asks for: the value does not reach a response. It is not thrown, because
    // a throw here would take down a deployment over a header name; it is
    // recorded as a typed issue and logged loudly, and the header falls back to
    // the safe end of the range.
    expect(env.getCspMode()).toBe("report-only");

    const issue = requireIssue(env.getEnvIssues(), "CSP_MODE");
    expect(issue.scope).toBe("server");
    expect(issue.message).toContain("report-only");
    expect(issue.message).toContain("enforce");
    expect(issue.appliedFallback).toBe(JSON.stringify("report-only"));
    expect(env.isEnvValid()).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it("refuses every value outside the enumeration", async () => {
    // Case sensitivity is deliberate and worth pinning: unlike
    // `ANALYTICS_DISABLED`, this variable is compared exactly, so `ENFORCE` is
    // a misconfiguration rather than a synonym.
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (const value of [
      "ENFORCE",
      "Report-Only",
      "report only",
      "true",
      "1",
      "enforce;",
      "report-only enforce",
    ]) {
      const env = await loadEnv({ CSP_MODE: value });

      expect(env.getCspMode(), `CSP_MODE=${value} must not be accepted`).toBe(
        "report-only",
      );
      expect(
        env.isEnvValid(),
        `CSP_MODE=${value} must be recorded as an issue`,
      ).toBe(false);
    }
  });
});

/* ==========================================================================
 * HSTS_MAX_AGE — a closed enumeration, specification §0.7.5
 * ========================================================================== */

describe("HSTS_MAX_AGE", () => {
  it("defaults to 300 seconds when absent", async () => {
    const env = await loadEnv();

    expect(env.getHstsMaxAge()).toBe("300");
    expect(env.getHstsMaxAgeSeconds()).toBe(300);
  });

  it("resolves the five-minute value verbatim", async () => {
    const env = await loadEnv({ HSTS_MAX_AGE: "300" });

    expect(env.getHstsMaxAge()).toBe("300");
    expect(env.getHstsMaxAgeSeconds()).toBe(300);
    expect(env.isEnvValid()).toBe(true);
  });

  it("resolves the one-year value verbatim", async () => {
    const env = await loadEnv({ HSTS_MAX_AGE: "31536000" });

    expect(env.getHstsMaxAge()).toBe("31536000");
    expect(env.getHstsMaxAgeSeconds()).toBe(31536000);
    expect(env.isEnvValid()).toBe(true);
  });

  it("admits exactly two members, and they are the two documented seconds", async () => {
    const env = await loadEnv();
    const options = enumOptions(env.serverEnvSchema.shape.HSTS_MAX_AGE);

    expect(options).toEqual(["300", "31536000"]);
    expect(options).toHaveLength(2);
  });

  it("admits no value carrying includeSubDomains or preload", async () => {
    // This is the reason the enumeration is closed rather than an integer
    // check. Both directives are effectively irreversible and stay unavailable
    // until a subdomain audit passes and the school signs off, so the schema
    // must not be able to express them at all — `proxy.ts` emits
    // `max-age=<value>` and has nothing else to concatenate.
    const env = await loadEnv();
    const options = enumOptions(env.serverEnvSchema.shape.HSTS_MAX_AGE);

    for (const option of options) {
      expect(option, "every admitted value is bare seconds").toMatch(/^\d+$/);
    }

    expect(options.join(" ")).not.toMatch(/includeSubDomains/i);
    expect(options.join(" ")).not.toMatch(/preload/i);
  });

  it("refuses a directive-bearing value and applies the safe default", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const env = await loadEnv({
      HSTS_MAX_AGE: "31536000; includeSubDomains; preload",
    });

    expect(env.getHstsMaxAge()).toBe("300");
    expect(env.getHstsMaxAgeSeconds()).toBe(300);

    const issue = requireIssue(env.getEnvIssues(), "HSTS_MAX_AGE");
    expect(issue.scope).toBe("server");
    expect(issue.appliedFallback).toBe(JSON.stringify("300"));
    expect(env.isEnvValid()).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it("refuses any other max-age, however reasonable it looks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (const value of ["63072000", "86400", "0", "15768000", "31536001"]) {
      const env = await loadEnv({ HSTS_MAX_AGE: value });

      expect(
        env.getHstsMaxAge(),
        `HSTS_MAX_AGE=${value} must not be accepted`,
      ).toBe("300");
      expect(
        env.isEnvValid(),
        `HSTS_MAX_AGE=${value} must be recorded as an issue`,
      ).toBe(false);
    }
  });
});

/* ==========================================================================
 * The two policy defaults together
 * ========================================================================== */

describe("the staged-policy defaults", () => {
  it("lands a Vercel project with neither variable set on report-only and 300", async () => {
    // Stated as its own case because this pair IS the deployed state whenever
    // the two variables are missing from the project, and because the pair is
    // what the promotion procedure in §0.7.5 moves away from one step at a
    // time. Neither default may be an unintended enforcing policy or a
    // year-long HTTPS commitment.
    const env = await loadEnv();

    expect(env.getCspMode()).toBe("report-only");
    expect(env.getHstsMaxAge()).toBe("300");
    expect(env.isEnvValid()).toBe(true);
  });

  it("keeps one bad value from degrading the other", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await loadEnv({
      CSP_MODE: "enforcing",
      HSTS_MAX_AGE: "31536000",
    });

    // Resolution is per key. A typo in the CSP header name must not silently
    // reset an HSTS value the operator deliberately raised, and it must not
    // take the whole environment down either.
    expect(env.getCspMode()).toBe("report-only");
    expect(env.getHstsMaxAge()).toBe("31536000");
    expect(env.getEnvIssues()).toHaveLength(1);
  });
});

/* ==========================================================================
 * CONTENT_SOURCE — the adapter switch and the rollback lever
 * ========================================================================== */

describe("CONTENT_SOURCE", () => {
  it("defaults to fallback when absent", async () => {
    const env = await loadEnv();

    expect(env.getContentSource()).toBe("fallback");
  });

  it("accepts both documented backends", async () => {
    const fallback = await loadEnv({ CONTENT_SOURCE: "fallback" });
    expect(fallback.getContentSource()).toBe("fallback");

    const supabase = await loadEnv({ CONTENT_SOURCE: "supabase" });
    expect(supabase.getContentSource()).toBe("supabase");
  });

  it("admits exactly the two documented backends", async () => {
    const env = await loadEnv();

    expect(enumOptions(env.serverEnvSchema.shape.CONTENT_SOURCE)).toEqual([
      "fallback",
      "supabase",
    ]);
  });

  it("falls back rather than guessing at an unrecognised backend", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await loadEnv({ CONTENT_SOURCE: "postgres" });

    expect(env.getContentSource()).toBe("fallback");
    expect(requireIssue(env.getEnvIssues(), "CONTENT_SOURCE").scope).toBe(
      "server",
    );
  });

  it("separates requested from ready", async () => {
    // Requesting Supabase without credentials must not be reported as usable.
    // The distinction is the whole reason the accessor is named "requested":
    // keys can arrive before the schema is pushed and the seed loaded, so even
    // a true answer here is only a necessary condition, with the readiness row
    // checked by the source adapter.
    const requestedWithoutKeys = await loadEnv({ CONTENT_SOURCE: "supabase" });

    expect(requestedWithoutKeys.getContentSource()).toBe("supabase");
    expect(requestedWithoutKeys.isSupabaseConfigured()).toBe(false);
    expect(requestedWithoutKeys.isSupabaseContentSourceRequested()).toBe(false);

    const requestedWithKeys = await loadEnv({
      CONTENT_SOURCE: "supabase",
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb-publishable-test-value",
    });

    expect(requestedWithKeys.isSupabaseContentSourceRequested()).toBe(true);
  });

  it("does not request Supabase merely because credentials exist", async () => {
    // The correction of a presence check standing in for a decision: keys
    // present with the switch unset must leave the site on the committed
    // fallback JSON, which is also what makes the one-variable rollback real.
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb-publishable-test-value",
    });

    expect(env.isSupabaseConfigured()).toBe(true);
    expect(env.getContentSource()).toBe("fallback");
    expect(env.isSupabaseContentSourceRequested()).toBe(false);
  });
});

/* ==========================================================================
 * The publishable key and its predecessor name
 * ========================================================================== */

describe("the Supabase publishable key", () => {
  it("resolves the current name", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb-publishable-current",
    });

    expect(env.getSupabasePublishableKey()).toBe("sb-publishable-current");
  });

  it("also accepts the predecessor name", async () => {
    // An existing deployment must not have to be renamed to keep working, and
    // no consumer should have to know both names exist.
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb-anon-predecessor",
    });

    expect(env.getSupabasePublishableKey()).toBe("sb-anon-predecessor");
  });

  it("prefers the current name when both are present", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb-publishable-current",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb-anon-predecessor",
    });

    expect(env.getSupabasePublishableKey()).toBe("sb-publishable-current");
  });

  it("returns undefined when neither is present", async () => {
    const env = await loadEnv();

    expect(env.getSupabasePublishableKey()).toBeUndefined();
  });

  it("never echoes a credential into a diagnostic", async () => {
    // An issue message is written to the log and can surface on an admin
    // screen, so a rejected credential must be described rather than quoted.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await loadEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: " " });

    // A blank value is ABSENT, not invalid, so nothing is recorded at all.
    expect(env.getEnvIssues()).toEqual([]);

    const invalid = await loadEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" });
    const issue = requireIssue(
      invalid.getEnvIssues(),
      "NEXT_PUBLIC_SUPABASE_URL",
    );

    expect(issue.scope).toBe("public");
    expect(issue.message).not.toContain("not-a-url");
    expect(issue.appliedFallback).toBe("unset");
    expect(invalid.getSupabaseUrl()).toBeUndefined();
    expect(invalid.isSupabaseConfigured()).toBe(false);
  });
});

/* ==========================================================================
 * The Supabase URL and the project host
 * ========================================================================== */

describe("the Supabase URL", () => {
  it("strips a trailing slash so joined paths cannot double up", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co/",
    });

    expect(env.getSupabaseUrl()).toBe("https://project-ref.supabase.co");
  });

  it("exposes the exact project host, never a wildcard", async () => {
    // `next.config.ts` builds the image optimizer's `remotePatterns` from this
    // and `proxy.ts` builds `connect-src` and `img-src` from it. A
    // `**.supabase.co` wildcard would let the optimizer fetch from any Supabase
    // tenant on the internet, which is the reference implementation's mistake.
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
    });

    expect(env.getSupabaseProjectHost()).toBe("project-ref.supabase.co");
  });

  it("keeps the port, so the local stack is addressable", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    });

    expect(env.getSupabaseProjectHost()).toBe("127.0.0.1:54321");
  });

  it("omits the host rather than guessing one when the URL is absent", async () => {
    const env = await loadEnv();

    expect(env.getSupabaseProjectHost()).toBeUndefined();
  });

  it("rejects a scheme that has no business in a fetched URL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://project-ref.supabase.co",
      "//project-ref.supabase.co",
      "project-ref.supabase.co",
    ]) {
      const env = await loadEnv({ NEXT_PUBLIC_SUPABASE_URL: value });

      expect(
        env.getSupabaseUrl(),
        `NEXT_PUBLIC_SUPABASE_URL=${value} must not be accepted`,
      ).toBeUndefined();
      expect(env.getSupabaseProjectHost()).toBeUndefined();
    }
  });
});

/* ==========================================================================
 * NEXT_PUBLIC_SITE_URL — a three-tier chain that always answers
 * ========================================================================== */

describe("the site URL", () => {
  it("uses the configured canonical host first", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SITE_URL: "https://www.cambridge-ellis.org",
    });

    expect(env.getSiteUrl()).toBe("https://www.cambridge-ellis.org");
  });

  it("strips a trailing slash from the configured host", async () => {
    // Canonical tags, the sitemap, Open Graph URLs and the auth callback are
    // all built by joining a path onto this, so a trailing slash would produce
    // a second, duplicate URL for every page.
    const env = await loadEnv({
      NEXT_PUBLIC_SITE_URL: "https://cambridge-ellis.org/",
    });

    expect(env.getSiteUrl()).toBe("https://cambridge-ellis.org");
  });

  it("composes an absolute https URL from the platform's bare host", async () => {
    const env = await loadEnv({ VERCEL_URL: "ces-abc123.vercel.app" });

    expect(env.getSiteUrl()).toBe("https://ces-abc123.vercel.app");
  });

  it("prefers the configured host over the platform's", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SITE_URL: "https://www.cambridge-ellis.org",
      VERCEL_URL: "ces-abc123.vercel.app",
    });

    expect(env.getSiteUrl()).toBe("https://www.cambridge-ellis.org");
  });

  it("falls back to localhost when neither is set", async () => {
    const env = await loadEnv();

    expect(env.getSiteUrl()).toBe("http://localhost:3000");
  });

  it("never lets a malformed value reach a canonical tag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await loadEnv({ NEXT_PUBLIC_SITE_URL: "cambridge-ellis.org" });

    // Degrades down the chain instead of emitting a relative or unparseable
    // canonical URL, and records why.
    expect(env.getSiteUrl()).toBe("http://localhost:3000");
    requireIssue(env.getEnvIssues(), "NEXT_PUBLIC_SITE_URL");
  });

  it("always returns an absolute, parseable URL", async () => {
    for (const overrides of [
      {},
      { VERCEL_URL: "ces-abc123.vercel.app" },
      { NEXT_PUBLIC_SITE_URL: "https://cambridge-ellis.org/" },
    ] satisfies readonly EnvOverrides[]) {
      const env = await loadEnv(overrides);
      const resolved = env.getSiteUrl();

      expect(() => new URL(resolved)).not.toThrow();
      expect(resolved).not.toMatch(/\/$/);
    }
  });
});

/* ==========================================================================
 * ANALYTICS_DISABLED
 * ========================================================================== */

describe("ANALYTICS_DISABLED", () => {
  it("leaves the tags rendering when unset, which is the production setting", async () => {
    const env = await loadEnv();

    expect(env.isAnalyticsDisabled()).toBe(false);
  });

  it("suppresses both vendor tags for the exact string true", async () => {
    // §0.6.6 requires every CI run except the one `analytics` job to suppress
    // the tags, so the route sweep and the Lighthouse runs cannot fill the
    // school's real reporting with synthetic pageviews.
    const env = await loadEnv({ ANALYTICS_DISABLED: "true" });

    expect(env.isAnalyticsDisabled()).toBe(true);
  });

  it("resolves to a boolean, never to the raw string", async () => {
    const env = await loadEnv({ ANALYTICS_DISABLED: "true" });

    expect(typeof env.isAnalyticsDisabled()).toBe("boolean");
  });

  it("accepts the affirmative and negative spellings the module documents", async () => {
    for (const [value, expected] of [
      ["true", true],
      ["TRUE", true],
      ["True", true],
      ["1", true],
      ["false", false],
      ["0", false],
    ] satisfies readonly (readonly [string, boolean])[]) {
      const env = await loadEnv({ ANALYTICS_DISABLED: value });

      expect(env.isAnalyticsDisabled(), `ANALYTICS_DISABLED=${value}`).toBe(
        expected,
      );
      expect(env.isEnvValid(), `ANALYTICS_DISABLED=${value}`).toBe(true);
    }
  });

  it("records a typo instead of quietly enabling the tags", async () => {
    // Failing closed to "enabled" is the safe direction for the school's data,
    // but a silent fallback would hide a CI job reporting real pageviews, so
    // the value is still recorded and logged.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await loadEnv({ ANALYTICS_DISABLED: "ture" });

    expect(env.isAnalyticsDisabled()).toBe(false);
    expect(requireIssue(env.getEnvIssues(), "ANALYTICS_DISABLED").scope).toBe(
      "server",
    );
  });
});

/* ==========================================================================
 * Scope separation — the reason the module has two schemas
 * ========================================================================== */

describe("the public and server scopes", () => {
  it("keeps every server-only credential out of the browser-safe schema", async () => {
    // The point of the split: a value a Client Component can reach must be a
    // value it is safe for a browser to hold. None of these three is.
    const env = await loadEnv();
    const publicKeys = Object.keys(env.publicEnvSchema.shape);

    for (const name of SERVER_ONLY_CREDENTIALS) {
      expect(
        publicKeys,
        `${name} must not be in the public schema`,
      ).not.toContain(name);
      expect(Object.keys(env.serverEnvSchema.shape)).toContain(name);
    }
  });

  it("keeps the server-only operational flags out of the browser-safe schema", async () => {
    const env = await loadEnv();
    const publicKeys = Object.keys(env.publicEnvSchema.shape);

    for (const name of [
      "CONTENT_SOURCE",
      "ANALYTICS_DISABLED",
      "CSP_MODE",
      "HSTS_MAX_AGE",
    ] satisfies readonly EnvVariableName[]) {
      expect(publicKeys).not.toContain(name);
    }
  });

  it("does not resolve a server value through the public parser", async () => {
    // Even handed the whole environment, the public parser must return only
    // browser-safe values — otherwise the split would be documentation rather
    // than a boundary.
    const env = await loadEnv();
    const resolved = env.parsePublicEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
      SUPABASE_SECRET_KEY: "service-role-value",
      REVALIDATE_SECRET: "revalidate-value",
      CRON_SECRET: "cron-value",
      CSP_MODE: "enforce",
    });

    const resolvedKeys = Object.keys(resolved.values);
    for (const name of SERVER_ONLY_CREDENTIALS) {
      expect(resolvedKeys).not.toContain(name);
    }
    expect(resolvedKeys).not.toContain("CSP_MODE");
    expect(JSON.stringify(resolved.values)).not.toContain("service-role-value");
    expect(resolved.issues).toEqual([]);
  });

  it("declares the two scopes as disjoint sets covering the whole contract", async () => {
    const env = await loadEnv();
    const publicKeys = Object.keys(env.publicEnvSchema.shape);
    const serverKeys = Object.keys(env.serverEnvSchema.shape);

    expect(publicKeys.filter((key) => serverKeys.includes(key))).toEqual([]);
    expect([...publicKeys, ...serverKeys].sort()).toEqual(
      [...ENV_VARIABLE_NAMES].sort(),
    );
  });

  it("tags each recorded issue with the scope it came from", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = await loadEnv({
      NEXT_PUBLIC_SITE_URL: "not-a-url",
      CSP_MODE: "enforcing",
    });

    expect(requireIssue(env.getEnvIssues(), "NEXT_PUBLIC_SITE_URL").scope).toBe(
      "public",
    );
    expect(requireIssue(env.getEnvIssues(), "CSP_MODE").scope).toBe("server");
  });

  it("reads every name as a literal static property access", async () => {
    // Next.js inlines `NEXT_PUBLIC_*` at build time by static textual
    // replacement, so a computed key or a spread yields `undefined` in the
    // browser bundle — quietly, with the server still working. This is a source
    // assertion because the failure is invisible at runtime on the server,
    // which is where a unit test runs.
    for (const name of ENV_VARIABLE_NAMES) {
      expect(
        envModuleCode,
        `${name} must be read as process.env.${name}`,
      ).toContain(`process.env.${name}`);
    }

    expect(envModuleCode).not.toContain("process.env[");
    expect(envModuleCode).not.toContain("...process.env");
  });
});

/* ==========================================================================
 * The module boundary — static inspection of lib/env.ts
 *
 * These four obligations cannot be observed by importing the module. Importing
 * it here proves only that it loads under Vitest, which is a Node context with
 * a DOM attached; it says nothing about whether the module would still load
 * inside `next.config.ts`, which Next evaluates in a plain Node process before
 * any React or server runtime exists. `import "server-only"` throws exactly
 * there and nowhere else, so the only instrument that can see it is the file's
 * own text.
 * ========================================================================== */

describe("the lib/env module boundary", () => {
  it("verifies its own instrument before trusting its silence", () => {
    // Every mention of `server-only`, `next/headers`, `throw` and
    // `ADMIN_EMAILS` in lib/env.ts today is inside a comment explaining why it
    // is absent. A raw text search would therefore report four failures against
    // a correct module. This case proves the stripper removes prose and keeps
    // code, so the assertions below mean what they claim.
    expect(envModuleSource).toContain("server-only");
    expect(envModuleCode).not.toContain("server-only");

    expect(stripComments('import "server-only";')).toContain("server-only");
    expect(stripComments('// import "server-only";')).not.toContain(
      "server-only",
    );
    expect(stripComments('/* import "server-only"; */')).not.toContain(
      "server-only",
    );
    expect(stripComments('const url = "http://x/y"; // a comment')).toBe(
      'const url = "http://x/y"; ',
    );
  });

  it("does not import server-only", () => {
    expect(importedSpecifiers(envModuleCode)).not.toContain("server-only");
  });

  it("does not import next/headers", () => {
    // `next/headers` would make the module request-scoped, which
    // `next.config.ts` and a cached function both cannot be.
    expect(importedSpecifiers(envModuleCode)).not.toContain("next/headers");
    expect(envModuleCode).not.toContain("next/headers");
  });

  it("imports nothing but its validator", () => {
    // A leaf module. Anything else here would give the config file a
    // transitive dependency graph it cannot evaluate.
    expect(importedSpecifiers(envModuleCode)).toEqual(["zod"]);
  });

  it("contains no throw at all, let alone at module scope", () => {
    // Stricter than "no top-level throw", and deliberately so: the module's
    // contract is that a missing or malformed variable degrades to a documented
    // default and is recorded, so there is no path on which throwing would be
    // correct. A future implementation that needs one has to justify it against
    // requirement 14 first, and this failing is that conversation.
    expect(envModuleCode).not.toMatch(/\bthrow\b/);
  });

  it("says so itself, so the invariant is documented where it is implemented", () => {
    expect(envModuleSource).toMatch(
      /THERE IS NO TOP-LEVEL `throw` IN THIS FILE/,
    );
  });
});

/* ==========================================================================
 * Deliberate omissions — names that must never come back
 * ========================================================================== */

describe("the names lib/env deliberately does not define", () => {
  it("defines no ADMIN_EMAILS key", async () => {
    // The reference implementation used a comma-separated environment
    // allowlist as a role. Authorization here is the `admin_users` table plus
    // an explicit capability matrix checked inside `security definer` database
    // functions, so the same rules apply to a direct REST call. A list in an
    // environment variable cannot express a role, cannot be audited and cannot
    // be revoked without a redeploy — reintroducing it would be a real security
    // regression, not a style difference.
    const env = await loadEnv();

    expect(envModuleCode).not.toContain("ADMIN_EMAILS");
    expect(Object.keys(env.publicEnvSchema.shape)).not.toContain(
      "ADMIN_EMAILS",
    );
    expect(Object.keys(env.serverEnvSchema.shape)).not.toContain(
      "ADMIN_EMAILS",
    );
    expect(Object.keys(env)).not.toContain("getAdminEmails");
  });

  it("exposes no analytics identifier", async () => {
    const env = await loadEnv();
    const schemaKeys = [
      ...Object.keys(env.publicEnvSchema.shape),
      ...Object.keys(env.serverEnvSchema.shape),
    ];

    for (const value of ANALYTICS_IDENTIFIER_VALUES) {
      expect(
        envModuleCode,
        `${value} is content in site_globals, never an environment value`,
      ).not.toContain(value);
    }

    for (const fragment of ANALYTICS_IDENTIFIER_FRAGMENTS) {
      for (const key of schemaKeys) {
        expect(
          key.toUpperCase(),
          `${key} looks like an analytics identifier variable`,
        ).not.toContain(fragment);
      }
    }

    // The one analytics variable that does exist gates whether the tags render;
    // it does not carry what they report to.
    expect(schemaKeys).toContain("ANALYTICS_DISABLED");
  });

  it("carries no retired Laravel or Statamic variable", async () => {
    // Read from the files this migration retired: config/app.php, and
    // config/statamic/git.php with config/statamic/editions.php. No PHP
    // executes after the migration, and the Git flags' capability moved into
    // the database as an append-only revision trail rather than remaining a
    // switch.
    const env = await loadEnv();
    const schemaKeys = [
      ...Object.keys(env.publicEnvSchema.shape),
      ...Object.keys(env.serverEnvSchema.shape),
    ];

    for (const legacyKey of RETIRED_LEGACY_KEYS) {
      expect(
        schemaKeys,
        `${legacyKey} must not survive the migration`,
      ).not.toContain(legacyKey);
      expect(envModuleCode).not.toContain(`process.env.${legacyKey}`);
    }
  });
});

/* ==========================================================================
 * Cross-file consistency with .env.example
 *
 * The template is the committed, machine-readable statement of the same
 * contract. If the two disagree, one of them is a defect — which is why this
 * group reads the file rather than trusting that somebody updated it.
 * ========================================================================== */

describe(".env.example", () => {
  it("documents exactly the ten keys the contract defines", () => {
    expect([...activeEnvKeys(envTemplate)].sort()).toEqual(
      [...DOCUMENTED_KEYS].sort(),
    );
  });

  it("documents each key exactly once", () => {
    const keys = activeEnvKeys(envTemplate);

    expect(keys).toHaveLength(new Set(keys).size);
  });

  it("documents only keys the module actually reads", async () => {
    const env = await loadEnv();
    const known = [
      ...Object.keys(env.publicEnvSchema.shape),
      ...Object.keys(env.serverEnvSchema.shape),
    ];

    for (const key of activeEnvKeys(envTemplate)) {
      expect(
        known,
        `${key} is documented but not read by lib/env.ts`,
      ).toContain(key);
    }
  });

  it("mentions the predecessor key name as a documented alias", () => {
    // Accepted by the module, so it has to be discoverable — but not an active
    // assignment, because a template that sets both names invites setting both.
    expect(envTemplate).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(activeEnvKeys(envTemplate)).not.toContain(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  });

  it("ships every credential and URL key empty", () => {
    for (const key of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "NEXT_PUBLIC_SITE_URL",
      "REVALIDATE_SECRET",
      "CRON_SECRET",
      "ANALYTICS_DISABLED",
    ] satisfies readonly EnvVariableName[]) {
      expect(activeEnvValue(envTemplate, key), `${key} must ship empty`).toBe(
        "",
      );
    }
  });

  it("states the three defaults the module resolves to", async () => {
    // Not decoration: this is what makes the template a statement of the
    // contract rather than a suggestion. A default changed in one place and not
    // the other is caught here.
    const env = await loadEnv();

    expect(activeEnvValue(envTemplate, "CONTENT_SOURCE")).toBe(
      env.getContentSource(),
    );
    expect(activeEnvValue(envTemplate, "CSP_MODE")).toBe(env.getCspMode());
    expect(activeEnvValue(envTemplate, "HSTS_MAX_AGE")).toBe(
      env.getHstsMaxAge(),
    );
  });

  it("documents both members of each closed enumeration", () => {
    // An operator promoting the policy reads this file, not the schema.
    expect(envTemplate).toContain("report-only | enforce");
    expect(envTemplate).toContain("300 | 31536000");
  });

  it("declares no ADMIN_EMAILS key", () => {
    // Scoped to active assignments on purpose: the file's own
    // "DELIBERATELY ABSENT" section names ADMIN_EMAILS in prose to explain why
    // it is gone, and a raw text search would contradict the very comment that
    // documents the decision.
    expect(activeEnvKeys(envTemplate)).not.toContain("ADMIN_EMAILS");
    expect(envTemplate).toContain("DELIBERATELY ABSENT");
    expect(envTemplate).toContain("ADMIN_EMAILS");
  });

  it("declares no analytics identifier key or value", () => {
    for (const key of activeEnvKeys(envTemplate)) {
      for (const fragment of ANALYTICS_IDENTIFIER_FRAGMENTS) {
        expect(key.toUpperCase(), `${key} in .env.example`).not.toContain(
          fragment,
        );
      }
    }

    for (const value of ANALYTICS_IDENTIFIER_VALUES) {
      expect(envTemplate, `${value} belongs to site_globals`).not.toContain(
        value,
      );
    }
  });

  it("declares no retired Laravel or Statamic key", () => {
    for (const legacyKey of RETIRED_LEGACY_KEYS) {
      expect(
        activeEnvKeys(envTemplate),
        `${legacyKey} must not survive the migration`,
      ).not.toContain(legacyKey);
    }
  });

  it("holds no value that looks like a real credential", () => {
    // A template is the easiest place for a working key to be committed by
    // accident, and the repository's secret scanner is the last line rather
    // than the first.
    for (const key of activeEnvKeys(envTemplate)) {
      const value = activeEnvValue(envTemplate, key) ?? "";

      expect(value, `${key} must not carry a JWT`).not.toMatch(
        /^ey[A-Za-z0-9_-]{10,}/,
      );
      expect(value, `${key} must not carry a Supabase key`).not.toMatch(
        /^sb[ps]?_[A-Za-z0-9_-]{10,}/,
      );
      expect(
        value.length,
        `${key} carries a suspiciously long value`,
      ).toBeLessThan(32);
    }
  });
});

/* ==========================================================================
 * Isolation — the property every case above depends on
 * ========================================================================== */

describe("resolution caching", () => {
  it("memoizes each scope, so a malformed value is reported once", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const env = await loadEnv({ CSP_MODE: "enforcing" });

    env.getCspMode();
    env.getCspMode();
    env.getEnvIssues();
    env.getEnvIssues();

    // One line per invalid value, not one per read: a request-path accessor
    // called on every render must not turn a misconfiguration into a log flood.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(env.getEnvIssues()).toHaveLength(1);
  });

  it("re-reads the environment after the cache is discarded", async () => {
    // `resetEnvironmentCache` exists for exactly this, and this case is what
    // proves it does something rather than merely returning.
    const env = await loadEnv({ CSP_MODE: "enforce" });
    expect(env.getCspMode()).toBe("enforce");

    vi.stubEnv("CSP_MODE", "report-only");
    expect(env.getCspMode(), "the memoized value is still served").toBe(
      "enforce",
    );

    env.resetEnvironmentCache();
    expect(env.getCspMode(), "and the new value after a reset").toBe(
      "report-only",
    );
  });

  it("does not leak one case's environment into the next", async () => {
    const configured = await loadEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb-publishable-test-value",
      CONTENT_SOURCE: "supabase",
      CSP_MODE: "enforce",
      HSTS_MAX_AGE: "31536000",
      ANALYTICS_DISABLED: "true",
    });

    expect(configured.isSupabaseConfigured()).toBe(true);
    expect(configured.getCspMode()).toBe("enforce");

    // The same helper, with no overrides, must return the keyless state — which
    // is only true because it clears all twelve names before importing.
    const keyless = await loadEnv();

    expect(keyless.isSupabaseConfigured()).toBe(false);
    expect(keyless.getContentSource()).toBe("fallback");
    expect(keyless.getCspMode()).toBe("report-only");
    expect(keyless.getHstsMaxAge()).toBe("300");
    expect(keyless.isAnalyticsDisabled()).toBe(false);
    expect(keyless.getSiteUrl()).toBe("http://localhost:3000");
    expect(keyless.isEnvValid()).toBe(true);
  });

  it("fixes an instance's answer at its first read, not at its import", async () => {
    // Worth pinning precisely, because it is the property a sibling spec is
    // most likely to trip over: the module reads `process.env` lazily and
    // memoizes per scope on FIRST READ. An instance imported under one
    // environment but not read until the environment has moved will answer with
    // the new value — which is why every case in this file reads inside the case
    // that set up its environment.
    const first = await loadEnv({ CSP_MODE: "enforce" });
    expect(first.getCspMode()).toBe("enforce");

    const second = await loadEnv({ CSP_MODE: "report-only" });
    expect(second.getCspMode()).toBe("report-only");

    // Two distinct instances, and the first keeps the answer it memoized even
    // though the environment changed underneath it.
    expect(first).not.toBe(second);
    expect(first.getCspMode()).toBe("enforce");
  });
});
