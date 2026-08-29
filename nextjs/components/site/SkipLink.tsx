/**
 * `SkipLink` — the first focusable element on every public page.
 *
 * ## Authority
 *
 * No user-specified rules were provided for this project: `review_rules`
 * returns `No user rules provided.`, and §0.8 of the technical specification
 * states the same independently. Nothing below originates from a project rule
 * document. That absence is not licence to lower the bar, so this component is
 * held to the specification and to enterprise-standard practice:
 *
 *   §0.4.5 "Accessibility" — the authoritative paragraph: "A `SkipLink` is the
 *          first focusable element in the `(site)` layout, visually hidden
 *          until `:focus-visible`, targeting `<main id="main">`; activating it
 *          moves focus past the header, the CTA bar and the breadcrumb, and a
 *          test asserts focus lands in `main` and is visible clear of the
 *          sticky chrome. It sits in the chrome layout rather than the
 *          `(pages)` layout so a 404 has one too."
 *   §0.4.5 "Sticky chrome" — every fixed bar sits inside
 *          `env(safe-area-inset-*)` padding; focus rings use `outline-offset`
 *          and must clear those bars.
 *   §0.3.5 "Zero hardcoded values" — this is authored code, so it carries no
 *          registry exemption. Every value below resolves to a token declared
 *          in `app/globals.css`; the only literals are the permitted `0`,
 *          `none`, `auto`, `inherit`, `currentColor` and `transparent`.
 *   §0.2.2 — one light theme ships, so there is no `dark:` variant anywhere.
 *
 * ## The baseline this repairs
 *
 * Measured across ten legacy routes, the server-rendered HTML carried **no
 * `<main>` element, no skip link, zero `aria-*` attributes, zero `tabindex`**
 * and exactly two `role` attributes (`complementary` and `navigation`, both in
 * `resources/views/layout.antlers.html:30-31`). Focus was invisible site-wide:
 * `public/css/style.css:8169` set `outline: none !important` on `a:hover,
 * a:focus`, and `:focus-visible` appeared **zero times in all six** legacy
 * stylesheets — across fifteen measured mobile tab stops not one showed an
 * indicator. Worse for this component specifically, the collapsed sidebar was
 * `visibility: visible` at `translateX(-270px)` with neither `aria-hidden` nor
 * `inert`, so **thirteen invisible off-screen tab stops preceded any on-screen
 * content** (§0.7.2). Even once `SiteSidebar` fixes that, a keyboard or screen
 * reader user still has the header, the mobile CTA bar and the breadcrumb strip
 * to traverse before reaching content. This link is the escape hatch, and
 * `--ring` — the token §0.3.3 identifies as the one that restores the
 * suppressed indicator — is what makes it visible when it arrives.
 *
 * ## Where it is mounted, and why that placement is not interchangeable
 *
 * Mounted by **`app/(site)/layout.tsx`**, the chrome layout, as the first child
 * of `<body>`'s content — *not* by `app/(site)/(pages)/layout.tsx`. A route
 * group layout wraps every route physically inside it, and §0.4.1 puts
 * `not-found.tsx` at the `(site)` level: inside the chrome, outside the
 * analytics subtree. Mounting this in `(pages)` would therefore leave a 404
 * with navigation but no way to skip it. It renders unconditionally — never
 * gated on edit mode, on a session, or on a feature flag — because an
 * accessibility escape hatch that appears only in some states is not one.
 *
 * ## The contract with the layout that mounts it
 *
 * Three obligations sit on the mounting layout rather than here, and all three
 * must hold or this link degrades to a no-op:
 *
 *   1. **`<main id="main" tabIndex={-1}>`.** The `id` is what the fragment
 *      resolves to, and `tabIndex={-1}` is what makes the element focusable so
 *      the browser MOVES FOCUS there rather than merely scrolling. Without it a
 *      screen reader's virtual cursor may follow the jump while the keyboard
 *      focus ring stays behind in the header — the exact failure this component
 *      exists to prevent. Pass `targetId` if that element is given another id.
 *   2. **First in document order.** "First focusable" is a property of the DOM,
 *      not of this file; nothing focusable may precede it.
 *   3. **Scroll compensation.** Already provided centrally: `app/globals.css`
 *      declares `html { scroll-padding-top: calc(var(--size-nav) +
 *      var(--size-bread)) }` and `:target { scroll-margin-top: <the same> }`,
 *      so activating this link cannot park the heading behind the fixed header.
 *      This component deliberately does not restate that offset — one owner.
 *
 * ## Why the hiding technique is clipping rather than movement
 *
 * The element must be invisible yet **focusable**, which rules out
 * `display: none` and `visibility: hidden` — either removes it from the tab
 * order entirely. It also rules out hiding by moving the box (`-top-full`,
 * `-translate-y-full`): a `position: fixed` element is positioned against its
 * nearest ancestor that establishes a containing block, and any ancestor with
 * `transform`, `filter`, `backdrop-filter`, `will-change` or `contain` becomes
 * one. Under such an ancestor a movement-based hide can leave the "hidden" link
 * rendered mid-viewport, and nothing warns you. Clipping cannot fail that way,
 * so the box stays at one stable position in both states and only its size,
 * overflow and opacity change. The element remains in the accessibility tree
 * throughout, which is correct: a skip link should be announced.
 *
 * `pointer-events-none` at rest is not decoration — it stops the 1px box from
 * intercepting a click in the top-inline-start corner, and it is what makes the
 * `:focus` reveal below safe, since a pointer can then never focus this link.
 *
 * ## Tests this component is answerable to
 *
 * Owned by other files, listed so their authors have the contract in one place:
 * `tests/e2e/a11y.spec.ts` asserts it is the FIRST focusable element on a
 * public page, that activating it lands focus INSIDE `main`, and that the
 * focused element is fully visible clear of the sticky chrome — then repeats the
 * whole check against a genuinely unmatched path, so the 404 is covered;
 * `tests/e2e/responsive.spec.ts` asserts the revealed link sits inside
 * `env(safe-area-inset-*)` padding on a notched viewport and is fully within a
 * 320px viewport; the 320px tab sweep is a manual release gate recorded in
 * `artifacts/accessibility-record.md`.
 *
 * One procedural trap, from validating this component in a real browser: press
 * the first `Tab` from a document-start position. Clicking into the page first
 * can land on `<main>`, and the `tabIndex={-1}` above makes `main`
 * mouse-focusable by design, which moves the sequential-focus starting point
 * past this link and gives a false failure. The `tabIndex` is required by the
 * contract; the test procedure is what has to accommodate it.
 *
 * ## Boundary
 *
 * A Server Component: no `"use client"`, no hook, no state, no data access and
 * no effect. Every state change is CSS, which is what lets the whole feature
 * work with JavaScript disabled and adds nothing to the client bundle. It
 * imports exactly one module — `cn` — and nothing from `components/cms/**`,
 * `@/lib/supabase/*` or `@/lib/content/*`.
 */

import { cn } from "@/lib/utils";

/**
 * The `id` of the landmark this link targets, matching the `<main id="main">`
 * that `app/(site)/layout.tsx` renders. Declared once here so the default and
 * the documented contract cannot drift apart.
 */
const DEFAULT_TARGET_ID = "main";

/**
 * The default accessible name. It is the element's visible text, so no
 * `aria-label` is set — an `aria-label` would override the rendered words and
 * silently desynchronise what a screen reader announces from what a sighted
 * keyboard user reads.
 */
const DEFAULT_LABEL = "Skip to main content";

/**
 * Props for {@link SkipLink}.
 *
 * Exactly three, all optional, and deliberately **not** extending the intrinsic
 * anchor props. A rest spread would let a caller pass `href`, `tabIndex`,
 * `hidden` or `onClick` and quietly break the one guarantee this component
 * makes; the narrow surface is the guarantee.
 */
export interface SkipLinkProps {
  /**
   * The `id` of the element to skip to, without the leading `#`.
   *
   * A leading `#` is tolerated and stripped, surrounding whitespace is trimmed,
   * and an empty or whitespace-only value falls back to `"main"` rather than
   * emitting `href="#"` — which would scroll to the top of the page and move
   * focus nowhere. Must be a valid HTML `id` (no whitespace) on an element that
   * is focusable, i.e. carries `tabIndex={-1}` unless it is natively focusable.
   */
  readonly targetId?: string;

  /**
   * The visible link text, which is also its accessible name.
   *
   * Trimmed; an empty or whitespace-only value falls back to
   * `"Skip to main content"`, so the element can never render as an unnamed
   * link — an unnamed link is a WCAG 2.4.4 failure and is exactly what the
   * legacy nav toggle was.
   */
  readonly label?: string;

  /**
   * Extra classes for the positioned outer element, merged last so a caller can
   * override any utility above. Values must still resolve to tokens declared in
   * `app/globals.css`; `npm run audit:tokens` fails on a literal here.
   */
  readonly className?: string;
}

/**
 * Normalises a caller-supplied fragment target into a bare HTML `id`.
 *
 * @param value The raw `targetId` prop, possibly absent, padded or `#`-prefixed.
 * @returns A non-empty id, never `""`, so the rendered `href` always addresses
 *   a real element rather than the top of the document.
 */
function resolveTargetId(value: string | undefined): string {
  const trimmed = value?.trim().replace(/^#+/, "").trim() ?? "";

  return trimmed.length > 0 ? trimmed : DEFAULT_TARGET_ID;
}

/**
 * Normalises the visible label.
 *
 * @param value The raw `label` prop, possibly absent, empty or whitespace.
 * @returns A non-empty string. Never `undefined` and never the text `"null"` or
 *   `"undefined"`, both of which a bare `{label}` interpolation can render.
 */
function resolveLabel(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";

  return trimmed.length > 0 ? trimmed : DEFAULT_LABEL;
}

/**
 * Renders the skip link.
 *
 * The markup is two elements for one reason, and it is a constraint rather than
 * a preference: `app/globals.css` states that `chrome-safe-*` sets the
 * safe-area padding on the OUTER element and that "any additional padding
 * belongs on an inner wrapper, because a second padding utility on the same
 * element and axis would override rather than compose with these". So the
 * anchor owns position, layer, safe area and visibility, and the inner span
 * owns the pill. The anchor is still the single focusable element.
 *
 * @param props See {@link SkipLinkProps}.
 * @returns One anchor addressing `#<targetId>`.
 */
export function SkipLink({ targetId, label, className }: SkipLinkProps) {
  const resolvedTargetId = resolveTargetId(targetId);
  const resolvedLabel = resolveLabel(label);

  return (
    <a
      data-slot="skip-link"
      href={`#${resolvedTargetId}`}
      className={cn(
        // Out of flow, so this element can never add to the page's layout or
        // scroll extent, and one stable position in both states. `start-2`
        // rather than `left-2`: logical properties throughout. The 8px inset
        // matters — it is what keeps the 2px focus ring at 2px offset fully on
        // screen instead of clipped against the viewport edge.
        "fixed start-2 top-2",
        // `--z-*` is not a Tailwind namespace, so there is no `z-80` utility;
        // the parenthesis shorthand reads the token directly. `--z-edit` (80) is
        // the declared ceiling of the scale, chosen because an accessibility
        // escape hatch must not be coverable by the header (`--z-nav`, 30), the
        // sticky CTA bar (`--z-sticky`, 20), a dropdown, an overlay, a modal or
        // a toast. It ties with the edit chrome, where DOM order breaks the tie
        // in this element's favour: it is rendered first.
        "z-(--z-edit)",
        // The safe-area contract. Both utilities fall back to `0px` where the
        // platform reports no inset, so on an unnotched device the anchor box
        // collapses onto the pill and the inherited focus ring hugs it exactly.
        "chrome-safe-inline chrome-safe-top",
        // Hidden, but focusable and announced. A 1x1 clipped, fully transparent
        // box: no `display: none` and no `visibility: hidden`, either of which
        // would drop it out of the tab order and defeat the whole component.
        "size-px overflow-hidden opacity-0",
        // See the header note: this is what makes the `focus:` reveal safe.
        "pointer-events-none",
        // Revealed. `:focus-visible` is the specified trigger and `:focus` is
        // its superset, applied as well because a link that is focused and
        // invisible is a WCAG 2.4.7 failure: `:focus-visible` is not guaranteed
        // to match when focus arrives programmatically after a pointer
        // interaction. It costs nothing here, because `pointer-events-none`
        // above means a pointer can never focus this link at rest.
        "focus:size-auto focus:overflow-visible focus:opacity-100",
        "focus:pointer-events-auto",
        "focus-visible:size-auto focus-visible:overflow-visible",
        "focus-visible:pointer-events-auto focus-visible:opacity-100",
        // The restored indicator. Identical to the `:focus-visible` rule in
        // `app/globals.css`, so there is one ring and not two, but stated here
        // as well so the component carries its own contract and can be asserted
        // in isolation. `outline-offset` is load-bearing rather than polish:
        // `--ring` resolves to the same blue as `--secondary`, measuring 4.32:1
        // against the page ground but only 1.01:1 against a brand fill, and the
        // offset is what places the ring against the ground. `outline-none` is
        // forbidden project-wide and appears nowhere.
        "focus-visible:outline-2 focus-visible:outline-offset-2",
        "focus-visible:outline-ring",
        className,
      )}
    >
      <span
        className={cn(
          // `block` because vertical padding on an inline box does not grow the
          // line box. Not a flex or grid utility: §0.3.5 permits those only in
          // `components/ui/layout.tsx`, and none is needed.
          "block",
          // The legacy button identity, preserved: `--radius-pill` is exactly
          // the 30px radius `public/css/ces.css:138` used. `--primary` is the
          // corrected brand green at 4.56:1 against its own foreground;
          // `--secondary` was rejected for the fill because `--ring` aliases it,
          // and a blue ring on a blue fill would lean entirely on the offset.
          "rounded-pill bg-primary text-primary-foreground shadow-card",
          // The touch target, sized by arithmetic rather than by a magic
          // number: `--text-sm` is 0.875rem at line-height 1.5, so the content
          // box is 21px, and `py-3` adds 12px on each side for 45px — clear of
          // the 44px `--size-control-touch` minimum §0.4.5 requires of touch
          // controls, and reached without a flex container or a `min-height`.
          "px-5 py-3",
          // Stated rather than inherited, so the label reads correctly wherever
          // this is mounted. Weight is left at the type role's own 400.
          "font-sans text-sm",
        )}
      >
        {resolvedLabel}
      </span>
    </a>
  );
}
