/**
 * RecordMortalityCommand
 *
 * Batch için ölüm kaydı oluşturur.
 * Mortality, batch metriklerini (survival rate, retention rate) etkiler.
 *
 * @module Batch/Commands
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import { ITenantCommand } from '@platform/cqrs';

// SSoT: MortalityReason is owned by tank-operation.enums.ts. Re-export so every
// existing `import { MortalityReason } from '../commands/record-mortality.command'`
// keeps compiling against ONE enum identity (the DB column now carries
// PREDATION + CANNIBALISM — no more silent UNKNOWN coercion).
export { MortalityReason } from '../entities/tank-operation.enums';
import { MortalityReason } from '../entities/tank-operation.enums';

export interface RecordMortalityPayload {
  tankId: string; // Tank ID (hangi tank'ta)
  quantity?: number; // Ölü sayısı (yalnız-kg modunda türetilir)
  avgWeightG?: number; // Ortalama ağırlık (gram)
  /** D-3 mod (b): tane+kg — verilen kg aynen düşer, kalan ortalama kayar. */
  biomassKg?: number;
  reason: MortalityReason; // Ölüm nedeni
  detail?: string; // Detaylı açıklama
  observedAt: Date; // Gözlem tarihi
  observedBy?: string; // Gözlemleyen kişi
  notes?: string;
}

export class RecordMortalityCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: RecordMortalityPayload,
    public readonly recordedBy: string,
    // SEC-HIGH-051: caller authz context for the object-level site check.
    // userRoles drives the canonical MODULE_MANAGER+ bypass; callerAssignedSiteIds
    // is the caller's JWT `assignedSiteIds` claim (the sites they may mutate).
    // Default [] is fail-closed: a non-manager with no sites is DENIED.
    public readonly userRoles: Role[] = [],
    public readonly callerAssignedSiteIds: string[] = [],
    public readonly mobileCommand?: MobileCommandEnvelope,
  ) {}
}
