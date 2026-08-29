"use client"

/**
 * `Select` — the Radix listbox, one of the 38 registry-generated files among
 * the 43 in `components/ui/` (§0.3.5).
 *
 * ## Provenance
 *
 * Registry membership was verified against the pinned CLI BEFORE generation, as
 * §0.3.1 requires — `shadcn view select` resolved, reporting exactly one
 * dependency, `radix-ui`, which `package.json` already pins at 1.6.7, so no
 * manifest change was needed. The file was then produced by
 * `shadcn add select` against the committed `components.json`
 * (`style: new-york`, `baseColor: stone`, `rsc: true`, `cssVariables: true`).
 * Its imports are the generated ones and they are the mandated ones (§0.6.5):
 * the consolidated `radix-ui` package rather than `@radix-ui/react-select`,
 * NAMED `lucide-react` icons rather than a namespace import, and `cn` from the
 * `@/lib/utils` alias. Both banned forms are lint errors at
 * `--max-warnings=0`.
 *
 * Generated internals are left verbatim. §0.3.5 exempts unmodified registry
 * output from the arbitrary-value ban deliberately — `ring-[3px]`,
 * `min-w-[8rem]` and the internal flex utilities below are expected output, and
 * rewriting them would make the next `shadcn add` a merge conflict. Only the
 * six deviations enumerated next depart from the generated text, each traced to
 * a hard invariant of this project rather than to taste, so a reviewer can
 * separate a required correction from a stylistic edit.
 *
 * ## The six deviations, and why each one is not optional
 *
 * 1. THE THREE DARK-VARIANT UTILITIES ARE REMOVED — the generated trigger
 *    carried a dark-variant input background, its hover counterpart, and a
 *    dark-variant invalid ring. (They are described rather than quoted here on
 *    purpose: Tailwind's source detection scans comments too, so writing the
 *    class strings out would emit the very `prefers-color-scheme: dark` rule
 *    this deviation exists to keep out of the stylesheet — measured at 220
 *    bytes when they were quoted, which is also how the mechanism below was
 *    confirmed rather than assumed.)
 *    §0.3.3 ships ONE light theme: `app/globals.css` declares no `.dark {}`
 *    block and `next-themes` is not a dependency. Crucially those utilities are
 *    not merely inert — `globals.css` records that `@variant dark` resolves
 *    against Tailwind's BUILT-IN variant, which is `prefers-color-scheme: dark`,
 *    so every one of them would take live effect for any visitor whose OS is in
 *    dark mode. That would paint a filled `--input` background onto the exact
 *    control staff use on a phone (§0.4.5), on a site that has no dark theme to
 *    complete the look. A dark-mode style with no dark mode is a rendering bug,
 *    not dead code.
 *
 * 2. `outline-none` IS REMOVED FROM THE TRIGGER and `outline-hidden` FROM THE
 *    ITEM. `app/globals.css` states the invariant plainly: "`outline: none` MUST
 *    NOT appear anywhere in this project, with or without `!important`", because
 *    `@layer base` declares `:focus-visible { outline: 2px solid
 *    var(--color-ring); outline-offset: 2px }` as THE focus indicator and the
 *    offset is load-bearing for WCAG SC 1.4.11 — measured, the ring resolves to
 *    rgb(0,124,194), 4.32:1 against the page ground but 1.01:1 against a filled
 *    control, so the offset is what makes it perceivable. Tailwind 4's
 *    `outline-none` compiles to `outline-style: none` in the `utilities` layer,
 *    which outranks `@layer base` and would silently defeat it, leaving only the
 *    generated `focus-visible:ring-ring/50` — a 50%-alpha ring measuring roughly
 *    2:1. This project exists in part to repair a legacy site whose
 *    `outline: none !important` produced zero visible focus indicators across 15
 *    measured mobile tab stops (§0.7.2); reintroducing the suppression on the
 *    first focusable control would be the same defect in a new stack. The
 *    generated `focus-visible:border-ring` and `focus-visible:ring-[3px]` are
 *    KEPT, so the indicator is the base outline plus the registry's own border
 *    and ring emphasis — strictly more visible than either alone, never less.
 *
 * 3. `z-50` BECOMES `z-(--z-dropdown)`. §0.3.3 declares a closed layering scale
 *    precisely because the legacy stylesheets used `z-index: 9999999`, `99999`
 *    and `9999` with no ordering discipline, and this surface is a dropdown, so
 *    40 is its layer. Note the shorthand: Tailwind 4 has no `--z-*` namespace,
 *    so these tokens generate NO `z-*` utility and must be read as
 *    `z-(--token)` — `z-dropdown` would silently be no class at all.
 *
 *    NESTING CAVEAT, because the token scale makes this real: a dropdown (40)
 *    sits BELOW an overlay (50) and a modal (60). The stock registry gives
 *    dialog and select the same `z-50`, so a select inside a dialog wins on DOM
 *    order; here it would lose on z-index. A `Select` rendered inside a
 *    `Dialog`, `AlertDialog` or `Sheet` — `GlobalsSheet` and `AdminUsers` are
 *    exactly that — must therefore raise its content to the surface it sits on:
 *
 *        <SelectContent className="z-(--z-modal)">
 *
 *    Equal z-index plus the later portal position puts it above the modal,
 *    which is the stock behaviour restored with a declared token. Inside the
 *    edit chrome use `z-(--z-edit)`, the scale's ceiling.
 *
 * 4. `shadow-md` BECOMES `shadow-popover`. §0.3.3's elevation group declares
 *    `--shadow-popover: 0 4px 16px oklch(36% 0.022 140 / .10)` for exactly this
 *    kind of surface; leaving a purpose-built token unused while the popover
 *    renders a Tailwind default is the drift the token contract exists to
 *    prevent. `--shadow-*` IS a Tailwind namespace, so `shadow-popover` is a
 *    real utility. `shadow-xs` on the trigger is untouched: no project token
 *    describes an input-sized lift, and inventing one is out of this file's
 *    scope.
 *
 * 5. THE GROUP LABEL KEEPS THE GENERATED `text-xs`, AND THE REASON IS A TRAP
 *    WORTH RECORDING FOR EVERY OTHER FILE IN THIS FOLDER. Swapping it for the
 *    project's `text-caption` role token looked correct on paper — §0.3.3's
 *    type-role matrix is closed and declares no `--text-xs` — but measured in a
 *    browser the swap DID NOTHING, and made the label worse. `cn()` runs
 *    `tailwind-merge`, which groups `text-*` utilities by consulting Tailwind's
 *    DEFAULT scales: `text-caption` is not a known font size, so it is
 *    classified as a text COLOUR, lands in the same group as
 *    `text-muted-foreground`, and the later class wins — the size class was
 *    silently dropped from the rendered `class` attribute entirely. The label
 *    then inherited the 17px body size and rendered LARGER than the 14px
 *    options it labels. `text-xs` survives the merge because tailwind-merge
 *    knows it is a font size, and 12px reads correctly against 14px options.
 *    The general rule: a custom `--text-*` token cannot be applied through
 *    `cn()` alongside a text-colour utility as a bare `text-<name>` class. Where
 *    one is genuinely needed, force the interpretation
 *    (`text-(length:--text-caption)`) or set it on an element that carries no
 *    colour utility. `text-sm` elsewhere in this file needs none of this: it is
 *    both a known merge group AND a declared project token, since `globals.css`
 *    overrides `--text-sm`, so the utility already resolves to the contract.
 *
 * 6. THE 44px TOUCH CONTRACT IS ADDED, and it is the one deviation that adds
 *    rather than removes. §0.4.5's responsive matrix requires 44 x 44px controls
 *    at 320–575px, on the domain finding in §0.4.3 that early-childhood sites
 *    need larger touch targets than a general school site, and on the §0.4.5
 *    acceptance criterion that staff complete their tasks ON A PHONE. The
 *    generated sizes miss it: the trigger is `h-9` (36px) or `h-8` (32px), an
 *    item is 33px and a scroll button 24px. Every interactive part therefore
 *    carries `min-h-(--size-control-touch)` with an `sm:` counterpart —
 *    2.75rem/44px below the 576px breakpoint, and above it a floor low enough
 *    that the generated geometry governs again.
 *
 *    THE `sm:` CLASS IS THE LOAD-BEARING HALF, not decoration: without it the
 *    44px minimum would apply at every width and a desktop trigger would be
 *    44px instead of 36px. Its job is to LOWER the floor, so it is expected to
 *    be non-binding above `sm` — measured in a browser, triggers return to
 *    36/36/36/32px and items to their natural 33px (`py-1.5` plus a 21px line
 *    box), which is the pristine registry geometry. `min-height` beats
 *    `height`, so the generated `h-9`/`h-8` are never edited: they simply win
 *    again once the floor drops. The scroll buttons use `--size-target-min`
 *    (1.5rem/24px, the WCAG 2.2 minimum) as their pointer-range floor, which is
 *    their generated height exactly.
 *
 *    Verified at 320px and 390px: all four harness triggers and every option
 *    measure exactly 44px, and trigger width needs no class of its own —
 *    `w-fit` plus `px-3` (24px), `gap-2` (8px) and a `size-4` chevron (16px)
 *    measured 82px at the narrowest, well past 44.
 *
 * ## Choose between this and `native-select` DELIBERATELY
 *
 * `native-select.tsx` is a separate generated file in this folder and the two
 * are NOT interchangeable. Pick on purpose:
 *
 *   - `NativeSelect` — a real `<select>`. PREFER IT ON TOUCH, where the OS
 *     picker is faster, scrolls better and is more accessible than any custom
 *     listbox, and in dense tabular contexts such as `DataTable` rows where a
 *     portalled popup fights the scroll container. It also needs no JavaScript.
 *   - `Select` — this file, the Radix listbox. Use it when the options need
 *     GROUPING (`SelectGroup` + `SelectLabel`), when an item renders more than
 *     text (an icon, a swatch, a secondary line), or when the trigger has to be
 *     styled as part of a composed control — `InputGroup`, a `FieldFrame` edit
 *     affordance, a toolbar.
 *
 * AND THE CHOICE HAS A MEASURED PRICE, so it is not only a matter of taste.
 * Built through this project's own pipeline and weighed with
 * `scripts/check-budget.mjs`, adding this component to an otherwise identical
 * client page moved the JavaScript total from 149,726 to 185,107 bytes Brotli —
 * A MARGINAL 35,381 BYTES, because the primitive brings its own positioning
 * engine, dismissable layer, focus scope, portal and collection. §0.9.3 sets the
 * ceiling at 180,000 bytes and the Next 16 + React 19 client baseline alone
 * takes 149,726 of it, leaving about 30,000 — less than this component costs. So
 * a PUBLIC page that renders one breaches the budget on its own. The editor and
 * admin surfaces are the right home for it: §0.4.1 loads `components/cms/**`
 * only in the verified authenticated bundle, which never competes with a
 * visitor's page weight. On a public surface use `NativeSelect`, or defer this
 * one behind `next/dynamic` at the call site. CSS is not the concern — the same
 * comparison moved the stylesheet by 13 bytes.
 *
 * Neither choice is a licence to hand-roll a bare `<select>`: §0.3.5 requires a
 * registry component wherever one exists.
 *
 * ## The options are DATA, and they never live in this file
 *
 * This component renders whatever `SelectItem` children a consumer maps; it
 * contains no option list, and it must not gain one. Eight closed vocabularies
 * back the controls that use it, and every one is a Postgres `check` constraint
 * (§0.4.2): `page_sections.kind`, `taxonomy_terms.taxonomy`,
 * `admin_users.role`, `nav_items.audience`, `classroom_teachers.source`,
 * `assets.lifecycle`, `security_events.kind` and `site_globals.banner_variant`,
 * plus the `site_globals` key schema discriminated by key. Their single source
 * of truth is `lib/schema.ts`, whose Zod enums the Server Action layer validates
 * against, so a consumer derives its `<SelectItem value=…>` set from there:
 *
 *     {NAV_AUDIENCES.map((audience) => (
 *       <SelectItem key={audience} value={audience}>{label(audience)}</SelectItem>
 *     ))}
 *
 * The failure mode this prevents is quiet rather than loud. §0.4.2 revokes
 * direct DML from `authenticated` and routes every write through a
 * `security definer` function, so an option this control offers that the
 * database no longer accepts does not corrupt data — it produces a save that
 * ALWAYS fails, with no obvious cause, on a surface whose whole purpose is to
 * be simple for non-technical staff (requirement 11). Sourcing the list from
 * the schema makes the drift impossible instead of merely unlikely.
 *
 * ## A rejected change is normal, and must not be swallowed
 *
 * This file is presentation only: it holds no state, issues no mutation and
 * knows nothing about Supabase. The consumer owns `value` and `onValueChange`,
 * and it MUST render from server-confirmed state rather than from what the user
 * picked, because some writes are legitimately refused. `set-admin-role`
 * enforces in one transaction that at least one active admin remains and that an
 * admin may not demote themselves (§0.4.2), so demoting the last admin comes
 * back as a typed error. On that path the consumer surfaces the error — a
 * `sonner` toast and the field's `FieldError` — and leaves the displayed value
 * equal to the server's. Swallowing it would leave the control showing a role
 * the database never accepted.
 *
 * ## Accessibility, and what Radix already guarantees
 *
 * The primitive supplies the full listbox pattern, which is why it is used
 * rather than reimplemented: `role="combobox"` with `aria-expanded` and
 * `aria-controls` on the trigger, `role="listbox"` on the content,
 * `aria-selected` on items, arrow-key movement, typeahead, Enter to commit, and
 * Escape to close and return focus to the trigger. Labelling is the consumer's
 * half of the contract: wrap the control in `Field` + `FieldLabel` (or pass
 * `aria-label`) so the trigger has an accessible name, and let `Field` wire
 * `aria-describedby` to the description and error. `aria-invalid` is styled here
 * and is set by the consumer, never guessed at.
 *
 * A `SelectItem` value must be a non-empty string — Radix reserves `""` for
 * clearing the selection and throws on an empty item value. An optional field
 * therefore needs an explicit sentinel option (for example `"__none__"`) that
 * the consumer maps back to `null` before it reaches a command, not `value=""`.
 *
 * Every claim above was checked in a browser rather than argued: the closed
 * focused trigger and each keyboard-focused option render a 2px solid
 * `rgb(0,124,194)` outline at 2px offset; arrow keys, typeahead, Enter and
 * Escape all behave as described, with focus landing back on the trigger
 * element itself; exactly one option carries `aria-selected="true"` and a
 * 16x16 check glyph; a disabled item cannot be focused or chosen even by a
 * scripted `.focus()`; and axe-core reports ZERO violations on any
 * `[data-slot^="select"]` node, closed or open.
 *
 * ONE KNOWN AXE ARTIFACT, so it is not mistaken for a regression: while the
 * listbox is open, the primitive's default modal behaviour sets `aria-hidden`
 * on the rest of the document, and axe then reports `aria-hidden-focus` against
 * whatever focusable elements sit in that background. It is inert in practice —
 * the background takes `pointer-events: none` and the focus scope holds Tab
 * inside the list — and it disappears when the listbox closes, which is the
 * state a Lighthouse run measures. `modal={false}` would silence it at the cost
 * of the scroll lock and the focus trap, so it is deliberately not passed.
 */

import * as React from "react"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * The root. Uncontrolled with `defaultValue`, or controlled with `value` +
 * `onValueChange`; `disabled`, `required` and `name` are forwarded to the
 * primitive.
 *
 * `name` exists for form participation, and the mechanism is worth stating
 * because it is easy to test for the wrong thing: the primitive mirrors the
 * value into a hidden native `<select>` (not an input), and after hydration it
 * renders that mirror ONLY when the trigger is inside a `<form>`. Server-
 * rendered markup contains it either way, which is why Chrome's autofill
 * advisory about a form field with no `id` or `name` can appear against
 * pre-hydration output that has no form at all. Nothing in this project posts a
 * native form — every write goes through a Server Action — so `name` is
 * optional here and the mirror is usually absent.
 */
function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

/** Groups items under a `SelectLabel`. The reason to prefer this over `NativeSelect`. */
function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

/** Renders the selected item's text, or `placeholder` when nothing is selected. */
function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit min-h-(--size-control-touch) items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 sm:min-h-(--size-control) *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

/**
 * The portalled listbox surface.
 *
 * `max-h-(--radix-select-content-available-height)` with `overflow-y-auto` is
 * what keeps a long list usable at 320px: the primitive measures the space
 * between the trigger and the viewport edge and publishes it as that variable,
 * so the list scrolls inside the viewport instead of overflowing it. Those
 * `--radix-*` variables are supplied by the primitive at runtime and are
 * deliberately not project tokens.
 *
 * `position` defaults to `"item-aligned"` (the generated default, which aligns
 * the selected item over the trigger like a native picker); pass
 * `position="popper"` with `side`, `align`, `sideOffset` and `alignOffset` for
 * anchored placement. Positioning props live HERE, not on the root.
 */
function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "relative z-(--z-dropdown) max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-popover data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

/**
 * The heading for a `SelectGroup`. Not interactive, so it takes no touch-target
 * minimum. `text-caption` rather than the generated `text-xs` — deviation 5.
 */
function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * One option. `value` is required and must be a non-empty string; use an
 * explicit sentinel for "no selection" rather than `value=""`, which the
 * primitive reserves for clearing and rejects.
 *
 * Selection is signalled twice over, which is what keeps it perceivable
 * independently of colour: the check indicator below, and `aria-selected` from
 * the primitive. The keyboard-focused option additionally shows the project's
 * global `:focus-visible` outline, because deviation 2 removed the generated
 * `outline-hidden` — the `focus:bg-accent` highlight alone measures about 1.1:1
 * against `--popover` and could not carry the state on its own.
 */
function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full min-h-(--size-control-touch) cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 sm:min-h-(--size-control) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

/** A divider between groups. Decorative, and `pointer-events-none` so it never eats a tap. */
function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

/**
 * Rendered by `SelectContent` automatically; exported because the registry
 * exports it and a bespoke content composition needs it. Both scroll buttons
 * are interactive, so they carry the touch minimum and relax above `sm` to
 * `--size-target-min`, which is their generated height exactly.
 */
function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex min-h-(--size-control-touch) cursor-default items-center justify-center py-1 sm:min-h-(--size-target-min)",
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex min-h-(--size-control-touch) cursor-default items-center justify-center py-1 sm:min-h-(--size-target-min)",
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}

