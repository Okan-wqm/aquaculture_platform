/**
 * INVARIANT (FE-MEDIUM-348): the console's workspace motifs are generated
 * into suderra.css, and Production's is the login reef's own fish.
 *
 * # Why
 *
 * The tenant console draws a static motif of each workspace's domain behind
 * its pages (suderra.css, `[data-ws] .sd-content::after`). Production's is
 * the reef fish of the login scene — salmon, sea bass, bream, trout,
 * mackerel, turbot, tuna and the baitfish school — whose artwork lives once,
 * in `web/shell/src/components/reef/art/*.svg`. A hand-copied silhouette
 * file would be a second drawing of the same fish that drifts the first time
 * an artist touches one. Greenhouse and Control & sensors are hand-drawn
 * sources in `web/shared-ui/src/styles/motifs/`.
 *
 * The drawings first shipped as files the stylesheet named with `url()`.
 * Vite resolved those against the shell's stylesheet, which `@import`s
 * suderra.css, emitted nothing and left the reference as written; production
 * requested `/assets/motifs/*.svg`, nginx answered 404 and the mask stayed
 * transparent. So `tools/design/generate-console-motifs.ts` inlines every
 * drawing as a data URI between BEGIN/END GENERATED sentinels on the motif
 * layer, and this guard regenerates and diffs — the convention
 * `edge-theme-generated.spec.ts` set for the edge page — and decodes each URI
 * the way a browser does (`fetch` runs the WHATWG data-URL processor) to
 * prove it carries the drawing it was made from.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MOTIF_BLOCK_BEGIN,
  MOTIF_BLOCK_END,
  MOTIF_SPECIES,
  MOTIF_WORKSPACES,
  REEF_ART_DIR,
  SUDERRA_CSS_PATH,
  renderMotifBlock,
  renderMotifs,
  silhouette,
} from '../../tools/design/generate-console-motifs';

import { workspaceMotifs } from './lib/web-console-theme';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** The committed block, sentinels included. */
function committedBlock(): string {
  const css = read(SUDERRA_CSS_PATH);
  const begin = css.indexOf(MOTIF_BLOCK_BEGIN);
  const end = css.indexOf(MOTIF_BLOCK_END);
  if (begin === -1 || end < begin) throw new Error(`${SUDERRA_CSS_PATH} has no motif block`);
  return css.slice(begin, end + MOTIF_BLOCK_END.length);
}

/** The body a browser decodes from a data URI, and its media type. */
async function decode(uri: string): Promise<{ type: string; svg: string }> {
  const response = await fetch(uri);
  return { type: response.headers.get('content-type') ?? '', svg: await response.text() };
}

/** An SVG's markup with the differences a data URI may make undone: comments, whitespace, quotes. */
function markup(svg: string): string {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/"/g, "'")
    .trim();
}

describe('INVARIANT (FE-MEDIUM-348): the workspace motifs are generated into suderra.css', () => {
  const drawings = renderMotifs();

  it('the committed block matches the generator', () => {
    expect(committedBlock()).toBe(renderMotifBlock(drawings));
  });

  it('suderra.css masks each motif workspace with its own drawing, decoded as a browser does', async () => {
    const motifs = workspaceMotifs();
    expect([...motifs.keys()].sort()).toEqual([...MOTIF_WORKSPACES].sort());
    for (const ws of MOTIF_WORKSPACES) {
      const { type, svg } = await decode(motifs.get(ws) ?? '');
      expect({ ws, type }).toEqual({ ws, type: 'image/svg+xml' });
      expect({ ws, svg: markup(svg) }).toEqual({ ws, svg: markup(drawings[ws]) });
    }
  });

  it('every species of the reef contributes a silhouette', () => {
    // Not vacuous: a parse slip that dropped a species' shapes would still diff clean.
    for (const species of MOTIF_SPECIES) {
      const art = read(`${REEF_ART_DIR}/${species}.svg`);
      expect({ species, shapes: silhouette(art).shapes.length > 0 }).toEqual({
        species,
        shapes: true,
      });
    }
  });

  it('the Production drawing keeps geometry only: no colour, gradient reference or class', async () => {
    const { svg } = await decode(workspaceMotifs().get('aqua') ?? '');
    expect(svg).toMatch(/^<svg /);
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|url\(|class=|style=|stroke=/);
  });
});
