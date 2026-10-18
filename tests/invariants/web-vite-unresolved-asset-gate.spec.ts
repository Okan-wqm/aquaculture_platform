/**
 * INVARIANT (FE-MEDIUM-348): every federation build fails on a stylesheet
 * `url()` it would ship unresolved.
 *
 * # Why
 *
 * Vite leaves a `url()` it cannot resolve as written and only warns — "…
 * didn't resolve at build time, it will remain unchanged to be resolved at
 * runtime" — and the build passes. The console's workspace motifs shipped
 * that way: suderra.css named `./motifs/*.svg`, the shell's stylesheet
 * `@import`s it, Vite resolved the path against the shell's styles directory
 * and emitted nothing, and production requested `/assets/motifs/*.svg`, which
 * nginx 404s. The warning had scrolled past in every CI build.
 *
 * `unresolvedAssetUrlGate()` (web/shared-ui/src/federation/) turns that
 * warning into a build error; its spec builds a stylesheet with Vite to prove
 * it. This guard proves the shell and every remote mount it, by reading each
 * config's resolved `vite build` pipeline (the FE-HIGH-343 probe), so no
 * string in a config can claim a plugin the pipeline lacks.
 */
import { UNRESOLVED_ASSET_URL_GATE } from '../../web/shared-ui/src/federation/unresolvedAssetUrlGate';

import {
  FEDERATION_PLUGIN,
  federationViteConfigs,
  resolveViteAliases,
} from './lib/federation-vite-configs';

describe('INVARIANT (FE-MEDIUM-348): every federation build refuses an unresolved stylesheet url()', () => {
  const builds = resolveViteAliases(federationViteConfigs(), [
    { mode: 'production', command: 'build' },
  ]);

  it('resolves the shell and every remote as a federation build', () => {
    // A probe that resolved nothing, or no federation pipeline, would make the next case vacuous.
    expect(builds.length).toBeGreaterThanOrEqual(9);
    expect(builds.filter(({ plugins }) => !plugins.includes(FEDERATION_PLUGIN))).toEqual([]);
  });

  it('mounts the unresolved-asset-url gate in each of them', () => {
    const ungated = builds
      .filter(({ plugins }) => !plugins.includes(UNRESOLVED_ASSET_URL_GATE))
      .map(({ configFile }) => configFile);
    expect(ungated).toEqual([]);
  });
});
