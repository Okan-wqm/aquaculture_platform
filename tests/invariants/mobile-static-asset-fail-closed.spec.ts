/**
 * A location that promises long-lived caching must fail closed.
 *
 * `aquamobil.conf` ends with an SPA fallback — `try_files $uri $uri/
 * /index.html` — which is correct for routes and wrong for files. A location
 * that does not answer the request itself falls through to it, so a MISSING
 * asset is served 200 with the HTML document. Two things then go wrong at
 * once: the browser parse-errors the "script" it asked for, and the
 * `Cache-Control: immutable, max-age=31536000` the asset location added is
 * applied to that HTML — the client keeps a copy of index.html under the URL
 * of a JavaScript bundle, for a year.
 *
 * That is the ordinary post-deploy case. A client holding a cached
 * index.html asks for a hashed chunk the new build no longer ships; without a
 * `=404` it gets a poisoned cache entry instead of a miss it could recover
 * from.
 *
 * The rule is derived, not listed: any location that adds a `Cache-Control`
 * with `max-age` greater than a day is serving files, not routes, and must
 * carry `try_files $uri =404`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONF = resolve(REPO_ROOT, 'infrastructure/docker/nginx/aquamobil.conf');

/** One `location <matcher> { ... }` block, brace-balanced. */
interface LocationBlock {
  matcher: string;
  body: string;
  line: number;
}

function parseLocations(conf: string): LocationBlock[] {
  const lines = conf.split('\n');
  const blocks: LocationBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const opened = /^\s*location\s+(?<matcher>[^{]+?)\s*\{/u.exec(line);
    const matcher = opened?.groups?.['matcher'];
    if (matcher === undefined) continue;
    let depth = 0;
    const body: string[] = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const current = lines[cursor];
      if (current === undefined) break;
      depth += (current.match(/\{/gu) ?? []).length;
      depth -= (current.match(/\}/gu) ?? []).length;
      body.push(current);
      if (depth === 0) break;
    }
    blocks.push({ matcher, body: body.join('\n'), line: index + 1 });
  }
  return blocks;
}

/** Longest `max-age=<n>` this block asks the client to honour, in seconds. */
function longestMaxAge(body: string): number {
  let longest = 0;
  for (const match of body.matchAll(/max-age=(\d+)/gu)) {
    const value = match[1];
    if (value === undefined) continue;
    longest = Math.max(longest, Number(value));
  }
  return longest;
}

const ONE_DAY_SECONDS = 86_400;

describe('aquamobil static assets fail closed (no SPA fallback for files)', () => {
  const conf = readFileSync(CONF, 'utf8');
  const blocks = parseLocations(conf);

  it('parses the config into location blocks', () => {
    expect(blocks.length).toBeGreaterThan(3);
    expect(blocks.some((block) => block.matcher === '/')).toBe(true);
  });

  it('every long-cached location answers a miss with 404, not the SPA document', () => {
    const offenders = blocks
      .filter((block) => block.matcher !== '/')
      .filter((block) => longestMaxAge(block.body) > ONE_DAY_SECONDS)
      .filter((block) => !/try_files\s+\$uri\s+=404\s*;/u.test(block.body))
      .map(
        (block) =>
          `  aquamobil.conf:${block.line}  location ${block.matcher} caches for ` +
          `${longestMaxAge(block.body)}s but has no \`try_files $uri =404;\`, so a missing ` +
          `file falls through to the SPA fallback and is cached as index.html.`,
      );

    if (offenders.length > 0) {
      throw new Error(`Long-cached locations must fail closed:\n${offenders.join('\n')}`);
    }
  });

  it('the SPA fallback itself is still present for real routes', () => {
    const root = blocks.find((block) => block.matcher === '/');
    expect(root).toBeDefined();
    expect(root?.body).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/u);
  });
});
