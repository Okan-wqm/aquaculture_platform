/**
 * CloseBatchCommand
 *
 * Batch'i kapatir (CLOSED durumuna gecirir).
 * Hasat tamamlandiktan veya basarisiz olarak isaretlendikten sonra kullanilir.
 *
 * BREAKING CHANGE: Replaced positional constructor with typed options object
 * to prevent future argument transposition (closedBy/notes were swapped).
 *
 * @module Batch/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export enum BatchCloseReason {
  HARVEST_COMPLETED = 'harvest_completed',   // Hasat tamamlandi
  TRANSFERRED = 'transferred',               // Transfer edildi
  FAILED = 'failed',                         // Basarisiz oldu
  CANCELLED = 'cancelled',                   // Iptal edildi
  OTHER = 'other',                           // Diger (admin-only)
}

/** Typed options object for CloseBatchCommand to prevent argument transposition */
export interface CloseBatchOptions {
  readonly tenantId: string;
  readonly batchId: string;
  readonly reason: BatchCloseReason;
  readonly closedBy: string;
  readonly userRoles: string[];
  readonly notes?: string;
}

export class CloseBatchCommand implements ITenantCommand {
  public readonly tenantId: string;
  public readonly batchId: string;
  public readonly reason: BatchCloseReason;
  public readonly closedBy: string;
  public readonly userRoles: string[];
  public readonly notes?: string;

  constructor(opts: CloseBatchOptions) {
    this.tenantId = opts.tenantId;
    this.batchId = opts.batchId;
    this.reason = opts.reason;
    this.closedBy = opts.closedBy;
    this.userRoles = opts.userRoles;
    this.notes = opts.notes;
  }
}
