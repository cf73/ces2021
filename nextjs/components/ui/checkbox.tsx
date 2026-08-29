/**
 * `Checkbox` — the tri-state selection control.
 *
 * One of the 38 registry-generated files among the 43 in `components/ui/`
 * (§0.3.5). Membership was VERIFIED against the pinned CLI before generating,
 * as §0.3.1 requires rather than assumes: `shadcn view checkbox` on
 * `shadcn@4.19.0` resolves to a single `registry:ui` file whose only declared
 * dependency is `radix-ui` — already an exact `1.6.7` pin in `package.json`, so
 * generation added no dependency and the manifest is unchanged. The body below
 * is `shadcn add checkbox` output against the committed `components.json`
 * (`new-york`, `stone`, `rsc: true`), with the four deviations enumerated under
 * "DEVIATIONS" and nothing else.
 *
 * ## CHECKBOX OR SWITCH? The split is behavioural, and choosing wrong is a bug
 *
 * Both controls appear in §0.3.2's "Editable field controls" row and they are
 * not interchangeable. The question is not "how many options" — it is whether
 * activating the control *changes the site*.
 *
 *   - **`Checkbox` (this file) — a selection, or a choice still pending.**
 *     Nothing happens to the content when it toggles; something happens later
 *     to whatever is selected. Consumers: `data-table.tsx` row selection and
 *     its select-all header cell, `EditableTermPicker` (multi-select over
 *     `taxonomy_terms`), `AssetLibrary` bulk selection across the 289 migrated
 *     assets, and filter panels such as the collection surfaces' draft filter.
 *
 *   - **`switch.tsx` — an immediate-effect state toggle.** Flipping it writes,
 *     through one Server Action, on the spot: `published` on any of the seven
 *     collections, `page_sections.enabled`, `person_education.enabled`,
 *     `nav_items.visible`, `announcements.feature_on_homepage`,
 *     `site_globals.banner_enabled` and `site_globals.maintenance_enabled`.
 *
 * The confusion is worth preventing because the two imply different promises to
 * the user. A switch that does not take effect until some later confirmation is
 * a lie about the system's state; a checkbox that silently publishes a page is
 * worse. §0.4.5's per-field model — "saving happens with each local edit" — is
 * what makes a `Switch` immediate, and it is exactly why row selection must NOT
 * be one.
 *
 * ### The consequential consumer: `EditableTermPicker` and the last role
 *
 * `EditableTermPicker` is where this component first does real work, and it is
 * also the one place with a floor underneath it. The legacy blueprint already
 * declares the constraint — `resources/blueprints/collections/people/people.yaml`
 * gives the `role` field `type: terms` over the `role` taxonomy with
 * `validate: - required` — and §0.4.2 carries it into the target as **at least
 * one `person_roles` row per person, "enforced by a deferred constraint
 * trigger"**. All 77 source people entries satisfy it, which is what makes the
 * invariant satisfiable by the canonical seed rather than something the
 * migration has to repair first.
 *
 * The consequence for this control: unchecking the LAST role is a legitimate
 * user action that the DATABASE will refuse. The picker must therefore let the
 * click happen, dispatch it, and surface the typed error the write function
 * returns — not disable the last checkbox, and not optimistically revert with no
 * explanation. Two reasons. Disabling the last one presumes to know which row is
 * last while another editor may be adding a second role concurrently, and the
 * §0.4.4 concurrency policy is optimistic rejection precisely because that
 * presumption is unsafe. And a silent revert is the failure mode the migration
 * exists to escape: a picker that lets a user clear the last role and then fails
 * opaquely would be a worse experience than the Control Panel it replaces, which
 * at least rendered the field as a validated `mode: select`. The commands return
 * typed results rather than throwing (§0.7.5), so the error is available to
 * render; `FieldFrame` shows it and the checkbox returns to its stored value.
 *
 * ## THE PROP CONTRACT (§0.3.2)
 *
 * Every prop is inherited from `CheckboxPrimitive.Root` through
 * `React.ComponentProps`, so nothing here re-declares or narrows a type:
 *
 *   `checked` / `defaultChecked`  `CheckedState`, i.e. `boolean | "indeterminate"`
 *   `onCheckedChange`             `(checked: CheckedState) => void`
 *   `disabled` `required` `name` `value`   forwarded to the underlying button
 *   `aria-describedby` `aria-invalid`      forwarded; `aria-invalid` is styled
 *
 * `checked` is deliberately NOT narrowed to `boolean`. `data-table.tsx`'s
 * select-all header cell is tri-state by nature — some but not all rows
 * selected — and Radix models that as the literal `"indeterminate"`. Narrowing
 * the type would make the header cell unrepresentable, and `aria-checked="mixed"`
 * along with it.
 *
 * ## TOKENS
 *
 * Every colour resolves through the §0.3.3 contract; there is no literal in this
 * file and no `dark:` variant, because one light theme ships:
 *
 *   `border-input`            `--input`, the resting stroke
 *   `bg-primary` (engaged)    `--primary`, the DARKENED brand green at 4.56:1
 *   `text-primary-foreground` `--primary-foreground`, so the glyph measures
 *                             4.56:1 against the fill it sits on
 *   `border-ring` / `ring-ring` `--ring` (= `--secondary`), the focus token
 *   `border-destructive`      `--destructive`, the invalid stroke
 *   `rounded-[4px]`           registry arbitrary value, LEFT ALONE per §0.3.5:
 *                             non-colour arbitrary values in generated files are
 *                             inventoried by `audit:tokens`, not failures
 *
 * ## DEVIATIONS from the pristine `shadcn add` output — four, each forced
 *
 * Recorded individually so the diff against a future `shadcn add` is reviewable
 * and nobody "restores" one of them. §0.3.5 exempts generated internals from the
 * hardcoded-value rule; it does not exempt them from the rest of the
 * specification, and each item below is required by a named section and backed by
 * a measurement rather than a preference.
 *
 *   D1. **The three `dark:` utilities are removed** — `dark:bg-input/30`,
 *       `dark:aria-invalid:ring-destructive/40`,
 *       `dark:data-[state=checked]:bg-primary`. These are NOT dead code, which
 *       was the assumption worth checking: `shadcn/tailwind.css` only *uses*
 *       `@variant dark` and never redefines it, and `app/globals.css` declares no
 *       `@custom-variant dark`, so `dark:` falls through to Tailwind 4's built-in
 *       variant. Compiling this project's real CSS emits
 *       `@media (prefers-color-scheme: dark) { .dark\:bg-input\/30 {
 *       background-color: color-mix(in oklab, var(--input) 30%, transparent) } }`
 *       — so on any dark-OS device the UNCHECKED box would take a fill the
 *       design never specified. §0.3.3 ships one light theme and `globals.css`
 *       states the invariant: "NO `.dark { }` block".
 *
 *   D2. **`outline-none` is removed.** `globals.css` owns the focus indicator in
 *       `@layer base` — `:focus-visible { outline: 2px solid var(--color-ring);
 *       outline-offset: 2px }` — and states verbatim, capitalised, that
 *       "`outline: none` MUST NOT appear anywhere in this project, with or
 *       without `!important`". It is not a style preference: the compiled layer
 *       order is `theme, base, components, utilities`, so the `.outline-none`
 *       UTILITY defeats that base rule at equal specificity. The offset is the
 *       part that matters here — `globals.css` records it as LOAD-BEARING for
 *       WCAG SC 1.4.11 because the ring colour measures 4.32:1 against
 *       `--background` but only 1.01:1 against the `--primary` fill, and a
 *       CHECKED checkbox is exactly a `--primary` fill. Suppressing the outline
 *       would leave this control's focus ring sitting on the one background it is
 *       nearly invisible against. The registry's own `focus-visible:ring-*` is
 *       KEPT: it composes with the outline (ring 0–3px out, outline 2–4px out)
 *       and the result is strictly more visible than either alone, never less.
 *
 *   D3. **The indeterminate state is given its own glyph and fill.** Radix's
 *       `Indicator` renders when the state is checked OR indeterminate, and the
 *       pristine body renders `CheckIcon` unconditionally with
 *       `data-[state=checked]` as the only styled engaged state. A select-all
 *       header at "some rows selected" would therefore paint a CHECK MARK on an
 *       unfilled box — which reads as "all selected", in the exact consumer the
 *       brief names. `MinusIcon` now renders for `indeterminate` and
 *       `data-[state=indeterminate]` mirrors the checked fill, so the three
 *       states are distinguished by SHAPE and not by colour alone: empty box,
 *       minus on green, check on green. Radix sets `aria-checked="mixed"` for
 *       the middle one on its own.
 *
 *       The switch is CSS on the Indicator's own `data-state`, not a JavaScript
 *       branch on `props.checked`. That is what keeps it correct for an
 *       UNCONTROLLED checkbox (`defaultChecked`), where the component never sees
 *       the current state, and identical on the server and the client.
 *
 *   D4. **The hit area is expanded to 44px below the `sm` breakpoint.** The
 *       painted box is `size-4` — 16px, under even `--size-target-min` (24px,
 *       the WCAG 2.2 floor) and far under the §0.4.5 matrix's 44 x 44px for
 *       "edit controls and drop targets" at 320–575px. A transparent,
 *       centred `::before` carries the target at `--size-control-touch`
 *       (2.75rem = 44px), collapsing to `--size-control` (2rem = 32px) at
 *       `--breakpoint-sm` = 576px, which is precisely where the matrix steps
 *       down. Pseudo-element boxes participate in hit testing and belong to the
 *       button, so a tap 14px clear of the glyph still activates it.
 *
 *       This is the mechanism the brief asks for — "expand the target through
 *       the label association or padding, not by scaling the glyph". Padding
 *       cannot do it here: the border and fill are painted on the Root itself,
 *       so padding would grow the visible box rather than only the target. The
 *       glyph stays 16px at every breakpoint. One consequence to keep in mind
 *       when laying out dense rows: below 576px the target extends 14px past
 *       each edge, so adjacent checkboxes need ~28px of separation to avoid
 *       overlapping targets — which is why it steps down to 32px exactly where
 *       tabular density begins.
 *
 *   A fifth, smaller correctness note rather than a deviation: both glyphs carry
 *   `aria-hidden`. They are decorative — the state is conveyed by
 *   `aria-checked` on the button — and the UI guidelines ask decorative assets
 *   to be hidden from assistive technology.
 *
 * ## MOTION
 *
 * `transition-shadow` needs no `motion-safe:` guard and must not be given one.
 * `globals.css` ends with a DELIBERATELY UNLAYERED
 * `@media (prefers-reduced-motion: reduce)` block that sets
 * `transition-duration: 1ms` on `*`, `::before` and `::after`; unlayered
 * declarations outrank the utilities layer, so it wins without `!important`.
 * 1ms rather than `none` is also deliberate — Radix waits for `animationend`
 * before unmounting, and `animation: none` never fires it.
 *
 * ## ACCESSIBILITY
 *
 * Radix supplies `role="checkbox"`, `aria-checked` in all three states
 * (`true` / `false` / `mixed`), Space activation, disabled semantics and a
 * hidden bubble input for form participation when `name` is set. The label
 * association belongs to the call site: pair this with `label.tsx` and
 * `field.tsx`, whose `Field` wires `aria-describedby` for the description and
 * error. A bare `<label for>` also works — `<button>` is a labelable element,
 * so the browser forwards activation and focus to the control; measured in
 * Chrome rather than assumed. There is no precedent to preserve from the legacy
 * site — it has no checkbox and no form field of any kind, its stylesheets
 * contain zero `:focus-visible` rules, and `public/css/style.css:8169` actively
 * suppressed the focus ring with `outline: none !important`. Every accessible
 * behaviour here is new.
 *
 * BLITZY [A11Y]: the UNCHECKED state's only visual affordance is the
 * `border-input` stroke, and that stroke measures 1.29:1 against `--background`
 * — below the 3:1 WCAG 2.2 SC 1.4.11 asks of the visual boundary that
 * identifies a component and its state. This is NOT a defect introduced here
 * and is deliberately not corrected here: `--input` is fixed by the §0.3.3
 * token contract, `app/globals.css` already carries the flag and the arithmetic
 * for it, and the UI guidelines require the design source to be implemented
 * exactly with a flag raised rather than the rendered output silently darkened.
 * It is repeated at this one call site because a checkbox is the case that
 * makes it bite hardest: `globals.css` mitigates the token by noting that "form
 * controls are never identified by their border alone, since --ring carries
 * :focus-visible and every control is labelled", and for an unchecked checkbox
 * the border IS the state boundary at rest, with no fill and no glyph behind
 * it. Resolving it needs a designer decision on the input stroke — a token edit,
 * which would apply everywhere at once — not a local override in this file.
 */

"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow before:absolute before:top-1/2 before:left-1/2 before:size-(--size-control-touch) before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground sm:before:size-(--size-control)",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group grid place-content-center text-current transition-none"
      >
        <CheckIcon
          aria-hidden="true"
          className="size-3.5 group-data-[state=indeterminate]:hidden"
        />
        <MinusIcon
          aria-hidden="true"
          className="hidden size-3.5 group-data-[state=indeterminate]:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
