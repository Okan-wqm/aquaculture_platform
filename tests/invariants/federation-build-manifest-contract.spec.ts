/**
 * INVARIANT — every console build names itself, its manifest is served fresh and never answered
 * with HTML, and the shell learns the build of every remote it loads (FE-MEDIUM-380, PKG-42).
 *
 * An open console tab learns that a new build is deployed by comparing each build it runs — the
 * shell and every remote it has loaded — with the `build-manifest.json` the server serves beside
 * it (web/shell/src/shell/buildSkew.ts). A release can rebuild only a remote (frontend images are
 * built per affected project, each remote served by its own container), so the shell alone is
 * not enough. That only works while these hold:
 *
 *   1. the shell's resolved build mounts the build-manifest plugin as a host (the id in
 *      index.html), and every remote's as a remote (the id exported from remoteEntry.js) — read
 *      from each config's resolved `vite build` pipeline (the FE-HIGH-343 probe), so no string in
 *      a config can claim a plugin the pipeline lacks;
 *   2. the shell's federation config registers the runtime plugin that records each remote entry
 *      the runtime loads, and that plugin imports nothing but types and a registry that imports
 *      nothing: the runtime imports it while it initialises, before any shared module (shared-ui,
 *      React) can load, so a shared import there would make the runtime's start wait on itself;
 *   3. the shell container (shell.conf) and every remote container (microfrontend.conf) serve
 *      the manifest from an exact location with `Cache-Control: no-store` — a cached manifest
 *      would name the old build forever — and answer a missing file with 404, never the SPA
 *      fallback, so nothing but the manifest is ever read as one;
 *   4. neither edge (droplet.conf, nginx.prod.conf) shadows the manifest or hides the
 *      container's Cache-Control.
 *
 * The file name is read from its one owner, web/shared-ui/src/federation/buildManifest.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BUILD_MANIFEST_FILE } from '../../web/shared-ui/src/federation/buildManifest';
import { BUILD_MANIFEST_PLUGIN } from '../../web/shared-ui/src/federation/buildManifestPlugin';

import { federationViteConfigs, resolveViteAliases } from './lib/federation-vite-configs';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SHELL_CONFIG = 'web/shell/vite.config.ts';
const RUNTIME_PLUGIN = 'web/shell/src/shell/remoteBuildRuntimePlugin.ts';
const RUNTIME_REGISTRY = 'web/shell/src/shell/loadedRemoteEntries.ts';

function read(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

/** The body of the exact-match location for `path`, brace-balanced; null when absent. */
function exactLocation(conf: string, path: string): string | null {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const opened = new RegExp(`location\\s*=\\s*${escaped}\\s*\\{`, 'u').exec(conf);
  if (opened === null) return null;
  let depth = 1;
  let cursor = opened.index + opened[0].length;
  for (; cursor < conf.length && depth > 0; cursor += 1) {
    if (conf[cursor] === '{') depth += 1;
    if (conf[cursor] === '}') depth -= 1;
  }
  return conf.slice(opened.index + opened[0].length, cursor - 1);
}

function withoutComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/u, ''))
    .join('\n');
}

/** Every `import … from '…'` statement of a TypeScript source, comments and all. */
function importStatements(source: string): string[] {
  return [...source.matchAll(/^import\s[\s\S]*?from\s+'[^']+';/gmu)].map(([statement]) =>
    statement.replace(/\s+/gu, ' '),
  );
}

describe('INVARIANT (FE-MEDIUM-380): every console build names itself and is served fresh', () => {
  describe('the builds', () => {
    const builds = resolveViteAliases(federationViteConfigs(), [
      { mode: 'production', command: 'build' },
    ]);

    it('resolves the shell and every remote', () => {
      // A probe that resolved nothing would make the cases below vacuous.
      expect(builds.length).toBeGreaterThanOrEqual(9);
      expect(builds.map(({ configFile }) => configFile)).toContain(SHELL_CONFIG);
    });

    it('the shell names its build as a host, in index.html', () => {
      const shell = builds.find(({ configFile }) => configFile === SHELL_CONFIG);
      if (shell === undefined) throw new Error(`${SHELL_CONFIG} did not resolve`);
      expect(shell.plugins).toContain(BUILD_MANIFEST_PLUGIN.host);
      expect(shell.plugins).not.toContain(BUILD_MANIFEST_PLUGIN.remote);
    });

    it('every remote names its build as a remote, in its entry module', () => {
      const unnamed = builds
        .filter(({ configFile }) => configFile !== SHELL_CONFIG)
        .filter(
          ({ plugins }) =>
            !plugins.includes(BUILD_MANIFEST_PLUGIN.remote) ||
            plugins.includes(BUILD_MANIFEST_PLUGIN.host),
        )
        .map(({ configFile }) => configFile);
      expect(unnamed).toEqual([]);
    });
  });

  describe('the shell learns the build of every remote it loads', () => {
    it('registers the runtime plugin that records each loaded remote entry', () => {
      const config = read(SHELL_CONFIG);
      expect(config).toMatch(
        /runtimePlugins:\s*\[\s*resolve\(__dirname,\s*'src\/shell\/remoteBuildRuntimePlugin\.ts'\)\s*\]/u,
      );
    });

    it('the runtime plugin imports nothing but types and the registry', () => {
      const imports = importStatements(read(RUNTIME_PLUGIN));
      expect(imports.length).toBeGreaterThan(0);
      const shared = imports.filter(
        (statement) =>
          !statement.startsWith('import type ') &&
          statement !== "import { recordLoadedRemoteEntry } from './loadedRemoteEntries';",
      );
      expect(shared).toEqual([]);
    });

    it('the registry imports nothing', () => {
      expect(importStatements(read(RUNTIME_REGISTRY))).toEqual([]);
    });
  });

  describe.each([
    ['the shell container', 'infrastructure/docker/nginx/shell.conf'],
    ['every remote container', 'infrastructure/docker/nginx/microfrontend.conf'],
  ])('%s', (_label, conf) => {
    const body = exactLocation(withoutComments(read(conf)), `/${BUILD_MANIFEST_FILE}`);

    it('serves the manifest from an exact location, never cached', () => {
      expect(body).not.toBeNull();
      expect(body).toMatch(/add_header\s+Cache-Control\s+"[^"]*\bno-store\b[^"]*"/u);
    });

    it('answers a missing manifest with 404, not a fallback', () => {
      expect(body).toMatch(/try_files\s+\$uri\s+=404;/u);
    });
  });

  it.each(['infrastructure/nginx/droplet.conf', 'infrastructure/docker/nginx/nginx.prod.conf'])(
    '%s neither shadows a manifest nor hides its Cache-Control',
    (edge) => {
      const conf = withoutComments(read(edge));
      expect(conf).not.toContain(BUILD_MANIFEST_FILE);
      expect(conf).not.toMatch(/proxy_hide_header\s+Cache-Control/u);
    },
  );
});
