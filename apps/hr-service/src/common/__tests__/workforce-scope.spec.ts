/**
 * The people reads every staff member reaches are scoped by the server, not by the client's
 * `moduleCode` (ADR-051 §1 `scoped('workforce')`, contract rule C2; ADR-054 draft PR-9;
 * HR-HIGH-066).
 *
 * For each operation this runs the `@AccessCaller()` factory Nest registered on the real handler
 * (the decision a request reaches after RolesGuard), hands the decided caller to the resolver, and
 * reads the scope the query carries: TENANT_ADMIN and any hr grant see every module, a farm or
 * sensor grant sees that module, a member with no grant is refused, and a `moduleCode` outside the
 * scope is FORBIDDEN instead of widening it.
 */
import { AccessCaller } from '@aquaculture/backend-common/decorators';
import { ALL_MODULES_SCOPE, moduleScopeOf, type ModuleScope } from '@aquaculture/shared-contracts';
import { ForbiddenException } from '@nestjs/common';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { createPaginatedQueryResult } from '@platform/cqrs';
import type { Repository } from 'typeorm';

import { AttendanceResolver } from '../../attendance/attendance.resolver';
import { GetDailyAttendanceOverviewQuery } from '../../attendance/queries/get-daily-attendance-overview.query';
import { EmployeeFilterInput, EmployeePaginationInput } from '../../hr/dto/employee-filter.input';
import { Employee } from '../../hr/entities/employee.entity';
import { HRResolver } from '../../hr/hr.resolver';
import { GetEmployeeQuery } from '../../hr/queries/get-employee.query';
import { GetEmployeesQuery } from '../../hr/queries/get-employees.query';
import { LeaveResolver } from '../../leave/leave.resolver';
import { GetTeamLeaveCalendarQuery } from '../../leave/queries/get-team-leave-calendar.query';
import { GetTeamWeeklyOverviewQuery } from '../../scheduling/queries/get-team-weekly-overview.query';
import { SchedulingResolver } from '../../scheduling/scheduling.resolver';
import { workforceScopeOf } from '../workforce-scope';
import { runGraphqlParamDecorator, takesParamDecorator } from './run-param-decorator';

const tenantId = 'tenant-1';

interface Claims {
  readonly role: string;
  readonly moduleAccess?: Readonly<Record<string, string>>;
}

function requestOf(claims: Claims): { user: Record<string, unknown> } {
  return {
    user: {
      sub: 'user-1',
      tenantId,
      role: claims.role,
      roles: [claims.role],
      ...(claims.moduleAccess === undefined ? {} : { moduleAccess: claims.moduleAccess }),
    },
  };
}

const VIEWERS = {
  tenantAdmin: {
    role: 'TENANT_ADMIN',
    moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
  },
  hrStaff: { role: 'MODULE_USER', moduleAccess: { hr: 'MODULE_USER' } },
  farmOperator: { role: 'MODULE_USER', moduleAccess: { farm: 'MODULE_USER' } },
  farmManagerGlobal: { role: 'MODULE_MANAGER', moduleAccess: { farm: 'MODULE_MANAGER' } },
  farmAndSensor: {
    role: 'MODULE_USER',
    moduleAccess: { farm: 'MODULE_USER', sensor: 'MODULE_MANAGER' },
  },
  noGrant: { role: 'MODULE_MANAGER', moduleAccess: {} },
  preR1Token: { role: 'MODULE_USER' },
} satisfies Record<string, Claims>;

/** The scope each viewer is decided, independent of the operation. */
const EXPECTED_SCOPE: ReadonlyArray<readonly [keyof typeof VIEWERS, ModuleScope | 'FORBIDDEN']> = [
  ['tenantAdmin', ALL_MODULES_SCOPE],
  ['hrStaff', ALL_MODULES_SCOPE],
  ['farmOperator', moduleScopeOf(['farm']) ?? ALL_MODULES_SCOPE],
  ['farmManagerGlobal', moduleScopeOf(['farm']) ?? ALL_MODULES_SCOPE],
  ['farmAndSensor', moduleScopeOf(['farm', 'sensor']) ?? ALL_MODULES_SCOPE],
  ['noGrant', 'FORBIDDEN'],
  ['preR1Token', 'FORBIDDEN'],
];

const queryBus = { execute: jest.fn() };
const commandBus: Partial<CommandBus> = { execute: jest.fn() };
const employeeRepository: Partial<Repository<Employee>> = {
  findOne: jest.fn().mockResolvedValue({ id: 'employee-1' }),
  manager: { findOne: jest.fn().mockResolvedValue(null) } as never,
};

const hrResolver = new HRResolver(commandBus as CommandBus, queryBus as unknown as QueryBus);
const attendanceResolver = new AttendanceResolver(
  commandBus as CommandBus,
  queryBus as unknown as QueryBus,
  employeeRepository as Repository<Employee>,
);
const leaveResolver = new LeaveResolver(
  commandBus as CommandBus,
  queryBus as unknown as QueryBus,
  employeeRepository as Repository<Employee>,
);
const schedulingResolver = new SchedulingResolver(
  commandBus as CommandBus,
  queryBus as unknown as QueryBus,
  employeeRepository as Repository<Employee>,
);

type Op = {
  readonly name: string;
  readonly cls: Parameters<typeof runGraphqlParamDecorator>[1];
  readonly method: string;
  /** Calls the resolver with the decided caller and a client `moduleCode`. */
  readonly call: (access: AccessCaller, moduleCode?: 'farm' | 'sensor') => Promise<unknown>;
  /** The scope the dispatched query carries. */
  readonly scopeOf: (query: unknown) => ModuleScope | undefined;
};

const context = { req: requestOf(VIEWERS.tenantAdmin) } as never;

const OPERATIONS: readonly Op[] = [
  {
    name: 'employees',
    cls: HRResolver,
    method: 'getEmployees',
    call: (access, moduleCode) =>
      hrResolver.getEmployees(
        access,
        Object.assign(new EmployeeFilterInput(), moduleCode ? { moduleCode } : {}),
        new EmployeePaginationInput(),
        context,
      ),
    scopeOf: (query) => (query as GetEmployeesQuery).scope,
  },
  {
    name: 'employee',
    cls: HRResolver,
    method: 'getEmployee',
    call: (access) => hrResolver.getEmployee(access, 'employee-1', context),
    scopeOf: (query) => (query as GetEmployeeQuery).scope,
  },
  {
    name: 'dailyAttendanceOverview',
    cls: AttendanceResolver,
    method: 'getDailyAttendanceOverview',
    call: (access, moduleCode) =>
      attendanceResolver.getDailyAttendanceOverview(access, context, undefined, moduleCode),
    scopeOf: (query) => (query as GetDailyAttendanceOverviewQuery).scope,
  },
  {
    name: 'teamLeaveCalendar',
    cls: LeaveResolver,
    method: 'getTeamLeaveCalendar',
    call: (access, moduleCode) =>
      leaveResolver.getTeamLeaveCalendar(
        access,
        context,
        '2026-11-01',
        '2026-11-30',
        undefined,
        moduleCode,
      ),
    scopeOf: (query) => (query as GetTeamLeaveCalendarQuery).scope,
  },
  {
    name: 'teamWeeklyOverview',
    cls: SchedulingResolver,
    method: 'getTeamWeeklyOverview',
    call: (access, moduleCode) =>
      schedulingResolver.getTeamWeeklyOverview(
        access,
        '2026-11-02',
        context,
        undefined,
        undefined,
        moduleCode,
      ),
    scopeOf: (query) => (query as GetTeamWeeklyOverviewQuery).scope,
  },
];

function decide(op: Op, claims: Claims): AccessCaller {
  return runGraphqlParamDecorator(
    AccessCaller,
    op.cls,
    op.method,
    requestOf(claims),
  ) as AccessCaller;
}

async function dispatchedScope(op: Op, access: AccessCaller, moduleCode?: 'farm' | 'sensor') {
  queryBus.execute.mockClear();
  await op.call(access, moduleCode);
  expect(queryBus.execute).toHaveBeenCalledTimes(1);
  return op.scopeOf(queryBus.execute.mock.calls[0]?.[0]);
}

beforeEach(() => {
  queryBus.execute.mockResolvedValue(createPaginatedQueryResult([], 1, 20, 0));
});

describe.each(OPERATIONS.map((op) => [op.name, op] as const))(
  '%s: the workforce scope is decided by the server (HR-HIGH-066)',
  (_name, op) => {
    it('takes @AccessCaller()', () => {
      expect(takesParamDecorator(AccessCaller, op.cls, op.method)).toBe(true);
    });

    it.each(EXPECTED_SCOPE)('%s gets %j', async (viewer, expected) => {
      if (expected === 'FORBIDDEN') {
        expect(() => decide(op, VIEWERS[viewer])).toThrow(ForbiddenException);
        return;
      }
      expect(await dispatchedScope(op, decide(op, VIEWERS[viewer]))).toEqual(expected);
    });
  },
);

describe.each(
  OPERATIONS.filter((op) => op.name !== 'employee').map((op) => [op.name, op] as const),
)('%s: moduleCode only narrows the server scope (contract rule C2)', (_name, op) => {
  it('a module inside the scope narrows to it', async () => {
    expect(await dispatchedScope(op, decide(op, VIEWERS.farmAndSensor), 'sensor')).toEqual(
      moduleScopeOf(['sensor']),
    );
    expect(await dispatchedScope(op, decide(op, VIEWERS.tenantAdmin), 'farm')).toEqual(
      moduleScopeOf(['farm']),
    );
  });

  it('a module outside the scope is FORBIDDEN and reaches no query', async () => {
    queryBus.execute.mockClear();
    await expect(op.call(decide(op, VIEWERS.farmManagerGlobal), 'sensor')).rejects.toThrow(
      ForbiddenException,
    );
    expect(queryBus.execute).not.toHaveBeenCalled();
  });
});

describe('workforceScopeOf', () => {
  it('refuses a decision that is not scoped(workforce): a programming error, never a scope', () => {
    // The payroll handler decides module(hr); asking it for a workforce scope is a bug.
    const pay = runGraphqlParamDecorator(
      AccessCaller,
      HRResolver,
      'getPayrolls',
      requestOf(VIEWERS.tenantAdmin),
    ) as AccessCaller;
    expect(() => workforceScopeOf(pay)).toThrow(TypeError);
  });
});
