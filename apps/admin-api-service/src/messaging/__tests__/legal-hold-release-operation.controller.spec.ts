import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import {
  ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1,
  ADMIN_MESSAGING_RPC_SUBJECTS_V1,
  type AdminLegalHoldReleaseOperationV1,
} from '@platform/admin-http-contracts';
import { RECENT_MFA_MAX_AGE_SECONDS } from '@aquaculture/backend-common/guards';

import type { CurrentUserData } from '../../decorators/current-user.decorator';
import {
  AuthorizeLegalHoldReleaseOperationDto,
  CreateLegalHoldReleaseOperationDto,
} from '../dto/legal-hold-release-operation.dto';
import { MessagingAdminController } from '../messaging-admin.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const HOLD_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const REASON =
  'External counsel confirmed matter 2026-0042 is closed and the preservation mandate has ended.';

const USER: CurrentUserData = {
  sub: ADMIN_ID,
  id: ADMIN_ID,
  roles: ['SUPER_ADMIN'],
  mfaVerified: true,
  iat: Math.floor(Date.now() / 1_000),
  jti: 'verified-token-id',
};

function operation(): AdminLegalHoldReleaseOperationV1 {
  const now = new Date().toISOString();
  return {
    id: OPERATION_ID,
    tenantId: TENANT_ID,
    holdId: HOLD_ID,
    status: 'PENDING',
    releaseReason: REASON,
    initiationRequestId: REQUEST_ID,
    initiatedBy: ADMIN_ID,
    initiatedAt: now,
    initiatorMfaVerifiedAt: now,
    expiresAt: now,
    authorizationRequestId: null,
    authorizedBy: null,
    authorizedAt: null,
    approverMfaVerifiedAt: null,
    releasedAt: null,
    expiredAt: null,
    expiredBy: null,
  };
}

describe('MessagingAdminController legal-hold release operations', () => {
  it('forwards only server-owned actor evidence on initiation', async () => {
    const send = jest.fn().mockReturnValue(of(operation()));
    const module = await Test.createTestingModule({
      controllers: [MessagingAdminController],
      providers: [
        { provide: 'MESSAGING_NATS_CLIENT', useValue: { send } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(15_000) },
        },
      ],
    }).compile();

    await module
      .get(MessagingAdminController)
      .createLegalHoldReleaseOperation(
        HOLD_ID,
        { tenantId: TENANT_ID, requestId: REQUEST_ID, releaseReason: REASON },
        USER,
      );

    expect(send).toHaveBeenCalledWith(
      ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHoldReleaseOperation,
      {
        tenantId: TENANT_ID,
        holdId: HOLD_ID,
        requestId: REQUEST_ID,
        releaseReason: REASON,
        initiator: {
          actorId: ADMIN_ID,
          roles: ['SUPER_ADMIN'],
          mfaVerified: true,
          tokenIssuedAt: new Date(USER.iat * 1_000).toISOString(),
          tokenId: 'verified-token-id',
        },
      },
    );
  });

  it('marks both mutation methods with the canonical five-minute MFA policy', () => {
    const prototype = MessagingAdminController.prototype;
    expect(
      Reflect.getMetadata(RECENT_MFA_MAX_AGE_SECONDS, prototype.createLegalHoldReleaseOperation),
    ).toBe(ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1);
    expect(
      Reflect.getMetadata(RECENT_MFA_MAX_AGE_SECONDS, prototype.authorizeLegalHoldReleaseOperation),
    ).toBe(ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1);
  });
});

describe('legal-hold release DTO boundary', () => {
  it('rejects an undersized reason and non-UUID idempotency key', async () => {
    const dto = plainToInstance(CreateLegalHoldReleaseOperationDto, {
      tenantId: TENANT_ID,
      requestId: 'retry-me',
      releaseReason: 'too short',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['requestId', 'releaseReason']),
    );
  });

  it('keeps the authorization body identity-free', async () => {
    const dto = plainToInstance(AuthorizeLegalHoldReleaseOperationDto, {
      tenantId: TENANT_ID,
      requestId: REQUEST_ID,
    });
    await expect(validate(dto)).resolves.toEqual([]);
    expect(Object.keys(dto).sort()).toEqual(['requestId', 'tenantId']);
  });
});
