/**
 * CreateCleanerBatchCommand
 *
 * Yeni bir cleaner fish batch'i oluşturur.
 * Lumpfish, Ballan Wrasse, vb. türler için kullanılır.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export interface CreateCleanerBatchPayload {
  speciesId: string;              // Cleaner fish tür ID (zorunlu - isCleanerFish=true olmalı)
  initialQuantity: number;        // Başlangıç adedi
  initialAvgWeightG: number;      // Başlangıç ortalama ağırlık (gram)
  sourceType: 'farmed' | 'wild_caught'; // Kaynak tipi
  sourceLocation?: string;        // Kaynak lokasyonu (tedarikçi/yakalama noktası)
  supplierId?: string;            // Tedarikçi ID
  stockedAt: Date;                // Stoklama tarihi
  purchaseCost?: number;          // Satın alma maliyeti
  currency?: string;              // Para birimi (default: TRY)
  notes?: string;
}

export class CreateCleanerBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateCleanerBatchPayload,
    public readonly createdBy: string,
  ) {}
}
