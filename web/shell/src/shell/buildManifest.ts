/**
 * The build identity of the console shell (FE-MEDIUM-380, PKG-42).
 *
 * WHY: a deploy replaces the shell image (docker-compose.droplet.yml, one image per release
 * tag), so the hashed chunks of the previous build no longer exist on the server, and the edge
 * answers a request for one with index.html (infrastructure/nginx/droplet.conf, `error_page
 * 404 = /index.html`). A tab opened before the deploy cannot tell: it imports a "chunk", gets
 * HTML, and the page fails; after a BREAKING GraphQL release its old documents fail validation
 * on every page. The tab has to know which build it runs and which build the server serves.
 *
 * WHAT: the one owner of the contract between the build and the running tab.
 *   - BUILD_MANIFEST_FILE: the file the build emits at the root of its output
 *     (buildManifestPlugin.ts), served by infrastructure/docker/nginx/shell.conf with no-store
 *     and a 404 when missing (tests/invariants/shell-build-manifest-contract.spec.ts).
 *   - BUILD_ID_META: the <meta> the build writes into index.html, so the document a tab loaded
 *     names the build its scripts came from — the document and its hashed scripts are one build.
 *   - buildIdFromManifest / buildIdOfDocument: read them; anything but a well-formed id is
 *     "unknown" (null), and an unknown build never makes a tab reload. The dev server has
 *     neither, so the check is off there.
 *
 * Pure and free of DOM globals: vite.config.ts (Node) imports it through the plugin.
 */

/** The manifest file, at the root of the shell's build output. */
export const BUILD_MANIFEST_FILE = 'build-manifest.json';

/** The `<meta name>` carrying the build id in the built index.html. */
export const BUILD_ID_META = 'aqua-build-id';

/** A build id is the SHA-256 of the build output, in lower-case hex. */
const BUILD_ID_PATTERN = /^[0-9a-f]{64}$/;

/** The served manifest's shape. */
export interface BuildManifest {
  readonly buildId: string;
}

/** What `buildIdOfDocument` reads: the loaded document's head, structurally. */
export interface BuildIdDocument {
  querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
}

export function isBuildId(value: unknown): value is string {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value);
}

/**
 * The build id of a served manifest, or null for anything that is not one (no manifest, the
 * edge's index.html fallback, a malformed id).
 */
export function buildIdFromManifest(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null || !('buildId' in manifest)) return null;
  const { buildId } = manifest;
  return isBuildId(buildId) ? buildId : null;
}

/** The build id the loaded document names, or null (the dev server writes none). */
export function buildIdOfDocument(document: BuildIdDocument): string | null {
  const meta = document.querySelector(`meta[name="${BUILD_ID_META}"]`);
  if (meta === null) return null;
  const content = meta.getAttribute('content');
  return isBuildId(content) ? content : null;
}
