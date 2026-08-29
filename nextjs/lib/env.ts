/**
 * Environment contract for the Cambridge-Ellis School application.
 *
 * THIS IS THE ONLY MODULE IN THE REPOSITORY THAT READS `process.env`.
 *
 * `proxy.ts`, `next.config.ts`, the four Supabase client factories, every route
 * handler and the content source adapter all ask this module instead of reading
 * the environment themselves. `eslint.config.mjs` enforces that with a
 * `no-process-env` restriction scoped to allow this file alone, so a second
 * reader is a build failure rather than a review comment. Keeping one reader is
 * what stops a server-only credential being pulled into a client bundle by
 * accident, and it is the reason the key set can be closed at all.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS SOFT. ALWAYS. THERE IS NO TOP-LEVEL `throw` IN THIS FILE.
 * ---------------------------------------------------------------------------
 *
 * The school supplies its Supabase keys *after* the project is complete, so the
 * build, the production render and every metadata function have to succeed with
 * no Supabase variables present at all. The CI `build-no-env` job proves it by
 * building with none set. That requirement is also why this module imports
 * neither `server-only` nor `next/headers`: `next.config.ts` imports it to
 * derive the image optimizer's `remotePatterns` host, and a config file is
 * evaluated in a plain Node context where `server-only` throws.
 *
 * This is the direct correction of the reference implementation the project was
 * pointed at, whose Supabase client read two variables at module scope and
 * called `throw new Error(...)` at module scope when either was missing. Under
 * this project's constraints that behaviour crashes the build.
 *
 * ---------------------------------------------------------------------------
 * ABSENT IS NOT THE SAME AS INVALID
 * ---------------------------------------------------------------------------
 *
 *   ABSENT  (unset, empty, or whitespace) -> the documented default, silently.
 *           `.env.example` ships every credential and URL key EMPTY on purpose,
 *           so a verbatim copy must land in the keyless state with no errors.
 *
 *   INVALID (present, but outside its schema) -> the documented default is
 *           applied anyway, a typed `EnvIssue` is recorded for
 *           `getEnvIssues()`, and the failure is logged loudly once. A typo in
 *           `CSP_MODE` or `HSTS_MAX_AGE` must never silently disable a security
 *           header, and it must never take the whole environment down with it
 *           either: resolution is per key, so one bad value degrades only
 *           itself.
 *
 * Every default is deliberately the safe end of its range - report-only CSP, a
 * five-minute HSTS, the fallback content source - so a variable missing from
 * the Vercel project can never produce an unintended enforcing policy or a
 * year-long HTTPS commitment.
 *
 * `.env.example` in this directory is the key-for-key mirror of this file and
 * carries the operational reasoning for each key. If the two ever disagree,
 * that is a defect in one of them, not licence to add a key.
 *
 * Deliberately absent, and not to be added: `ADMIN_EMAILS` (authorization is
 * the `admin_users` table plus the capability matrix in `lib/auth.ts`, not an
 * environment allowlist) and every analytics identifier (the Google Ads tag and
 * both StatCounter values are content in `site_globals`, present in the
 * fallback JSON, so they work with no keys and staff can edit them without a
 * redeploy - `ANALYTICS_DISABLED` gates whether the tags render, not what they
 * report to).
 */

import * as z from "zod";

/* ==========================================================================
 * Names, scopes and diagnostics
 * ========================================================================== */

/**
 * Every environment variable this application reads. The union is closed: a
 * name that is not here is not read anywhere in the codebase.
 */
export type EnvVariableName =
  // Browser-safe scope.
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "NEXT_PUBLIC_SITE_URL"
  | "VERCEL_URL"
  // Server-only scope.
  | "CONTENT_SOURCE"
  | "SUPABASE_SECRET_KEY"
  | "REVALIDATE_SECRET"
  | "CRON_SECRET"
  | "ANALYTICS_DISABLED"
  | "CSP_MODE"
  | "HSTS_MAX_AGE";

/**
 * Which of the two schemas a variable belongs to. `public` means the value is
 * safe to appear in a browser bundle; `server` means it must never leave the
 * server.
 */
export type EnvScope = "public" | "server";

/**
 * A variable that was present but failed its schema. Absent variables never
 * produce an issue - they take their documented default.
 *
 * `message` never contains the offending value for a credential-bearing
 * variable, and `appliedFallback` can only ever describe a non-credential
 * value, because every credential key is optional and therefore falls back to
 * `unset`.
 */
export interface EnvIssue {
  readonly variable: EnvVariableName;
  readonly scope: EnvScope;
  readonly message: string;
  readonly appliedFallback: string;
}

/**
 * The shape the parse functions accept. Tests drive them with a plain record;
 * the accessors below drive them with the real `process.env`.
 */
export type EnvironmentRecord = Readonly<
  Partial<Record<EnvVariableName, string | undefined>>
>;

/** The outcome of parsing one scope: resolved values plus any typed failures. */
export interface EnvResolution<TValues> {
  readonly values: TValues;
  readonly issues: readonly EnvIssue[];
}

/* ==========================================================================
 * Field schemas
 * ========================================================================== */

/**
 * An absolute http or https URL. HTTPS is deliberately NOT required: the local
 * Supabase stack serves `http://127.0.0.1:54321` and CI points the application
 * at it. Restricting the protocol to http(s) still rejects `javascript:`,
 * `data:` and `ftp:`, which a bare URL check would accept and which would then
 * reach a canonical tag or an Open Graph URL.
 */
const httpUrlSchema = z.url({ protocol: /^https?$/ }).optional();

/** A credential or opaque token. Empty values never reach it (see `normalize`). */
const secretSchema = z.string().min(1).optional();

/** The content source adapter's switch. Defaults to the committed fallback JSON. */
const contentSourceSchema = z.enum(["fallback", "supabase"]).default("fallback");

/**
 * Which header name `proxy.ts` sends its single policy string under. A CLOSED
 * enumeration: a typo has to fail validation rather than silently disable the
 * Content Security Policy.
 */
const cspModeSchema = z.enum(["report-only", "enforce"]).default("report-only");

/**
 * `Strict-Transport-Security: max-age=<value>`, in seconds.
 *
 * A CLOSED enumeration of exactly two values, and NOT a free integer. It admits
 * no value carrying `includeSubDomains` or `preload`: those two directives are
 * effectively irreversible and stay unavailable until a subdomain audit
 * confirms every `cambridge-ellis.org` subdomain serves valid HTTPS and the
 * school signs off. Widening this enumeration is itself a reviewed change.
 * `300` (five minutes) is the safe default; `31536000` (one year) is raised only
 * after the production domain has served real traffic cleanly for a full day.
 */
const hstsMaxAgeSchema = z.enum(["300", "31536000"]).default("300");

/**
 * A boolean-ish flag. `true` and `1` mean true; `false` and `0` mean false;
 * absent means false. Comparison is case-insensitive (the value is lower-cased
 * before it reaches this schema), which is a superset of `.env.example`'s "the
 * exact string `true`" and behaves identically for that string. Anything else -
 * `yes`, `ture` - is an INVALID value: it falls back to false exactly as
 * `.env.example` documents, but is additionally recorded and logged, because a
 * typo here is how a CI run silently fills the school's real analytics with
 * synthetic pageviews.
 */
const booleanishSchema = z
  .enum(["true", "1", "false", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

/* ==========================================================================
 * The two schemas
 * ========================================================================== */

/**
 * BROWSER-SAFE SCOPE. Every value here may appear in a client bundle.
 *
 * `NEXT_PUBLIC_*` values are inlined at BUILD time by static textual
 * replacement, which is why the readers below use literal property accesses and
 * why changing one of these requires a redeploy rather than a restart.
 *
 * `VERCEL_URL` is platform-injected and not a credential, but it carries no
 * `NEXT_PUBLIC_` prefix and is therefore absent from the browser bundle: it
 * participates in site-URL resolution only on the server. That is precisely why
 * `NEXT_PUBLIC_SITE_URL` exists and should be set in production.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrlSchema,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secretSchema,
  /** The predecessor name, still accepted so an existing deployment need not be renamed. */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: secretSchema,
  NEXT_PUBLIC_SITE_URL: httpUrlSchema,
  VERCEL_URL: z.string().min(1).optional(),
});

/**
 * SERVER-ONLY SCOPE. Nothing here may be read from a code path a client
 * component can reach, and nothing here is inlined into any bundle. The
 * accessors for these values are grouped together and marked below.
 */
export const serverEnvSchema = z.object({
  CONTENT_SOURCE: contentSourceSchema,
  SUPABASE_SECRET_KEY: secretSchema,
  REVALIDATE_SECRET: secretSchema,
  CRON_SECRET: secretSchema,
  ANALYTICS_DISABLED: booleanishSchema,
  CSP_MODE: cspModeSchema,
  HSTS_MAX_AGE: hstsMaxAgeSchema,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** `fallback` serves the committed JSON; `supabase` requires the readiness gate. */
export type ContentSource = z.infer<typeof contentSourceSchema>;
/** The header name `proxy.ts` sends its policy under. */
export type CspMode = z.infer<typeof cspModeSchema>;
/** The `max-age` value, in seconds, as a string. */
export type HstsMaxAge = z.infer<typeof hstsMaxAgeSchema>;

/* ==========================================================================
 * Resolution
 * ========================================================================== */

/**
 * Variables whose value must never appear in a log line or an issue message.
 * The publishable key is not secret, but it is still a credential-shaped value
 * and there is no reason to echo it.
 */
const CREDENTIAL_VARIABLES: ReadonlySet<EnvVariableName> = new Set([
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY",
  "REVALIDATE_SECRET",
  "CRON_SECRET",
]);

/**
 * Collapses "unset", "empty" and "whitespace only" into a single ABSENT state.
 *
 * This is load-bearing rather than cosmetic: `.env.example` ships
 * `NEXT_PUBLIC_SUPABASE_URL=`, `SUPABASE_SECRET_KEY=` and every other
 * credential key empty, so a verbatim copy must resolve to the documented
 * defaults with zero issues. Without this, an empty string would be a
 * *present, invalid* value and a clean install would log four failures.
 */
function normalize(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Describes the value actually applied, without ever quoting a credential. */
function describeApplied(
  variable: EnvVariableName,
  applied: unknown,
): string {
  if (applied === undefined) {
    return "unset";
  }
  if (CREDENTIAL_VARIABLES.has(variable)) {
    return "unset";
  }
  return JSON.stringify(applied);
}

/** Extracts a readable reason, redacting it entirely for credential variables. */
function describeFailure(
  variable: EnvVariableName,
  error: z.ZodError,
): string {
  if (CREDENTIAL_VARIABLES.has(variable)) {
    return "value is present but invalid (details withheld: credential)";
  }
  return error.issues.at(0)?.message ?? "value is present but invalid";
}

/**
 * Resolves one variable, degrading only itself on failure.
 *
 * On success the parsed value is returned. On failure the value is recovered
 * from the field schema's OWN default (by re-parsing `undefined`), so the
 * default can never drift from the declaration above; `fallback` exists solely
 * to satisfy the type system on a path the schemas make unreachable. Either
 * way a typed issue is appended - never thrown.
 */
function resolveField<TSchema extends z.ZodType>(
  variable: EnvVariableName,
  scope: EnvScope,
  schema: TSchema,
  raw: string | undefined,
  fallback: z.output<TSchema>,
  issues: EnvIssue[],
): z.output<TSchema> {
  const parsed = schema.safeParse(normalize(raw));
  if (parsed.success) {
    return parsed.data;
  }

  const recovered = schema.safeParse(undefined);
  const applied = recovered.success ? recovered.data : fallback;

  issues.push({
    variable,
    scope,
    message: describeFailure(variable, parsed.error),
    appliedFallback: describeApplied(variable, applied),
  });

  return applied;
}

/**
 * Parses the browser-safe scope from an arbitrary record.
 *
 * Exported so `tests/unit/**` can drive the contract without touching the real
 * process environment.
 */
export function parsePublicEnvironment(
  source: EnvironmentRecord,
): EnvResolution<PublicEnv> {
  const issues: EnvIssue[] = [];
  const shape = publicEnvSchema.shape;

  const values: PublicEnv = {
    NEXT_PUBLIC_SUPABASE_URL: resolveField(
      "NEXT_PUBLIC_SUPABASE_URL",
      "public",
      shape.NEXT_PUBLIC_SUPABASE_URL,
      source.NEXT_PUBLIC_SUPABASE_URL,
      undefined,
      issues,
    ),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: resolveField(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "public",
      shape.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      undefined,
      issues,
    ),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: resolveField(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "public",
      shape.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      undefined,
      issues,
    ),
    NEXT_PUBLIC_SITE_URL: resolveField(
      "NEXT_PUBLIC_SITE_URL",
      "public",
      shape.NEXT_PUBLIC_SITE_URL,
      source.NEXT_PUBLIC_SITE_URL,
      undefined,
      issues,
    ),
    VERCEL_URL: resolveField(
      "VERCEL_URL",
      "public",
      shape.VERCEL_URL,
      source.VERCEL_URL,
      undefined,
      issues,
    ),
  };

  return { values, issues };
}

/**
 * Parses the server-only scope from an arbitrary record.
 *
 * `ANALYTICS_DISABLED` is lower-cased before validation so `True` and `TRUE`
 * behave like `true`; every other value is compared exactly.
 */
export function parseServerEnvironment(
  source: EnvironmentRecord,
): EnvResolution<ServerEnv> {
  const issues: EnvIssue[] = [];
  const shape = serverEnvSchema.shape;
  const analyticsDisabled = normalize(source.ANALYTICS_DISABLED)?.toLowerCase();

  const values: ServerEnv = {
    CONTENT_SOURCE: resolveField(
      "CONTENT_SOURCE",
      "server",
      shape.CONTENT_SOURCE,
      source.CONTENT_SOURCE,
      "fallback",
      issues,
    ),
    SUPABASE_SECRET_KEY: resolveField(
      "SUPABASE_SECRET_KEY",
      "server",
      shape.SUPABASE_SECRET_KEY,
      source.SUPABASE_SECRET_KEY,
      undefined,
      issues,
    ),
    REVALIDATE_SECRET: resolveField(
      "REVALIDATE_SECRET",
      "server",
      shape.REVALIDATE_SECRET,
      source.REVALIDATE_SECRET,
      undefined,
      issues,
    ),
    CRON_SECRET: resolveField(
      "CRON_SECRET",
      "server",
      shape.CRON_SECRET,
      source.CRON_SECRET,
      undefined,
      issues,
    ),
    ANALYTICS_DISABLED: resolveField(
      "ANALYTICS_DISABLED",
      "server",
      shape.ANALYTICS_DISABLED,
      analyticsDisabled,
      false,
      issues,
    ),
    CSP_MODE: resolveField(
      "CSP_MODE",
      "server",
      shape.CSP_MODE,
      source.CSP_MODE,
      "report-only",
      issues,
    ),
    HSTS_MAX_AGE: resolveField(
      "HSTS_MAX_AGE",
      "server",
      shape.HSTS_MAX_AGE,
      source.HSTS_MAX_AGE,
      "300",
      issues,
    ),
  };

  return { values, issues };
}

/* ==========================================================================
 * Reading the real environment
 * ========================================================================== */

/**
 * The browser-safe scope, read from the real environment.
 *
 * Every `NEXT_PUBLIC_*` value MUST be a literal static property access, exactly
 * as written below. Next.js inlines these at build time by static textual
 * replacement, so a computed key (`process.env[name]`) or a spread
 * (`{ ...process.env }`) silently yields `undefined` in the browser bundle.
 * That is the single most common way a module of this shape breaks, and it
 * breaks quietly: the server keeps working while the client loses its
 * configuration.
 */
function readRawPublicEnvironment(): EnvironmentRecord {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_URL: process.env.VERCEL_URL,
  };
}

/**
 * The server-only scope, read from the real environment.
 *
 * Read lazily and separately from the browser-safe scope, so that a client
 * component calling one of the public accessors never executes this function at
 * all. None of these names carries a `NEXT_PUBLIC_` prefix, so none is inlined
 * into any bundle; in a browser context they would all resolve to `undefined`,
 * which is a further reason no secret can leak through a mistaken call.
 */
function readRawServerEnvironment(): EnvironmentRecord {
  return {
    CONTENT_SOURCE: process.env.CONTENT_SOURCE,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    REVALIDATE_SECRET: process.env.REVALIDATE_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    ANALYTICS_DISABLED: process.env.ANALYTICS_DISABLED,
    CSP_MODE: process.env.CSP_MODE,
    HSTS_MAX_AGE: process.env.HSTS_MAX_AGE,
  };
}

let publicResolution: EnvResolution<PublicEnv> | undefined;
let serverResolution: EnvResolution<ServerEnv> | undefined;

/**
 * Reports invalid values once per process, per scope.
 *
 * `console.error` rather than `console.warn`: a present-but-invalid security
 * variable is a misconfiguration somebody has to fix, and the whole point of
 * the closed enumerations is that it cannot pass unnoticed. Nothing is thrown -
 * the deployment stays up on the safe default.
 */
function reportIssues(issues: readonly EnvIssue[]): void {
  for (const issue of issues) {
    console.error(
      `[env] ${issue.variable} (${issue.scope}) ${issue.message}. ` +
        `Applied fallback: ${issue.appliedFallback}. ` +
        `See nextjs/.env.example for the accepted values.`,
    );
  }
}

/** Resolves and memoizes the browser-safe scope. Never throws. */
function resolvedPublicEnv(): EnvResolution<PublicEnv> {
  if (publicResolution === undefined) {
    publicResolution = parsePublicEnvironment(readRawPublicEnvironment());
    reportIssues(publicResolution.issues);
  }
  return publicResolution;
}

/** Resolves and memoizes the server-only scope. Never throws. */
function resolvedServerEnv(): EnvResolution<ServerEnv> {
  if (serverResolution === undefined) {
    serverResolution = parseServerEnvironment(readRawServerEnvironment());
    reportIssues(serverResolution.issues);
  }
  return serverResolution;
}

/**
 * Discards both memoized resolutions.
 *
 * TEST-ONLY. Production code has no reason to call it: the environment does not
 * change within the lifetime of a process, and `NEXT_PUBLIC_*` values are
 * literals in a built bundle, so re-reading them cannot produce a new answer.
 * It exists so a unit test can mutate `process.env` between cases.
 */
export function resetEnvironmentCache(): void {
  publicResolution = undefined;
  serverResolution = undefined;
}

/* ==========================================================================
 * Diagnostics
 * ========================================================================== */

/**
 * Every variable that was present but invalid, across both scopes, with the
 * fallback that was applied instead. Empty in the keyless state, and empty for
 * a correctly configured deployment.
 *
 * This is the typed failure surface: validation problems are values here, not
 * exceptions, which is what lets a health check or an admin screen report a
 * misconfiguration without the misconfiguration having taken the site down.
 */
export function getEnvIssues(): readonly EnvIssue[] {
  return [...resolvedPublicEnv().issues, ...resolvedServerEnv().issues];
}

/** True when no variable is present-but-invalid. Absent variables are valid. */
export function isEnvValid(): boolean {
  return getEnvIssues().length === 0;
}

/* ==========================================================================
 * Browser-safe accessors
 *
 * Safe to call from a Server Component, a Client Component, a route handler,
 * `proxy.ts` or `next.config.ts`.
 * ========================================================================== */

/**
 * The configured Supabase project URL, with any trailing slash removed, or
 * `undefined` when it is unset or invalid.
 *
 * `undefined` is the keyless state and is fully supported: the content adapter
 * stays on the committed fallback JSON and sign-in reports edit mode
 * unavailable. Callers must handle `undefined` rather than assert it away.
 */
export function getSupabaseUrl(): string | undefined {
  const url = resolvedPublicEnv().values.NEXT_PUBLIC_SUPABASE_URL;
  return url === undefined ? undefined : stripTrailingSlash(url);
}

/**
 * The Supabase publishable key, or `undefined`.
 *
 * ONE accessor for TWO variable names: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
 * is preferred and the predecessor `NEXT_PUBLIC_SUPABASE_ANON_KEY` is accepted
 * as a fallback, so an existing deployment need not be renamed and no consumer
 * has to know both names exist.
 *
 * The key is safe in a browser bundle: it carries no authority of its own, and
 * every read it can perform is bounded by row-level security, which restricts
 * anonymous reads to published rows.
 */
export function getSupabasePublishableKey(): string | undefined {
  const values = resolvedPublicEnv().values;
  return (
    values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    values.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/**
 * The Supabase project host - hostname plus port when one is present - or
 * `undefined` when the URL is absent or unparseable.
 *
 * This is what keeps the two places that need it narrow and correct:
 *
 *   - `next.config.ts` builds the image optimizer's `remotePatterns` from it,
 *     scoped to `/storage/v1/object/public/media/**` on this host. A
 *     `**.supabase.co` wildcard would let the optimizer fetch from any Supabase
 *     tenant on the internet, which is exactly the reference implementation's
 *     mistake.
 *   - `proxy.ts` builds `connect-src` (`https://` and `wss://`) and `img-src`
 *     from it.
 *
 * A consumer that gets `undefined` must OMIT its pattern or directive entry
 * rather than guess a host. Callers needing the scheme as well - the local
 * stack is `http://127.0.0.1:54321` - should read `getSupabaseUrl()` and
 * construct a `URL` from it.
 */
export function getSupabaseProjectHost(): string | undefined {
  const url = getSupabaseUrl();
  if (url === undefined) {
    return undefined;
  }
  try {
    const host = new URL(url).host;
    return host === "" ? undefined : host;
  } catch {
    // Unreachable for a value that passed the schema, but a parse failure here
    // must degrade to "no pattern" rather than escape as an exception: this
    // function is called during `next build`, where a throw fails the build.
    return undefined;
  }
}

/**
 * Whether Supabase credentials are PRESENT - URL and publishable key both.
 *
 * This answers "can a client be constructed at all", which is what sign-in and
 * the edit-mode availability check need. It deliberately does NOT answer
 * "should the content adapter read from Supabase": see
 * `isSupabaseContentSourceRequested()` below and the readiness gate it points
 * at. Conflating the two is how a presence check flips a working site onto an
 * empty database.
 */
export function isSupabaseConfigured(): boolean {
  return getSupabaseUrl() !== undefined && getSupabasePublishableKey() !== undefined;
}

/**
 * The resolved public site URL, with no trailing slash. Always returns a
 * usable absolute URL.
 *
 * The chain, in order:
 *
 *   1. `NEXT_PUBLIC_SITE_URL` - set this to the CANONICAL host in production so
 *      canonical tags, the sitemap, Open Graph URLs and the host redirect all
 *      agree.
 *   2. `https://$VERCEL_URL` - the platform's per-deployment host. Server-side
 *      only, because `VERCEL_URL` is not inlined into the browser bundle.
 *   3. `http://localhost:3000` - local development.
 *
 * Used by `lib/seo.ts` canonicals, `app/sitemap.ts`, Open Graph image URLs and
 * the auth callback.
 */
export function getSiteUrl(): string {
  const values = resolvedPublicEnv().values;

  const configured = values.NEXT_PUBLIC_SITE_URL;
  if (configured !== undefined) {
    return stripTrailingSlash(configured);
  }

  const vercelHost = values.VERCEL_URL;
  if (vercelHost !== undefined) {
    const fromPlatform = normalizeAbsoluteUrl(`https://${vercelHost}`);
    if (fromPlatform !== undefined) {
      return fromPlatform;
    }
  }

  return "http://localhost:3000";
}

/** Removes every trailing slash, so joined paths never produce a double slash. */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Validates and normalizes a composed absolute URL, returning `undefined`
 * rather than throwing when it cannot be parsed - `VERCEL_URL` is
 * platform-supplied and is never assumed to be well formed.
 */
function normalizeAbsoluteUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return stripTrailingSlash(parsed.toString());
  } catch {
    return undefined;
  }
}

/* ==========================================================================
 * SERVER-ONLY ACCESSORS
 *
 * Everything below this line reads the server scope. DO NOT call any of it from
 * a Client Component, and do not re-export it from a module a client bundle
 * imports. This file cannot enforce that with `import "server-only"`, because
 * `next.config.ts` imports it in a plain Node context where that marker throws -
 * so the boundary is this comment, the scope split above, and the lint rule that
 * makes this the only reader of `process.env`.
 * ========================================================================== */

/**
 * Which backend the content source adapter has been ASKED to use. Defaults to
 * `fallback`.
 *
 * Also the rollback switch: returning it to `fallback` and redeploying restores
 * the public site to the last exported snapshot in one deploy without touching
 * the database.
 */
export function getContentSource(): ContentSource {
  return resolvedServerEnv().values.CONTENT_SOURCE;
}

/**
 * Whether the Supabase backend has been requested AND its credentials are
 * present.
 *
 * REQUESTED, NOT READY. This is a necessary condition, not a sufficient one:
 * `lib/content/source.ts` must ALSO confirm the `site_readiness` row before it
 * reads from Supabase, because keys can arrive before the schema is pushed, the
 * seed is loaded, the admins are bootstrapped and the assets are uploaded. The
 * name says "requested" so the two questions cannot be conflated at a call
 * site.
 */
export function isSupabaseContentSourceRequested(): boolean {
  return getContentSource() === "supabase" && isSupabaseConfigured();
}

/**
 * The Supabase service-role credential, or `undefined`.
 *
 * SERVER ONLY, AND PRODUCTION-SCOPED ONLY. It bypasses row-level security
 * entirely. In the Vercel project it must NOT be added to the Preview
 * environment: a Preview variable is available to any deployment of any branch,
 * including a branch from a fork, so scoping it to "Production and Preview"
 * hands full database authority to arbitrary code. Previews either point at a
 * separate Supabase project or hold no secret key at all and run in fallback,
 * read-only mode. Do not "fix" this by widening the scope.
 *
 * When it is absent, `lib/supabase/admin.ts` refuses to construct and
 * invitations, role changes and the upload finalize path each report themselves
 * unavailable rather than crashing.
 */
export function getSupabaseSecretKey(): string | undefined {
  return resolvedServerEnv().values.SUPABASE_SECRET_KEY;
}

/**
 * The shared secret for `/api/revalidate`, or `undefined`.
 *
 * When it is absent the route must return 404 - NOT 401. A 401 advertises that
 * the endpoint exists; an unconfigured revalidation hook should be invisible,
 * not merely closed.
 */
export function getRevalidateSecret(): string | undefined {
  return resolvedServerEnv().values.REVALIDATE_SECRET;
}

/**
 * The shared secret for `/api/cleanup/orphans`, or `undefined`.
 *
 * When it is absent the route must return 404, so the nightly sweep is inert
 * rather than open. Same reasoning as `getRevalidateSecret()`.
 */
export function getCronSecret(): string | undefined {
  return resolvedServerEnv().values.CRON_SECRET;
}

/**
 * Whether the two analytics tags must be suppressed. Read by
 * `app/(site)/(pages)/layout.tsx`.
 *
 * False in production - both tags render. Set true in CI so the bulk route
 * sweep and the Lighthouse runs never fill the school's real reporting with
 * synthetic pageviews. This gates whether the tags RENDER; it does not carry
 * their identifiers, which are content in `site_globals`.
 */
export function isAnalyticsDisabled(): boolean {
  return resolvedServerEnv().values.ANALYTICS_DISABLED;
}

/**
 * Which header name `proxy.ts` sends its single policy string under:
 * `Content-Security-Policy-Report-Only` or `Content-Security-Policy`.
 * Defaults to `report-only`, the safe end of the range.
 *
 * `proxy.ts` is the sole owner of the policy and builds ONE string; this only
 * chooses the header name. A policy split across two owners produces two
 * headers, which browsers intersect, and that is how a working nonce policy
 * silently becomes unsatisfiable.
 */
export function getCspMode(): CspMode {
  return resolvedServerEnv().values.CSP_MODE;
}

/**
 * The `Strict-Transport-Security` `max-age`, in seconds, as the literal string
 * to emit. Defaults to `"300"`.
 *
 * `proxy.ts` emits `max-age=<value>` and NEVER adds `includeSubDomains` or
 * `preload`, because this schema admits no value that carries them.
 */
export function getHstsMaxAge(): HstsMaxAge {
  return resolvedServerEnv().values.HSTS_MAX_AGE;
}

/**
 * The same value as a number, for callers that need to compare or compute with
 * it. The header itself is built from `getHstsMaxAge()`.
 */
export function getHstsMaxAgeSeconds(): number {
  return Number.parseInt(getHstsMaxAge(), 10);
}

