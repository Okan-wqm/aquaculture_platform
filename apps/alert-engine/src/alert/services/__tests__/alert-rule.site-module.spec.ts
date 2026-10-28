import { collaborator } from '@aquaculture/testing';
import { type Repository } from 'typeorm';

import { AlertEvaluationService } from '../alert-evaluation.service';
import { AlertRuleService } from '../alert-rule.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { ActiveAlertCountDimension } from '../../dto/active-alert-count.type';
import { AlertRule, AlertSeverity } from '../../../database/entities/alert-rule.entity';

/**
 * The site + module dimension of alarms (ALERT-MEDIUM-010).
 *
 * The tenant console reads alarms per module workspace (the workspace menu's
 * counts, each module dashboard's alarm panel) and per site (a dashboard row's
 * alarm counts). One scope — site and/or module, equality, absent = no
 * narrowing — applies to both the alarm list and the active counts, so a
 * count and the list it opens hold the same rows. The counts group by site
 * and/or module only when asked: without `groupBy` the rows keep the
 * annunciator's (severity, acknowledged) shape and carry no site or module.
 */
describe('AlertRuleService — site and module scope', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const siteId = '22222222-2222-4222-8222-222222222222';

  type Chain = Record<
    | 'select'
    | 'addSelect'
    | 'where'
    | 'andWhere'
    | 'groupBy'
    | 'addGroupBy'
    | 'orderBy'
    | 'addOrderBy'
    | 'skip'
    | 'take',
    jest.Mock
  > & { getRawMany: jest.Mock; getManyAndCount: jest.Mock };

  let query: Chain;
  let service: AlertRuleService;

  beforeEach(() => {
    const chained = (): jest.Mock => jest.fn().mockReturnThis();
    query = {
      select: chained(),
      addSelect: chained(),
      where: chained(),
      andWhere: chained(),
      groupBy: chained(),
      addGroupBy: chained(),
      orderBy: chained(),
      addOrderBy: chained(),
      skip: chained(),
      take: chained(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    service = new AlertRuleService(
      collaborator<Repository<AlertRule>>({}, 'AlertRuleRepository'),
      collaborator<Repository<AlertHistory>>(
        { createQueryBuilder: jest.fn().mockReturnValue(query) },
        'AlertHistoryRepository',
      ),
      collaborator<AlertEvaluationService>({}, 'AlertEvaluationService'),
    );
  });

  const clauses = (): string[] => query.andWhere.mock.calls.map(([clause]: [string]) => clause);

  describe('getAlertHistory', () => {
    it('narrows the list to one site and one module', async () => {
      await service.getAlertHistory(
        tenantId,
        { siteId, module: OWNER_MODULE.FARM, resolved: false },
        { page: 1, limit: 20 },
      );

      expect(query.andWhere).toHaveBeenCalledWith('alert.siteId = :siteId', { siteId });
      expect(query.andWhere).toHaveBeenCalledWith('alert.module = :module', {
        module: OWNER_MODULE.FARM,
      });
    });

    it('does not narrow by site or module when neither is given', async () => {
      await service.getAlertHistory(tenantId, { resolved: false }, { page: 1, limit: 20 });

      expect(clauses()).toEqual(['alert.resolved = :resolved']);
    });
  });

  describe('countActiveAlerts', () => {
    it('keeps the annunciator’s shape when no grouping is asked for', async () => {
      query.getRawMany.mockResolvedValue([
        { severity: AlertSeverity.CRITICAL, acknowledged: false, count: '2' },
      ]);

      await expect(service.countActiveAlerts(tenantId)).resolves.toEqual([
        { severity: AlertSeverity.CRITICAL, acknowledged: false, count: 2 },
      ]);
      expect(query.addGroupBy.mock.calls).toEqual([['alert.acknowledged']]);
    });

    it('counts per module, a row without a module included as null', async () => {
      query.getRawMany.mockResolvedValue([
        {
          severity: AlertSeverity.HIGH,
          acknowledged: false,
          module: OWNER_MODULE.SENSOR,
          count: '3',
        },
        { severity: AlertSeverity.HIGH, acknowledged: false, module: null, count: '1' },
      ]);

      const counts = await service.countActiveAlerts(tenantId, {
        groupBy: [ActiveAlertCountDimension.MODULE],
      });

      expect(counts).toEqual([
        {
          severity: AlertSeverity.HIGH,
          acknowledged: false,
          module: OWNER_MODULE.SENSOR,
          count: 3,
        },
        { severity: AlertSeverity.HIGH, acknowledged: false, module: null, count: 1 },
      ]);
      expect(query.addSelect).toHaveBeenCalledWith('alert.module', 'module');
      expect(query.addGroupBy).toHaveBeenCalledWith('alert.module');
      expect(query.addGroupBy).not.toHaveBeenCalledWith('alert.siteId');
    });

    it('counts one module’s alarms per site', async () => {
      query.getRawMany.mockResolvedValue([
        { severity: AlertSeverity.CRITICAL, acknowledged: true, siteId, count: '1' },
      ]);

      const counts = await service.countActiveAlerts(tenantId, {
        module: OWNER_MODULE.FARM,
        groupBy: [ActiveAlertCountDimension.SITE],
      });

      expect(counts).toEqual([
        { severity: AlertSeverity.CRITICAL, acknowledged: true, siteId, count: 1 },
      ]);
      expect(query.andWhere).toHaveBeenCalledWith('alert.resolved = :resolved', {
        resolved: false,
      });
      expect(query.andWhere).toHaveBeenCalledWith('alert.module = :module', {
        module: OWNER_MODULE.FARM,
      });
      expect(query.addSelect).toHaveBeenCalledWith('alert.siteId', 'siteId');
      expect(query.addGroupBy).toHaveBeenCalledWith('alert.siteId');
    });

    it('narrows the counts to one site', async () => {
      await service.countActiveAlerts(tenantId, { siteId });

      expect(clauses()).toEqual(['alert.resolved = :resolved', 'alert.siteId = :siteId']);
    });

    it('groups once per dimension however often it is named', async () => {
      await service.countActiveAlerts(tenantId, {
        groupBy: [ActiveAlertCountDimension.SITE, ActiveAlertCountDimension.SITE],
      });

      expect(query.addGroupBy.mock.calls).toEqual([['alert.acknowledged'], ['alert.siteId']]);
    });
  });
});
