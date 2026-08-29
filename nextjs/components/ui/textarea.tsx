/**
 * `Textarea` — the multi-line plain-text control for the whole application.
 *
 * One of the 38 registry-generated files among the 43 in `components/ui/`
 * (§0.3.5). Produced by `shadcn@4.19.0 add textarea` against the committed
 * `components.json` (style `new-york`, `baseColor` stone, `cssVariables` true),
 * after `shadcn@4.19.0 view textarea` confirmed registry membership as §0.3.1
 * requires. That verification also settled the manifest question: the registry
 * item declares no `dependencies`, no `registryDependencies` and no `cssVars`,
 * so nothing was added to `package.json` and nothing was changed in
 * `app/globals.css` — one file, and this is it.
 *
 * ## What this control is for, and what it must never be used for
 *
 * Plain multi-line text ONLY. The columns it serves are the plain-text ones in
 * §0.4.2 — `pages.description`, `pages.short_description`, `pages.intro`,
 * `pages.welcome_line`, `events.short_description`, `events.location`,
 * `classrooms.description`, `promoted.summary`, `people.official_title`,
 * `site_globals.maintenance_message` and every `seo_description`.
 *
 * It is NOT the rich-text surface. Bard-derived fields are ProseMirror
 * documents and belong to `components/cms/EditableRichText.tsx` on Tiptap 3,
 * whose node and mark set is derived from the server-side allowlist in
 * `lib/richtext-validate.ts` so the toolbar and the validator cannot drift. A
 * textarea holds a string; it cannot represent a `doc` node tree, so binding
 * one to a Bard field would flatten structure the corpus actually contains —
 * 265 `paragraph`, 38 `heading`, 28 `listItem`, 40 `link` marks and all 50
 * table-family nodes, the last of which are the tuition fee schedule.
 *
 * ## No length cap by default — deliberate, and the trap in this file
 *
 * Statamic's `character_limit` is a soft editor hint, not a stored constraint,
 * which is exactly why the live content violates it. Measured in the source
 * blueprints and entries: `programsumbrella.short_description` declares
 * `character_limit: '300'` while three of the four umbrella description values
 * run 675, 533 and 301 characters; all four `announcements.title` values run
 * 44–69 characters against `character_limit: 30`; and
 * `events.short_description` declares 500 the same way.
 *
 * §0.4.2 therefore GRANDFATHERS those values: the limits live in
 * `lib/schema.ts` and in the editor's character counter, the write functions
 * enforce them on any create or edit, the seed load is exempt, and each
 * over-length row is listed in `artifacts/parity-report.json` "for the school
 * to shorten at leisure". Reproducing `character_limit` here as a hard HTML
 * length attribute would convert a decade of soft guidance into a hard data
 * barrier at the precise moment the school gains the ability to edit — a
 * 675-character description would open in a control that refuses to hold it.
 * So this component sets no length attribute and no row count of its own; a
 * caller that genuinely needs either passes it explicitly, and the counter that
 * warns is the editor's job, not this control's. Truncation is never correct
 * here.
 *
 * ## Props: everything native, nothing swallowed
 *
 * `React.ComponentProps<"textarea">` is spread onto the element, so `value`,
 * `defaultValue`, `onChange`, `onBlur`, `rows`, `disabled`, `required`,
 * `maxLength`, `placeholder`, `name`, `id`, `aria-describedby`, `aria-invalid`
 * and every data attribute reach the DOM unchanged. `className` is the one prop
 * intercepted, and only so `cn()` can merge it — a caller's class wins over the
 * defaults below because `tailwind-merge` resolves conflicts last-wins.
 *
 * In React 19 `ref` is an ordinary prop of an intrinsic element, so the spread
 * forwards it to the underlying `HTMLTextAreaElement` and no `forwardRef`
 * wrapper is needed. `hooks/use-editable-field.ts` relies on that to focus the
 * control and to read its live value.
 *
 * `onKeyDown` is explicitly NOT intercepted. §0.4.5 maps Escape to
 * revert-and-exit for every editable field and `hooks/use-editable-field.ts`
 * owns that handler; a keydown handler here would sit in front of it and eat
 * the one key the edit model depends on.
 *
 * This file carries no `"use client"` directive, exactly as the registry emits
 * it. The element is stateless, so it renders in a Server Component as happily
 * as inside the client-only editor bundle; adding the directive would drag
 * every consumer's subtree across the boundary for no reason.
 *
 * ## Two documented divergences from the registry output
 *
 * §0.3.5 deliberately exempts generated registry internals from the
 * "zero hardcoded values" rule, so the content-driven field sizing, the minimum
 * height, the extra-small shadow, the 3px focus ring width and the
 * two-property animation list are left exactly as generated —
 * `audit-tokens.mjs` inventories
 * non-colour arbitrary values in generated files rather than failing them, and
 * rewriting them would turn the next `shadcn add` into a merge conflict. The
 * two changes below are the only ones, flagged inline at the call site:
 *
 *   1. TYPOGRAPHY. The registry sizes its text 1rem, dropping to 0.875rem from
 *      the 768px breakpoint. §0.3.3 assigns all prose `--text-body` —
 *      1.0625rem / 1.6 / 0.02em, "preserved exactly" from the legacy 17px, the
 *      one typographic decision the current site gets right. This control edits
 *      that prose in place, over the very paragraph a visitor reads, so a
 *      different size here would reflow the text the moment an editor clicked
 *      into it. The utility used below exists because `--text-body` and its
 *      line-height and letter-spacing companions are declared in the
 *      `@theme static` block of `app/globals.css`; no new token is introduced.
 *   2. COLOUR MODE. The registry emits two dark-variant utilities: a field
 *      background at 30% of `--input`, and an invalid-state ring at 40% of
 *      `--destructive`. §0.3.3 ships ONE light theme — `globals.css` has no
 *      `.dark` block and `next-themes` is not a dependency. Because
 *      `shadcn/tailwind.css` declares no custom dark variant, that variant
 *      resolves against Tailwind's built-in one, which is the
 *      `prefers-color-scheme` media query, so those utilities would NOT be
 *      inert: every visitor whose device is in dark mode would get a filled
 *      field on a white page, a second appearance nobody designed and no test
 *      covers. Both are removed, and no dark-mode variant is authored in their
 *      place.
 *
 * Both divergences are visible in a diff against `shadcn view textarea`, which
 * is the point of recording them here: a future regeneration should re-apply
 * them rather than read them as drift.
 *
 * A related trap, recorded because it cost real bytes to find: Tailwind's
 * source scanner extracts candidate utilities from every text file it walks,
 * comments included, and it does not know a comment from markup. An earlier
 * draft of this header quoted the two removed dark-variant class names and the
 * registry's responsive size pair verbatim; compiling `app/globals.css` proved
 * that prose alone added 863 bytes of dead CSS and reintroduced a
 * `prefers-color-scheme` block into the shipped stylesheet — the very thing
 * item 2 removes. Hence the descriptive phrasing above. Documentation in this
 * tree must not spell out a utility the component does not itself use.
 *
 * ## What this file deliberately does not do
 *
 * No label, no description, no error text and no character counter. Those are
 * `Field`, `FieldLabel`, `FieldDescription` and `FieldError` from
 * `components/ui/field.tsx`, which own the `aria-describedby` wiring; this
 * control only has to let the resulting attribute through, and it does.
 */

import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        /* Generated by `shadcn@4.19.0 add textarea`. Two divergences, both
           explained in this file's header:
           BLITZY [TYPOGRAPHY]: text sized with the --text-body token per §0.3.3,
           overriding the registry's own responsive size pair.
           BLITZY [COLOUR_MODE]: the registry's two dark-variant utilities are
           removed — one light theme ships (§0.3.3) and that variant binds to
           the prefers-color-scheme media query here.
           Everything else is unmodified registry output, which §0.3.5 exempts
           by design. */
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-body shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
