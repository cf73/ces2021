/**
 * Separator — the section rule.
 *
 * One of the 38 registry-generated files among the 43 in `components/ui/`
 * (§0.3.5). Produced by `shadcn add separator` against the committed
 * `components.json` at the pinned CLI version, after `shadcn view separator`
 * confirmed registry membership as §0.3.1 requires. The CLI reported exactly
 * one dependency, `radix-ui`, which `package.json` already pins exactly at the
 * §0.6.1 version — so generating this file added no dependency.
 *
 * The code below is unmodified registry output. Everything added is
 * documentation plus Prettier's formatting (semicolons and a trailing comma;
 * the Tailwind class order was already canonical, so
 * `prettier-plugin-tailwindcss` reordered nothing). §0.3.5 deliberately exempts
 * generated internals from the arbitrary-value ban, so the
 * `data-[orientation=…]` variants are left exactly as the registry emits them
 * rather than being rewritten into something that would conflict on the next
 * `shadcn add`. Only `badge.tsx` and `sonner.tsx` carry mandated post-generation
 * edits among the 38; this file carries none.
 *
 * ## What this replaces
 *
 * The legacy stylesheet styled the bare element globally — `hr { border-top:
 * 1px solid … }` in `resources/sass/elements.scss` — with a hard-coded colour
 * carrying a 10% alpha channel. Two things change. The colour now resolves
 * through a token (see below), and the element is no longer bare: §0.3.5's
 * "registry components over raw HTML" rule means no `<hr>` appears anywhere in
 * the authored tree once this component exists.
 *
 * ## `decorative` is the substantive prop, not boilerplate
 *
 * This is the capability the legacy `<hr>` could not express. A bare `<hr>` has
 * an implicit `separator` role and is therefore *always* announced, so a purely
 * ornamental rule added for visual rhythm became noise in a screen reader with
 * no way to opt out. Radix resolves the two cases to different semantics:
 *
 *   - `decorative` (the default, `true`) renders `role="none"`, removing the
 *     element from the accessibility tree entirely. Correct for a rule that
 *     exists only to look right — spacing between cards, a divider inside a
 *     menu whose grouping is already conveyed some other way.
 *   - `decorative={false}` renders `role="separator"`, announcing a genuine
 *     thematic boundary, and adds `aria-orientation="vertical"` for the
 *     vertical case only — `horizontal` is the implicit default of the
 *     `separator` role, so emitting it would be redundant. Correct where the
 *     rule itself carries meaning a non-sighted user would otherwise lose.
 *
 * Choose deliberately: the default is the quiet one, so a meaningful boundary
 * must opt in. Neither choice changes a single pixel, which is why this comment
 * exists — nothing about the rendered result signals that the decision was
 * made, and both spellings look equally finished in a diff.
 *
 * ## Colour comes from a token, and that token is shared
 *
 * The rule's colour arrives solely through `bg-border`, which Tailwind resolves
 * via the `--color-border` alias in the `@theme inline` layer to the `--border`
 * value declared in `:root` in `app/globals.css`. That value is the legacy
 * `$glow` colour carried across exactly (§0.3.3), so there is no hard-coded
 * colour in this file and none is permitted: `npm run audit:tokens` treats a
 * colour literal as a failure even in a generated file, where it exempts
 * arbitrary sizing.
 *
 * Do not override `--border` locally to adjust how this rule looks.
 * `--shadow-glow` is defined as a shadow *referencing* `--border` precisely so
 * the border colour and the shadow tint cannot drift apart, which means the
 * token is also the elevation tint on the polaroid frame, the cards and the
 * fixed navigation. Retuning it here to fix one rule would silently move
 * elevation across the whole site. Adjust the token in `app/globals.css`, once,
 * with that consequence in view.
 *
 * One light theme ships (§0.3.3), so no `dark:` variant is authored here and
 * the `.dark` block the registry can emit is absent by construction.
 *
 * ## The vertical orientation needs a height from its parent
 *
 * `orientation="vertical"` styles the rule `h-full w-px`, so it is only visible
 * when its container resolves to a non-zero height. Inside a flex *row* whose
 * height comes from its content this is the common silent failure: the rule
 * renders, occupies 1px of width, computes to `height: 0` and is invisible with
 * no error anywhere. Give the container a height, or let the default
 * `align-items: stretch` do it — but do not "fix" an invisible vertical rule by
 * adding a fixed pixel height here, which would be a magic value §0.3.5 forbids
 * in authored code.
 *
 * @example A purely visual rule between two sections — silent to assistive
 * technology.
 * ```tsx
 * <Separator className="my-6" />
 * ```
 *
 * @example A meaningful boundary, announced as a separator.
 * ```tsx
 * <Separator decorative={false} />
 * ```
 *
 * @example Vertical, inside a row that stretches its children so the rule has
 * a real height.
 * ```tsx
 * <Row align="stretch">
 *   <span>Toddler</span>
 *   <Separator orientation="vertical" />
 *   <span>Preschool</span>
 * </Row>
 * ```
 */

"use client";

import * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
