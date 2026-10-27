// @vitest-environment node
/**
 * Every console build names itself (FE-MEDIUM-380, PKG-42): the shell's Vite build writes one id
 * into index.html and each remote's into an export of its entry module, and both into a served
 * `build-manifest.json`, so an open tab can compare every build it runs with the one the server
 * serves. A remote has to name itself too: a release can rebuild only a remote, and the shell's
 * id then stays the same while the tab's copy of that remote asks for chunks that are gone.
 *
 * These cases run Vite itself on small apps, the way `unresolvedAssetUrlGate.spec.ts` does, so
 * they also pin what the plugin relies on: that index.html and the entry chunk are in the bundle
 * when a `post` generateBundle hook runs, and that the appended export is a valid export of the
 * built entry module.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build, type Rollup } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILD_ID_META,
  BUILD_MANIFEST_FILE,
  buildIdFromManifest,
  buildIdOfRemoteEntry,
} from '../buildManifest';
import { BUILD_MANIFEST_PLUGIN, buildManifestPlugin } from '../buildManifestPlugin';

const REMOTE_ENTRY = 'remoteEntry.js';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function textOf(output: Rollup.OutputAsset): string {
  return typeof output.source === 'string'
    ? output.source
    : new TextDecoder().decode(output.source);
}

/**
 * A source tree whose entries lazily load a page printing `pageText`: `main.js` for the host's
 * index.html, `entry.js` (exporting the loader, as a remote entry exports `get`) for the remote.
 */
function sources(pageText: string): string {
  const root = mkdtempSync(join(tmpdir(), 'build-manifest-'));
  roots.push(root);
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>\n',
  );
  writeFileSync(join(root, 'main.js'), "void import('./page.js');\n");
  writeFileSync(join(root, 'entry.js'), "export const page = () => import('./page.js');\n");
  writeFileSync(join(root, 'page.js'), `export const text = ${JSON.stringify(pageText)};\n`);
  return root;
}

/** The id the served manifest names; throws when the build emitted no well-formed manifest. */
function manifestIdOf(output: readonly (Rollup.OutputChunk | Rollup.OutputAsset)[]): string {
  const manifest = output.find(
    (file): file is Rollup.OutputAsset =>
      file.type === 'asset' && file.fileName === BUILD_MANIFEST_FILE,
  );
  if (manifest === undefined) throw new Error('the build emitted no manifest');
  const buildId = buildIdFromManifest(JSON.parse(textOf(manifest)));
  if (buildId === null) throw new Error('the manifest names no well-formed build id');
  return buildId;
}

interface BuiltHost {
  readonly html: string;
  readonly buildId: string;
}

/** Builds a two-chunk host app whose lazy page prints `pageText`. */
async function buildHost(pageText: string): Promise<BuiltHost> {
  const result = (await build({
    root: sources(pageText),
    configFile: false,
    logLevel: 'silent',
    plugins: [buildManifestPlugin({ kind: 'host' })],
    build: { write: false },
  })) as Rollup.RollupOutput;
  const html = result.output.find(
    (file): file is Rollup.OutputAsset => file.type === 'asset' && file.fileName === 'index.html',
  );
  if (html === undefined) throw new Error('the build emitted no index.html');
  return { html: textOf(html), buildId: manifestIdOf(result.output) };
}

interface BuiltRemote {
  readonly outDir: string;
  readonly buildId: string;
}

/** Builds a remote whose entry chunk is `remoteEntry.js`, as the federation plugin names it. */
async function buildRemote(pageText: string): Promise<BuiltRemote> {
  const root = sources(pageText);
  const outDir = join(root, 'dist');
  const result = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [buildManifestPlugin({ kind: 'remote', entry: REMOTE_ENTRY })],
    build: {
      outDir,
      rollupOptions: {
        input: { remoteEntry: join(root, 'entry.js') },
        preserveEntrySignatures: 'strict',
        output: { entryFileNames: '[name].js' },
      },
    },
  })) as Rollup.RollupOutput;
  return { outDir, buildId: manifestIdOf(result.output) };
}

describe('buildManifestPlugin', () => {
  it('is a build-only plugin, named by the kind of build it names', () => {
    const host = buildManifestPlugin({ kind: 'host' });
    const remote = buildManifestPlugin({ kind: 'remote', entry: REMOTE_ENTRY });
    expect(host.name).toBe(BUILD_MANIFEST_PLUGIN.host);
    expect(remote.name).toBe(BUILD_MANIFEST_PLUGIN.remote);
    expect(host.apply).toBe('build');
    expect(remote.apply).toBe('build');
  });

  describe('a host (the shell)', () => {
    it('emits a manifest naming the build and writes the same id into index.html', async () => {
      const { html, buildId } = await buildHost('first');
      expect(html).toContain(`<meta name="${BUILD_ID_META}" content="${buildId}">`);
      // The tag sits in <head>, where the shell reads it before any script runs.
      expect(html.indexOf(BUILD_ID_META)).toBeLessThan(html.indexOf('</head>'));
    });

    it('gives the same sources the same id, so rebuilding identical code does not reload a tab', async () => {
      expect((await buildHost('same')).buildId).toBe((await buildHost('same')).buildId);
    });

    it('gives a build whose lazily loaded chunk changed another id', async () => {
      expect((await buildHost('before')).buildId).not.toBe((await buildHost('after')).buildId);
    });
  });

  describe('a remote', () => {
    it('exports the id the manifest names from the built entry module', async () => {
      const { outDir, buildId } = await buildRemote('first');
      const entry: unknown = await import(pathToFileURL(join(outDir, REMOTE_ENTRY)).href);
      expect(buildIdOfRemoteEntry(entry)).toBe(buildId);
      // The entry's own exports are untouched: the federation runtime still finds them.
      expect(entry).toHaveProperty('page');
      expect(JSON.parse(readFileSync(join(outDir, BUILD_MANIFEST_FILE), 'utf8'))).toEqual({
        buildId,
      });
    });

    it('gives a remote whose lazily loaded chunk changed another id', async () => {
      expect((await buildRemote('before')).buildId).not.toBe((await buildRemote('after')).buildId);
    });

    it('fails the build when the entry it should name its id in is not emitted', async () => {
      await expect(
        build({
          root: sources('first'),
          configFile: false,
          logLevel: 'silent',
          plugins: [buildManifestPlugin({ kind: 'remote', entry: 'missingEntry.js' })],
          build: { write: false },
        }),
      ).rejects.toThrow(/missingEntry\.js/);
    });
  });
});
