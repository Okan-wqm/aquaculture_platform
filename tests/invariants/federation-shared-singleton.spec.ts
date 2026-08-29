/**
 * Federation shared-singleton rails (C0 / FE-HIGH-005).
 *
 * Module Federation's singleton discipline lives in ONE file:
 * `web/shared-ui/src/federation/federationSharedConfig.ts` (the SSoT).
 * Before these rails existed, tenant-admin's vite config spread the SSoT
 * and then OVERRODE four core deps with strictVersion-less caret ranges
 * (plus a duplicate `lucide-react` key pinning `'^18.2.0'`), and dashboard
 * carried an inline `recharts` literal — the exact drift class that
 * produces two React instances at runtime (FE-HIGH-004).
 *
 * What this spec makes impossible to reintroduce:
 *   1. Non-exact pins inside SHARED_VERSIONS (the SSoT itself drifting).
 *   2. A federation vite config that does not consume the SSoT.
 *   3. Inline shared-entry literals (`requiredVersion:`/`singleton:`)
 *      anywhere outside the SSoT file — the override class.
 *   4. Lockfile resolution drift: every CORE singleton package must
 *      resolve to exactly ONE version repo-wide, equal to the SSoT pin.
 *   5. Silent bundler swap: the federation plugin import is pinned by an
 *      explicit expectation flag (C1 flips it when @originjs is replaced
 *      by @module-federation/vite — making the migration a one-line,
 *      reviewed flip instead of an unnoticed drift).
 *
 * Runtime browser proof (single React instance inside a loaded remote) is
 * NOT coverable here — the Playwright harness targets the gateway HTTP
 * surface only (e2e/playwright.config.ts). The runtime probe lands with
 * the C1 federation-plugin migration's staging validation (tracked in
 * docs/reviews/frontend-expert/2026-06-11-federation-invariant-rails.md
 * under FE-HIGH-005).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const SSOT_PATH = 'web/shared-ui/src/federation/federationSharedConfig.ts';

/**
 * C1 migration flag: while true, every federation vite config must import
 * @originjs/vite-plugin-federation (the current, working plugin). The C1
 * wave (plugin migration to @module-federation/vite) flips this to false,
 * which turns the SAME assertion into a ban on the abandoned plugin.
 *
 * C1 PR-1a (2026-06-13): flipped to false — every federation vite config now
 * imports `{ federation }` from @module-federation/vite; @originjs is banned.
 */
const ORIGINJS_PLUGIN_EXPECTED = false;

/**
 * Packages whose lockfile resolution must be a SINGLE version repo-wide,
 * equal to the SSoT pin. These are the federated core singletons — a
 * second resolved version is a latent dual-instance bug.
 *
 * C1-1b (2026-06-14): lucide-react + recharts GRADUATED here from the weaker
 * pin-must-exist set. The version-alignment wave unified admin-panel's
 * lucide-react 0.294.0 onto 0.469.0 and folded dashboard/tenant-admin's
 * inline recharts/lucide literals into the SSoT, so both now resolve to a
 * single version repo-wide. Graduating them turns that achievement into an
 * enforced rail: a future change reintroducing a second lucide/recharts
 * version now fails CI instead of silently regressing (FE-HIGH-005).
 */
const SINGLE_VERSION_PACKAGES = [
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  '@tanstack/react-query',
  'zustand',
  '@xyflow/react',
  'lucide-react',
  'recharts',
] as const;

function gitLsFiles(globs: readonly string[]): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...globs], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function readRepoFile(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
}

/** Parse SHARED_VERSIONS entries out of the SSoT source text. */
function parseSharedVersions(): Map<string, string> {
  const text = readRepoFile(SSOT_PATH);
  const block = text.match(/export const SHARED_VERSIONS = \{([\s\S]*?)\} as const;/)?.[1];
  expect(block).toBeDefined();
  const entries = new Map<string, string>();
  for (const m of (block as string).matchAll(/^\s*'?([@\w/-]+)'?:\s*'([^']+)'/gm)) {
    entries.set(m[1] as string, m[2] as string);
  }
  expect(entries.size).toBeGreaterThanOrEqual(7);
  return entries;
}

/** All vite configs that participate in Module Federation. */
function federationViteConfigs(): readonly string[] {
  return gitLsFiles(['web/shell/vite.config.ts', 'web/modules/*/vite.config.ts']).filter((f) =>
    readRepoFile(f).includes('federation('),
  );
}

interface LockPackageInfo {
  version?: string;
}

function lockfileVersions(pkg: string): readonly string[] {
  const lock = JSON.parse(readRepoFile('package-lock.json')) as {
    packages?: Record<string, LockPackageInfo>;
  };
  const versions = new Set<string>();
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if ((path === `node_modules/${pkg}` || path.endsWith(`/node_modules/${pkg}`)) && info.version) {
      versions.add(info.version);
    }
  }
  return [...versions].sort();
}

describe('federation shared-singleton rails (FE-HIGH-005)', () => {
  test('SHARED_VERSIONS pins are exact semver (no ranges in the SSoT)', () => {
    for (const [pkg, version] of parseSharedVersions()) {
      expect({ pkg, version }).toEqual({
        pkg,
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      });
    }
  });

  test('every federation vite config consumes the SSoT', () => {
    const configs = federationViteConfigs();
    // Shell + 7 remotes today; a NEW remote that forgets the SSoT fails here.
    expect(configs.length).toBeGreaterThanOrEqual(8);
    for (const file of configs) {
      const text = readRepoFile(file);
      expect({ file, importsSsot: text.includes('federationSharedConfig') }).toEqual({
        file,
        importsSsot: true,
      });
    }
  });

  test('no inline shared-entry literals outside the SSoT (the override class)', () => {
    for (const file of federationViteConfigs()) {
      // Strip comments first — config docblocks legitimately NAME the keys
      // ("strictVersion:true enforced on ALL entries") without declaring
      // them. Only code-position keys are the override class.
      const text = readRepoFile(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const offending = [...text.matchAll(/requiredVersion\s*:|singleton\s*:|strictVersion\s*:/g)];
      expect({ file, inlineSharedEntryKeys: offending.length }).toEqual({
        file,
        inlineSharedEntryKeys: 0,
      });
    }
  });

  test('core singleton packages resolve to exactly one version == SSoT pin', () => {
    const ssot = parseSharedVersions();
    for (const pkg of SINGLE_VERSION_PACKAGES) {
      const pin = ssot.get(pkg);
      expect({ pkg, pinned: pin !== undefined }).toEqual({ pkg, pinned: true });
      expect({ pkg, lockfileVersions: lockfileVersions(pkg) }).toEqual({
        pkg,
        lockfileVersions: [pin],
      });
    }
  });

  test('shell + remote package.json declarations are satisfied by the SSoT pins', () => {
    const ssot = parseSharedVersions();
    const manifests = gitLsFiles(['web/shell/package.json', 'web/modules/*/package.json']);
    expect(manifests.length).toBeGreaterThanOrEqual(8);
    for (const file of manifests) {
      const pkg = JSON.parse(readRepoFile(file)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, pin] of ssot) {
        const declared = deps[name];
        if (!declared) continue; // module does not use this dep — fine
        // Workspace-protocol declarations (file:/link:/workspace:) point at
        // the in-repo source — the package IS the SSoT, no range to check.
        if (/^(file|link|workspace):/.test(declared)) continue;
        // C1-1b: lucide-react + recharts are now full SINGLE_VERSION packages
        // (see SINGLE_VERSION_PACKAGES above) and go through the same
        // satisfied-by-SSoT-pin check as every other singleton — no special
        // staged-alignment branch or admin-panel exemption remains.
        const base = declared.replace(/^[\^~]/, '');
        const satisfied =
          declared === pin ||
          (declared.startsWith('^') &&
            pin.split('.')[0] === base.split('.')[0] &&
            comparable(pin) >= comparable(base)) ||
          (declared.startsWith('~') &&
            pin.split('.').slice(0, 2).join('.') === base.split('.').slice(0, 2).join('.') &&
            comparable(pin) >= comparable(base));
        expect({ file, name, declared, satisfiedBySsotPin: satisfied }).toEqual({
          file,
          name,
          declared,
          satisfiedBySsotPin: true,
        });
      }
    }
  });

  test(`federation plugin expectation flag (${ORIGINJS_PLUGIN_EXPECTED ? '@originjs current' : '@originjs banned'})`, () => {
    for (const file of federationViteConfigs()) {
      const usesOriginjs = readRepoFile(file).includes('@originjs/vite-plugin-federation');
      expect({ file, usesOriginjs }).toEqual({ file, usesOriginjs: ORIGINJS_PLUGIN_EXPECTED });
    }
  });
});

/** Numeric comparison key for x.y.z (sufficient for exact semver pins). */
function comparable(version: string): number {
  const [a = 0, b = 0, c = 0] = version.split('.').map(Number);
  return a * 1_000_000 + b * 1_000 + c;
}
