import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { VfdChangeSet } from '../entities/vfd-change-set.entity';
import { VfdChangeSetItem } from '../entities/vfd-change-set-item.entity';
import { VfdParameterAuditLog } from '../entities/vfd-parameter-audit-log.entity';
import { VfdParameterDefinition } from '../entities/vfd-parameter-definition.entity';
import {
  VfdChangeSetStatus,
  VfdChangeSetItemStatus,
  VfdAuditAction,
  VfdDeviceStatus,
} from '../../vfd/entities/vfd.enums';
import { VfdDeviceService } from '../../vfd/services/vfd-device.service';
import { VfdCommandService } from '../../vfd/services/vfd-command.service';
import { VfdRegisterMappingService } from '../../vfd/services/vfd-register-mapping.service';
import { VfdEdgeReadService } from '../../vfd/services/vfd-edge-read.service';
import { VfdEdgeWriteService, VfdEdgeWriteResult } from '../../vfd/services/vfd-edge-write.service';
import { VfdDevice } from '../../vfd/entities/vfd-device.entity';

const TOTAL_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;

/** CiA 402 / PROFIdrive status word bit 2 (0x0004) = Operation Enabled (running). */
const STATUS_WORD_RUNNING_BIT = 0x0004;

/**
 * Applies approved VFD parameter change sets to the drive.
 *
 * SENSOR-CRITICAL-007: all drive I/O is edge-delegated. This service never opens
 * a socket to the drive — it reads via `VfdEdgeReadService` (edge `read_modbus`)
 * and writes via `VfdEdgeWriteService` (edge `write_modbus`). The edge performs
 * the hardened, readback-verified write, so a write ack means the register was
 * confirmed equal to the written wire value — the cloud does not (and cannot)
 * re-read to "verify" a fabricated success.
 */
@Injectable()
export class VfdParameterWriterService {
  private readonly logger = new Logger(VfdParameterWriterService.name);

  constructor(
    @InjectRepository(VfdChangeSet) private readonly changeSetRepo: Repository<VfdChangeSet>,
    @InjectRepository(VfdChangeSetItem)
    private readonly changeSetItemRepo: Repository<VfdChangeSetItem>,
    @InjectRepository(VfdParameterAuditLog)
    private readonly auditLogRepo: Repository<VfdParameterAuditLog>,
    @InjectRepository(VfdParameterDefinition)
    private readonly paramDefRepo: Repository<VfdParameterDefinition>,
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly vfdCommandService: VfdCommandService,
    private readonly registerMappingService: VfdRegisterMappingService,
    private readonly edgeReadService: VfdEdgeReadService,
    private readonly edgeWriteService: VfdEdgeWriteService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Apply a change set: read-back current, edge-write (readback-verified), rollback on failure. */
  async applyChangeSet(changeSet: VfdChangeSet): Promise<VfdChangeSet> {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;

    changeSet.status = VfdChangeSetStatus.APPLYING;
    await this.changeSetRepo.save(changeSet);

    const device = await this.vfdDeviceService.findById(changeSet.vfdDeviceId, changeSet.tenantId);

    if (device.status !== VfdDeviceStatus.ACTIVE) {
      await this.failChangeSet(changeSet, `Device is not active (status: ${device.status})`);
      throw new BadRequestException(
        `Device ${changeSet.vfdDeviceId} is not active. Current status: ${device.status}`,
      );
    }

    const itemDefs = await this.loadDefinitionsForItems(changeSet.items);

    if (changeSet.items.some((i) => itemDefs.get(i.parameterDefinitionId)?.requiresMotorStop)) {
      try {
        await this.assertMotorStoppedForRestrictedWrite(device);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.failChangeSet(changeSet, reason);
        throw error instanceof BadRequestException ? error : new BadRequestException(reason);
      }
    }

    const sortedItems = [...changeSet.items].sort(
      (a, b) =>
        (itemDefs.get(a.parameterDefinitionId)?.displayOrder ?? 0) -
        (itemDefs.get(b.parameterDefinitionId)?.displayOrder ?? 0),
    );

    const appliedItems: VfdChangeSetItem[] = [];
    let hasFailure = false;

    for (const item of sortedItems) {
      if (Date.now() > deadline) {
        await this.markItemFailed(item, 'Total change set timeout exceeded (60s)');
        hasFailure = true;
        continue;
      }

      const def = itemDefs.get(item.parameterDefinitionId);
      if (!def) {
        await this.markItemFailed(
          item,
          `Parameter definition ${item.parameterDefinitionId} not found`,
        );
        hasFailure = true;
        continue;
      }

      // Read the current value first — needed for the audit trail AND for a safe
      // rollback. If it cannot be read, fail closed for this item rather than
      // writing a value we could never revert.
      const prev = await this.edgeReadService.readRegister(
        device,
        def.registerAddress,
        `read ${item.parameterName} current value`,
      );
      if (!prev.success || !prev.found || prev.rawValue === undefined) {
        await this.markItemFailed(
          item,
          `Cannot read current value: ${prev.error ?? 'register not reported by edge'}`,
        );
        hasFailure = true;
        continue;
      }
      item.previousValue = this.applyScaling(prev.rawValue, def.scalingFactor, def.offset);

      // Edge write. The edge readback-verifies FC6, so a success ack means the
      // register was confirmed equal to `wire` — no cloud re-read (and no
      // tolerance fudge) can fabricate a pass.
      const wire = this.reverseScale(item.requestedValue, def.scalingFactor, def.offset);
      const write = await this.edgeWriteWithRetry(
        device,
        def.registerAddress,
        wire,
        `apply ${item.parameterName}`,
      );
      if (!write.success) {
        await this.markItemFailed(
          item,
          `Write failed: ${write.error ?? 'edge reported the write failed'}`,
        );
        hasFailure = true;
        continue;
      }

      // The edge verified `wire` reached the register, so the applied engineering
      // value is exactly what that wire value scales back to.
      item.appliedValue = this.applyScaling(wire, def.scalingFactor, def.offset);
      item.status = VfdChangeSetItemStatus.APPLIED;
      item.appliedAt = new Date();
      await this.changeSetItemRepo.save(item);
      appliedItems.push(item);
    }

    if (!hasFailure) {
      changeSet.status = VfdChangeSetStatus.APPLIED;
      changeSet.appliedAt = new Date();
      await this.changeSetRepo.save(changeSet);
      this.eventEmitter.emit('vfd.changeset.applied', { changeSetId: changeSet.id });

      // SENSOR-CRITICAL-009: every item was written AND edge-readback-verified
      // inline (the edge's FC6 verify_write_readback), so the applied set is
      // confirmed on the drive. Advance to VERIFIED instead of stranding the set
      // at APPLIED with no writer for the terminal transition.
      changeSet.status = VfdChangeSetStatus.VERIFIED;
      changeSet.verifiedAt = new Date();
      await this.changeSetRepo.save(changeSet);
      this.eventEmitter.emit('vfd.changeset.verified', { changeSetId: changeSet.id });
    } else {
      await this.rollbackAppliedItems(device, appliedItems, itemDefs);
      changeSet.status = VfdChangeSetStatus.FAILED;
      await this.changeSetRepo.save(changeSet);
      this.eventEmitter.emit('vfd.changeset.failed', { changeSetId: changeSet.id });
    }

    for (const item of sortedItems) {
      await this.writeAuditLog(
        changeSet.tenantId,
        changeSet.vfdDeviceId,
        changeSet.id,
        item.parameterName,
        item.previousValue ?? 0,
        item.appliedValue ?? item.requestedValue,
        VfdAuditAction.APPLY,
        changeSet.createdBy,
        changeSet.automationRuleId,
      );
    }

    return changeSet;
  }

  /** Read a single parameter's engineering value from a device (edge-delegated). */
  async readParameterValue(
    deviceId: string,
    tenantId: string,
    parameterDef: VfdParameterDefinition,
  ): Promise<number> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const read = await this.edgeReadService.readRegister(
      device,
      parameterDef.registerAddress,
      `read ${parameterDef.parameterName}`,
    );
    if (!read.success || !read.found || read.rawValue === undefined) {
      throw new BadRequestException(
        `Cannot read parameter ${parameterDef.parameterName} from VFD ${deviceId}: ${read.error ?? 'register not reported by edge'}`,
      );
    }
    return this.applyScaling(read.rawValue, parameterDef.scalingFactor, parameterDef.offset);
  }

  /** Write a single parameter value to a device (edge-delegated, readback-verified). */
  async writeParameterValue(
    deviceId: string,
    tenantId: string,
    parameterDef: VfdParameterDefinition,
    value: number,
  ): Promise<VfdEdgeWriteResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const wire = this.reverseScale(value, parameterDef.scalingFactor, parameterDef.offset);
    return this.edgeWriteService.writeRegister(
      device,
      parameterDef.registerAddress,
      wire,
      `write ${parameterDef.parameterName}`,
    );
  }

  /** Create an immutable audit log entry. */
  async writeAuditLog(
    tenantId: string,
    vfdDeviceId: string,
    changeSetId: string,
    parameterName: string,
    previousValue: number,
    newValue: number,
    action: VfdAuditAction,
    performedBy: string,
    automationRuleId?: string,
  ): Promise<VfdParameterAuditLog> {
    const entry = this.auditLogRepo.create({
      tenantId,
      vfdDeviceId,
      changeSetId,
      parameterName,
      previousValue,
      newValue,
      action,
      performedBy,
      automationRuleId,
    });
    return this.auditLogRepo.save(entry);
  }

  // ============ PRIVATE HELPERS ============

  private async loadDefinitionsForItems(
    items: VfdChangeSetItem[],
  ): Promise<Map<string, VfdParameterDefinition>> {
    const ids = [...new Set(items.map((i) => i.parameterDefinitionId))];
    const defs = await this.paramDefRepo.findByIds(ids);
    const map = new Map<string, VfdParameterDefinition>();
    for (const def of defs) map.set(def.id, def);
    return map;
  }

  /**
   * Fail-closed motor-state interlock for parameters that require the motor to
   * be stopped. The motor must be POSITIVELY read as stopped before the write
   * proceeds: if the brand has no status-word register mapping, OR the status
   * word cannot be read from the edge, the write is refused rather than assumed
   * safe (SENSOR-HIGH-074).
   *
   * CiA 402 / PROFIdrive status word bit 2 (0x0004) = Operation Enabled (running).
   */
  private async assertMotorStoppedForRestrictedWrite(device: VfdDevice): Promise<void> {
    const mapping = await this.registerMappingService.getStatusWordMapping(device.brand);
    if (!mapping) {
      throw new BadRequestException(
        `Cannot verify motor state for brand ${device.brand}: no status-word register mapping. ` +
          'Refusing to write parameters that require the motor to be stopped.',
      );
    }

    const read = await this.edgeReadService.readRegister(
      device,
      mapping.registerAddress,
      'motor status word',
    );
    if (!read.success || !read.found || read.rawValue === undefined) {
      throw new BadRequestException(
        `Cannot verify motor state for VFD ${device.id}: ${read.error ?? 'status word not reported by edge'}. ` +
          'Refusing to write parameters that require the motor to be stopped.',
      );
    }

    if (read.rawValue & STATUS_WORD_RUNNING_BIT) {
      throw new BadRequestException(
        'Motor is running — change set contains parameters that require the motor to be stopped',
      );
    }
  }

  private applyScaling(raw: number, factor: number, offset: number): number {
    return raw * factor + offset;
  }

  private reverseScale(eng: number, factor: number, offset: number): number {
    return Math.round((eng - offset) / factor);
  }

  private async markItemFailed(item: VfdChangeSetItem, message: string): Promise<void> {
    item.status = VfdChangeSetItemStatus.FAILED;
    item.errorMessage = message;
    await this.changeSetItemRepo.save(item);
  }

  /**
   * Edge write with a small retry. Writing the same setpoint is idempotent, so a
   * retry is safe for transient ack failures; a definitive failure (readback
   * mismatch = drive clamp) simply fails again and is reported.
   */
  private async edgeWriteWithRetry(
    device: VfdDevice,
    address: number,
    value: number,
    intent: string,
  ): Promise<VfdEdgeWriteResult> {
    let last: VfdEdgeWriteResult | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await this.edgeWriteService.writeRegister(device, address, value, intent);
        if (result.success) return result;
        last = result;
      } catch (error) {
        last = {
          success: false,
          commandId: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (attempt < MAX_RETRIES - 1) await this.sleep(RETRY_BACKOFF_MS);
    }
    return last ?? { success: false, commandId: '', error: 'Write failed after retries' };
  }

  private async rollbackAppliedItems(
    device: VfdDevice,
    items: VfdChangeSetItem[],
    defs: Map<string, VfdParameterDefinition>,
  ): Promise<void> {
    for (const item of items) {
      if (item.previousValue == null) continue;
      const def = defs.get(item.parameterDefinitionId);
      if (!def) continue;
      try {
        const wire = this.reverseScale(item.previousValue, def.scalingFactor, def.offset);
        const res = await this.edgeWriteService.writeRegister(
          device,
          def.registerAddress,
          wire,
          `rollback ${item.parameterName}`,
        );
        if (res.success) {
          item.status = VfdChangeSetItemStatus.ROLLED_BACK;
          await this.changeSetItemRepo.save(item);
        } else {
          this.logger.error(
            `Rollback failed for item ${item.id} (${item.parameterName}): ${res.error ?? 'edge write failed'}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Rollback failed for item ${item.id} (${item.parameterName})`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private async failChangeSet(cs: VfdChangeSet, reason: string): Promise<void> {
    cs.status = VfdChangeSetStatus.FAILED;
    cs.metadata = { ...cs.metadata, failureReason: reason };
    await this.changeSetRepo.save(cs);
    this.eventEmitter.emit('vfd.changeset.failed', { changeSetId: cs.id, reason });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
