// @vitest-environment node
/**
 * The build names itself (FE-MEDIUM-380, PKG-42): the shell's Vite build writes one id into
 * index.html and into a served `build-manifest.json`, so an open tab can compare the build it
 * runs with the build the server serves.
 *
 * These cases run Vite itself on a small app (an entry, a lazily loaded chunk and index.html),
 * the way `unresolvedAssetUrlGate.spec.ts` does, so they also pin what the plugin relies on:
 * that index.html is in the bundle when a `post` generateBundle hook runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, type Rollup } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILD_ID_META, BUILD_MANIFEST_FILE, isBuildId } from '../buildManifest';
import { BUILD_MANIFEST_PLUGIN, buildManifestPlugin } from '../buildManifestPlugin';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface BuiltApp {
  readonly html: string;
  readonly manifest: unknown;
}

function textOf(output: Rollup.OutputAsset): string {
  return typeof output.source === 'string'
    ? output.source
    : new TextDecoder().decode(output.source);
}

/** Builds a two-chunk app whose lazy page prints `pageText`. */
async function buildApp(pageText: string): Promise<BuiltApp> {
  const root = mkdtempSync(join(tmpdir(), 'build-manifest-'));
  roots.push(root);
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>\n',
  );
  writeFileSync(join(root, 'main.js'), "void import('./page.js');\n");
  writeFileSync(join(root, 'page.js'), `export const text = ${JSON.stringify(pageText)};\n`);
  const result = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [buildManifestPlugin()],
    build: { write: false },
  })) as Rollup.RollupOutput;
  const assets = result.output.filter((file): file is Rollup.OutputAsset => file.type === 'asset');
  const html = assets.find((file) => file.fileName === 'index.html');
  const manifest = assets.find((file) => file.fileName === BUILD_MANIFEST_FILE);
  if (html === undefined || manifest === undefined) {
    throw new Error(`the build emitted ${assets.map((file) => file.fileName).join(', ')}`);
  }
  return { html: textOf(html), manifest: JSON.parse(textOf(manifest)) as unknown };
}

function idOf(app: BuiltApp): string {
  const { manifest } = app;
  if (typeof manifest !== 'object' || manifest === null || !('buildId' in manifest)) {
    throw new Error('the manifest carries no buildId');
  }
  const { buildId } = manifest;
  if (!isBuildId(buildId)) throw new Error(`malformed build id ${String(buildId)}`);
  return buildId;
}

describe('buildManifestPlugin', () => {
  it('is a build-only plugin under its own name', () => {
    const plugin = buildManifestPlugin();
    expect(plugin.name).toBe(BUILD_MANIFEST_PLUGIN);
    expect(plugin.apply).toBe('build');
  });

  it('emits a manifest naming the build and writes the same id into index.html', async () => {
    const app = await buildApp('first');
    const buildId = idOf(app);
    expect(app.html).toContain(`<meta name="${BUILD_ID_META}" content="${buildId}">`);
    // The tag sits in <head>, where the shell reads it before any script runs.
    expect(app.html.indexOf(BUILD_ID_META)).toBeLessThan(app.html.indexOf('</head>'));
  });

  it('gives the same sources the same id, so rebuilding identical code does not reload a tab', async () => {
    expect(idOf(await buildApp('same'))).toBe(idOf(await buildApp('same')));
  });

  it('gives a build whose lazily loaded chunk changed another id', async () => {
    expect(idOf(await buildApp('before'))).not.toBe(idOf(await buildApp('after')));
  });
});
