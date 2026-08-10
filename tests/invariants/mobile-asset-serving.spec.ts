/**
 * AquaMobil asset-serving invariant (ORPHAN-HIGH-582 / ORPHAN-MEDIUM-572).
 *
 * Two production-only failure shapes have already bitten this app, both
 * invisible to a status-code check:
 *
 *   - the theme pre-paint script was an inline <script>, silently blocked by
 *     `script-src 'self'`, leaving every user on the fallback theme and gloved
 *     workers on standard-size controls;
 *   - the brand font was fetched from a CDN that `font-src 'self'` forbids, so
 *     the app rendered in the system fallback for its entire production life.
 *
 * Both were fixed by serving same-origin files. This asserts the nginx config
 * actually serves them correctly, because the third failure of this family
 * would be the SPA fallback answering a MISSING asset with index.html and
 * HTTP 200 — the browser then executes HTML as JavaScript (theme layer silently
 * dead) or parses it as a font (silent fallback). Nothing 500s; nothing logs.
 *
 * Static assertions on the config, not a live probe: this runs in CI where no
 * container is available. The behaviours were verified once against a real
 * nginx (headers and 404s observed) and pinned here so they cannot drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONF = join(__dirname, '../../infrastructure/docker/nginx/aquamobil.conf');
const conf = readFileSync(CONF, 'utf8');

/** The body of a named location block, so assertions cannot drift to another one. */
function section(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  return source.slice(start, close + 1);
}

describe('aquamobil asset serving', () => {
  it('never lets a missing asset fall through to index.html', () => {
    // `try_files $uri $uri/ /index.html` on an asset extension is the silent
    // failure. Assets must 404 honestly; only routes may fall through.
    expect(conf).toMatch(/location\s+~\*\s+\\\.\(\?:js\|mjs\|css\|woff2\?/);
    expect(conf).toMatch(/try_files\s+\$uri\s+=404;/);
  });

  it('serves the theme pre-paint script uncached', () => {
    // Unhashed filename that must stay in step with useTheme.ts. A cached copy
    // can drift a deploy behind the hashed bundle and reproduce ORPHAN-HIGH-582
    // by a different route.
    const block = section(conf, 'location = /theme-init.js');
    expect(block).not.toBe(''); // no location block for /theme-init.js
    expect(block).toContain('no-store');
    // An add_header here drops every inherited security header unless the
    // snippet is re-included (SEC-MEDIUM-052).
    expect(block).toContain('security-headers.conf');
  });

  it('gives the self-hosted fonts a cache policy that is not immutable', () => {
    // The filenames are stable, not content-hashed — an immutable year would
    // pin a stale face until someone renamed the file.
    const block = section(conf, 'location ^~ /fonts/');
    expect(block).not.toBe(''); // no ^~ location block for /fonts/
    expect(block).toContain('max-age=86400');
    expect(block).not.toContain('immutable');
  });

  it('keeps every prefix asset block ahead of the extension regex', () => {
    // THE TRAP, found by running it: nginx evaluates regex locations BEFORE
    // plain prefix ones, so adding the extension regex above silently stripped
    // /assets/ of its immutable year and /fonts/ of its cache headers entirely.
    // `^~` is what makes the prefix win. Removing it breaks caching invisibly —
    // everything still 200s.
    for (const prefix of ['/assets/', '/icons/', '/fonts/']) {
      expect(conf).toContain(`location ^~ ${prefix}`);
    }
  });

  it('still lets real routes reach the SPA', () => {
    expect(conf).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });
});
