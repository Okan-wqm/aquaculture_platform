# Console polish (2026-10-17)

Owner decisions on how the tenant console looks and loads, implemented as code changes only: no
production container, database or droplet state was touched.

Owner: claude (implementation), okan (review and decisions).

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
