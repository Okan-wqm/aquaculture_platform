/**
 * The shell build names itself (FE-MEDIUM-380, PKG-42).
 *
 * WHY: an open tab can only learn that a new build is deployed if the build says which one it
 * is, in two places that cannot disagree: the document the tab loaded and a file the server
 * serves fresh (see buildManifest.ts).
 *
 * WHAT: a build-only plugin that, after every other plugin has produced the bundle
 * (`generateBundle`, order `post`, when index.html and every chunk and asset are in it):
 *   - derives the build id: SHA-256 over every emitted file's name and bytes, in name order.
 *     Content-derived, so rebuilding identical sources gives the same id (no needless reload)
 *     and any change anywhere in the output gives another; no clock, no environment;
 *   - writes it into index.html as `<meta name="aqua-build-id">`, in <head>, before any script;
 *   - emits `build-manifest.json` = `{ "buildId": … }` beside index.html.
 * Files Vite copies from `public/` are not part of the bundle and so not of the id; none of them
 * is code the tab's build imports.
 *
 * `__tests__/buildManifestPlugin.spec.ts` runs Vite on a small app and proves all three;
 * `tests/invariants/shell-build-manifest-contract.spec.ts` proves vite.config.ts mounts it and
 * nginx serves the manifest uncached.
 */
import { createHash } from 'node:crypto';

import type { Plugin, Rollup } from 'vite';

import { BUILD_ID_META, BUILD_MANIFEST_FILE, type BuildManifest } from './buildManifest';

/** The plugin's name in the resolved pipeline. */
export const BUILD_MANIFEST_PLUGIN = 'aquaculture:build-manifest';

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
    throw new Error(`[${BUILD_MANIFEST_PLUGIN}] ${INDEX_HTML} must have exactly one ${HEAD_CLOSE}`);
  }
  return `${html.slice(0, at)}<meta name="${BUILD_ID_META}" content="${buildId}">${html.slice(at)}`;
}

/** The plugin to list in the shell's `plugins`. */
export function buildManifestPlugin(): Plugin {
  return {
    name: BUILD_MANIFEST_PLUGIN,
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle): void {
        const html = bundle[INDEX_HTML];
        if (html === undefined || html.type !== 'asset' || typeof html.source !== 'string') {
          this.error(
            `[${BUILD_MANIFEST_PLUGIN}] the build emitted no ${INDEX_HTML} to name its id in`,
          );
        }
        const buildId = buildIdOfBundle(bundle);
        html.source = withBuildIdMeta(html.source, buildId);
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
