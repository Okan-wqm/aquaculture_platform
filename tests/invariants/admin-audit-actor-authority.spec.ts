/**
 * INVARIANT — the admin audit writer names the actor the platform verified,
 * never a string the caller supplied (ADMIN-CRITICAL-008).
 *
 * Until 2026-09-05 `AuditLogService.log()` took `performedBy` as an input
 * field, so every caller decided who acted: controllers passed
 * `user?.id || 'unknown'` or the literal 'SUPER_ADMIN', a client-writable
 * POST /activity-logs accepted `userId` / `userEmail` from the body, and the
 * writer swallowed persistence failures and returned null. The row named
 * whoever the code said, and nothing failed when no row was written.
 *
 * What holds now, and what this spec keeps true:
 *   1. The writer's entry type carries no actor, IP, agent or channel field;
 *      `record()` reads them from the AsyncLocalStorage frame the guard
 *      populated and throws when no principal is there.
 *   2. `recordForActor()` — the persisted-run continuation path — is callable
 *      from exactly the files listed here; a new caller fails the build.
 *   3. No admin-api source passes a `performedBy` to the writer, and no
 *      client-writable activity/audit POST exists.
 *   4. The ESLint rule `no-actor-in-input-dto` is registered at 'error' for
 *      admin-api, so a validated body cannot declare an actor field.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WRITER = 'apps/admin-api-service/src/audit/audit.service.ts';

/** Files allowed to record on behalf of a persisted continuation actor. */
const CONTINUATION_CALLERS: ReadonlyArray<string> = [
  'apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

/** `git grep -l`; exit status 1 means "no match". */
function gitGrepFiles(args: readonly string[]): string[] {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '--untracked', ...args], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

const ADMIN_SOURCES = ['--', 'apps/admin-api-service/src'];
const isSource = (path: string): boolean =>
  !path.endsWith('.spec.ts') && !path.includes('/__tests__/') && !/\/migrations\//.test(path);

describe('INVARIANT (ADMIN-CRITICAL-008): the admin audit writer names the verified actor', () => {
  const writer = stripComments(read(WRITER));

  it('the entry type carries no actor, IP, agent or channel field', () => {
    const entry = /export interface AuditEntry \{([\s\S]*?)\n\}/.exec(writer)?.[1] ?? '';
    expect(entry.length).toBeGreaterThan(0);
    for (const field of [
      'performedBy',
      'performedByEmail',
      'ipAddress',
      'userAgent',
      'method',
      'mfaVerified',
    ]) {
      expect(entry).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('record() reads the actor from the request frame and fails closed without one', () => {
    expect(writer).toMatch(/async record\(entry: AuditEntry\): Promise<AuditLog>/);
    expect(writer).toMatch(
      /const ctx = getRequestContext\(\);\s*if \(!ctx\.userId\) \{\s*throw new AuditActorMissingError/,
    );
    expect(writer).toMatch(/performedBy: ctx\.userId/);
    expect(writer).toMatch(/mfaVerified: ctx\.mfaVerified === true/);
    // No swallow: the writer has no try/catch around the INSERT.
    expect(writer).not.toMatch(/catch \(error\)[\s\S]*?return null/);
    expect(writer).not.toMatch(/\basync log\(/);
  });

  it('recordForActor() is called only from the persisted-run continuation', () => {
    const callers = gitGrepFiles(['-F', '-e', 'recordForActor(', ...ADMIN_SOURCES]).filter(
      (path) => isSource(path) && path !== WRITER,
    );
    expect(callers.sort()).toEqual([...CONTINUATION_CALLERS].sort());
  });

  it('no admin-api source hands the writer a performedBy', () => {
    const files = gitGrepFiles([
      '-E',
      '-e',
      'auditLogService\\.(record|recordForActor)\\(',
      ...ADMIN_SOURCES,
    ]).filter(isSource);
    expect(files.length).toBeGreaterThanOrEqual(5);
    const offenders: string[] = [];
    for (const path of files) {
      const src = stripComments(read(path));
      for (const match of src.matchAll(
        /auditLogService\.(?:record|recordForActor)\(([\s\S]*?)\n\s*\}\);/g,
      )) {
        if (/\bperformedBy\s*:/.test(match[1] ?? '')) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no client-writable activity or audit POST exists', () => {
    for (const controller of [
      'apps/admin-api-service/src/security/controllers/activity-log.controller.ts',
      'apps/admin-api-service/src/audit/audit.controller.ts',
    ]) {
      const src = stripComments(read(controller));
      expect(src).not.toMatch(/@Post\(\)\s*(@HttpCode\([^)]*\)\s*)?async logActivity\(/);
      expect(src).not.toMatch(/\bLogActivityDto\b/);
      expect(src).not.toMatch(/\blogActivityImmediate\b/);
    }
  });

  it('the no-actor-in-input-dto rule is registered at error for admin-api', () => {
    const config = read('eslint.config.mjs');
    expect(config).toMatch(
      /files: \['apps\/admin-api-service\/src\/\*\*\/\*\.ts'\][\s\S]*?'aquaculture\/no-actor-in-input-dto': 'error'/,
    );
    expect(read('tools/eslint-rules/index.ts')).toContain(
      "'no-actor-in-input-dto': noActorInInputDto",
    );
  });
});
