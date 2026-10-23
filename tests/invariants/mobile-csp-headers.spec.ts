/**
 * Mobile PWA security-header coverage (SEC-MEDIUM-052).
 *
 * nginx `add_header` is NOT additive across configuration levels: the instant a
 * `location` declares its own `add_header` (e.g. Cache-Control on index.html or a
 * service worker), it inherits NONE of the server-level `add_header` directives —
 * silently dropping the Content-Security-Policy on exactly the responses that
 * matter (the PWA document + the service workers). The fix re-applies the headers
 * via an `include`d snippet in every overriding location. This invariant pins that
 * coverage so a future location that sets its own add_header cannot silently
 * regress the CSP, and so the snippet stays delivered into the image (a missing
 * include target would make nginx fail to start).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// nginx add_header inheritance and its include map have one owner, shared with ARIA's
// infrastructure-policy adapter (ARIA-HIGH-012); this spec keeps its own Cache-Control filter on
// top of it and takes the include target and the snippet's headers from it.
import { readNginx } from '../../tools/gates/lib/infra/nginx-conf';
import {
  headerLevels,
  includedHeadersFrom,
  SNIPPET_INCLUDES,
} from '../../tools/gates/infra-policy/nginx-header-inheritance';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SNIPPET = 'infrastructure/docker/nginx/snippets/security-headers.conf';
const AQUAMOBIL_CONF = 'infrastructure/docker/nginx/aquamobil.conf';
const DOCKERFILE = 'infrastructure/docker/Dockerfile.aquamobil';
const DROPLET_CONF = 'infrastructure/nginx/droplet.conf';

function read(rel: string): string {
  const path = resolve(REPO_ROOT, rel);
  if (!existsSync(path)) throw new Error(`${rel} does not exist`);
  return readFileSync(path, 'utf8');
}

/** The include target the header owner maps to SNIPPET: the path every include must name. */
function snippetIncludePath(): string {
  const targets = [...SNIPPET_INCLUDES].filter(([, snippet]) => snippet === SNIPPET);
  if (targets.length !== 1 || targets[0] === undefined) {
    throw new Error(`the header owner maps ${SNIPPET} to ${targets.length} include targets`);
  }
  return targets[0][0];
}

const SNIPPET_INCLUDE_PATH = snippetIncludePath();
const INCLUDE_DIRECTIVE = `include ${SNIPPET_INCLUDE_PATH}`;

/** Return the brace-balanced body of the first `{...}` after a header match. */
function blockBody(conf: string, header: RegExp): string {
  const m = header.exec(conf);
  if (!m) throw new Error(`location header not found: ${header}`);
  const open = conf.indexOf('{', m.index);
  if (open === -1) throw new Error(`no opening brace after ${header}`);
  let depth = 0;
  for (let i = open; i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    else if (conf[i] === '}') {
      depth--;
      if (depth === 0) return conf.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

/**
 * The Cache-Control-overriding levels of `conf` that serve without the security set: the
 * regression guard below and its mutation cases share it, so a case that goes red here is the
 * guard itself going red. `dropped` alone is not enough: it is computed from what the parent
 * level sets, so with the server-level include gone (or spelled as a relative path the include
 * map does not know) a Cache-Control location with no include drops nothing and passes, while
 * main's guard required the include in every such location (SEC-MEDIUM-052; ARIA-HIGH-012
 * landing fix 1, high-012-compare.md section 5).
 */
function cacheControlOffenders(conf: string): string[] {
  const includedHeaders = includedHeadersFrom(read);
  const confRead = readNginx(conf);
  // A misread file yields a partial tree, and an unread snippet an include that adds nothing, on
  // either of which "no offenders" would mean nothing.
  expect(includedHeaders.has(SNIPPET_INCLUDE_PATH)).toBe(true);
  expect(confRead.errors).toEqual([]);
  const levels = headerLevels(confRead.tree, { includedHeaders });
  const cacheControlLevels = levels.filter((level) => level.declared.includes('Cache-Control'));
  // Non-vacuous: the tree holds one level per `add_header Cache-Control` line of the file.
  const cacheControlLines = conf
    .split('\n')
    .filter((line) => /^\s*add_header\s+Cache-Control\b/.test(line)).length;
  expect(cacheControlLines).toBeGreaterThan(0);
  expect(cacheControlLevels).toHaveLength(cacheControlLines);
  return cacheControlLevels
    .filter((level) => level.dropped.length > 0)
    .map((level) => `location ${level.location} (line ${level.line})`);
}

/** `conf` with `from` replaced by `to`; the anchor must exist, so a mutation is never vacuous. */
function mutate(conf: string, from: string, to: string): string {
  expect(conf).toContain(from);
  return conf.replace(from, to);
}

/** The offenders without their line numbers (the mutations move lines). */
function offenderLocations(conf: string): string[] {
  return cacheControlOffenders(conf).map((offender) => offender.replace(/ \(line \d+\)$/, ''));
}

describe('mobile PWA security headers (SEC-MEDIUM-052)', () => {
  describe('security-headers snippet', () => {
    const snippet = read(SNIPPET);

    it('defines the Content-Security-Policy (and is the single source of truth)', () => {
      expect(snippet).toMatch(/add_header\s+Content-Security-Policy\s+"/);
    });

    it('carries the rest of the security set', () => {
      for (const h of [
        'X-Frame-Options',
        'X-Content-Type-Options',
        'Referrer-Policy',
        'Permissions-Policy',
      ]) {
        expect(snippet).toContain(`add_header ${h}`);
      }
    });
  });

  describe('Dockerfile delivers the snippet to the include path', () => {
    it('COPYs the snippet to /etc/nginx/snippets/ so the include resolves at runtime', () => {
      // A missing include target makes nginx fail to start — pin the COPY.
      expect(read(DOCKERFILE)).toMatch(
        /COPY\s+infrastructure\/docker\/nginx\/snippets\/security-headers\.conf\s+\/etc\/nginx\/snippets\/security-headers\.conf/,
      );
    });
  });

  describe('aquamobil.conf re-includes the snippet wherever it overrides headers', () => {
    const conf = read(AQUAMOBIL_CONF);

    it('the PWA document (location = /index.html) re-applies the security headers', () => {
      expect(blockBody(conf, /location\s*=\s*\/index\.html\s*\{/)).toContain(INCLUDE_DIRECTIVE);
    });

    it('the service workers re-apply the security headers', () => {
      expect(
        blockBody(conf, /location\s*~\*\s*\^\/\(messaging-sw\|firebase-messaging-sw\)/),
      ).toContain(INCLUDE_DIRECTIVE);
      expect(blockBody(conf, /location\s*=\s*\/sw\.js\s*\{/)).toContain(INCLUDE_DIRECTIVE);
    });

    it('no Cache-Control-overriding location is left without the security include (regression guard)', () => {
      // Every block that sets its own Cache-Control add_header drops the inherited
      // security set, so it MUST re-include the snippet. The owner computes each level's
      // drop (the /health JSON endpoint drops too: it sets Content-Type, not
      // Cache-Control); this spec guards the Cache-Control overrides.
      expect(cacheControlOffenders(conf)).toEqual([]);
    });
  });

  describe('the regression guard catches what main caught (ARIA-HIGH-012 landing fix 1)', () => {
    const conf = read(AQUAMOBIL_CONF);
    const SERVER_INCLUDE = `\n    ${INCLUDE_DIRECTIVE};\n`;
    const ASSETS_CACHE =
      '        add_header Cache-Control "public, immutable, max-age=31536000";\n';
    const ASSETS_INCLUDE = `${ASSETS_CACHE}        ${INCLUDE_DIRECTIVE}; # SEC-MEDIUM-052\n`;
    const withoutAssetsInclude = mutate(conf, ASSETS_INCLUDE, ASSETS_CACHE);

    it('control: the /assets/ include removed under the server include', () => {
      expect(offenderLocations(withoutAssetsInclude)).toEqual(['location /assets/']);
    });

    it('the server include and the /assets/ include removed', () => {
      // aquamobil.conf:45 and :101. Main's guard reported `location /assets/ {`; nothing above
      // /assets/ sets a header any more, so it drops nothing and still serves without the CSP.
      expect(offenderLocations(mutate(withoutAssetsInclude, SERVER_INCLUDE, '\n'))).toEqual([
        'location /assets/',
      ]);
    });

    it('the server include spelled as a relative path and the /assets/ include removed', () => {
      // nginx resolves `include snippets/...` against its prefix; the include map knows only the
      // absolute target the Dockerfile COPYs to, so the server level declares nothing it can see.
      const relative = mutate(
        withoutAssetsInclude,
        SERVER_INCLUDE,
        '\n    include snippets/security-headers.conf;\n',
      );
      expect(offenderLocations(relative)).toEqual(['location /assets/']);
    });

    it('a location that declares the whole set itself, in any case, is not an offender', () => {
      // nginx header names are case-insensitive; the guard compares them that way.
      const snippetHeaders = includedHeadersFrom(read).get(SNIPPET_INCLUDE_PATH);
      if (snippetHeaders === undefined) throw new Error(`${SNIPPET} does not read cleanly`);
      const ownSet = snippetHeaders
        .map((header) => `        add_header ${header.toLowerCase()} "x" always;\n`)
        .join('');
      const declared = mutate(
        mutate(withoutAssetsInclude, SERVER_INCLUDE, '\n'),
        ASSETS_CACHE,
        `${ASSETS_CACHE}${ownSet}`,
      );
      expect(offenderLocations(declared)).toEqual([]);
    });
  });

  describe('droplet.conf /mobile/ edge re-applies HSTS', () => {
    it('the /mobile/ proxy location carries Strict-Transport-Security', () => {
      // CSP + the rest pass through from the aquamobil upstream, but HSTS is set
      // only at this TLS edge and is dropped by the location's own add_header.
      expect(blockBody(read(DROPLET_CONF), /location\s+\/mobile\/\s*\{/)).toMatch(
        /add_header\s+Strict-Transport-Security/,
      );
    });
  });
});
