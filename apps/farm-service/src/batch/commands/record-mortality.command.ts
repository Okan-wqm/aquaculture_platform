/**
 * RecordMortalityCommand
 *
 * Batch için ölüm kaydı oluşturur.
 * Mortality, batch metriklerini (survival rate, retention rate) etkiler.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export enum MortalityReason {
  DISEASE = 'disease',           // Hastalık
  WATER_QUALITY = 'water_quality', // Su kalitesi
  STRESS = 'stress',             // Stres
  HANDLING = 'handling',         // Taşıma/işleme
  TEMPERATURE = 'temperature',   // Sıcaklık şoku
  OXYGEN = 'oxygen',             // Oksijen yetersizliği
  PREDATION = 'predation',       // Predatör
  CANNIBALISM = 'cannibalism',   // Yamyamlık
  UNKNOWN = 'unknown',           // Bilinmiyor
  OTHER = 'other',               // Diğer
}

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
  ) {}
}
