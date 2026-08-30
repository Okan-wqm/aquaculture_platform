/**
 * SENSOR-CRITICAL-002 residual — SSoT for IP-pinned outbound HTTP.
 *
 * `SsrfValidatorService.safeFetch` (validate host + PIN the resolved IP) is the
 * single path for operator/tenant-controlled fetches. A plain `fetch(hostname)`
 * after validation re-opens the DNS-rebinding window. This invariant fails if a
 * migrated caller reverts to a bare `fetch()` / `getSafeFetchOptions()`, if the
 * removed `getSafeFetchOptions` helper is reintroduced, or if the lint guard is
 * unwired.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const VALIDATOR = 'libs/backend-common/src/ai-safety/ssrf-validator.service.ts';

// Callers of operator/tenant-controlled URLs migrated to safeFetch in the same
// change that removed getSafeFetchOptions.
const MIGRATED_CALLERS = [
  'apps/sensor-service/src/protocol/adapters/iot/http-rest.adapter.ts',
  'apps/notification-service/src/notification/services/notification-dispatcher.service.ts',
] as const;

describe('INVARIANT (SENSOR-CRITICAL-002): operator-controlled fetches are IP-pinned via safeFetch', () => {
  it('SsrfValidatorService exposes safeFetch and no longer exposes getSafeFetchOptions', () => {
    const src = readSrc(VALIDATOR);
    expect(src).toContain('async safeFetch(');
    expect(stripComments(src)).not.toContain('getSafeFetchOptions');
  });

  it.each(MIGRATED_CALLERS)(
    '%s routes through safeFetch with no bare fetch()/getSafeFetchOptions',
    (file) => {
      const code = stripComments(readSrc(file));
      expect(code).toContain('.safeFetch(');
      expect(code).not.toContain('getSafeFetchOptions');
      // No bare global fetch( — dotted method calls (`.safeFetch(`, `.prefetch(`)
      // are excluded by the lookbehind on `.`/word-char.
      expect(code).not.toMatch(/(?<![.\w])fetch\s*\(/);
    },
  );

  it('the no-unpinned-ssrf-fetch lint rule exists, is registered, and is wired at error severity', () => {
    expect(() => readSrc('tools/eslint-rules/rules/no-unpinned-ssrf-fetch.ts')).not.toThrow();
    expect(readSrc('tools/eslint-rules/index.ts')).toContain("'no-unpinned-ssrf-fetch'");
    expect(readSrc('eslint.config.mjs')).toContain("'aquaculture/no-unpinned-ssrf-fetch': 'error'");
  });
});
