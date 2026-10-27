/**
 * Every console build names itself: the shell and each federated remote (FE-MEDIUM-380, PKG-42).
 *
 * WHY: an open tab can only learn that a new build is deployed if each build it runs says which
 * one it is, in two places that cannot disagree: the file the tab loaded and a file the server
 * serves fresh (buildManifest.ts). The shell alone was not enough: a release can rebuild only a
 * remote (frontend images are built per affected project), whose container then no longer has
 * the chunks an open tab's copy of that remote asks for, while the shell's id stays the same.
 *
 * WHAT: a build-only plugin that, after every other plugin has produced the bundle
 * (`generateBundle`, order `post`, when every chunk and asset is in it):
 *   - derives the build id: SHA-256 over every emitted file's name and bytes, in name order.
 *     Content-derived, so rebuilding identical sources gives the same id (no needless reload)
 *     and any change anywhere in the output gives another; no clock, no environment;
 *   - names it where the running tab reads it:
 *       host   — `<meta name="aqua-build-id">` in index.html, in <head>, before any script;
 *       remote — `export const aquaBuildId = "…"` appended to the remote entry chunk, which the
 *                federation runtime imports and the shell reads (loadedRemoteEntries.ts);
 *   - emits `build-manifest.json` = `{ "buildId": … }` at the root of the output.
 * Files Vite copies from `public/` are not part of the bundle and so not of the id; none of them
 * is code the tab imports.
 *
 * `__tests__/buildManifestPlugin.spec.ts` runs Vite on a host and a remote and proves all three;
 * `tests/invariants/federation-build-manifest-contract.spec.ts` proves the shell's resolved build
 * mounts the host plugin, every remote's the remote plugin, and nginx serves each manifest
 * uncached.
 */
import { createHash } from 'node:crypto';

import type { Plugin, Rollup } from 'vite';

import {
  BUILD_ID_META,
  BUILD_MANIFEST_FILE,
  REMOTE_BUILD_ID_EXPORT,
  type BuildManifest,
} from './buildManifest';

/** Where a build names its id for the running tab. */
export type BuildManifestTarget =
  | { readonly kind: 'host' }
  | { readonly kind: 'remote'; readonly entry: string };

/** The plugin's name in a resolved pipeline, by kind, so the invariant can tell them apart. */
export const BUILD_MANIFEST_PLUGIN = {
  host: 'aquaculture:build-manifest:host',
  remote: 'aquaculture:build-manifest:remote',
} as const satisfies Record<BuildManifestTarget['kind'], string>;

const INDEX_HTML = 'index.html';
const HEAD_CLOSE = '</head>';

/** SHA-256 over every emitted file but the manifest, by name and content, in name order. */
export function buildIdOfBundle(bundle: Rollup.OutputBundle): string {
  const hash = createHash('sha256');
  const byName = Object.entries(bundle).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [fileName, output] of byName) {
    if (fileName === BUILD_MANIFEST_FILE) continue;
    hash.update(fileName);
    hash.update('\0');
    hash.update(output.type === 'chunk' ? output.code : output.source);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** `html` with the build-id meta tag as the last element of its single <head>. */
function withBuildIdMeta(html: string, buildId: string): string {
  const at = html.indexOf(HEAD_CLOSE);
  if (at === -1 || html.indexOf(HEAD_CLOSE, at + HEAD_CLOSE.length) !== -1) {
    throw new Error(
      `[${BUILD_MANIFEST_PLUGIN.host}] ${INDEX_HTML} must have exactly one ${HEAD_CLOSE}`,
    );
  }
  return `${html.slice(0, at)}<meta name="${BUILD_ID_META}" content="${buildId}">${html.slice(at)}`;
}

/** Writes the id where the running tab of `target` reads it; fails the build when that file is missing. */
function nameBuildIn(
  bundle: Rollup.OutputBundle,
  target: BuildManifestTarget,
  buildId: string,
  fail: (message: string) => never,
): void {
  if (target.kind === 'host') {
    const html = bundle[INDEX_HTML];
    if (html === undefined || html.type !== 'asset' || typeof html.source !== 'string') {
      fail(`[${BUILD_MANIFEST_PLUGIN.host}] the build emitted no ${INDEX_HTML} to name its id in`);
    }
    html.source = withBuildIdMeta(html.source, buildId);
    return;
  }
  const entry = bundle[target.entry];
  if (entry === undefined || entry.type !== 'chunk') {
    fail(
      `[${BUILD_MANIFEST_PLUGIN.remote}] the build emitted no entry chunk ${target.entry} to name its id in`,
    );
  }
  entry.code = `${entry.code}\nexport const ${REMOTE_BUILD_ID_EXPORT} = ${JSON.stringify(buildId)};\n`;
}

/**
 * The plugin to list in a federation config's `plugins`: `{ kind: 'host' }` in the shell,
 * `{ kind: 'remote', entry: <federation filename> }` in each remote.
 */
export function buildManifestPlugin(target: BuildManifestTarget): Plugin {
  return {
    name: BUILD_MANIFEST_PLUGIN[target.kind],
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle): void {
        const buildId = buildIdOfBundle(bundle);
        nameBuildIn(bundle, target, buildId, (message) => this.error(message));
        const manifest: BuildManifest = { buildId };
        this.emitFile({
          type: 'asset',
          fileName: BUILD_MANIFEST_FILE,
          source: `${JSON.stringify(manifest)}\n`,
        });
      },
    },
  };
}
