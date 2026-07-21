import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

import {
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  LoginAttempt,
  ApiUsageLog,
  UserSession,
} from '../../entities/security.entity';
import {
  SecurityMonitoringService,
  SECURITY_TELEMETRY_LIVENESS_WINDOW_MS,
} from '../security-monitoring.service';

/**
 * APA-240: the security dashboard aggregates over admin.security_events /
 * login_attempts / api_usage_logs / user_sessions. When those tables are empty
 * (the supply chain is currently dead — no producers), the health-score
 * arithmetic still yields a high "healthy" number over zeros. getTelemetryLiveness
 * is the honesty signal the FE uses to render "No telemetry" instead of a green
 * gauge. These tests pin its three states. Mocked repos — no DB.
 */
type RepoMock = { findOne: jest.Mock; count: jest.Mock };
const makeRepo = (): RepoMock => ({
  findOne: jest.fn().mockResolvedValue(null),
  count: jest.fn().mockResolvedValue(0),
});

describe('SecurityMonitoringService.getTelemetryLiveness (APA-240)', () => {
  let service: SecurityMonitoringService;
  let securityEventRepo: RepoMock;
  let loginAttemptRepo: RepoMock;
  let apiUsageRepo: RepoMock;
  let sessionRepo: RepoMock;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    securityEventRepo = makeRepo();
    loginAttemptRepo = makeRepo();
    apiUsageRepo = makeRepo();
    sessionRepo = makeRepo();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityMonitoringService,
        { provide: getRepositoryToken(SecurityEvent), useValue: securityEventRepo },
        { provide: getRepositoryToken(SecurityIncident), useValue: makeRepo() },
        { provide: getRepositoryToken(ThreatIntelligence), useValue: makeRepo() },
        { provide: getRepositoryToken(LoginAttempt), useValue: loginAttemptRepo },
        { provide: getRepositoryToken(ApiUsageLog), useValue: apiUsageRepo },
        { provide: getRepositoryToken(UserSession), useValue: sessionRepo },
      ],
    }).compile();
    service = moduleRef.get(SecurityMonitoringService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports no_data when every telemetry source is empty (never a green score over a void)', async () => {
    const result = await service.getTelemetryLiveness();
    expect(result).toEqual({ dataStatus: 'no_data', lastSeenAt: null });
  });

  it('reports live when the newest telemetry row is within the liveness window', async () => {
    const recent = new Date(Date.now() - 60_000);
    loginAttemptRepo.findOne.mockResolvedValue({ createdAt: recent });

    const result = await service.getTelemetryLiveness();

    expect(result.dataStatus).toBe('live');
    expect(result.lastSeenAt).toBe(recent.toISOString());
  });

  it('reports stale when the newest telemetry row is older than the window', async () => {
    const old = new Date(Date.now() - SECURITY_TELEMETRY_LIVENESS_WINDOW_MS - 60_000);
    securityEventRepo.findOne.mockResolvedValue({ createdAt: old });

    const result = await service.getTelemetryLiveness();

    expect(result.dataStatus).toBe('stale');
    expect(result.lastSeenAt).toBe(old.toISOString());
  });

  it('uses the newest createdAt across all sources for lastSeenAt', async () => {
    const older = new Date(Date.now() - 5 * 60_000);
    const newer = new Date(Date.now() - 60_000);
    loginAttemptRepo.findOne.mockResolvedValue({ createdAt: older });
    apiUsageRepo.findOne.mockResolvedValue({ createdAt: newer });

    const result = await service.getTelemetryLiveness();

    expect(result.lastSeenAt).toBe(newer.toISOString());
    expect(result.dataStatus).toBe('live');
  });
});
