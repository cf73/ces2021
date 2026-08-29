/**
 * The empty-state primitive — one of the 38 files in `components/ui/`
 * generated from the shadcn registry (§0.3.5).
 *
 * Registry membership was verified against the pinned CLI before generation,
 * as §0.3.1 requires: `npx shadcn@4.19.0 view empty` resolves as a
 * `registry:ui` item declaring no dependencies, no `registryDependencies` and
 * no `cssVars`, so nothing was added to `package.json` and nothing in
 * `app/globals.css` was touched. Structure, `data-slot` attributes, the `cva`
 * shape, the layout classes, the arbitrary variants and the export block are
 * the registry's own output, kept byte-for-byte so the diff after a future
 * `shadcn add` stays reviewable. Three deliberate post-generation edits are
 * marked EDIT 1..3 below, each mandated rather than stylistic.
 *
 * ---------------------------------------------------------------------------
 * WHEN TO USE THIS COMPONENT — AND WHEN NOT TO
 * ---------------------------------------------------------------------------
 * There is no consistent legacy empty state to preserve; this component is
 * what creates one. `no_results` appears six times across five Antlers views
 * and behaves differently in almost every one: `events.antlers.html` carries
 * real copy that never fires, both `home.antlers.html` branches are literally
 * empty, `programs`/`flexpage` use `{{ unless no_results }}` purely to
 * suppress, and `room.antlers.html` leaks the staff note "No teachers added
 * yet!" to visitors.
 *
 * So the choice is deliberate per consumer, and reaching for this component
 * reflexively is a defect:
 *
 *   THE RULE — an empty state is right where a user EXPECTS content and its
 *   absence is informative. Suppression is right where the section itself is
 *   OPTIONAL, because there is nothing missing from the visitor's point of
 *   view.
 *
 *   USES this component:
 *     - `EventsIndex`   — the `{{if no_results}}` branch that exists today and
 *                         never fires (§0.5.1). A visitor who navigates to
 *                         /events expects events.
 *     - `ProgramsIndex` — "an empty published set renders a short editorial
 *                         line rather than an empty grid" (§0.4.5).
 *
 *   DOES NOT use this component — render nothing instead:
 *     - `PromotedCarousel` — "the all-draft state rendering the section absent
 *                            rather than empty" (§0.5.1).
 *     - `Classroom`        — "a classroom with no teachers renders no heading
 *                            and no empty list" (§0.5.1).
 *     - `ChildPageLinks`   — "rendering nothing when there are none" (§0.5.1).
 *     - `FlexPage`         — a missing hero image is "suppressed rather than
 *                            rendered empty" (§0.5.1).
 *
 * The home page is the clearest case for suppression. All 12 promoted entries
 * and 3 of the 4 announcements are drafts, so both features are dormant BY
 * PUBLISH STATE, NOT BROKEN, and §0.2.2 keeps publishing them out of scope —
 * "flags migrate exactly; the carousel and banner remain dormant until the
 * school publishes." Showing "No promoted events" there would turn an
 * invisible dormant feature into a visible defect.
 *
 * That constrains the COPY every consumer passes, not just the placement:
 * because draft state is authoritative and publishing is out of scope, an
 * empty state must never prompt anyone to publish something and must never
 * imply a fault. It states what is not there; it does not apologise for it or
 * assign blame.
 *
 * ---------------------------------------------------------------------------
 * NOTES FOR CONSUMERS
 * ---------------------------------------------------------------------------
 * - Borderless by default. The root sets `rounded-lg border-dashed` but no
 *   border WIDTH, so no border paints until a caller adds `border`. That is
 *   the registry's own behaviour, retained rather than "corrected": the dashed
 *   frame is opt-in.
 * - Overriding a text COLOUR is safe. Overriding a text SIZE needs the
 *   arbitrary "length:" form that EDIT 2 uses on the title below, spelled out
 *   for the role you want, because `tailwind-merge` classifies this project's
 *   custom type-role names (`h3`, `body`, `caption`) as colours rather than
 *   sizes — they are not t-shirt sizes — so a bare role utility and a colour
 *   utility collapse into one another and the loser is dropped silently.
 *   Measured against tailwind-merge 3.6.0:
 *     twMerge("text-h3", "text-primary")                     -> "text-primary"
 *     twMerge("text-[length:var(--text-h3)]", "text-primary") -> both kept
 *   The hint is a correctness requirement, not a style preference. Spelling
 *   the role out also matters here: Tailwind extracts class candidates from
 *   comments too, so a wildcard token name in this prose would emit a bogus
 *   `font-size` rule into the production stylesheet.
 * - `EmptyDescription` renders a `<div>` while typed `React.ComponentProps<"p">`.
 *   That mismatch is upstream's, and it is left exactly as generated: the two
 *   prop sets are effectively identical, it compiles, and changing either half
 *   would alter the rendered DOM or the public type for no benefit. Do not
 *   "fix" it.
 */

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border-dashed p-6 text-center text-balance md:p-12",
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn(
        "flex max-w-sm flex-col items-center gap-2 text-center",
        className,
      )}
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      /**
       * EDIT 1 of 3 — invisible accessibility, required by §0.4.5 via this
       * file's brief: "a decorative icon in EmptyMedia must be `aria-hidden`;
       * the message is what gets announced." The icon is supplied by the
       * caller as children, so the registry's `[&_svg]:pointer-events-none`
       * cannot reach it and CSS cannot hide it from assistive technology.
       * Defaulting the wrapper to `aria-hidden` means the accessible name of
       * the empty state comes from `EmptyTitle` and `EmptyDescription`, which
       * are siblings and therefore unaffected.
       *
       * Deliberately placed BEFORE the spread so it stays overridable: a
       * caller whose media is genuinely informative rather than decorative
       * passes `aria-hidden={false}` and supplies its own alternative text.
       * This has zero visual impact, which is the category the UI guidelines
       * say never conflicts with a design source and must always be applied.
       */
      aria-hidden="true"
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      /**
       * EDIT 2 of 3 — the registry emits `text-lg font-medium tracking-tight`.
       * `--text-lg` and `--tracking-tight` are NOT declared in
       * `app/globals.css`, so both would fall through to a Tailwind default
       * and source this heading's scale from outside the §0.3.3 token
       * contract. Rebound to the declared Heading 3 role, which §0.3.3 assigns
       * to card titles at 700 weight — hence `font-bold` rather than
       * `font-medium`, and no tracking utility at all, since `--text-h3`
       * declares no letter-spacing companion.
       *
       * The `length:` hint is load-bearing, not decoration: a bare `text-h3`
       * is silently dropped by `tailwind-merge` when a caller passes any text
       * colour (see NOTES FOR CONSUMERS above), which would quietly render
       * this title at body size. The colour is inherited — `@layer base` sets
       * `body { color: var(--color-foreground) }` and `h1..h6 { color:
       * inherit }` — so no colour utility is needed here, and adding one would
       * reintroduce exactly that collision.
       */
      className={cn(
        "text-[length:var(--text-h3)] leading-[var(--text-h3--line-height)] font-bold",
        className,
      )}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      /**
       * EDIT 3 of 3 — the registry emits `text-sm/relaxed text-muted-foreground`.
       * `--leading-relaxed` is not declared, and this file's brief binds the
       * description to `--text-body`. Only the colour utility survives,
       * because the Body role is already the inherited default: `@layer base`
       * sets `body { font-size: var(--text-body); line-height:
       * var(--text-body--line-height); letter-spacing:
       * var(--text-body--letter-spacing) }`. That is §0.3.3's Body role — "all
       * prose, preserved exactly" — and its 1.6 line-height is precisely the
       * generous measure `/relaxed` was reaching for.
       *
       * Restating the size here as `text-body` would be worse than redundant:
       * `tailwind-merge` would collapse it against `text-muted-foreground` and
       * drop one of the two. The link treatment is the registry's, unchanged.
       */
      className={cn(
        "text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance",
        className,
      )}
      {...props}
    />
  );
}

export {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
};
