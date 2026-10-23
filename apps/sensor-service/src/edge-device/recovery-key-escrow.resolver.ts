import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  CurrentUser,
  type CurrentUserPayload,
  Role,
  Roles,
  Tenant,
} from '@aquaculture/backend-common/decorators';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import {
  RecoveryKeyEscrowStatusType,
  RetrievedRecoveryEscrowType,
} from './dto/recovery-key-escrow.dto';
import { EdgeDeviceService } from './edge-device.service';
import { RecoveryKeyEscrowService } from './recovery-key-escrow.service';

/**
 * The console's view of the `/data` recovery escrow (ADR-048 DEC-14.3).
 *
 * Seeing that a device's recovery key is escrowed, and by which escrow key, is open to the
 * tenant administrator and the module manager. Taking the envelope out is the tenant
 * administrator's alone (a platform administrator passes the roles guard), needs a stated
 * reason, and is an audited operation whose own record the service writes in the
 * transaction that reads the envelope. It is a mutation, not a query: it changes what the
 * record says. The envelope is ciphertext for the offline HSM; nothing here can open it.
 *
 * A device of another tenant answers like a device that does not exist.
 */
@Resolver()
export class RecoveryKeyEscrowResolver {
  constructor(
    private readonly escrow: RecoveryKeyEscrowService,
    private readonly devices: EdgeDeviceService,
  ) {}

  @Query(() => [RecoveryKeyEscrowStatusType], {
    name: 'recoveryKeyEscrows',
    description:
      "A Suderra OS device's escrowed /data recovery envelopes, newest first, without their ciphertext",
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async recoveryKeyEscrows(
    @Tenant() tenantId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
  ): Promise<RecoveryKeyEscrowStatusType[]> {
    if ((await this.devices.findById(deviceId, tenantId)) === null) return [];
    const rows = await this.escrow.status(tenantId, deviceId);
    return rows.map((row) => Object.assign(new RecoveryKeyEscrowStatusType(), row));
  }

  @Mutation(() => [RetrievedRecoveryEscrowType], {
    name: 'retrieveRecoveryKeyEscrow',
    description:
      'Takes the current escrowed /data recovery envelope(s) of a device out for the custodians to open in the offline HSM; the retrieval is recorded with the reason given',
  })
  @Roles(Role.TENANT_ADMIN)
  @AuditedOperation({ resource: 'RecoveryKeyEscrow', action: 'RETRIEVE' })
  async retrieveRecoveryKeyEscrow(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Args('reason') reason: string,
  ): Promise<RetrievedRecoveryEscrowType[]> {
    const retrieved = await this.escrow.retrieve(tenantId, deviceId, user.sub, reason);
    return retrieved.map((item) =>
      Object.assign(new RetrievedRecoveryEscrowType(), {
        escrowId: item.escrowId,
        deviceId: item.deviceId,
        receivedAt: item.receivedAt,
        envelope: JSON.stringify(item.envelope),
      }),
    );
  }
}
