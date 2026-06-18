/**
 * Platform-wide invariant — MT-CRITICAL-001 / SEC-HIGH-001 / SECREV-CRITICAL-003:
 *
 * Production code MUST NOT read tenantId from query strings, request
 * bodies, or GraphQL variables. JWT (cryptographically verified) is the
 * trust anchor; x-tenant-id header is accepted only on explicit
 * pre-auth / cross-tenant-admin / edge-ingestion paths and is gated by
 * StripInternalHeadersMiddleware.
 *
 * # Why
 *
 * MT-CRITICAL-001 reached its 3rd cycle in the 2026-04-28 audit because
 * each prior fix closed one source path while leaving siblings open:
 * round 1 closed `req.query['tenantId']` in TenantContextMiddleware,
 * round 2 closed it in the guard, round 3 found the body / GraphQL-
 * variables fallback. A make-detectable invariant catches the regression
 * class wholesale: any production code that reads `tenantId` from
 * `req.query`, `req.body`, or GraphQL variables fails CI before merge.
 *
 * # What this test enforces
 *
 *   Scan every production .ts file in apps/, libs/, platform/ (excluding
 *   tests + spec files) for the four banned patterns:
 *
 *     - req.query['tenantId']    or req.query.tenantId
 *     - request.query['tenantId'] or request.query.tenantId
 *     - body['tenantId']         or body.tenantId
 *     - variables['tenantId']    or variables.tenantId
 *
 *   The TenantIsolationGuard's extractRequestedTenantId() method has
 *   already had its query/body branches removed (W0.F); this invariant
 *   prevents a future patch from putting them back.
 *
 * # Allow-list
 *
 * A small set of files legitimately reference these patterns for
 * REJECTION purposes (e.g. logging an attempt) and are exempt by name.
 * Each entry needs a justification.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Files that legitimately reference the banned patterns. Each entry is
 * justified inline — the default expectation is zero references.
 */
const ALLOW_LIST: ReadonlyArray<{ path: string; reason: string }> = [
  // No exemptions today. Future maintainers: prefer fixing the source
  // over adding an entry. If a fix is genuinely impossible, attach an
  // ADR ID so the trade-off is reviewable.
];

const BANNED_PATTERNS = [
  /\breq\.query\s*(?:\.\s*tenantId|\[\s*['"]tenantId['"]\s*])/g,
  /\brequest\.query\s*(?:\.\s*tenantId|\[\s*['"]tenantId['"]\s*])/g,
  /\bbody\s*\[\s*['"]tenantId['"]\s*\]/g,
  /\bvariables\s*\[\s*['"]tenantId['"]\s*\]/g,
] as const;

interface Hit {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

describe('INVARIANT (MT-CRITICAL-001): no production code reads tenantId from query / body / GraphQL variables', () => {
  it('no production .ts file matches any banned tenant-source pattern', () => {
    const lsFilesOut = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
        'apps/*.ts', 'apps/**/*.ts',
        'libs/*.ts', 'libs/**/*.ts',
        'platform/*.ts', 'platform/**/*.ts'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const allow = new Set(ALLOW_LIST.map((e) => e.path));
    const files = lsFilesOut
      .split('\n')
      .filter(
        (f) =>
          f.length > 0 &&
          !f.includes('/__tests__/') &&
          !f.endsWith('.spec.ts') &&
          !f.endsWith('.test.ts') &&
          !f.endsWith('.e2e-spec.ts') &&
          !allow.has(f),
      );

    const hits: Hit[] = [];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      // Strip comments to avoid false-positives in docblock examples.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
        .join('\n');
      // Per-pattern scan + line-number tracking
      for (const pattern of BANNED_PATTERNS) {
        const lines = stripped.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (pattern.test(line)) {
            pattern.lastIndex = 0;
            hits.push({
              file: rel,
              line: i + 1,
              text: line.trim(),
              pattern: pattern.source,
            });
          }
        }
      }
    }

    if (hits.length > 0) {
      throw new Error(
        `${hits.length} production code reference(s) to a banned tenant-source pattern.\n` +
          'JWT is the trust anchor; x-tenant-id header is accepted only on explicit\n' +
          'pre-auth / cross-tenant-admin / edge-ingestion paths.\n\n' +
          hits
            .slice(0, 20)
            .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
            .join('\n') +
          (hits.length > 20 ? `\n  …+${hits.length - 20} more` : ''),
      );
    }
  });

  it('every allow-list entry references a real file', () => {
    for (const entry of ALLOW_LIST) {
      try {
        readFileSync(resolve(REPO_ROOT, entry.path), 'utf8');
      } catch {
        throw new Error(
          `no-query-param-tenant allow-list references non-existent file: ${entry.path}. ` +
            `Reason on file: ${entry.reason}`,
        );
      }
    }
  });
});
