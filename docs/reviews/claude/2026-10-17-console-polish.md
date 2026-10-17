# Console polish (2026-10-17)

Owner decisions on how the tenant console looks and loads, implemented as code changes only: no
production container, database or droplet state was touched.

Owner: claude (implementation), okan (review and decisions).

## FE-MEDIUM-349

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-31.

### Symptom (FE-MEDIUM-349)

A refresh or a sign-in showed up to four different loading screens one after another:

1. The `web/shell/index.html` boot splash: a sky-blue rounded square, a small spinner and
   "Aquaculture Platform", in hex typed into the file.
2. The shell's `PageLoading` ("Checking session...", in English, an extra-large spinner on
   gray-50), or on a sign-in page the auth layout's spinner.
3. `RemoteModuleLoader`: a pinging module icon, a spinner, "Loading Dashboard..." and "This may
   take a moment on first load", in English.
4. The remote's own fallback: grey text in farm, messaging and tenant-admin, a `Spinner` in
   sensor and hr, "Yukleniyor..." in the admin panel, a pulsing "Sekme yükleniyor…" on the batch
   tabs.

Messaging, hydroponics and dashboard also each carried a private copy of the session gate with
its own session text, or nothing at all. The owner's decision (Okan, 2026-10-17) is one
professional loader everywhere: the logo centred and turning slowly, "Loading…" or "Yükleniyor…"
beneath, and a boot splash that is the same visual, so the hand-off shows no swap.

### Root cause (FE-MEDIUM-349)

No component owned "the app is loading". Each layer that waited (the HTML before React, the
session check, the route chunk, the remote's page chunk) drew its own indicator. The boot splash
could not use the design system at all: it paints before any stylesheet loads, so its colours
were typed into the HTML and had drifted from the tokens.

### Fix (FE-MEDIUM-349)

- **One component.** `BrandLoader` in `web/shared-ui/src/components/Loading/`:
  - the brand mark (`BRAND.mark`, `/logo4-mark.png`) at 72 × 60, turning once every 1.8 s
    (linear, infinite), with "Loading…" or "Yükleniyor…" beneath (`brandLoader.loading`);
  - under `prefers-reduced-motion` the mark does not turn: it fades gently between 1 and 0.55
    opacity over 2.4 s;
  - `role="status"` with `aria-live="polite"`. The visible word is `aria-hidden` and a
    visually hidden label says what is loading (`brandLoader.label` by default, the session
    check for the guards and the session gates);
  - `variant="screen"` fills the viewport on the console ground, `region` (the default) fills
    the area it stands in.

  `PageLoading` and `RemoteModuleLoader` are deleted. `GuardLoading` renders the BrandLoader.
  `Spinner` stays the inline indicator for buttons and small blocks.

- **Everywhere it was a loading screen.** The BrandLoader now renders in:
  - the shell's session check and redirect, its eight route `Suspense` fallbacks, and the auth
    layout's session check;
  - every remote's route `Suspense` fallback: farm, messaging, tenant-admin, sensor, hr, the
    admin panel, and the batch detail tabs;
  - the tenant-admin guards.

  Messaging, hydroponics and dashboard drop their private session gates for the guard family's
  `RequireAuth`, which shows the same loader. Fallbacks that stand in for one widget (a SCADA
  widget skeleton, the code editor) are placeholders, not loading screens, and are unchanged.

- **The splash is the component.** `index.html`'s `#root` holds the BrandLoader's exact markup
  (screen variant, Turkish, as the document is `lang="tr"`). Its `<style>` is the loader's only
  stylesheet: every surface that shows a BrandLoader renders in the shell's document. Colours
  and face are the console tokens (`var(--color-sd-paper, …)`,
  `var(--color-sd-ink-muted, …)`, `var(--font-body-sd, …)`), read only under
  `:root[data-theme]`. Before the theme is resolved, and until the design system's CSS arrives,
  a copy of those tokens stands in. `tools/design/generate-boot-splash.ts` generates
  that copy from theme.css between BEGIN/END GENERATED sentinels, for the light theme, the dark
  theme by `data-theme` and, before the shell has resolved it, by the OS scheme. The same
  generator owns the `theme-color` meta (`--color-primary-500`), so no colour is typed into the
  file.
- **The turn carries over.** A CSS animation starts again on a new element, so the mark would
  snap back to its first angle when React replaces the splash. Just before the first render,
  `bootstrap.tsx` calls `holdBootSplashTurn(root)`, which reads the splash mark's animation start
  time. Every BrandLoader then starts its own turn at that time, so the new mark stands at the
  angle the old one had reached.
- The rail reads its logo from `BRAND.mark` too. The locale keys the old loaders used
  (`common.pageLoading`, `messaging.loadingModule`, `messaging.checkingSession`) are removed.
  The hardcoded-text ratchet ceilings fall with the strings: shell 141 → 136, farm 2606 → 2605,
  tenant-admin 503 → 501, hydroponics 190 → 189.

### Detection (FE-MEDIUM-349)

- `web/shell/src/__tests__/bootSplash.spec.tsx` checks the boot splash against the component:
  - it renders `<BrandLoader variant="screen" />` in Turkish and requires the splash in
    `index.html` to match element by element: tags, classes, role, `aria-live`, `aria-hidden`,
    `src`, `alt`, size and text;
  - it holds the stylesheet to the decision: one linear turn every 1.6 to 2 s, a reduced-motion
    fade with no transform, token colours with the generated fallback, an off-screen label and
    a zero body margin.

  A splash that loses `aria-hidden` on its text fails it. It also requires every rule that
  reads a console token to be scoped to `:root[data-theme]`, and it imports `main.tsx` with the
  bootstrap chunk mocked and a dark OS scheme: `data-theme` must already be `dark` when the
  bootstrap chunk is imported.

- `web/shared-ui/src/components/Loading/__tests__/BrandLoader.spec.tsx` covers the component:
  the status and its label, the visible word in both locales, the mark, both variants, the turn
  carried over from a held splash, the turn left alone without one (in a fresh module instance),
  and a held turn dropped once there is no splash to hold.
- `tests/invariants/web-brand-loader.spec.ts`:
  - `index.html` equals the generator's output from theme.css and spells no colour of its own;
  - every `Suspense` fallback in a file that declares routes is `<BrandLoader`, across the shell
    and every remote;
  - `RemoteModuleLoader` and `PageLoading` are gone;
  - `GuardLoading`, the shell's session check and the auth layout render the BrandLoader.

### Independent review (FE-MEDIUM-349)

An independent review of the first version found:

- **MEDIUM: a dark-OS user's splash went dark → light → dark.** The splash read
  `var(--color-sd-paper, var(--brand-loader-ground))` everywhere. Those tokens arrive with the
  bootstrap chunk's stylesheet in their light values, and `data-theme` was set only when the
  bootstrap chunk itself ran (`applyThemePreference` in `bootstrap.tsx`), after about 1.2 MB of
  JS. Between the two, the generated dark copy lost to the light tokens. Two changes, each
  closing it alone:
  - `web/shell/src/main.tsx` applies the stored preference (`applyThemePreference`,
    `followSystemThemePreference`, `getStoredThemePreference` from `utils/theme.ts`, which stays
    the one owner) before `import('./bootstrap')`, the import that requests the stylesheet.
    `bootstrap.tsx` no longer applies it. No inline script, so the CSP is unchanged.
  - `web/shell/index.html` reads the console tokens only under `:root[data-theme]`. Before the
    theme is resolved, only the generated copy paints the loader, whatever has loaded.
- **LOW: the "without a splash" BrandLoader test depended on module state.** `bootSplashTurn.ts`
  keeps the held turn in module scope, so the case passed or failed by what earlier cases left.
  It now renders from a fresh module instance (`vi.resetModules`). A new case holds a splash's
  turn itself, then holds again with no splash, and requires the turn to be dropped. Making
  `holdBootSplashTurn` keep a stale turn fails that case.

## FE-LOW-350

**State:** OPEN. Owner: claude (implementation), okan (decision on the security header).
Deadline 2026-10-31.

### Symptom (FE-LOW-350)

The boot splash paints before the user's stored theme and language are known. Suppose the
stored theme differs from the OS colour scheme, or the stored or browser language is not the
document's static `tr`. That user sees the splash in the default theme and language until the
React hand-off applies theirs. FE-MEDIUM-349 makes the hand-off itself seamless, because the
splash and the BrandLoader share markup and stylesheet. This first-paint difference remains.
For the theme it now lasts until the shell's entry module runs, before the bootstrap chunk is
requested, rather than until the bootstrap chunk has loaded.

### Root cause (FE-LOW-350)

Applying a stored preference before first paint needs a script that runs before the body is
painted. The meta CSP in `web/shell/index.html` and the edge CSP
(`infrastructure/docker/nginx/nginx.prod.conf:147`) allow `script-src 'self'` only: no inline
script and no hash. The shell applies the theme when its entry module runs
(`web/shell/src/main.tsx`, before it imports the bootstrap chunk), and the language when React
mounts (`web/shared-ui/src/i18n/I18nProvider.tsx:98-100`). The entry module is an external
module script, which the browser may run after it has painted the body.

### Why it is not in the FE-MEDIUM-349 change (FE-LOW-350)

Each fix changes the edge security headers or adds a render-blocking request, which is the
owner's decision.

- An inline boot script that applies `getStoredThemePreference` and `resolveInitialLocale`
  before the body paints, allowed by a `sha256` hash in the meta CSP and in both edge CSPs
  (`nginx.prod.conf`, `infrastructure/nginx/droplet.conf`). An invariant would hold the hashes
  to the script.
- An external `/boot-preferences.js` with its own no-cache location in
  `infrastructure/docker/nginx/shell.conf`, since every `.js` there is cached immutable for a
  year. It costs one render-blocking revalidation per load.

Either one needs a parity test against `web/shell/src/utils/theme.ts` and
`web/shared-ui/src/i18n/localePreference.ts`, so the boot script cannot drift from them.
