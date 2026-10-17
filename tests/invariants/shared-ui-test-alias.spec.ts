/**
 * A spec never resolves through a build artifact (FE-HIGH-064), and a build
 * never aliases shared-ui at all (FE-HIGH-343).
 *
 * Under vitest no federation runtime exists, so specs alias
 * `@aquaculture/shared-ui` to `web/shared-ui/src`, which is always present in a
 * checkout. `dist/` exists only after shared-ui has been built, so a spec that
 * resolved through it died at import resolution — "Failed to resolve import
 * @aquaculture/shared-ui" — whenever CI ran a module's suite before building
 * shared-ui. tenant-admin's `test` job failed exactly this way.
 *
 * Every other mode must NOT alias the package. Vite's alias plugin runs before
 * every user plugin, so an alias hands `@module-federation/vite` a file path
 * instead of the shared specifier and the import bypasses `loadShare`: each
 * bundle carries its own shared-ui and its own React contexts. The bare
 * specifier resolves through the workspace package's `exports` to the same
 * `dist/index.mjs` the alias used to name.
 *
 * `sharedUiAlias` owns that decision and every config spreads it, so this
 * invariant fails a config that spells the alias key or the built barrel for
 * itself. web-shared-ui-singleton-imports.spec.ts proves the non-test modes
 * shadow no federation-shared specifier.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sharedUiAlias } from '../../web/shared-ui/src/federation/sharedUiAlias';
import { REPO_ROOT, federationViteConfigs, webViteConfigs } from './lib/federation-vite-configs';

/** The alias key whose entry must only come from the resolver. */
const GOVERNED_ALIAS = "'@aquaculture/shared-ui':";

/** How a config applies the resolver to its `resolve.alias` object. */
const RESOLVER_SPREAD = '...sharedUiAlias(';

function readConfig(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf-8');
}

describe('INVARIANT: shared-ui resolves from source under test and is never aliased in a build', () => {
  const configs = webViteConfigs();
  const federationConfigs = federationViteConfigs();

  it('finds the federation configs it is meant to govern', () => {
    // A walker that silently matched nothing would make every case below vacuous.
    expect(configs.length).toBeGreaterThanOrEqual(9);
    expect(federationConfigs.length).toBeGreaterThanOrEqual(9);
  });

  it('leaves no config spelling the @aquaculture/shared-ui alias key for itself', () => {
    const offenders = configs.flatMap((file) =>
      readConfig(file)
        .split('\n')
        .filter((line) => line.includes(GOVERNED_ALIAS) && !/^\s*(\/\/|\*)/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );

    expect(offenders).toEqual([]);
  });

  it('spreads the resolver into every federation config, so specs still reach source', () => {
    const offenders = federationConfigs.filter(
      (file) => !readConfig(file).includes(RESOLVER_SPREAD),
    );

    expect(offenders).toEqual([]);
  });

  it('leaves no config spelling the built barrel for itself', () => {
    const offenders = configs.filter((file) => readConfig(file).includes('shared-ui/dist'));

    expect(offenders).toEqual([]);
  });

  it('sends test mode to source', () => {
    const root = '/repo/web/shared-ui';

    // The other modes are web-shared-ui-singleton-imports.spec.ts's to prove.
    expect(sharedUiAlias(root, 'test')).toEqual({ '@aquaculture/shared-ui': `${root}/src` });
  });
});
