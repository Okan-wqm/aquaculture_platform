/**
 * Leave API — module scope contract.
 *
 * The Leave requests pages ask these root fields for one module's people. The
 * argument must exist in the GraphQL schema (`moduleCode: HRModuleCode`,
 * optional) AND reach the query the handler runs; either half missing leaves
 * the page silently showing every module.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { createPaginatedQueryResult } from '@platform/cqrs';
import type { GraphQLSchema } from 'graphql';
import type { Repository } from 'typeorm';

import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import type { Employee } from '../../hr/entities/employee.entity';
import { LeaveResolver } from '../leave.resolver';
import { GetLeaveRequestsQuery } from '../queries/get-leave-requests.query';
import { GetPendingApprovalsQuery } from '../queries/get-pending-approvals.query';
import { GetTeamLeaveCalendarQuery } from '../queries/get-team-leave-calendar.query';

const tenantId = 'tenant-uuid-001';
const context = { req: { user: { sub: 'user-uuid-001', tenantId, roles: [Role.TENANT_ADMIN] } } };

/** The authenticated caller as the resolver receives it from @CurrentUser(). */
function viewerWith(roles: string[]): CurrentUserPayload {
  return { sub: 'user-uuid-001', email: 'viewer@farm.test', tenantId, roles } as CurrentUserPayload;
}

describe('leave API — module scope contract', () => {
  describe('GraphQL schema', () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile();
      schema = await moduleRef.get(GraphQLSchemaFactory).create([LeaveResolver]);
    });

    it.each(['leaveRequests', 'pendingLeaveApprovals', 'teamLeaveCalendar'])(
      '%s takes an optional moduleCode: HRModuleCode',
      (field) => {
        const argument = schema
          .getQueryType()
          ?.getFields()
          [field]?.args.find((arg) => arg.name === 'moduleCode');

        expect(argument).toBeDefined();
        expect(String(argument?.type)).toBe('HRModuleCode');
      },
    );

    it('keeps the own-request, by-id, balance and definition queries unscoped', () => {
      const fields = schema.getQueryType()?.getFields() ?? {};

      for (const field of [
        'myLeaveRequests',
        'leaveRequest',
        'leaveBalances',
        'myLeaveBalances',
        'leaveTypes',
      ]) {
        expect(fields[field]?.args.map((arg) => arg.name)).not.toContain('moduleCode');
      }
    });
  });

  describe('resolver', () => {
    const queryBus = { execute: jest.fn() };
    const employeeRepository = { findOne: jest.fn() };
    // The resolver only reaches queryBus.execute and employeeRepository.findOne here; each
    // double is declared as a Partial of the real collaborator so one plain assertion hands it over.
    const commandBusDouble: Partial<CommandBus> = { execute: jest.fn() };
    const queryBusDouble: Partial<QueryBus> = queryBus;
    const employeeRepositoryDouble: Partial<Repository<Employee>> = employeeRepository;
    const resolver = new LeaveResolver(
      commandBusDouble as CommandBus,
      queryBusDouble as QueryBus,
      employeeRepositoryDouble as Repository<Employee>,
    );

    beforeEach(() => {
      jest.clearAllMocks();
      queryBus.execute.mockResolvedValue(createPaginatedQueryResult([], 1, 20, 0));
      employeeRepository.findOne.mockResolvedValue({ id: 'employee-uuid-001' });
    });

    it('hands leaveRequests the module', async () => {
      await resolver.getLeaveRequests(
        context,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        20,
        1,
        OWNER_MODULE.FARM,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetLeaveRequestsQuery(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          20,
          1,
          OWNER_MODULE.FARM,
        ),
      );
    });

    it('hands pendingLeaveApprovals the module, and narrows a manager to their own department', async () => {
      await resolver.getPendingLeaveApprovals(
        context,
        viewerWith(['MODULE_MANAGER']),
        undefined,
        20,
        1,
        OWNER_MODULE.SENSOR,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetPendingApprovalsQuery(
          tenantId,
          'employee-uuid-001',
          undefined,
          20,
          1,
          OWNER_MODULE.SENSOR,
          true,
        ),
      );
    });

    it('never asks for the implicit own-department narrowing on behalf of a tenant admin', async () => {
      await resolver.getPendingLeaveApprovals(context, viewerWith(['TENANT_ADMIN']));

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetPendingApprovalsQuery(
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

    it('hands teamLeaveCalendar the module', async () => {
      await resolver.getTeamLeaveCalendar(
        context,
        '2026-10-22',
        '2026-10-22',
        undefined,
        OWNER_MODULE.HYDROPONICS,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTeamLeaveCalendarQuery(
          tenantId,
          undefined,
          '2026-10-22',
          '2026-10-22',
          OWNER_MODULE.HYDROPONICS,
        ),
      );
    });

    it('sends no module when the page names none (the Company view)', async () => {
      await resolver.getTeamLeaveCalendar(context, '2026-10-22', '2026-10-22');

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTeamLeaveCalendarQuery(tenantId, undefined, '2026-10-22', '2026-10-22', undefined),
      );
    });
  });
});
