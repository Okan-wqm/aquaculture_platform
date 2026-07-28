/**
 * APA-151 — an admin-panel API function must never throw synchronously.
 *
 * `analyticsApi.getApiUsageByEndpoint`, `getEngagementMetrics`, `getFeatureUsage`
 * and `getGeographicDistribution` were non-async arrows that
 * `throw new Error('Not implemented…')` for endpoints the backend does not have.
 *
 * That is strictly worse than not existing. Every other member of these API
 * objects returns a promise from `apiFetch`, so a caller writes
 * `void fn().catch(setError)` — and a SYNCHRONOUS throw happens before any
 * promise exists, so it escapes that chain entirely and takes down the caller's
 * error handling with it. An absent method, by contrast, is a compile error at
 * the first would-be caller.
 *
 * This gate covers the whole api layer rather than the four functions that
 * happened to have it, because the mistake is easy to repeat the next time a
 * route is planned before it is built. The honest placeholder is no function.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-151
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_DIR = join(__dirname, '..', '..', 'web/modules/admin-panel/src/services/api');

/** `throw new Error('Not implemented…')` and its close relatives. */
const NOT_IMPLEMENTED_THROW = /throw\s+new\s+\w*Error\s*\(\s*['"`][^'"`]*[Nn]ot implemented/;

function apiSourceFiles(): string[] {
  return readdirSync(API_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => join(API_DIR, name));
}

describe('admin-panel API layer never throws synchronously (APA-151)', () => {
  const files = apiSourceFiles();

  it('finds the api layer to scan', () => {
    // Guards the gate itself: a moved directory would silently pass forever.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((file) => [file.split('/').pop() ?? file, file]))(
    '%s declares no not-implemented stub',
    (_name, file) => {
      // Comments are stripped first: this file's own docblock names the
      // pattern it forbids, and so would any explanation of a past removal.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const offending = source
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter((entry) => NOT_IMPLEMENTED_THROW.test(entry.line));

      expect(
        offending.map((entry) => `${file}:${entry.number}  ${entry.line.trim()}`),
      ).toEqual([]);
    },
  );
});
