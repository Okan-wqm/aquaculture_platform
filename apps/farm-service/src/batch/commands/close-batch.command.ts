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
import { Role } from '@aquaculture/backend-common/decorators';

export enum BatchCloseReason {
  HARVEST_COMPLETED = 'harvest_completed',   // Hasat tamamlandi
  TRANSFERRED = 'transferred',               // Transfer edildi
  FAILED = 'failed',                         // Basarisiz oldu
  CANCELLED = 'cancelled',                   // Iptal edildi
  // close-batch-enum (FARM-HIGH): the FE close-batch picker has long offered
  // these four legitimate aquaculture close reasons, but the backend enum
  // lacked them so every such selection failed GraphQL enum validation (the
  // mutation never reached the handler). Added here — the server enum is the
  // SSoT and the FE picker already matches it. closeReason persists as a string
  // (BatchClosedEvent.closeReason is FREE_TEXT), so no event-contract change.
  TOTAL_MORTALITY = 'total_mortality',       // Tüm stok telef oldu
  DISEASE_OUTBREAK = 'disease_outbreak',     // Hastalık kaynaklı itlaf
  COMMERCIAL_DECISION = 'commercial_decision', // Ticari karar (erken kapanış)
  MERGED = 'merged',                         // Başka partiyle birleştirildi
  OTHER = 'other',                           // Diger (admin-only)
}

/** Typed options object for CloseBatchCommand to prevent argument transposition */
export interface CloseBatchOptions {
  readonly tenantId: string;
  readonly batchId: string;
  readonly reason: BatchCloseReason;
  readonly closedBy: string;
  readonly userRoles: Role[];
  readonly notes?: string;
  /**
   * Explicit user acknowledgement that closing the batch while a
   * medicine withdrawal period is still active is intentional.
   *
   * When the batch has active HealthEvent rows whose
   * `earliestHarvestDate` is still in the future, the handler refuses
   * to close unless this flag is `true`. The acknowledgement is
   * persisted to the audit log so the operator who accepted the
   * override is traceable. Default false — a close attempt without
   * the flag surfaces the list of blocking events in the error body
   * so the UI can render them.
   *
   * This is independent of the OTHER-reason admin override: a
   * TENANT_ADMIN closing a batch for `OTHER` reasons still needs to
   * acknowledge if there are open treatments. Food-safety compliance
   * (Mattilsynet / EU Reg 37/2010) is not bypassable by role.
   */
  readonly acknowledgeActiveTreatments?: boolean;
}

export class CloseBatchCommand implements ITenantCommand {
  public readonly tenantId: string;
  public readonly batchId: string;
  public readonly reason: BatchCloseReason;
  public readonly closedBy: string;
  public readonly userRoles: Role[];
  public readonly notes?: string;
  public readonly acknowledgeActiveTreatments: boolean;

  constructor(opts: CloseBatchOptions) {
    this.tenantId = opts.tenantId;
    this.batchId = opts.batchId;
    this.reason = opts.reason;
    this.closedBy = opts.closedBy;
    this.userRoles = opts.userRoles;
    this.notes = opts.notes;
    this.acknowledgeActiveTreatments = opts.acknowledgeActiveTreatments ?? false;
  }
}
