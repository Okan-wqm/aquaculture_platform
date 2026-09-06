/**
 * ADMIN-HIGH-009 — admin NATS bridge contract for the monitoring aggregates.
 *
 * Verifies (London school — the MonitoringStatsService collaborator is mocked):
 *   1. the two @MessagePattern strings match EXACTLY what admin-api-service's
 *      MessagingAdminController sends (`request.messaging.admin.getMonitoringStats`
 *      / `request.messaging.admin.getTenantsOverview`);
 *   2. the handler delegates to MonitoringStatsService and returns its result
 *      unmodified (no reshaping at the transport boundary).
 */
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { Test } from '@nestjs/testing';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { RetentionPolicyService } from '../compliance/services/retention-policy.service';
import { ComplianceAuditService } from '../compliance/services/compliance-audit.service';
import { DataExportService } from '../compliance/services/data-export.service';
import { AiPersonasRegistryService } from '../ai/services/ai-personas-registry.service';
import {
  MessagingMonitoringStats,
  MessagingTenantsOverview,
  MonitoringStatsService,
} from '../monitoring/services/monitoring-stats.service';
import { MessagingAdminNatsHandler } from './messaging-admin-nats.handler';

/** Flatten the pattern metadata (array in current @nestjs/microservices). */
function patternsOf(method: unknown): string[] {
  const metadata: unknown = Reflect.getMetadata(PATTERN_METADATA, method as object);
  return Array.isArray(metadata) ? metadata.map(String) : [String(metadata)];
}

describe('MessagingAdminNatsHandler — monitoring patterns (ADMIN-HIGH-009)', () => {
  let handler: MessagingAdminNatsHandler;
  let getMonitoringStats: jest.Mock;
  let getTenantsOverview: jest.Mock;

  const stats: MessagingMonitoringStats = {
    totals: {
      totalMessages: 400,
      messages24h: 35,
      messages7d: 130,
      activeChannels: 10,
      tenantCount: 2,
    },
    perTenant: [
      {
        tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        messageCount24h: 25,
        messageCount7d: 90,
        totalMessages: 300,
        activeChannels: 7,
      },
    ],
    outbox: { pendingCount: 4, failedCount: 2, oldestPendingAgeSeconds: 124 },
    generatedAt: '2026-07-13T00:00:00.000Z',
  };

  const overview: MessagingTenantsOverview = {
    tenants: stats.perTenant,
    generatedAt: '2026-07-13T00:00:00.000Z',
  };

  beforeEach(async () => {
    getMonitoringStats = jest.fn().mockResolvedValue(stats);
    getTenantsOverview = jest.fn().mockResolvedValue(overview);

    // Nest's testing module resolves collaborators without type casts —
    // useValue providers are untyped at the DI boundary by design.
    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingAdminNatsHandler,
        { provide: CommandBus, useValue: { execute: jest.fn() } },
        { provide: QueryBus, useValue: { execute: jest.fn() } },
        { provide: LegalHoldService, useValue: { getHolds: jest.fn(), getActiveHolds: jest.fn() } },
        { provide: RetentionPolicyService, useValue: {} },
        { provide: ComplianceAuditService, useValue: { getAuditLog: jest.fn() } },
        { provide: DataExportService, useValue: { exportTenant: jest.fn() } },
        { provide: AiPersonasRegistryService, useValue: { getAvailablePersonas: jest.fn() } },
        { provide: MonitoringStatsService, useValue: { getMonitoringStats, getTenantsOverview } },
      ],
    }).compile();

    handler = moduleRef.get(MessagingAdminNatsHandler);
  });

  it('binds getMonitoringStats to the exact pattern the admin-api controller sends', () => {
    expect(patternsOf(handler.getMonitoringStats)).toContain(
      'request.messaging.admin.getMonitoringStats',
    );
  });

  it('binds getTenantsOverview to the exact pattern the admin-api controller sends', () => {
    expect(patternsOf(handler.getTenantsOverview)).toContain(
      'request.messaging.admin.getTenantsOverview',
    );
  });

  it('delegates getMonitoringStats to MonitoringStatsService and returns its result', async () => {
    await expect(handler.getMonitoringStats()).resolves.toEqual(stats);
    expect(getMonitoringStats).toHaveBeenCalledTimes(1);
  });

  it('delegates getTenantsOverview to MonitoringStatsService and returns its result', async () => {
    await expect(handler.getTenantsOverview()).resolves.toEqual(overview);
    expect(getTenantsOverview).toHaveBeenCalledTimes(1);
  });
});
