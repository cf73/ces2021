"use client";

/**
 * `Switch` — the binary toggle, generated from the pinned shadcn/ui registry.
 *
 * One of the 38 registry-generated files among the 43 in `components/ui/`
 * (§0.3.5). Registry membership was verified against the pinned CLI BEFORE
 * generation, as §0.3.1 requires: `npx shadcn@4.19.0 view switch` resolves and
 * declares exactly one dependency, `radix-ui`, which `package.json` already
 * pins at 1.6.7 — so no manifest change was needed. The body below is the
 * `new-york-v4` output produced by `npx shadcn@4.19.0 add switch` against the
 * committed `components.json`, with the three deviations flagged inline and
 * nothing else altered. Keeping it otherwise byte-faithful is deliberate: it is
 * what makes the next `shadcn add` a no-op rather than a merge conflict.
 *
 * ## WHAT THIS COMPONENT IS NOT RESPONSIBLE FOR
 *
 * This is a PURE CONTROLLED TOGGLE. It renders state and reports intent, and it
 * does nothing else. Three concerns that look like they belong here live
 * elsewhere on purpose, because each has its own enforcement point:
 *
 *   - It does NOT write. Persistence is a Server Action dispatching one of the
 *     discriminated commands in `lib/actions/commands.ts` (`set-published`,
 *     `set-section-enabled`, `update-nav-tree`, `update-globals`), each of
 *     which calls a `security definer` database function rather than issuing
 *     DML. A generic `updateField(table, column, value)` is an authorization
 *     hole dressed as convenience (§0.4.4), and a toggle that wrote directly
 *     would be exactly that hole with a nicer shape.
 *   - It does NOT confirm. Where a toggle needs an explicit confirmation step —
 *     `site_globals.maintenance_enabled` above all — that is `AlertDialog`'s
 *     job (§0.3.2). Burying a confirmation inside the control would apply it to
 *     every caller, including the six toggles that must not prompt.
 *   - It does NOT check capability. Authorization is decided in the database on
 *     every request, and re-decided by the write function. A caller renders
 *     this with `disabled` when `lib/auth.ts` says the actor lacks the
 *     capability; a caller that forgets still cannot write, because the
 *     database refuses.
 *
 * ## THE BOOLEANS THIS DRIVES, AND WHY `disabled` IS LOAD-BEARING
 *
 * Seven distinct columns reach staff through this one control, and they are not
 * interchangeable (§0.4.2):
 *
 *   - `published` on the seven content tables — `not null default false`,
 *     because a load error must not publish content. 55 of 163 migrated
 *     entries are drafts, including all 12 promoted entries and 3 of the 4
 *     announcements. Of the 142 content paths, 102 resolve publicly and 40
 *     return 404 purely because their entry is a draft, so this is the only
 *     control that moves that number. Publish state is enforced server-side —
 *     RLS restricts anonymous reads to `published = true`, so a draft is not
 *     fetched-then-hidden, it is not returned.
 *   - `page_sections.enabled` and `person_education.enabled` — `not null
 *     default true`. Seven disabled nested records exist in the migrated
 *     corpus; they are suppressed from public rendering, stay visible and
 *     toggleable in edit mode, and round-trip through export.
 *   - `nav_items.visible`, `announcements.feature_on_homepage`,
 *     `site_globals.banner_enabled` — presentation and placement.
 *   - `site_globals.maintenance_enabled` — the consequential one. Enabling it
 *     makes `proxy.ts` serve anonymous visitors a 503 with `Retry-After` and
 *     `noindex`.
 *
 * Capability differs across that set, which is the whole reason `disabled` gets
 * first-class treatment here rather than being an afterthought. Per §0.4.2's
 * matrix an editor may toggle `published` and a nested record's `enabled`, but
 * may NOT edit `site_globals` (including maintenance mode) or `nav_items`. The
 * same component therefore renders in contexts where the actor can and cannot
 * act, and the legacy configuration makes that split real rather than
 * theoretical: `resources/users/roles.yaml` grants the `editor` role a BROADER
 * permission set than `admin`, an authoring error the target resolves as
 * `admin ⊇ editor`. Radix maps `disabled` onto the underlying button's own
 * `disabled` attribute, so the state is announced to assistive technology and
 * the control is genuinely inert — not merely dimmed and then failing on click.
 *
 * ## THE THREE DEVIATIONS FROM REGISTRY OUTPUT
 *
 * Each is required by a governing standard, each was verified by compiling
 * `app/globals.css` through `@tailwindcss/postcss` rather than by reasoning
 * about Tailwind's behaviour, and each is flagged at its call site per §0.3.1.
 *
 *   1. COLOUR MODE — the three generated `dark:` utilities are removed. This is
 *      not tidying. `shadcn/tailwind.css` uses `@variant dark` without
 *      declaring a class-based `@custom-variant dark`, so `dark:` falls through
 *      to Tailwind's built-in variant and compiles to
 *      `@media (prefers-color-scheme: dark)` — confirmed in the compiled CSS.
 *      The site ships ONE light theme and `globals.css` carries no `.dark`
 *      block (§0.3.3), so those rules would fire for any visitor whose OS is in
 *      dark mode, on a theme that was never designed for it: an unchecked thumb
 *      would repaint to the `--foreground` green on a track lightened to 80% of
 *      `--input`, inverting the thumb/track relationship the light theme was
 *      contrast-audited for and pushing the track below the 3:1 that WCAG 2.2
 *      SC 1.4.11 asks of a non-text boundary.
 *
 *      Note on how the removed utilities are described below: they are named by
 *      their token and effect rather than spelled out as class strings, because
 *      Tailwind's scanner reads raw file bytes and is NOT comment-aware. Quoting
 *      the literal utilities here re-emitted every rule this deviation removes —
 *      measured, then fixed: the compiled stylesheet went from one
 *      `prefers-color-scheme: dark` block back to none. Dead CSS that a comment
 *      resurrects is still dead CSS, and it would have made this file's own
 *      claim false.
 *   2. TOUCH TARGET — the registry's default track is 18.4 x 32 px
 *      (`h-[1.15rem] w-8`), well under the 44 x 44 px §0.4.5 requires at
 *      320-575 px. A transparent `::before` overlay carries the hit area at
 *      `--size-control-touch` (2.75rem = 44px), collapsing to `--size-control`
 *      (2rem = 32px) from `--breakpoint-sm` (576px) upward, which is exactly
 *      the responsive matrix's three-column contract. Zero visual cost: the
 *      pseudo-element paints nothing and only enlarges the button's own
 *      clickable region. This matters more than it looks — §0.4.3's acceptance
 *      criterion has staff completing "publish a draft event" unaided ON A
 *      PHONE as one of five timed tasks, so touch is this control's primary
 *      environment, not an edge case.
 *   3. MOTION — the registry's bare `transition-all` / `transition-transform`
 *      inherit Tailwind's default 150ms and default easing, neither of which is
 *      a project token. Both are bound to `--duration-fast` (120ms) and
 *      `--ease-out` per §0.3.3. Suppression under
 *      `prefers-reduced-motion: reduce` is NOT re-implemented here: the last
 *      block of `globals.css` is a deliberately unlayered media query that
 *      collapses every transition to 1ms, which outranks Tailwind's utilities
 *      layer without `!important` and — because it uses 1ms rather than `none`
 *      — still lets Radix's `animationend` fire. A local copy would be a second
 *      owner of one behaviour.
 *
 * ## TOKEN CONSUMPTION — WHY THE PARENTHESISED FORM
 *
 * `--size-*` and `--duration-*` are NOT Tailwind namespaces, so there is no
 * `size-control-touch` or `duration-fast` utility; writing one yields a
 * full-width block and no error, which `globals.css` names as a measured trap.
 * They are consumed as `size-(--size-control-touch)` and
 * `duration-(--duration-fast)`. `--ease-*` IS a namespace, so the bare
 * `ease-out` utility resolves to this project's override of it,
 * `cubic-bezier(0.22, 1, 0.36, 1)` — verified in the compiled output rather
 * than assumed. Every colour resolves to a token: `--primary` (4.56:1),
 * `--input`, `--ring`, `--background`. No hex, no colour function, no CSS
 * named colour and no palette shade appears anywhere below.
 *
 * The non-colour arbitrary values that remain — `ring-[3px]`, `h-[1.15rem]`,
 * `translate-x-[calc(100%-2px)]` — are untouched registry internals, which
 * §0.3.5 scopes out of the zero-hardcoded-values rule on purpose: colour is the
 * axis where a stray literal breaks the brand contract, unlike a 3px focus
 * ring, and rewriting them would defeat the point of pinning the registry.
 */

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * An accessible on/off toggle.
 *
 * Radix renders a native `<button role="switch">` and keeps `aria-checked` in
 * step with state, so the control is keyboard-operable with Space and Enter,
 * exposes its state to assistive technology, and conveys that state by thumb
 * POSITION as well as by track colour — colour is never the sole indicator
 * (§0.4.5). Pair it with `Label`'s `htmlFor` for its accessible name, or with
 * `Field` when it needs a description or an error; `aria-describedby` forwards
 * through the prop spread for the standalone case.
 *
 * Controlled usage is the norm in this application, because every commit goes
 * through a Server Action and the caller owns the pending and conflict states:
 *
 * ```tsx
 * <Switch
 *   checked={published}
 *   onCheckedChange={(next) => startTransition(() => setPublished(next))}
 *   disabled={!canPublish || isPending}
 *   aria-describedby="publish-help"
 * />
 * ```
 *
 * @param className Merged through `cn`, so a caller's utility wins over the
 *   defaults below for any property they both set.
 * @param size `"default"` (18.4 x 32px track) or `"sm"` (14 x 24px). The hit
 *   area is unaffected — both sizes carry the same 44px touch target.
 * @param props Everything `SwitchPrimitive.Root` accepts, forwarded verbatim:
 *   `checked` and `onCheckedChange` for controlled use, `defaultChecked` for
 *   uncontrolled, plus `disabled`, `required`, `name`, `value`, `asChild` and
 *   the standard ARIA and DOM attributes. `checked` is a plain `boolean` — a
 *   switch has no indeterminate state, which is the one place its contract
 *   differs from `Checkbox`.
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        /* BLITZY [A11Y]: `relative` plus the transparent `before:` overlay carry a
           44x44px hit area at 320-575px per §0.4.5, collapsing to 32px from
           `--breakpoint-sm` up. Added to registry output, which ships an 18.4x32px
           track and no hit-area compensation. Zero visual cost. */
        /* BLITZY [MOTION]: `duration-(--duration-fast) ease-out` bind the registry's
           bare `transition-all` to the §0.3.3 tokens (120ms, the project's own
           `--ease-out`) instead of Tailwind's default 150ms and default easing.
           Reduced-motion suppression is global and unlayered in `globals.css`. */
        /* BLITZY [COLOR]: the registry's dark-mode override of the unchecked
           track — which lightened it to 80% of `--input` — is removed. One light
           theme ships (§0.3.3) and the dark variant compiles to a
           `prefers-color-scheme` media query here, so it would fire uninvited
           and lower the track below SC 1.4.11's 3:1. Named rather than quoted,
           for the scanner reason in the header. */
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all duration-(--duration-fast) ease-out outline-none before:absolute before:top-1/2 before:left-1/2 before:size-(--size-control-touch) before:-translate-x-1/2 before:-translate-y-1/2 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input sm:before:size-(--size-control)",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          /* BLITZY [MOTION]: as above — the thumb's `transition-transform` is bound
             to the same 120ms / `--ease-out` pair, so track and thumb move together
             rather than on two different clocks. */
          /* BLITZY [COLOR]: the registry's two dark-mode thumb overrides are
             removed — one repainted the checked thumb to `--primary-foreground`,
             the other the unchecked thumb to `--foreground`. The second is the
             consequential one: under OS dark mode it would paint an unchecked thumb
             dark green against a light track, inverting the audited relationship.
             Named rather than quoted, for the scanner reason in the header. */
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform duration-(--duration-fast) ease-out group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
