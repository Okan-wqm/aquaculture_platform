/**
 * INVARIANT — platform-admin MFA has one switch and one mechanism
 * (ADR-0011, SEC-CRITICAL-058).
 *
 * The mechanism ships now; enforcement is dated. What this spec keeps true:
 *
 *   1. auth-service's TokenService refuses a SUPER_ADMIN token for an
 *      un-enrolled account once the switch has passed, and names the account
 *      in a security event before then — asserted as unit behaviour in the
 *      service's own spec, whose test titles are pinned here so the behaviour
 *      cannot be deleted with its test.
 *   2. Every irreversible admin handler — a DELETE, or a handler named
 *      erase / archive / purge / drop / release / export / terminate /
 *      revoke / rollback / deprovision — carries @Destructive(), which
 *      installs DestructiveActionGuard itself. Public (unauthenticated)
 *      handlers are exempt: a password-reset by token has no principal.
 *   3. The switch is the only switch: no committed compose or env file sets
 *      MFA_REQUIRED_FOR_CROSS_TENANT=false, and the auth-service compose
 *      entry states SUPER_ADMIN_MFA_ENFORCED_AT as a literal that parses.
 *   4. `security.mfa_enabled` has no reader anywhere: an operator toggle for
 *      a mandatory control is gone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

import { parsePlatformAdminMfaPolicy } from '../../libs/backend-common/src/security/platform-admin-mfa-policy';

import { allAdminMutationHandlers } from './lib/admin-mutation-handlers';

const REPO_ROOT = resolve(__dirname, '..', '..');

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

function gitFiles(pathspecs: string[]): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
}

function gitGrepFiles(args: string[]): string[] {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '--untracked', ...args], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

const IRREVERSIBLE_NAME =
  /(erase|archive|purge|drop|release|export|terminate|revoke|rollback|deprovision)/i;

describe('INVARIANT (ADR-0011): platform-admin MFA — one switch, one mechanism', () => {
  it('auth-service refuses or records an un-enrolled SUPER_ADMIN at token issue, and its spec proves both', () => {
    const service = stripComments(
      read('apps/auth-service/src/modules/authentication/services/token.service.ts'),
    );
    expect(service).toMatch(/user\.role === Role\.SUPER_ADMIN && !user\.mfaEnabled/);
    expect(service).toMatch(/readPlatformAdminMfaPolicy\(\)/);
    expect(service).toMatch(/if \(policy\.enforced\) \{\s*throw new ForbiddenException/);
    const spec = read(
      'apps/auth-service/src/modules/authentication/services/token.service.spec.ts',
    );
    expect(spec).toContain(
      'refuses a SUPER_ADMIN token for an un-enrolled account once enforcement has started',
    );
    expect(spec).toContain(
      'records an un-enrolled SUPER_ADMIN in detective mode and still mints the token',
    );
  });

  it('every irreversible admin handler carries @Destructive(), which installs its own guard', () => {
    const decorator = stripComments(
      read('libs/backend-common/src/decorators/destructive.decorator.ts'),
    );
    expect(decorator).toMatch(/UseGuards\(DestructiveActionGuard\)/);
    const unguarded: string[] = [];
    for (const handler of allAdminMutationHandlers()) {
      const irreversible = handler.verb === 'Delete' || IRREVERSIBLE_NAME.test(handler.name);
      if (!irreversible || handler.isPublic) continue;
      if (!/@Destructive\(/.test(handler.block)) unguarded.push(handler.id);
    }
    expect(unguarded).toEqual([]);
  });

  it('the destructive-event sink is bound globally in admin-api so detective mode leaves a row', () => {
    const auditModule = stripComments(read('apps/admin-api-service/src/audit/audit.module.ts'));
    expect(auditModule).toMatch(/provide: DESTRUCTIVE_EVENT_SINK/);
    expect(auditModule).toMatch(/@Global\(\)/);
    expect(auditModule).toMatch(/exports: \[[^\]]*DESTRUCTIVE_EVENT_SINK/);
  });

  it('no committed compose or env file switches cross-tenant MFA off', () => {
    const offenders = gitGrepFiles([
      '-E',
      '-e',
      "MFA_REQUIRED_FOR_CROSS_TENANT[=:]\\s*'?false'?",
      '--',
      '*.yml',
      '*.yaml',
      '*.env',
      '*.env.*',
      '.env*',
    ]);
    expect(offenders).toEqual([]);
  });

  it('auth-service states SUPER_ADMIN_MFA_ENFORCED_AT in the droplet compose as a literal that parses', () => {
    const doc = yaml.load(read('docker-compose.droplet.yml')) as {
      services?: Record<string, { environment?: Record<string, unknown> }>;
    };
    const raw = doc.services?.['auth-service']?.environment?.['SUPER_ADMIN_MFA_ENFORCED_AT'];
    expect(typeof raw).toBe('string');
    expect(String(raw)).not.toMatch(/\$\{/);
    expect(() => parsePlatformAdminMfaPolicy(String(raw), true)).not.toThrow();
  });

  it('security.mfa_enabled has no reader left', () => {
    const readers = gitGrepFiles([
      '-F',
      '-e',
      'security.mfa_enabled',
      '--',
      'apps',
      'libs',
      'web',
      'platform',
    ]).filter((path) => !/\/migrations\//.test(path));
    expect(readers).toEqual([]);
  });
});
