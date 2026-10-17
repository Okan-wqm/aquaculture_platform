import { collaborator } from '@aquaculture/testing';
import { type Repository } from 'typeorm';

import { AlertResolver } from '../alert.resolver';
import { AlertEvaluationService } from '../../services/alert-evaluation.service';
import { AlertRuleService } from '../../services/alert-rule.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import { AlertRule, AlertSeverity } from '../../../database/entities/alert-rule.entity';

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
      );
      expect(items).toEqual([alarm('alert-1')]);
    });

    it('hands the service an absent filter for every explicit null', async () => {
      await resolver.getAlertHistory(tenantId, 1, 20, null, null, null, null, null, null, null);

      expect(getAlertHistory).toHaveBeenCalledWith(
        tenantId,
        {
          ruleId: undefined,
          severity: undefined,
          severities: undefined,
          acknowledged: undefined,
          resolved: undefined,
          startDate: undefined,
          endDate: undefined,
        },
        { page: 1, limit: 20 },
      );
    });

    it('caps the page size at 100', async () => {
      await resolver.getAlertHistory(tenantId, 2, 500);

      expect(getAlertHistory).toHaveBeenCalledWith(tenantId, expect.anything(), {
        page: 2,
        limit: 100,
      });
    });
  });

  describe('through the real service', () => {
    let query: {
      where: jest.Mock;
      andWhere: jest.Mock;
      orderBy: jest.Mock;
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
