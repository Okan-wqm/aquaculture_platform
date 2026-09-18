/**
 * A spec never resolves through a build artifact (FE-HIGH-064).
 *
 * Every federation config aliases `@aquaculture/shared-ui` to
 * `web/shared-ui/dist` — the built barrel the `shared:` singleton contract is
 * pinned against. Under vitest that alias is wrong: `dist/` exists only after
 * shared-ui has been built, so a CI job that runs a module's suite without
 * building shared-ui first dies at import resolution — "Failed to resolve
 * import @aquaculture/shared-ui" on every spec that reaches the package,
 * before one assertion runs. It reports a build-ordering accident as a test
 * failure, and it passes locally for anyone who happens to have a stale
 * `dist/` on disk. tenant-admin's `test` job failed exactly this way while
 * seven other configs carried the same latent break.
 *
 * `resolveSharedUiAlias` owns the src/dist choice, and this invariant keeps it
 * the ONLY place that owns it: a config that re-spells either path fails here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { resolveSharedUiAlias } from '../../web/shared-ui/src/federation/sharedUiAlias';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEB_ROOT = resolve(REPO_ROOT, 'web');

/** The alias key whose target must never be spelled in a config. */
const GOVERNED_ALIAS = "'@aquaculture/shared-ui':";

/** Never descend into build output or installed deps. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.nx']);

function viteConfigs(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...viteConfigs(childAbs));
    } else if (entry.isFile() && entry.name === 'vite.config.ts') {
      out.push(childAbs);
    }
  }
  return out;
}

describe('INVARIANT: shared-ui resolves from source under test (FE-HIGH-064)', () => {
  const configs = viteConfigs(WEB_ROOT);

  it('finds the federation configs it is meant to govern', () => {
    // A walker that silently matched nothing would make every case below vacuous.
    expect(configs.length).toBeGreaterThanOrEqual(9);
  });

  it('routes every @aquaculture/shared-ui alias through the resolver', () => {
    const offenders: string[] = [];

    for (const configAbs of configs) {
      const source = readFileSync(configAbs, 'utf-8');
      // A config may call the resolver at the alias site or bind its result to
      // a local first; both say the value came from the resolver, which is the
      // rule. Only a value the config computed itself is a violation.
      const resolverBindings = new Set(
        [
          ...source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*resolveSharedUiAlias\(/g),
        ].map((match) => match[1]),
      );

      for (const line of source.split('\n')) {
        if (!line.includes(GOVERNED_ALIAS)) continue;
        const target = line.slice(line.indexOf(GOVERNED_ALIAS) + GOVERNED_ALIAS.length);
        const viaResolver =
          target.includes('resolveSharedUiAlias(') ||
          [...resolverBindings].some((name) => new RegExp(`\\b${name}\\b`).test(target));
        if (!viaResolver) {
          offenders.push(`${relative(REPO_ROOT, configAbs)}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('leaves no config spelling the built barrel for itself', () => {
    const offenders = configs
      .filter((configAbs) => readFileSync(configAbs, 'utf-8').includes('shared-ui/dist'))
      .map((configAbs) => relative(REPO_ROOT, configAbs));

    expect(offenders).toEqual([]);
  });

  it('sends test mode to source and every other mode to the built barrel', () => {
    const root = '/repo/web/shared-ui';

    expect(resolveSharedUiAlias(root, 'test')).toBe(`${root}/src`);
    for (const mode of ['development', 'production', 'staging', '']) {
      expect(resolveSharedUiAlias(root, mode)).toBe(`${root}/dist`);
    }
  });
});
