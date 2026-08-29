/**
 * Breadcrumb — the shadcn/ui registry primitive for the site's parent chain.
 *
 * ## PROVENANCE, AND THE REGENERATION CONTRACT
 *
 * Everything below the closing of this comment is BYTE-FOR-BYTE the output of
 * the pinned registry, generated as §0.3.1 requires rather than transcribed:
 *
 *   npx shadcn@4.19.0 view breadcrumb   -> resolves; type registry:ui;
 *                                          dependencies: ["radix-ui"] only
 *   npx shadcn@4.19.0 add breadcrumb    -> creates this file (2,350 bytes)
 *
 * Membership was confirmed against the pinned CLI BEFORE generating, so this
 * is one of the 38 generated files among the 43 in `components/ui/` and not one
 * of the 5 authored compositions (`dropzone`, `layout`, `typography`,
 * `date-picker`, `data-table`). The registry item declares no `cssVars` and no
 * `tailwind` key, so generation added nothing to `app/globals.css`; its single
 * declared dependency, the consolidated `radix-ui` package, was already pinned
 * at 1.6.7, so it added nothing to `package.json` either. Both files were
 * checksummed before and after to prove it.
 *
 * §0.3.4 mandates post-generation edits for exactly two of the 38 —
 * `badge.tsx` and `sonner.tsx` — and this is neither. Nothing in the component
 * code is modified: not a class, not a prop, not an element. This header is
 * additive documentation, which is the one thing a regeneration can safely
 * clobber, and keeping the code identical is what makes the diff after a
 * registry upgrade reviewable rather than a merge.
 *
 * That is also why this file is not Prettier-formatted (the registry emits no
 * semicolons) and why it matches the convention already set by the other
 * generated file in this tree, `hooks/use-mobile.ts`. `format:check` is not a
 * CI gate; `tsc --noEmit`, `eslint --max-warnings=0`, `vitest` and
 * `audit:tokens` are, and this file passes all four.
 *
 * ## THE PUBLIC API
 *
 * Seven parts, exactly the §0.3.2 "Breadcrumb strip" contract:
 *
 *   Breadcrumb           the <nav> landmark, pre-labelled `aria-label="breadcrumb"`
 *   BreadcrumbList       the <ol>; wraps and breaks words, which is the 320px rule
 *   BreadcrumbItem       the <li>
 *   BreadcrumbLink       takes `asChild`, so `next/link` supplies the anchor
 *   BreadcrumbPage       the current page: a <span>, never a link to itself
 *   BreadcrumbSeparator  accepts custom children; falls back to a chevron
 *   BreadcrumbEllipsis   the collapse affordance for a long chain
 *
 * ## THE TWO LEGACY DEFECTS THIS REPAIRS, AND WHY STRUCTURE IS THE FIX
 *
 * `resources/views/_breadcrumb.antlers.html` was 251 bytes and, included via
 * `{{partial:breadcrumb}}` on eight page types, carried both defects to all of
 * them. It emitted, verbatim:
 *
 *   <span class="crumb small" {{ if is_current }} class="current"{{ /if }}>
 *       <a href="{{ url }}">{{ title }}</a> /&nbsp
 *   </span>
 *
 *   1. TWO `class` ATTRIBUTES ON ONE ELEMENT. Duplicate attributes are not an
 *      error the browser reports: it keeps the first and silently discards the
 *      second, so `class="current"` never applied and the current-page marker
 *      has never once rendered in production. A component cannot fix that by
 *      being more careful with class strings — every class here goes through a
 *      single `cn()` call producing a single `className`, so a second `class`
 *      attribute is unreachable by construction. The real repair is structural:
 *      the current item is a DIFFERENT ELEMENT, `BreadcrumbPage`, which also
 *      carries `aria-current="page"`. That fixes a third defect the source had
 *      and the brief does not name — the legacy markup wrapped every crumb
 *      including the current one in `<a href>`, so the page linked to itself
 *      and conveyed its position to assistive technology not at all.
 *
 *   2. `/&nbsp` IS A MALFORMED ENTITY. With no terminating semicolon it is not
 *      a non-breaking space; it is the literal seven characters, rendered as
 *      text and read aloud as text. `BreadcrumbSeparator` replaces it with a
 *      real element carrying `role="presentation"` and `aria-hidden="true"`:
 *      visible to the eye, silent to a screen reader. Because it accepts
 *      children, a consumer may pass the school's own glyph and still inherit
 *      that silence.
 *
 * ## WHAT DRIVES THIS COMPONENT — AND WHAT MUST NOT
 *
 * §0.4.2 keeps four concepts apart and this primitive renders the SECOND:
 *
 *   1. URL parent               `pages.parent_id`
 *   2. BREADCRUMB PARENT        also `pages.parent_id` — rendered here
 *   3. Menu membership + order  `nav_items`, rendered by `NavTree`
 *   4. Contextual child lists   a published-children query
 *
 * A breadcrumb fed from `nav_items` would claim a parent the URL does not
 * have. The migration's own worked example: Donate is seeded as a MENU child
 * of Giving while its URL stays `/donate`, so a menu-driven chain would render
 * "Giving / Donate" for a page that has no parent segment at all. This file
 * cannot make that mistake — it holds no data access whatsoever, which
 * `eslint.config.mjs` enforces for everything under `components/**` by
 * forbidding any `lib/supabase/*` import. The chain is resolved upstream and
 * arrives as children.
 *
 * `components/site/StructuredData.tsx` emits a `BreadcrumbList` JSON-LD object
 * from that same resolved chain. Derive both from one source so the visible
 * chain and the structured one cannot disagree.
 *
 * ## WHAT BELONGS TO THE CONSUMER, NOT HERE
 *
 * The sticky bar is `components/site/Breadcrumbs.tsx` and the `(site)` layout;
 * this primitive is deliberately position-neutral and sets no height, so it
 * cannot fight the chrome that contains it. The legacy `.bread`
 * (`resources/sass/elements.scss:134-158`) was `position: fixed` at a hard
 * 70px (45px at the large breakpoint) with a five-digit z-index and a raw
 * translucent hex background. Its replacements are all tokens the consumer
 * applies: the height token for 70px, the sticky layering token — never a
 * five-digit z-index, which is what let the legacy hamburger at seven digits
 * sit over the bar and clip a crumb to "rams / Program" — a token-resolved
 * surface colour rather than a hex literal, and the `chrome-safe-*` utilities
 * for `env(safe-area-inset-*)`. Scroll compensation is already global in
 * `app/globals.css`, which sets `scroll-padding-top` and a matching
 * `scroll-margin-top` on anchor targets from the same chrome tokens: that is
 * the repair for a legacy bar that obscured whichever heading you scrolled to.
 *
 * THREE TRAPS IN THAT BAR, EACH MEASURED IN A BROWSER RATHER THAN REASONED
 * ABOUT. A prototype of the bar was rendered with the real compiled stylesheet
 * and inspected in headless Chrome; all three failed silently, which is why
 * they are recorded here instead of being left for the next reader to redshift
 * into production:
 *
 *   - `z-sticky` AND `h-bread` GENERATE NO CSS AT ALL. Tailwind 4 derives
 *     utilities from theme namespaces, and it has no `--z-*` namespace and no
 *     `--size-*`-to-height mapping. Both classes are therefore dropped in
 *     silence: the compiled sheet contained zero `z-index` declarations and the
 *     bar measured `z-index: auto` at every viewport. A hit-test probe then
 *     reproduced the exact legacy failure — a later `position: fixed` sibling
 *     painted over the bar and stole the crumb's hit target. Write the custom
 *     property shorthand instead, `z-(--z-sticky)` and `h-(--size-bread)`,
 *     which compile to `z-index: var(--z-sticky)` and `height:
 *     var(--size-bread)`. That form is also what `audit-tokens.mjs` recognises
 *     as a token REFERENCE, so it is checked to resolve and is not counted as
 *     an arbitrary value even in an authored file.
 *
 *   - A GUTTER UTILITY ON THE SAME ELEMENT AS `chrome-safe-inline` LOSES.
 *     Both set the inline padding axis in the same `@layer utilities`, so the
 *     later one wins outright rather than composing, and with no safe-area
 *     insets reported it resolves to zero — measured `padding-left: 0px` and
 *     the first crumb flush against x=0. `app/globals.css` states this
 *     requirement in its own comment: put the gutter on an INNER wrapper.
 *
 *   - THAT ZEROED GUTTER CLIPS THE FOCUS RING OUT OF THE VIEWPORT. With the
 *     first crumb at x=0, the global `:focus-visible` ring — 2px at a 2px
 *     offset — paints from x=-4, and `scrollLeft` cannot reach it. Pixel
 *     inspection of a 320px screenshot found the left vertical stroke simply
 *     absent. That breaks the §0.4.5 requirement that every focused element be
 *     fully visible during the 320px tab sweep, so it is a real accessibility
 *     regression produced by a padding mistake two elements away. Restoring
 *     the inner gutter fixed it: re-measured, the ring box starts at x=12 and
 *     all four strokes are drawn.
 *
 * With those three corrected, the same harness measured clean at 320px:
 * `scrollWidth === clientWidth === 320`, not one element out of bounds, and
 * the deep chain "School Age Mandarin – Grades K through 3rd" wrapping onto
 * three flex lines with every ancestor left at `overflow-x: visible` — so the
 * chain fits rather than being clipped, which is precisely what the legacy
 * `overflow: hidden` masked.
 *
 * THE SPACE MONO VOICE, WITH THE TRAP MEASURED. `.crumb` was
 * `font-family: $mono` (`elements.scss:163-165`), and §0.3.3 calls that the
 * site's recognizable accent voice, carried by the meta type role. Preserving
 * it is the consumer's job, and the obvious way to do it is wrong. The
 * generated list below sets both a font-size class and a muted colour class;
 * `tailwind-merge` cannot know that a project-defined meta type token is a
 * font size, so it classifies it as a text COLOUR. Measured against
 * `tailwind-merge@3.6.0`, passing the meta type class through `className`
 * DROPS the muted colour, and re-stating the colour after it drops the meta
 * class instead — the two are mutually exclusive on this element and no
 * ordering rescues them.
 *
 * The verified recipe, therefore: pass `font-mono` (which collides with
 * nothing) to `BreadcrumbList`, and put the meta type class on the outer
 * sticky wrapper, where its letter-spacing inherits into the list and no merge
 * conflict exists. The generated font size is 0.875rem, the same value the
 * meta role declares, so the rendered size is identical either way and what
 * the wrapper adds is the tracking and the family. Both the muted colour and
 * the accent voice survive.
 *
 * ## COMPLIANCE NOTES
 *
 * Zero colour literals: every colour is a semantic utility resolving to a
 * token in `app/globals.css`. That is the axis §0.3.5 refuses to exempt even
 * in generated output, and `npm run audit:tokens` fails on a violation here.
 * The arbitrary values that remain are SIZING only — the gaps, the icon box
 * and the svg-descendant variant — and §0.3.5 exempts those in generated files
 * deliberately, so rewriting them would defeat the point of pinning the
 * registry. One light theme ships (§0.3.3), so no `dark:` variant is authored.
 *
 * Imports satisfy §0.6.5 at `--max-warnings=0`: `Slot` from the consolidated
 * `radix-ui` and never `@radix-ui/react-slot`; both icons as NAMED
 * `lucide-react` imports and never a namespace, which would pull the whole
 * icon set into a bundle budgeted at 180KB of compressed JavaScript; and `cn`
 * from the `@/lib/utils` alias.
 *
 * Accessibility (§0.4.5, WCAG 2.2 AA, with Lighthouse asserting 1.00): the
 * landmark is named, so a page carrying more than one navigation region stays
 * unambiguous — net-new, since the legacy document had two `role` attributes
 * in total and no `aria-*` at all. Note that `BreadcrumbEllipsis` is
 * `aria-hidden`, so its "More" text is not announced; the registry treats the
 * ellipsis as decorative, and a consumer that needs it operable wraps it in a
 * `DropdownMenu` trigger, which is the documented composition.
 */

import * as React from "react"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground sm:gap-2.5",
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  )
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "a"

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn("transition-colors hover:text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  )
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  )
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
