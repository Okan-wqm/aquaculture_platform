import { collaborator } from '@aquaculture/testing';
import { type Repository } from 'typeorm';

import { AlertEvaluationService } from '../alert-evaluation.service';
import { AlertRuleService } from '../alert-rule.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import { AlertRule, AlertSeverity } from '../../../database/entities/alert-rule.entity';

/**
 * AlertRuleService.countActiveAlerts — exact unresolved-alarm counts per
 * (severity, acknowledged), behind the tenant console's annunciator.
 *
 * The annunciator used to count the newest alertHistory page of each
 * acknowledgement side, and lost an older active CRITICAL once 100 newer rows
 * sat in front of it: INFO feed-transition records nobody acknowledges, or
 * alarms resolved without being acknowledged. A grouped count over the
 * unresolved rows has no page to fall off, so it is the one source: resolved
 * rows are excluded in SQL, every severity is counted (the web maps severity
 * to priority), and Postgres' bigint COUNT arrives as a string and leaves as a
 * number.
 */
describe('AlertRuleService.countActiveAlerts', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  let query: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
    addGroupBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    limit: jest.Mock;
    getRawMany: jest.Mock;
  };
  let historyRepository: { createQueryBuilder: jest.Mock };
  let service: AlertRuleService;

  beforeEach(() => {
    query = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    historyRepository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    service = new AlertRuleService(
      collaborator<Repository<AlertRule>>({}, 'AlertRuleRepository'),
      collaborator<Repository<AlertHistory>>(historyRepository, 'AlertHistoryRepository'),
      collaborator<AlertEvaluationService>({}, 'AlertEvaluationService'),
    );
  });

  it('counts the tenant’s unresolved alarms grouped by severity and acknowledgement', async () => {
    query.getRawMany.mockResolvedValue([
      { severity: AlertSeverity.CRITICAL, acknowledged: false, count: '1' },
      { severity: AlertSeverity.INFO, acknowledged: false, count: '250' },
      { severity: AlertSeverity.HIGH, acknowledged: true, count: '3' },
    ]);

    const counts = await service.countActiveAlerts(tenantId);

    expect(counts).toEqual([
      { severity: AlertSeverity.CRITICAL, acknowledged: false, count: 1 },
      { severity: AlertSeverity.INFO, acknowledged: false, count: 250 },
      { severity: AlertSeverity.HIGH, acknowledged: true, count: 3 },
    ]);
    expect(query.where).toHaveBeenCalledWith('alert.tenantId = :tenantId', { tenantId });
    expect(query.andWhere).toHaveBeenCalledWith('alert.resolved = :resolved', {
      resolved: false,
    });
    expect(query.groupBy).toHaveBeenCalledWith('alert.severity');
    expect(query.addGroupBy).toHaveBeenCalledWith('alert.acknowledged');
  });

  it('pages nothing, so no row can be pushed out of the count', async () => {
    await service.countActiveAlerts(tenantId);

    expect(query.skip).not.toHaveBeenCalled();
    expect(query.take).not.toHaveBeenCalled();
    expect(query.limit).not.toHaveBeenCalled();
    expect(query.getRawMany).toHaveBeenCalledTimes(1);
  });

  it('reports a tenant without active alarms as no rows', async () => {
    await expect(service.countActiveAlerts(tenantId)).resolves.toEqual([]);
  });
});
