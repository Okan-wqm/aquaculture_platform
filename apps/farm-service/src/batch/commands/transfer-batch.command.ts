/**
 * TransferBatchCommand
 *
 * Batch'i bir tank'tan diğerine transfer eder.
 * Kaynak ve hedef tank'ların TankBatch durumlarını günceller.
 *
 * @module Batch/Commands
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import { ITenantCommand } from '@platform/cqrs';

export interface TransferBatchPayload {
  sourceTankId: string; // Kaynak tank ID
  destinationTankId: string; // Hedef tank ID
  quantity?: number; // Transfer edilecek adet (yalnız-kg modunda türetilir)
  avgWeightG?: number; // Ortalama ağırlık (otomatik hesaplanabilir)
  /** D-3 mod (b): tane+kg — verilen kg aynen düşer, kalan ortalama kayar. */
  biomassKg?: number;
  transferReason?: string; // Transfer nedeni
  transferredAt?: Date; // Transfer tarihi (default: now)
  notes?: string;
  skipCapacityCheck?: boolean; // Kapasite kontrolünü atla (aşırı yüklemeye izin ver)
}

export class TransferBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: TransferBatchPayload,
    public readonly transferredBy: string,
    // SEC-HIGH-051: caller authz context. Transfer touches TWO sites (source +
    // destination tank), so the handler asserts EACH leg with this context.
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
    public readonly mobileCommand?: MobileCommandEnvelope,
  ) {}
}
