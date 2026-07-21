/**
 * APA-163 — legal-hold release dual-approver chain.
 *
 * Two guarantees under test:
 *   1. The REST → NATS forward carries the full dual-approver contract payload
 *      (`holdId`, `tenantId`, `userId`, `approverId`, `releaseReason`) to the
 *      `releaseLegalHold` subject — the pre-fix chain dropped approverId +
 *      releaseReason, so every release failed at the deep command handler.
 *   2. `ReleaseLegalHoldDto` (a class-validator class, so the global
 *      ValidationPipe actually engages) rejects a missing/short/whitespace
 *      reason and a non-UUID approver at the trust boundary — a non-retried 400
 *      instead of the pre-fix retried 502.
 */
import { of } from 'rxjs';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { MessagingAdminController } from '../messaging-admin.controller';
import { ReleaseLegalHoldDto } from '../dto/release-legal-hold.dto';
import type { CurrentUserData } from '../../decorators/current-user.decorator';

const HOLD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const APPROVER_ID = '33333333-3333-4333-8333-333333333333';
const RELEASER: CurrentUserData = {
  id: '44444444-4444-4444-8444-444444444444',
  email: 'releaser@platform.test',
  roles: ['SUPER_ADMIN'],
};
const VALID_REASON =
  'Matter 2026-0042 concluded; retention obligation lifted per counsel sign-off.';

describe('MessagingAdminController.releaseLegalHold (APA-163)', () => {
  async function makeController(sendReturn: unknown): Promise<{
    controller: MessagingAdminController;
    send: jest.Mock;
  }> {
    const send = jest.fn().mockReturnValue(of(sendReturn));
    const moduleRef = await Test.createTestingModule({
      controllers: [MessagingAdminController],
      providers: [
        { provide: 'MESSAGING_NATS_CLIENT', useValue: { send } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(15_000) } },
      ],
    }).compile();
    const controller = moduleRef.get(MessagingAdminController);
    return { controller, send };
  }

  it('forwards the full dual-approver payload to the releaseLegalHold subject', async () => {
    const backendHold = {
      id: HOLD_ID,
      tenantId: TENANT_ID,
      channelId: null,
      reason: 'original',
      isActive: false,
      createdAt: '2026-07-21T00:00:00.000Z',
    };
    const { controller, send } = await makeController(backendHold);

    const dto: ReleaseLegalHoldDto = {
      tenantId: TENANT_ID,
      approverId: APPROVER_ID,
      releaseReason: VALID_REASON,
    };

    const result = await controller.releaseLegalHold(HOLD_ID, dto, RELEASER);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('request.messaging.admin.releaseLegalHold', {
      holdId: HOLD_ID,
      tenantId: TENANT_ID,
      userId: RELEASER.id,
      approverId: APPROVER_ID,
      releaseReason: VALID_REASON,
    });
    expect(result).toEqual(backendHold);
  });
});

describe('ReleaseLegalHoldDto validation (APA-163 trust boundary)', () => {
  async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(ReleaseLegalHoldDto, payload);
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  }

  it('accepts a valid dual-approver payload', async () => {
    expect(
      await errorsFor({
        tenantId: TENANT_ID,
        approverId: APPROVER_ID,
        releaseReason: VALID_REASON,
      }),
    ).toEqual([]);
  });

  it('rejects a reason shorter than the shared minimum', async () => {
    expect(
      await errorsFor({
        tenantId: TENANT_ID,
        approverId: APPROVER_ID,
        releaseReason: 'too short',
      }),
    ).toContain('releaseReason');
  });

  it('rejects a whitespace-only reason (trimmed before length check)', async () => {
    expect(
      await errorsFor({
        tenantId: TENANT_ID,
        approverId: APPROVER_ID,
        releaseReason: ' '.repeat(80),
      }),
    ).toContain('releaseReason');
  });

  it('rejects a non-UUID approver', async () => {
    expect(
      await errorsFor({
        tenantId: TENANT_ID,
        approverId: 'not-a-uuid',
        releaseReason: VALID_REASON,
      }),
    ).toContain('approverId');
  });

  it('rejects a missing tenantId', async () => {
    expect(
      await errorsFor({
        approverId: APPROVER_ID,
        releaseReason: VALID_REASON,
      }),
    ).toContain('tenantId');
  });
});
