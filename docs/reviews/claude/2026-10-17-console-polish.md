# Console polish (2026-10-17)

Owner decisions on how the tenant console looks and loads, implemented as code changes only: no
production container, database or droplet state was touched.

Owner: claude (implementation), okan (review and decisions).

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

## FE-MEDIUM-348

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-31.

### Symptom (FE-MEDIUM-348)

The workspace switcher at the top of the rail moves the console between Production,
Greenhouse, Control & sensors and Company. Only the accent ramp changed: the rail, the sticky
header and the page ground kept one neutral graphite and one engineering grid in every workspace
and in both themes. The owner's decision (Okan, 2026-10-17) is that the whole console takes on
the domain the user switched to.

### Root cause (FE-MEDIUM-348)

- The `[data-ws]` blocks in `web/shared-ui/src/styles/theme.css` re-assigned the accent ramps
  only. `sd-paper` (the page ground) and `sd-parchment` (the rail and the header, which paints
  it at 88% under a blur) had one value per theme, so no workspace could reach them.
- The ground in `web/shared-ui/src/styles/suderra.css` (`.sd-content::before`) was one
  grid-and-noise drawing for every workspace.
- The contrast gate's cascade model (`tests/invariants/lib/web-console-theme.ts`) modelled the
  Production workspace as the absence of `data-ws`. The shell sets `data-ws='aqua'`
  (`web/shell/src/console/shell/useFollowedWorkspace.ts:38`), so a ground re-assigned for aqua
  would have gone unmeasured.

### Fix (FE-MEDIUM-348)

- **Tints.** Each workspace block, light and dark, now also re-assigns `sd-paper`,
  `sd-parchment` and `sd-mint-paper` (the text on the solid accent, defined as the ground
  colour). Every tint keeps the neutral ground's OKLCH lightness, so only the hue moves:
  Production deep-sea teal-blue (hue 224), Greenhouse leaf green (148), Control & sensors
  industrial purple-grey (295), Company corporate navy-graphite (258, the least chroma). Aqua
  gets a block of its own carrying the ground only; its accent stays the default. With no
  workspace set (the SUPER_ADMIN console, the auth pages) the neutral graphite holds. The rail,
  the header, the page and every surface painted from these tokens follow without a component
  change.
- **Motifs.** `.sd-content::after` paints the workspace accent through a mask at
  `--sd-motif-opacity` (0.07 light, 0.09 dark; plain custom properties in theme.css beside the
  console shadows). It sits after the grid and under every child (z-index -1 in the column's
  stacking context), takes no pointer events, is fixed to the viewport and is not printed. The
  base rule sets no `content`; a box exists only under `[data-ws='aqua' | 'gh' | 'ctl']
.sd-content`, so Company, the SUPER_ADMIN console and the auth pages draw nothing.
  - Production: the login reef's fish (salmon, bass, bream, trout, mackerel, turbot, tuna and a
    baitfish school) on its three depth planes, generated from
    `web/shell/src/components/reef/art/*.svg`, so the console's reef is the login's reef and not
    a second drawing.
  - Greenhouse: two NFT channels with net pots, leaf sprigs and loose leaves (source
    `web/shared-ui/src/styles/motifs/gh.svg`).
  - Control & sensors: P&ID process lines with valves, a pump, a vessel and instrument bubbles,
    and circuit traces with pads, vias and a chip (source `motifs/ctl.svg`).
  - The drawings are inlined. `tools/design/generate-console-motifs.ts` writes each one as a
    `data:image/svg+xml` URI (`--sd-motif-<ws>`) with its tile size (`--sd-motif-<ws>-size`)
    into a generated block on the layer's rule in suderra.css; each workspace rule masks with
    `var(--sd-motif-<ws>)`. The drawings carry no colour (`currentColor` or no paint at all). A
    mask reads coverage only, so the motif follows the workspace and the theme with the tokens.
    Nothing animates.
- **Model.** The cascade model writes `data-ws` for every workspace, as the shell does, and
  gains `bare(theme)` (no workspace), an OKLCH reading and the motif rules.

### Detection (FE-MEDIUM-348)

- `tests/invariants/web-theme-token-parity.spec.ts` (FE-MEDIUM-348 block):
  - every workspace moves `sd-paper` and `sd-parchment` off the neutral ground and off every
    other workspace, in both themes;
  - each tint's hue lies in its domain's window, its chroma is perceptible but slight, and its
    lightness is the neutral ground's;
  - with no workspace the ground stays neutral, and `sd-mint-paper` stays the ground colour;
  - the motif opacity is at most 0.12;
  - every text token holds 4.5:1 and every icon token 3:1 on the ground under the motif and on
    the frosted header over it, in all four workspaces and both themes. The header share is
    read from `ConsoleHeader.tsx`, the motif colour from suderra.css.
    The existing FE-HIGH-321 rows resolve `sd-paper` and `sd-parchment` per workspace, so every
    pair they measure is measured on the tinted grounds too. The placement row holds the new
    tokens to one value wherever the theme and workspace attributes sit (dark islands included).
- `web/shared-ui/src/styles/__tests__/suderra-workspace-motif.spec.ts`: switching `data-ws` on
  `<html>` swaps the mask under the column (three distinct data URIs for aqua, gh and ctl, none
  for org). No workspace means no motif, and suderra.css names no file in any `url()`. The layer
  takes no input, sits at z-index -1, is fixed (and the column declares nothing that would make
  it a containing block for a fixed box), paints from the accent token at the motif opacity, has
  no animation or transition and is hidden in print. Each mask, decoded as a browser decodes it
  (`fetch` of the data URI) and parsed as an SVG image, is well-formed, colourless, static and
  tiled at its viewBox size.
- `tests/invariants/web-console-motif-generated.spec.ts`: the committed block equals the
  generator's output, every URI decodes to the drawing it was made from (the reef-derived tile,
  the gh and ctl sources), every species contributes, and the Production drawing keeps geometry
  only.
- `web/shell/src/console/shell/__tests__/useFollowedWorkspace.spec.tsx`: the first frame after
  entering the console, and after a move to another workspace, already carries the new `data-ws`.

### Independent review (FE-MEDIUM-348)

An independent review of the first version found:

- **HIGH: the motifs never loaded in the production build.** suderra.css named the drawings as
  files, `url('./motifs/*.svg')`. The shell's `styles/index.css` `@import`s suderra.css;
  `@tailwindcss/postcss` inlines it, and Vite then resolved the `url()` against
  `web/shell/src/styles/`, found nothing, and kept the reference as written with only a warning
  ("… didn't resolve at build time, it will remain unchanged to be resolved at runtime", Frontend
  Lighthouse run 39058917903). The built `/assets/bootstrap-*.css` asked for
  `/assets/motifs/*.svg`, which nginx (`try_files $uri =404`) does not have: the mask was
  transparent in every workspace. Fixed by the inlined data URIs above, and made a build error:
  `web/shared-ui/src/federation/unresolvedAssetUrlGate.ts` is a plugin whose build-only `config`
  hook wraps the logger Vite would use, so that warning throws while the stylesheet is
  transformed. The shell and all eight remotes mount it.
  `federation/__tests__/unresolvedAssetUrlGate.spec.ts` builds a stylesheet with Vite (without
  the gate the unresolved `url()` ships; with it the build fails naming the url and the file; an
  inlined drawing passes), and `tests/invariants/web-vite-unresolved-asset-gate.spec.ts` reads
  each federation config's resolved build pipeline and requires the plugin. With the gate and
  the old CSS, `vite build` of the shell failed on `./motifs/aqua.svg`; with the data URIs it
  passes with no such warning and no motif file in `dist/`.
- **LOW: one frame of the previous ground.** `useFollowedWorkspace` wrote `data-ws` from a
  passive effect, after the browser had painted the route change. It writes it from a layout
  effect now.
- **Comment check: "fixed to the viewport".** The column declares `container-type: inline-size`.
  That applies size and style containment, not layout containment, so the column is no
  containing block for a fixed box: measured in Chromium 149, a fixed child of such a column
  keeps the viewport's top and height at a 1000 px scroll offset, while `100cqw` resolves to the
  column's width. The comment was accurate; suderra.css now states the mechanism and the
  measurement.

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
