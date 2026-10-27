/**
 * INVARIANT — the shell's build manifest is emitted, served fresh, and never answered with HTML
 * (FE-MEDIUM-380, PKG-42).
 *
 * An open console tab learns that a new build is deployed by reading `build-manifest.json`
 * (web/shell/src/shell/useBuildSkewReload.ts). That only works while three files agree:
 *
 *   1. web/shell/vite.config.ts mounts `buildManifestPlugin()`, which emits the manifest and
 *      writes the same id into index.html;
 *   2. infrastructure/docker/nginx/shell.conf serves the manifest from an exact location with
 *      `Cache-Control: no-store`: a cached manifest would name the old build forever, and the
 *      tab would never reload;
 *   3. that location answers a missing file with 404 (`try_files $uri =404`) rather than the
 *      SPA fallback, so nothing but the manifest is ever read as one.
 *
 * The file name is read from its one owner, web/shell/src/shell/buildManifest.ts. Both edges
 * (infrastructure/nginx/droplet.conf, infrastructure/docker/nginx/nginx.prod.conf) proxy `/` to
 * the shell without a Cache-Control of their own, so the shell container's header reaches the
 * browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

function manifestFileName(): string {
  const source = read('web/shell/src/shell/buildManifest.ts');
  const declared = /export const BUILD_MANIFEST_FILE = '([^']+)';/u.exec(source)?.[1];
  if (declared === undefined) {
    throw new Error('web/shell/src/shell/buildManifest.ts no longer declares BUILD_MANIFEST_FILE');
  }
  return declared;
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

describe('shell build manifest contract (FE-MEDIUM-380)', () => {
  const fileName = manifestFileName();

  it('the shell build mounts the plugin that emits the manifest', () => {
    const viteConfig = withoutComments(read('web/shell/vite.config.ts'));
    expect(viteConfig).toMatch(
      /import \{ buildManifestPlugin \} from '\.\/src\/shell\/buildManifestPlugin';/u,
    );
    expect(viteConfig).toMatch(/plugins:\s*\[[\s\S]*buildManifestPlugin\(\)/u);
  });

  it('the shell container serves the manifest from an exact location, never cached', () => {
    const body = exactLocation(
      withoutComments(read('infrastructure/docker/nginx/shell.conf')),
      `/${fileName}`,
    );
    expect(body).not.toBeNull();
    expect(body).toMatch(/add_header\s+Cache-Control\s+"[^"]*\bno-store\b[^"]*"/u);
  });

  it('a missing manifest is a 404, not the SPA fallback', () => {
    const body = exactLocation(
      withoutComments(read('infrastructure/docker/nginx/shell.conf')),
      `/${fileName}`,
    );
    expect(body).toMatch(/try_files\s+\$uri\s+=404;/u);
  });

  it.each(['infrastructure/nginx/droplet.conf', 'infrastructure/docker/nginx/nginx.prod.conf'])(
    '%s neither shadows the manifest nor overrides its Cache-Control',
    (edge) => {
      const conf = withoutComments(read(edge));
      expect(conf).not.toContain(fileName);
      expect(conf).not.toMatch(/proxy_hide_header\s+Cache-Control/u);
    },
  );
});
