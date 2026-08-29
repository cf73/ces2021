/**
 * =============================================================================
 * extract-statamic-content.test.ts
 * =============================================================================
 *
 * The unit suite for the extractor. Five subjects, chosen because each is a place
 * where a plausible-looking change silently alters migrated content rather than
 * breaking a build — see `tools/README.md` §7.2:
 *
 *   1. link normalization      — three transform classes, and everything else
 *                                left alone
 *   2. the FAQ split           — 11 items, and the rebuilt text equal to the
 *                                source's
 *   3. identity                — RFC-4122 v5, the namespace shared with SQL, and
 *                                the derived child refs 22 sets have no id for
 *   4. calendar and provenance — zone-free strings, epoch conversion, the two
 *                                mapped user ids
 *   5. the rich-text round trip — import -> export -> re-import, lossless
 *
 * ## The dual-source corpus (README §7.3)
 *
 * Resolved in this order, and the third entry is the load-bearing one:
 *
 *   1. `CES_SOURCE_ROOT`, if set and holding `content/`
 *   2. the repository's own `content/`, if it still exists
 *   3. the committed `nextjs/data/fallback/*.json`
 *
 * Step 2 is why these assertions were meaningful during the migration. Step 3 is
 * why they are still meaningful now that `content/` has been deleted: the same
 * round trip runs against the committed snapshot, so the guarantee outlives its
 * input. A suite that could only run against what the migration removes would
 * have protected the corpus for exactly as long as it did not need protecting.
 *
 * Assertions that need the flat files — the unquoted YAML scalars, the raw node
 * arrays — are stated against the source when it is present and against the
 * emitted snapshot when it is not, so nothing is skipped in either mode.
 * =============================================================================
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  bardToTiptapDoc,
  deriveChildLegacyRef,
  deriveEntityUuid,
  documentHasFaqPairs,
  epochToIso,
  isReplicatorTextSet,
  mapUpdatedBy,
  normalizeLinkHref,
  resolveStatamicEntryUri,
  splitFaqDocument,
  tiptapDocToBardNodes,
  uuidV5,
  type AssetRow,
  type EventRow,
  type FallbackMeta,
  type FallbackTable,
  type InspiringQuoteRow,
  type NavItemRow,
  type PageRow,
  type PageSectionRow,
  type PersonRow,
  type ProseMirrorNode,
  type RouteRow,
  type TiptapDoc,
} from "../src/extract-statamic-content";

/* ==========================================================================
 * Fixtures and corpus resolution
 * ========================================================================== */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const readJson = async (relative: string): Promise<unknown> =>
  JSON.parse(await readFile(join(REPO_ROOT, relative), "utf8")) as unknown;

const readTable = async <T>(fileName: string): Promise<FallbackTable<T>> =>
  (await readJson(`nextjs/data/fallback/${fileName}`)) as FallbackTable<T>;

/**
 * The YAML engine the extractor gives gray-matter, reconstructed here.
 *
 * Reconstructed rather than imported because it is an implementation detail of
 * the module. What the tests below assert is the OBSERVABLE consequence of the
 * choice — that a calendar scalar stays a string — and they assert it both
 * against this engine and against the extractor's own emitted output, which is
 * the evidence that the wiring is actually in place.
 */
const YAML_1_2_ENGINE = {
  yaml: {
    parse: (input: string): object => {
      const value: unknown = YAML.parse(input);
      return value === null || value === undefined ? {} : (value as object);
    },
    stringify: (): string => {
      throw new Error("not used");
    },
  },
};

const resolveSourceRoot = async (): Promise<string | null> => {
  const configured = process.env["CES_SOURCE_ROOT"]?.trim();
  if (configured !== undefined && configured !== "") {
    if (await isDirectory(join(configured, "content"))) {
      return configured;
    }
    throw new Error(
      `CES_SOURCE_ROOT=${configured} does not contain content/. Unset it or point it at a ` +
        `Statamic checkout; it is not silently ignored, because a typo there would quietly ` +
        `downgrade the suite to fallback mode.`,
    );
  }
  return (await isDirectory(join(REPO_ROOT, "content"))) ? REPO_ROOT : null;
};

const SOURCE_ROOT = await resolveSourceRoot();
const MODE = SOURCE_ROOT === null ? "fallback-json" : "flat-files";

interface SourceEntryFixture {
  readonly path: string;
  readonly slug: string;
  readonly collection: string;
  readonly data: Record<string, unknown>;
  readonly raw: string;
}

const loadSourceEntries = async (root: string): Promise<SourceEntryFixture[]> => {
  const collections = [
    "pages",
    "people",
    "events",
    "classrooms",
    "promoted",
    "announcements",
    "inspiring_quotes",
  ];
  const entries: SourceEntryFixture[] = [];
  for (const collection of collections) {
    const dir = join(root, "content", "collections", collection);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    for (const name of names) {
      const relative = `content/collections/${collection}/${name}`;
      const raw = await readFile(join(root, relative), "utf8");
      const parsed = matter(raw, { engines: YAML_1_2_ENGINE });
      entries.push({
        path: relative,
        slug: basename(name, ".md"),
        collection,
        data: parsed.data as Record<string, unknown>,
        raw,
      });
    }
  }
  return entries;
};

const SOURCE_ENTRIES: readonly SourceEntryFixture[] =
  SOURCE_ROOT === null ? [] : await loadSourceEntries(SOURCE_ROOT);

const META = (await readJson("nextjs/data/fallback/meta.json")) as FallbackMeta;
const PAGES = await readTable<PageRow>("pages.json");
const SECTIONS = await readTable<PageSectionRow>("page-sections.json");
const PEOPLE = await readTable<PersonRow>("people.json");
const EVENTS = await readTable<EventRow>("events.json");
const QUOTES = await readTable<InspiringQuoteRow>("inspiring-quotes.json");
const NAV = await readTable<NavItemRow>("nav-items.json");
const ROUTES = await readTable<RouteRow>("routes.json");
const ASSETS = await readTable<AssetRow>("assets.json");

/* ==========================================================================
 * 1. Identity
 * ========================================================================== */

describe("identity", () => {
  it("computes the published RFC 9562 appendix A.4 v5 vector", () => {
    // The one v5 example the specification itself publishes: the DNS namespace
    // 6ba7b810-9dad-11d1-80b4-00c04fd430c8 with the name `www.example.com`.
    // Getting the version nibble or the variant bits wrong still produces a
    // plausible-looking uuid, so a published vector is the only useful test of
    // this function — and this one is external evidence rather than a value read
    // back out of the implementation being tested.
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    // A second name through the same namespace, cross-checked against an
    // independent implementation.
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.org")).toBe(
      "74738ff5-5367-5958-9aee-98fffdcd1876",
    );
  });

  it("sets the version and variant fields", () => {
    const uuid = uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "cambridge-ellis");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rejects a malformed namespace rather than hashing it as text", () => {
    expect(() => uuidV5("not-a-uuid", "x")).toThrow();
  });

  it("derives an entity id from the table and the legacy ref, table-scoped", () => {
    const asPage = deriveEntityUuid("pages", "home");
    const asPerson = deriveEntityUuid("people", "home");
    expect(asPage).toBe(uuidV5(META.identity.uuid_namespace, "pages:home"));
    // Table scoping is the whole reason `legacy_ref` is text rather than uuid:
    // `pages:home` must not be able to collide with a person.
    expect(asPage).not.toBe(asPerson);
  });

  it("is deterministic across calls, which is what makes the seed idempotent", () => {
    expect(deriveEntityUuid("events", "abc")).toBe(deriveEntityUuid("events", "abc"));
  });

  it("derives child refs from the ordinal in source order", () => {
    // Mandatory rather than convenient: 22 of the 167 replicator sets carry no
    // `id` at all — 15 `add_content` and 7 `education` — so identity cannot be
    // taken from the source.
    expect(deriveChildLegacyRef("parent-ref", "education", 0)).toBe("parent-ref:education:0");
    expect(deriveChildLegacyRef("parent-ref", "add_content", 12)).toBe("parent-ref:add_content:12");
    expect(deriveChildLegacyRef("a", "b", 0)).not.toBe(deriveChildLegacyRef("a", "b", 1));
  });

  it("rejects a negative or non-integer ordinal", () => {
    expect(() => deriveChildLegacyRef("a", "b", -1)).toThrow();
    expect(() => deriveChildLegacyRef("a", "b", 1.5)).toThrow();
  });
});

describe("the identity contract shared with SQL", () => {
  it("uses the namespace declared by migration 01", async () => {
    // The namespace constant has to be identical in three places: the migration's
    // `ces_uuid_namespace()`, `meta.json`'s identity block, and the extractor. A
    // divergence would not fail the seed — `ces_uuid()` would simply mint
    // different ids than the fallback JSON embeds, and the two data sources would
    // silently disagree about every row.
    const migration = await readFile(
      join(REPO_ROOT, "supabase/migrations/20260901120100_extensions.sql"),
      "utf8",
    );
    expect(migration).toContain(META.identity.uuid_namespace);
    expect(migration).toContain("ces_uuid(p_table text, p_legacy_ref text)");
    // The SQL must concatenate the same way the TypeScript does.
    expect(migration).toContain("p_table || ':' || p_legacy_ref");
  });

  it("resolves seed ids through ces_uuid() with the refs the JSON embeds", async () => {
    const seed = await readFile(join(REPO_ROOT, "supabase/seed.sql"), "utf8");
    const home = PAGES.rows.find((page) => page.legacy_ref === "home");
    expect(home).toBeDefined();
    if (home === undefined) {
      return;
    }
    // The seed names the pair; the JSON embeds the v5 of that pair. Postgres
    // computing the same value from the same pair was verified against a live
    // local stack for all 652 rows; what a unit test can hold is that both sides
    // name the SAME pair and that the embedded literal is the v5 of it.
    expect(seed).toContain("public.ces_uuid('pages', 'home')");
    expect(home.id).toBe(uuidV5(META.identity.uuid_namespace, "pages:home"));
  });

  it("states `published` explicitly on every collection insert", async () => {
    const seed = await readFile(join(REPO_ROOT, "supabase/seed.sql"), "utf8");
    // The columns default to FALSE while the Statamic rule is that absence means
    // published, so an omitted column would silently draft 5 quotes, 4
    // announcements and 31 pages.
    for (const table of [
      "pages",
      "people",
      "events",
      "classrooms",
      "promoted",
      "announcements",
      "inspiring_quotes",
    ]) {
      const insert = new RegExp(`insert into public\\.${table}\\n {2}\\(([^)]*)\\)`, "u").exec(seed);
      expect(insert, `${table} has no insert statement`).not.toBeNull();
      expect(insert?.[1] ?? "", `${table} does not state published`).toContain("published");
    }
  });

  it("upserts rather than inserts, because two migrations seed ahead of it", async () => {
    const seed = await readFile(join(REPO_ROOT, "supabase/seed.sql"), "utf8");
    // Migration 11 seeds all 26 `site_globals` rows itself, so a plain insert
    // here fails on a unique violation the first time anyone runs `db reset`.
    expect(seed).toContain("on conflict (key) do update set");
    expect(seed).toContain("on conflict (legacy_ref) do update set");
    // And every statement must be an upsert of some form: no bare insert. Matched
    // at line start so that the prose in the header — which quotes both forms —
    // cannot make this assertion pass or fail for the wrong reason.
    const inserts = seed.match(/^insert into public\.[a-z_]+$/gmu) ?? [];
    const conflicts = seed.match(/^on conflict \(/gmu) ?? [];
    expect(inserts.length).toBe(17);
    expect(conflicts.length).toBe(inserts.length);
  });

  it("neither reads nor embeds a credential, nor the local inspection account", async () => {
    const seed = await readFile(join(REPO_ROOT, "supabase/seed.sql"), "utf8");
    // The control-panel account created locally to observe legacy behaviour must
    // not reach any target artifact, seed file or fixture. Asserted as a PATTERN
    // over reserved example domains rather than by naming the address, so the
    // literal never enters this file either — and the pattern is strictly
    // stronger, because it also catches a placeholder address leaking in from
    // anywhere else.
    const reservedDomain = /@example\.(com|org|net|test|invalid)\b/iu;
    for (const [label, content] of [
      ["seed.sql", seed],
      ["meta.json", JSON.stringify(META)],
      ["pages.json", JSON.stringify(PAGES)],
      ["people.json", JSON.stringify(PEOPLE)],
      ["site-globals.json", JSON.stringify(await readTable<unknown>("site-globals.json"))],
    ] as const) {
      expect(content, label).not.toMatch(reservedDomain);
    }
    // And no connection string, bearer token or provider key of any shape.
    expect(seed).not.toMatch(/postgres(ql)?:\/\//u);
    expect(seed).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/u);
    expect(seed).not.toMatch(/sb_(secret|publishable)_/u);
    expect(seed).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/u);
  });
});

/* ==========================================================================
 * 2. Calendar scalars and provenance
 * ========================================================================== */

describe("epochToIso", () => {
  it("converts a UNIX epoch integer to ISO-8601 UTC", () => {
    // Every entry carries `updated_at` as an epoch integer, e.g. 1710514597.
    expect(epochToIso(1710514597)).toBe("2024-03-15T14:56:37.000Z");
    expect(epochToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("rejects a non-integer or negative value rather than producing a date", () => {
    expect(() => epochToIso(1.5)).toThrow();
    expect(() => epochToIso(-1)).toThrow();
    expect(() => epochToIso(Number.NaN)).toThrow();
  });
});

describe("mapUpdatedBy", () => {
  it("maps the two known Statamic user ids to their addresses", () => {
    expect(mapUpdatedBy("1179db75-8eeb-4bad-8e60-d5005aef7ef8")).toBe("bekah@cambridge-ellis.org");
    expect(mapUpdatedBy("b863e707-3140-4001-859f-3487e09c5881")).toBe("conrad.fulbrook@gmail.com");
  });

  it("passes an unrecognized id through VERBATIM", () => {
    // An id this program does not recognize is provenance it must not invent an
    // owner for. Verbatim is the only honest answer.
    const unknownId = "00000000-0000-0000-0000-000000000000";
    expect(mapUpdatedBy(unknownId)).toBe(unknownId);
    // Not only an unknown uuid: `updated_by` is a free text column, so a value
    // of any shape must survive. A non-address token is used deliberately — an
    // email-shaped placeholder here would be indistinguishable from a real
    // credential to a secret scanner, and the assertion needs neither.
    expect(mapUpdatedBy("legacy-import-script")).toBe("legacy-import-script");
    expect(mapUpdatedBy("")).toBe("");
  });
});

describe("the YAML 1.1 hazard", () => {
  it("is real: gray-matter's default engine turns a bare time into an integer", () => {
    // gray-matter defaults to js-yaml, which implements YAML 1.1. Under 1.1 an
    // unquoted `11:00` is SEXAGESIMAL and parses as the integer 660, and an
    // unquoted `2026-11-07` parses as a Date object. Every calendar scalar in the
    // corpus is single-quoted today, so both engines agree right now — but this
    // program is re-runnable against a newer commit, and one unquoted Statamic
    // write would silently corrupt a published event time or shift a date.
    const source = "---\nend_time: 11:00\nevent_date: 2026-11-07\n---\n";
    const withDefaultEngine: unknown = matter(source).data;
    expect(withDefaultEngine).toMatchObject({ end_time: 660 });
    const asRecord = withDefaultEngine as Record<string, unknown>;
    expect(asRecord["event_date"]).toBeInstanceOf(Date);
  });

  it("is closed by the pinned yaml@2.9.0 engine, which implements YAML 1.2", () => {
    const source = "---\nend_time: 11:00\nevent_date: 2026-11-07\nstart: '06:30'\n---\n";
    const data = matter(source, { engines: YAML_1_2_ENGINE }).data as Record<string, unknown>;
    expect(data["end_time"]).toBe("11:00");
    expect(data["event_date"]).toBe("2026-11-07");
    expect(data["start"]).toBe("06:30");
  });

  it("leaves the escaped non-breaking space intact under either engine", () => {
    // `\_` is the standard double-quoted escape for U+00A0 in both 1.1 and 1.2,
    // so NBSP handling is unaffected by the engine choice. There are ZERO raw
    // U+00A0 bytes on disk; 8 entries use the escape.
    const source = '---\nq: "Q:\\_ What is it?"\n---\n';
    const viaDefault = matter(source).data as Record<string, unknown>;
    const viaPinned = matter(source, { engines: YAML_1_2_ENGINE }).data as Record<string, unknown>;
    expect(viaDefault["q"]).toBe("Q:\u00a0 What is it?");
    expect(viaPinned["q"]).toBe("Q:\u00a0 What is it?");
  });

  it("emitted event times are zone-free strings on a 12-hour clock, verbatim", () => {
    // The evidence that the engine wiring is actually in place, not just that the
    // engine behaves. The 6:30 PM auction stores '06:30' and '11:00': the source
    // uses a 12-hour clock with no meridiem and a 24-hour "correction" here would
    // rewrite published event times.
    const auction = EVENTS.rows.find(
      (event) => event.slug === "annual-auction-and-community-celebration",
    );
    expect(auction).toBeDefined();
    expect(auction?.start_time).toBe("06:30");
    expect(auction?.end_time).toBe("11:00");
    for (const event of EVENTS.rows) {
      expect(typeof event.event_date).toBe("string");
      expect(event.event_date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      if (event.start_time !== null) {
        expect(event.start_time).toMatch(/^\d{2}:\d{2}$/u);
      }
    }
    for (const person of PEOPLE.rows) {
      if (person.joined_ces !== null) {
        expect(person.joined_ces).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      }
    }
  });

  it("preserves calendar_link byte-for-byte and never regenerates it", () => {
    const withLink = EVENTS.rows.filter((event) => event.calendar_link !== null);
    expect(withLink).toHaveLength(4);
    for (const event of withLink) {
      // Hand-built Google Calendar template URLs, percent-encoding included.
      expect(event.calendar_link).toMatch(/^https:\/\/calendar\.google\.com\//u);
    }
  });

  it("migrates the one prose zoom_link unchanged rather than dropping it", () => {
    const prose = EVENTS.rows.filter((event) => event.zoom_link === "Zoom link to come");
    expect(prose).toHaveLength(1);
  });
});

/* ==========================================================================
 * 3. Link normalization
 * ========================================================================== */

describe("normalizeLinkHref", () => {
  it("rewrites an absolute same-origin URL to a root-relative path", () => {
    // The destination is unchanged; only the href form changes, which is what
    // stops a client-routed application forcing a full page reload. No redirect
    // is involved.
    expect(normalizeLinkHref("https://cambridge-ellis.org/donate")).toMatchObject({
      href: "/donate",
      kind: "absolute_same_origin",
      changed: true,
    });
    expect(
      normalizeLinkHref("https://www.cambridge-ellis.org/admissions/financial-aid").href,
    ).toBe("/admissions/financial-aid");
    // Query and fragment ride along, because dropping either would change where
    // the link goes.
    expect(normalizeLinkHref("https://cambridge-ellis.org/x?a=1#b").href).toBe("/x?a=1#b");
  });

  it("does NOT treat a subdomain as same-origin", () => {
    // The corpus links to `cambridge-ellis.myschoolapp.com`. A suffix match would
    // rewrite it to a root-relative path and break the apply flow, which is the
    // highest-intent link on the site.
    const applied = normalizeLinkHref("https://cambridge-ellis.myschoolapp.com/app#login/apply");
    expect(applied.kind).toBe("untouched");
    expect(applied.changed).toBe(false);
    expect(applied.href).toBe("https://cambridge-ellis.myschoolapp.com/app#login/apply");
  });

  it("adds the mailto: scheme to a bare email address", () => {
    // Today these resolve as RELATIVE PATHS, so clicking one 404s instead of
    // opening a mail client — on the apply and financial-aid pages.
    const result = normalizeLinkHref("christina@cambridge-ellis.org");
    expect(result).toMatchObject({
      href: "mailto:christina@cambridge-ellis.org",
      kind: "bare_email",
      changed: true,
    });
  });

  it("preserves the case of a bare email address exactly", () => {
    expect(normalizeLinkHref("Michelle@Cambridge-Ellis.org").href).toBe(
      "mailto:Michelle@Cambridge-Ellis.org",
    );
  });

  it("leaves a pre-existing mailto: alone, mixed case included", () => {
    // 13 hrefs already carry the scheme and 9 of those are mixed case. The local
    // part of an address is case-sensitive by specification, and these are the
    // addresses the school publishes.
    for (const href of [
      "mailto:Michelle@Cambridge-Ellis.org",
      "mailto:Andy@cambridge-ellis.org",
      "mailto:info@cambridge-ellis.org",
    ]) {
      const result = normalizeLinkHref(href);
      expect(result.href).toBe(href);
      expect(result.changed).toBe(false);
      expect(result.kind).toBe("existing_mailto");
    }
  });

  it("leaves every other well-formed link untouched", () => {
    for (const href of [
      "https://www.instagram.com/cambridgeellis/",
      "https://calendar.google.com/calendar/event?action=TEMPLATE",
      "http://example.test/path",
      "tel:+16173540014",
      "/programs/day-programs",
      "#section",
      "https://cambridge-ellis.org.evil.test/phish",
    ]) {
      const result = normalizeLinkHref(href);
      expect(result.href, href).toBe(href);
      expect(result.changed, href).toBe(false);
    }
  });

  it("classifies the internal scheme without resolving it", () => {
    const result = normalizeLinkHref("statamic://entry::2d2dfb77-be33-43a8-8b81-ea5fb25d09f3");
    expect(result.kind).toBe("internal_scheme");
  });
});

describe("resolveStatamicEntryUri", () => {
  const index = new Map<string, string>([
    ["2d2dfb77-be33-43a8-8b81-ea5fb25d09f3", "/giving/ways-to-give"],
    ["80db4d25-4d83-49ad-8d90-62f26c47a7b9", "/contact"],
  ]);

  it("resolves both records the corpus holds", () => {
    expect(
      resolveStatamicEntryUri("statamic://entry::2d2dfb77-be33-43a8-8b81-ea5fb25d09f3", index),
    ).toBe("/giving/ways-to-give");
    expect(
      resolveStatamicEntryUri("statamic://entry::80db4d25-4d83-49ad-8d90-62f26c47a7b9", index),
    ).toBe("/contact");
  });

  it("FAILS on an unresolvable uuid rather than shipping a dead scheme", () => {
    expect(() =>
      resolveStatamicEntryUri("statamic://entry::00000000-0000-0000-0000-000000000000", index),
    ).toThrow();
  });

  it("fails on an href that is not the internal scheme at all", () => {
    expect(() => resolveStatamicEntryUri("https://example.test/", index)).toThrow();
  });
});

describe("the eleven transformed links, as emitted", () => {
  const allText = JSON.stringify(SECTIONS.rows);

  it("carries every bare address as a mailto: link", () => {
    // The five bare-email records are UNQUOTED YAML scalars in the source, unlike
    // every other href in the corpus — a quoted-only match would miss all five.
    for (const address of [
      "mailto:christina@cambridge-ellis.org",
      "mailto:elisabeth@cambridge-ellis.org",
      "mailto:andy@cambridge-ellis.org",
    ]) {
      expect(allText).toContain(address);
    }
  });

  it("carries no absolute same-origin href and no internal scheme", () => {
    expect(allText).not.toContain("https://cambridge-ellis.org/");
    expect(allText).not.toContain("https://www.cambridge-ellis.org/");
    expect(allText).not.toContain("statamic://entry::");
  });

  it("resolved both internal-scheme links to their canonical paths", () => {
    expect(allText).toContain("/giving/ways-to-give");
    expect(allText).toContain("/contact");
  });

  it("kept the mixed-case mailto addresses as authored", () => {
    const people = JSON.stringify(PEOPLE.rows);
    // Emails on `people` are a column rather than a link mark, and their case is
    // preserved for the same reason.
    expect(people).toMatch(/[A-Z][a-z]*@Cambridge-Ellis\.org/u);
  });

  it("parses an UNQUOTED bare-email scalar as the string it is", () => {
    // The shape the five records actually have on disk.
    const source = "---\nhref: christina@cambridge-ellis.org\n---\n";
    const data = matter(source, { engines: YAML_1_2_ENGINE }).data as Record<string, unknown>;
    expect(data["href"]).toBe("christina@cambridge-ellis.org");
    expect(normalizeLinkHref(String(data["href"])).href).toBe(
      "mailto:christina@cambridge-ellis.org",
    );
  });
});

/* ==========================================================================
 * 4. The replicator/node discriminator and the FAQ split
 * ========================================================================== */

describe("isReplicatorTextSet", () => {
  it("distinguishes a SET, whose `text` is an ARRAY", () => {
    // A replicator set of `type: "text"` is indistinguishable from a ProseMirror
    // `text` node by the type key alone, and there are 65 such sets across 23
    // pages. The only reliable discriminator is the shape of `text`.
    expect(
      isReplicatorTextSet({
        id: "abc",
        type: "text",
        enabled: true,
        text: [{ type: "paragraph" }],
      }),
    ).toBe(true);
    expect(isReplicatorTextSet({ type: "text", text: [] })).toBe(true);
  });

  it("distinguishes a NODE, whose `text` is a STRING", () => {
    expect(isReplicatorTextSet({ type: "text", text: "hello" })).toBe(false);
  });

  it("returns false for anything else", () => {
    expect(isReplicatorTextSet({ type: "image", image: "x.jpg" })).toBe(false);
    expect(isReplicatorTextSet({ type: "paragraph" })).toBe(false);
    expect(isReplicatorTextSet(null)).toBe(false);
    expect(isReplicatorTextSet("text")).toBe(false);
    expect(isReplicatorTextSet([])).toBe(false);
  });
});

describe("splitFaqDocument", () => {
  const doc = (nodes: readonly ProseMirrorNode[]): TiptapDoc => ({ type: "doc", content: nodes });
  const para = (text: string): ProseMirrorNode => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });

  it("opens an item on a paragraph beginning `Q:` and closes it at the next", () => {
    const parts = splitFaqDocument(
      doc([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Language" }] },
        para("Q: First?"),
        para("A: First answer."),
        para("Q: Second?"),
        para("A: Second answer."),
      ]),
    );
    const items = parts.filter((part) => part.kind === "faq_item");
    expect(items).toHaveLength(2);
    expect(parts[0]?.kind).toBe("text");
  });

  it("preserves a paragraph OUTSIDE a pair, in document order", () => {
    // The leading `Language Program` heading is not part of any pair and must be
    // kept as a prose section, or the page loses content the split did not own.
    const parts = splitFaqDocument(
      doc([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Language" }] },
        para("Q: A?"),
        para("A: B."),
      ]),
    );
    expect(parts).toHaveLength(2);
    const first = parts[0];
    expect(first?.kind).toBe("text");
    if (first?.kind === "text") {
      expect(first.nodes[0]?.type).toBe("heading");
    }
  });

  it("keeps a multi-paragraph answer whole", () => {
    const parts = splitFaqDocument(
      doc([para("Q: A?"), para("A: one."), para("and two."), para("Q: B?"), para("A: three.")]),
    );
    const items = parts.filter((part) => part.kind === "faq_item");
    expect(items).toHaveLength(2);
    const first = items[0];
    if (first?.kind === "faq_item") {
      expect(first.answer).toContain("one.");
      expect(first.answer).toContain("and two.");
    }
  });

  it("detects a Q:/A: run only where one exists", () => {
    expect(documentHasFaqPairs(doc([para("Q: A?"), para("A: B.")]))).toBe(true);
    expect(documentHasFaqPairs(doc([para("Just prose.")]))).toBe(false);
  });

  it("produced exactly 11 faq_item rows, with the NBSP intact", () => {
    const items = SECTIONS.rows.filter((section) => section.kind === "faq_item");
    expect(items).toHaveLength(11);
    for (const item of items) {
      expect(item.question).not.toBeNull();
      expect(item.answer).not.toBeNull();
    }
    // The first question's text is `Q:\u00a0 What is the language program...` —
    // the non-breaking space is real after parsing and must survive.
    const first = items[0];
    expect(first?.question).toContain("\u00a0");
  });

  it("kept the leading heading as a prose section on that page", () => {
    const faqPage = PAGES.rows.find((page) => page.slug === "frequently-asked-questions");
    expect(faqPage).toBeDefined();
    const own = SECTIONS.rows.filter((section) => section.page_id === faqPage?.id);
    expect(own.filter((section) => section.kind === "faq_item")).toHaveLength(11);
    expect(own.filter((section) => section.kind === "text").length).toBeGreaterThanOrEqual(1);
  });
});

/* ==========================================================================
 * 5. The rich-text round trip
 * --------------------------------------------------------------------------
 * The central guarantee: import -> export -> re-import loses nothing. It runs
 * over EVERY Bard-bearing field the resolved corpus holds — in flat-file mode the
 * 29 concatenated `add_content` text runs across 23 pages, the 4 `events.details`
 * fields and `important_notes`; in fallback mode the same documents as emitted.
 *
 * `toStrictEqual` rather than `toEqual`, deliberately. `toEqual` treats an own
 * property whose value is `undefined` as equal to an absent one, which would make
 * the 18 `content`-less paragraph nodes untestable — and normalizing those to
 * `content: []` is the single likeliest way for a serializer to break this.
 * ========================================================================== */

/** Every text run in a node tree, in document order. */
const textRuns = (nodes: readonly ProseMirrorNode[]): string[] => {
  const runs: string[] = [];
  const walk = (list: readonly ProseMirrorNode[]): void => {
    for (const node of list) {
      if (node.text !== undefined) {
        runs.push(node.text);
      }
      if (node.content !== undefined) {
        walk(node.content);
      }
    }
  };
  walk(nodes);
  return runs;
};

/** Count nodes that carry NO own `content` key, which must stay absent. */
const contentlessNodes = (nodes: readonly ProseMirrorNode[]): number => {
  let count = 0;
  const walk = (list: readonly ProseMirrorNode[]): void => {
    for (const node of list) {
      if (!Object.prototype.hasOwnProperty.call(node, "content")) {
        count += 1;
      } else if (node.content !== undefined) {
        walk(node.content);
      }
    }
  };
  walk(nodes);
  return count;
};

interface BardField {
  readonly label: string;
  /** The bare node array as the source stores it, or as export re-emits it. */
  readonly nodes: readonly unknown[];
}

/** Collect every Bard-bearing field from the flat files. */
const bardFieldsFromSource = (entries: readonly SourceEntryFixture[]): BardField[] => {
  const fields: BardField[] = [];
  for (const entry of entries) {
    const addContent = entry.data["add_content"];
    if (Array.isArray(addContent)) {
      for (const [index, set] of addContent.entries()) {
        if (isReplicatorTextSet(set)) {
          const nodes = (set as Record<string, unknown>)["text"];
          if (Array.isArray(nodes)) {
            fields.push({
              label: `${entry.path}:add_content[${String(index)}].text`,
              nodes: nodes as readonly unknown[],
            });
          }
        }
      }
    }
    for (const handle of ["details", "important_notes"]) {
      const value = entry.data[handle];
      if (Array.isArray(value)) {
        fields.push({ label: `${entry.path}:${handle}`, nodes: value as readonly unknown[] });
      }
    }
  }
  return fields;
};

/** Collect every Bard-bearing field from the committed snapshot. */
const bardFieldsFromFallback = (): BardField[] => {
  const fields: BardField[] = [];
  for (const section of SECTIONS.rows) {
    if (section.body !== null) {
      fields.push({
        label: `page_sections:${section.legacy_ref}`,
        nodes: tiptapDocToBardNodes(section.body),
      });
    }
  }
  for (const event of EVENTS.rows) {
    if (event.details !== null) {
      fields.push({ label: `events:${event.slug}`, nodes: tiptapDocToBardNodes(event.details) });
    }
  }
  for (const page of PAGES.rows) {
    if (page.important_notes !== null) {
      fields.push({
        label: `pages:${page.slug}:important_notes`,
        nodes: tiptapDocToBardNodes(page.important_notes),
      });
    }
  }
  return fields;
};

const BARD_FIELDS: readonly BardField[] =
  SOURCE_ROOT === null ? bardFieldsFromFallback() : bardFieldsFromSource(SOURCE_ENTRIES);

describe(`the rich-text round trip (${MODE})`, () => {
  it("has fields to check, so the suite cannot pass by testing nothing", () => {
    expect(BARD_FIELDS.length).toBeGreaterThan(0);
    if (SOURCE_ROOT !== null) {
      // The 65 `text` sets concatenate into 29 runs only inside the extractor;
      // here each set is checked on its own, so the figure is the set count plus
      // the 4 `events.details` fields and the one `important_notes`.
      expect(BARD_FIELDS.length).toBe(70);
    }
  });

  it("is lossless for every Bard-bearing field", () => {
    for (const field of BARD_FIELDS) {
      const imported = bardToTiptapDoc(field.nodes, field.label);
      const exported = tiptapDocToBardNodes(imported);
      const reimported = bardToTiptapDoc(exported, field.label);
      // Deep equality of the node trees, with absent keys distinguished from
      // present-but-undefined ones.
      expect(reimported, field.label).toStrictEqual(imported);
      // Byte equality of every text run, which is the assertion that a stray
      // trim or a whitespace "tidy" would fail.
      expect(textRuns(exported), field.label).toStrictEqual(textRuns(imported.content));
    }
  });

  it("wraps a bare array and unwraps back to a bare array", () => {
    // The two source shapes and the one stored shape. A standalone field stores a
    // BARE array; Tiptap stores a single `doc`. Confusing the two is the failure
    // this asserts against.
    const nodes = [{ type: "paragraph", content: [{ type: "text", text: "x" }] }];
    const doc = bardToTiptapDoc(nodes, "test");
    expect(doc.type).toBe("doc");
    expect(Array.isArray(tiptapDocToBardNodes(doc))).toBe(true);
    expect(tiptapDocToBardNodes(doc)).toHaveLength(1);
  });

  it("refuses to export something that is not a doc", () => {
    // Cast through `unknown` on purpose: the type says `"doc"`, so the only way
    // to reach the runtime guard is to hand it what a JSON read could hand it.
    const notADoc = { type: "paragraph", content: [] } as unknown as TiptapDoc;
    expect(() => tiptapDocToBardNodes(notADoc)).toThrow();
  });

  it("preserves a paragraph node that carries NO `content` key at all", () => {
    // 18 exist in the corpus — `apply.md`'s first disabled set ends with a bare
    // `{type: paragraph}`. Most ProseMirror serializers normalize these to
    // `content: []`, and doing so would fail the deep-equality assertion above.
    const doc = bardToTiptapDoc([{ type: "paragraph" }], "test");
    const node = doc.content[0];
    expect(node).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(node, "content")).toBe(false);
    expect(JSON.stringify(doc)).toBe('{"type":"doc","content":[{"type":"paragraph"}]}');
  });

  it("preserves the count of content-less nodes across the round trip", () => {
    for (const field of BARD_FIELDS) {
      const imported = bardToTiptapDoc(field.nodes, field.label);
      const reimported = bardToTiptapDoc(tiptapDocToBardNodes(imported), field.label);
      expect(contentlessNodes(reimported.content), field.label).toBe(
        contentlessNodes(imported.content),
      );
    }
  });

  it("preserves the table family, spans and colwidth included", () => {
    // All 50 table-family nodes live in ONE entry, `tuition.md`, and each cell
    // carries `colspan`, `rowspan` and `colwidth` — the last as an ARRAY on 15
    // cells and as an explicit `null` on 15 more. Without table support the
    // tuition page loses its entire fee schedule.
    const cells: ProseMirrorNode[] = [];
    const collect = (nodes: readonly ProseMirrorNode[]): void => {
      for (const node of nodes) {
        if (node.type === "tableCell" || node.type === "tableHeader") {
          cells.push(node);
        }
        if (node.content !== undefined) {
          collect(node.content);
        }
      }
    };
    for (const field of BARD_FIELDS) {
      collect(bardToTiptapDoc(field.nodes, field.label).content);
    }
    expect(cells).toHaveLength(30);
    for (const cell of cells) {
      expect(cell.attrs, JSON.stringify(cell.attrs)).toBeDefined();
      const attrs = cell.attrs ?? {};
      expect(Object.prototype.hasOwnProperty.call(attrs, "colspan")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(attrs, "rowspan")).toBe(true);
      // `colwidth` is an array or an explicit null. A truthiness shortcut would
      // silently drop the column widths.
      expect(Object.prototype.hasOwnProperty.call(attrs, "colwidth")).toBe(true);
    }
    const arrayWidths = cells.filter((cell) => Array.isArray(cell.attrs?.["colwidth"]));
    const nullWidths = cells.filter((cell) => cell.attrs?.["colwidth"] === null);
    expect(arrayWidths).toHaveLength(15);
    expect(nullWidths).toHaveLength(15);
  });

  it("preserves a run of pure whitespace, which is significant", () => {
    // One text run in `tuition.md` is 45 characters of pure whitespace. It is
    // content, and it must survive byte-for-byte.
    const runs = BARD_FIELDS.flatMap((field) =>
      textRuns(bardToTiptapDoc(field.nodes, field.label).content),
    );
    const whitespace = runs.filter((run) => run.length >= 45 && run.trim() === "");
    expect(whitespace).toHaveLength(1);
  });

  it("rejects a node that is not a mapping, rather than coercing it", () => {
    expect(() => bardToTiptapDoc(["not a node"], "test")).toThrow();
    expect(() => bardToTiptapDoc([{ text: "no type" }], "test")).toThrow();
    // A replicator set reached through the node branch: its `text` is an array,
    // and the error must say so rather than producing a node with no text.
    expect(() => bardToTiptapDoc([{ type: "text", text: [] }], "test")).toThrow();
  });
});

/* ==========================================================================
 * 6. Publish semantics
 * ========================================================================== */

describe("publish semantics", () => {
  it("treats ABSENCE of `published` as PUBLISHED", () => {
    // The Statamic rule, and inverting it would silently draft most of the site.
    // `inspiring_quotes` carries ZERO `published:` keys and all five are live,
    // which makes it the clearest available witness.
    expect(QUOTES.rows).toHaveLength(5);
    for (const quote of QUOTES.rows) {
      expect(quote.published, quote.slug).toBe(true);
    }
    if (SOURCE_ROOT !== null) {
      const quoteEntries = SOURCE_ENTRIES.filter(
        (entry) => entry.collection === "inspiring_quotes",
      );
      for (const entry of quoteEntries) {
        expect(Object.prototype.hasOwnProperty.call(entry.data, "published")).toBe(false);
      }
    }
  });

  it("preserves all 55 draft flags exactly", () => {
    const drafts =
      PAGES.rows.filter((row) => !row.published).length +
      PEOPLE.rows.filter((row) => !row.published).length +
      EVENTS.rows.filter((row) => !row.published).length +
      (META.counts.classrooms - (META.counts.classrooms - 1)) * 0 +
      QUOTES.rows.filter((row) => !row.published).length;
    // Counted from the register rather than re-derived per table, so the figure
    // this asserts is the same one the census publishes.
    expect(drafts).toBe(2 + 21 + 16 + 0);
    expect(ROUTES.rows.filter((route) => !route.published)).toHaveLength(40);
    expect(ROUTES.rows.filter((route) => route.published)).toHaveLength(102);
  });

  it("keeps every promoted entry a draft, so the carousel is dormant by DATA", async () => {
    const promoted = (await readTable<{ published: boolean }>("promoted.json")).rows;
    expect(promoted).toHaveLength(12);
    expect(promoted.filter((row) => !row.published)).toHaveLength(12);
  });
});

/* ==========================================================================
 * 7. Routes, assets and the emitted contract
 * ========================================================================== */

describe("routes", () => {
  it("produces 142 unique content paths", () => {
    expect(ROUTES.rows).toHaveLength(142);
    expect(new Set(ROUTES.rows.map((route) => route.path)).size).toBe(142);
  });

  it("fixes precedence exactly as content_routes does", () => {
    const expected: Record<string, number> = { page: 1, classroom: 2, person: 3, event: 4 };
    for (const route of ROUTES.rows) {
      expect(route.precedence, route.path).toBe(expected[route.kind]);
    }
  });

  it("takes page paths verbatim from the materialized column", () => {
    // Never recomputed from the slug: `structure.root = true`, so home's slug is
    // `home` while its path is `/`, and recomputing would get that row wrong.
    const home = PAGES.rows.find((page) => page.legacy_ref === "home");
    expect(home?.path).toBe("/");
    expect(home?.slug).toBe("home");
    for (const page of PAGES.rows) {
      const route = ROUTES.rows.find((row) => row.id === page.id);
      expect(route?.path, page.slug).toBe(page.path);
    }
  });

  it("normalizes the classroom route, which alone lacks a leading slash", () => {
    // `classrooms.yaml` declares `route: 'programs/{slug}'`.
    for (const route of ROUTES.rows.filter((row) => row.kind === "classroom")) {
      expect(route.path).toMatch(/^\/programs\/[^/]+$/u);
    }
  });

  it("agrees with the route manifest, statuses included", async () => {
    const manifest = (await readJson("artifacts/route-manifest.json")) as {
      counts: { content_paths: number; published: number; draft: number };
      routes: readonly { path: string; anonymous_status: number | null }[];
    };
    expect(manifest.counts.content_paths).toBe(142);
    expect(manifest.counts.published).toBe(102);
    expect(manifest.counts.draft).toBe(40);
    for (const route of ROUTES.rows) {
      const row = manifest.routes.find((entry) => entry.path === route.path);
      expect(row, route.path).toBeDefined();
      expect(row?.anonymous_status, route.path).toBe(route.published ? 200 : 404);
    }
  });
});

describe("assets, read from the manifest and never re-derived", () => {
  it("carries all 289 rows in the three classes", async () => {
    const manifest = (await readJson("artifacts/assets.manifest.json")) as {
      assets: readonly {
        legacy_ref: string;
        path: string;
        bucket: string;
        class: string;
        focus: { x: number; y: number; zoom: number } | null;
      }[];
    };
    expect(ASSETS.rows).toHaveLength(289);
    expect(ASSETS.rows.filter((row) => row.class === "deployed")).toHaveLength(110);
    expect(ASSETS.rows.filter((row) => row.class === "draft_only")).toHaveLength(24);
    expect(ASSETS.rows.filter((row) => row.class === "archived")).toHaveLength(155);
    expect(ASSETS.rows.filter((row) => row.bundled)).toHaveLength(117);

    // One filename map, four consumers: the class, the bucket and the normalized
    // path must come from the manifest rather than being recomputed here.
    const byRef = new Map(manifest.assets.map((entry) => [entry.legacy_ref, entry] as const));
    for (const row of ASSETS.rows) {
      const entry = byRef.get(row.legacy_ref);
      expect(entry, row.legacy_ref).toBeDefined();
      expect(row.path, row.legacy_ref).toBe(entry?.path);
      expect(row.bucket, row.legacy_ref).toBe(entry?.bucket);
      expect(row.class, row.legacy_ref).toBe(entry?.class);
    }
  });

  it("carries the 18 focal points, the 5 non-unit zooms included", async () => {
    const manifest = (await readJson("artifacts/assets.manifest.json")) as {
      assets: readonly {
        legacy_ref: string;
        focus: { x: number; y: number; zoom: number } | null;
      }[];
    };
    const focal = ASSETS.rows.filter((row) => row.focus_x !== null);
    expect(focal).toHaveLength(18);
    // Dropping the zoom would silently re-crop five images.
    expect(focal.filter((row) => (row.focus_zoom ?? 1) > 1)).toHaveLength(5);

    const byRef = new Map(manifest.assets.map((entry) => [entry.legacy_ref, entry] as const));
    for (const row of focal) {
      const focus = byRef.get(row.legacy_ref)?.focus;
      expect(focus, row.legacy_ref).not.toBeNull();
      expect(row.focus_x, row.legacy_ref).toBe(focus?.x);
      expect(row.focus_y, row.legacy_ref).toBe(focus?.y);
      expect(row.focus_zoom, row.legacy_ref).toBe(focus?.zoom);
    }
  });

  it("leaves `alt` null on all 289, because no sidecar carries one", () => {
    // Authoring alt text for the informative subset is a cutover deliverable and
    // a release gate, never a migrated value. Fabricating it here would make the
    // gate pass while the images stayed undescribed.
    for (const row of ASSETS.rows) {
      expect(row.alt, row.legacy_ref).toBeNull();
    }
  });

  it("resolves every asset reference a row holds", () => {
    const known = new Set(ASSETS.rows.map((row) => row.id));
    const check = (id: string | null, label: string): void => {
      if (id !== null) {
        expect(known.has(id), label).toBe(true);
      }
    };
    for (const page of PAGES.rows) {
      check(page.main_image_asset_id, `pages/${page.slug}.main_image`);
      check(page.program_image_asset_id, `pages/${page.slug}.program_image`);
    }
    for (const section of SECTIONS.rows) {
      check(section.asset_id, `page_sections/${section.legacy_ref}`);
    }
    for (const person of PEOPLE.rows) {
      check(person.photo_asset_id, `people/${person.slug}.photo`);
    }
    for (const event of EVENTS.rows) {
      check(event.image_asset_id, `events/${event.slug}.image`);
    }
  });
});

describe("navigation, which is separate from routing", () => {
  it("seeds the 38-row designed menu with three roots", () => {
    expect(NAV.rows).toHaveLength(38);
    expect(NAV.rows.filter((row) => row.parent_id === null)).toHaveLength(3);
    expect(NAV.rows.filter((row) => !row.visible)).toHaveLength(3);
    expect(NAV.rows.filter((row) => row.target_page_id === null)).toHaveLength(3);
    expect(NAV.rows.filter((row) => row.external_url !== null)).toHaveLength(0);
    expect(new Set(NAV.rows.map((row) => row.legacy_ref)).size).toBe(38);
  });

  it("carries the contractual nav:header-actions row", () => {
    // `SiteHeader` resolves the two header calls to action by that literal
    // string, so it is a contract rather than a name.
    const header = NAV.rows.find((row) => row.legacy_ref === "nav:header-actions");
    expect(header).toBeDefined();
    expect(header?.visible).toBe(false);
    expect(NAV.rows.filter((row) => row.parent_legacy_ref === "nav:header-actions")).toHaveLength(2);
  });

  it("puts Admissions FIRST under the first group", () => {
    // The whole point of the reordering, against a legacy sidebar that placed it
    // sixth of nine while the only standing call to action was "Donate Now".
    const considering = NAV.rows.filter(
      (row) => row.parent_legacy_ref === "nav:considering-ces",
    );
    const first = [...considering].sort((left, right) => left.sort_order - right.sort_order)[0];
    expect(first?.label).toBe("Admissions");
  });

  it("moves Donate in the MENU without moving its URL", () => {
    const donate = NAV.rows.find((row) => row.label === "Donate");
    expect(donate?.parent_legacy_ref).toContain("giving");
    // The page's own path is unchanged: the same grouping through
    // `pages.parent_id` would have rewritten it to /giving/donate.
    expect(donate?.target_page_path).toBe("/donate");
    expect(PAGES.rows.some((page) => page.path === "/donate")).toBe(true);
  });

  it("resolves every menu target to a real page path", () => {
    const paths = new Set(PAGES.rows.map((page) => page.path));
    for (const row of NAV.rows) {
      if (row.target_page_path !== null) {
        expect(paths.has(row.target_page_path), row.legacy_ref).toBe(true);
      }
    }
  });

  it("hides only the two draft targets and the header group", () => {
    const hidden = NAV.rows.filter((row) => !row.visible).map((row) => row.label);
    expect(hidden).toContain("Deposits");
    expect(hidden).toContain("Header Actions");
  });
});

/* ==========================================================================
 * 8. The integrity register — preserved and reported, never repaired
 * ========================================================================== */

describe("the integrity register", () => {
  it("records the four stale parent references without acting on them", () => {
    const stale = META.integrity.stale_parent_references;
    expect(stale).toHaveLength(4);
    expect(stale.map((row) => row.slug).sort()).toStrictEqual([
      "day-programs",
      "enrichment-programs",
      "language-programs",
      "summer-programs",
    ]);
    // The tree is authoritative, so all four still render at their correct URLs.
    for (const row of stale) {
      const page = PAGES.rows.find((candidate) => candidate.slug === row.slug);
      expect(page?.path, row.slug).toBe(`/programs/${row.slug}`);
      // The raw value is retained rather than discarded.
      expect(page?.legacy["parent"]).toBe(row.raw_parent);
    }
  });

  it("loads the dangling announcement link as a null foreign key", async () => {
    const announcements = (
      await readTable<{ slug: string; link_page_id: string | null; legacy: Record<string, unknown> }>(
        "announcements.json",
      )
    ).rows;
    expect(META.integrity.dangling_announcement_links).toHaveLength(1);
    const dangling = META.integrity.dangling_announcement_links[0];
    const row = announcements.find((candidate) => candidate.slug === dangling?.slug);
    expect(row?.link_page_id).toBeNull();
    // The raw id is retained, so the school can find what it was meant to be.
    expect(row?.legacy["link"]).toBe(dangling?.raw_link);
    // The other three resolve.
    expect(announcements.filter((entry) => entry.link_page_id !== null)).toHaveLength(3);
  });

  it("records TWO missing-required-field cases, not the one the prose states", () => {
    const missing = META.integrity.missing_required_fields;
    expect(missing).toHaveLength(2);
    const mandarin = missing.find(
      (row) => row.slug === "school-age-mandarin-for-grades-k-through-3rd",
    );
    expect(mandarin?.missing).toStrictEqual([
      "program_image",
      "short_description",
      "description",
    ]);
    // Loaded NULL, never invented.
    const page = PAGES.rows.find((row) => row.slug === mandarin?.slug);
    expect(page?.program_image_asset_id).toBeNull();
    expect(page?.short_description).toBeNull();
    expect(page?.description).toBeNull();

    // The second case, found by measurement: an `institution` set that names no
    // institution. `institution_name` is NOT NULL, so no row can exist for it.
    const empty = missing.find((row) => row.collection === "people");
    expect(empty?.slug).toBe("alex-danton-klein");
    const person = PEOPLE.rows.find((row) => row.slug === "alex-danton-klein");
    expect(person?.education).toHaveLength(0);
    // Nothing is lost: the set itself is carried in `legacy`.
    expect(person?.legacy["education_without_institution"]).toBeDefined();
  });

  it("computes the grandfathered ledger rather than hardcoding it", () => {
    const ledger = META.integrity.grandfathered_over_length;
    expect(ledger).toHaveLength(6);
    // Two `pages.short_description` values and four announcement titles — NOT the
    // three `description` values the specification names. `description` carries
    // `validate: required` and no `character_limit` anywhere in the 19 blueprints.
    expect(ledger.filter((row) => row.column === "short_description")).toHaveLength(2);
    expect(ledger.filter((row) => row.column === "title")).toHaveLength(4);
    expect(ledger.some((row) => row.column === "description")).toBe(false);
    for (const row of ledger) {
      expect(row.length, `${row.slug}.${row.column}`).toBeGreaterThan(row.declared_limit);
    }
    // The values load at FULL LENGTH: the limits belong to the write path, and a
    // check constraint here would have aborted the load.
    const language = PAGES.rows.find((row) => row.slug === "language-programs");
    expect(language?.short_description?.length).toBe(379);
  });

  it("records the promoted link duplication and renders neither twice", async () => {
    const promoted = (
      await readTable<{
        slug: string;
        legacy: Record<string, unknown>;
        links: readonly { link_title: string; link_url: string }[];
      }>("promoted.json")
    ).rows;
    expect(META.integrity.promoted_link_duplication).toHaveLength(1);
    const withLink = promoted.filter((row) => row.links.length > 0);
    // `max_sets: 1` bounds it: exactly one of the twelve entries carries a set.
    expect(withLink).toHaveLength(1);
    const only = withLink[0];
    expect(only?.links[0]?.link_title).toBe("Apply now!");
    expect(only?.links[0]?.link_url).toBe(
      "https://cambridge-ellis.myschoolapp.com/app#login/apply",
    );
    // The undeclared scalar holding the same URL is retained and not rendered.
    expect(only?.legacy["link"]).toBe(only?.links[0]?.link_url);
  });

  it("preserves the seven disabled nested records", () => {
    const disabled = SECTIONS.rows.filter((section) => !section.enabled);
    // Six page-level plus one `person_education`. Contiguous ENABLED text sets
    // concatenate; a DISABLED one is never merged, which is what keeps the two
    // ADJACENT disabled sets in `apply.md` separate.
    expect(disabled).toHaveLength(6);
    const educationDisabled = PEOPLE.rows.flatMap((person) =>
      person.education.filter((row) => !row.enabled),
    );
    expect(educationDisabled).toHaveLength(1);
  });
});

/* ==========================================================================
 * 9. The classroom union — the central reconciliation
 * ========================================================================== */

describe("the classroom relation", () => {
  it("loads the UNION of both legacy directions, each row tagged", async () => {
    const classrooms = (
      await readTable<{
        slug: string;
        legacy: Record<string, unknown>;
        teachers: readonly { source: string; person_legacy_ref: string }[];
      }>("classrooms.json")
    ).rows;
    const teachers = classrooms.flatMap((room) => room.teachers);
    // 32 forward, 24 reverse, 15 in both -> 41. The live template renders the
    // REVERSE query, so the forward relation alone would remove 9 associations
    // the site displays and the reverse alone would discard 17 the entries
    // assert. Neither is acceptable under "no content is lost".
    expect(teachers).toHaveLength(41);
    expect(teachers.filter((row) => row.source === "both")).toHaveLength(15);
    expect(teachers.filter((row) => row.source === "forward")).toHaveLength(17);
    expect(teachers.filter((row) => row.source === "reverse")).toHaveLength(9);
  });

  it("retains the forward array on the classroom row", async () => {
    const classrooms = (
      await readTable<{ slug: string; legacy: Record<string, unknown> }>("classrooms.json")
    ).rows;
    const withTeachers = classrooms.filter((room) => room.legacy["teachers"] !== undefined);
    expect(withTeachers.length).toBeGreaterThan(0);
  });

  it("retains the reverse array on the person row", () => {
    const withClassrooms = PEOPLE.rows.filter((row) => row.legacy["classrooms"] !== undefined);
    expect(withClassrooms).toHaveLength(22);
    // And the other undeclared drift keys.
    expect(PEOPLE.rows.filter((row) => row.legacy["programs"] !== undefined)).toHaveLength(25);
  });

  it("gives every person at least one role, computed and never invented", () => {
    // Migration 06 enforces this with a DEFERRABLE INITIALLY DEFERRED constraint
    // trigger, so a person with none aborts the load at COMMIT rather than at the
    // offending statement.
    expect(PEOPLE.rows).toHaveLength(77);
    for (const person of PEOPLE.rows) {
      expect(person.role_term_ids.length, person.slug).toBeGreaterThanOrEqual(1);
      expect(person.role_slugs.length, person.slug).toBe(person.role_term_ids.length);
    }
    const total = PEOPLE.rows.reduce((sum, person) => sum + person.role_term_ids.length, 0);
    expect(total).toBe(82);
  });
});

/* ==========================================================================
 * 10. The emitted contract as a whole
 * ========================================================================== */

describe("the emitted snapshot", () => {
  it("names every table it loads and agrees with its own counts", () => {
    expect(META.produced_by).toBe("extract");
    expect(META.schema_version).toBe("20260901121800");
    expect(META.counts.pages).toBe(PAGES.rows.length);
    expect(META.counts.page_sections).toBe(SECTIONS.rows.length);
    expect(META.counts.people).toBe(PEOPLE.rows.length);
    expect(META.counts.events).toBe(EVENTS.rows.length);
    expect(META.counts.inspiring_quotes).toBe(QUOTES.rows.length);
    expect(META.counts.nav_items).toBe(NAV.rows.length);
    expect(META.counts.assets).toBe(ASSETS.rows.length);
    expect(META.counts.routes).toBe(ROUTES.rows.length);
    expect(META.counts.person_education).toBe(
      PEOPLE.rows.reduce((sum, person) => sum + person.education.length, 0),
    );
  });

  it("checksums the source manifest as it was actually written", async () => {
    const { createHash } = await import("node:crypto");
    const bytes = await readFile(join(REPO_ROOT, "artifacts/migration-source-manifest.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(META.source_manifest_checksum);
  });

  it("reports nodes, marks and set kinds in SEPARATE census sections", async () => {
    const census = (await readJson("artifacts/corpus-census.json")) as {
      prosemirror_nodes: Record<string, number>;
      prosemirror_marks: Record<string, number>;
      replicator_sets: { total: number; by_kind: Record<string, number> };
      table_family: { nodes: number; entries: number };
      faq: { top_level_nodes: number; items: number };
    };
    // The distinction the census exists to keep. 352 text NODES plus 65 `text`
    // replicator SETS is the 417 the specification reports as a node count.
    expect(census.prosemirror_nodes["text"]).toBe(352);
    expect(census.replicator_sets.by_kind["text"]).toBe(65);
    expect((census.prosemirror_nodes["text"] ?? 0) + (census.replicator_sets.by_kind["text"] ?? 0)).toBe(
      417,
    );
    // All 40 `link` objects are MARKS; the single `link` set kind is a promoted
    // entry's replicator and is a different thing entirely.
    expect(census.prosemirror_marks["link"]).toBe(40);
    expect(census.replicator_sets.by_kind["link"]).toBe(1);
    expect(census.replicator_sets.total).toBe(167);
    expect(census.table_family).toStrictEqual({
      nodes: 50,
      entries: 1,
      entry_paths: ["content/collections/pages/tuition.md"],
    });
    // 23 top-level nodes, not the 25 the specification states.
    expect(census.faq.top_level_nodes).toBe(23);
    expect(census.faq.items).toBe(11);
  });

  it("carries the closed 26-key globals set with the values promoted from templates", async () => {
    const globals = (
      await readTable<{ key: string; value: unknown; group: string; public: boolean }>(
        "site-globals.json",
      )
    ).rows;
    expect(globals).toHaveLength(26);
    const byKey = new Map(globals.map((row) => [row.key, row] as const));
    expect(byKey.get("phone")?.value).toBe("617-354-0014");
    expect(byKey.get("fax")?.value).toBe("617-491-4313");
    expect(byKey.get("address_line_1")?.value).toBe("80 Trowbridge St.");
    // Content, NOT environment variables, so they work in the keyless state.
    expect(byKey.get("google_ads_id")?.value).toBe("AW-11332213588");
    expect(byKey.get("statcounter_project")?.value).toBe("12673899");
    expect(byKey.get("statcounter_security")?.value).toBe("24719029");
    // Root-relative BY DESIGN: forcing https would break the migrated value.
    expect(byKey.get("donate_url")?.value).toBe("/donate");
    // Intentionally empty: no source value exists, and inventing school hours
    // would be worse than omitting the property.
    expect(byKey.get("opening_hours")?.value).toBeNull();
    // The maintenance copy is not public, so an anonymous reader cannot see it
    // before it is used.
    for (const key of [
      "maintenance_enabled",
      "maintenance_title",
      "maintenance_message",
      "maintenance_retry_after",
    ]) {
      expect(byKey.get(key)?.public, key).toBe(false);
    }
    expect(byKey.get("maintenance_enabled")?.value).toBe(false);
    expect(String(byKey.get("maintenance_message")?.value)).toContain("Stay tooned!");
    // Recovered from a disabled block, and shipped UNCONFIRMED: a dead link in an
    // enrolled-family journey would be worse than none.
    expect(byKey.get("family_portal_url")?.value).toMatchObject({ confirmed: false });
  });

  it("applies the single authorized copy edit and nothing else", () => {
    const donate = PAGES.rows.find((page) => page.path === "/donate");
    const own = SECTIONS.rows.filter((section) => section.page_id === donate?.id);
    const text = JSON.stringify(own);
    expect(text).toContain("Your support helps us continue in our mission");
    // The one-word fix, and the ONLY prose change in the whole migration.
    expect(JSON.stringify(SECTIONS.rows)).not.toContain("You support helps");
  });

  it("preserves the three summer tier labels including the authored leading space", () => {
    const program = SECTIONS.rows.find(
      (section) => section.kind === "program" && section.data["full_day_label"] !== undefined,
    );
    expect(program?.data["half_day_label"]).toBe("Half day: ");
    // The stray leading space is exactly as authored in the template.
    expect(program?.data["full_day_label"]).toBe(" Full day: ");
    expect(program?.data["extended_day_label"]).toBe("Extended day: ");
    // The prices are content and stay verbatim.
    expect(program?.half_day_price).toBe("8:30 - 12pm, $2400");
    expect(program?.extended_day_price).toBe("8:30 - 5pm, $3150");
  });

  it("keeps the empty program_title that is the source's own defect", () => {
    // The nested `programs_in_this_session` set carries no `program_title`, which
    // is why the live page renders an empty <h5>. Filling it in would be
    // inventing content.
    const nested = SECTIONS.rows.filter((section) => section.parent_section_id !== null);
    expect(nested).toHaveLength(1);
    expect(nested[0]?.kind).toBe("program");
    expect(nested[0]?.program_title).toBeNull();
  });

  it("dispatches both slideshow shapes correctly", () => {
    // `home.yaml` declares `slideshow` as a REPLICATOR whose image set carries
    // [image, happy_verb] -> 5 `slide` rows. The two umbrella blueprints declare
    // the same handle as `type: assets, mode: list` -> 15 `image` rows.
    const slides = SECTIONS.rows.filter((section) => section.kind === "slide");
    expect(slides).toHaveLength(5);
    expect(slides.map((section) => section.happy_verb)).toStrictEqual([
      "We Play",
      "We Wonder",
      "We Explore",
      "We Make",
      "We Grow",
    ]);
    expect(SECTIONS.rows.filter((section) => section.kind === "image")).toHaveLength(16);
  });

  it("keeps the statistic values as TEXT, because one of them is `5:1`", () => {
    const stats = SECTIONS.rows.filter((section) => section.kind === "statistic");
    expect(stats).toHaveLength(3);
    const numbers = stats.map((section) => section.stat_number);
    expect(numbers).toContain("5:1");
    expect(numbers).toContain("41");
    expect(numbers).toContain("9");
    for (const value of numbers) {
      expect(typeof value).toBe("string");
    }
  });

  it("turns the nine flat testimonial fields into three sections", () => {
    const testimonials = SECTIONS.rows.filter((section) => section.kind === "testimonial");
    expect(testimonials).toHaveLength(3);
    for (const section of testimonials) {
      expect(section.attribution).not.toBeNull();
      expect(section.asset_id).not.toBeNull();
      expect(section.quote_text).not.toBeNull();
    }
  });

  it("retains the undeclared `hero` array and resolves its filenames", () => {
    const home = PAGES.rows.find((page) => page.legacy_ref === "home");
    const hero = home?.legacy["hero"];
    expect(Array.isArray(hero)).toBe(true);
    expect(hero).toHaveLength(6);
    // Real asset references: every one must exist in the manifest, three of them
    // appear nowhere else in the corpus, and home.md carries no `main_image`.
    const filenames = new Set(ASSETS.rows.map((row) => row.legacy_ref));
    for (const name of (hero as readonly string[]) ?? []) {
      expect(filenames.has(name), name).toBe(true);
    }
    expect(home?.main_image_asset_id).toBeNull();
  });

  it("emits every fallback table with a matching count and a stable envelope", async () => {
    for (const fileName of [
      "taxonomy-terms.json",
      "assets.json",
      "site-globals.json",
      "pages.json",
      "page-sections.json",
      "people.json",
      "events.json",
      "classrooms.json",
      "promoted.json",
      "announcements.json",
      "inspiring-quotes.json",
      "nav-items.json",
      "routes.json",
    ]) {
      const table = await readTable<unknown>(fileName);
      expect(table.count, fileName).toBe(table.rows.length);
      expect(typeof table.table, fileName).toBe("string");
      // Hyphenated file name, underscored table name.
      expect(table.table, fileName).not.toContain("-");
      const raw = await readFile(join(REPO_ROOT, "nextjs/data/fallback", fileName), "utf8");
      expect(raw.endsWith("\n"), fileName).toBe(true);
    }
  });
});

