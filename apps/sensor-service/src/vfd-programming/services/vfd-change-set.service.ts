import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { VfdChangeSet } from '../entities/vfd-change-set.entity';
import { VfdChangeSetItem } from '../entities/vfd-change-set-item.entity';
import { VfdParameterAuditLog } from '../entities/vfd-parameter-audit-log.entity';
import {
  VfdChangeSetStatus,
  VfdChangeSetItemStatus,
  VfdAuditAction,
} from '../../vfd/entities/vfd.enums';
import { RiskEvaluatorService } from '../risk/risk-evaluator.service';
import { VfdParameterDefinitionService } from './vfd-parameter-definition.service';
import { VfdDeviceService } from '../../vfd/services/vfd-device.service';
import { ChangeSetItemInput, CreateChangeSetInput } from '../dto';

/**
 * VFD ChangeSet Service -- Maker-Checker Workflow Engine
 *
 * Implements the 4-eye principle for VFD parameter changes:
 *   DRAFT -> PENDING_APPROVAL -> APPROVED -> APPLYING -> APPLIED -> VERIFIED
 *                              -> REJECTED
 *   DRAFT -> CANCELLED       (maker abandons a never-submitted draft)
 *   APPROVED -> CANCELLED    (call off a scheduled / not-yet-applied change)
 *
 * Business rules:
 * - Maker (creator) cannot approve their own change set
 * - Only one active (non-draft) change set per device at a time
 * - Rollback creates an inverse change set with swapped values
 * - Emergency rollback bypasses the normal approval flow
 * - Cancel (not reject) terminates a change set BEFORE it touches the device:
 *   only DRAFT or APPROVED are cancellable. Once APPLYING/APPLIED the device
 *   already holds (some of) the new values, so rollback — not cancel — is the
 *   correct remediation. The scheduler only applies status=APPROVED rows, so
 *   moving an APPROVED change set to CANCELLED structurally prevents the
 *   pending apply with no half-applied state.
 */
@Injectable()
export class VfdChangeSetService {
  private readonly logger = new Logger(VfdChangeSetService.name);

  constructor(
    @InjectRepository(VfdChangeSet)
    private readonly changeSetRepository: Repository<VfdChangeSet>,
    @InjectRepository(VfdChangeSetItem)
    private readonly changeSetItemRepository: Repository<VfdChangeSetItem>,
    @InjectRepository(VfdParameterAuditLog)
    private readonly auditLogRepository: Repository<VfdParameterAuditLog>,
    private readonly riskEvaluator: RiskEvaluatorService,
    private readonly parameterDefinitionService: VfdParameterDefinitionService,
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── CREATE ──────────────────────────────────────────────────────────

  /**
   * Create a new change set in DRAFT status.
   * Optionally includes initial items.
   */
  async createChangeSet(
    tenantId: string,
    input: CreateChangeSetInput,
    createdBy: string,
  ): Promise<VfdChangeSet> {
    this.logger.log(`Creating change set for device ${input.vfdDeviceId} by ${createdBy}`);

    const changeSet = this.changeSetRepository.create({
      tenantId,
      vfdDeviceId: input.vfdDeviceId,
      description: input.description,
      createdBy,
      status: VfdChangeSetStatus.DRAFT,
      scheduledAt: input.scheduledAt,
      items: [],
    });

    const saved = await this.changeSetRepository.save(changeSet);

    if (input.items && input.items.length > 0) {
      return this.addItems(saved.id, input.items, tenantId);
    }

    return saved;
  }

  // ─── ITEMS ───────────────────────────────────────────────────────────

  /**
   * Add parameter change items to a DRAFT change set.
   * Validates each parameter exists and requested value is within range.
   */
  async addItems(
    changeSetId: string,
    items: ChangeSetItemInput[],
    tenantId: string,
  ): Promise<VfdChangeSet> {
    const changeSet = await this.findByIdOrFail(changeSetId, tenantId);
    this.assertStatus(changeSet, VfdChangeSetStatus.DRAFT, 'add items');

    // Resolve device brand for parameter lookups
    const deviceId = changeSet.vfdDeviceId;
    const definitions = await this.parameterDefinitionService.getDefinitionsForDevice(
      deviceId,
      tenantId,
    );

    const newItems: VfdChangeSetItem[] = [];

    for (const item of items) {
      const definition = definitions.find((d) => d.parameterName === item.parameterName);

      if (!definition) {
        throw new BadRequestException(
          `Parameter '${item.parameterName}' not found for this device`,
        );
      }

      this.validateValueInRange(
        item.parameterName,
        item.requestedValue,
        definition.minValue,
        definition.maxValue,
      );

      const changeSetItem = this.changeSetItemRepository.create({
        changeSetId,
        parameterDefinitionId: definition.id,
        parameterName: item.parameterName,
        requestedValue: item.requestedValue,
        status: VfdChangeSetItemStatus.PENDING,
      });

      newItems.push(changeSetItem);
    }

    await this.changeSetItemRepository.save(newItems);

    return this.findByIdOrFail(changeSetId, tenantId);
  }

  /**
   * Remove an item from a DRAFT change set.
   */
  async removeItem(changeSetId: string, itemId: string, tenantId: string): Promise<VfdChangeSet> {
    const changeSet = await this.findByIdOrFail(changeSetId, tenantId);
    this.assertStatus(changeSet, VfdChangeSetStatus.DRAFT, 'remove items');

    const item = await this.changeSetItemRepository.findOne({
      where: { id: itemId, changeSetId },
    });

    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found in change set ${changeSetId}`);
    }

    await this.changeSetItemRepository.remove(item);

    return this.findByIdOrFail(changeSetId, tenantId);
  }

  // ─── SUBMIT FOR APPROVAL ────────────────────────────────────────────

  /**
   * Submit a DRAFT change set for approval.
   * Validates items exist, values in range, and runs risk evaluation.
   */
  async submitForApproval(
    changeSetId: string,
    submittedBy: string,
    tenantId: string,
  ): Promise<VfdChangeSet> {
    const changeSet = await this.findByIdOrFail(changeSetId, tenantId);
    this.assertStatus(changeSet, VfdChangeSetStatus.DRAFT, 'submit');

    if (!changeSet.items || changeSet.items.length === 0) {
      throw new BadRequestException('Change set must have at least one item before submission');
    }

    // Load definitions for the device to validate values and assess risk
    const definitions = await this.parameterDefinitionService.getDefinitionsForDevice(
      changeSet.vfdDeviceId,
      changeSet.tenantId,
    );
    const defMap = new Map(definitions.map((d) => [d.parameterName, d]));

    const riskChanges: Array<{
      parameterName: string;
      value: number;
      limits?: { min?: number; max?: number };
    }> = [];

    for (const item of changeSet.items) {
      const definition = defMap.get(item.parameterName);

      if (definition) {
        this.validateValueInRange(
          item.parameterName,
          item.requestedValue,
          definition.minValue,
          definition.maxValue,
        );
      }

      riskChanges.push({
        parameterName: item.parameterName,
        value: item.requestedValue,
        limits: definition ? { min: definition.minValue, max: definition.maxValue } : undefined,
      });
    }

    const riskResult = this.riskEvaluator.evaluateBatchRisk(riskChanges);

    // Concurrent guard: no other active change set for this device
    await this.ensureNoActiveChangeSet(changeSet.tenantId, changeSet.vfdDeviceId, changeSet.id);

    changeSet.status = VfdChangeSetStatus.PENDING_APPROVAL;
    changeSet.metadata = {
      ...changeSet.metadata,
      riskSummary: {
        riskLevel: riskResult.riskLevel,
        riskScore: riskResult.riskScore,
        requiresMotorStop: riskResult.requiresMotorStop,
        warnings: riskResult.warnings,
      },
    };

    const saved = await this.changeSetRepository.save(changeSet);

    this.eventEmitter.emit('vfd.changeset.pending', {
      changeSetId: saved.id,
      tenantId: saved.tenantId,
      vfdDeviceId: saved.vfdDeviceId,
      submittedBy,
      riskLevel: riskResult.riskLevel,
    });

    this.logger.log(
      `Change set ${changeSetId} submitted for approval (risk: ${riskResult.riskLevel})`,
    );

    return saved;
  }

  // ─── APPROVE (MAKER-CHECKER) ────────────────────────────────────────

  /**
   * Approve a PENDING_APPROVAL change set.
   * CRITICAL: enforces maker != checker rule.
   */
  async approveChangeSet(
    changeSetId: string,
    approvedBy: string,
    tenantId: string,
  ): Promise<VfdChangeSet> {
    const changeSet = await this.findByIdOrFail(changeSetId, tenantId);
    this.assertStatus(changeSet, VfdChangeSetStatus.PENDING_APPROVAL, 'approve');

    // Maker-Checker enforcement
    if (changeSet.createdBy === approvedBy) {
      throw new ForbiddenException('Maker-Checker violation: approver must differ from requester');
    }

    // Concurrent guard (friendly error; the partial unique index
    // uq_vfd_change_sets_one_active_per_device is the structural invariant)
    await this.ensureNoActiveChangeSet(changeSet.tenantId, changeSet.vfdDeviceId, changeSet.id);

    // SEC-MEDIUM-083 (2026-08-23 scan №28): ATOMIC status claim — the
    // previous read-check-write let two concurrent approvals both pass
    // assertStatus and both emit 'vfd.changeset.approved'. The conditional
    // UPDATE makes the second approval structurally impossible.
    const claim = await this.changeSetRepository.update(
      { id: changeSetId, tenantId, status: VfdChangeSetStatus.PENDING_APPROVAL },
      { status: VfdChangeSetStatus.APPROVED, approvedBy },
    );
    if (!claim.affected) {
      throw new ConflictException(
        `Change set ${changeSetId} is no longer PENDING_APPROVAL (concurrently approved, rejected or cancelled)`,
      );
    }
    changeSet.status = VfdChangeSetStatus.APPROVED;
    changeSet.approvedBy = approvedBy;

    const saved = changeSet;

    // If not scheduled, trigger immediate apply
    if (!changeSet.scheduledAt) {
      this.eventEmitter.emit('vfd.changeset.approved', {
        changeSetId: saved.id,
        tenantId: saved.tenantId,
        vfdDeviceId: saved.vfdDeviceId,
        approvedBy,
      });
    }

    this.logger.log(`Change set ${changeSetId} approved by ${approvedBy}`);

    return saved;
  }

  // ─── REJECT ──────────────────────────────────────────────────────────

  /**
   * Reject a PENDING_APPROVAL change set with a reason.
   */
  async rejectChangeSet(
    changeSetId: string,
    rejectedBy: string,
    reason: string,
    tenantId: string,
  ): Promise<VfdChangeSet> {
    const changeSet = await this.findByIdOrFail(changeSetId, tenantId);
    this.assertStatus(changeSet, VfdChangeSetStatus.PENDING_APPROVAL, 'reject');

    changeSet.status = VfdChangeSetStatus.REJECTED;
    changeSet.rejectedBy = rejectedBy;
    changeSet.rejectionReason = reason;

    const saved = await this.changeSetRepository.save(changeSet);

    this.eventEmitter.emit('vfd.changeset.rejected', {
      changeSetId: saved.id,
      tenantId: saved.tenantId,
      vfdDeviceId: saved.vfdDeviceId,
      rejectedBy,
      reason,
    });

    this.logger.log(`Change set ${changeSetId} rejected by ${rejectedBy}: ${reason}`);

    return saved;
  }

  // ─── CANCEL ──────────────────────────────────────────────────────────

  /**
   * Cancel a change set before it is applied to the device.
   *
   * Allowed only from DRAFT or APPROVED — the two pre-apply states. Unlike
   * reject (the checker's PENDING_APPROVAL verdict), cancel is the maker/admin
   * aborting their own change set. Moving an APPROVED change set to CANCELLED
   * removes it from the scheduler's `status = APPROVED` apply query, so a
   * scheduled-but-not-yet-applied change is structurally prevented from firing
   * with no half-applied state. Once the change set reaches APPLYING/APPLIED the
   * status guard rejects cancel, because the device already holds the new values
   * and rollback is the correct remediation.
   *
   * Actor + optional reason are recorded in `metadata` (jsonb, no schema change)
   * mirroring how rollback records its reason there.
   */
  async cancelChangeSet(
    changeSetId: string,
    cancelledBy: string,
    tenantId: string,
    reason?: string,
  ): Promise<VfdChangeSet> {
    const changeSet = await this.findByIdOrFail(changeSetId, tenantId);
    this.assertStatusIn(
      changeSet,
      [VfdChangeSetStatus.DRAFT, VfdChangeSetStatus.APPROVED],
      'cancel',
    );

    changeSet.status = VfdChangeSetStatus.CANCELLED;
    changeSet.metadata = {
      ...changeSet.metadata,
      cancellation: {
        cancelledBy,
        cancelledAt: new Date().toISOString(),
        reason: reason ?? null,
      },
    };

    const saved = await this.changeSetRepository.save(changeSet);

    this.eventEmitter.emit('vfd.changeset.cancelled', {
      changeSetId: saved.id,
      tenantId: saved.tenantId,
      vfdDeviceId: saved.vfdDeviceId,
      cancelledBy,
      reason: reason ?? null,
    });

    this.logger.log(
      `Change set ${changeSetId} cancelled by ${cancelledBy}${reason ? `: ${reason}` : ''}`,
    );

    return saved;
  }

  // ─── ROLLBACK ────────────────────────────────────────────────────────

  /**
   * Rollback an APPLIED or VERIFIED change set by creating an inverse change set.
   * Emergency rollback bypasses the normal approval flow.
   */
  async rollbackChangeSet(
    changeSetId: string,
    reason: string,
    performedBy: string,
    tenantId: string,
    options?: { emergency?: boolean },
  ): Promise<VfdChangeSet> {
    const original = await this.findByIdOrFail(changeSetId, tenantId);

    if (
      original.status !== VfdChangeSetStatus.APPLIED &&
      original.status !== VfdChangeSetStatus.VERIFIED
    ) {
      throw new BadRequestException(
        `Cannot rollback change set in status '${original.status}'. Must be APPLIED or VERIFIED.`,
      );
    }

    // Create inverse change set
    const rollbackChangeSet = this.changeSetRepository.create({
      tenantId: original.tenantId,
      vfdDeviceId: original.vfdDeviceId,
      description: `Rollback of change set ${original.id}: ${reason}`,
      createdBy: performedBy,
      status: VfdChangeSetStatus.DRAFT,
      rollbackOfId: original.id,
      metadata: {
        rollbackReason: reason,
        originalChangeSetId: original.id,
      },
    });

    const savedRollback = await this.changeSetRepository.save(rollbackChangeSet);

    // Create inverse items: swap previousValue <-> requestedValue
    const inverseItems: VfdChangeSetItem[] = [];
    for (const item of original.items) {
      const inverseItem = this.changeSetItemRepository.create({
        changeSetId: savedRollback.id,
        parameterDefinitionId: item.parameterDefinitionId,
        parameterName: item.parameterName,
        previousValue: item.requestedValue,
        requestedValue: item.previousValue ?? 0,
        status: VfdChangeSetItemStatus.PENDING,
      });
      inverseItems.push(inverseItem);
    }

    await this.changeSetItemRepository.save(inverseItems);

    // SEC-LOW-084 (2026-08-23 scan №29): the override is a TYPED caller
    // decision (emergencyRollbackChangeSet, TENANT_ADMIN-gated resolver
    // mutation) — a free-text reason value can never again self-approve a
    // change set.
    const isEmergency = options?.emergency === true;

    if (isEmergency) {
      // Emergency rollback: auto-approve and emit with EMERGENCY_OVERRIDE.
      // Atomic DRAFT→APPROVED claim (№28): a concurrent state change on the
      // rollback row aborts the override instead of double-writing.
      const claim = await this.changeSetRepository.update(
        { id: savedRollback.id, tenantId, status: VfdChangeSetStatus.DRAFT },
        { status: VfdChangeSetStatus.APPROVED, approvedBy: performedBy },
      );
      if (!claim.affected) {
        throw new ConflictException(
          `Rollback change set ${savedRollback.id} changed state before the emergency override could claim it`,
        );
      }
      savedRollback.status = VfdChangeSetStatus.APPROVED;
      savedRollback.approvedBy = performedBy;

      // Mark original as rolled back
      original.status = VfdChangeSetStatus.ROLLED_BACK;
      await this.changeSetRepository.save(original);

      // Audit log
      await this.createAuditLog(
        original.tenantId,
        original.vfdDeviceId,
        savedRollback.id,
        VfdAuditAction.EMERGENCY_OVERRIDE,
        performedBy,
        inverseItems,
      );

      this.eventEmitter.emit('vfd.changeset.approved', {
        changeSetId: savedRollback.id,
        tenantId: savedRollback.tenantId,
        vfdDeviceId: savedRollback.vfdDeviceId,
        approvedBy: performedBy,
        action: VfdAuditAction.EMERGENCY_OVERRIDE,
      });

      this.logger.warn(`EMERGENCY rollback of change set ${changeSetId} by ${performedBy}`);
    } else {
      // Normal rollback: submit for approval
      await this.submitForApproval(savedRollback.id, performedBy, tenantId);

      this.logger.log(`Rollback change set ${savedRollback.id} created for ${changeSetId}`);
    }

    // Same contract as before the fix: a freshly loaded entity (with the
    // items relation), not the in-memory working copy.
    return this.findByIdOrFail(savedRollback.id, tenantId);
  }

  /**
   * SEC-LOW-084 (2026-08-23 scan №29): explicit emergency rollback entry.
   *
   * The 4-eyes principle is overridden ONLY through this typed path, which
   * the resolver gates to TENANT_ADMIN — never through rollback metadata
   * (the old `reason === 'emergency'` magic string was one free-text field
   * away from a self-approved inverse change set). Still audit-logged as
   * EMERGENCY_OVERRIDE.
   */
  async emergencyRollbackChangeSet(
    changeSetId: string,
    reason: string,
    performedBy: string,
    tenantId: string,
  ): Promise<VfdChangeSet> {
    this.logger.warn(
      `EMERGENCY rollback requested for change set ${changeSetId} by ${performedBy}: ${reason}`,
    );
    return this.rollbackChangeSet(changeSetId, reason, performedBy, tenantId, {
      emergency: true,
    });
  }

  // ─── QUERIES ─────────────────────────────────────────────────────────

  /**
   * Find a change set by ID with items relation.
   */
  async findById(changeSetId: string, tenantId: string): Promise<VfdChangeSet | null> {
    return this.changeSetRepository.findOne({
      where: { id: changeSetId, tenantId },
      relations: ['items'],
    });
  }

  /**
   * Find change sets for a device with optional status filter and pagination.
   */
  async findByDevice(
    tenantId: string,
    vfdDeviceId: string,
    status?: VfdChangeSetStatus,
    limit = 20,
    offset = 0,
  ): Promise<{ items: VfdChangeSet[]; total: number }> {
    const where: Record<string, unknown> = { tenantId, vfdDeviceId };
    if (status) {
      where['status'] = status;
    }

    const [items, total] = await this.changeSetRepository.findAndCount({
      where,
      relations: ['items'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total };
  }

  /**
   * Count change sets with PENDING_APPROVAL status for a tenant.
   */
  async getPendingApprovalCount(tenantId: string): Promise<number> {
    return this.changeSetRepository.count({
      where: { tenantId, status: VfdChangeSetStatus.PENDING_APPROVAL },
    });
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────────────────────

  /**
   * Load a change set or throw NotFoundException.
   */
  private async findByIdOrFail(changeSetId: string, tenantId: string): Promise<VfdChangeSet> {
    const changeSet = await this.changeSetRepository.findOne({
      where: { id: changeSetId, tenantId },
      relations: ['items'],
    });

    if (!changeSet) {
      throw new NotFoundException(`Change set ${changeSetId} not found`);
    }

    return changeSet;
  }

  /**
   * Assert a change set is in the expected status.
   */
  private assertStatus(
    changeSet: VfdChangeSet,
    expected: VfdChangeSetStatus,
    action: string,
  ): void {
    if (changeSet.status !== expected) {
      throw new BadRequestException(
        `Cannot ${action}: change set is in '${changeSet.status}' status, expected '${expected}'`,
      );
    }
  }

  /**
   * Assert a change set is in one of several allowed statuses.
   * Used by transitions valid from more than one source state (e.g. cancel,
   * which is reachable from both DRAFT and APPROVED).
   */
  private assertStatusIn(
    changeSet: VfdChangeSet,
    allowed: VfdChangeSetStatus[],
    action: string,
  ): void {
    if (!allowed.includes(changeSet.status)) {
      throw new BadRequestException(
        `Cannot ${action}: change set is in '${changeSet.status}' status, expected one of [${allowed.join(
          ', ',
        )}]`,
      );
    }
  }

  /**
   * Validate a requested value is within the parameter's min/max bounds.
   */
  private validateValueInRange(
    parameterName: string,
    value: number,
    minValue?: number,
    maxValue?: number,
  ): void {
    if (minValue !== undefined && minValue !== null && value < minValue) {
      throw new BadRequestException(
        `Value ${value} for '${parameterName}' is below minimum ${minValue}`,
      );
    }
    if (maxValue !== undefined && maxValue !== null && value > maxValue) {
      throw new BadRequestException(
        `Value ${value} for '${parameterName}' is above maximum ${maxValue}`,
      );
    }
  }

  /**
   * Ensure no other active (non-draft) change set exists for the same device.
   * Prevents concurrent conflicting changes.
   */
  private async ensureNoActiveChangeSet(
    tenantId: string,
    vfdDeviceId: string,
    excludeId?: string,
  ): Promise<void> {
    const activeStatuses = [
      VfdChangeSetStatus.PENDING_APPROVAL,
      VfdChangeSetStatus.APPROVED,
      VfdChangeSetStatus.APPLYING,
    ];

    const where: Record<string, unknown> = {
      tenantId,
      vfdDeviceId,
      status: In(activeStatuses),
    };

    if (excludeId) {
      where['id'] = Not(excludeId);
    }

    const existing = await this.changeSetRepository.findOne({ where });

    if (existing) {
      throw new ConflictException(
        `Device ${vfdDeviceId} already has an active change set (${existing.id}) in status ${existing.status}`,
      );
    }
  }

  /**
   * Create audit log entries for rollback operations.
   */
  private async createAuditLog(
    tenantId: string,
    vfdDeviceId: string,
    changeSetId: string,
    action: VfdAuditAction,
    performedBy: string,
    items: VfdChangeSetItem[],
  ): Promise<void> {
    const logs = items.map((item) =>
      this.auditLogRepository.create({
        tenantId,
        vfdDeviceId,
        changeSetId,
        parameterName: item.parameterName,
        previousValue: item.previousValue,
        newValue: item.requestedValue,
        action,
        performedBy,
      }),
    );

    await this.auditLogRepository.save(logs);
  }
}
