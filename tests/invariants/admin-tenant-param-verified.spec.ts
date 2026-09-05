/**
 * INVARIANT — on the platform-admin surface a tenant id is a verified
 * identity, never a transport value (ADMIN-CRITICAL-009).
 *
 * Until 2026-09-05 roughly 115 admin handlers took `tenantId` straight from
 * a route param, the query string or a validated body and attached it to
 * money, messages, configuration, exports and destructive operations: any
 * UUID, any lifecycle state, possibly no tenant at all. Now:
 *
 *   1. no admin controller reads `@Param('tenantId')` / `@Query('tenantId')`,
 *      and the tenant controller's `:id` routes use @TenantParam too
 *      (the ESLint rule `no-unverified-tenant-param` is the editor-time half;
 *      this is the CI half, and it also pins the rule's registration);
 *   2. `@TenantParam` attaches VerifiedTenantPipe itself, and the pipe reads
 *      the kernel TENANT_ACTIVE_CHECK port — resolution is not optional;
 *   3. admin-api binds that port from its read-only auth.tenants mapping in
 *      a @Global module, so the pipe resolves in every feature module.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const ADMIN_CONTROLLERS = 'apps/admin-api-service/src/**/*.controller.ts';

describe('INVARIANT (ADMIN-CRITICAL-009): admin tenant ids are verified before any handler runs', () => {
  it('no admin controller reads a raw tenantId param or query', () => {
    const offenders = gitGrepFiles([
      '-E',
      "@(Param|Query)\\('(tenantId|tenant_id)'",
      '--',
      ADMIN_CONTROLLERS,
    ]).filter((f) => !f.endsWith('.spec.ts'));
    expect(offenders).toEqual([]);
  });

  it("the tenant controller's :id routes resolve through @TenantParam, not @Param('id')", () => {
    const src = stripComments(read('apps/admin-api-service/src/tenant/tenant.controller.ts'));
    expect(src).not.toMatch(/@Param\('id'/);
    expect(src).toMatch(/@TenantParam\('param', \{ key: 'id'/);
  });

  it('no validated admin input DTO carries a tenantId property', () => {
    const files = gitGrepFiles([
      '-E',
      '^\\s*tenantId[!?]?:',
      '--',
      'apps/admin-api-service/src',
    ]).filter((f) => !f.endsWith('.spec.ts') && !/__tests__|entities\/|\.entity\.ts/.test(f));
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(read(file));
      for (const match of src.matchAll(/class\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
        const [, name, body] = match;
        if (!name || !body) continue;
        if (/^(Query|Filter|Search)[A-Z]|(Query|Filter|Search)Dto$/.test(name)) continue;
        const validated =
          /@(Is[A-Z]\w*|Validate\w*|Matches|Length|MinLength|MaxLength|Min|Max)\(/.test(body);
        // `@TenantIdCarrier() readonly tenantId?: undefined` is the whitelisted, unreadable carrier key.
        const readable = /^\s*(?!readonly tenantId\?: undefined)(?:readonly )?tenantId[!?]?:/m.test(
          body,
        );
        if (validated && readable) offenders.push(`${file}#${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('@TenantParam attaches VerifiedTenantPipe, and the pipe requires the kernel port', () => {
    const decorator = stripComments(
      read('libs/backend-common/src/decorators/tenant-param.decorator.ts'),
    );
    expect(decorator).toMatch(/RawTenantParam\(\s*\{[\s\S]*\},\s*VerifiedTenantPipe,\s*\)/);
    const pipe = stripComments(read('libs/backend-common/src/tenant/verified-tenant.pipe.ts'));
    expect(pipe).toMatch(
      /@Inject\(TENANT_ACTIVE_CHECK\) private readonly tenants: TenantActiveCheck/,
    );
    expect(pipe).not.toMatch(/@Optional\(\)/);
    expect(pipe).toMatch(/throw new NotFoundException/);
    expect(pipe).toMatch(
      /TENANT_PARAM_MUTATION_DEFAULT_ALLOW: readonly TenantStatus\[\] = \[TenantStatus\.ACTIVE\]/,
    );
  });

  it('admin-api binds TENANT_ACTIVE_CHECK from auth.tenants in a global module the app imports', () => {
    const module = stripComments(read('apps/admin-api-service/src/tenant/tenant-lookup.module.ts'));
    expect(module).toMatch(/@Global\(\)/);
    expect(module).toMatch(/provide: TENANT_ACTIVE_CHECK, useExisting: TenantLookupService/);
    expect(module).toMatch(/exports: \[[^\]]*TENANT_ACTIVE_CHECK[^\]]*VerifiedTenantPipe/);
    const app = stripComments(read('apps/admin-api-service/src/app.module.ts'));
    expect(app).toMatch(/\bTenantLookupModule,/);
  });

  it('the lint rule is registered, tested and enforced on the admin surface', () => {
    expect(read('tools/eslint-rules/index.ts')).toMatch(
      /'no-unverified-tenant-param': noUnverifiedTenantParam/,
    );
    expect(read('tools/lint-gates/custom-rules.spec.ts')).toMatch(/'no-unverified-tenant-param',/);
    const config = read('eslint.config.mjs');
    expect(config).toMatch(/'aquaculture\/no-unverified-tenant-param': 'error'/);
  });
});
