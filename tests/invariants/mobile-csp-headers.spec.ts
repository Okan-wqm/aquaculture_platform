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

const REPO_ROOT = resolve(__dirname, '..', '..');
const SNIPPET = 'infrastructure/docker/nginx/snippets/security-headers.conf';
const AQUAMOBIL_CONF = 'infrastructure/docker/nginx/aquamobil.conf';
const DOCKERFILE = 'infrastructure/docker/Dockerfile.aquamobil';
const DROPLET_CONF = 'infrastructure/nginx/droplet.conf';
const INCLUDE_DIRECTIVE = 'include /etc/nginx/snippets/security-headers.conf';

function read(rel: string): string {
  const path = resolve(REPO_ROOT, rel);
  if (!existsSync(path)) throw new Error(`${rel} does not exist`);
  return readFileSync(path, 'utf8');
}

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
      expect(blockBody(conf, /location\s*~\*\s*\^\/\(messaging-sw\|firebase-messaging-sw\)/)).toContain(
        INCLUDE_DIRECTIVE,
      );
      expect(blockBody(conf, /location\s*=\s*\/sw\.js\s*\{/)).toContain(INCLUDE_DIRECTIVE);
    });

    it('no Cache-Control-overriding location is left without the security include (regression guard)', () => {
      // Every block that sets its own Cache-Control add_header drops the inherited
      // security set, so it MUST re-include the snippet.
      const offenders: string[] = [];
      const locationRe = /location[^\n{]*\{/g;
      let m: RegExpExecArray | null;
      while ((m = locationRe.exec(conf)) !== null) {
        const body = blockBody(conf, new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) ?? '';
        // Only top-level-ish blocks that override Cache-Control matter; skip the
        // /health JSON endpoint (it sets Content-Type, not Cache-Control).
        if (/add_header\s+Cache-Control/.test(body) && !body.includes(INCLUDE_DIRECTIVE)) {
          offenders.push(m[0]);
        }
      }
      expect(offenders).toEqual([]);
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
