/**
 * Cambridge-Ellis School — the four layout primitives.
 *
 * One of the **five authored files** among the 43 in `components/ui/`. The
 * shadcn/ui registry has no general layout primitive — no `Grid`, `Stack`,
 * `Flex` or page container — which §0.3.4 records as one of its two genuine
 * absent categories. `npx shadcn add layout` resolves to nothing; this file is
 * written by hand and reviewed like any other source file.
 *
 * ## WHY THIS FILE IS LOAD-BEARING RATHER THAN CONVENIENT
 *
 * §0.3.5 forbids hand-rolled flex and grid across the whole authored tree.
 * That rule is **unsatisfiable without this file**: with no sanctioned way to
 * express a two-column card grid, every call site would have to break it. So
 * these four components are not a nicety layered over Tailwind — they are the
 * mechanism that makes the rule enforceable, and §0.3.4 fixes their brief
 * exactly: "each takes only token-valued props, so spacing cannot be
 * improvised at a call site."
 *
 * That is why every spacing, alignment and width prop below is a **closed
 * union of token names**, never `number` and never `string`. `gap={13}` is a
 * compile error, not a lint warning found later. The type system is the
 * enforcement point; the audit script is the backstop.
 *
 * ## THIS FILE IS UNIQUELY PRIVILEGED — AND THE PRIVILEGE IS THE POINT
 *
 * §0.3.4 and §0.3.5 both state that raw Tailwind flex and grid utilities are
 * permitted **only inside `components/ui/layout.tsx`**, "which is where they
 * are reviewed once instead of everywhere." Every `flex`, `grid`,
 * `grid-cols-*`, `items-*` and `justify-*` string in this project should
 * appear below and nowhere else. If a sibling component needs a layout this
 * file cannot express, the correct fix is to extend a prop union here — not to
 * reach for `flex` at the call site.
 *
 * ## WHAT THIS FILE IS DELIBERATELY NOT
 *
 *   - NOT a token definition. `app/globals.css` is the sole declaration site;
 *     this file only ever *consumes* tokens (§0.3.3).
 *   - NOT a page shell. `Container` constrains width and nothing else. Header,
 *     footer, sidebar and breadcrumb chrome belong to `app/(site)/layout.tsx`.
 *   - NOT a replacement for the system's own layout vehicles. §0.3.5 lists
 *     `Sidebar`, `SidebarInset`, `Sheet`, `Card`, `Item` and `AspectRatio` as
 *     equally valid; none is reimplemented here.
 *   - NOT a `vh` sizing helper. §0.3.3 retires `-15vh`, `94vh`, `70vh` and
 *     `50vh` **by design** — §0.7.2 measured them as three separate responsive
 *     defects, including a `.polaroid { width: 50vh }` that computed to 422px
 *     on a 390px screen and put 76px of frame off-screen. Not one viewport
 *     unit appears below. `--size-hero-max` (`80dvh`) is the project's single
 *     permitted viewport-height token and it lives in the hero component.
 *
 * ## INVARIANTS, EACH CHECKED IN THIS FILE'S VALIDATION
 *
 *   - **No `"use client"`.** These are pure presentational wrappers: no state,
 *     no effect, no event handler, no ref. `components.json` sets `rsc: true`,
 *     and a needless client boundary here would drag every consuming page into
 *     the client bundle against the §0.9.3 ceiling of 180,000 compressed bytes
 *     of JavaScript for the entire page.
 *   - **Exactly one runtime import.** `cn` from `@/lib/utils`, alongside a
 *     single type-only import from `react` that is erased at compile time. No
 *     Radix primitive, no icon, no other `components/ui` file — so this file
 *     typechecks on a clean checkout before any generated component exists.
 *   - **No new dependency.** `class-variance-authority` is available and
 *     pinned, but plain typed lookup records are clearer here and add no
 *     runtime: a `Record<Gap, string>` is exhaustive at compile time, which is
 *     all CVA would buy for variants that take no compound logic.
 *   - **No `dark:` variant.** One light theme ships (§0.3.3); the registry's
 *     `.dark` block is deleted from `globals.css` and must not be reintroduced
 *     by proxy here.
 *   - **No arbitrary value and no colour literal.** `scripts/audit-tokens.mjs`
 *     classifies this file as *authored* by basename, where both are hard
 *     failures. Width tokens are therefore referenced with Tailwind 4's
 *     `max-w-(--container-page)` shorthand, which the audit's
 *     `TAILWIND_VAR_SHORTHAND_PATTERN` correctly reads as a token reference.
 *   - **No inline `style`.** The audit scans `style={{ … }}` too, and a style
 *     object is exactly the improvised-value channel this file exists to
 *     close.
 *   - **No colour, radius, shadow or typography.** Layout owns structure only.
 *     Surface treatment belongs to `Card`, `Item` and the token layer.
 *
 * ## TWO ADDITIONS BEYOND THE LITERALLY ENUMERATED PROPS, AND WHY
 *
 * §0.3.2 fixes the four names and their core props, and they are implemented
 * verbatim — nothing is renamed and no specified prop is dropped or altered.
 * Two optional props are nevertheless added, because without them §0.3.5 would
 * be violated *elsewhere*, which is worse than a slightly wider API here:
 *
 *   1. **`as` on all four, not just `Container`.** §UI1 requires the most
 *      specific semantic element for every piece of content — `<ul>`/`<li>`
 *      for lists of items, `<section>`, `<nav>`, `<header>`. A card grid is a
 *      list of items. With no `as`, a caller must either emit a `<div>` soup
 *      (breaking §UI1) or hand-roll `grid grid-cols-…` on its own `<ul>`
 *      (breaking §0.3.5). Both are avoidable, so `as` is uniform across the
 *      four. It is typed as a closed union of block-level semantic tags, so it
 *      is an escape hatch for *semantics* and never for *styling*.
 *   2. **The complementary axis prop on `Stack` and `Row`.** The brief gives
 *      `Stack` an `align` and `Row` a `justify`. The legacy layer this file
 *      replaces sets *both* axes on both orientations — `.navigation` is
 *      `row` + `align-items: center` + `justify-content: space-between`,
 *      `.datearea` is `row` + `align-items: center`, `.peoplecard` is `column`
 *      + `justify-content: space-between` + `align-items: center`. Omitting
 *      the complement would force `items-center` into a sibling file, i.e. a
 *      raw flex utility outside this one. Both props are optional and default
 *      to the CSS initial behaviour, so no existing call site changes meaning.
 *
 * Precedence followed throughout is §0.3.5's: design-system compliance first,
 * then visual fidelity within system constraints, then accessibility at zero
 * visual cost, then responsive behaviour through system primitives, then code
 * quality. Concretely, that ordering is why no abstraction below is allowed to
 * loosen the token discipline.
 */

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/* ==========================================================================
 * Token unions
 *
 * Each union is closed and every member maps to a value declared in
 * `app/globals.css`. Widening one of these types is the only sanctioned way to
 * add a layout value to this project, which is precisely the reviewability
 * §0.3.5 is after.
 * ========================================================================== */

/**
 * The semantic elements a layout primitive may render.
 *
 * Deliberately a closed union rather than `React.ElementType`: the purpose is
 * to let a caller pick the correct *semantic* tag (§UI1), not to turn these
 * components into arbitrary render targets. Every member is block-level or a
 * list container, so `display: flex` / `display: grid` applies cleanly to all
 * of them and the resolved layout does not depend on which tag was chosen.
 *
 * `li` is included so a `Stack` or `Row` can be a list *item* whose children
 * are laid out — the common shape of a card inside a `Grid` rendered as `ul`.
 */
export type LayoutElement =
  | "div"
  | "section"
  | "article"
  | "main"
  | "aside"
  | "header"
  | "footer"
  | "nav"
  | "ul"
  | "ol"
  | "li"
  | "dl"
  | "figure"
  | "figcaption"
  | "form"
  | "fieldset";

/**
 * The project's spacing vocabulary, as gap steps.
 *
 * The nine values are the legacy ladder §0.3.3 preserves — "12 / 18 / 24 / 30
 * / 45 / 60 / 75 / 90 / 110 px … Exact matches" — plus `none` for a
 * genuinely gapless container, `0` being one of the six literals §0.3.5
 * permits. Nothing between the steps is reachable, which is the point: a
 * 13-pixel gap is not a design decision anyone made.
 *
 * Six steps resolve through Tailwind's default `--spacing` multiplier and
 * three through the named tokens §0.3.3 adds for the values that multiplier
 * does not reach cleanly. Both forms were verified against a real compile of
 * `app/globals.css`; see the `GAP` table below for the exact mapping.
 */
export type Gap =
  "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl";

/** Cross-axis alignment. Maps one-to-one onto `align-items`. */
export type Align = "start" | "center" | "end" | "stretch" | "baseline";

/** Main-axis distribution. Maps one-to-one onto `justify-content`. */
export type Justify =
  "start" | "center" | "end" | "between" | "around" | "evenly";

/**
 * The three content measures declared in §0.3.3's `Containers` group.
 *
 *   - `prose` — `--container-prose`, 68ch. The reading measure, for `Prose`
 *     output and any long-form body copy.
 *   - `page`  — `--container-page`, 75rem. The default page width.
 *   - `wide`  — `--container-wide`, 90rem. Full-bleed sections and galleries.
 */
export type ContainerSize = "prose" | "page" | "wide";

/**
 * The **maximum** number of columns a `Grid` reaches at its widest step.
 *
 * This is a ceiling on one monotone ramp, not a fixed count — see `Grid` for
 * the full contract. `4` is the card-grid contract from §0.4.5's responsive
 * matrix; `3` is the testimonial ladder; `1` opts out of responsive columns
 * entirely while keeping token-valued gaps.
 */
export type GridColumns = 1 | 2 | 3 | 4;

/* ==========================================================================
 * Token lookup tables
 *
 * `Record<Union, string>` makes each table exhaustive at compile time: adding
 * a member to a union above without adding its class here is a type error, so
 * the two can never drift.
 *
 * THE RAW FLEX AND GRID UTILITIES BELOW ARE THE ONES §0.3.5 CONFINES TO THIS
 * FILE. Everything else in the project composes these four components.
 * ========================================================================== */

/**
 * Gap step to Tailwind gap utility, with the pixel value each produces.
 *
 * The `45` / `75` / `110` suffixes read as pixel values because they resolve
 * to the *named* tokens `--spacing-45`, `--spacing-75` and `--spacing-110`,
 * which take precedence over the dynamic `calc(var(--spacing) * n)` form. That
 * precedence was verified against a real compile rather than assumed, because
 * the two readings differ by a factor of four and nothing would error:
 * `gap-45` emits `gap: var(--spacing-45)` (45px), not `calc(0.25rem * 45)`
 * (180px). The remaining suffixes are plain multipliers of `--spacing`
 * (0.25rem), including the fractional steps, which Tailwind 4 generates on
 * demand.
 */
const GAP: Record<Gap, string> = {
  none: "gap-0", //                          0    — a permitted literal
  xs: "gap-3", //                           12px  — calc(--spacing * 3)
  sm: "gap-4.5", //                         18px  — calc(--spacing * 4.5)
  md: "gap-6", //                           24px  — calc(--spacing * 6)
  lg: "gap-7.5", //                         30px  — calc(--spacing * 7.5)
  xl: "gap-45", //                          45px  — var(--spacing-45)
  "2xl": "gap-15", //                       60px  — calc(--spacing * 15)
  "3xl": "gap-75", //                       75px  — var(--spacing-75)
  "4xl": "gap-22.5", //                     90px  — calc(--spacing * 22.5)
  "5xl": "gap-110", //                     110px  — var(--spacing-110)
};

/** Cross-axis alignment to `align-items`. */
const ALIGN: Record<Align, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
  baseline: "items-baseline",
};

/** Main-axis distribution to `justify-content`. */
const JUSTIFY: Record<Justify, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
  evenly: "justify-evenly",
};

/**
 * Content measure to max-width utility.
 *
 * Tailwind 4's `max-w-(--token)` shorthand is used rather than the bare
 * `max-w-prose` / `max-w-page` / `max-w-wide` scale utilities, for one
 * measured reason: **`max-w-prose` is a built-in Tailwind utility that emits
 * `max-width: 65ch`**, silently shadowing this project's
 * `--container-prose: 68ch`. `max-w-page` and `max-w-wide` happen to resolve
 * correctly, but relying on that asymmetry would leave a trap for whoever
 * adds a fourth measure. The shorthand form always reads the declared token,
 * is unambiguous at the call site, and the token audit treats it as a
 * reference rather than an arbitrary value.
 */
const CONTAINER_SIZE: Record<ContainerSize, string> = {
  prose: "max-w-(--container-prose)", //  68ch
  page: "max-w-(--container-page)", //    75rem
  wide: "max-w-(--container-wide)", //    90rem
};

/**
 * Column ceiling to the responsive column ramp.
 *
 * ## THE RAMP
 *
 * Every ceiling walks the same monotone ladder and simply stops earlier or
 * later, so a caller chooses *how wide the content wants to get* rather than
 * hand-specifying a count per breakpoint:
 *
 * | `cols` | 320–575px | 576–991px | 992–1399px | ≥1400px |
 * |--------|-----------|-----------|------------|---------|
 * | `1`    | 1         | 1         | 1          | 1       |
 * | `2`    | 1         | 2         | 2          | 2       |
 * | `3`    | 1         | 2         | 3          | 3       |
 * | `4`    | 1         | 2         | 3          | 4       |
 *
 * `cols={4}` is verbatim §0.4.5's `Card grids (people, classrooms, programs)`
 * row — "1 column, full-bleed card / 2 columns via container query / 3
 * columns; 4 at `--breakpoint-2xl`" — which is what `tests/e2e/responsive.spec.ts`
 * asserts at the 320 / 576 / 992 / 1400px viewport projects. `cols={3}` is the
 * testimonial ladder from the same matrix (1 / 2-up / 3-up).
 *
 * ## WHY THE SECOND STEP IS A CONTAINER QUERY, AND WHY IT IS MEDIA-GUARDED
 *
 * §0.4.5 specifies the 576–991px step as "2 columns **via container query**",
 * not a viewport media query, so the second column appears when the grid
 * genuinely has room rather than when the window happens to be wide — the
 * distinction that lets a card grid behave correctly inside a narrow column as
 * well as full-bleed. `@md:` is Tailwind 4's `@container (width >= 28rem)`,
 * i.e. 448px, and it is the only built-in container step inside the window the
 * matrix requires: above 390px, so a 390px phone keeps its single full-bleed
 * card, and at or below 576px, so a 576px viewport reaches two columns. This
 * is also why `Container` adds no horizontal padding.
 *
 * The `max-lg:` prefix is not decoration — it is a **correctness fix for a CSS
 * ordering hazard**, found by compiling this project's real stylesheet rather
 * than by reasoning. Tailwind emits container-query variants *after* media-query
 * variants, and the two have equal specificity, so later wins: a bare
 * `@md:grid-cols-2` would override both `lg:grid-cols-3` and
 * `2xl:grid-cols-4` at every viewport whose container exceeds 448px. A 1400px
 * desktop would have rendered **two** columns instead of four, silently.
 * Guarding the container query to `@media (width < 992px)` confines it to the
 * band the matrix assigns it, so the three steps cannot collide whatever order
 * Tailwind emits them in.
 *
 * Each entry restates `grid-cols-1` so the ramp reads as a complete
 * declaration and does not depend on a base class applied elsewhere.
 *
 * ## WHERE THE CONTAINER-RELATIVE BEHAVIOUR STOPS — READ THIS BEFORE NESTING
 *
 * Only the **second** step is container-relative. §0.4.5 specifies the third
 * and fourth as viewport steps ("3 columns at ≥992px, 4 at
 * `--breakpoint-2xl`"), and they are implemented as ordinary media queries, so
 * they apply whatever width the grid's own container happens to have.
 *
 * The practical consequence, measured in a browser rather than reasoned about:
 * a `Grid` placed inside `Container size="prose"` still reaches four columns at
 * a 1400px viewport, giving four ~147px cells inside the 661px reading measure.
 * That is faithful to the specified matrix, not a bug — but it is rarely what a
 * caller wants, so **card grids belong inside `size="page"` or `size="wide"`,
 * and `size="prose"` is for reading-measure body copy.** Widening the ramp to
 * make steps three and four container-relative would mean inventing container
 * thresholds that appear in neither §0.3.3's closed token contract nor
 * §0.4.5's matrix, so it is deliberately not done here.
 */
const GRID_COLUMNS: Record<GridColumns, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 max-lg:@md:grid-cols-2 lg:grid-cols-2",
  3: "grid-cols-1 max-lg:@md:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 max-lg:@md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4",
};

/* ==========================================================================
 * Shared props
 * ========================================================================== */

/**
 * Props common to all four primitives.
 *
 * `HTMLAttributes<HTMLElement>` rather than a `div`-specific type, because
 * `as` makes the rendered tag variable: an event handler typed against
 * `HTMLDivElement` would not be assignable to `<ul>`'s attributes under
 * `strictFunctionTypes`, whereas one typed against the `HTMLElement` base is
 * assignable to every member of `LayoutElement`. It carries `className` and
 * `children`, so neither is redeclared below.
 */
interface LayoutBaseProps extends HTMLAttributes<HTMLElement> {
  /**
   * The semantic element to render. Defaults to `div`.
   *
   * An escape hatch for **semantics only** (§UI1) — a card grid is a list of
   * items and should say so — never for styling. Layout itself is identical
   * whichever tag is chosen.
   */
  as?: LayoutElement;
}

/* ==========================================================================
 * Container
 * ========================================================================== */

/** Props for {@link Container}. */
export interface ContainerProps extends LayoutBaseProps {
  /**
   * Which content measure to constrain to. Defaults to `page`
   * (`--container-page`, 75rem), the width most of the site uses.
   */
  size?: ContainerSize;
}

/**
 * Constrains content to one of the three measures in §0.3.3 and centres it.
 *
 * This is a **width constraint and nothing else** — no padding, no background,
 * no chrome. Two reasons, and both matter:
 *
 *   1. Site chrome is `app/(site)/layout.tsx`'s responsibility. A container
 *      that also owned padding would compete with it.
 *   2. Horizontal padding here would shrink every descendant `Grid`'s
 *      container-query width and could push the 576px viewport below the 448px
 *      threshold its second column depends on — turning a padding tweak into a
 *      silent responsive regression.
 *
 * `w-full` with `max-w-*` implements §0.4.5's single-breakpoint rule directly:
 * the wrapper spans the full width and the content container takes the
 * measure, centred with automatic inline margins.
 *
 * @example A page body at the default measure, as a semantic `<section>`.
 * ```tsx
 * <Container as="section" size="page">
 *   <Stack gap="2xl">{children}</Stack>
 * </Container>
 * ```
 *
 * @example Long-form copy at the 68ch reading measure.
 * ```tsx
 * <Container size="prose"><Prose value={page.body} /></Container>
 * ```
 */
export function Container({
  as: Component = "div",
  size = "page",
  className,
  ...props
}: ContainerProps) {
  return (
    <Component
      className={cn("mx-auto w-full", CONTAINER_SIZE[size], className)}
      {...props}
    />
  );
}

/* ==========================================================================
 * Stack
 * ========================================================================== */

/** Props for {@link Stack}. */
export interface StackProps extends LayoutBaseProps {
  /** Vertical space between children. Defaults to `md` (24px). */
  gap?: Gap;
  /**
   * Horizontal alignment of the children — the cross axis, because a `Stack`
   * flows vertically. Omitted means the CSS initial `stretch`, so children
   * fill the width.
   */
  align?: Align;
  /**
   * Vertical distribution of the children — the main axis. Only observable
   * when the stack is taller than its content, e.g. a card of fixed height
   * pushing its footer down with `justify="between"`.
   */
  justify?: Justify;
}

/**
 * Stacks children vertically with a token-valued gap.
 *
 * Spacing is `gap`, never a margin on the children. That is a deliberate
 * correction of the legacy layer, which distributed vertical rhythm through
 * `.spacer30` / `.spacer60` / `.spacerTop90` margin classes applied by hand at
 * each call site — so the space between two items depended on which of them
 * remembered to carry a spacer, and the last item in a list always contributed
 * a trailing margin nobody wanted. A `gap` sits *between* children only: it is
 * automatically correct for 0, 1 and N children, which is §UI8's requirement
 * for lists, and it needs no `:last-child` rule.
 *
 * @example A page section, semantically marked up.
 * ```tsx
 * <Stack as="section" gap="2xl">
 *   <H2>Our classrooms</H2>
 *   <Grid cols={4} gap="lg">{cards}</Grid>
 * </Stack>
 * ```
 *
 * @example A fixed-height card pinning its footer to the bottom — the shape
 * the legacy `.peoplecard` produced by hand, minus the percentage-height bug.
 * ```tsx
 * <Stack gap="sm" align="center" justify="between">{…}</Stack>
 * ```
 */
export function Stack({
  as: Component = "div",
  gap = "md",
  align,
  justify,
  className,
  ...props
}: StackProps) {
  return (
    <Component
      className={cn(
        "flex min-w-0 flex-col",
        GAP[gap],
        align && ALIGN[align],
        justify && JUSTIFY[justify],
        className,
      )}
      {...props}
    />
  );
}

/* ==========================================================================
 * Row
 * ========================================================================== */

/** Props for {@link Row}. */
export interface RowProps extends LayoutBaseProps {
  /** Horizontal space between children, and between wrapped lines. Defaults to `md` (24px). */
  gap?: Gap;
  /**
   * Whether children may wrap onto further lines. **Defaults to `true`**, which
   * is what keeps a long row from overflowing a 320px viewport; pass `false`
   * only when the row must stay on one line and its own overflow is handled.
   */
  wrap?: boolean;
  /**
   * Horizontal distribution of the children — the main axis, because a `Row`
   * flows horizontally.
   */
  justify?: Justify;
  /**
   * Vertical alignment of the children — the cross axis. Omitted means the CSS
   * initial `stretch`, so children match the tallest.
   */
  align?: Align;
}

/**
 * Lays children out horizontally with a token-valued gap, wrapping by default.
 *
 * Wrapping is opt-out rather than opt-in because the failure it prevents is
 * the expensive one. §0.7.2 measured the legacy site losing content off the
 * side of a 390px screen while `#colorlib-page { overflow: hidden }` masked it
 * — a `scrollWidth > clientWidth` check read clean while the visitor could not
 * reach part of the image. A row that wraps cannot produce that, so the safe
 * behaviour is the default and the unsafe one has to be asked for by name.
 *
 * @example The legacy `.navigation` shape — both axes set, which is why `Row`
 * carries `align` as well as `justify`.
 * ```tsx
 * <Row as="nav" gap="md" align="center" justify="between">{…}</Row>
 * ```
 *
 * @example A single-line meta row that must not wrap.
 * ```tsx
 * <Row gap="xs" align="baseline" wrap={false}>{…}</Row>
 * ```
 */
export function Row({
  as: Component = "div",
  gap = "md",
  wrap = true,
  justify,
  align,
  className,
  ...props
}: RowProps) {
  return (
    <Component
      className={cn(
        "flex min-w-0 flex-row",
        wrap ? "flex-wrap" : "flex-nowrap",
        GAP[gap],
        justify && JUSTIFY[justify],
        align && ALIGN[align],
        className,
      )}
      {...props}
    />
  );
}

/* ==========================================================================
 * Grid
 * ========================================================================== */

/** Props for {@link Grid}. */
export interface GridProps extends LayoutBaseProps {
  /**
   * The maximum number of columns to reach at the widest step. Defaults to `4`,
   * the card-grid contract in §0.4.5. See {@link GRID_COLUMNS} for the full
   * per-breakpoint ramp.
   */
  cols?: GridColumns;
  /** Space between rows and columns. Defaults to `md` (24px). */
  gap?: Gap;
}

/**
 * A responsive grid whose column count follows the §0.4.5 ramp.
 *
 * Columns are equal-width `minmax(0, 1fr)` tracks, so a long unbroken string
 * in one cell cannot widen its column and push the grid past its container —
 * the `minmax(0, …)` floor plus `min-w-0` is what makes that true, and it is
 * the structural answer to the class of bug §0.3.5 attributes to magic pixel
 * values ("what produced the elliptical portraits and the off-screen
 * polaroid"). Cell height is intrinsic: nothing here sizes a child, so a
 * portrait's proportions come from `AspectRatio` and never from whatever space
 * the text happens to leave, which is exactly how the legacy `.peoplecard`
 * turned circles into per-card ellipses (a constant 203.19px wide against
 * heights from 171.19px to 225.59px).
 *
 * ## THE OUTER ELEMENT IS REQUIRED, NOT INCIDENTAL
 *
 * This component renders two elements: an outer wrapper carrying
 * `container-type: inline-size`, and the grid itself. That is a CSS
 * requirement rather than a stylistic choice — **a container query resolves
 * against the nearest *ancestor* container, so an element cannot query its own
 * width.** Putting `@container` and `@md:grid-cols-2` on one element would
 * silently measure whatever ancestor happened to be a container, or nothing at
 * all, and either way the second column would never appear.
 *
 * Owning its own container context is also what makes the component
 * self-contained: the ramp behaves identically whether the grid sits in a
 * full-bleed section or a narrow sidebar, and it does not depend on some
 * ancestor having remembered to declare a container. §DS3-d's instruction to
 * flatten unnecessary wrappers does not reach this one — it is load-bearing,
 * and it is one element, keeping the tree inside the ≤ 4-level target.
 *
 * The wrapper is always a plain `div`; `as`, `className` and every other prop
 * go to the grid element, so `as="ul"` yields `<div><ul class="grid …">` and
 * `className` still overrides the grid's own classes through `cn`.
 *
 * @example The card grid — people, classrooms and programs all use this shape.
 * ```tsx
 * <Grid as="ul" cols={4} gap="lg">
 *   {people.map((p) => <PersonCard as="li" key={p.slug} person={p} />)}
 * </Grid>
 * ```
 *
 * @example The three home testimonials: 1 up, then 2 up, then 3 up.
 * ```tsx
 * <Grid cols={3} gap="lg">{testimonials.map(…)}</Grid>
 * ```
 */
export function Grid({
  as: Component = "div",
  cols = 4,
  gap = "md",
  className,
  ...props
}: GridProps) {
  return (
    <div className="@container w-full min-w-0">
      <Component
        className={cn("grid min-w-0", GRID_COLUMNS[cols], GAP[gap], className)}
        {...props}
      />
    </div>
  );
}
