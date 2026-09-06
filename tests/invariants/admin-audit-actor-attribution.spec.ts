/**
 * An audit row names the operator, never a literal (ADMIN-HIGH-097, from APA-247).
 *
 * A controller always has an authenticated request — every admin-api route sits
 * behind the SUPER_ADMIN guard. So an attribution field written from a
 * controller has an identity available, and a string literal in that position
 * is a placeholder somebody meant to come back to:
 *
 *   createdBy: 'admin',           // Would come from auth context
 *   createdBy: 'tenant-user-id',  // In production, would come from auth context
 *   performedBy: 'SUPER_ADMIN',   // the role, not the person
 *
 * Each one produces an audit record attributing a real operator's action to an
 * identity no account has, which is the one thing an audit trail exists to
 * prevent. The database explorer's case was the sharpest: its own comment calls
 * cross-tenant SUPER_ADMIN reads "the highest-criticality audit class" and
 * awaits the log so the access can never go unrecorded — then recorded the
 * role, so the row proves someone with the role read tenant data and not who.
 *
 * SERVICES are deliberately out of scope. A service can be driven by cron or by
 * a system path with no operator at all, and `performedBy: 'system:cron'` is the
 * honest value there. The rule is about the surface that HAS an identity and
 * declined to use it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_API_SRC = resolve(REPO_ROOT, 'apps/admin-api-service/src');

/** Fields that answer "who did this". */
const ATTRIBUTION_FIELDS = [
  'createdBy',
  'updatedBy',
  'deletedBy',
  'changedBy',
  'performedBy',
  'resolvedBy',
  'acknowledgedBy',
  'actor',
  'actorName',
] as const;

const LITERAL_ATTRIBUTION = new RegExp(
  String.raw`\b(${ATTRIBUTION_FIELDS.join('|')})\s*:\s*'[^']*'`,
);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '__tests__', 'migrations']);

function controllers(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...controllers(childAbs));
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      out.push(childAbs);
    }
  }
  return out;
}

describe('INVARIANT: admin-api audit rows name the operator (ADMIN-HIGH-097, from APA-247)', () => {
  const files = controllers(ADMIN_API_SRC);

  it('finds the controllers it is meant to govern', () => {
    // A walker that matched nothing would make the case below vacuous.
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it('writes no attribution field as a string literal', () => {
    const offenders: string[] = [];

    for (const fileAbs of files) {
      readFileSync(fileAbs, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          if (LITERAL_ATTRIBUTION.test(line)) {
            offenders.push(`${relative(REPO_ROOT, fileAbs)}:${index + 1}: ${line.trim()}`);
          }
        });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} audit write(s) attribute a hardcoded identity. A controller has ` +
          `an authenticated request: use requireAuthUserId(req) / requireAuthUserName(req) ` +
          `from apps/admin-api-service/src/shared/authenticated-request.ts, which refuse ` +
          `rather than substitute:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('leaves no degrade-to-role fallback behind either', () => {
    // `user?.id || 'SUPER_ADMIN'` passes the literal rule while still recording
    // the role whenever the guard stops populating the request.
    const offenders = files
      .filter((fileAbs) => /\?\.\s*id\s*\|\|\s*'/.test(readFileSync(fileAbs, 'utf-8')))
      .map((fileAbs) => relative(REPO_ROOT, fileAbs));

    expect(offenders).toEqual([]);
  });
});
