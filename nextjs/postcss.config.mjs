/**
 * PostCSS configuration for the Cambridge-Ellis School Next.js application.
 *
 * The Tailwind CSS v4 plugin is the only entry, by design. The v4 engine
 * resolves stylesheet imports and applies vendor prefixes itself, and Next
 * minifies CSS in production builds, so no companion plugin is required here
 * and none should be added.
 *
 * Styling is configured in CSS rather than in JavaScript. The design tokens —
 * the `:root` semantic values, the `@theme inline` alias layer and the
 * namespaced scales — live in `app/globals.css`, which is also where the
 * shadcn/ui stylesheet is imported. This project ships no JavaScript Tailwind
 * config file, so no key beyond `plugins` is meaningful in this module.
 *
 * The `.mjs` extension declares the module system explicitly. `package.json`
 * does not set `"type": "module"`, so the extension — rather than a package
 * field or a loader's syntax-detection fallback — is what makes `export
 * default` unambiguously correct here. Keep it.
 */
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
