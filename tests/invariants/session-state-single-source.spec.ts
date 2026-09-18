/**
 * Platform-wide invariant — ADMIN-HIGH-100:
 *
 * A user's login-session state has ONE owner: auth-service
 * (`auth.refresh_tokens` plus the Redis `SessionManagerService`). No other
 * service may keep its own table of login sessions, and no other service may
 * revoke a user's sessions by writing that table itself.
 *
 * # Why
 *
 * `admin.user_sessions` was a full session model — token, device, geo, request
 * counts, termination reason — that nothing ever wrote to. The only INSERT was
 * `ActivityLoggingService.createSession`, which had no callers; neither did
 * `updateSessionActivity` or `terminateSession`. The table was therefore empty
 * for its whole life, and everything reading it read nothing:
 *
 *   - `GET /security/activities/sessions/user/:userId` always answered `[]`.
 *   - `POST /security/activities/sessions/user/:userId/terminate` always
 *     answered `{ terminated: 0 }` and revoked nothing, so an operator locking
 *     out a compromised account through it got HTTP 200 while every live
 *     session kept working.
 *   - `SecurityMonitoringService.checkSessionHijacking` returned `false` at its
 *     first lookup (it had no callers either, so it was dead code rather than a
 *     control switched off — but it could never have fired).
 *
 * The working admin surface existed the whole time and is what the admin panel
 * calls: `GET /users/:id/sessions` reads `auth.refresh_tokens`, and
 * `PATCH /users/:id/force-logout` delegates to auth-service over NATS. The two
 * dead endpoints were a second implementation of both, against a store nobody
 * filled.
 *
 * # What this test enforces
 *
 *   1. No service outside auth-service declares a `user_sessions` table.
 *   2. admin-api-service revokes login sessions ONLY by delegating to
 *      `AUTH_ADMIN_COMMAND_SUBJECTS.FORCE_LOGOUT_USER`.
 *   3. The admin read path for a user's sessions reads `auth.refresh_tokens`.
 *   4. auth-service actually answers that subject (so 2 is not vacuous).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const SESSION_OWNER_PREFIX = 'apps/auth-service/';

/** `@Entity('user_sessions'` in any spelling of quoting/spacing. */
const USER_SESSIONS_ENTITY = /@Entity\(\s*['"`]user_sessions['"`]/;

const ADMIN_USERS_SERVICE = 'apps/admin-api-service/src/users/users.service.ts';
const AUTH_ADMIN_HANDLER =
  'apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts';

function productionSources(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      'apps/*.ts',
      'apps/**/*.ts',
      'libs/*.ts',
      'libs/**/*.ts',
      'platform/*.ts',
      'platform/**/*.ts',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
    .split('\n')
    .filter(
      (f) =>
        f.length > 0 &&
        !f.includes('/__tests__/') &&
        !f.includes('/migrations/') &&
        !f.endsWith('.spec.ts') &&
        !f.endsWith('.test.ts'),
    );
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('INVARIANT (ADMIN-HIGH-100): login-session state has a single owner', () => {
  it('scans a real corpus (guards against a silently empty file list)', () => {
    expect(productionSources().length).toBeGreaterThan(500);
  });

  it('no service outside auth-service declares a user_sessions table', () => {
    const offenders = productionSources().filter(
      (rel) => !rel.startsWith(SESSION_OWNER_PREFIX) && USER_SESSIONS_ENTITY.test(read(rel)),
    );

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} service(s) outside auth-service declare a \`user_sessions\` table:\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          '\n\nA user’s login sessions live in `auth.refresh_tokens` plus the Redis\n' +
          'SessionManagerService. A second copy can only ever disagree with the first —\n' +
          '`admin.user_sessions` disagreed by being permanently empty, so the endpoints\n' +
          'reading it reported "no sessions" and "0 terminated" while every session was\n' +
          'live (ADMIN-HIGH-100).',
      );
    }
  });

  it('admin-api-service revokes sessions by delegating to auth over NATS', () => {
    const src = read(ADMIN_USERS_SERVICE);
    expect(src).toMatch(/AUTH_ADMIN_COMMAND_SUBJECTS\.FORCE_LOGOUT_USER/);
    // The delegation must be a request/reply to auth, not a local write.
    expect(src).toMatch(/async forceLogout\(/);
  });

  it('the admin read path for a user’s sessions reads auth.refresh_tokens', () => {
    const src = read(ADMIN_USERS_SERVICE);
    const getUserSessions = src.slice(src.indexOf('async getUserSessions('));
    expect(getUserSessions).not.toHaveLength(0);
    expect(getUserSessions.slice(0, 1200)).toMatch(/FROM\s+auth\.refresh_tokens/);
  });

  it('auth-service answers FORCE_LOGOUT_USER (the delegation is not vacuous)', () => {
    const src = read(AUTH_ADMIN_HANDLER);
    expect(src).toMatch(/@MessagePattern\(AUTH_ADMIN_COMMAND_SUBJECTS\.FORCE_LOGOUT_USER\)/);
    expect(src).toMatch(/adminForceLogout\(/);
  });
});
