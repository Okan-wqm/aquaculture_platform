/**
 * RecordCullCommand
 *
 * Batch için ayıklama (cull) kaydı oluşturur.
 * Cull, grading sonrası küçük/deforme/hasta balıkların ayrılmasıdır.
 *
 * @module Batch/Commands
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import { ITenantCommand } from '@platform/cqrs';

// SSoT: CullReason is owned by tank-operation.enums.ts. Re-export so every
// existing `import { CullReason } from '../commands/record-cull.command'`
// keeps compiling against ONE enum identity (the DB column + the command now
// agree — QUALITY is no longer a command-only value the DB rejects).
export { CullReason } from '../entities/tank-operation.enums';
import { CullReason } from '../entities/tank-operation.enums';

export interface RecordCullPayload {
  tankId: string;                // Tank ID
  quantity: number;              // Ayıklanan sayı
  avgWeightG?: number;           // Ortalama ağırlık (gram)
  /** D-3 mod (b): tane+kg — verilen kg aynen düşer, kalan ortalama kayar. */
  biomassKg?: number;
  reason: CullReason;            // Ayıklama nedeni
  detail?: string;               // Detaylı açıklama
  culledAt: Date;                // Ayıklama tarihi
  notes?: string;
}

export class RecordCullCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: RecordCullPayload,
    public readonly recordedBy: string,
    // SEC-HIGH-051: caller authz context for the object-level site check.
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
    public readonly mobileCommand?: MobileCommandEnvelope,
  ) {}
}
