import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { In } from 'typeorm';

import {
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  LoginAttempt,
  ApiUsageLog,
  UserSession,
} from '../../entities/security.entity';
import { SecurityMonitoringService } from '../security-monitoring.service';

/**
 * APA-244: the SecurityDashboard "Resolved" tile previously counted
 * status==='closed' within the FE's first incidents page (default 20 rows), so
 * the resolved count was silently capped. The dashboard stats endpoint now owns
 * a server-side aggregate over the whole incident table. These tests pin that
 * `resolvedIncidents` is a distinct count of the resolved status set
 * (recovered/closed) — not a slice, and not the active set. Mocked repos, no DB.
 */
type RepoMock = {
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
  findOne: jest.Mock;
};

const makeQueryBuilder = (): Record<string, jest.Mock> => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'limit',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
};

const makeRepo = (): RepoMock => ({
  count: jest.fn().mockResolvedValue(0),
  createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  findOne: jest.fn().mockResolvedValue(null),
});

describe('SecurityMonitoringService.getSecurityDashboardStats resolved incidents (APA-244)', () => {
  let service: SecurityMonitoringService;
  let securityEventRepo: RepoMock;
  let incidentRepo: RepoMock;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    securityEventRepo = makeRepo();
    incidentRepo = makeRepo();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityMonitoringService,
        { provide: getRepositoryToken(SecurityEvent), useValue: securityEventRepo },
        { provide: getRepositoryToken(SecurityIncident), useValue: incidentRepo },
        { provide: getRepositoryToken(ThreatIntelligence), useValue: makeRepo() },
        { provide: getRepositoryToken(LoginAttempt), useValue: makeRepo() },
        { provide: getRepositoryToken(ApiUsageLog), useValue: makeRepo() },
        { provide: getRepositoryToken(UserSession), useValue: makeRepo() },
      ],
    }).compile();
    service = moduleRef.get(SecurityMonitoringService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns resolvedIncidents as a distinct server-side count of recovered/closed incidents', async () => {
    // incidentRepository.count is called twice, in order: active then resolved.
    incidentRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(7);

    const stats = await service.getSecurityDashboardStats();

    expect(stats.activeIncidents).toBe(3);
    expect(stats.resolvedIncidents).toBe(7);
    expect(incidentRepo.count).toHaveBeenCalledTimes(2);
  });

  it('scopes the resolved count to the recovered/closed status set (not a page slice)', async () => {
    await service.getSecurityDashboardStats();

    expect(incidentRepo.count).toHaveBeenNthCalledWith(2, {
      where: { status: In(['recovered', 'closed']) },
    });
  });
});
