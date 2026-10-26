/**
 * Attendance API — module scope contract.
 *
 * The Team › Today and Attendance pages ask these four root fields for one
 * module's people. The argument must exist in the GraphQL schema (`moduleCode:
 * HRModuleCode`, optional) AND reach the query the handler runs; either half
 * missing leaves the page silently showing every module.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { createPaginatedQueryResult } from '@platform/cqrs';
import type { GraphQLSchema } from 'graphql';
import type { EntityManager, Repository } from 'typeorm';

import { HrModuleCode } from '../../common/enums';
import { Employee } from '../../hr/entities/employee.entity';
import { AttendanceResolver } from '../attendance.resolver';
import { GetAttendanceRecordsQuery } from '../queries/get-attendance-records.query';
import { GetDailyAttendanceOverviewQuery } from '../queries/get-daily-attendance-overview.query';
import { GetPendingAttendanceApprovalsQuery } from '../queries/get-pending-attendance-approvals.query';
import { GetTodaysAttendanceQuery } from '../queries/get-todays-attendance.query';

const tenantId = 'tenant-uuid-001';
const context = { req: { user: { sub: 'user-uuid-001', tenantId, roles: [Role.TENANT_ADMIN] } } };

/** A request authenticated as `user-uuid-001` (an AUTH user id, never an HR employee id) with these roles. */
function contextWith(roles: Role[]): typeof context {
  return { req: { user: { sub: 'user-uuid-001', tenantId, roles } } };
}

describe('attendance API — module scope contract', () => {
  describe('GraphQL schema', () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile();
      schema = await moduleRef.get(GraphQLSchemaFactory).create([AttendanceResolver]);
    });

    it.each([
      'todaysAttendance',
      'dailyAttendanceOverview',
      'attendanceRecords',
      'pendingAttendanceApprovals',
    ])('%s takes an optional moduleCode: HRModuleCode', (field) => {
      const argument = schema
        .getQueryType()
        ?.getFields()
        [field]?.args.find((arg) => arg.name === 'moduleCode');

      expect(argument).toBeDefined();
      expect(String(argument?.type)).toBe('HRModuleCode');
    });

    it('keeps the own-record queries unscoped: there is nothing of other people to narrow', () => {
      const fields = schema.getQueryType()?.getFields() ?? {};

      for (const field of ['myTodaysAttendance', 'myAttendanceRecords', 'myAttendanceSummary']) {
        expect(fields[field]?.args.map((arg) => arg.name)).not.toContain('moduleCode');
      }
    });
  });

  describe('resolver', () => {
    const queryBus = { execute: jest.fn() };
    const employeeRepository = { findOne: jest.fn() };
    // The viewer's own record is read through the repository's manager (common/viewer.ts).
    const viewerLookup = jest.fn();
    const managerDouble: Partial<EntityManager> = { findOne: viewerLookup };
    // The resolver reaches only execute() on each bus and findOne() on the repository. Each double is
    // declared as a Partial of the real type, so one plain assertion hands it over without a cast chain.
    const commandBusDouble: Partial<CommandBus> = { execute: jest.fn() };
    const queryBusDouble: Partial<QueryBus> = queryBus;
    const employeeRepositoryDouble: Partial<Repository<Employee>> = {
      ...employeeRepository,
      manager: managerDouble as EntityManager,
    };
    const resolver = new AttendanceResolver(
      commandBusDouble as CommandBus,
      queryBusDouble as QueryBus,
      employeeRepositoryDouble as Repository<Employee>,
    );

    beforeEach(() => {
      jest.clearAllMocks();
      queryBus.execute.mockResolvedValue(createPaginatedQueryResult([], 1, 20, 0));
      employeeRepository.findOne.mockResolvedValue({ id: 'employee-uuid-001' });
      viewerLookup.mockResolvedValue({ id: 'employee-uuid-001', departmentHrId: 'dept-1' });
    });

    it('hands todaysAttendance the module', async () => {
      await resolver.getTodaysAttendance(context, undefined, HrModuleCode.FARM);

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTodaysAttendanceQuery(tenantId, undefined, HrModuleCode.FARM),
      );
    });

    it('hands dailyAttendanceOverview the module', async () => {
      await resolver.getDailyAttendanceOverview(context, '2026-10-22', HrModuleCode.SENSOR);

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetDailyAttendanceOverviewQuery(tenantId, '2026-10-22', HrModuleCode.SENSOR),
      );
    });

    it('hands attendanceRecords the module', async () => {
      await resolver.getAttendanceRecords(
        context,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        20,
        1,
        HrModuleCode.HYDROPONICS,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetAttendanceRecordsQuery(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          20,
          1,
          HrModuleCode.HYDROPONICS,
        ),
      );
    });

    describe('pendingAttendanceApprovals', () => {
      it('hands the queue the module', async () => {
        await resolver.getPendingAttendanceApprovals(context, undefined, 20, 1, HrModuleCode.FARM);

        expect(queryBus.execute).toHaveBeenCalledWith(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            'employee-uuid-001',
            undefined,
            20,
            1,
            HrModuleCode.FARM,
            false,
          ),
        );
      });

      // The queue excludes the approver's own records and looks their department up BY employee id:
      // an auth user id (the JWT sub) is neither, so the resolver must bridge it first.
      it("hands the queue the viewer's EMPLOYEE id, never the auth user id", async () => {
        await resolver.getPendingAttendanceApprovals(contextWith([Role.MODULE_MANAGER]));

        // Only the id and department are read: the full entity would decrypt national id and bank
        // details for nothing.
        expect(viewerLookup).toHaveBeenCalledWith(Employee, {
          where: { userId: 'user-uuid-001', tenantId, isDeleted: false },
          select: ['id', 'departmentHrId'],
        });
        const [query] = queryBus.execute.mock.calls[0] as [GetPendingAttendanceApprovalsQuery];
        expect(query.approverId).toBe('employee-uuid-001');
        expect(query.approverId).not.toBe('user-uuid-001');
      });

      it('does not ask for the implicit own-department narrowing on behalf of a tenant admin', async () => {
        await resolver.getPendingAttendanceApprovals(contextWith([Role.TENANT_ADMIN]));

        expect(queryBus.execute).toHaveBeenCalledWith(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            'employee-uuid-001',
            undefined,
            20,
            1,
            undefined,
            false,
          ),
        );
      });

      it('asks for the own-department narrowing on behalf of a module manager', async () => {
        await resolver.getPendingAttendanceApprovals(contextWith([Role.MODULE_MANAGER]));

        expect(queryBus.execute).toHaveBeenCalledWith(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            'employee-uuid-001',
            undefined,
            20,
            1,
            undefined,
            true,
          ),
        );
      });

      it('narrows a user holding several roles when none of them is tenant admin', async () => {
        await resolver.getPendingAttendanceApprovals(
          contextWith([Role.MODULE_USER, Role.MODULE_MANAGER]),
        );

        const [query] = queryBus.execute.mock.calls[0] as [GetPendingAttendanceApprovalsQuery];
        expect(query.narrowToOwnDepartment).toBe(true);
      });

      it('hands an explicit department and module through beside the narrowing flag', async () => {
        await resolver.getPendingAttendanceApprovals(
          contextWith([Role.MODULE_MANAGER]),
          'dept-explicit',
          20,
          1,
          HrModuleCode.SENSOR,
        );

        expect(queryBus.execute).toHaveBeenCalledWith(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            'employee-uuid-001',
            'dept-explicit',
            20,
            1,
            HrModuleCode.SENSOR,
            true,
          ),
        );
      });

      // The tenant owner often has no HR employee record and approves across departments: the queue
      // must not depend on one (same as the leave queue).
      it('lists the queue for a tenant admin who has no employee record', async () => {
        viewerLookup.mockResolvedValue(null);

        await resolver.getPendingAttendanceApprovals(
          contextWith([Role.TENANT_ADMIN]),
          undefined,
          20,
          1,
          HrModuleCode.FARM,
        );

        expect(queryBus.execute).toHaveBeenCalledWith(
          new GetPendingAttendanceApprovalsQuery(
            tenantId,
            null,
            undefined,
            20,
            1,
            HrModuleCode.FARM,
            false,
          ),
        );
      });

      it('does not lock a module manager without an employee record out of the queue', async () => {
        viewerLookup.mockResolvedValue(null);

        await expect(
          resolver.getPendingAttendanceApprovals(contextWith([Role.MODULE_MANAGER])),
        ).resolves.toBeDefined();

        expect(queryBus.execute).toHaveBeenCalledWith(
          new GetPendingAttendanceApprovalsQuery(tenantId, null, undefined, 20, 1, undefined, true),
        );
      });
    });

    it('sends no module when the page names none (the Company view)', async () => {
      await resolver.getTodaysAttendance(context);

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTodaysAttendanceQuery(tenantId, undefined, undefined),
      );
    });

    // Today is the first page of every module's Team area, and the tenant owner often has no HR
    // employee record: the whole-team roster must not depend on one.
    it('shows the team roster to a manager who has no employee record', async () => {
      employeeRepository.findOne.mockResolvedValue(null);

      await resolver.getTodaysAttendance(context, undefined, HrModuleCode.FARM);

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTodaysAttendanceQuery(tenantId, undefined, HrModuleCode.FARM),
      );
    });

    it('still refuses a non-manager who has no employee record', async () => {
      employeeRepository.findOne.mockResolvedValue(null);
      const regularUser = {
        req: { user: { sub: 'user-uuid-002', tenantId, roles: [Role.MODULE_USER] } },
      };

      await expect(resolver.getTodaysAttendance(regularUser)).rejects.toThrow(
        'Employee record not found',
      );
    });
  });
});
