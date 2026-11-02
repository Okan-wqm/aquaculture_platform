/**
 * Pay and HR finance are decided as hr module data, by the module grant (owner decision D6;
 * ADR-054 draft one-way door 2; HR-CRITICAL-065, RBAC-HIGH-031).
 *
 * While hr-service is `account-role`, RolesGuard admits a payroll or HR finance call by the
 * tenant-wide `users.role`, which Assign Manager sets to MODULE_MANAGER for a manager of ANY
 * module. Each of these operations therefore also takes `@AccessCaller()`, which decides its
 * `@Access.module('hr')` spec with its `@Roles` against the verified `moduleAccess` claim. This
 * spec runs that parameter's own factory, as Nest registered it on the real handler, for the
 * viewers D6 separates: only TENANT_ADMIN (whose claim lists hr when the tenant has it enabled) and
 * the holder of an hr MODULE_MANAGER grant pass. The global role guard in front of it is
 * unchanged and is characterized by e2e/tests/security/module-access-layers.expected.ts.
 */
import { AccessCaller } from '@aquaculture/backend-common/decorators';
import { isAccessCaller } from '@aquaculture/backend-common/security';
import {
  runGraphqlParamDecorator,
  takesParamDecorator,
} from '../../common/__tests__/run-param-decorator';
import { ForbiddenException } from '@nestjs/common';

import { HRResolver } from '../../hr/hr.resolver';
import { HrFinanceResolver } from '../resolvers/hr-finance.resolver';

type ResolverClass = typeof HRResolver | typeof HrFinanceResolver;

interface Claims {
  readonly role: string;
  readonly moduleAccess?: Readonly<Record<string, string>>;
}

function decide(cls: ResolverClass, method: string, claims: Claims): unknown {
  const user = {
    sub: 'user-1',
    tenantId: 'tenant-1',
    role: claims.role,
    roles: [claims.role],
    ...(claims.moduleAccess === undefined ? {} : { moduleAccess: claims.moduleAccess }),
  };
  return runGraphqlParamDecorator(AccessCaller, cls, method, { user });
}

const TENANT_ADMIN: Claims = {
  role: 'TENANT_ADMIN',
  moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
};
const HR_MANAGER: Claims = { role: 'MODULE_MANAGER', moduleAccess: { hr: 'MODULE_MANAGER' } };

/** Every viewer D6 shuts out of pay, and why. */
const SHUT_OUT: ReadonlyArray<readonly [string, Claims]> = [
  [
    'a farm manager (global MODULE_MANAGER)',
    { role: 'MODULE_MANAGER', moduleAccess: { farm: 'MODULE_MANAGER' } },
  ],
  [
    'a sensor manager (global MODULE_MANAGER)',
    { role: 'MODULE_MANAGER', moduleAccess: { sensor: 'MODULE_MANAGER' } },
  ],
  ['a global MODULE_MANAGER with no grant at all', { role: 'MODULE_MANAGER', moduleAccess: {} }],
  [
    'a designated hr manager who is not its primary manager (hr MODULE_USER grant)',
    { role: 'MODULE_MANAGER', moduleAccess: { hr: 'MODULE_USER' } },
  ],
  ['a token minted before the moduleAccess claim existed', { role: 'MODULE_MANAGER' }],
  [
    'a TENANT_ADMIN of a tenant without hr enabled',
    { role: 'TENANT_ADMIN', moduleAccess: { farm: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' } },
  ],
];

/** The operations open to TENANT_ADMIN and the hr manager: `@Roles(TENANT_ADMIN, MODULE_MANAGER)`. */
const MANAGER_PAY_OPERATIONS: ReadonlyArray<readonly [ResolverClass, string]> = [
  [HRResolver, 'getPayrolls'],
  [HRResolver, 'getPendingPayrolls'],
  [HRResolver, 'createPayroll'],
  [HRResolver, 'approvePayroll'],
  [HrFinanceResolver, 'hrPersonnelTable'],
  [HrFinanceResolver, 'hrLabourCost'],
  [HrFinanceResolver, 'hrFinanceSummary'],
  [HrFinanceResolver, 'hrFinanceCategories'],
  [HrFinanceResolver, 'hrFinanceEntries'],
  [HrFinanceResolver, 'payrollCostSettings'],
  [HrFinanceResolver, 'createHrFinanceEntry'],
  [HrFinanceResolver, 'updateHrFinanceEntry'],
  [HrFinanceResolver, 'deleteHrFinanceEntry'],
  [HrFinanceResolver, 'createHrFinanceCategory'],
  [HrFinanceResolver, 'updateHrFinanceCategory'],
];

/** The settings and archival writes `@Roles(TENANT_ADMIN)` keeps to the tenant admin. */
const ADMIN_PAY_OPERATIONS: ReadonlyArray<readonly [ResolverClass, string]> = [
  [HrFinanceResolver, 'archiveHrFinanceCategory'],
  [HrFinanceResolver, 'restoreHrFinanceCategory'],
  [HrFinanceResolver, 'updatePayrollCostSettings'],
];

const ALL_PAY_OPERATIONS = [...MANAGER_PAY_OPERATIONS, ...ADMIN_PAY_OPERATIONS].map(
  ([cls, method]) => [`${cls.name}.${method}`, cls, method] as const,
);

describe('pay and HR finance: decided by the hr grant (D6, HR-CRITICAL-065)', () => {
  it.each(ALL_PAY_OPERATIONS)('%s takes @AccessCaller()', (_name, cls, method) => {
    expect(takesParamDecorator(AccessCaller, cls, method)).toBe(true);
  });

  it.each(ALL_PAY_OPERATIONS)(
    '%s admits TENANT_ADMIN of a tenant with hr',
    (_name, cls, method) => {
      expect(isAccessCaller(decide(cls, method, TENANT_ADMIN))).toBe(true);
    },
  );

  describe.each(SHUT_OUT)('%s', (_viewer, claims) => {
    it.each(ALL_PAY_OPERATIONS)('is refused %s', (_name, cls, method) => {
      expect(() => decide(cls, method, claims)).toThrow(ForbiddenException);
    });
  });

  it.each(
    MANAGER_PAY_OPERATIONS.map(([cls, method]) => [`${cls.name}.${method}`, cls, method] as const),
  )('%s admits the hr manager (hr MODULE_MANAGER grant)', (_name, cls, method) => {
    expect(isAccessCaller(decide(cls, method, HR_MANAGER))).toBe(true);
  });

  it.each(
    ADMIN_PAY_OPERATIONS.map(([cls, method]) => [`${cls.name}.${method}`, cls, method] as const),
  )('%s stays TENANT_ADMIN only: the hr manager is refused', (_name, cls, method) => {
    expect(() => decide(cls, method, HR_MANAGER)).toThrow(ForbiddenException);
  });
});
