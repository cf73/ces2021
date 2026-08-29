/**
 * `Item` — the row primitive, generated from the shadcn/ui registry.
 *
 * ## Provenance and authority
 *
 * One of the 38 registry-generated files among the 43 in `components/ui/`
 * (§0.3.5). Registry membership was verified against the pinned CLI *before*
 * generation, as §0.3.1 requires: `shadcn@4.19.0 view item` resolves and
 * reports `dependencies: ["radix-ui"]` and `registryDependencies:
 * ["separator"]`. The file was then produced by `shadcn@4.19.0 add item`
 * against the committed `components.json` (`new-york`, `rsc: true`,
 * `baseColor: stone`, `iconLibrary: lucide`). The declared dependency was
 * already present at its exact pin, `radix-ui@1.6.7`, so no manifest change
 * accompanied the generation.
 *
 * §0.3.5 deliberately exempts unmodified registry internals from the "zero
 * hardcoded values" rule and governs them by `npm run audit:tokens` instead,
 * which fails a generated file only on a colour literal. Every colour below is
 * a token — `border-border`, `bg-muted/50`, `bg-accent/50`,
 * `text-muted-foreground`, `text-primary`, `border-ring`, `ring-ring/50`,
 * `bg-border` — so the arbitrary values that remain (`ring-[3px]`, and the
 * `[&_svg]` / `[&>a]` / `[&+[data-slot=…]]` / `group-has-[…]` arbitrary
 * variants, which are selectors rather than property values) are inventoried
 * rather than violations. `bg-transparent` is on §0.3.5's permitted-literal
 * list. There is no `dark:` variant anywhere: the site ships one light theme
 * (§0.3.3), and `globals.css` carries no `.dark` block for one to resolve
 * against.
 *
 * There is no `"use client"` directive, and that is load-bearing rather than
 * incidental — see the note on list semantics below.
 *
 * ## The two deviations from generated output, and why each is forced
 *
 * 1. **The separator.** The registry emits `import { Separator } from
 *    "@/components/ui/separator"`. That module is a separate registry item
 *    with its own owner and is not among this file's declared dependencies, so
 *    importing it is out of bounds here. `ItemSeparator` therefore renders the
 *    Radix primitive that the registry item itself declares — `Separator` from
 *    the consolidated `radix-ui` package — carrying the same token-backed
 *    classes the generated `separator.tsx` applies (`shrink-0 bg-border`, plus
 *    the two `data-[orientation=…]` pairs). DOM output, computed styling and
 *    the forwarded prop surface (`orientation`, `decorative`) are unchanged.
 * 2. **`aria-hidden` on that separator.** Radix's `decorative` yields
 *    `role="none"`, which is not the same thing. A rule drawn between two rows
 *    carries nothing a screen reader needs, and inside `ItemGroup`'s
 *    `role="list"` an element that is neither a `listitem` nor removed from the
 *    accessibility tree is an unallowed child. It is set before the prop
 *    spread, so a caller can still override it.
 *
 * No other edit was made. §0.3.2 names eight parts as the contract — `Item`,
 * `ItemMedia`, `ItemContent`, `ItemTitle`, `ItemDescription`, `ItemActions`,
 * `ItemGroup`, `ItemSeparator` — and the registry additionally emits
 * `ItemHeader` and `ItemFooter`. Those two are kept rather than pruned:
 * deleting registry output is the kind of divergence that turns the next
 * `shadcn add` into a merge conflict, and both are additive.
 *
 * ## What this replaces, and the defect it closes
 *
 * `Item` is the row form of a card — what the legacy templates should have
 * used wherever a person, an event, a child page or an asset was rendered as a
 * horizontal record. Its consumers are `EventCard`, `ChildPageLinks`, the
 * classroom teacher list in `templates/Classroom.tsx`, the `AssetLibrary` rows
 * and the `RevisionHistory` entries.
 *
 * The teacher list is the case worth understanding. Two legacy pages rendered
 * the same three people with different affordances: on `/programs/day-programs`
 * each teacher was a link, while `room.antlers.html` listed them through the
 * reverse relation (`{{collection:people classrooms:contains="{id}"}}`) as an
 * unlinked `<img alt="{{title}}">` with the email address as plain `<h5>` text.
 * One shared row component is what makes that inconsistency unrepresentable:
 * the presentation becomes one component, and the data becomes one union table
 * carrying a `source` tag.
 *
 * ## Composition rules for consumers
 *
 * - **One tab stop per actionable row.** When the whole row navigates, pass
 *   `asChild` and let the link *be* the row:
 *   `<Item asChild><Link …>…</Link></Item>`. Do not then nest a `<button>`
 *   inside it — a control inside a link is two tab stops for one action, which
 *   is the defect the legacy layout commits at `layout.antlers.html:54`. A row
 *   that needs both a destination and a secondary action keeps the row inert
 *   and puts the link on `ItemTitle`, with the action in `ItemActions`.
 * - **An empty group renders nothing.** `ItemGroup` has no empty state of its
 *   own, by design: a classroom with no teachers must render no heading and no
 *   empty list (§0.5.1), so the consumer omits the group entirely rather than
 *   rendering an empty one. Where an empty state *is* wanted, `Empty` is the
 *   component for it.
 * - **List semantics.** `ItemGroup` is `role="list"`, so its children should be
 *   list items. A group of inert rows satisfies that as generated; a group
 *   whose rows are themselves links must either wrap each row in an element
 *   with `role="listitem"` — the `<li><a></a></li>` shape — or drop the list
 *   role with `role={undefined}`. This is a requirement rather than a
 *   preference: an unwrapped `role="list"` whose children are links is an
 *   `aria-required-children` failure, which the automated `axe-core` gate
 *   reports and which would cost the accessibility score §0.9.3 asserts at
 *   1.00. A `role="listitem"` wrapper costs no tab stop, because only the link
 *   inside it is interactive. The choice is left to the call site rather than
 *   inferred here on purpose: detecting group membership would need React
 *   context, context would require `"use client"`, and that would turn a
 *   primitive which renders perfectly well on the server into one shipped to
 *   every browser — against a budget of 180 KB of compressed JavaScript for the
 *   whole page (§0.9.3).
 * - **Media sizing.** `ItemMedia variant="image"` is a fixed 40 px square with
 *   `overflow-hidden` that constrains an image child to fill and cover, sized
 *   for a thumbnail beside `ItemTitle` and `ItemDescription`. A portrait that
 *   needs a focal point or a responsive `srcset` belongs in `Media` over
 *   `next/image`, placed inside `ItemMedia` — never a raw `<img>`.
 */

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Separator as SeparatorPrimitive,
  Slot as SlotPrimitive,
} from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A vertical run of `Item` rows.
 *
 * Renders `role="list"` so a run of rows is announced as a list with a count.
 * The `group/item-group` marker is the named Tailwind group the registry uses
 * for group-scoped variants; it is kept even though no variant in this file
 * currently reads it, because pruning it would diverge from registry output for
 * no gain.
 *
 * Has no gap of its own: rows are separated either by their own padding or by
 * an explicit `ItemSeparator`.
 */
function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn("group/item-group flex flex-col", className)}
      {...props}
    />
  );
}

/**
 * A rule between two rows.
 *
 * Purely decorative: `decorative` (Radix's own `role="none"`) and
 * `aria-hidden="true"` are both applied before the prop spread, so the element
 * is absent from the accessibility tree and cannot be an unallowed child of
 * `ItemGroup`'s list — while a caller who genuinely wants a semantic
 * `role="separator"` can still pass `decorative={false} aria-hidden={false}`.
 *
 * `my-0` neutralises any inherited vertical margin so spacing is owned by the
 * rows, not the rule.
 */
function ItemSeparator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="item-separator"
      orientation={orientation}
      decorative={decorative}
      aria-hidden="true"
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        "my-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The row's own variants.
 *
 * `variant` is the surface treatment: `default` is transparent for a row
 * sitting on a page that already has a surface, `outline` draws the
 * `--border` token, and `muted` tints with `--muted` at half opacity.
 * `size` is the density: `default` for a standalone row, `sm` for a dense list
 * such as the asset library or a revision log.
 *
 * The base classes carry two behaviours worth naming. `flex-wrap` lets a long
 * title, media and actions reflow onto a second line on a narrow viewport
 * instead of overflowing — which is why no row needs a fixed height, unlike the
 * legacy `.peoplecard` at `height: 400px`. And `focus-visible:` rather than
 * `:focus` means the ring appears for keyboard users only, restoring the
 * indicator the legacy stylesheet suppressed site-wide with
 * `outline: none !important`.
 */
const itemVariants = cva(
  "group/item flex flex-wrap items-center rounded-md border border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [a]:transition-colors [a]:hover:bg-accent/50",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border",
        muted: "bg-muted/50",
      },
      size: {
        default: "gap-4 p-4",
        sm: "gap-2.5 px-4 py-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * One row.
 *
 * Composes `ItemMedia`, `ItemContent` (holding `ItemTitle` and
 * `ItemDescription`) and `ItemActions`. Pass `asChild` to make the row itself
 * the interactive element — a `next/link` anchor or a button — which keeps an
 * actionable row at exactly one tab stop and puts the focus ring on the whole
 * row rather than on something inside it.
 *
 * `data-variant` and `data-size` are emitted alongside the classes so a
 * consumer or a test can assert the resolved variant without parsing a class
 * string.
 */
function Item({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof itemVariants> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Root : "div";
  return (
    <Comp
      data-slot="item"
      data-variant={variant}
      data-size={size}
      className={cn(itemVariants({ variant, size, className }))}
      {...props}
    />
  );
}

/**
 * The leading slot of a row: a thumbnail, an avatar, or an icon.
 *
 * `default` adds no box of its own, for a child that brings its own frame —
 * `Avatar`, or `Media` inside an `AspectRatio`. `icon` is a 32 px tinted,
 * rounded box that sizes an unsized `lucide-react` glyph to 16 px. `image` is a
 * 40 px square that clips its child and makes it cover, for a thumbnail.
 *
 * Under `group-has-[[data-slot=item-description]]/item:` the media aligns to
 * the top of a two-line row instead of centring against it, so a thumbnail
 * lines up with the title rather than floating between title and description.
 */
const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center gap-2 group-has-[[data-slot=item-description]]/item:translate-y-0.5 group-has-[[data-slot=item-description]]/item:self-start [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "size-8 rounded-sm border bg-muted [&_svg:not([class*='size-'])]:size-4",
        image:
          "size-10 overflow-hidden rounded-sm [&_img]:size-full [&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/** The leading media slot. See {@link itemMediaVariants} for the variants. */
function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

/**
 * The row's text column.
 *
 * `flex-1` makes it absorb the space media and actions leave, so a row needs no
 * width calculation. A second, adjacent `ItemContent` drops back to its
 * intrinsic width — the shape for a trailing value column, such as a date or a
 * file size, beside a growing title.
 */
function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        "flex flex-1 flex-col gap-1 [&+[data-slot=item-content]]:flex-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The row's primary line.
 *
 * A `div` rather than a heading, because a row is not a document section and a
 * list of rows must not inject heading levels into the page outline. Where a row
 * genuinely titles a section, the consumer passes its own heading element as a
 * child.
 *
 * `w-fit` keeps a trailing badge or icon tight against the text instead of at
 * the far edge of the column.
 */
function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "flex w-fit items-center gap-2 text-sm leading-snug font-medium",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The row's secondary line — a person's official title, an event's venue, an
 * asset's dimensions.
 *
 * A real `<p>`, clamped to two lines so one long value cannot push a list out
 * of rhythm, in `--muted-foreground` (6.3:1 on `--background`, so it clears
 * WCAG AA as body text rather than relying on being "secondary"). A link inside
 * it is underlined at all times, because colour alone is never the sole
 * indicator of meaning.
 */
function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "line-clamp-2 text-sm leading-normal font-normal text-balance text-muted-foreground",
        "[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The trailing slot: the row's controls.
 *
 * Only ever populated on a row that is *not* itself actionable — see the
 * one-tab-stop rule in this file's header. Touch sizing belongs to the control
 * placed here (`Button size="icon"` against `--size-control-touch`), not to
 * this container.
 */
function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

/**
 * A full-width band above the row's main line.
 *
 * Registry output, retained verbatim; `basis-full` makes it claim its own line
 * within the row's `flex-wrap` container.
 */
function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A full-width band below the row's main line. Registry output, retained
 * verbatim; the counterpart to {@link ItemHeader}.
 */
function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemHeader,
  ItemFooter,
};
