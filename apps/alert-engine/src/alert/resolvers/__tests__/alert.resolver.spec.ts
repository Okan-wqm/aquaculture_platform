import { collaborator } from '@aquaculture/testing';
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { type Repository } from 'typeorm';

import { AlertResolver } from '../alert.resolver';
import { AlertEvaluationService } from '../../services/alert-evaluation.service';
import { AlertRuleService } from '../../services/alert-rule.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { ActiveAlertCountDimension } from '../../dto/active-alert-count.type';
import { AlertHistoryOrder } from '../../dto/alert-history-order.enum';
import { AlertRule, AlertSeverity } from '../../../database/entities/alert-rule.entity';

const SITE_ID = '33333333-3333-4333-8333-333333333333';

function alarm(id: string): AlertHistory {
  return Object.assign(new AlertHistory(), { id });
}

/** A real AlertRuleService over the given history repository; the rule side is off the path. */
function alertRuleService(
  historyRepository: Partial<Repository<AlertHistory>> = {},
): AlertRuleService {
  return new AlertRuleService(
    collaborator<Repository<AlertRule>>({}, 'AlertRuleRepository'),
    collaborator<Repository<AlertHistory>>(historyRepository, 'AlertHistoryRepository'),
    collaborator<AlertEvaluationService>({}, 'AlertEvaluationService'),
  );
}

/**
 * AlertResolver.alertHistory — the GraphQL arguments reach the service.
 *
 * The tenant console's alarm list asks for one annunciator tile's rows:
 * `severities` (P3 = MEDIUM + WARNING), `resolved: false` (a tile counts open
 * alarms only) and, for UNACK, `acknowledged: false`. A resolver that dropped
 * one of them would answer with a wider list than the tile counted, and only
 * this spec would notice — the schema gate checks that an argument exists,
 * not that it is used.
 *
 * Every filter argument is nullable in the schema, and graphql-js passes an
 * explicit `null` through as null. It means "no filter", so the resolver
 * hands the service an absent filter: no throw, no `IN (NULL)`, no
 * `= NULL` that matches nothing.
 */
describe('AlertResolver.alertHistory', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  describe('forwarding to AlertRuleService', () => {
    let getAlertHistory: jest.SpyInstance<
      ReturnType<AlertRuleService['getAlertHistory']>,
      Parameters<AlertRuleService['getAlertHistory']>
    >;
    let resolver: AlertResolver;

    beforeEach(() => {
      const service = alertRuleService();
      getAlertHistory = jest
        .spyOn(service, 'getAlertHistory')
        .mockResolvedValue({ items: [alarm('alert-1')], total: 1 });
      resolver = new AlertResolver(service);
    });

    it('forwards the severity set, the open-alarm and the acknowledgement filters', async () => {
      const items = await resolver.getAlertHistory(
        tenantId,
        1,
        20,
        undefined,
        undefined,
        [AlertSeverity.MEDIUM, AlertSeverity.WARNING],
        false,
        false,
      );

      expect(getAlertHistory).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({
          severities: [AlertSeverity.MEDIUM, AlertSeverity.WARNING],
          acknowledged: false,
          resolved: false,
        }),
        { page: 1, limit: 20 },
        AlertHistoryOrder.NEWEST_FIRST,
      );
      expect(items).toEqual([alarm('alert-1')]);
    });

    it('hands the service an absent filter for every explicit null', async () => {
      await resolver.getAlertHistory(
        tenantId,
        1,
        20,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );

      const filters = getAlertHistory.mock.calls.at(0)?.[1];
      expect(Object.entries(filters ?? {})).toEqual([
        ['ruleId', undefined],
        ['severity', undefined],
        ['severities', undefined],
        ['acknowledged', undefined],
        ['resolved', undefined],
        ['startDate', undefined],
        ['endDate', undefined],
        ['siteId', undefined],
        ['module', undefined],
      ]);
      expect(getAlertHistory).toHaveBeenCalledWith(
        tenantId,
        expect.anything(),
        { page: 1, limit: 20 },
        AlertHistoryOrder.NEWEST_FIRST,
      );
    });

    it('forwards the site and module scope of a module dashboard’s alarm panel', async () => {
      await resolver.getAlertHistory(
        tenantId,
        1,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        SITE_ID,
        OWNER_MODULE.FARM,
      );

      expect(getAlertHistory).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({ resolved: false, siteId: SITE_ID, module: OWNER_MODULE.FARM }),
        { page: 1, limit: 20 },
        AlertHistoryOrder.NEWEST_FIRST,
      );
    });

    it('forwards the most-severe-first order a dashboard panel asks for; null pages newest first', async () => {
      const page = (orderBy: AlertHistoryOrder | null): Promise<unknown> =>
        resolver.getAlertHistory(
          tenantId,
          1,
          50,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          OWNER_MODULE.FARM,
          orderBy,
        );

      await page(AlertHistoryOrder.MOST_SEVERE_FIRST);
      await page(null);

      expect(getAlertHistory.mock.calls.map((call) => call[3])).toEqual([
        AlertHistoryOrder.MOST_SEVERE_FIRST,
        AlertHistoryOrder.NEWEST_FIRST,
      ]);
    });

    it('caps the page size at 100', async () => {
      await resolver.getAlertHistory(tenantId, 2, 500);

      expect(getAlertHistory).toHaveBeenCalledWith(
        tenantId,
        expect.anything(),
        { page: 2, limit: 100 },
        AlertHistoryOrder.NEWEST_FIRST,
      );
    });
  });

  describe('through the real service', () => {
    let query: {
      where: jest.Mock;
      andWhere: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      skip: jest.Mock;
      take: jest.Mock;
      getManyAndCount: jest.Mock;
    };
    let resolver: AlertResolver;

    beforeEach(() => {
      query = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[{ id: 'alert-1' }], 1]),
      };
      const historyRepository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
      resolver = new AlertResolver(alertRuleService(historyRepository));
    });

    it('reads every severity for `severities: null`, without throwing', async () => {
      const items = await resolver.getAlertHistory(tenantId, 1, 20, undefined, undefined, null);

      expect(items).toEqual([{ id: 'alert-1' }]);
      expect(query.andWhere).not.toHaveBeenCalled();
    });

    it('reads every acknowledgement state for `acknowledged: null`', async () => {
      await resolver.getAlertHistory(
        tenantId,
        1,
        20,
        undefined,
        undefined,
        [AlertSeverity.CRITICAL],
        null,
        null,
      );

      const clauses = query.andWhere.mock.calls.map(([clause]: [string]) => clause);
      expect(clauses).toEqual(['alert.severity IN (:...severities)']);
    });
  });
});

/**
 * AlertResolver.activeAlertCounts — the scope and grouping reach the service.
 *
 * Without arguments the annunciator's request is unchanged; the workspace
 * menu asks `groupBy: [MODULE]`, a module dashboard `module` + `groupBy:
 * [SITE]`. An explicit null is an absent argument, as on alertHistory.
 */
describe('AlertResolver.activeAlertCounts', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  let countActiveAlerts: jest.SpyInstance<
    ReturnType<AlertRuleService['countActiveAlerts']>,
    Parameters<AlertRuleService['countActiveAlerts']>
  >;
  let resolver: AlertResolver;

  beforeEach(() => {
    const service = alertRuleService();
    countActiveAlerts = jest.spyOn(service, 'countActiveAlerts').mockResolvedValue([]);
    resolver = new AlertResolver(service);
  });

  it('asks for the tenant-wide counts when no argument is given', async () => {
    await resolver.getActiveAlertCounts(tenantId);

    expect(countActiveAlerts).toHaveBeenCalledWith(tenantId, {
      siteId: undefined,
      module: undefined,
      groupBy: undefined,
    });
  });

  it('forwards the module filter and the per-site grouping', async () => {
    await resolver.getActiveAlertCounts(tenantId, null, OWNER_MODULE.SENSOR, [
      ActiveAlertCountDimension.SITE,
    ]);

    expect(countActiveAlerts).toHaveBeenCalledWith(tenantId, {
      siteId: undefined,
      module: OWNER_MODULE.SENSOR,
      groupBy: [ActiveAlertCountDimension.SITE],
    });
  });

  it('forwards a site filter and treats an explicit null grouping as none', async () => {
    await resolver.getActiveAlertCounts(tenantId, SITE_ID, null, null);

    expect(countActiveAlerts).toHaveBeenCalledWith(tenantId, {
      siteId: SITE_ID,
      module: undefined,
      groupBy: undefined,
    });
  });
});

/**
 * The siteId arguments parse a UUID (ALERT-LOW-014). `site_id` is a uuid
 * column: a value that is not one must be a validation error, not a 22P02 the
 * database hands the client. Nest runs an argument's pipes before the method;
 * the specs above call the method directly and never reach them, so this runs
 * the pipes the `@Args` decorator registered, as Nest does.
 */
describe('AlertResolver siteId arguments (ALERT-LOW-014)', () => {
  type SiteFiltered = 'getAlertHistory' | 'getActiveAlertCounts';

  interface RegisteredArg {
    readonly data?: unknown;
    readonly pipes: readonly PipeTransform[];
  }

  async function parsedSiteId(method: SiteFiltered, value: unknown): Promise<unknown> {
    const registered: Record<string, RegisteredArg> = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AlertResolver,
      method,
    );
    const siteArg = Object.values(registered).find((arg) => arg.data === 'siteId');
    if (siteArg === undefined) throw new Error(`${method} registers no siteId argument`);
    expect(siteArg.pipes.length).toBeGreaterThan(0);
    let parsed = value;
    for (const pipe of siteArg.pipes) {
      parsed = await pipe.transform(parsed, { type: 'custom', data: 'siteId' });
    }
    return parsed;
  }

  const methods: readonly SiteFiltered[] = ['getAlertHistory', 'getActiveAlertCounts'];

  it.each(methods)('%s passes a site UUID, and an absent or null site', async (method) => {
    await expect(parsedSiteId(method, SITE_ID)).resolves.toBe(SITE_ID);
    await expect(parsedSiteId(method, undefined)).resolves.toBeUndefined();
    await expect(parsedSiteId(method, null)).resolves.toBeNull();
  });

  it.each(methods)('%s refuses a site that is not a UUID as a bad request', async (method) => {
    await expect(parsedSiteId(method, 'site-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
