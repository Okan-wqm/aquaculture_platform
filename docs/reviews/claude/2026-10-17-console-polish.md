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
.sd-content`, so Company, the SUPER_ADMIN console and the auth pages draw and fetch nothing.
  - Production: `motifs/aqua.svg`, the login reef's fish (salmon, bass, bream, trout,
    mackerel, turbot, tuna and a baitfish school) on its three depth planes. It is generated
    from `web/shell/src/components/reef/art/*.svg` by `tools/design/generate-console-motifs.ts`,
    so the console's reef is the login's reef and not a second drawing.
  - Greenhouse: `motifs/gh.svg`, two NFT channels with net pots, leaf sprigs and loose leaves.
  - Control & sensors: `motifs/ctl.svg`, P&ID process lines with valves, a pump, a vessel and
    instrument bubbles, and circuit traces with pads, vias and a chip.
  - The files carry no colour (`currentColor` or no paint at all). A mask reads coverage only,
    so the motif follows the workspace and the theme with the tokens. Nothing animates.
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
  `<html>` swaps the motif under the column (aqua, gh, ctl, none for org). No workspace means no
  motif. The layer takes no input, sits at z-index -1, is fixed, paints from the accent token at
  the motif opacity, has no animation or transition and is hidden in print. Each motif file is
  colourless, static (no SMIL, script or style) and tiled at its viewBox size.
- `tests/invariants/web-console-motif-generated.spec.ts`: the committed Production motif equals
  the generator's output from the reef art, every species contributes, and the file keeps
  geometry only.
