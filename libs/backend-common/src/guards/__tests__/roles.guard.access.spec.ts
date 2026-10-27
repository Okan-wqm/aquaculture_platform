import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  MODULE_ACCESS_DENIED_METRIC,
  MODULE_ACCESS_DENIED_REGISTRY,
} from '../../metrics/module-access-denied.metrics';
import { RolesGuard, type RolesGuardEnrolment } from '../roles.guard';

import {
  FixtureController,
  FixtureResolver,
  SensorClassResolver,
  graphqlContext,
  httpContext,
  member,
  type FixtureUser,
} from './access-context.fixture';
import { ACCOUNT_ROLE_CASES } from './account-role.cases';

/**
 * RolesGuard under ADR-051 (RBAC-HIGH-031; plan PKG-05, roles.guard.access.spec.ts):
 *   - `account-role` mode keeps today's outcomes (the cases of roles.guard.ts before PKG-05);
 *   - `module-access` mode decides the handler's `@Access` spec through decideAccess, with
 *     `@Roles` checked by kind: module roles by the caller's role in the spec's module, account
 *     roles by the account role, so the global `users.role` never grants module access;
 *   - the guard leaves `req` unchanged in both modes.
 */

const MODULE_ACCESS: RolesGuardEnrolment = { service: 'hr-service', mode: 'module-access' };
const ACCOUNT_ROLE: RolesGuardEnrolment = { service: 'hr-service', mode: 'account-role' };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}

/** A frozen request: any write the guard attempted would throw in strict mode. */
function requestWith(user: FixtureUser | undefined, method = 'POST'): object {
  return deepFreeze(user === undefined ? { method } : { method, user: { ...user } });
}

function outcome(guard: RolesGuard, context: ExecutionContext): 'allowed' | 'forbidden' | 'bad' {
  try {
    return guard.canActivate(context) ? 'allowed' : 'forbidden';
  } catch (error: unknown) {
    if (error instanceof ForbiddenException) return 'forbidden';
    if (error instanceof BadRequestException) return 'bad';
    throw error;
  }
}

async function deniedCount(service: string, specKind: string): Promise<number> {
  const metric = MODULE_ACCESS_DENIED_REGISTRY.getSingleMetric(MODULE_ACCESS_DENIED_METRIC);
  if (metric === undefined) throw new Error(`${MODULE_ACCESS_DENIED_METRIC} is not registered`);
  const { values } = await metric.get();
  const sample = values.find(
    (entry) => entry.labels['service'] === service && entry.labels['spec_kind'] === specKind,
  );
  return sample === undefined ? 0 : sample.value;
}

describe('RolesGuard — account-role mode keeps today’s outcomes', () => {
  const guards: ReadonlyArray<[string, RolesGuard]> = [
    ['built by dependency injection (no enrolment)', new RolesGuard(new Reflector())],
    ['built with an account-role enrolment', new RolesGuard(new Reflector(), ACCOUNT_ROLE)],
  ];

  describe.each(guards)('%s', (_label, guard) => {
    it.each(ACCOUNT_ROLE_CASES.map((row) => [row.name, row] as const))('%s', (_name, row) => {
      const context = graphqlContext(FixtureResolver, row.handler, requestWith(row.user));
      expect(outcome(guard, context)).toBe(row.allowed ? 'allowed' : 'forbidden');
    });
  });
});

describe('RolesGuard — module-access mode decides @Access with @Roles by kind', () => {
  const guard = new RolesGuard(new Reflector(), MODULE_ACCESS);

  function decide(handler: string, user: FixtureUser | undefined): 'allowed' | 'forbidden' | 'bad' {
    return outcome(guard, graphqlContext(FixtureResolver, handler, requestWith(user)));
  }

  it('denies a handler without @Access, even for a TENANT_ADMIN', () => {
    expect(decide('unclassified', member({ roles: ['TENANT_ADMIN'] }))).toBe('forbidden');
    expect(decide('noRoles', member({ roles: ['TENANT_ADMIN'] }))).toBe('forbidden');
  });

  it('admits a @Public handler without a user', () => {
    expect(decide('health', undefined)).toBe('allowed');
  });

  it('denies an unauthenticated request to a classified handler', () => {
    expect(decide('batches', undefined)).toBe('forbidden');
  });

  it('never lets the global MODULE_MANAGER role reach hr payrolls (RBAC-HIGH-031)', () => {
    expect(decide('payrolls', member({ roles: ['MODULE_MANAGER'] }))).toBe('forbidden');
    expect(
      decide(
        'payrolls',
        member({ roles: ['MODULE_MANAGER'], moduleAccess: { farm: 'MODULE_MANAGER' } }),
      ),
    ).toBe('forbidden');
  });

  it('admits payrolls for an hr manager grant whatever the global role', () => {
    expect(decide('payrolls', member({ moduleAccess: { hr: 'MODULE_MANAGER' } }))).toBe('allowed');
  });

  it('denies payrolls to an hr MODULE_USER grant (the module-role hierarchy)', () => {
    expect(decide('payrolls', member({ moduleAccess: { hr: 'MODULE_USER' } }))).toBe('forbidden');
  });

  it('checks a TENANT_ADMIN-only farm operation by the account role only', () => {
    const farmManager = member({
      roles: ['MODULE_MANAGER'],
      moduleAccess: { farm: 'MODULE_MANAGER' },
    });
    const tenantAdmin = member({
      roles: ['TENANT_ADMIN'],
      moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
    });
    expect(decide('archiveFinanceCategory', farmManager)).toBe('forbidden');
    expect(decide('archiveFinanceCategory', tenantAdmin)).toBe('allowed');
  });

  it('applies the module-role hierarchy within the spec’s module', () => {
    expect(decide('batches', member({ moduleAccess: { farm: 'MODULE_MANAGER' } }))).toBe('allowed');
    expect(decide('closeBatch', member({ moduleAccess: { farm: 'MODULE_USER' } }))).toBe(
      'forbidden',
    );
    expect(decide('closeBatch', member({ moduleAccess: { farm: 'MODULE_MANAGER' } }))).toBe(
      'allowed',
    );
  });

  it('denies a module the tenant administrator’s claim does not list (module disabled)', () => {
    const adminWithoutHr = member({
      roles: ['TENANT_ADMIN'],
      moduleAccess: { farm: 'MODULE_MANAGER' },
    });
    expect(decide('payrolls', adminWithoutHr)).toBe('forbidden');
  });

  it('reads the handler spec over the class spec', () => {
    const farmOnly = requestWith(member({ moduleAccess: { farm: 'MODULE_USER' } }));
    expect(outcome(guard, graphqlContext(SensorClassResolver, 'readings', farmOnly))).toBe(
      'forbidden',
    );
    expect(outcome(guard, graphqlContext(SensorClassResolver, 'farmOverride', farmOnly))).toBe(
      'allowed',
    );
  });

  it('denies a self, company or account handler that also names @Roles', () => {
    expect(decide('myProfile', member())).toBe('allowed');
    expect(decide('myProfileWithRoles', member({ roles: ['TENANT_ADMIN'] }))).toBe('forbidden');
  });

  it('decides intent: a Company Query passes with company:view, a Company Mutation never does', () => {
    const companyViewer = member({ resourcePermissions: ['company:view'] });
    expect(decide('companyTree', companyViewer)).toBe('allowed');
    expect(decide('renameCompany', companyViewer)).toBe('forbidden');
    expect(decide('renameCompany', member({ roles: ['TENANT_ADMIN'] }))).toBe('forbidden');
    expect(decide('companyTree', member({ moduleAccess: { farm: 'MODULE_MANAGER' } }))).toBe(
      'forbidden',
    );
  });

  it('decides intent over REST: GET reads, POST writes', () => {
    const companyViewer = member({ resourcePermissions: ['company:view'] });
    expect(
      outcome(guard, httpContext(FixtureController, 'read', requestWith(companyViewer, 'GET'))),
    ).toBe('allowed');
    expect(
      outcome(guard, httpContext(FixtureController, 'write', requestWith(companyViewer, 'POST'))),
    ).toBe('forbidden');
    expect(
      outcome(
        guard,
        httpContext(FixtureController, 'unclassified', requestWith(companyViewer, 'GET')),
      ),
    ).toBe('forbidden');
  });

  it('decides an account capability from the verified capabilities', () => {
    expect(decide('createTenantRole', member({ resourcePermissions: ['roles:create'] }))).toBe(
      'allowed',
    );
    expect(decide('createTenantRole', member())).toBe('forbidden');
  });

  it.each([
    ['moduleAccess naming an account role', { moduleAccess: { farm: 'TENANT_ADMIN' } }],
    ['moduleAccess naming a module that owns no data', { moduleAccess: { alert: 'MODULE_USER' } }],
    ['roles as a string', { roles: 'TENANT_ADMIN' }],
    ['resourcePermissions as a string', { resourcePermissions: 'roles:create' }],
    ['assignedSiteIds holding a number', { assignedSiteIds: [42] }],
  ])('answers a malformed claim (%s) with 400', (_label, claim) => {
    expect(decide('batches', member(claim))).toBe('bad');
  });

  it('counts each denial in module_access_denied_total by service and spec kind', async () => {
    const unclassifiedBefore = await deniedCount('hr-service', 'unclassified');
    const moduleBefore = await deniedCount('hr-service', 'module');
    decide('unclassified', member());
    decide('payrolls', member({ roles: ['MODULE_MANAGER'] }));
    decide('payrolls', member({ moduleAccess: { hr: 'MODULE_MANAGER' } }));
    expect(await deniedCount('hr-service', 'unclassified')).toBe(unclassifiedBefore + 1);
    expect(await deniedCount('hr-service', 'module')).toBe(moduleBefore + 1);
  });
});

describe('RolesGuard — stores nothing on the request', () => {
  it.each([
    ['account-role', ACCOUNT_ROLE],
    ['module-access', MODULE_ACCESS],
  ])('%s: the request is identical before and after, allowed or denied', (_mode, enrolment) => {
    const guard = new RolesGuard(new Reflector(), enrolment);
    for (const handler of ['payrolls', 'batches', 'unclassified', 'noRoles']) {
      const user = member({ moduleAccess: { farm: 'MODULE_USER' } });
      const request = { method: 'POST', user: { ...user } };
      const before = JSON.stringify(request);
      const keys = Reflect.ownKeys(request);
      // The frozen copy proves no write was attempted; the plain one that none happened.
      outcome(guard, graphqlContext(FixtureResolver, handler, requestWith(user)));
      outcome(guard, graphqlContext(FixtureResolver, handler, request));
      expect(JSON.stringify(request)).toBe(before);
      expect(Reflect.ownKeys(request)).toEqual(keys);
    }
  });
});
