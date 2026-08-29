/**
 * `Skeleton` — the loading placeholder surface.
 *
 * One of the 38 registry-generated files among the 43 in `components/ui/`
 * (§0.3.5). Produced by the pinned CLI rather than authored: registry
 * membership was verified first, as §0.3.1 requires, with
 * `npx shadcn@4.19.0 view skeleton` — which resolved, returning one
 * `registry:ui` file (`registry/new-york-v4/ui/skeleton.tsx`) and declaring
 * NO npm `dependencies` and NO `registryDependencies`. That is why this
 * component added nothing to `package.json`: it needs nothing beyond `cn`,
 * and the pulse comes from Tailwind's own `--animate-pulse` theme value.
 * `shadcn add skeleton` then wrote the file against the committed
 * `components.json` (`new-york`, `rsc: true`, `baseColor: stone`,
 * `cssVariables: true`), creating exactly this one file and touching neither
 * `app/globals.css` nor any manifest.
 *
 * The generated output was, verbatim:
 *
 *     className={cn("animate-pulse rounded-md bg-accent", className)}
 *
 * with no `aria-hidden`. Three deviations from it are applied below. Each is
 * mandated by this file's brief rather than chosen, and each is flagged inline
 * at its site in the §0.3.5 house style so a diff after a future
 * `shadcn add` stays reviewable and nobody "restores" one by mistake:
 * `bg-accent` → `bg-muted`, `animate-pulse` → `motion-safe:animate-pulse`,
 * and the addition of `aria-hidden`. Everything else — the function
 * declaration, the `data-slot` attribute, the `React.ComponentProps<"div">`
 * signature, the trailing `export { Skeleton }` — is the registry's shape,
 * kept deliberately so the next upgrade is a small diff.
 *
 * No user-specified rules were provided for this project: `review_rules`
 * returns `No user rules provided.`, and §0.8 states the same independently.
 * Nothing here originates from a rule document. The absence is not licence to
 * lower the bar, so this file is held to §0.3.2 (the "Loading states" row),
 * §0.3.3 (tokens, motion, one light theme), §0.3.5 (the generated-file
 * compliance boundary), §0.4.5 (WCAG 2.2 AA) and §0.6.5 (imports).
 *
 * ## THE PROP CONTRACT: THE SURFACE IS OURS, THE GEOMETRY IS THE CALLER'S
 *
 * §0.3.2 specifies this component's API in three words — "`className` for
 * shape". The division is absolute and it is what keeps 43 call sites from
 * each inventing a placeholder:
 *
 *   - THIS FILE owns the surface: the fill, the corner radius and the pulse.
 *     It sets no width, no height and no margin, so it has no opinion about
 *     where it sits.
 *   - THE CALLER owns the geometry, passed through `className`. The caller's
 *     classes are merged LAST, so `tailwind-merge` lets them win any conflict
 *     with the three base utilities — `cn("rounded-md", "rounded-full")`
 *     yields `rounded-full`, not both (see `lib/utils.ts`).
 *
 * Every `div` prop is forwarded, so `id`, `style`, `data-*` and a ref all pass
 * straight through. React 19 treats `ref` as an ordinary prop on function
 * components, so `React.ComponentProps<"div">` already includes it and no
 * `forwardRef` wrapper is needed.
 *
 * ## CONSTRAINT 1: A SKELETON MUST NOT CAUSE THE SHIFT IT EXISTS TO PREVENT
 *
 * `lighthouserc.json` asserts CLS <= 0.05, and the legacy baseline is
 * EXACTLY 0 — §0.7.2 measured that "CLS is 0 and the document itself is served
 * in 180 ms, so the problem is entirely payload and blocking, not markup
 * instability". Cumulative Layout Shift is therefore one of only two metrics
 * the current site already gets right, sitting behind a Performance score of 55
 * and a 57.4 s LCP. A placeholder whose box differs from the box its content
 * finally occupies is one of the very few ways this rebuild could make that
 * specific number WORSE than the site it replaces.
 *
 * Two halves, and only the first is this file's to guarantee:
 *
 *   - Guaranteed here: the pulse cannot move anything. Tailwind 4.3.3 defines
 *     `--animate-pulse` as `pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`
 *     over `@keyframes pulse { 50% { opacity: 0.5 } }` — verified by compiling
 *     through this project's own `@tailwindcss/postcss` pipeline. It animates
 *     OPACITY ALONE. No transform, no dimension, no offset, so it contributes
 *     no layout shift by construction, and the legacy `animate.css`
 *     `@keyframes pulse` — which scaled `scale3d(1, 1, 1)` to
 *     `scale3d(1.05, 1.05, 1.05)` — is deliberately not what runs here.
 *   - THE CALLER'S OBLIGATION: size the skeleton to the real box. Give it the
 *     same height the loaded content will take, and for media wrap it in
 *     `AspectRatio` (`components/ui/aspect-ratio.tsx`) or apply an
 *     `--aspect-*` token from §0.3.3 — `--aspect-square` for a portrait,
 *     `--aspect-portrait` for a polaroid, `--aspect-hero-sm/md/lg` for a hero,
 *     `--aspect-embed` for a framed embed. Those tokens exist precisely because
 *     they replace every `vh` height in the legacy layer, and a ratio box
 *     reserves its space before the image arrives. A bare `h-4` next to text
 *     that renders at `--text-body` (1.0625rem over a 1.6 line-height, so
 *     1.7rem) reserves too little and shifts the page on swap.
 *
 * ## CONSTRAINT 2: A SKELETON MUST BE SILENT TO ASSISTIVE TECHNOLOGY
 *
 * A placeholder carries no meaning. A dozen of them announced individually is
 * strictly worse than silence, so this element is `aria-hidden` and contributes
 * nothing to the accessibility tree. The loading STATE is real information and
 * belongs to the region being replaced, not to the placeholder: give that
 * region `aria-busy="true"` while it loads, or announce completion through a
 * live region. This is invisible accessibility in the sense of the UI
 * guidelines — it changes no pixel, so it can never conflict with a design
 * source, and it applies unconditionally.
 *
 * `aria-hidden` is declared BEFORE the prop spread, so it is a default rather
 * than a lock: a caller with a genuine reason to expose the node passes
 * `aria-hidden={false}` and their value wins. Anything so exposed needs its own
 * accessible name and role; the default exists because that is almost never
 * what is wanted.
 *
 * ## CONSTRAINT 3: THE PULSE IS SUPPRESSED UNDER REDUCED MOTION
 *
 * §0.3.3 is unambiguous — "Every animation references these, and every one is
 * suppressed under `prefers-reduced-motion: reduce`" — and an indefinitely
 * pulsing box is exactly the motion that criterion exists for. The legacy layer
 * did the opposite, and it was measured: `prefers-reduced-motion` occurs ZERO
 * times in `ces.css`, `splide.min.css` and `all.css`, and zero times in the
 * 73,641-byte vendored `animate.css` that ships its own ungated `.pulse` class
 * while never being loaded by any template at all.
 *
 * `app/globals.css` already carries a deliberately UNLAYERED
 * `@media (prefers-reduced-motion: reduce)` block that collapses every
 * animation to 1 ms with a single iteration, and unlayered declarations outrank
 * Tailwind's `utilities` layer, so that net catches this component too. It is
 * still not sufficient on its own, and the reason is worth stating: it clamps
 * the DURATION but leaves `animation-name` computing to `pulse`, so the
 * animation still exists and still starts. `motion-safe:` is used instead of a
 * bare `animate-pulse` so the declaration is never emitted at all under
 * `reduce` — it compiles to
 * `@media (prefers-reduced-motion: no-preference) { animation: var(--animate-pulse) }`,
 * verified against this project's own Tailwind build. That is precisely the
 * form the UI guidelines prescribe (animations live inside a no-preference
 * query), it makes the guarantee a property of this component rather than of a
 * stylesheet elsewhere in the tree, and it leaves `animation-name` resolving to
 * `none` under `reduce` — directly assertable, unlike an imperceptibly short
 * animation. What remains under `reduce` is a static, fully visible
 * placeholder: the pulse only ever lowers opacity at its midpoint, so with no
 * animation the surface simply sits at full opacity.
 *
 * Consequence for callers, because it is the one non-obvious edge of this
 * choice: the base animation utility is variant-scoped, so `tailwind-merge`
 * treats a plain `animate-none` as a different utility rather than an override.
 * To ship a deliberately static skeleton, pass `motion-safe:animate-none`.
 *
 * ## WHERE THIS COMPONENT BELONGS — AND WHERE IT DOES NOT
 *
 * §0.4.4 settles the caching model as "cache the anonymous data, render the
 * HTML per request". Anonymous content reads are `use cache` functions carrying
 * `cacheTag` values, so "a public page render is a template render, not a
 * database round trip". A genuinely slow boundary on a public route is
 * therefore rare, and a skeleton there is decoration that costs a real render
 * pass.
 *
 * Where it earns its place is the authenticated surfaces, whose readers under
 * `lib/content/live/*` are UNCACHED BY DESIGN so that RLS grants the caller
 * draft and private visibility: `app/admin/**`, `AssetLibrary` (289 migrated
 * assets) and `RevisionHistory`. `SidebarMenuSkeleton` in
 * `components/ui/sidebar.tsx` is the other consumer, which is why this file is
 * generated before that one.
 *
 * There is nothing to port here. §0.5.1 records that `app/loading.tsx` has "no
 * source" because "the legacy site has no error boundary, no loading state and
 * no OG image" — this component is net-new capability, which is exactly why its
 * two constraints above are stated rather than inherited.
 *
 * @example A text block, sized to the line box it replaces.
 * ```tsx
 * <div aria-busy="true">
 *   <Skeleton className="mb-2 h-6 w-3/4" />
 *   <Skeleton className="h-6 w-1/2" />
 * </div>
 * ```
 *
 * @example Media, where the ratio is what protects CLS.
 * ```tsx
 * <AspectRatio ratio={1}>
 *   <Skeleton className="size-full rounded-full" />
 * </AspectRatio>
 * ```
 */

import { cn } from "@/lib/utils";

/**
 * A single loading placeholder.
 *
 * @param className Geometry for this instance — width, height, margin, and any
 *   radius or fill override. Merged after the base utilities, so it wins every
 *   conflict.
 * @param props Any other `div` attribute, forwarded unchanged. Declared after
 *   the defaults below, so `aria-hidden` and `data-slot` are both overridable.
 * @returns A `div` carrying the placeholder surface and, unless the visitor has
 *   asked for reduced motion, the pulse.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      /* BLITZY [A11Y]: added to the generated output, which carried no ARIA at
         all. A placeholder has no meaning to announce; the region it sits in
         owns the busy state. Declared before the spread so a caller can still
         pass `aria-hidden={false}`. */
      aria-hidden
      className={cn(
        /* BLITZY [COLOR]: `bg-accent` in the generated output, changed to
           `bg-muted` per this file's brief ("Resolve to --muted and
           --radius-md"). `--accent` is this project's warm cream, a brand
           surface that reads as content rather than as absence; `--muted` is
           the neutral quiet token and is what a placeholder should be. Both
           are tokens, so neither is a literal — this is a semantic correction,
           not a compliance fix.
           BLITZY [MOTION]: `animate-pulse` in the generated output, scoped to
           `motion-safe:` so the animation is emitted only inside
           `@media (prefers-reduced-motion: no-preference)` (§0.3.3). Under
           `reduce` the placeholder stays visible and perfectly still.
           `rounded-md` is the registry's own utility and resolves to
           --radius-md; it is kept unchanged. */
        "rounded-md bg-muted motion-safe:animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
