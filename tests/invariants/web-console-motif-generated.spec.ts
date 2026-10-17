/**
 * INVARIANT (FE-MEDIUM-348): the Production workspace's motif is the login
 * reef's own fish.
 *
 * # Why
 *
 * The tenant console draws a static motif of each workspace's domain behind
 * its pages (suderra.css, `[data-ws] .sd-content::after`). Production's is
 * the reef fish of the login scene — salmon, sea bass, bream, trout,
 * mackerel, turbot, tuna and the baitfish school — whose artwork lives once,
 * in `web/shell/src/components/reef/art/*.svg`. A hand-copied silhouette
 * file would be a second drawing of the same fish that drifts the first time
 * an artist touches one. So `tools/design/generate-console-motifs.ts`
 * derives the motif from the art (every filled shape, colour dropped: a mask
 * reads only coverage) and this guard regenerates and diffs, the
 * convention `edge-theme-generated.spec.ts` set for the edge page.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AQUA_MOTIF_PATH,
  MOTIF_SPECIES,
  REEF_ART_DIR,
  renderAquaMotif,
  silhouette,
} from '../../tools/design/generate-console-motifs';

import { workspaceMotifs } from './lib/web-console-theme';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT (FE-MEDIUM-348): the Production motif is generated from the reef art', () => {
  it('the committed motif matches the generator', () => {
    expect(read(AQUA_MOTIF_PATH)).toBe(renderAquaMotif());
  });

  it('suderra.css draws it for the Production workspace', () => {
    const file = workspaceMotifs().get('aqua');
    expect(file).toBeDefined();
    expect(resolve(REPO_ROOT, 'web/shared-ui/src/styles', file ?? '')).toBe(
      resolve(REPO_ROOT, AQUA_MOTIF_PATH),
    );
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

  it('the silhouette keeps geometry only: no colour, gradient reference or class', () => {
    const motif = read(AQUA_MOTIF_PATH);
    expect(motif).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|url\(|class=|style=|stroke=/);
  });
});
