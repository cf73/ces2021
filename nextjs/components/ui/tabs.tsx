"use client"

/**
 * Tabs — one of the 38 registry-generated files among the 43 in
 * `components/ui/` (§0.3.5).
 *
 * ## Provenance
 *
 * Registry membership was verified against the pinned CLI BEFORE generating,
 * as §0.3.1 requires: `shadcn view tabs` (CLI 4.19.0) resolved and reported
 * `type: registry:ui`, file `registry/new-york-v4/ui/tabs.tsx`, and exactly one
 * dependency — `radix-ui`, already pinned exact at 1.6.7. The body below is
 * `shadcn add tabs` output against the committed `components.json`
 * (`style: new-york`, `rsc: true`, `utils: @/lib/utils`), which touched no
 * other file. Keep it that way: the class strings are deliberately left
 * byte-identical to the registry apart from the two corrections recorded
 * below, so the diff from a future `shadcn add tabs` stays readable.
 *
 * ## Why this component exists
 *
 * It is the tab strip of the globals editor panel (§0.3.2, "Globals editor
 * panel"), which answers user requirement 4 — a section for site data that
 * appears in multiple instances and cannot be edited in place. `GlobalsSheet`
 * mounts SIX tabs inside a right-side `Sheet`, one per §0.4.2 key group:
 * Contact and Address, Social and Portal Links, Branding, Announcement
 * Presentation, Analytics, and Maintenance. Every value behind those tabs is a
 * template literal in the legacy site — the address, phone and fax at
 * `resources/views/layout.antlers.html:46-49`, the contact address at :50, the
 * two social URLs at :51-52, the donate target at :54, the logo at :33, the
 * Google Ads tag at :4 and StatCounter's project and security token at :85-87
 * and again in the noscript pixel at :95 — so this strip is the whole surface
 * through which non-technical school staff take ownership of values that today
 * require editing a PHP template and redeploying. §0.4.3 makes "change the
 * school phone number in globals" one of five timed, unaided acceptance tasks.
 *
 * Three consumer obligations follow, and all three are met by the code below
 * rather than by the caller:
 *
 *   1. A trigger must be OMITTABLE. The Maintenance tab is admin-only
 *      (§0.3.2), and §0.4.2 puts every `site_globals` write under `admin`
 *      rather than `editor`, so an editor renders five tabs and an admin six.
 *      Nothing here indexes, counts or positions triggers: Radix derives roving
 *      focus from the triggers actually mounted, so arrow, Home and End
 *      navigation traverse whatever set is present with no dead stop. Do not
 *      add index arithmetic or a fixed trigger count.
 *   2. Six triggers must survive 320 px. See the responsive layer below.
 *   3. Controlled AND uncontrolled use. Both come from the full
 *      `React.ComponentProps<typeof TabsPrimitive.Root>` pass-through: `value`
 *      with `onValueChange` for controlled, `defaultValue` for uncontrolled,
 *      plus `orientation`, `dir` and `activationMode`. No prop is intercepted.
 *
 * Nothing about validation, capability enforcement or confirmation lives here.
 * §0.3.2 puts the Maintenance tab's confirmation step in `AlertDialog`, and
 * §0.4.2 enforces capability in the database through `security definer` write
 * functions — a hidden trigger is a courtesy, never a control.
 *
 * ## The two corrections to registry output, both measured
 *
 * §0.3.5 exempts generated internals from the zero-hardcoded-values rule, so
 * every arbitrary value the registry emits — `p-[3px]`, `h-[calc(100%-1px)]`,
 * `ring-[3px]`, `after:bottom-[-5px]`, the `[&_svg]` descendants — is left
 * exactly as generated and is inventoried rather than failed by
 * `npm run audit:tokens`. DO NOT "tidy" them. Three things were changed, and
 * none of the three is cosmetic:
 *
 *   1. SEVEN `dark:` utilities were REMOVED. §0.3.3 ships one light theme, and
 *      in this project `dark:` is live rather than dead: no `.dark` block and
 *      no `@custom-variant dark` exists in `app/globals.css` or in
 *      `shadcn/tailwind.css` (which defines nine `data-*` variants and never
 *      `dark`), so Tailwind 4's built-in variant applies. Compiling this file
 *      through `@tailwindcss/postcss` emits those classes inside
 *      `@media (prefers-color-scheme: dark)` — measured, not assumed. Left in,
 *      any visitor whose OS is set to dark would lose the active tab's
 *      distinguishing near-white `bg-background` pill to the dark-variant fill
 *      `--input` at 30% alpha, which over the `bg-muted` track is oklch 90% on
 *      96.5% — visually indistinguishable from an inactive tab. Restoring them
 *      requires first declaring a real dark theme, which §0.3.3 rules out.
 *      Verified in Chrome after removal: the compiled stylesheet contains zero
 *      rules under any `prefers-color-scheme` condition, and full-page
 *      screenshots under emulated dark and light are byte-identical.
 *   2. The inactive trigger's label colour, `--foreground` at 60% alpha,
 *      became `text-muted-foreground`. Composited over the `bg-muted` track,
 *      `--foreground` at 60% measures 3.28:1 against the 4.5:1 that WCAG 2.2
 *      AA 1.4.3 asks of 14 px/weight-500 text; `--muted-foreground` on the same
 *      track measures 5.87:1. The substitute is not invented — it is the token
 *      `tabsListVariants` already sets on the list, and the one the registry
 *      itself reaches for under `dark:`. This follows §0.3.3's own practice of
 *      darkening a value that fails AA and recording the ratio (`--secondary`
 *      3.21:1 → 4.54:1, `--primary` 3.51:1 → 4.56:1). Untouched because they
 *      already pass: the active label on its pill at 10.33:1 (the pill is
 *      `--background`, oklch 98.5% — near-white, not #fff, so the ratio is
 *      10.33:1 rather than the 10.78:1 pure white would give) and hover at
 *      9.77:1. Chrome reports the inactive label as rgb(89, 96, 88) on
 *      rgb(244, 244, 238), reproducing the 5.87:1 figure exactly.
 *   3. `TabsContent`'s outline-suppressing utility was REMOVED, leaving
 *      `flex-1`. Radix makes the panel focusable (`tabIndex: 0`) so that Tab
 *      leaves the strip and lands in the panel, and the registry then
 *      suppresses its ring. Measured in Chrome, that combination cost a
 *      keyboard user a blind stop: with the panel genuinely focused and
 *      matching `:focus-visible`, computed `outline-style` was `none`,
 *      `box-shadow` `none`, and a screenshot of the focused state was
 *      byte-identical to the unfocused one — zero pixels of feedback. The
 *      suppression sat in the `utilities` layer and so overrode
 *      `app/globals.css`'s base-layer `:focus-visible` ring, which is the
 *      project's declared repair for the legacy `outline: none !important` at
 *      `public/css/style.css:8169`; globals.css states that `outline: none`
 *      must not appear anywhere in this project. No Figma or other design
 *      source specifies a focus treatment here (§0.10 records that none was
 *      provided), so the governing instruction is to apply a visible
 *      `:focus-visible` outline consistent with the design — which is exactly
 *      what deleting one utility restores, at no cost to pointer users since
 *      `:focus-visible` does not match a mouse click.
 *
 * ## Invariants
 *
 *   - Primitives come from the consolidated `radix-ui` package (§0.6.5). A
 *     `@radix-ui/react-tabs` import is a lint error at `--max-warnings=0`.
 *   - No colour literal, and no `white`/`black` keyword: `audit:tokens` fails
 *     on one even in a generated file, colour being the axis where a stray
 *     literal breaks the brand contract.
 *   - Nothing here may suppress an outline. §0.3.3 calls `--ring` "the token
 *     that restores the focus indicator", so the trigger's
 *     `focus-visible:ring-ring/50` and `focus-visible:outline-ring` are
 *     load-bearing, and correction 3 above is the panel's half of the same
 *     rule. Photographed in Chrome: the trigger's indicator draws 3 px outside
 *     its border box and is not clipped, because the list keeps
 *     `overflow: visible` on both axes.
 */

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * The 320 px contract, applied on top of the registry classes rather than
 * inside them.
 *
 * The globals panel's six labels — "Contact and Address", "Social and Portal
 * Links", "Branding", "Announcement Presentation", "Analytics", "Maintenance"
 * — run to roughly 790 px at `text-sm` with the registry's
 * `whitespace-nowrap`. On a 320 px viewport the generated `inline-flex w-fit`
 * strip at its fixed 36 px height therefore overflows its container and is
 * clipped, which §0.4.5's 320 px tab sweep does not permit: every focused
 * element must be fully visible in the viewport.
 *
 * Wrapping, not scrolling, is the fix. `overflow-x: auto` forces `overflow-y`
 * to `auto` as well — one axis leaving `visible` takes the other with it — so a
 * scroll strip would clip the trigger's own focus ring, which needs 3 px of
 * ring plus the global 2 px outline at 2 px offset against only 3 px of list
 * padding. That trades a layout defect for an accessibility one. Wrapping
 * needs no scroll container, hides no trigger behind an affordance a
 * non-technical user has to discover, and self-regulates: `flex-wrap` wraps
 * only when the line is full, so a desktop strip with room to spare still
 * renders as one row.
 *
 * Measured in Chrome, the one cosmetic cost of an auto height: at 1280 px the
 * strip is 37 px rather than the registry's 36 px. Making the height auto means
 * the trigger's own percentage height no longer resolves against a definite
 * parent, so it falls back to its content box — 31 px instead of 29 px — and
 * the 3 px padding either side gives 37. A 1 px difference on a strip that
 * would otherwise clip two thirds of its labels on a phone is the right trade;
 * forcing it back would mean overriding the trigger's height too, which is a
 * larger deviation from the registry for a pixel nobody can see.
 *
 * At 320 px the same measurement run confirmed the intent: the six triggers
 * wrap to five rows, every rect sits inside the list's box with the declared
 * 3 px of padding above and below, none is clipped, the narrowest clearance to
 * the viewport edge is 36 px, and `documentElement.scrollWidth` stays at 320
 * with zero elements anywhere on the page crossing that edge.
 *
 * Three classes, each deliberate:
 *
 *   - `flex-wrap` — unmodified, so a caller can switch it off with a no-wrap
 *     utility of their own. Left unscoped rather than tied to the horizontal
 *     orientation because a vertical list is `h-fit`, hence never
 *     height-constrained, hence never wraps.
 *   - `group-data-[orientation=horizontal]/tabs:h-auto` — the fixed 36 px
 *     height above would clip the second and third rows. Scoped to the
 *     horizontal modifier so the vertical orientation keeps its own `h-fit`.
 *     Because the modifier string is identical to the one carrying that fixed
 *     height, `tailwind-merge` resolves the two as one class group and DROPS
 *     the fixed one from the output — there is no duplicate class and no
 *     specificity fight. Verified against tailwind-merge@3.6.0.
 *   - `group-data-[orientation=horizontal]/tabs:min-h-9` — preserves the
 *     registry's 36 px floor for the common single-row case.
 *
 * Position is load-bearing: this string is passed AFTER the variant output so
 * it wins the height, and BEFORE `className` so the caller still wins over it.
 *
 * One caveat about editing the prose above, learned by measuring the compiled
 * stylesheet: Tailwind's scanner is a text scanner and does not skip comments,
 * so writing a complete utility name here EMITS that utility. Naming the four
 * classes this file removed or replaced added four dead rules to the build,
 * one of them an `@media (prefers-color-scheme: dark)` block — documentation
 * quietly reintroducing the very thing it documents removing. Describe a class
 * this file does not use by its token or its value, never by its full utility
 * name.
 */
const tabsListResponsive =
  "flex-wrap group-data-[orientation=horizontal]/tabs:h-auto group-data-[orientation=horizontal]/tabs:min-h-9"

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), tabsListResponsive, className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
