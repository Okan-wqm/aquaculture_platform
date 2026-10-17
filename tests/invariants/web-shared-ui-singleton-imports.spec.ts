/**
 * Invariant: federated web runtime code must consume shared-ui through the
 * public `@aquaculture/shared-ui` package entrypoint, and that entrypoint must
 * reach the Module Federation share scope in every federation build.
 *
 * Module Federation relies on that package specifier as the singleton identity
 * for React contexts. Two paths create a second module identity in production
 * bundles, and both end in the same Provider/Hook split: AuthProvider or
 * TenantProvider exists, but a remote or shell hook reads a different context
 * instance and throws at runtime.
 *
 *   1. A deep source import such as `../../../shared-ui/src/...` in runtime code.
 *   2. A `resolve.alias` entry in a federation vite config that rewrites a
 *      federation-shared specifier to a file path. Vite's alias plugin runs
 *      before every user plugin, so `@module-federation/vite` receives the path,
 *      not the package name, and never routes the import through `loadShare`.
 *      The remote then imports its own bundled copy directly. That is how the
 *      dashboard remote rendered "useTenantContext must be used within a
 *      TenantProvider" under the shell's TenantProvider (FE-HIGH-343): shell and
 *      all eight remotes aliased `@aquaculture/shared-ui` to `web/shared-ui/dist`
 *      in every mode, so each bundle carried a private shared-ui.
 *
 * Path 2 is checked against the alias table Vite resolves for each config
 * (lib/federation-vite-configs.ts), not against the config text: a text scan
 * of sensor-module's config read none of its aliases.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { SHARED_VERSIONS } from '../../web/shared-ui/src/federation/federationSharedConfig';
import {
  SHARED_UI_PACKAGE,
  SHARED_UI_TEST_MODE,
  sharedUiAlias,
} from '../../web/shared-ui/src/federation/sharedUiAlias';
import {
  FEDERATION_PLUGIN,
  type ProbeTarget,
  aliasShadows,
  describeFind,
  federationViteConfigs,
  resolveViteAliases,
  webViteConfigs,
} from './lib/federation-vite-configs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEB_RUNTIME_GLOBS = [
  'web/shell/src/**/*.ts',
  'web/shell/src/**/*.tsx',
  'web/modules/*/src/**/*.ts',
  'web/modules/*/src/**/*.tsx',
] as const;

const EXEMPT_PATH_PATTERNS = [
  /__tests__\//,
  /\.spec\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.ts$/,
  /\.test\.tsx$/,
  /\.d\.ts$/,
] as const;

/** Every specifier the federation SSoT shares as a singleton. */
const FEDERATION_SHARED_KEYS: readonly string[] = Object.keys(SHARED_VERSIONS);

interface Hit {
  file: string;
  line: number;
  specifier: string;
}

function gitLsFiles(globs: readonly string[]): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...globs], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function listRuntimeFiles(): readonly string[] {
  return gitLsFiles(WEB_RUNTIME_GLOBS).filter(
    (file) => !EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(file)),
  );
}

/**
 * Static import/export statements, matched over the whole file so a
 * multi-line `import {\n  A,\n} from '...'` is seen as one statement.
 */
const IMPORT_SPECIFIER_RE =
  /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function scanFile(file: string): readonly Hit[] {
  const content = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const hits: Hit[] = [];

  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? '';
    if (specifier.includes('shared-ui/src/')) {
      const statementStart = (match.index ?? 0) + match[0].search(/\S/);
      hits.push({ file, line: lineOf(content, statementStart), specifier });
    }
  }

  return hits;
}

describe('INVARIANT: federated web runtime imports shared-ui through one singleton package identity', () => {
  const hits = listRuntimeFiles().flatMap((file) => [...scanFile(file)]);

  it('does not deep-import shared-ui source files from shell or remote modules', () => {
    if (hits.length > 0) {
      const details = hits.map((hit) => `  ${hit.file}:${hit.line} -> ${hit.specifier}`).join('\n');

      throw new Error(
        `Found ${hits.length} shared-ui deep source import(s):\n${details}\n\n` +
          `Use the public '@aquaculture/shared-ui' entrypoint instead. ` +
          `Deep source imports create duplicate React context module identities ` +
          `under Module Federation and can break AuthProvider/TenantProvider at runtime.`,
      );
    }

    expect(hits).toEqual([]);
  });

  it('sees a multi-line deep import as one statement', () => {
    // A line-by-line scan reads only `} from '...'` on the last line and misses it.
    const sample =
      "import {\n  useTenantContext,\n} from '../../shared-ui/src/contexts/TenantContext';";
    const specifiers = [...sample.matchAll(IMPORT_SPECIFIER_RE)].map((match) => match[1]);
    expect(specifiers).toEqual(['../../shared-ui/src/contexts/TenantContext']);
  });
});

/** How a federation container is resolved for real: `vite build` and the `vite` dev server. */
const BUILD_TARGETS: readonly ProbeTarget[] = [
  { mode: 'production', command: 'build' },
  { mode: 'development', command: 'serve' },
];

/** How vitest resolves the same config. */
const TEST_TARGET: ProbeTarget = { mode: SHARED_UI_TEST_MODE, command: 'serve' };

describe('INVARIANT: no federation build resolves a shared singleton around the share scope (FE-HIGH-343)', () => {
  // Every vite config under web/, resolved by Vite itself: the alias table a
  // build applies, with spread-in helpers and plugin-appended entries, and no
  // way for a string in the config text to hide an entry from the check.
  const federationConfigs = federationViteConfigs();
  const resolved = resolveViteAliases(webViteConfigs(), [...BUILD_TARGETS, TEST_TARGET]);
  const builds = resolved.filter(({ mode }) => mode !== SHARED_UI_TEST_MODE);
  const federationBuilds = builds.filter(({ configFile }) =>
    federationConfigs.includes(configFile),
  );
  const federationSpecRuns = resolved.filter(
    ({ configFile, mode }) =>
      mode === SHARED_UI_TEST_MODE && federationConfigs.includes(configFile),
  );

  it('governs exactly the configs whose resolved pipeline mounts the federation plugin', () => {
    // A walker that matched nothing would make the cases below vacuous; one
    // that matched by text alone could skip a container wired up another way.
    expect(federationConfigs.length).toBeGreaterThanOrEqual(9);
    expect(FEDERATION_SHARED_KEYS).toContain(SHARED_UI_PACKAGE);

    const mounted = builds
      .filter(({ plugins }) => plugins.includes(FEDERATION_PLUGIN))
      .map(({ configFile, mode }) => `${configFile} (${mode})`);
    const expected = federationConfigs.flatMap((configFile) =>
      BUILD_TARGETS.map(({ mode }) => `${configFile} (${mode})`),
    );
    expect(mounted.sort()).toEqual(expected.sort());
  });

  it("reads each federation build's own alias table", () => {
    // Every federation config maps '@' to its own src/. Seeing that entry in
    // every build proves the probe resolved the config it names rather than
    // returning an empty table the next case would pass on.
    const unread = federationBuilds
      .filter(
        ({ configFile, aliases }) =>
          !aliases.some(
            ({ find, replacement }) =>
              find === '@' && replacement === resolve(REPO_ROOT, dirname(configFile), 'src'),
          ),
      )
      .map(({ configFile, mode }) => `${configFile} (${mode})`);

    expect(unread).toEqual([]);
  });

  it('no federation build aliases a federation-shared specifier', () => {
    const offenders = federationBuilds.flatMap(({ configFile, mode, aliases }) =>
      aliases
        .filter(({ find }) => FEDERATION_SHARED_KEYS.some((key) => aliasShadows(find, key)))
        .map(
          ({ find, replacement }) =>
            `${configFile} (${mode}) aliases '${describeFind(find)}' -> ${replacement}`,
        ),
    );

    expect(offenders).toEqual([]);
  });

  it('sees an alias a helper spreads in: under vitest each federation config sends shared-ui to source', () => {
    // Positive control for the case above. The shared-ui source alias reaches a
    // config only through `...sharedUiAlias(root, mode)`, so a check blind to
    // spread-in entries, or to any config, fails here.
    const sharedUiSource = resolve(REPO_ROOT, 'web/shared-ui/src');
    const missing = federationSpecRuns
      .filter(
        ({ aliases }) =>
          !aliases.some(
            ({ find, replacement }) => find === SHARED_UI_PACKAGE && replacement === sharedUiSource,
          ),
      )
      .map(({ configFile }) => configFile);

    expect(federationSpecRuns).toHaveLength(federationConfigs.length);
    expect(missing).toEqual([]);
  });

  it('the shared-ui alias resolver shadows no shared specifier outside test mode', () => {
    const root = '/repo/web/shared-ui';
    const offenders = ['production', 'development', 'staging', ''].flatMap((mode) =>
      Object.keys(sharedUiAlias(root, mode))
        .filter((find) => FEDERATION_SHARED_KEYS.some((key) => aliasShadows(find, key)))
        .map((find) => `mode '${mode}' aliases '${find}'`),
    );

    expect(offenders).toEqual([]);
    // Under vitest no federation runtime exists; the source alias is the point.
    expect(Object.keys(sharedUiAlias(root, SHARED_UI_TEST_MODE))).toEqual([
      '@aquaculture/shared-ui',
    ]);
  });
});
