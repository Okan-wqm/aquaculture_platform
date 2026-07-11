import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  createVfdAdapter,
  VfdCommandResult,
  VfdConnectionHandle,
} from '../adapters';
import { VFD_BRAND_COMMANDS } from '../brand-configs';
import { VfdCommandAuditLog } from '../entities/vfd-command-audit-log.entity';
import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdCommandType, VfdDeviceStatus } from '../entities/vfd.enums';

import { VfdDeviceService } from './vfd-device.service';
import { VfdRegisterMappingService } from './vfd-register-mapping.service';

/**
 * Command input structure
 */
export interface VfdCommandInput {
  command: VfdCommandType;
  value?: number; // For SET_FREQUENCY, SET_SPEED, SET_TORQUE
}

/**
 * Who dispatched a command — captured on the audit record (DB-SENSOR-HIGH-003).
 * Optional so internal/system callers (automation) can pass a system identity.
 */
export interface VfdCommandActor {
  userId: string;
  email?: string;
  source?: string; // 'operator' (default) | 'automation' | 'system'
}

/**
 * Command execution result
 */
export interface VfdCommandExecutionResult {
  success: boolean;
  command: VfdCommandType;
  value?: number;
  error?: string;
  executedAt: Date;
  latencyMs?: number;
}

/**
 * VFD Command Service
 * Handles sending control commands to VFD devices
 */
@Injectable()
export class VfdCommandService {
  private readonly logger = new Logger(VfdCommandService.name);

  // Active connections cache
  private activeConnections: Map<string, {
    handle: VfdConnectionHandle;
    adapter: ReturnType<typeof createVfdAdapter>;
    lastActivity: Date;
  }> = new Map();

  // Per-device connect lock: prevents concurrent calls from opening duplicate sockets
  private connectLocks: Map<string, Promise<{
    adapter: ReturnType<typeof createVfdAdapter>;
    handle: VfdConnectionHandle;
  }>> = new Map();

  constructor(
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly registerMappingService: VfdRegisterMappingService,
    @InjectRepository(VfdCommandAuditLog)
    private readonly commandAuditRepo: Repository<VfdCommandAuditLog>
  ) {}

  /**
   * Execute a command on a VFD device
   */
  async executeCommand(
    deviceId: string,
    tenantId: string,
    commandInput: VfdCommandInput,
    actor?: VfdCommandActor
  ): Promise<VfdCommandExecutionResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);

    // Validate device is active
    if (device.status !== VfdDeviceStatus.ACTIVE) {
      throw new BadRequestException(
        `Device ${deviceId} is not active. Current status: ${device.status}`
      );
    }

    this.logger.log(
      `Executing command ${commandInput.command} on device ${deviceId}` +
      (commandInput.value !== undefined ? ` with value ${commandInput.value}` : '')
    );

    let executionResult: VfdCommandExecutionResult;
    try {
      // Get or create connection
      const { adapter, handle } = await this.getOrCreateConnection(device);

      // Execute the command
      let result: VfdCommandResult;

      switch (commandInput.command) {
        case VfdCommandType.START:
          result = await this.executeStart(device, adapter, handle);
          break;

        case VfdCommandType.STOP:
          result = await this.executeStop(device, adapter, handle);
          break;

        case VfdCommandType.REVERSE:
          result = await this.executeReverse(device, adapter, handle);
          break;

        case VfdCommandType.SET_FREQUENCY:
          if (commandInput.value === undefined) {
            throw new BadRequestException('SET_FREQUENCY requires a value');
          }
          result = await this.executeSetFrequency(device, adapter, handle, commandInput.value);
          break;

        case VfdCommandType.SET_SPEED:
          if (commandInput.value === undefined) {
            throw new BadRequestException('SET_SPEED requires a value');
          }
          result = await this.executeSetSpeed(device, adapter, handle, commandInput.value);
          break;

        case VfdCommandType.FAULT_RESET:
          result = await this.executeFaultReset(device, adapter, handle);
          break;

        case VfdCommandType.EMERGENCY_STOP:
          result = await this.executeEmergencyStop(device, adapter, handle);
          break;

        case VfdCommandType.JOG_FORWARD:
          result = await this.executeJog(device, adapter, handle, 'forward');
          break;

        case VfdCommandType.JOG_REVERSE:
          result = await this.executeJog(device, adapter, handle, 'reverse');
          break;

        default:
          throw new BadRequestException(`Unknown command: ${commandInput.command}`);
      }

      executionResult = {
        success: result.success,
        command: commandInput.command,
        value: commandInput.value,
        error: result.error,
        executedAt: result.acknowledgedAt || new Date(),
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      this.logger.error(
        `Failed to execute command ${commandInput.command} on device ${deviceId}`,
        error
      );

      executionResult = {
        success: false,
        command: commandInput.command,
        value: commandInput.value,
        error: (error as Error).message,
        executedAt: new Date(),
      };
    }

    // DB-SENSOR-HIGH-003: every dispatched actuator command leaves a durable,
    // immutable audit record (success AND failure). Best-effort: a command —
    // especially EMERGENCY_STOP — must never be blocked by an audit-store
    // outage, so an audit-write failure is logged loudly but does not change
    // the command result.
    await this.recordCommandAudit(deviceId, tenantId, commandInput, executionResult, actor);

    return executionResult;
  }

  /**
   * Persist an immutable audit row for a dispatched VFD control command.
   * Never throws — audit durability must not gate industrial actuation.
   */
  private async recordCommandAudit(
    deviceId: string,
    tenantId: string,
    commandInput: VfdCommandInput,
    result: VfdCommandExecutionResult,
    actor?: VfdCommandActor
  ): Promise<void> {
    try {
      await this.commandAuditRepo.save(
        this.commandAuditRepo.create({
          tenantId,
          vfdDeviceId: deviceId,
          command: commandInput.command,
          value: commandInput.value,
          success: result.success,
          error: result.error,
          performedBy: actor?.userId ?? 'system',
          performedByEmail: actor?.email,
          source: actor?.source ?? 'operator',
          latencyMs: result.latencyMs,
        })
      );
    } catch (auditError) {
      this.logger.error(
        `AUDIT GAP: failed to persist command audit for ${commandInput.command} on device ${deviceId} ` +
          `(command result success=${result.success}) — ${(auditError as Error).message}`
      );
    }
  }

  /**
   * Read the immutable command-audit trail for a device (tenant-scoped),
   * newest first. Surfaces the audit log to the product (parity — the table is
   * not write-only).
   */
  async getCommandAuditLog(
    deviceId: string,
    tenantId: string,
    limit = 100
  ): Promise<VfdCommandAuditLog[]> {
    return this.commandAuditRepo.find({
      where: { vfdDeviceId: deviceId, tenantId },
      order: { timestamp: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /**
   * Execute START command
   */
  private async executeStart(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle
  ): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const startCommand = brandCommands?.['RUN_FORWARD'] || brandCommands?.['START'] || 0x000f;

    return adapter.writeControlWord(handle, startCommand, controlWordMapping.registerAddress);
  }

  /**
   * Execute STOP command
   */
  private async executeStop(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle
  ): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const stopCommand = brandCommands?.['STOP'] || brandCommands?.['SHUTDOWN'] || 0x0006;

    return adapter.writeControlWord(handle, stopCommand, controlWordMapping.registerAddress);
  }

  /**
   * Execute REVERSE command
   */
  private async executeReverse(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle
  ): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const reverseCommand = brandCommands?.['RUN_REVERSE'] || 0x080f;

    return adapter.writeControlWord(handle, reverseCommand, controlWordMapping.registerAddress);
  }

  /**
   * Execute SET_FREQUENCY command
   */
  private async executeSetFrequency(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle,
    frequencyHz: number
  ): Promise<VfdCommandResult> {
    const speedRefMapping = await this.registerMappingService.getSpeedReferenceMapping(device.brand);
    if (!speedRefMapping) {
      throw new BadRequestException(`Speed reference mapping not found for brand ${device.brand}`);
    }

    // Validate frequency range
    if (speedRefMapping.minValue != null && frequencyHz < speedRefMapping.minValue) {
      throw new BadRequestException(
        `Frequency ${frequencyHz} Hz is below minimum ${speedRefMapping.minValue} Hz`
      );
    }
    if (speedRefMapping.maxValue != null && frequencyHz > speedRefMapping.maxValue) {
      throw new BadRequestException(
        `Frequency ${frequencyHz} Hz is above maximum ${speedRefMapping.maxValue} Hz`
      );
    }

    return adapter.writeSpeedReference(
      handle,
      frequencyHz,
      speedRefMapping.registerAddress,
      speedRefMapping.scalingFactor
    );
  }

  /**
   * Execute SET_SPEED command (percentage 0-100%)
   */
  private async executeSetSpeed(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle,
    speedPercent: number
  ): Promise<VfdCommandResult> {
    // Validate speed percentage
    if (speedPercent < 0 || speedPercent > 100) {
      throw new BadRequestException(`Speed percentage must be between 0 and 100`);
    }

    const speedRefMapping = await this.registerMappingService.getSpeedReferenceMapping(device.brand);
    if (!speedRefMapping) {
      throw new BadRequestException(`Speed reference mapping not found for brand ${device.brand}`);
    }

    // Convert percentage to actual value based on scaling
    // Different brands use different reference scaling
    let referenceValue: number;
    if (speedRefMapping.unit === 'Hz') {
      // Use max frequency from register mapping, or default to 50Hz
      const maxFrequency = speedRefMapping.maxValue || 50;
      referenceValue = (speedPercent / 100) * maxFrequency;
    } else if (speedRefMapping.unit === '%') {
      referenceValue = speedPercent;
    } else {
      // Default: percentage * 100 (e.g., 10000 = 100%)
      referenceValue = speedPercent * 100;
    }

    return adapter.writeSpeedReference(
      handle,
      referenceValue,
      speedRefMapping.registerAddress,
      speedRefMapping.scalingFactor
    );
  }

  /**
   * Execute FAULT_RESET command
   */
  private async executeFaultReset(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle
  ): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const resetCommand = brandCommands?.['FAULT_RESET'] || brandCommands?.['RESET'] || 0x0080;

    return adapter.writeControlWord(handle, resetCommand, controlWordMapping.registerAddress);
  }

  /**
   * Execute EMERGENCY_STOP command
   */
  private async executeEmergencyStop(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle
  ): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    // Emergency stop typically uses QUICK_STOP or OFF2 (coast stop)
    const emergencyCommand = brandCommands?.['QUICK_STOP'] || brandCommands?.['COAST'] || 0x0002;

    return adapter.writeControlWord(handle, emergencyCommand, controlWordMapping.registerAddress);
  }

  /**
   * Execute JOG command
   */
  private async executeJog(
    device: VfdDevice,
    adapter: ReturnType<typeof createVfdAdapter>,
    handle: VfdConnectionHandle,
    direction: 'forward' | 'reverse'
  ): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const jogCommand = direction === 'forward'
      ? (brandCommands?.['JOG_FORWARD'] || brandCommands?.['JOG'] || 0x057f)
      : (brandCommands?.['JOG_REVERSE'] || 0x0d7f);

    return adapter.writeControlWord(handle, jogCommand, controlWordMapping.registerAddress);
  }

  /**
   * Get or create connection to a device.
   * Uses a per-device promise lock so concurrent callers wait for the same
   * connect() call rather than each opening their own socket.
   */
  private getOrCreateConnection(device: VfdDevice): Promise<{
    adapter: ReturnType<typeof createVfdAdapter>;
    handle: VfdConnectionHandle;
  }> {
    const cached = this.activeConnections.get(device.id);
    if (cached && cached.handle.isConnected) {
      // Apply the same 60-second idle timeout as the reader service
      const idleTime = Date.now() - cached.lastActivity.getTime();
      if (idleTime < 60000) {
        cached.lastActivity = new Date();
        return Promise.resolve({ adapter: cached.adapter, handle: cached.handle });
      }
      // Stale connection: close asynchronously, then fall through to reconnect
      void this.closeConnection(device.id);
    }

    // If a connect is already in progress for this device, reuse that promise
    const inflight = this.connectLocks.get(device.id);
    if (inflight) {
      return inflight;
    }

    const connectPromise = (async () => {
      try {
        const adapter = createVfdAdapter(device.protocol);
        const handle = await adapter.connect(device.protocolConfiguration);

        this.activeConnections.set(device.id, {
          adapter,
          handle,
          lastActivity: new Date(),
        });

        return { adapter, handle };
      } finally {
        // Remove the lock regardless of success or failure
        this.connectLocks.delete(device.id);
      }
    })();

    this.connectLocks.set(device.id, connectPromise);
    return connectPromise;
  }

  /**
   * Close connection for a device
   */
  async closeConnection(deviceId: string): Promise<void> {
    const cached = this.activeConnections.get(deviceId);
    if (cached) {
      try {
        await cached.adapter.disconnect(cached.handle);
      } catch (error) {
        this.logger.warn(`Error closing connection for device ${deviceId}`, error);
      }
      this.activeConnections.delete(deviceId);
    }
  }
}
