"use client"

/**
 * The shadcn/ui table primitive — one of the 38 registry-generated files among
 * the 43 in `components/ui/` (§0.3.5), and the component §0.3.5 singles out as
 * its cautionary case for the "registry components over raw HTML" rule:
 *
 *   "The legacy tuition tables are the cost of not following this rule: five
 *    `<table>` elements with no attributes, inheriting nothing but
 *    `border-collapse`, so prices collide with their labels at every viewport."
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE — generated, verified, and byte-identical to the registry
 * ---------------------------------------------------------------------------
 * Registry membership was confirmed against the pinned CLI *before* generation,
 * as §0.3.1 requires, rather than assumed from the classification table:
 *
 *   npx shadcn@4.19.0 view table   # exit 0 — the item resolves
 *   npx shadcn@4.19.0 add table    # run from `nextjs/`, against components.json
 *
 * `view` reports `type: "registry:ui"`, exactly one file
 * (`registry/new-york-v4/ui/table.tsx`), and **no `dependencies`,
 * `registryDependencies`, `devDependencies`, `cssVars` or `css` fields** — so
 * nothing was added to `package.json` and nothing was injected into
 * `app/globals.css`. That is why this item, unlike `calendar` or `carousel`,
 * contributes no entry to the §0.6.1 dependency inventory. It has no Radix
 * dependency at all: it is semantic markup plus token-bound classes.
 *
 * The code below is the registry payload verbatim, 2,478 bytes, unmodified.
 * Everything this file contributes beyond the registry is in this comment.
 * Two consequences of that choice are deliberate:
 *
 *   - **No post-generation edits.** Among the 38 generated files only
 *     `badge.tsx` (the gradient date-chip variant) and `sonner.tsx` (the
 *     `next-themes` import removal) carry mandated edits. This file carries
 *     none, and none is needed — see the prop contract below, which the
 *     registry output already satisfies. Keeping it byte-identical is what
 *     makes the next `shadcn add` a clean no-op instead of a merge conflict,
 *     which is the whole point of pinning the registry (§0.3.5).
 *   - **Not reformatted.** The registry emits shadcn's own style (no
 *     semicolons, double quotes, 2-space indent). Running `prettier --write`
 *     over it would be a post-generation edit for cosmetic gain; §0.6.6's
 *     `lint-types` job gates `tsc --noEmit` and `eslint . --max-warnings=0`,
 *     both of which this file passes as written, and formatting is not a gate.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — the eight parts §0.3.2 names
 * ---------------------------------------------------------------------------
 * | Export         | Element     | Contributes                                |
 * |----------------|-------------|--------------------------------------------|
 * | `Table`        | `<table>`   | The scroll container plus `caption-bottom`  |
 * | `TableHeader`  | `<thead>`   | A rule under the header row                 |
 * | `TableBody`    | `<tbody>`   | Suppresses the rule after the last row      |
 * | `TableFooter`  | `<tfoot>`   | Muted ground and medium weight for totals   |
 * | `TableRow`     | `<tr>`      | Row rule, hover and `data-state=selected`   |
 * | `TableHead`    | `<th>`      | Header cell: height, padding, weight        |
 * | `TableCell`    | `<td>`      | Data cell: padding and vertical alignment   |
 * | `TableCaption` | `<caption>` | The accessible table name                   |
 *
 * Every part is a plain function component over `React.ComponentProps<T>` for
 * its intrinsic element. There is no `forwardRef`: under React 19 a `ref` is an
 * ordinary prop, so `ref` travels with the spread like any other.
 *
 * ---------------------------------------------------------------------------
 * THE PROP CONTRACT — the load-bearing part, and why it is load-bearing
 * ---------------------------------------------------------------------------
 * Each part types its props as `React.ComponentProps<"th">`, `<"td">` and so on
 * and spreads `{...props}` straight onto the element. Three attributes ride on
 * that spread and all three are contractual, not incidental:
 *
 *   - **`scope`** — §0.3.2's tuition row states the requirement outright:
 *     "`TableCaption` mandatory; `TableHead` with `scope`." `scope="col"` binds
 *     a column header to its column and `scope="row"` binds a row header to its
 *     row, which is what lets a screen reader announce a figure together with
 *     the programme and schedule it belongs to. Without it a fee table is a
 *     grid of unattributed numbers.
 *   - **`colSpan` / `rowSpan`** — §0.3.2 requires the port to "preserve
 *     `colspan`, `rowspan` and `colwidth` from the source nodes". Measured
 *     against `content/collections/pages/tuition.md`: 8 `tableHeader` plus 22
 *     `tableCell` is 30 cells, and `colspan`, `rowspan` and `colwidth` each
 *     occur exactly 30 times — every single cell carries all three.
 *   - **`headers`** — available on the same spread as the belt-and-braces
 *     fallback for any irregular cell a span makes ambiguous.
 *
 * A component that destructured only `className` and dropped the rest would
 * compile, render, pass a visual review and silently fail WCAG 2.2 AA. The
 * spread is therefore asserted by test rather than trusted: the accompanying
 * unit tests render `TableHead scope="row"` and `TableCell colSpan={2}
 * rowSpan={2}` and assert the attributes reach the DOM.
 *
 * Note what is *not* here: `colwidth`. It is a ProseMirror attribute with no
 * HTML counterpart — the legacy editor emitted it as `data-colwidth` and, as
 * §0.7.3 records, it was "consumed by nothing". The renderer converts it to a
 * `<colgroup>`/`<col>` width, which is why it is a `TuitionTable.tsx` concern
 * and not a prop here.
 *
 * ---------------------------------------------------------------------------
 * CONSUMER 1 — the tuition fee schedule (public, and the highest-value fix)
 * ---------------------------------------------------------------------------
 * All 50 table-family nodes in the entire corpus live in one entry, and §0.7.3
 * calls the result "the single highest-value content fix in the rebuild".
 * Measured, the legacy page renders five bare `<table>` elements — 15 rows in
 * total, 8 `<th>` of which four are empty placeholders while the fifth table
 * has none at all. No `.table` class is ever applied, so Bootstrap's
 * `.table td, .table th { padding: .75rem; border-top: … }` never reaches them
 * and `border-collapse: collapse` is the only rule that does. Cell padding is
 * 1px, there are no borders and no caption, and labels collide with prices even
 * at desktop width: `"Morning (Mon-Fri, 8:30-12pm)$31,360"`. At 390px the
 * tables neither scroll nor clip — `overflow-x` is `visible` through the whole
 * ancestor chain — they just compress, and the five right edges land at 345,
 * 345, 357, 322 and 359, so the schedule reads as five unrelated fragments.
 *
 * This file supplies the three things that were missing: real token-derived
 * padding in place of the 1px, a `<caption>` element, and a scroll container.
 * `TuitionTable.tsx` supplies the rest of §0.4.5's contract — a caption naming
 * each programme, `scope="col"` and `scope="row"` associations, and every
 * figure, span and footnote marker carried across unchanged, including the
 * asterisked combined-programme rates.
 *
 * Figures are authored strings, never numbers. `lib/utils.ts` deliberately
 * exports no `formatPrice` for exactly this reason, so nothing on this path
 * re-formats `"$58,745*"` and no locale can turn a comma into a decimal point.
 *
 * ---------------------------------------------------------------------------
 * CONSUMER 2 — the authored `data-table.tsx`, and the boundary between them
 * ---------------------------------------------------------------------------
 * `components/ui/data-table.tsx` layers `@tanstack/react-table` over these
 * eight parts for the asset library (289 rows) and the collection-management
 * surfaces, which §0.3.2 notes are used by the admin surfaces and "not by any
 * public page". That dependency belongs to `data-table.tsx` alone and is
 * deliberately absent here: this file stays a neutral primitive so neither
 * consumer bleeds into the other, and so the public tuition page never pulls a
 * table-engine into its bundle. `TableRow`'s `data-[state=selected]` and the
 * `[role=checkbox]` padding rules are the seams the sorting-and-selection
 * consumer uses; the public page simply never sets them.
 *
 * ---------------------------------------------------------------------------
 * RESPONSIVE — what this file owes, and what it does not
 * ---------------------------------------------------------------------------
 * §0.4.5's matrix gives the tuition row three breakpoints: stacked labelled
 * blocks with no horizontal scroll below 576px, a horizontal scroll container
 * with a visible affordance from 576 to 991px, and the full table at 992px and
 * above. The transformation itself belongs to `TuitionTable.tsx`. What this
 * file owes is narrower and it is satisfied here:
 *
 *   - **No forced `min-width`.** `<table>` carries `w-full` and nothing else
 *     dimensional, so a consumer can re-lay the rows as blocks below 576px
 *     without fighting an intrinsic floor. This is the property that makes the
 *     stacked variant possible at all.
 *   - **A container that genuinely scrolls.** `overflow-x-auto` on the wrapper
 *     is the direct repair of the measured legacy failure, where every element
 *     in the ancestor chain was `overflow-x: visible` and `scrollLeft = 9999`
 *     read back `0` on every table and every parent.
 *
 * Two integration notes a consumer needs, because both are easy to get wrong:
 *
 *   - `whitespace-nowrap` on `TableHead` and `TableCell` is right for a wide
 *     fee table and wrong for a stacked block. A consumer overrides it by
 *     passing `whitespace-normal`, which `cn` resolves in the caller's favour
 *     via `tailwind-merge` — last occurrence of a conflicting utility wins.
 *   - `className` on `Table` lands on the `<table>`, **not** on the
 *     `data-slot="table-container"` wrapper, and the registry exposes no
 *     `containerClassName`. The 576-991px "visible affordance" is therefore
 *     rendered by wrapping `<Table>` in the consumer's own `relative` element
 *     and positioning the edge cue inside it. Adding a prop here to shortcut
 *     that is precisely the post-generation edit §0.3.5 forbids, so the
 *     recipe is documented rather than the primitive widened.
 *
 * One measured limit on that override mechanism, because it is not uniform.
 * `tailwind-merge` resolves a conflict only between utilities it recognises:
 * `cn("whitespace-nowrap", "whitespace-normal")` correctly yields
 * `whitespace-normal`, and `cn("p-2", "p-4")` yields `p-4`, but this project's
 * custom type roles are not in its font-size scale, so
 * `cn("text-sm", "text-meta")` yields **both** classes rather than the second.
 * That is benign here and it is worth knowing why rather than discovering it:
 * `--text-sm` and `--text-meta` are the same 0.875rem, so the size is
 * identical either way, and only `text-meta` declares a letter-spacing
 * (0.06em), so the mono meta treatment lands whichever rule wins on
 * font-size. A consumer that needs a role token to *displace* `text-sm`
 * deterministically — rather than merely coexist with it — should set it on a
 * wrapping element instead of relying on the merge.
 *
 * ---------------------------------------------------------------------------
 * TOKEN AND THEME COMPLIANCE (§0.3.3, §0.3.5)
 * ---------------------------------------------------------------------------
 * Every colour here resolves to a declared token, which is the axis
 * `npm run audit:tokens` fails on even in a generated file:
 * `text-foreground` → `--foreground`, `text-muted-foreground` →
 * `--muted-foreground`, `bg-muted` and `bg-muted/50` → `--muted`. The bare
 * `border-b`, `border-t`, `border-0` and `border-b-0` utilities set width only
 * and take their colour from `app/globals.css`'s base reset,
 * `*, ::before, ::after { border-color: var(--color-border) }`, so the rules
 * resolve to `--border` — the legacy `$glow` value, preserved exactly — without
 * naming a colour. There is no hex literal, no `oklch()` call, no Tailwind
 * palette shade and no CSS named colour anywhere below.
 *
 * The arbitrary *sizing* values — `[&_tr]:border-b`,
 * `[&_tr:last-child]:border-0`, `[&>tr]:last:border-b-0`,
 * `[&:has([role=checkbox])]:pr-0` and `[&>[role=checkbox]]:translate-y-[2px]`
 * — are left exactly as generated. §0.3.5 scopes the zero-hardcoded-values rule
 * to authored code and exempts generated internals on purpose: the audit
 * inventories them and fails only on a colour, "colour being the axis where a
 * stray literal breaks the brand contract, unlike a 3px focus ring".
 *
 * No `dark:` variant appears below and none may be added. The site ships one
 * light theme (§0.3.3): there is no legacy dark treatment, the brand reads on a
 * near-white ground, and a second theme would double the contrast-audit surface
 * for a site administered by non-technical staff.
 *
 * ---------------------------------------------------------------------------
 * WHY `"use client"`
 * ---------------------------------------------------------------------------
 * The directive is the registry's, not a local decision. `components.json` sets
 * `rsc: true`, under which the CLI's RSC transform *keeps* the directive — it
 * strips it only when RSC is off — so this is faithful output and removing it
 * would be a post-generation edit. It costs little and is bounded: these are
 * eight markup wrappers with no state, no effect and no handler, so the whole
 * module is a fraction of the §0.9.3 budget that allows 180 KB of compressed
 * JavaScript for the page. Nothing about it moves data access into the browser
 * — presenters still read through `lib/content/*` on the server and pass plain
 * values down, so the first paint is fully server-rendered markup.
 */

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
