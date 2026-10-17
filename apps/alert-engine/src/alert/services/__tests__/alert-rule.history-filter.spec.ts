import { collaborator } from '@aquaculture/testing';
import { type Repository } from 'typeorm';

import { AlertEvaluationService } from '../alert-evaluation.service';
import { AlertRuleService } from '../alert-rule.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import { AlertRule, AlertSeverity } from '../../../database/entities/alert-rule.entity';

/**
 * AlertRuleService.getAlertHistory — the severity filter is a SET.
 *
 * The tenant console groups alert-engine's six severities into alarm
 * priorities (P3 = MEDIUM + WARNING, web/shared-ui AnnunciatorPriority), and
 * the alarm list opens filtered to the priority of the annunciator tile that
 * was pressed. A single-severity filter cannot express P3, so the history
 * query also takes `severities` and narrows with IN; the single `severity`
 * stays, because AquaMobil (an installed PWA) sends it. An empty set matches
 * no alarm (it is a filter that admits nothing, not the absence of a filter),
 * and no set means every severity. `resolved` narrows to the open alarms a
 * tile counts (or to the cleared ones), so the list holds the tile's rows.
 * An explicit GraphQL null never reaches here: the resolver turns it into an
 * absent filter (alert.resolver.spec.ts).
 */
describe('AlertRuleService.getAlertHistory — severities filter', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  let query: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let historyRepository: { createQueryBuilder: jest.Mock };
  let service: AlertRuleService;

  beforeEach(() => {
    query = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[{ id: 'alert-1' }], 1]),
    };
    historyRepository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    service = new AlertRuleService(
      collaborator<Repository<AlertRule>>({}, 'AlertRuleRepository'),
      collaborator<Repository<AlertHistory>>(historyRepository, 'AlertHistoryRepository'),
      collaborator<AlertEvaluationService>({}, 'AlertEvaluationService'),
    );
  });

  it('narrows to every severity of the set with one IN clause', async () => {
    const result = await service.getAlertHistory(
      tenantId,
      { severities: [AlertSeverity.MEDIUM, AlertSeverity.WARNING] },
      { page: 1, limit: 20 },
    );

    expect(query.where).toHaveBeenCalledWith('alert.tenantId = :tenantId', { tenantId });
    expect(query.andWhere).toHaveBeenCalledWith('alert.severity IN (:...severities)', {
      severities: [AlertSeverity.MEDIUM, AlertSeverity.WARNING],
    });
    expect(result).toEqual({ items: [{ id: 'alert-1' }], total: 1 });
  });

  it('combines the severity set with the acknowledgement filter', async () => {
    await service.getAlertHistory(
      tenantId,
      { severities: [AlertSeverity.CRITICAL], acknowledged: false },
      { page: 2, limit: 20 },
    );

    expect(query.andWhere).toHaveBeenCalledWith('alert.severity IN (:...severities)', {
      severities: [AlertSeverity.CRITICAL],
    });
    expect(query.andWhere).toHaveBeenCalledWith('alert.acknowledged = :acknowledged', {
      acknowledged: false,
    });
    expect(query.skip).toHaveBeenCalledWith(20);
  });

  it('keeps the single-severity filter AquaMobil sends, alone or with a set', async () => {
    await service.getAlertHistory(
      tenantId,
      { severity: AlertSeverity.HIGH, severities: [AlertSeverity.HIGH, AlertSeverity.CRITICAL] },
      { page: 1, limit: 20 },
    );

    expect(query.andWhere).toHaveBeenCalledWith('alert.severity = :severity', {
      severity: AlertSeverity.HIGH,
    });
    expect(query.andWhere).toHaveBeenCalledWith('alert.severity IN (:...severities)', {
      severities: [AlertSeverity.HIGH, AlertSeverity.CRITICAL],
    });
  });

  it('reads every severity when no set is given', async () => {
    await service.getAlertHistory(tenantId, { acknowledged: true }, { page: 1, limit: 20 });

    const clauses = query.andWhere.mock.calls.map(([clause]: [string]) => clause);
    expect(clauses).toEqual(['alert.acknowledged = :acknowledged']);
  });

  it('narrows to the open alarms, as an annunciator tile counts them', async () => {
    await service.getAlertHistory(
      tenantId,
      { severities: [AlertSeverity.CRITICAL], resolved: false },
      { page: 1, limit: 20 },
    );

    expect(query.andWhere).toHaveBeenCalledWith('alert.resolved = :resolved', {
      resolved: false,
    });
  });

  it('narrows to the cleared alarms', async () => {
    await service.getAlertHistory(tenantId, { resolved: true }, { page: 1, limit: 20 });

    const clauses = query.andWhere.mock.calls.map(([clause]: [string]) => clause);
    expect(clauses).toEqual(['alert.resolved = :resolved']);
    expect(query.andWhere).toHaveBeenCalledWith('alert.resolved = :resolved', { resolved: true });
  });

  it('answers an empty set with no alarms, without querying', async () => {
    const result = await service.getAlertHistory(
      tenantId,
      { severities: [] },
      { page: 1, limit: 20 },
    );

    expect(result).toEqual({ items: [], total: 0 });
    expect(historyRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
