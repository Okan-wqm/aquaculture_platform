import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { VfdChangeSet } from '../entities/vfd-change-set.entity';
import { VfdChangeSetItem } from '../entities/vfd-change-set-item.entity';
import { VfdParameterAuditLog } from '../entities/vfd-parameter-audit-log.entity';
import { VfdParameterDefinition } from '../entities/vfd-parameter-definition.entity';
import {
  VfdChangeSetStatus, VfdChangeSetItemStatus, VfdAuditAction,
  VfdDeviceStatus, VfdDataType, ByteOrder,
} from '../../vfd/entities/vfd.enums';
import { VfdDeviceService } from '../../vfd/services/vfd-device.service';
import { VfdCommandService } from '../../vfd/services/vfd-command.service';
import { VfdRegisterMappingService } from '../../vfd/services/vfd-register-mapping.service';
import { createVfdAdapter, BaseVfdAdapter, VfdConnectionHandle, VfdCommandResult } from '../../vfd/adapters';
import { VfdDevice } from '../../vfd/entities/vfd-device.entity';

const TOTAL_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;
const REGISTER_SETTLE_MS = 100;

@Injectable()
export class VfdParameterWriterService {
  private readonly logger = new Logger(VfdParameterWriterService.name);

  constructor(
    @InjectRepository(VfdChangeSet) private readonly changeSetRepo: Repository<VfdChangeSet>,
    @InjectRepository(VfdChangeSetItem) private readonly changeSetItemRepo: Repository<VfdChangeSetItem>,
    @InjectRepository(VfdParameterAuditLog) private readonly auditLogRepo: Repository<VfdParameterAuditLog>,
    @InjectRepository(VfdParameterDefinition) private readonly paramDefRepo: Repository<VfdParameterDefinition>,
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly vfdCommandService: VfdCommandService,
    private readonly registerMappingService: VfdRegisterMappingService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Apply a change set: read-back, write, verify, rollback on failure. */
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
      if (await this.isMotorRunning(device)) {
        await this.failChangeSet(changeSet, 'Motor is running — cannot apply parameters that require motor stop');
        throw new BadRequestException('Motor is running — change set contains parameters that require motor stop');
      }
    }

    const adapter = createVfdAdapter(device.protocol);
    const handle = await adapter.connect(device.protocolConfiguration);

    try {
      const sortedItems = [...changeSet.items].sort((a, b) =>
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
          await this.markItemFailed(item, `Parameter definition ${item.parameterDefinitionId} not found`);
          hasFailure = true;
          continue;
        }

        try {
          const currentRaw = await this.readRegisterValue(adapter, handle, def);
          item.previousValue = this.applyScaling(currentRaw, def.scalingFactor, def.offset);

          await this.writeWithRetry(adapter, handle, def.registerAddress,
            this.reverseScale(item.requestedValue, def.scalingFactor, def.offset));
          await this.sleep(REGISTER_SETTLE_MS);

          const verifyRaw = await this.readRegisterValue(adapter, handle, def);
          item.appliedValue = this.applyScaling(verifyRaw, def.scalingFactor, def.offset);

          if (!this.isWithinTolerance(item.appliedValue, item.requestedValue, def.scalingFactor)) {
            await this.markItemFailed(item,
              `Read-back mismatch: expected ${item.requestedValue}, got ${item.appliedValue}`);
            hasFailure = true;
            continue;
          }

          item.status = VfdChangeSetItemStatus.APPLIED;
          item.appliedAt = new Date();
          await this.changeSetItemRepo.save(item);
          appliedItems.push(item);
        } catch (error) {
          await this.markItemFailed(item,
            `Write failed: ${error instanceof Error ? error.message : String(error)}`);
          hasFailure = true;
        }
      }

      if (!hasFailure) {
        changeSet.status = VfdChangeSetStatus.APPLIED;
        changeSet.appliedAt = new Date();
        await this.changeSetRepo.save(changeSet);
        this.eventEmitter.emit('vfd.changeset.applied', { changeSetId: changeSet.id });
      } else {
        await this.rollbackAppliedItems(adapter, handle, appliedItems, itemDefs);
        changeSet.status = VfdChangeSetStatus.FAILED;
        await this.changeSetRepo.save(changeSet);
        this.eventEmitter.emit('vfd.changeset.failed', { changeSetId: changeSet.id });
      }

      for (const item of sortedItems) {
        await this.writeAuditLog(changeSet.tenantId, changeSet.vfdDeviceId, changeSet.id,
          item.parameterName, item.previousValue ?? 0,
          item.appliedValue ?? item.requestedValue, VfdAuditAction.APPLY,
          changeSet.createdBy, changeSet.automationRuleId);
      }

      return changeSet;
    } finally {
      try { await adapter.disconnect(handle); } catch {
        this.logger.warn('Failed to disconnect after change set apply');
      }
    }
  }

  /** Read a single parameter's engineering value from a device. */
  async readParameterValue(
    deviceId: string, tenantId: string, parameterDef: VfdParameterDefinition,
  ): Promise<number> {
    return this.withDeviceConnection(deviceId, tenantId, async (adapter, handle) => {
      const raw = await this.readRegisterValue(adapter, handle, parameterDef);
      return this.applyScaling(raw, parameterDef.scalingFactor, parameterDef.offset);
    });
  }

  /** Write a single parameter value to a device. */
  async writeParameterValue(
    deviceId: string, tenantId: string, parameterDef: VfdParameterDefinition, value: number,
  ): Promise<VfdCommandResult> {
    return this.withDeviceConnection(deviceId, tenantId, async (adapter, handle) => {
      const raw = this.reverseScale(value, parameterDef.scalingFactor, parameterDef.offset);
      return adapter.writeRegister(handle, parameterDef.registerAddress, raw);
    });
  }

  /** Create an immutable audit log entry. */
  async writeAuditLog(
    tenantId: string, vfdDeviceId: string, changeSetId: string,
    parameterName: string, previousValue: number, newValue: number,
    action: VfdAuditAction, performedBy: string, automationRuleId?: string,
  ): Promise<VfdParameterAuditLog> {
    const entry = this.auditLogRepo.create({
      tenantId, vfdDeviceId, changeSetId, parameterName,
      previousValue, newValue, action, performedBy, automationRuleId,
    });
    return this.auditLogRepo.save(entry);
  }

  // ============ PRIVATE HELPERS ============

  /** Open a connection, run callback, then disconnect. */
  private async withDeviceConnection<T>(
    deviceId: string, tenantId: string,
    fn: (adapter: BaseVfdAdapter, handle: VfdConnectionHandle) => Promise<T>,
  ): Promise<T> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const adapter = createVfdAdapter(device.protocol);
    const handle = await adapter.connect(device.protocolConfiguration);
    try {
      return await fn(adapter, handle);
    } finally {
      try { await adapter.disconnect(handle); } catch { /* ignore */ }
    }
  }

  private async loadDefinitionsForItems(
    items: VfdChangeSetItem[],
  ): Promise<Map<string, VfdParameterDefinition>> {
    const ids = [...new Set(items.map((i) => i.parameterDefinitionId))];
    const defs = await this.paramDefRepo.findByIds(ids);
    const map = new Map<string, VfdParameterDefinition>();
    for (const def of defs) map.set(def.id, def);
    return map;
  }

  /** Check motor status via status word bit 2 (0x0004 = Operation Enabled). */
  private async isMotorRunning(device: VfdDevice): Promise<boolean> {
    const mapping = await this.registerMappingService.getStatusWordMapping(device.brand);
    if (!mapping) {
      this.logger.warn(`No status word mapping for brand ${device.brand}, assuming motor stopped`);
      return false;
    }
    const adapter = createVfdAdapter(device.protocol);
    const handle = await adapter.connect(device.protocolConfiguration);
    try {
      const buf = await adapter.readRegister(handle, mapping.registerAddress, mapping.registerCount || 1, mapping.functionCode || 3);
      return Boolean(buf.readUInt16BE(0) & 0x0004);
    } finally {
      try { await adapter.disconnect(handle); } catch { /* ignore */ }
    }
  }

  private async readRegisterValue(
    adapter: BaseVfdAdapter, handle: VfdConnectionHandle, def: VfdParameterDefinition,
  ): Promise<number> {
    const buf = await adapter.readRegister(handle, def.registerAddress, def.registerCount, def.functionCode || 3);
    return this.parseRawValue(buf, def);
  }

  private parseRawValue(buf: Buffer, def: VfdParameterDefinition): number {
    const be = def.byteOrder === ByteOrder.BIG || def.byteOrder === 'big';
    switch (def.dataType) {
      case VfdDataType.UINT16: case 'uint16':
        return be ? buf.readUInt16BE(0) : buf.readUInt16LE(0);
      case VfdDataType.INT16: case 'int16':
        return be ? buf.readInt16BE(0) : buf.readInt16LE(0);
      case VfdDataType.UINT32: case 'uint32': {
        if (buf.length < 4) return 0;
        const wBig = def.wordOrder === ByteOrder.BIG || def.wordOrder === 'big';
        const h = be ? buf.readUInt16BE(0) : buf.readUInt16LE(0);
        const l = be ? buf.readUInt16BE(2) : buf.readUInt16LE(2);
        return wBig ? (h >>> 0) * 65536 + (l >>> 0) : (l >>> 0) * 65536 + (h >>> 0);
      }
      case VfdDataType.INT32: case 'int32':
        return buf.length < 4 ? 0 : (be ? buf.readInt32BE(0) : buf.readInt32LE(0));
      case VfdDataType.FLOAT32: case 'float32':
        return buf.length < 4 ? 0 : (be ? buf.readFloatBE(0) : buf.readFloatLE(0));
      default:
        return be ? buf.readUInt16BE(0) : buf.readUInt16LE(0);
    }
  }

  private applyScaling(raw: number, factor: number, offset: number): number {
    return raw * factor + offset;
  }

  private reverseScale(eng: number, factor: number, offset: number): number {
    return Math.round((eng - offset) / factor);
  }

  private isWithinTolerance(actual: number, expected: number, scalingFactor: number): boolean {
    return Math.abs(actual - expected) <= Math.abs(scalingFactor) * 2;
  }

  private async markItemFailed(item: VfdChangeSetItem, message: string): Promise<void> {
    item.status = VfdChangeSetItemStatus.FAILED;
    item.errorMessage = message;
    await this.changeSetItemRepo.save(item);
  }

  private async writeWithRetry(
    adapter: BaseVfdAdapter, handle: VfdConnectionHandle, address: number, value: number,
  ): Promise<VfdCommandResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await this.withTimeout(adapter.writeRegister(handle, address, value), WRITE_TIMEOUT_MS);
        if (result.success) return result;
        lastError = new Error(result.error ?? 'Write returned unsuccessful');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < MAX_RETRIES - 1) await this.sleep(RETRY_BACKOFF_MS);
    }
    throw lastError ?? new Error('Write failed after retries');
  }

  private async rollbackAppliedItems(
    adapter: BaseVfdAdapter, handle: VfdConnectionHandle,
    items: VfdChangeSetItem[], defs: Map<string, VfdParameterDefinition>,
  ): Promise<void> {
    for (const item of items) {
      if (item.previousValue == null) continue;
      const def = defs.get(item.parameterDefinitionId);
      if (!def) continue;
      try {
        await adapter.writeRegister(handle, def.registerAddress,
          this.reverseScale(item.previousValue, def.scalingFactor, def.offset));
        item.status = VfdChangeSetItemStatus.ROLLED_BACK;
        await this.changeSetItemRepo.save(item);
      } catch (err) {
        this.logger.error(`Rollback failed for item ${item.id} (${item.parameterName})`,
          err instanceof Error ? err.stack : String(err));
      }
    }
  }

  private async failChangeSet(cs: VfdChangeSet, reason: string): Promise<void> {
    cs.status = VfdChangeSetStatus.FAILED;
    cs.metadata = { ...cs.metadata, failureReason: reason };
    await this.changeSetRepo.save(cs);
    this.eventEmitter.emit('vfd.changeset.failed', { changeSetId: cs.id, reason });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
      promise.then((r) => { clearTimeout(timer); resolve(r); })
        .catch((e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
