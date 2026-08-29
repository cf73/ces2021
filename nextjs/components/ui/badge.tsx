/**
 * Badge — the role taxonomy chip and the event date chip.
 *
 * GENERATED from the pinned shadcn/ui registry, then modified in exactly three
 * enumerated places. The provenance and the delta list are recorded here
 * because §0.3.5 keeps registry output reviewable: a future `shadcn add badge`
 * must produce a diff a reader can confine to these three changes.
 *
 *   Registry item : badge (registry:ui), style new-york-v4
 *   CLI           : shadcn 4.19.0, membership confirmed with `shadcn view badge`
 *                   before generating, per §0.3.1
 *   Declared dep  : radix-ui — already pinned at 1.6.7, so no manifest changed
 *
 * ## THE THREE DELTAS FROM PRISTINE REGISTRY OUTPUT
 *
 * D1  ADDED the `gradient-date` variant. §0.3.2 mandates it: "Gradient date
 *     chip is a project variant added to the generated `badgeVariants`, keeping
 *     `--gradient-event` with a `--foreground` text colour". The measured
 *     contrast rationale sits on the variant itself.
 *
 * D2  On the destructive variant, the registry's bare colour-keyword text
 *     utility became `text-destructive-foreground`. Neither cosmetic nor
 *     optional: `npm run audit:tokens` fails a colour literal in a generated
 *     file, and it was observed failing on the pristine output with exactly one
 *     violation, reported as a `colourLiteral` on that class. §0.3.5 exempts
 *     generated files from the arbitrary-VALUE ban only; colour is the one axis
 *     that "fails in generated files too", and the audit carries no allowlist,
 *     suppression file, ignore comment or baseline by design, so there is no
 *     way to pass while the literal remains. The substitution is visually
 *     identical, because `app/globals.css` defines that token as the same pure
 *     white the keyword names; nothing renders differently.
 *
 * D3  REMOVED the three dark-mode overrides the registry ships: an
 *     invalid-state focus indicator on the base, plus a background and a focus
 *     indicator on the destructive variant. §0.3.3 ships one light theme and
 *     `app/globals.css` carries no dark-theme block. These were NOT dead code:
 *     the dark variant resolves against Tailwind's built-in one, and compiling
 *     them against this project's own stylesheet emits a real
 *     `prefers-color-scheme` media query. A visitor whose OS prefers dark would
 *     have seen the destructive badge at 60% opacity on a single-theme site, and
 *     a light-preference Lighthouse run could never have detected it.
 *
 * Everything else is untouched ON PURPOSE. §0.3.5 exempts unmodified registry
 * internals from the zero-hardcoded-values rule, so the two arbitrary values
 * (`focus-visible:ring-[3px]`, `transition-[color,box-shadow]`) and the ten
 * arbitrary variants (`[&>svg]:size-3`, `[a&]:hover:bg-primary/90`, and the
 * rest) stay exactly as generated. The audit inventories those; they are not
 * failures, and "fixing" them would defeat the point of pinning the registry.
 *
 * The pinned registry ships SIX variants, not the four §0.3.2 enumerates:
 * `ghost` and `link` arrive with it. All six are kept. The four named are all
 * present, so the contract holds, and deleting the extras would both modify
 * generated output and destroy the reviewable-diff property above.
 *
 * ## THE TWO CONSUMERS
 *
 * Role taxonomy chip — `components/site/PersonCard.tsx` and
 * `components/templates/PeopleIndex.tsx` render one of the three live `role`
 * terms: teacher, board-of-directors, leadership. `content/taxonomies/role.yaml`
 * declares nothing but a title, so every term is public and there is no
 * visibility state for the chip to express. Use the registry variants, paired
 * with the Space Mono meta voice at the call site.
 *
 * ONE MEASURED CAVEAT FOR THAT CONSUMER, because it is a silent wrong-size bug
 * rather than an obvious break. `tailwind-merge` resolves a conflict only
 * between utilities it can CLASSIFY. A stock size utility is classified and
 * merges cleanly, so a caller's stock size replaces the base size outright.
 * A utility built on a project-declared entry in the `--text-*` namespace is
 * NOT classified, so `cn` keeps BOTH it and the base size, and the winner is
 * then decided by position in the compiled stylesheet rather than by call-site
 * order. Compiling this project's stylesheet shows that position is canonical
 * and independent of source order, and that the base's size rule is emitted
 * LAST — so at equal specificity THE BASE WINS. A role chip that supplies only
 * the meta voice therefore keeps the meta letter-spacing but renders at the
 * base size, not at the 0.875rem the meta role specifies.
 *
 * This file cannot fix that: the base size is registry output, and `cn` is
 * shared. The consuming component should either pass a stock size utility
 * whose declared token value equals the meta size — `app/globals.css` declares
 * both at 0.875rem — or that behaviour should be corrected once, centrally, by
 * teaching `lib/utils.ts` about the project's custom text scale. Either is a
 * decision for those files' owners; it is recorded here because this is where
 * it is observable.
 *
 * Event date chip — `components/site/EventDateChip.tsx` is the `gradient-date`
 * consumer. Its geometry belongs to that component, and this file is
 * deliberately built not to obstruct it:
 *
 *   - The `gradient-date` variant sets a background and a text colour and
 *     NOTHING ELSE. No width, no height, no flex-direction, and above all no
 *     font-size. The legacy chip renders its day numeral at 24px below the
 *     1200px breakpoint and 96px above it, and §0.5.1 requires the port to fold
 *     the duplicated `.showifxl` / `.hideifxl` numeral into ONE element whose
 *     type scale changes responsively. A font-size here would fight that.
 *   - The generated BASE does carry a small stock size. That is registry output
 *     and it stays, and for THIS consumer it is not an obstacle: the date chip
 *     scales with stock size utilities, which `tailwind-merge` classifies, so
 *     `cn()` drops the base size and the caller's responsive pair survives.
 *     Verified by exercising the real `cn` over this variant: the base size is
 *     removed, both the caller's base-breakpoint and large-breakpoint sizes
 *     remain, the base width utility is replaced by the caller's, and the
 *     gradient and text colour come through untouched. The caveat under the
 *     role chip above applies only to custom-token size utilities.
 *   - The base also carries `rounded-full`, `w-fit`, `whitespace-nowrap` and
 *     `overflow-hidden`. A full-bleed or column-oriented chip overrides each
 *     the same way. `--size-datechip` (the legacy 275px column) and the
 *     responsive matrix in §0.4.5 are the consumer's to apply, including the
 *     fix for the horizontal variant that bleeds 15px off a 1440px viewport.
 *
 * No hover state is invented for `gradient-date`. The legacy `.datearea` has
 * none, and the project's state rule is that interactive states match the
 * design's own variants rather than being improvised. Focus is already covered
 * by the base's `focus-visible` treatment, which paints outside the gradient and is
 * therefore unaffected by it. A chip that must announce itself as a date
 * should be rendered through `asChild` over a `<time dateTime="…">` element,
 * which is why that prop is part of this file's contract.
 *
 * ## TOKENS ONLY
 *
 * Every value here resolves to a token declared in `app/globals.css`. No
 * colour notation of any kind appears in this file — no hex digits, and no
 * functional colour syntax: the gradient's stops are permitted only inside
 * that token's own definition (§0.3.5), which is that stylesheet, not this
 * file. That holds for the prose as well as the code, so a scan of this file
 * finds no literal even in its documentation.
 *
 * ## WHY THIS DOCUMENTATION DESCRIBES CLASSES INSTEAD OF QUOTING THEM
 *
 * Tailwind 4's scanner reads source files as PLAIN TEXT and does not parse
 * comments, so any complete utility class name written in prose becomes a real
 * candidate and is compiled into the shipped stylesheet. That was measured, not
 * assumed: an earlier revision of this header quoted the classes D2 and D3
 * remove, and compiling this file emitted 7 extra selectors and 1,098 extra
 * bytes — among them the very colour-keyword utility D2 exists to delete and
 * all three dark-mode rules D3 exists to delete. Documenting the removals had
 * silently reinstated them in the output.
 *
 * The deltas above therefore describe those classes rather than quoting them.
 * Class names that DO still appear in prose are ones the code itself uses, so
 * they add no candidate. Please keep it that way when editing: a quoted class
 * name here has a real cost in `app/globals.css`'s compiled output and in the
 * §0.9.3 CSS budget, and quoting a removed class re-ships it.
 */

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // D3 removed the trailing dark-mode invalid-state override from the end of
  // this string; see the header for why it is described and not quoted.
  // Otherwise verbatim registry output, arbitrary values included.
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        // D2 substituted the token for the colour literal; D3 removed this
        // variant's two dark-mode overrides (background and focus indicator).
        destructive:
          "bg-destructive text-destructive-foreground focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        /**
         * D1 — the one mandated project variant (§0.3.2). Appended last so the
         * registry's own entries stay contiguous and byte-identical above.
         *
         * THE CLASS FORM IS LOAD-BEARING AND WAS VERIFIED BY COMPILING, not by
         * reading documentation. Through this project's own Tailwind 4.3.3
         * pipeline against its own stylesheet, the parenthesised form below
         * emits `background-image: var(--gradient-event)` — correct — whereas
         * the tempting square-bracketed bare-variable shorthand emits
         * `background-color` instead. That shorthand is a SILENT failure: a
         * gradient is not a valid background-colour value, so the chip would
         * render with no background whatsoever and nothing would error. The
         * parenthesised form is also the convention `app/globals.css` documents
         * for tokens outside a Tailwind namespace, and `--gradient-event` is
         * deliberately declared in `:root` alone because a gradient generates no
         * colour utility for `@theme` to alias.
         *
         * The gradient itself is preserved stop for stop, angle included. It is
         * one of only two gradients in the legacy design and a distinctive part
         * of the visual field the brief asks to keep, so altering a stop or the
         * angle would be an unauthorised design change.
         *
         * THE FOREGROUND IS THE ONE THING THAT CHANGES, corrected on
         * measurement rather than taste. The legacy rule at
         * `resources/sass/elements.scss:69-72` forces the day numerals to pure
         * white with `!important`; sampling real pixels beside the glyphs gave
         * 1.30:1 to 1.83:1 against a 3:1 AA-large minimum. `--foreground` on
         * the same three stops measures 6.59:1, 5.91:1 and 8.27:1 — so every
         * stop clears AA for normal text, not merely for large text, which
         * matters because this chip is informative content rather than
         * decoration.
         *
         * No border entry is needed: the base already sets `border
         * border-transparent`, which is exactly what this variant wants.
         */
        "gradient-date": "bg-(image:--gradient-event) text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
