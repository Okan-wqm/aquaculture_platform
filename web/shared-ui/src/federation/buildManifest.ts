/**
 * The build identity of the console: the shell and every federated remote (FE-MEDIUM-380,
 * PKG-42).
 *
 * WHY: a deploy replaces an image — the shell's, or one remote's: frontend images are built per
 * affected project (scripts/ci/select-deployment-scope.ts), and each remote is served by its own
 * container under /remotes/<name>/ (infrastructure/nginx/droplet.conf). The hashed chunks of the
 * previous build are then gone from that container, and a tab opened before the deploy cannot
 * tell: it imports a "chunk", gets a 404 or HTML, and the page fails; after a BREAKING GraphQL
 * release the documents of whichever part was rebuilt fail validation on every page. The tab has
 * to know which build of each part it runs and which build the server serves for it.
 *
 * WHAT: the one owner of the contract between a build and the running tab.
 *   - BUILD_MANIFEST_FILE: the file every build (the shell and each remote) emits at the root of
 *     its output (buildManifestPlugin.ts), served with no-store and a 404 when missing by
 *     infrastructure/docker/nginx/shell.conf and microfrontend.conf
 *     (tests/invariants/federation-build-manifest-contract.spec.ts).
 *   - What the running tab reads, written by the same build as the code it runs, so the two
 *     cannot disagree:
 *       the shell: BUILD_ID_META, a <meta> in its index.html;
 *       a remote:  REMOTE_BUILD_ID_EXPORT, an export of its remoteEntry.js, read from the entry
 *                  module the federation runtime loaded (web/shell/src/shell/loadedRemoteEntries.ts).
 *   - buildManifestUrlBeside: a part's manifest sits beside its document or entry.
 *   - buildIdFromManifest / buildIdOfDocument / buildIdOfRemoteEntry: read them; anything but a
 *     well-formed id is "unknown" (null), and an unknown build never makes a tab reload. The dev
 *     server writes none of them, so the check is off there.
 *
 * Pure and free of DOM and Node globals: the plugin (Node) and the shell's build-skew check (the
 * browser, through the shared-ui barrel) both import it.
 */

/** The manifest file, at the root of a build's output. */
export const BUILD_MANIFEST_FILE = 'build-manifest.json';

/** The `<meta name>` carrying the build id in the shell's built index.html. */
export const BUILD_ID_META = 'aqua-build-id';

/** The export of a remote's built entry module that carries its build id. */
export const REMOTE_BUILD_ID_EXPORT = 'aquaBuildId';

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

/** The build id the loaded shell document names, or null (the dev server writes none). */
export function buildIdOfDocument(document: BuildIdDocument): string | null {
  const meta = document.querySelector(`meta[name="${BUILD_ID_META}"]`);
  if (meta === null) return null;
  const content = meta.getAttribute('content');
  return isBuildId(content) ? content : null;
}

/**
 * The build id a loaded remote entry module exports, or null (a remote built before the id
 * existed, the dev server, an entry that failed to load).
 */
export function buildIdOfRemoteEntry(entryExports: unknown): string | null {
  if (typeof entryExports !== 'object' || entryExports === null) return null;
  if (!(REMOTE_BUILD_ID_EXPORT in entryExports)) return null;
  const buildId: unknown = Reflect.get(entryExports, REMOTE_BUILD_ID_EXPORT);
  return isBuildId(buildId) ? buildId : null;
}

/**
 * The absolute URL of the manifest beside `fileUrl` (the shell's base, or a remote's entry),
 * resolved against the document's URL.
 */
export function buildManifestUrlBeside(fileUrl: string, documentUrl: string): string {
  return new URL(BUILD_MANIFEST_FILE, new URL(fileUrl, documentUrl)).href;
}
