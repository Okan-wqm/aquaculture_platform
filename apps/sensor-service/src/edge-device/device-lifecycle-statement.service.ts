import { Injectable } from '@nestjs/common';

import {
  contractTimestamp,
  type DeviceBinding,
  type DeviceLifecycleStatement,
  type SignedStatement,
  STATEMENT,
} from './edge-contract';
import { ManifestSigner } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * Device-lifecycle statements (ADR-048 DEC-5.14, DEC-12): signed by the
 * separate `device-lifecycle` signer identity, whose key only the OS image
 * pins. P0 issues exactly one action — enter MAINTENANCE to re-provision,
 * for a bounded window — which the agent hands to root unchanged
 * (`lifecycle_request` command) and root verifies and performs. Decommission,
 * RMA and break-glass arrive with the same statement in P3.
 */

export interface EnterMaintenanceInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly binding: DeviceBinding;
  /** Monotonic per device; root refuses an equal or lower value. */
  readonly updateSeq: number;
  readonly notBefore: string;
  readonly expiresAt: string;
}

export function buildEnterMaintenance(input: EnterMaintenanceInput): DeviceLifecycleStatement {
  return {
    _type: STATEMENT.deviceLifecycle,
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    device_binding: input.binding,
    action: 'enter-maintenance',
    purpose: 'reprovision',
    update_seq: input.updateSeq,
    not_before: input.notBefore,
    expires_at: input.expiresAt,
  };
}

@Injectable()
export class DeviceLifecycleStatementService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  enterMaintenanceForReprovisioning(request: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly binding: DeviceBinding;
    readonly updateSeq: number;
    readonly window: { readonly notBefore: Date; readonly expiresAt: Date };
  }): SignedStatement<typeof STATEMENT.deviceLifecycle> {
    const signer = new ManifestSigner(this.config.settings.keys.deviceLifecycle);
    return signer.sign(
      STATEMENT.deviceLifecycle,
      buildEnterMaintenance({
        tenantId: request.tenantId,
        deviceId: request.deviceId,
        binding: request.binding,
        updateSeq: request.updateSeq,
        notBefore: contractTimestamp(request.window.notBefore),
        expiresAt: contractTimestamp(request.window.expiresAt),
      }),
    );
  }
}
