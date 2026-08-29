"use client";

/**
 * `Label` — the accessible form-label primitive.
 *
 * ## Provenance: generated, not authored
 *
 * One of the 38 files in `components/ui/` produced by the pinned registry CLI
 * rather than written by hand (§0.3.5: 43 files = 38 generated + 5 authored;
 * this is not one of the five). Membership was verified against the pinned CLI
 * before generation, as §0.3.1 requires: `shadcn@4.19.0 view label` resolves,
 * and reports exactly one dependency — `radix-ui`, already pinned at 1.6.7 in
 * `package.json`, so generating this item added nothing to the manifest.
 *
 * Treat this file as project source and review it like any other, but do not
 * rewrite its internals for style. §0.3.5 deliberately exempts unmodified
 * registry output from the zero-hardcoded-values rule — `group-data-[…]` and
 * `peer-disabled:` variants are arbitrary by design — and governs it through
 * `npm run audit:tokens` instead, which fails only on a colour literal here.
 * There is no colour literal in this file, and no `dark:` variant: the site
 * ships one light theme (§0.3.3), so the `.dark` block the registry emits
 * elsewhere has no counterpart to honour.
 *
 * ## The one deviation from generated output, and the measurement behind it
 *
 * Everything below is the registry's output verbatim except the three type
 * utilities. The generated file reads `text-sm leading-none font-medium`;
 * §0.3.3's type-role matrix instead assigns `--text-h4` to "Bard level 4 and
 * field labels in edit mode", and `app/globals.css` says so at the token's own
 * declaration. So the role is applied here — but NOT through the obvious
 * `text-h4` utility, for a reason that was measured rather than assumed.
 *
 * `cn()` ends in `twMerge`, and `tailwind-merge@3.6.0` classifies a `text-*`
 * class by validating its value: `h4` is not a t-shirt size, so the font-size
 * validator rejects it and the text-colour validator claims it instead. The
 * observed consequences, against this project's own installed version:
 *
 *   twMerge("text-h4 text-muted-foreground") === "text-muted-foreground"
 *   twMerge("text-h4 text-destructive")      === "text-destructive"
 *   twMerge("text-h4 text-sm")               === "text-h4 text-sm"
 *
 * The first two drop the type role silently — so the first consumer to render
 * a secondary or errored label as `<Label className="text-muted-foreground">`
 * would lose the specified size with nothing to show for it in review. The
 * third is worse in its way: two font sizes both survive and the winner is
 * decided by stylesheet order, which `lib/utils.ts` documents as precisely the
 * outcome a caller cannot control. Either way the file would be "fighting"
 * `field.tsx` rather than composing with it.
 *
 * The parenthesised custom-property forms carry a type hint that the same
 * validators do recognise, so they land in the font-size and line-height
 * groups and behave correctly under composition — a caller's own font size
 * replaces this one, while a caller's colour leaves it alone. Verified against
 * this project's `@tailwindcss/postcss@4.3.3` that each compiles to the
 * intended declaration and resolves to a token declared in `app/globals.css`:
 *
 *   text-(length:--text-h4)          -> font-size: var(--text-h4)
 *   leading-(--text-h4--line-height) -> line-height: var(--text-h4--line-height)
 *   font-bold                        -> font-weight: 700
 *
 * Together those are the h4 role exactly as §0.3.3 states it: a fluid
 * `clamp(1.125rem, .5vw + 1rem, 1.375rem)`, leading 1.3 and weight 700, all
 * three inherited from the legacy `h4` (20px / 1.3 / 700) rather than invented.
 * Confirmed in Chrome against the compiled stylesheet: the label computes
 * `font-size: 22px` / `line-height: 28.6px` at a 1280px viewport and
 * `font-size: 18px` / `line-height: 23.4px` at 375px — the clamp's ceiling and
 * floor — at `font-weight: 700` in both cases.
 * The size is also why §0.3.5's text-colour-by-size rule leaves the brand
 * display colour unavailable here: `text-brand-display` is permitted only at
 * >= 24px and weight 700, and this role's ceiling is 22px. Labels take the
 * inherited foreground, or whatever colour the composing field passes.
 *
 * A future `shadcn add label --overwrite` will revert those three utilities to
 * `text-sm leading-none font-medium`. That is a silent regression of the type
 * role, not a harmless refresh, so re-apply this deviation after any
 * regeneration.
 *
 * ## Why the Radix primitive, and not a bare `<label>`
 *
 * Worth being precise about, because the usual claim for this primitive — that
 * it adds click forwarding to non-native controls — is not what it does. Read
 * against `@radix-ui/react-label`'s source, it renders a plain `<label>` and
 * adds exactly one `onMouseDown` behaviour:
 *
 *   1. It suppresses text selection on double click (`event.detail > 1` ->
 *      `preventDefault`), while leaving the click itself to proceed so the
 *      label stays clickable. Without it, a stray double-click on a label
 *      beside a checkbox leaves a selection highlight across the form.
 *      `select-none` is the appearance half of this; only the handler changes
 *      the behaviour, and the two are kept together.
 *   2. It carves out presses that land on a nested `button, input, select` or
 *      `textarea`, returning before it interferes — so double-click-to-select
 *      a word still works inside a wrapped text input.
 *   3. It calls a consumer's own `onMouseDown` first and does nothing further
 *      if that handler already prevented the event, so wrapping this component
 *      never overrides the wrapper.
 *
 * Click and focus forwarding to the associated control is the *platform's*
 * label behaviour via `for`, not Radix's. It reaches `Switch` and `Checkbox`
 * — which render `button[role="switch"]` and `button[role="checkbox"]` —
 * because `button` is one of HTML's labelable elements, so the association is
 * native and needs nothing added. Verified: a label click flips both controls'
 * `aria-checked` and `data-state`.
 *
 * So the primitive earns its place for the selection behaviour and for being
 * what the rest of the registry composes, not for forwarding. Do not swap in a
 * plain element for brevity — points 1 to 3 are not reproducible in CSS.
 *
 * ## Contract for consumers
 *
 * Every native `<label>` attribute is forwarded, `htmlFor` included, so the
 * association reaches the DOM as `for` and the label becomes the control's
 * accessible name. `className` is merged last and therefore wins, and
 * `data-slot="label"` is preserved as the stable selector the rest of the
 * system targets.
 *
 * `field.tsx` builds `FieldLabel` on this export and owns the `aria-describedby`
 * wiring; all 14 `Editable*` editors reach a label through that path rather
 * than importing this file directly. (`FieldLegend` is a native `<legend>` and
 * does NOT compose this component, despite the symmetry of the names.) This
 * file is therefore kept deliberately thin — no variants, no state of its own,
 * no layout beyond the row the registry defines — so `field.tsx` can compose
 * it. Three properties of that composition are load-bearing and were checked
 * against the registry's own `field` source rather than assumed:
 *
 *   - `FieldLabel` is typed `React.ComponentProps<typeof Label>`, so this
 *     component's prop type must stay the full native label set. Narrowing it
 *     to a hand-picked subset would break `field.tsx`'s type.
 *   - `FieldLabel` passes `data-slot="field-label"`. That works only because
 *     `data-slot` is set BEFORE `{...props}` below, letting a composer override
 *     it; reordering those two lines would silently pin every field label to
 *     `data-slot="label"`.
 *   - `FieldLabel` adds `leading-snug`, which correctly replaces this
 *     component's line-height while leaving the h4 font-size intact — the
 *     composition the conflict-safe binding above exists to make possible.
 *
 * Disabled state is conveyed without colour, which §0.4.5 requires: colour is
 * never the sole indicator of meaning. Measured in Chrome against the compiled
 * stylesheet, a disabled label computes `opacity: 0.5` and
 * `pointer-events: none` against `1` and `auto` when enabled, while its `color`
 * is byte-identical to the enabled one — so the state is carried entirely by
 * non-colour channels. The disabled control itself remains the authoritative
 * signal for assistive technology; this is only its visual echo.
 *
 * Which variant delivers that depends on DOM order, and a consumer needs to
 * know it because it is invisible in the class list. Tailwind compiles
 * `peer-disabled:*` to a general-sibling combinator —
 * `:where(.peer):disabled ~ *` — so those two utilities match only when the
 * disabled control PRECEDES the label, which is the checkbox-beside-its-label
 * arrangement the registry had in mind. In the label-above-the-control layout
 * a form usually wants, they are inert (measured: `cursor` stays `default`),
 * and `group-data-[disabled=true]:*` is what carries the state, since it
 * descends from an ancestor and is order-independent. `field.tsx` should
 * therefore mark the disabled `Field` group rather than rely on the peer axis.
 * Both sets are kept exactly as generated: the peer pair is correct for the
 * arrangement it was written for, and removing either would be a
 * post-generation edit §0.3.5 does not sanction.
 */

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-(length:--text-h4) leading-(--text-h4--line-height) font-bold select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
