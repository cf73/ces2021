/**
 * `NativeSelect` — a real, OS-rendered `<select>`.
 *
 * ## Provenance: generated, not authored
 *
 * Everything below the comment is unmodified `shadcn@4.19.0 add native-select`
 * output, produced against the committed `components.json` (`new-york`,
 * `baseColor: stone`, `iconLibrary: lucide`). §0.3.1 requires registry
 * membership to be confirmed against the pinned CLI *before* generating rather
 * than assumed, and it was: `npx shadcn@4.19.0 view native-select` resolves, and
 * the registry item declares neither `dependencies` nor `registryDependencies`,
 * so nothing was added to `package.json` — `lucide-react` was already pinned.
 * This file is therefore one of the 38 generated members of the 43 in
 * `components/ui/`, not one of the 5 authored ones (§0.3.4, §0.3.5).
 *
 * That provenance is the reason the implementation is left exactly as emitted.
 * §0.3.5 scopes generated registry internals out of the zero-hardcoded-values
 * rule deliberately — unmodified output contains arbitrary values by design
 * (`ring-[3px]`, `transition-[color,box-shadow]`, `bg-[Canvas]`), and a rule
 * that forbade them would mean rewriting every generated file, which defeats
 * the point of pinning the registry and turns the next `shadcn add` into a
 * merge conflict. `scripts/audit-tokens.mjs` enforces the asymmetry: an
 * arbitrary value here is inventoried, a *colour* literal would still fail. The
 * project precedent is `hooks/use-mobile.ts`, committed byte-identical to its
 * registry item, with `eslint.config.mjs` relaxing one rule for it rather than
 * editing the file. Only `badge.tsx` and `sonner.tsx` carry mandated edits
 * among the 38; this file carries none. This comment is the sole addition, and
 * it changes no class, prop or element.
 *
 * ## Choose between this and `select.tsx` on purpose, not by habit
 *
 * Both sit in the "Editable field controls" row of §0.3.2 and the division is
 * deliberate:
 *
 *   - **`native-select.tsx` (this file)** renders a genuine `<select>`, so the
 *     platform draws the list. On iOS and Android that is the OS picker: a
 *     wheel or a full-height sheet with the device's own text sizing, scroll
 *     physics and assistive-technology support. It needs no portal, no
 *     collision detection and no focus management, cannot be clipped by an
 *     `overflow: hidden` ancestor, and adds nothing to the JavaScript bundle
 *     beyond one chevron icon. Prefer it on touch and in dense tabular
 *     contexts — the `CollectionManager` filters and the `data-table` page-size
 *     control are the intended consumers.
 *   - **`select.tsx`** is the Radix listbox. Reach for it when the requirement
 *     genuinely exceeds what a native control can express: grouping rendered
 *     through `SelectGroup`/`SelectLabel`, custom item content (an icon, a
 *     swatch, two lines of text), or a trigger styled as one part of a
 *     composed control. A native `<option>` renders text only.
 *
 * This is not a stylistic preference. §0.4.3 records the early-childhood
 * domain finding that these sites need "larger touch targets and simplified
 * navigation than a general school site", and §0.4.5 makes it testable: an
 * admin and an editor must each complete five named editing tasks unaided **on
 * a phone** as well as a laptop, and a task that cannot be completed unaided is
 * recorded in `artifacts/accessibility-record.md` as a defect against
 * requirement 11 rather than as a training issue. On a phone the OS picker wins
 * that test.
 *
 * ## Options are data. Never hardcode a vocabulary here or at a call site
 *
 * Children are ordinary `<option>` and `<optgroup>` elements — `<option>` has
 * no registry equivalent and is expected. `NativeSelectOption` and
 * `NativeSelectOptGroup` are thin styling wrappers over the same elements, for
 * the platforms that let an author paint a dropped-down list.
 *
 * Seven closed vocabularies feed selects in this application, and every one is
 * backed by a Postgres `check` constraint (§0.4.2): `page_sections.kind`,
 * `taxonomy_terms.taxonomy`, `admin_users.role`, `nav_items.audience`,
 * `classroom_teachers.source`, `assets.lifecycle` and `security_events.kind`.
 * Their single source in the application is `lib/schema.ts`; a call site maps
 * over that and this component renders what it is given. None of those values
 * appears in this file, and none may. A literal copied here drifts silently
 * from its constraint the first time the constraint changes, and the symptom is
 * the worst kind: a save that always fails with nothing on screen explaining
 * why, because the value was rejected in the database rather than in the form.
 *
 * ## Sizing, and how to reach the touch height
 *
 * Measured from the emitted classes: the default is `h-9` (2.25rem / 36px) and
 * `size="sm"` is `h-8` (2rem / 32px), which coincides exactly with the
 * `--size-control` token for pointer input. 36px clears WCAG 2.2 SC 2.5.8
 * Target Size (Minimum), whose 24px floor this project holds as
 * `--size-target-min`, so the generated default is conformant as it stands.
 *
 * It is not, however, the 44px figure §0.4.5 asks for in the 320–575px column,
 * and the registry has no variant for it. A consumer rendering this control on
 * a touch surface passes the token classes and `cn` resolves them —
 * `tailwind-merge@3.6.0` collapses `h-9` against both `h-(--size-control-touch)`
 * and the bracketed `var()` form, keeping only the caller's. THE PADDING MUST
 * TRAVEL WITH THE HEIGHT:
 *
 *     <NativeSelect
 *       className="h-(--size-control-touch) sm:h-(--size-control) sm:py-1"
 *     >
 *
 * That third class is not decoration, and leaving it off is a real defect
 * measured in a browser rather than a theoretical one. The component changes
 * height and padding together for its own small variant —
 * `data-[size=sm]:h-8` is always paired with `data-[size=sm]:py-1` — so an
 * override that changes only the height leaves the base `py-2` behind. At the
 * 32px height that yields a 14px content box for a 21px line box, and Chrome
 * slices the baseline and the lower bowl of every glyph: measured at 1280px,
 * six of fifteen ink rows of the value text were gone, and `scrollHeight`
 * still equalled `clientHeight`, so nothing in the DOM reports it. With
 * `sm:py-1` the content box is 26px below the breakpoint and 22px above it,
 * both clear of the line box, and the rendering above 576px is row-for-row
 * identical to the component's own `size="sm"`. Verified at 320px, 390px and
 * 1280px, and at the 575/576px boundary: 44px holds through 575px inclusive
 * and 32px applies from 576px, matching §0.4.5's two columns exactly.
 *
 * One further interaction to know about, because it is silent: `size="sm"`
 * emits its height under a `data-[size=sm]` variant, which `tailwind-merge`
 * cannot collapse against an unvariated `h-*` class — the two survive together
 * and the attribute selector wins wherever it applies. Combining `size="sm"`
 * with the touch classes therefore yields 32px at every viewport. Use the touch
 * classes with the default size; use `size="sm"` for pointer-dense tables.
 *
 * ## Two details that are load-bearing rather than cosmetic
 *
 *   - **The chevron must not swallow the tap.** The native arrow is removed by
 *     `appearance-none` and a `ChevronDownIcon` is positioned over the control,
 *     which is the classic way to ship a select that looks right and behaves as
 *     though it were dead: an overlay with default pointer behaviour eats the
 *     tap that should open the picker, and it eats it precisely over the arrow,
 *     where every user aims. The generated icon carries `pointer-events-none`
 *     and `aria-hidden="true"`, so taps pass through to the `<select>` and no
 *     screen reader announces a decoration. Both were verified in a real
 *     browser at touch viewport widths, not reasoned about — that is the only
 *     way this class of defect surfaces.
 *   - **The focus indicator is substituted, not suppressed.** The control
 *     carries `outline-none`, which sits in Tailwind's utilities layer and so
 *     overrides the `:focus-visible` outline `app/globals.css` sets in
 *     `@layer base`. What replaces it is stronger, not weaker:
 *     `focus-visible:border-ring` swaps the full-opacity ring colour into the
 *     1px border (measured 4.31:1 against the page background, clearing SC
 *     1.4.11) and `focus-visible:ring-[3px] focus-visible:ring-ring/50` adds a
 *     3px halo around it. `--ring` is the token that exists to repair the
 *     legacy `outline: none !important` on `a:hover, a:focus`, which suppressed
 *     the indicator site-wide across every measured tab stop (§0.7.2); nothing
 *     here reintroduces that.
 *
 * ## Recorded divergences — reviewable rather than silent
 *
 *   1. **The native `size` attribute is unavailable.** The registry reuses the
 *      name for a height variant and omits the attribute from the prop type.
 *      Every other native prop still forwards through the spread —
 *      `value`, `defaultValue`, `onChange`, `disabled`, `required`, `name`,
 *      `multiple`, `aria-describedby`, `aria-invalid` — and `ref` reaches the
 *      `<select>` because React 19 passes it as an ordinary prop. Nothing in
 *      this application needs a multi-row list box: every select surface is a
 *      single-choice dropdown, so the omission costs nothing today. A future
 *      requirement for one is a job for `select.tsx`, not an edit here.
 *   2. **The emitted `dark:` utilities are live, and they resolve against the
 *      OS preference.** `globals.css` declares no `.dark` block and no
 *      `@custom-variant dark` (§0.3.3 ships one light theme), and
 *      `shadcn/tailwind.css` only *uses* `@variant dark` — so Tailwind's
 *      built-in variant applies and `dark:bg-input/30`,
 *      `dark:hover:bg-input/50` and `dark:aria-invalid:ring-destructive/40`
 *      compile under `@media (prefers-color-scheme: dark)`. Verified by
 *      compiling this file against `app/globals.css` with the pinned Tailwind
 *      CLI. The effect is a faint warm fill tint in place of a transparent one,
 *      a slightly stronger tint on hover, and a slightly stronger invalid ring;
 *      no value inverts, the foreground stays `--foreground`, and body contrast
 *      stays above 9:1. That is a rounding error against a light theme rather
 *      than a second theme, so the classes are left as generated per the
 *      no-edits boundary above and the finding is recorded here instead.
 *   3. **The wrapper is `w-fit`.** The control shrink-wraps its widest option,
 *      and `className` reaches the `<select>` rather than the wrapper, so a
 *      full-width field is achieved by the layout around this component — a
 *      `Field`, or a `Container`/`Stack`/`Grid` cell from
 *      `components/ui/layout.tsx` — not by a class passed here.
 *   4. **Two of the generated utilities are physical rather than logical.**
 *      The project's invariants ask for logical properties throughout, and
 *      `px-3`/`py-2`/`py-1` are already logical in Tailwind 4
 *      (`padding-inline`/`padding-block`), but `pr-9` and `right-3.5` — the
 *      pair that reserves and fills the chevron's gutter — are not; their
 *      logical spellings would be `pe-9` and `end-3.5`. They are left as
 *      generated under the no-edits boundary. The practical cost today is nil:
 *      the site ships a single LTR locale and `<html lang="en">`, so no
 *      inline-direction flip exists to expose them. Anything that adds an RTL
 *      locale should revisit this file, and this note is here so that revisit
 *      starts from a known list rather than a search.
 */

import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative w-fit has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-2 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 data-[size=sm]:py-1 dark:bg-input/30 dark:hover:bg-input/50",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          className
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  )
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
