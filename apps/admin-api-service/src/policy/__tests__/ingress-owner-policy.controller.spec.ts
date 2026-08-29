import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { SecurityEventService } from '@aquaculture/backend-common/security';

import { AuditLogService } from '../../audit/audit.service';
import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { IngressOwnerPolicyController } from '../ingress-owner-policy.controller';
import { IngressOwnerPolicyService } from '../services/ingress-owner-policy.service';

describe('IngressOwnerPolicyController', () => {
  it('is explicitly restricted to platform administrators', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, IngressOwnerPolicyController) as unknown[];

    expect(guards).toContain(PlatformAdminGuard);
  });

  it('derives the actor from the authenticated principal and records audit/security evidence', async () => {
    const append = jest.fn().mockResolvedValue({
      tenantId: '0f3f4a75-c611-4ad4-9fe4-89ea0c978a1a',
      version: 1,
      owner: 'NESTJS',
      effectiveEpoch: '2026-08-25T12:00:00.000Z',
      state: 'PREPARING',
    });
    const log = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const publishSuspiciousActivity = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [IngressOwnerPolicyController],
      providers: [
        { provide: IngressOwnerPolicyService, useValue: { append } },
        { provide: AuditLogService, useValue: { log } },
        { provide: SecurityEventService, useValue: { publishSuspiciousActivity } },
      ],
    })
      .overrideGuard(PlatformAdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = moduleRef.get(IngressOwnerPolicyController);

    const result = await controller.appendPolicy(
      {
        tenantId: '0f3f4a75-c611-4ad4-9fe4-89ea0c978a1a',
        version: 1,
        owner: 'NESTJS',
        effectiveEpoch: '2026-08-25T12:00:00.000Z',
        state: 'PREPARING',
        drainBarrierSatisfied: false,
        reason: 'Establish the initial Node owner',
      },
      {
        id: '8e471b18-8ddd-428f-93dc-f4bd6c1e6f07',
        email: 'platform-admin@example.com',
        roles: ['SUPER_ADMIN'],
      },
    );

    expect(result.state).toBe('PREPARING');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: '8e471b18-8ddd-428f-93dc-f4bd6c1e6f07',
        drainBarrierSatisfied: false,
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INGRESS_OWNER_POLICY_CHANGED',
        performedBy: '8e471b18-8ddd-428f-93dc-f4bd6c1e6f07',
        details: expect.objectContaining({ reason: 'Establish the initial Node owner' }),
      }),
    );
    expect(publishSuspiciousActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'INGRESS_OWNER_POLICY_CHANGED',
        tenantId: '0f3f4a75-c611-4ad4-9fe4-89ea0c978a1a',
      }),
    );
  });
});
