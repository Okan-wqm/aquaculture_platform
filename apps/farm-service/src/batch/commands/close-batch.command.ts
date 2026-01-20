/**
 * CloseBatchCommand
 *
 * Batch'i kapatır (CLOSED durumuna geçirir).
 * Hasat tamamlandıktan veya başarısız olarak işaretlendikten sonra kullanılır.
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export enum BatchCloseReason {
  HARVEST_COMPLETED = 'harvest_completed',   // Hasat tamamlandı
  TRANSFERRED = 'transferred',               // Transfer edildi
  FAILED = 'failed',                         // Başarısız oldu
  CANCELLED = 'cancelled',                   // İptal edildi
  OTHER = 'other',                           // Diğer
}

export class CloseBatchCommand implements ITenantCommand {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly reason: BatchCloseReason,
    public readonly notes?: string,
    public readonly closedBy?: string,
  ) {}
}
