/**
 * RecordCullCommand
 *
 * Batch için ayıklama (cull) kaydı oluşturur.
 * Cull, grading sonrası küçük/deforme/hasta balıkların ayrılmasıdır.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export enum CullReason {
  SMALL_SIZE = 'small_size',     // Küçük boy
  DEFORMED = 'deformed',         // Deformite
  SICK = 'sick',                 // Hasta
  POOR_GROWTH = 'poor_growth',   // Zayıf büyüme
  GRADING = 'grading',           // Grading sonucu
  QUALITY = 'quality',           // Kalite yetersizliği
  OTHER = 'other',               // Diğer
}

export interface RecordCullPayload {
  tankId: string;                // Tank ID
  quantity: number;              // Ayıklanan sayı
  avgWeightG?: number;           // Ortalama ağırlık (gram)
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
  ) {}
}
