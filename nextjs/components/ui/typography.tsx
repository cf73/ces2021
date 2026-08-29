/**
 * Cambridge-Ellis School — the typographic element set.
 *
 * One of the FIVE AUTHORED files among the 43 in `components/ui/`. It is not
 * `shadcn add` output and never will be: shadcn/ui's Typography page is a
 * documentation recipe rather than an installable registry item (§0.3.4), so
 * `npx shadcn add typography` produces nothing. `scripts/audit-tokens.mjs`
 * lists this basename in `AUTHORED_UI_FILES`, which means the strict half of
 * the token rules applies here — an arbitrary value or a colour literal in
 * this file fails the audit, where the same thing in a generated file would
 * only be inventoried.
 *
 * ## What this file is
 *
 * The single place the eleven type roles of §0.3.3 are resolved into elements.
 * Requirement 8 asked for typography "standardized and holistically improved
 * from the ground up", with explicit licence not to be "overly tethered to the
 * existing typography". §0.3.3 took that licence: the legacy fixed step ramp
 * (`h1` 30px jumping to 96px at exactly 768px with nothing in between, and
 * `h4` at 20px sitting ABOVE `h3` at 18px below that breakpoint — a genuine
 * inversion) becomes a fluid `clamp()` ramp, self-hosted through `next/font`.
 *
 * `components/site/Prose.tsx` maps ProseMirror node types onto these exports
 * one-to-one, which is how the corpus resolves to one definition each:
 *
 *   paragraph  265 nodes → P            heading level 2  → H2
 *   heading     38 nodes → H2/H3/H4     heading level 3  → H3
 *   listItem    28 nodes → List's <li>  heading level 4  → H4
 *   bulletList   6 nodes → List         blockquote  2    → Blockquote
 *   orderedList  1 node  → List ordered
 *
 * `lib/richtext-validate.ts` constrains `heading.level` to 2–4 and permits only
 * the `bold`, `italic` and `link` marks, so no export needs an underline,
 * strike, code-block or horizontal-rule treatment — the validator rejects all
 * five outright, and a toolbar that offered one would produce an edit that
 * fails on save. `InlineCode` exists for editorial use, not because the corpus
 * contains a `code` mark; it does not.
 *
 * ## THE ONE THING NOT TO "TIDY" — READ BEFORE CHANGING A CLASS STRING
 *
 * Every role below is written as FOUR-OR-FIVE separate classes, one per CSS
 * axis, rather than as the single idiomatic Tailwind 4 utility `text-display`.
 * That looks redundant. It is not, and collapsing it silently breaks the site.
 *
 * `cn()` ends in `twMerge()`, and tailwind-merge 3.6.0 knows only Tailwind's
 * BUILT-IN font-size names. Every name in this project's custom `--text-*`
 * scale is unknown to it, so it classifies each one as a text-COLOUR and puts
 * it in the same conflict group as a real colour utility — where the last
 * occurrence wins and the other is dropped. Measured against the installed
 * version, not assumed:
 *
 *   twMerge("text-red-500", "text-display")  → "text-display"
 *   twMerge("text-display", "text-red-500")  → "text-red-500"
 *   twMerge("text-body",    "text-primary")  → "text-primary"
 *   twMerge("text-body", "text-muted-foreground")
 *                                            → "text-muted-foreground"
 *
 * In each of the last three the FONT SIZE is destroyed and nothing reports it.
 * That is not a hypothetical: `className` pass-through is mandatory on every
 * export (§0.3.4) and `<P className="text-muted-foreground">` is an entirely
 * ordinary call, so the single-class form would lose its size across all 265
 * paragraph and 38 heading nodes the moment any caller tinted one. The
 * seemingly safer `text-(color:--token)` spelling does NOT help — it is still
 * the colour group, so it still collapses. `[color:var(--token)]` does avoid
 * the collision, but `audit-tokens.mjs` counts a bracket group containing `:`
 * as an arbitrary value, which fails in an authored file.
 *
 * The form used here keeps each axis in a DIFFERENT tailwind-merge conflict
 * group, so all of them survive together and a caller can still override any
 * one of them on its own:
 *
 *   text-(length:--text-<role>)               → font-size      [font-size]
 *   leading-(--text-<role>--line-height)      → line-height    [leading]
 *   tracking-(--text-<role>--letter-spacing)  → letter-spacing [tracking]
 *   font-bold | font-normal                   → font-weight    [font-weight]
 *   text-brand-display | text-muted-foreground → color         [text-color]
 *
 * Both halves were verified by compiling `app/globals.css` through
 * `@tailwindcss/postcss` 4.3.3 — each utility emits the expected single
 * declaration — and by re-running the merges above, where every class
 * survives. The parenthesis form is a TOKEN REFERENCE to the audit
 * (`TAILWIND_VAR_SHORTHAND_PATTERN`), not an arbitrary value, and every token
 * it names is declared in `app/globals.css`, including the `--line-height` and
 * `--letter-spacing` companion keys.
 *
 * ## What this file deliberately does NOT do
 *
 *   - No `prose` class from `@tailwindcss/typography`. That plugin sets its own
 *     font-size, leading and colours from its own variables, which is exactly
 *     the "silent override" the brief forbids — if the two disagree the token
 *     wins, and the way to guarantee that is not to invite the conflict. It is
 *     also a CONTAINER class, so it belongs on a wrapper in `Prose.tsx`, not on
 *     an individual element.
 *   - No `scroll-margin-top`. `app/globals.css` already applies it to
 *     `:target` and to every `hN[id]`, computed from the chrome tokens. This
 *     file's job is to FORWARD `id` so that rule can match — which is why every
 *     export spreads its native props.
 *   - No colour on H2–H4, Lead, P, Blockquote, Meta or List. They inherit,
 *     matching the legacy `h1, h2, h3, h4, h5, h6 { color: inherit }` with
 *     `h1 { color: $band5 }` layered on top: only the page heading was ever
 *     coloured. Preserving that distinction is what keeps the visual field
 *     recognizable while the contrast correction lands.
 *   - No borders, padding, margins or flex/grid utilities. Spacing and
 *     alignment go through `Container`, `Stack`, `Row` and `Grid` (§0.3.5); the
 *     one apparent exception is `List`, explained at its own definition.
 *   - No `"use client"`. These have no state, no effect and no handler, so they
 *     render in a Server Component. Adding the directive would pull every
 *     consuming tree into the client bundle against the §0.9.3 budget.
 *   - No `dark:` variant. One light theme ships (§0.3.3, "Colour mode").
 *
 * ## Not exported, and where those roles live instead
 *
 * Two of the eleven roles are intentionally absent. `--text-hero` is the home
 * page's `.happyverb` statement — a single site-specific composition owned by
 * its presenter, not a document element a rich-text renderer emits. `--text-sm`
 * is the `Small` role; it is left to call sites because `text-sm` IS one of
 * tailwind-merge's built-in sizes and therefore safe to hand-roll, and because
 * `InlineCode` already binds it for the mono case. Everything else that needs a
 * shared definition has one here.
 */

import { cn } from "@/lib/utils";

/* ==========================================================================
 * The role bindings
 * ==========================================================================
 * One constant per role, each naming its tokens explicitly. Not exported: the
 * public API of this file is its components (§0.3.4), and a consumer that
 * reached for a class string instead of an element would bypass the semantic
 * tag that is this file's contribution to WCAG 2.2 AA.
 *
 * A role declares a `--letter-spacing` companion only where §0.3.3 gives it
 * one, and a `font-weight` companion only where the role is 700. Where a token
 * has no companion the corresponding class is absent rather than guessed at,
 * so the emitted CSS matches the contract exactly.
 * ========================================================================== */

/**
 * Display — the page `h1`. `clamp(2.5rem, 6vw + 1rem, 6rem)`, replacing the
 * legacy 30px→96px step change.
 *
 * The ONLY role that carries `text-brand-display`, and the colour rule is
 * measured rather than stylistic. §0.3.5 restricts that token to text at
 * >= 24px and weight 700 because the legacy `$band5` `#459b34` computes to
 * 3.51:1 at body size and FAILS WCAG AA — 23 elements on the leadership page
 * fail contrast at exactly that ratio. `--color-brand-display` preserves
 * `$band5` unchanged and passes only as AA-large, at 3.36:1. This role clears
 * the bar with room to spare: its floor is 2.5rem = 40px and its weight is 700.
 * Body-size brand text uses `--primary` (4.56:1) instead.
 */
const DISPLAY =
  "text-(length:--text-display) leading-(--text-display--line-height) tracking-(--text-display--letter-spacing) font-bold text-brand-display";

/**
 * Heading 2 — section headings and bard `heading` level 2.
 * `clamp(1.75rem, 2.5vw + 1rem, 3rem)`, from the legacy 24px→36px.
 *
 * Its floor is 1.75rem = 28px at weight 700, so `text-brand-display` would be
 * permissible here. It is deliberately NOT applied: §0.3.3's type-role matrix
 * assigns that colour to the Display role alone, and the legacy stylesheet
 * coloured only `h1`. Inheriting keeps a page's colour hierarchy legible.
 */
const HEADING_2 =
  "text-(length:--text-h2) leading-(--text-h2--line-height) tracking-(--text-h2--letter-spacing) font-bold";

/**
 * Heading 3 — card titles and bard level 3.
 * `clamp(1.375rem, 1vw + 1rem, 1.875rem)`, from the legacy 18px→24px.
 *
 * MUST NOT carry `text-brand-display`. Its floor is 1.375rem = 22px, below the
 * 24px threshold, so binding that colour here would ship the 3.51:1 failure
 * this migration exists to fix — at a size where AA-large does not apply.
 * `tests/unit` asserts programmatically that no sub-24px role binds it.
 */
const HEADING_3 =
  "text-(length:--text-h3) leading-(--text-h3--line-height) font-bold";

/**
 * Heading 4 — bard level 4 and field labels in edit mode.
 * `clamp(1.125rem, .5vw + 1rem, 1.375rem)`.
 *
 * Note what the ramp fixes: the legacy `h4` was a flat 20px while `h3` was
 * 18px below 768px, so the fourth-level heading rendered LARGER than the third.
 * Here the ceiling of `--text-h4` (1.375rem) equals the FLOOR of `--text-h3`,
 * so H3 is greater than or equal to H4 at every viewport and the inversion
 * cannot recur.
 */
const HEADING_4 =
  "text-(length:--text-h4) leading-(--text-h4--line-height) font-bold";

/** Lead — page intros and the `summary` field. Weight 400, colour inherited. */
const LEAD =
  "text-(length:--text-lead) leading-(--text-lead--line-height) font-normal";

/**
 * Body — all prose. `1.0625rem` / 1.6 / 0.02em, PRESERVED EXACTLY from the
 * legacy `body` rule and the one role in the ramp that is deliberately not
 * fluid: §0.3.3 calls it "the one typographic decision the current site gets
 * right". Not rounded to `1rem`, not made responsive.
 *
 * `font-normal` is bound explicitly even though `body` already resolves to 400.
 * That is not redundancy — it makes a paragraph self-contained inside an
 * ancestor that sets a weight, such as a card title or the edit chrome, where
 * inheritance alone would render body copy bold.
 */
const BODY =
  "text-(length:--text-body) leading-(--text-body--line-height) tracking-(--text-body--letter-spacing) font-normal";

/**
 * Quote — bard `blockquote`, the four quote replicator sets and
 * `inspiring_quotes`. Sized as Lead, rendered italic at weight 400.
 *
 * Type only: no rule, no left border, no inset. Those are spacing and colour
 * decisions belonging to whichever presenter places the quote, and §0.3.5
 * routes spacing through the layout primitives rather than through element
 * defaults.
 */
const QUOTE =
  "text-(length:--text-quote) leading-(--text-quote--line-height) font-normal italic";

/**
 * Inline code. Bound to `--font-mono` and `--text-sm`, per §0.3.4.
 *
 * No background tint or padding, for the same reason `Blockquote` has no
 * border. Weight is left to inherit so a code span inside a heading tracks the
 * heading. `text-sm` would have been safe to write in its short form here —
 * it is one of tailwind-merge's built-in sizes — but the length form is used
 * for consistency with every other role, so no reader has to know the
 * exception exists.
 */
const INLINE_CODE =
  "font-mono text-(length:--text-sm) leading-(--text-sm--line-height)";

/**
 * Caption — image captions and field help text. `.8125rem` / 1.75, the legacy
 * `.small` figures exactly, in `--muted-foreground` (6.3:1 on the page ground,
 * 6.0:1 on `--muted`, so it clears AA on either surface).
 *
 * This is the `--text-caption` role, NOT `--text-sm`. The two are different
 * sizes (13px against 14px) and §0.3.3 keeps them apart.
 */
const CAPTION =
  "text-(length:--text-caption) leading-(--text-caption--line-height) font-normal text-muted-foreground";

/**
 * Meta — dates, roles and labels: the legacy `.meta` class. `.875rem` with
 * 0.06em tracking in Space Mono, which §0.3.3 calls "the site's recognizable
 * accent voice", and the reason this role is the mono one.
 *
 * Colour is INHERITED, and that is a load-bearing choice rather than an
 * omission. `.meta` carried no colour of its own in the legacy stylesheet, and
 * `EventDateChip` renders this role on top of `--gradient-event`, where §0.3.3
 * requires `--foreground` (6.59 / 5.91 / 8.27:1 across the three stops) in
 * place of the legacy white that measured 1.30–1.83:1. Forcing
 * `--muted-foreground` here would break that pairing on every event card.
 */
const META =
  "font-mono text-(length:--text-meta) leading-(--text-meta--line-height) tracking-(--text-meta--letter-spacing) font-normal";

/**
 * The shared half of a list: body metrics plus the marker geometry.
 *
 * Tailwind's Preflight resets `ol, ul, menu` to `list-style: none` with zero
 * margin and padding, so a list rendered without these classes loses its
 * markers AND its indent and reads as undifferentiated prose. Restoring them
 * is content fidelity for the 6 bulletList, 1 orderedList and 28 listItem
 * nodes in the corpus, not decoration — the list semantics are part of what
 * requirement 12 protects.
 *
 * `ps-6` is the one spacing utility in this file, and it is logical
 * (`padding-inline-start`) rather than physical. 1.5rem is chosen over the
 * browser's own 40px default because at the 320px floor of the responsive
 * contract a 40px indent consumes 12.5% of the line; 1.5rem clears the marker
 * at every size in the ramp. `list-outside` keeps wrapped lines aligned to the
 * text rather than tucked under the marker.
 *
 * Nesting needs no extra rule: `Prose` renders each nested list through this
 * same component, so every level gets its own markers and its own indent.
 */
const LIST_BASE = `${BODY} list-outside ps-6`;

/** Unordered lists — bard `bulletList`. */
const LIST_UNORDERED = `${LIST_BASE} list-disc`;

/** Ordered lists — bard `orderedList`. */
const LIST_ORDERED = `${LIST_BASE} list-decimal`;

/* ==========================================================================
 * The components
 * ==========================================================================
 * Each is a thin element: one semantic tag, one token-bound class list, and
 * nothing else. No wrapper, no context, no state (§0.3.4).
 *
 * Two properties are common to all of them and both are contractual. Native
 * props are spread, so `id`, `aria-*`, `lang` and `dir` reach the DOM — `id` in
 * particular, because the anchor-offset rule in `app/globals.css` matches
 * `hN[id]` and an in-page jump to `#faq-3` would otherwise park the heading
 * behind the sticky header (§0.4.5). And `className` is merged LAST through
 * `cn`, so a caller's class wins any conflict it genuinely contests while
 * leaving the other axes intact.
 * ========================================================================== */

/**
 * The page heading. One per page, and the only heading that carries the brand
 * colour.
 *
 * @example
 * ```tsx
 * <H1 id="mission">Mission and Philosophy</H1>
 * ```
 */
export function H1({ className, ...props }: React.ComponentProps<"h1">) {
  return <h1 className={cn(DISPLAY, className)} {...props} />;
}

/** A section heading, and the target of bard `heading` level 2. */
export function H2({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn(HEADING_2, className)} {...props} />;
}

/** A card title, and the target of bard `heading` level 3. */
export function H3({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn(HEADING_3, className)} {...props} />;
}

/** Bard `heading` level 4, and field labels in edit mode. */
export function H4({ className, ...props }: React.ComponentProps<"h4">) {
  return <h4 className={cn(HEADING_4, className)} {...props} />;
}

/**
 * A page intro or the `summary` field: prose set one step above body size.
 * Renders a paragraph, so it composes inside `Prose` without disturbing the
 * heading outline.
 */
export function Lead({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn(LEAD, className)} {...props} />;
}

/** A paragraph. The target of all 265 `paragraph` nodes in the corpus. */
export function P({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn(BODY, className)} {...props} />;
}

/**
 * A pull quote. The target of bard `blockquote`, the quote replicator sets and
 * `inspiring_quotes`.
 *
 * `<blockquote>` is used rather than a styled paragraph so assistive
 * technology announces the quotation. Where the source supplies an
 * attribution, the caller pairs this with `Meta` — the legacy pattern was
 * `.meta small` beneath the quote.
 */
export function Blockquote({
  className,
  ...props
}: React.ComponentProps<"blockquote">) {
  return <blockquote className={cn(QUOTE, className)} {...props} />;
}

/** An inline code span, in the mono voice at the small size. */
export function InlineCode({
  className,
  ...props
}: React.ComponentProps<"code">) {
  return <code className={cn(INLINE_CODE, className)} {...props} />;
}

/**
 * Quiet secondary text: image captions and field help text, at the caption
 * size in `--muted-foreground`.
 *
 * Colour alone never carries meaning here (§0.4.5) — this role marks text as
 * secondary, and anything that must be understood as an error uses
 * `FieldError`, which pairs its colour with text.
 */
export function Muted({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn(CAPTION, className)} {...props} />;
}

/**
 * Dates, roles and labels in Space Mono — the legacy `.meta` treatment.
 *
 * The one addition to the export list §0.3.4 fixes, and it is added on
 * evidence rather than for symmetry. `.meta` is used across the sidebar
 * contact block, all three home testimonial attributions, the inspiring-quote
 * attribution, `_eventcard` and `_peoplecard`; without a shared definition
 * each of those presenters would rebind `--text-meta` and `--font-mono` by
 * hand, which is precisely the duplication this file exists to prevent — and
 * every one of those hand-rolled sites would independently hit the
 * tailwind-merge collapse documented in the file header.
 */
export function Meta({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn(META, className)} {...props} />;
}

/**
 * Props for {@link List}.
 *
 * The element is chosen by `ordered`, so the props are typed against
 * `HTMLElement` rather than against `HTMLUListElement` or `HTMLOListElement`.
 * That is deliberate on both sides of the variance: event handlers declared
 * over the wider `HTMLElement` remain assignable to either tag's expected
 * handler type, while a `ref` — whose object form is invariant and so cannot be
 * typed across both tags at once — is intentionally not accepted. Nothing in
 * this project takes a ref to a list.
 *
 * `ordered` is a plain optional boolean rather than a discriminated union, so
 * `Prose` can pass `ordered={node.type === "orderedList"}` directly. A union
 * would be marginally more precise about `start` and `reversed` and would fail
 * to narrow on exactly that call.
 */
export interface ListProps extends React.HTMLAttributes<HTMLElement> {
  /** Render `<ol>` instead of `<ul>`. Bard `orderedList` sets this. */
  ordered?: boolean;
  /** First number of an ordered list. Ignored when `ordered` is false. */
  start?: number;
  /** Count an ordered list downwards. Ignored when `ordered` is false. */
  reversed?: boolean;
}

/**
 * A bulleted or numbered list, carrying body metrics and restoring the markers
 * and indent Preflight removes.
 *
 * Children are plain `<li>` elements: they inherit every metric from this
 * element, so `Prose` emits `listItem` nodes without a wrapper component.
 *
 * @example
 * ```tsx
 * <List ordered start={3}>
 *   <li>Submit the application</li>
 * </List>
 * ```
 */
export function List({
  ordered = false,
  start,
  reversed,
  className,
  ...props
}: ListProps) {
  if (ordered) {
    return (
      <ol
        className={cn(LIST_ORDERED, className)}
        start={start}
        reversed={reversed}
        {...props}
      />
    );
  }
  return <ul className={cn(LIST_UNORDERED, className)} {...props} />;
}
