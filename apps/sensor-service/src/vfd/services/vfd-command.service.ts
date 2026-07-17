import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VfdCommandResult } from '../adapters';
import { VFD_BRAND_COMMANDS } from '../brand-configs';
import { VfdCommandAuditLog } from '../entities/vfd-command-audit-log.entity';
import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdCommandType, VfdDeviceStatus } from '../entities/vfd.enums';

import { VfdDeviceService } from './vfd-device.service';
import { VfdEdgeWriteService } from './vfd-edge-write.service';
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
 *
 * Dispatches control commands (START/STOP/SET_FREQUENCY/EMERGENCY_STOP/…) to a
 * drive. The production write path is the edge Rust gateway (SENSOR-CRITICAL-007,
 * ADR-025): this service NO LONGER opens an in-process socket to the drive — it
 * resolves the control-word / speed-reference register + wire value and delegates
 * the write to `VfdEdgeWriteService`, which publishes a signed-topic `write_modbus`
 * command to the owning edge gateway and returns the gateway's REAL acknowledgement.
 * A command `success` therefore means the drive echoed the write; a drive not bound
 * to an edge gateway fails closed (no more silent fabricated success — the previous
 * in-process adapters returned `success:true` without transmitting).
 */
@Injectable()
export class VfdCommandService {
  private readonly logger = new Logger(VfdCommandService.name);

  constructor(
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly registerMappingService: VfdRegisterMappingService,
    private readonly edgeWriteService: VfdEdgeWriteService,
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
      // Resolve the register + wire value and delegate the write to the edge
      // gateway. Each helper below fails closed if the drive is not edge-bound.
      let result: VfdCommandResult;

      switch (commandInput.command) {
        case VfdCommandType.START:
          result = await this.executeStart(device);
          break;

        case VfdCommandType.STOP:
          result = await this.executeStop(device);
          break;

        case VfdCommandType.REVERSE:
          result = await this.executeReverse(device);
          break;

        case VfdCommandType.SET_FREQUENCY:
          if (commandInput.value === undefined) {
            throw new BadRequestException('SET_FREQUENCY requires a value');
          }
          result = await this.executeSetFrequency(device, commandInput.value);
          break;

        case VfdCommandType.SET_SPEED:
          if (commandInput.value === undefined) {
            throw new BadRequestException('SET_SPEED requires a value');
          }
          result = await this.executeSetSpeed(device, commandInput.value);
          break;

        case VfdCommandType.FAULT_RESET:
          result = await this.executeFaultReset(device);
          break;

        case VfdCommandType.QUICK_STOP:
          result = await this.executeQuickStop(device);
          break;

        case VfdCommandType.EMERGENCY_STOP:
          result = await this.executeEmergencyStop(device);
          break;

        case VfdCommandType.JOG_FORWARD:
          result = await this.executeJog(device, 'forward');
          break;

        case VfdCommandType.JOG_REVERSE:
          result = await this.executeJog(device, 'reverse');
          break;

        case VfdCommandType.COAST_STOP:
          result = await this.executeCoastStop(device);
          break;

        default: {
          // Compile-time exhaustiveness: adding a VfdCommandType member
          // without a dispatch case is a type error, not a runtime
          // "Unknown command" (QUICK_STOP/COAST_STOP shipped exactly that way).
          const unhandled: never = commandInput.command;
          throw new BadRequestException(`Unknown command: ${String(unhandled)}`);
        }
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
   * Delegate a single-register write to the drive's edge gateway and adapt the
   * result to the adapter-era `VfdCommandResult` shape the callers expect.
   * `success` reflects the gateway's real acknowledgement — never a fabrication.
   */
  private async edgeWrite(
    device: VfdDevice,
    registerAddress: number,
    wireValue: number,
    intent: string
  ): Promise<VfdCommandResult> {
    const result = await this.edgeWriteService.writeRegister(
      device,
      registerAddress,
      wireValue,
      intent
    );
    return {
      success: result.success,
      error: result.error,
      latencyMs: result.latencyMs,
      acknowledgedAt: new Date(),
    };
  }

  /**
   * Reverse-scale an engineering value (Hz / %) to the drive's raw register
   * value, mirroring the adapters' `reverseScaling` (offset 0). Guards against a
   * zero/undefined scaling factor so a mis-seeded mapping cannot divide by zero.
   */
  private reverseScale(value: number, scalingFactor: number | null | undefined): number {
    const factor = scalingFactor && scalingFactor !== 0 ? scalingFactor : 1;
    return Math.round(value / factor);
  }

  /**
   * Execute START command
   */
  private async executeStart(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const startCommand = brandCommands?.['RUN_FORWARD'] || brandCommands?.['START'] || 0x000f;

    return this.edgeWrite(device, controlWordMapping.registerAddress, startCommand, 'START');
  }

  /**
   * Execute STOP command
   */
  private async executeStop(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const stopCommand = brandCommands?.['STOP'] || brandCommands?.['SHUTDOWN'] || 0x0006;

    return this.edgeWrite(device, controlWordMapping.registerAddress, stopCommand, 'STOP');
  }

  /**
   * Execute REVERSE command
   */
  private async executeReverse(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const reverseCommand = brandCommands?.['RUN_REVERSE'] || 0x080f;

    return this.edgeWrite(device, controlWordMapping.registerAddress, reverseCommand, 'REVERSE');
  }

  /**
   * Execute SET_FREQUENCY command
   */
  private async executeSetFrequency(
    device: VfdDevice,
    frequencyHz: number
  ): Promise<VfdCommandResult> {
    const speedRefMapping = await this.registerMappingService.getSpeedReferenceMapping(device.brand);
    if (!speedRefMapping) {
      throw new BadRequestException(`Speed reference mapping not found for brand ${device.brand}`);
    }

    if (!Number.isFinite(frequencyHz)) {
      throw new BadRequestException(`Invalid frequency value: ${frequencyHz}`);
    }

    // Validate frequency range. Mapping-configured bounds win (Rockwell's
    // signed -500..500 stays legitimate); an UNBOUNDED mapping falls back to
    // a conservative absolute envelope instead of passing anything to the
    // drive — the mapping columns are nullable, so without the fallback
    // 600 Hz or -10 Hz reached physical hardware unvalidated. 0..400 Hz is
    // the widest Hz bound in the shipped brand register data (Danfoss,
    // Yaskawa both cap at 400 Hz); min 0 because SET_FREQUENCY is a
    // magnitude — direction is the REVERSE command.
    const minFrequencyHz = speedRefMapping.minValue ?? 0;
    const maxFrequencyHz = speedRefMapping.maxValue ?? 400;
    if (frequencyHz < minFrequencyHz) {
      throw new BadRequestException(
        `Frequency ${frequencyHz} Hz is below minimum ${minFrequencyHz} Hz`
      );
    }
    if (frequencyHz > maxFrequencyHz) {
      throw new BadRequestException(
        `Frequency ${frequencyHz} Hz is above maximum ${maxFrequencyHz} Hz`
      );
    }

    const wireValue = this.reverseScale(frequencyHz, speedRefMapping.scalingFactor);
    return this.edgeWrite(device, speedRefMapping.registerAddress, wireValue, 'SET_FREQUENCY');
  }

  /**
   * Execute SET_SPEED command (percentage 0-100%)
   */
  private async executeSetSpeed(
    device: VfdDevice,
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

    const wireValue = this.reverseScale(referenceValue, speedRefMapping.scalingFactor);
    return this.edgeWrite(device, speedRefMapping.registerAddress, wireValue, 'SET_SPEED');
  }

  /**
   * Execute FAULT_RESET command
   */
  private async executeFaultReset(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    const resetCommand = brandCommands?.['FAULT_RESET'] || brandCommands?.['RESET'] || 0x0080;

    return this.edgeWrite(device, controlWordMapping.registerAddress, resetCommand, 'FAULT_RESET');
  }

  /**
   * Execute QUICK_STOP command — controlled fast ramp-down. In CiA402 /
   * PROFIdrive the quick-stop control word IS the fieldbus e-stop
   * mechanism, so brands that define QUICK_STOP share the wire value with
   * EMERGENCY_STOP; the distinct command types preserve operator intent
   * in results and audit trails.
   */
  private async executeQuickStop(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    // CiA402 QUICK_STOP (OFF3) control word is 0x0002 (VFD_CONTROL_COMMANDS.QUICK_STOP)
    const quickStopCommand = brandCommands?.['QUICK_STOP'] || 0x0002;

    return this.edgeWrite(device, controlWordMapping.registerAddress, quickStopCommand, 'QUICK_STOP');
  }

  /**
   * Execute COAST_STOP command — remove output voltage and let the motor
   * freewheel (CiA402 OFF2 / DISABLE_VOLTAGE).
   */
  private async executeCoastStop(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    // 0x0000 = CiA402 DISABLE_VOLTAGE (OFF2 coast)
    const coastCommand = brandCommands?.['COAST'] || brandCommands?.['COAST_STOP'] || 0x0000;

    return this.edgeWrite(device, controlWordMapping.registerAddress, coastCommand, 'COAST_STOP');
  }

  /**
   * Execute EMERGENCY_STOP command
   */
  private async executeEmergencyStop(device: VfdDevice): Promise<VfdCommandResult> {
    const controlWordMapping = await this.registerMappingService.getControlWordMapping(device.brand);
    if (!controlWordMapping) {
      throw new BadRequestException(`Control word mapping not found for brand ${device.brand}`);
    }

    const brandCommands = VFD_BRAND_COMMANDS[device.brand];
    // Emergency stop typically uses QUICK_STOP or OFF2 (coast stop)
    const emergencyCommand = brandCommands?.['QUICK_STOP'] || brandCommands?.['COAST'] || 0x0002;

    return this.edgeWrite(
      device,
      controlWordMapping.registerAddress,
      emergencyCommand,
      'EMERGENCY_STOP'
    );
  }

  /**
   * Execute JOG command
   */
  private async executeJog(
    device: VfdDevice,
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

    return this.edgeWrite(
      device,
      controlWordMapping.registerAddress,
      jogCommand,
      direction === 'forward' ? 'JOG_FORWARD' : 'JOG_REVERSE'
    );
  }
}
