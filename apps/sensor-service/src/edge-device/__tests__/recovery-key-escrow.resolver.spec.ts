import { AUDITED_OPERATION_KEY } from '@aquaculture/backend-common/audit';
import { Role, ROLES_KEY } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';

import { type EdgeDeviceService } from '../edge-device.service';
import {
  ESCROW_ALGORITHM,
  ESCROW_ENVELOPE_TYPE,
  type RecoveryKeyEscrowService,
} from '../recovery-key-escrow.service';
import { RecoveryKeyEscrowResolver } from '../recovery-key-escrow.resolver';

/**
 * Who may see that a recovery key is escrowed and who may take it out (ADR-048 DEC-14.3).
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER = { sub: 'user-7', email: 'op@example.com', tenantId: TENANT, roles: ['TENANT_ADMIN'] };
const ENVELOPE = {
  _type: ESCROW_ENVELOPE_TYPE,
  volume_uuid: '3f1c7a52-9d2e-4b60-8f0a-5c2b7d1e9a41',
  algorithm: ESCROW_ALGORITHM,
  recipient_spki_sha256: 'ab'.repeat(32),
  ciphertext: Buffer.alloc(384, 7).toString('base64'),
} as const;

describe('RecoveryKeyEscrowResolver', () => {
  const status = jest.fn();
  const retrieve = jest.fn();
  const findById = jest.fn();
  let resolver: RecoveryKeyEscrowResolver;

  beforeEach(() => {
    jest.resetAllMocks();
    resolver = new RecoveryKeyEscrowResolver(
      collaborator<RecoveryKeyEscrowService>({ status, retrieve }, 'RecoveryKeyEscrowService'),
      collaborator<EdgeDeviceService>({ findById }, 'EdgeDeviceService'),
    );
  });

  const roles = (handler: keyof RecoveryKeyEscrowResolver): unknown =>
    Reflect.getMetadata(ROLES_KEY, RecoveryKeyEscrowResolver.prototype[handler]);

  it('shows the escrow to the tenant administrator and the module manager, takes it out for the administrator alone', () => {
    expect(roles('recoveryKeyEscrows')).toEqual([Role.TENANT_ADMIN, Role.MODULE_MANAGER]);
    expect(roles('retrieveRecoveryKeyEscrow')).toEqual([Role.TENANT_ADMIN]);
  });

  it('retrieval is an audited operation', () => {
    expect(
      Reflect.getMetadata(
        AUDITED_OPERATION_KEY,
        RecoveryKeyEscrowResolver.prototype.retrieveRecoveryKeyEscrow,
      ),
    ).toMatchObject({ resource: 'RecoveryKeyEscrow', action: 'RETRIEVE' });
  });

  it('retrieves as the authenticated user, in the authenticated tenant, with the reason given', async () => {
    retrieve.mockResolvedValue([
      {
        escrowId: 'e1',
        deviceId: DEVICE,
        receivedAt: new Date('2026-10-20T12:00:00Z'),
        envelope: ENVELOPE,
      },
    ]);
    const out = await resolver.retrieveRecoveryKeyEscrow(
      TENANT,
      USER,
      DEVICE,
      'Device reports tpm-unseal-failed',
    );
    expect(retrieve).toHaveBeenCalledWith(
      TENANT,
      DEVICE,
      'user-7',
      'Device reports tpm-unseal-failed',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ escrowId: 'e1', deviceId: DEVICE });
    expect(JSON.parse(out[0]?.envelope ?? '')).toEqual(ENVELOPE);
  });

  it('lists the escrow without ciphertext, and nothing for a device of another tenant', async () => {
    findById.mockResolvedValue({ id: DEVICE });
    status.mockResolvedValue([
      {
        id: 'e1',
        volumeUuid: ENVELOPE.volume_uuid,
        recipientSpkiSha256: ENVELOPE.recipient_spki_sha256,
        state: 'active',
        receivedAt: new Date('2026-10-20T12:00:00Z'),
        supersededAt: null,
        retrievals: 2,
      },
    ]);
    const listed = await resolver.recoveryKeyEscrows(TENANT, DEVICE);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0] ?? {})).not.toContain('ciphertext');
    findById.mockResolvedValue(null);
    expect(await resolver.recoveryKeyEscrows(TENANT, DEVICE)).toEqual([]);
    expect(status).toHaveBeenCalledTimes(1);
  });
});
