/**
 * Next.js framework configuration for the Cambridge-Ellis School application.
 *
 * The scope of this module is deliberately narrow, and knowing what is *not*
 * here matters as much as what is. It owns exactly three things: the Cache
 * Components opt-in, the image optimizer, and the four response headers that
 * carry no per-request value. Anything that varies per request — above all the
 * Content Security Policy nonce — belongs to `proxy.ts`.
 *
 * WHAT THIS FILE MUST NEVER EMIT
 *
 * The Content Security Policy, in both its enforcing and its report-only form,
 * the HSTS transport-security header, and the reporting-endpoints group are
 * owned solely by `proxy.ts`, which generates a fresh nonce per request,
 * selects the enforcing or report-only header name from `CSP_MODE`, and derives
 * the transport-security value from the `HSTS_MAX_AGE` enumeration.
 *
 * This is not a stylistic division of labour. A policy emitted from two owners
 * produces two policy headers on one response, and a browser presented with
 * two policies enforces the INTERSECTION of both — so a well-meaning second
 * policy here would combine with the nonce policy into something no script can
 * satisfy. The observable symptom would not be an error page: it would be the
 * school's Google Ads and StatCounter tags silently failing to execute, which
 * is precisely the analytics continuity the migration is required to preserve.
 * The end-to-end security suite asserts exactly one enforcing policy header per
 * response, so a duplicate emitted from here is a test failure as well as a
 * defect.
 *
 * For the same reason the legacy cross-site-scripting filter header is absent
 * below: it is deprecated, superseded by the policy above, and no longer
 * honoured by current browsers.
 *
 * These names are written out in prose rather than as literal header strings on
 * purpose. The migration's review gate greps this file for the exact tokens it
 * must not contain, so an example of a header this file is forbidden to emit
 * would itself trip that gate.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * There is no `webpack()` or `turbopack()` override, no `env` block, and no
 * `publicRuntimeConfig` / `serverRuntimeConfig` — the last two are legacy and
 * incompatible with the App Router. There is no `output: 'export'`, no
 * `generateBuildId`, and no flag aimed at forcing static HTML: pages are
 * dynamic by design (see the Cache Components note below). Neither
 * `eslint.ignoreDuringBuilds` nor `typescript.ignoreBuildErrors` appears,
 * because a build that hides a type error or a lint violation is not a passing
 * build.
 *
 * The file is typed as `NextConfig` rather than left untyped, which is most of
 * the reason it is authored in TypeScript: a misspelled or invented key is a
 * compile error here instead of a silently ignored line in a JavaScript config.
 */
import type { NextConfig } from "next";

import { getSupabaseUrl } from "./lib/env";

/**
 * The element type of `images.remotePatterns`, derived from `NextConfig` so the
 * pattern builder below is checked against the framework's own contract rather
 * than a hand-written copy of it, and without reaching into a `next/dist/**`
 * internal path for the type.
 */
type ImageRemotePatterns = NonNullable<
  NonNullable<NextConfig["images"]>["remotePatterns"]
>;

/**
 * The Storage prefix under which PUBLIC media objects are served. Narrowing to
 * this exact prefix — rather than to the host, or to `/storage/v1/**` — is what
 * confines the optimizer to the one bucket whose contents are, by definition,
 * referenced by published content.
 */
const PUBLIC_MEDIA_OBJECT_PREFIX = "/storage/v1/object/public/media";

/**
 * THE ENVIRONMENT IS READ THROUGH `lib/env.ts`, NOT FROM `process.env`.
 *
 * `lib/env.ts` is the project's single reader of `process.env` — every
 * application module, `proxy.ts` and this file included, asks it instead — and
 * the lint configuration enforces that with a restricted-syntax rule that
 * pointedly does not exempt this file. The import above is what makes that
 * invariant true here rather than merely asserted.
 *
 * Importing an application module from a config file is safe in this one
 * direction because `lib/env.ts` was written for it: it imports neither
 * `server-only` — which throws in the plain Node context a config file is
 * evaluated in — nor `next/headers`, and it contains no top-level `throw`. Its
 * own header records this file as the reason for both constraints, so the
 * coupling is a stated contract on both sides rather than an assumption made
 * on one.
 *
 * `getSupabaseUrl()` is total: unset, blank and schema-invalid values all
 * resolve to `undefined`, with an invalid one additionally recorded as a typed
 * issue and logged once. Nothing here can throw on a missing variable, which is
 * what keeps the keyless build the migration guarantees — proven by the CI job
 * that builds with no Supabase variables set at all — working. A config that
 * threw on an absent variable is the reference implementation's headline
 * weakness reappearing in a new place.
 *
 * `getSupabaseProjectHost()` exists next to it and returns host-plus-port
 * directly, but it is deliberately not used here: the scheme is load-bearing
 * below, where a non-`https:` URL must be refused rather than accommodated, and
 * that accessor discards it.
 */

/**
 * Builds the image optimizer's remote allowlist from the configured Supabase
 * project URL.
 *
 * Three properties matter, and each is a decision rather than a default:
 *
 * 1. EXACTNESS. The pattern names the one configured host — derived from the
 *    URL actually in force — its port, and the public media prefix. A wildcard
 *    subdomain pattern over the provider's own domain would let the optimizer
 *    fetch from any tenant project on the internet and cache the result under
 *    this origin, so no wildcard host appears anywhere in this file.
 * 2. NO PRIVATE BUCKET. There is deliberately no pattern for `media-private`
 *    or for the `media-trash/` prefix. A signed Storage URL handed to
 *    `next/image` becomes a durable, cacheable, unauthenticated
 *    `/_next/image` URL whose cache outlives the signature, so a draft
 *    photograph would become permanently public. Private objects are served
 *    exclusively through the session-checked `/api/media/**` route, which sets
 *    `private, no-store` and renders `unoptimized`. If a private image fails
 *    to load, the fix is that route or the object's bucket — never a wider
 *    pattern here.
 * 3. TOTALITY. With no URL configured, or one that does not parse, or one that
 *    is not `https:`, the result is an empty array and the build proceeds. In
 *    the keyless state the site renders from committed fallback JSON with
 *    images served from `public/assets/**`, which are local and need no remote
 *    pattern at all.
 *
 * On that last clause: a non-`https:` URL is refused rather than accommodated.
 * A local stack emits an `http://127.0.0.1:<port>` URL, and admitting it would
 * require `dangerouslyAllowLocalIP`, which opens the optimizer onto loopback
 * and private-range addresses. That is a production-wide SSRF footgun traded
 * for a local-development convenience, so local Storage objects simply are not
 * optimized — a loud, local-only failure instead of a quiet, global weakening.
 */
function supabaseMediaRemotePatterns(
  rawUrl: string | undefined,
): ImageRemotePatterns {
  if (rawUrl === undefined) {
    return [];
  }

  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }

  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    return [];
  }

  return [
    {
      protocol: "https",
      hostname: parsed.hostname,
      // An empty string means "the scheme's default port", which is the normal
      // case for a hosted project. Carrying the value through keeps the
      // pattern exact instead of matching the host on any port.
      port: parsed.port,
      pathname: `${PUBLIC_MEDIA_OBJECT_PREFIX}/**`,
    },
  ];
}

const nextConfig: NextConfig = {
  /**
   * Surfaces the double-invoke and deprecation checks in development. It has
   * no effect on a production build, so there is no cost to leaving it on.
   */
  reactStrictMode: true,

  /**
   * Suppresses the `X-Powered-By: Next.js` response header. Advertising the
   * framework and its presence to every visitor buys nothing and hands a
   * scanner one fewer thing to fingerprint.
   */
  poweredByHeader: false,

  /**
   * Gzip for self-hosted responses. Vercel compresses at the edge, so this is
   * belt and braces there, but it is what keeps a `next start` deployment or a
   * local production run honest against the byte budgets the CI gate asserts.
   */
  compress: true,

  /**
   * Cache Components — the single most consequential line in this file.
   *
   * Next.js 16 caches nothing implicitly: routes are dynamic unless something
   * opts them in, and the `use cache` directive together with the `cacheLife`
   * and `cacheTag` APIs is UNAVAILABLE without this flag, which defaults to
   * false. The whole content-read design depends on it — every anonymous read
   * in `lib/content/cached/**` is a `use cache` function tagged by table and
   * row, invalidated by `updateTag` from a Server Action so an editor gets
   * read-your-writes with no deploy.
   *
   * The failure mode if this were omitted is silent, which is why it is
   * commented at length rather than left as a bare boolean: nothing errors,
   * every cached reader simply degrades into a plain function, and the site
   * quietly issues a database round trip per render.
   *
   * The option is TOP-LEVEL, not under `experimental`. That is verified
   * against the pinned `next@16.3.3` rather than assumed: the framework
   * annotates `experimental.cacheComponents` as deprecated in favour of the
   * top-level form and warns that the option has moved out of experimental, so
   * the experimental placement would both warn and misrepresent intent.
   *
   * Note the deliberate consequence: pages themselves stay dynamic. That is
   * what allows a per-request CSP nonce, and therefore a script policy that
   * grants no blanket inline-script exemption at all. Anonymous *data* comes
   * from the cache, so a public page
   * render is a template render rather than a database round trip — the cost
   * is that HTML is not served from the CDN edge, and for a single school's
   * traffic that trade is clearly worth taking.
   */
  cacheComponents: true,

  /**
   * The image optimizer — the mechanism that repairs the site's single largest
   * measured defect.
   *
   * The legacy baseline, in Lighthouse transferred bytes: the home page shipped
   * 12,843,003 bytes across 40 requests, of which 10,471,625 (81.5%) were
   * images, with zero `srcset` attributes anywhere on the site. All five hero
   * JPEGs downloaded on every load though one is ever visible — 5,990,000
   * bytes — and the largest, 4032x3024, was rendered into an 1152x846 box for
   * 3,770,000 bytes on its own. The budget this configuration serves is
   * <= 800,000 bytes of images on first load and <= 250,000 bytes for the
   * largest single image at any breakpoint.
   *
   * The built-in optimizer does this work rather than Supabase Storage
   * transformations, which require a paid plan and emit WebP only. The
   * optimizer works on any plan and produces AVIF and WebP with a full
   * `srcset`. Neither the custom-loader option nor its companion loader-file
   * path is set here: a custom loader would bypass optimization entirely while
   * appearing to configure it, which is the worst of both. `unoptimized` is
   * likewise never set — the one place optimization is skipped is the
   * private-media route, which opts out per image rather than globally.
   */
  images: {
    /**
     * AVIF first, then WebP. The framework default is WebP alone, so AVIF has
     * to be asked for; it is materially smaller at equal quality on exactly
     * the kind of large photographic content this site is made of.
     */
    formats: ["image/avif", "image/webp"],

    /**
     * Candidate widths for viewport-sized images (`sizes` containing a `vw`
     * unit, and the full-bleed heroes). The set spans the project's five
     * breakpoints — 576 / 768 / 992 / 1200 / 1400 — with 640/750/828 covering
     * phones at 1x-3x, 1080/1200 the tablet and small-desktop range, and
     * 1920/2048/3840 the large and retina desktop cases. Every entry is a real
     * `srcset` candidate; against a baseline of zero `srcset` attributes,
     * breadth here is the point.
     */
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],

    /**
     * Candidate widths for fixed-size images: portraits, card thumbnails,
     * avatars and the polaroid frame. The 203px rendered portraits that
     * currently pull down 1,790,000-byte originals resolve to the 256 entry.
     * 16 is included for icon-scale renderings the default set omits.
     */
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],

    /**
     * Next.js 16 requires quality values to be declared before `next/image`
     * may request them, which makes this an allowlist rather than a hint: a
     * request for an undeclared quality is refused, so an arbitrary `q`
     * parameter cannot be used to multiply the optimizer's cache entries. 75
     * is the working default; the higher three exist for photography where the
     * default is visibly lossy.
     */
    qualities: [75, 85, 90, 95],

    /**
     * SVG is never passed through the optimizer. An SVG is a script vector,
     * and the upload policy rejects the format outright, so nothing can
     * legitimately reach this path. The framework default is already `false`;
     * it is stated explicitly so that any future flip is a visible, reviewable
     * diff rather than the silent removal of a line.
     */
    dangerouslyAllowSVG: false,

    /**
     * Derived from the configured project URL, and empty when there is none.
     * The reasoning — exactness, the deliberate absence of any private-bucket
     * pattern, and totality in the keyless state — is documented on
     * `supabaseMediaRemotePatterns` above.
     */
    remotePatterns: supabaseMediaRemotePatterns(getSupabaseUrl()),
  },

  /**
   * The four nonce-independent security headers, applied to every response.
   *
   * Four is the whole set, and the count is a contract rather than a
   * coincidence: a header whose value varies per request cannot be expressed
   * here, so the per-request policies live in `proxy.ts` and only these
   * constant ones live in the framework config. Concretely, and repeated at the
   * point of temptation because this is where a well-meant addition would go:
   *
   *   - NO content security policy, in either the enforcing or the
   *     report-only form. `proxy.ts` builds the policy around a per-request
   *     nonce and chooses the header name from `CSP_MODE`. A second policy
   *     emitted here would be intersected with that one by the browser, and
   *     the failure would be silent.
   *   - NO transport-security header. `proxy.ts` derives it from the
   *     `HSTS_MAX_AGE` enumeration, so the staged rollout has one source of
   *     truth and can never accidentally carry a subdomain directive or a
   *     preload directive — the latter being effectively irreversible.
   *   - NO reporting-endpoints group. The report-only rollout's reporting
   *     group is part of the policy `proxy.ts` builds, and a group declared
   *     without the matching policy collects nothing.
   *
   * `X-Powered-By` is suppressed by `poweredByHeader` above rather than by an
   * entry here, because it is a framework flag rather than a header this file
   * adds.
   */
  async headers() {
    return [
      {
        // Every path. Static assets and the optimizer's own responses are
        // included deliberately: `nosniff` and a referrer policy are as
        // correct on an image as on a document, and there is no per-request
        // work in this list for an excluded path to save.
        source: "/(.*)",
        headers: [
          {
            // Stops a browser from second-guessing a declared Content-Type,
            // which is the mechanism behind serving a document as script.
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            // Send the full URL only to same-origin destinations; send the
            // origin alone on a cross-origin HTTPS request, and nothing at all
            // on a downgrade. The stricter modern default, and it keeps page
            // paths — including admin and draft-preview paths — out of the
            // referrer headers reaching the analytics and embed vendors.
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            // No page on this site asks for a camera, a microphone or a
            // location, so all three are denied outright rather than left to
            // the browser's default prompt. An empty allowlist denies the
            // feature to this document and to every frame it embeds.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            // Retained alongside the CSP's `frame-ancestors 'self'` for agents
            // that do not implement that directive. The two agree by design;
            // where a browser honours both, the CSP wins.
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
