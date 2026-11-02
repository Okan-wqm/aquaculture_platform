/**
 * Scheduling API — module scope contract.
 *
 * The Shift schedule pages ask these root fields for one module's people. The
 * argument must exist in the GraphQL schema (`moduleCode: HRModuleCode`,
 * optional) AND reach the query the handler runs; either half missing leaves
 * the page silently showing every module.
 */
import { AccessCaller, Role } from '@aquaculture/backend-common/decorators';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { createPaginatedQueryResult } from '@platform/cqrs';
import type { GraphQLSchema } from 'graphql';
import type { Repository } from 'typeorm';

import { ALL_MODULES_SCOPE, OWNER_MODULE, moduleScopeOf } from '@aquaculture/shared-contracts';
import type { Employee } from '../../hr/entities/employee.entity';
import { GetOvertimeSummaryQuery } from '../queries/get-overtime-summary.query';
import { GetTeamWeeklyOverviewQuery } from '../queries/get-team-weekly-overview.query';
import { GetWeeklyPlansQuery } from '../queries/get-weekly-plans.query';
import { runGraphqlParamDecorator } from '../../common/__tests__/run-param-decorator';
import { SchedulingResolver } from '../scheduling.resolver';

const tenantId = 'tenant-uuid-001';
const context = { req: { user: { sub: 'user-uuid-001', tenantId, roles: [Role.TENANT_ADMIN] } } };

/**
 * The workforce decision the handler's own @AccessCaller() makes for this request (a TENANT_ADMIN:
 * every module), so a module the page names narrows it (common/workforce-scope.ts).
 */
function workforce(method: string): AccessCaller {
  return runGraphqlParamDecorator(AccessCaller, SchedulingResolver, method, context.req) as AccessCaller;
}

describe('scheduling API — module scope contract', () => {
  describe('GraphQL schema', () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile();
      schema = await moduleRef.get(GraphQLSchemaFactory).create([SchedulingResolver]);
    });

    it.each(['teamWeeklyOverview', 'weeklyPlans', 'overtimeSummary'])(
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

    it('keeps the by-id, own-schedule and settings queries unscoped', () => {
      const fields = schema.getQueryType()?.getFields() ?? {};

      for (const field of ['weeklyPlan', 'mySchedule', 'schedulingSettings']) {
        expect(fields[field]?.args.map((arg) => arg.name)).not.toContain('moduleCode');
      }
    });
  });

  describe('resolver', () => {
    const queryBus = { execute: jest.fn() };
    // The resolver only reaches queryBus.execute here; each double is declared as a Partial of
    // the real collaborator so one plain assertion hands it over.
    const commandBusDouble: Partial<CommandBus> = { execute: jest.fn() };
    const queryBusDouble: Partial<QueryBus> = queryBus;
    const resolver = new SchedulingResolver(
      commandBusDouble as CommandBus,
      queryBusDouble as QueryBus,
      {} as Repository<Employee>,
    );

    beforeEach(() => {
      jest.clearAllMocks();
      queryBus.execute.mockResolvedValue(createPaginatedQueryResult([], 1, 20, 0));
    });

    it('hands teamWeeklyOverview the module', async () => {
      await resolver.getTeamWeeklyOverview(
        workforce('getTeamWeeklyOverview'),
        '2026-10-19',
        context,
        undefined,
        undefined,
        OWNER_MODULE.FARM,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTeamWeeklyOverviewQuery(
          tenantId,
          '2026-10-19',
          undefined,
          undefined,
          moduleScopeOf([OWNER_MODULE.FARM]) ?? undefined,
        ),
      );
    });

    it('hands weeklyPlans the module', async () => {
      await resolver.getWeeklyPlans(
        context,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        20,
        1,
        OWNER_MODULE.SENSOR,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetWeeklyPlansQuery(
          tenantId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          20,
          1,
          OWNER_MODULE.SENSOR,
        ),
      );
    });

    it('hands overtimeSummary the module', async () => {
      await resolver.getOvertimeSummary(
        10,
        2026,
        context,
        undefined,
        undefined,
        OWNER_MODULE.HYDROPONICS,
      );

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetOvertimeSummaryQuery(
          tenantId,
          10,
          2026,
          undefined,
          undefined,
          OWNER_MODULE.HYDROPONICS,
        ),
      );
    });

    it('sends no module when the page names none (the Company view)', async () => {
      await resolver.getTeamWeeklyOverview(workforce('getTeamWeeklyOverview'), '2026-10-19', context);

      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetTeamWeeklyOverviewQuery(
          tenantId,
          '2026-10-19',
          undefined,
          undefined,
          ALL_MODULES_SCOPE,
        ),
      );
    });
  });
});
