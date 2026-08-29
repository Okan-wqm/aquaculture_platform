import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Test } from '@nestjs/testing';

import { AuditLogService } from '../audit/audit.service';

import {
  CreateTelemetryCapacityEnvelopeDto,
  ReleaseTelemetryCapacityEntitlementDto,
} from './dto/tenant.dto';
import { TelemetryCapacityService } from './services/telemetry-capacity.service';
import { TelemetryCapacityAdminController } from './telemetry-capacity-admin.controller';

describe('TelemetryCapacityAdminController', () => {
  it('records audit and security evidence for an envelope revision', async () => {
    const createEnvelope = jest.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      version: 8,
      sustainedIngressMessagesPerSecond: 2_000,
      sustainedMetricRowsPerMinute: 120_000,
      effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const log = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const publishSuspiciousActivity = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryCapacityAdminController],
      providers: [
        { provide: TelemetryCapacityService, useValue: { createEnvelope } },
        { provide: AuditLogService, useValue: { log } },
        {
          provide: SecurityEventService,
          useValue: { publishSuspiciousActivity },
        },
      ],
    }).compile();
    const controller = moduleRef.get(TelemetryCapacityAdminController);
    const dto = Object.assign(new CreateTelemetryCapacityEnvelopeDto(), {
      sustainedIngressMessagesPerSecond: 2_000,
      sustainedMetricRowsPerMinute: 120_000,
      effectiveAt: '2026-09-01T00:00:00.000Z',
    });

    const result = await controller.createEnvelope(dto, {
      id: 'platform-admin-1',
      email: 'admin@example.com',
      roles: ['platform_admin'],
    });

    expect(result.version).toBe(8);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TELEMETRY_CAPACITY_ENVELOPE_CREATED',
        performedBy: 'platform-admin-1',
      }),
    );
    expect(publishSuspiciousActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'platform-admin-1',
        action: 'TELEMETRY_CAPACITY_ENVELOPE_CREATED',
      }),
    );
  });

  it('records audit and security evidence when an entitlement revision is released', async () => {
    const release = jest.fn().mockResolvedValue({
      operationId: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
      reservationId: '33333333-3333-4333-8333-333333333333',
      entitlementId: '44444444-4444-4444-8444-444444444444',
      entitlementVersion: 2,
      activationState: 'RELEASED',
      effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
      capacityEnvelopeVersion: 8,
      sustainedIngressMessagesPerSecond: 2_000,
      sustainedMetricRowsPerMinute: 120_000,
    });
    const log = jest.fn().mockResolvedValue({ id: 'audit-2' });
    const publishSuspiciousActivity = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryCapacityAdminController],
      providers: [
        { provide: TelemetryCapacityService, useValue: { release } },
        { provide: AuditLogService, useValue: { log } },
        {
          provide: SecurityEventService,
          useValue: { publishSuspiciousActivity },
        },
      ],
    }).compile();
    const controller = moduleRef.get(TelemetryCapacityAdminController);
    const dto = Object.assign(new ReleaseTelemetryCapacityEntitlementDto(), {
      reason: 'Rollback after measured capacity regression',
    });

    const result = await controller.releaseEntitlement(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      dto,
      {
        id: 'platform-admin-1',
        email: 'admin@example.com',
        roles: ['platform_admin'],
      },
    );

    expect(result.activationState).toBe('RELEASED');
    expect(release).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TELEMETRY_CAPACITY_ENTITLEMENT_RELEASED',
        performedBy: 'platform-admin-1',
        details: expect.objectContaining({ reason: dto.reason }),
      }),
    );
    expect(publishSuspiciousActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'platform-admin-1',
        action: 'TELEMETRY_CAPACITY_ENTITLEMENT_RELEASED',
      }),
    );
  });
});
