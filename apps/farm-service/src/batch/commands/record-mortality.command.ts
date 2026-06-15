/**
 * RecordMortalityCommand
 *
 * Batch için ölüm kaydı oluşturur.
 * Mortality, batch metriklerini (survival rate, retention rate) etkiler.
 *
 * @module Batch/Commands
 */
import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import { ITenantCommand } from '@platform/cqrs';

// SSoT: MortalityReason is owned by tank-operation.enums.ts. Re-export so every
// existing `import { MortalityReason } from '../commands/record-mortality.command'`
// keeps compiling against ONE enum identity (the DB column now carries
// PREDATION + CANNIBALISM — no more silent UNKNOWN coercion).
export { MortalityReason } from '../entities/tank-operation.enums';
import { MortalityReason } from '../entities/tank-operation.enums';

export interface RecordMortalityPayload {
  tankId: string;                // Tank ID (hangi tank'ta)
  quantity: number;              // Ölü sayısı
  avgWeightG?: number;           // Ortalama ağırlık (gram)
  reason: MortalityReason;       // Ölüm nedeni
  detail?: string;               // Detaylı açıklama
  observedAt: Date;              // Gözlem tarihi
  observedBy?: string;           // Gözlemleyen kişi
  notes?: string;
}

export class RecordMortalityCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly payload: RecordMortalityPayload,
    public readonly recordedBy: string,
    public readonly mobileCommand?: MobileCommandEnvelope,
  ) {}
}
