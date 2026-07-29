import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';

import {
  validateCommandEnvelope,
  formatValidationErrors,
} from '@platform/sensor-contracts/validators';

import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import {
  ModbusRtuConfiguration,
  ModbusTcpConfiguration,
  VfdDevice,
} from '../entities/vfd-device.entity';
import { VfdRegisterMapping } from '../entities/vfd-register-mapping.entity';
import { VfdDataType, VfdProtocol } from '../entities/vfd.enums';
import { VfdRegisterMappingService } from './vfd-register-mapping.service';

/**
 * Edge Modbus register config — serialises to the edge crate's
 * `ModbusRegisterConfig` (snake_case serde field names). Fields not sent use the
 * edge's serde defaults (byte_order, poll_interval_ms).
 */
interface EdgeModbusRegisterConfig {
  name: string;
  address: number;
  register_type: string;
  data_type: string;
  scale: number;
  unit?: string;
}

/** Serialises to the edge crate's `ModbusSecurityConfig` (partial; rest default). */
interface EdgeModbusSecurityConfig {
  enabled: boolean;
  allowed_function_codes: number[];
  allow_writes: boolean;
  allowed_write_ranges: Array<[number, number]>;
  verify_write_readback: boolean;
}

/** Serialises to the edge crate's `ModbusDeviceConfig`. */
export interface EdgeModbusDeviceConfig {
  name: string;
  connection_type: 'tcp' | 'rtu';
  address: string;
  slave_id: number;
  baud_rate?: number;
  registers: EdgeModbusRegisterConfig[];
  security: EdgeModbusSecurityConfig;
}

/**
 * Outcome of an edge provisioning command. `success` is true only on a real edge
 * ack; `skipped` marks a device whose protocol cannot be represented as an edge
 * Modbus device (nothing was published).
 */
export interface EdgeProvisionResult {
  success: boolean;
  commandId?: string;
  error?: string;
  latencyMs?: number;
  skipped?: boolean;
}

interface PendingProvision {
  commandId: string;
  startTime: number;
  resolve: (result: EdgeProvisionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const U8_MAX = 0xff;
const U16_MAX = 0xffff;

// Reads (FC1-4) + single-coil write (FC5) + single-register write (FC6). The
// edge implements only single writes; the address whitelist (allowed_write_ranges)
// is the fine-grained SL-2 boundary, so the function-code set stays this broad
// only to admit the write path at all.
const VFD_ALLOWED_FUNCTION_CODES = [1, 2, 3, 4, 5, 6];
const WRITE_FUNCTION_CODES = new Set([5, 6, 16]);

/**
 * VFD → edge Modbus device bridge (SENSOR-CRITICAL-007, Faz 1 Slice 3.5).
 *
 * A tenant-added VFD is registered in the cloud after the edge was provisioned;
 * the edge cannot LEARN about it from static config. This service publishes a
 * `provision_modbus_device` command (its inverse `decommission_modbus_device`)
 * to the owning edge gateway so the drive becomes a live, writable Modbus device
 * on the edge — the target of the `write_modbus` envelopes the write primitive
 * (`VfdEdgeWriteService`) publishes. The edge hot-adds + persists the device, so
 * the write path is real end-to-end rather than aimed at a non-existent device.
 *
 * The Modbus device config is derived from the VFD's protocol configuration
 * (connection) + its brand register mappings (register map + `allowed_write_ranges`
 * from the WRITABLE registers only — deny-by-default write authority). Non-Modbus
 * VFDs (PROFIBUS, PROFINET, …) cannot be pushed as Modbus devices and are skipped.
 *
 * Auth: like every cloud→edge command the envelope is UNSIGNED — the broker's
 * per-tenant mTLS ACL is the authority (see VfdEdgeWriteService for the note on
 * the latent ed25519 signing capability).
 */
@Injectable()
export class VfdEdgeProvisioningService {
  private readonly logger = new Logger(VfdEdgeProvisioningService.name);
  private readonly ackTimeoutMs = 10000;
  private readonly pending = new Map<string, PendingProvision>();

  constructor(
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    private readonly registerMappingService: VfdRegisterMappingService,
    @InjectRepository(VfdDevice)
    private readonly vfdDeviceRepository: Repository<VfdDevice>,
  ) {}

  /**
   * Provision (or re-provision) the drive on its owning edge gateway. A no-op
   * `skipped` result when the drive is not bound to a gateway or its protocol is
   * not Modbus; a real edge ack otherwise.
   */
  async provisionDevice(device: VfdDevice): Promise<EdgeProvisionResult> {
    if (!device.edgeDeviceId || !device.edgeModbusDeviceName) {
      return { success: false, skipped: true, error: 'drive is not bound to an edge gateway' };
    }

    const modbusConfig = await this.buildModbusDeviceConfig(device);
    if (!modbusConfig) {
      return {
        success: false,
        skipped: true,
        error: `protocol ${device.protocol} cannot be provisioned as an edge Modbus device`,
      };
    }

    return this.dispatch(device.tenantId, device.edgeDeviceId, {
      command: 'provision_modbus_device',
      params: { device: modbusConfig },
      intent: `provision ${device.edgeModbusDeviceName}`,
    });
  }

  /**
   * Decommission the drive's Modbus device on its edge gateway. Callers pass the
   * PRIOR binding when a drive is unbound/deleted (the entity may already be
   * mutated). A no-op `skipped` result when there is no binding to remove.
   */
  async decommissionDevice(binding: {
    tenantId: string;
    edgeDeviceId?: string | null;
    edgeModbusDeviceName?: string | null;
  }): Promise<EdgeProvisionResult> {
    if (!binding.edgeDeviceId || !binding.edgeModbusDeviceName) {
      return { success: false, skipped: true, error: 'no edge binding to decommission' };
    }
    return this.dispatch(binding.tenantId, binding.edgeDeviceId, {
      command: 'decommission_modbus_device',
      params: { device: binding.edgeModbusDeviceName },
      intent: `decommission ${binding.edgeModbusDeviceName}`,
    });
  }

  /**
   * Re-provision every edge-bound VFD owned by an edge gateway. Called when the
   * gateway comes back online (or on demand) to reconcile drives that were bound
   * while it was offline. Returns the per-drive outcomes.
   */
  async reprovisionAllForEdge(
    edgeDeviceId: string,
    tenantId: string,
  ): Promise<Array<{ vfdDeviceId: string; result: EdgeProvisionResult }>> {
    const devices = await this.vfdDeviceRepository.find({
      where: { edgeDeviceId, tenantId },
    });
    const bound = devices.filter((d) => d.edgeModbusDeviceName);
    if (bound.length === 0) {
      return [];
    }
    this.logger.log(
      `Reconciling ${bound.length} bound VFD(s) for edge ${edgeDeviceId} (tenant ${tenantId})`,
    );
    const outcomes: Array<{ vfdDeviceId: string; result: EdgeProvisionResult }> = [];
    for (const device of bound) {
      // Serialise: each drive is an independent edge command; a failure on one
      // must not abort reconciliation of the rest.
      const result = await this.provisionDevice(device).catch((error) => ({
        success: false,
        error: `reprovision threw: ${(error as Error).message}`,
      }));
      outcomes.push({ vfdDeviceId: device.id, result });
    }
    return outcomes;
  }

  /**
   * Resolve a pending provision/decommission with the edge gateway's ack. Called
   * by the MQTT listener for every command response; a no-op when the commandId
   * is not one of ours.
   */
  handleProvisionResponse(payload: Record<string, unknown>): void {
    const commandId = typeof payload['commandId'] === 'string' ? payload['commandId'] : undefined;
    if (!commandId) {
      return;
    }
    const pending = this.pending.get(commandId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(commandId);

    const success = payload['success'] === true;
    const edgeError = typeof payload['error'] === 'string' ? payload['error'] : undefined;
    pending.resolve({
      success,
      commandId,
      latencyMs: Date.now() - pending.startTime,
      error: success ? undefined : (edgeError ?? 'edge gateway reported the command failed'),
    });
  }

  /**
   * Build the edge Modbus device config from the VFD's protocol configuration +
   * brand register mappings. Returns null for non-Modbus protocols.
   */
  async buildModbusDeviceConfig(device: VfdDevice): Promise<EdgeModbusDeviceConfig | null> {
    const connection = this.buildConnection(device);
    if (!connection) {
      return null;
    }

    const [allMappings, writableMappings] = await Promise.all([
      this.registerMappingService.getMappingsForBrand(
        device.brand,
        device.modelSeries ?? undefined,
      ),
      this.registerMappingService.getWritableMappings(device.brand),
    ]);

    const registers = allMappings
      .filter((m) => m.registerAddress >= 0 && m.registerAddress <= U16_MAX)
      .map((m) => this.toEdgeRegister(m));

    const writeRanges = this.buildWriteRanges(writableMappings, device);
    const allowWrites = writeRanges.length > 0;

    return {
      ...connection,
      registers,
      security: {
        enabled: true,
        allowed_function_codes: VFD_ALLOWED_FUNCTION_CODES,
        allow_writes: allowWrites,
        allowed_write_ranges: writeRanges,
        verify_write_readback: true,
      },
    };
  }

  private buildConnection(
    device: VfdDevice,
  ): Pick<
    EdgeModbusDeviceConfig,
    'name' | 'connection_type' | 'address' | 'slave_id' | 'baud_rate'
  > | null {
    const name = device.edgeModbusDeviceName;
    if (!name) {
      return null;
    }
    if (device.protocol === VfdProtocol.MODBUS_TCP) {
      const cfg = device.protocolConfiguration as ModbusTcpConfiguration;
      if (!cfg?.host || !Number.isInteger(cfg.port)) {
        return null;
      }
      return {
        name,
        connection_type: 'tcp',
        address: `${cfg.host}:${cfg.port}`,
        slave_id: this.clampU8(cfg.unitId ?? 1),
      };
    }
    if (device.protocol === VfdProtocol.MODBUS_RTU) {
      const cfg = device.protocolConfiguration as ModbusRtuConfiguration;
      if (!cfg?.serialPort) {
        return null;
      }
      return {
        name,
        connection_type: 'rtu',
        address: cfg.serialPort,
        slave_id: this.clampU8(cfg.slaveId ?? 1),
        ...(Number.isInteger(cfg.baudRate) ? { baud_rate: cfg.baudRate } : {}),
      };
    }
    // Non-Modbus protocols cannot be represented as an edge Modbus device.
    return null;
  }

  private buildWriteRanges(
    writableMappings: VfdRegisterMapping[],
    device: VfdDevice,
  ): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const push = (address: number, count: number): void => {
      const start = address;
      const end = address + Math.max(count, 1) - 1;
      if (start >= 0 && start <= U16_MAX && end >= start && end <= U16_MAX) {
        ranges.push([start, end]);
      }
    };
    for (const m of writableMappings) {
      push(m.registerAddress, m.registerCount);
    }
    for (const custom of device.customRegisterMappings ?? []) {
      if (WRITE_FUNCTION_CODES.has(custom.functionCode)) {
        push(custom.registerAddress, custom.registerCount);
      }
    }
    return this.dedupeRanges(ranges);
  }

  private toEdgeRegister(m: VfdRegisterMapping): EdgeModbusRegisterConfig {
    const register: EdgeModbusRegisterConfig = {
      name: m.parameterName,
      address: m.registerAddress,
      register_type: this.registerTypeForFunctionCode(m.functionCode),
      data_type: this.edgeDataType(m.dataType),
      scale: Number(m.scalingFactor ?? 1) || 1,
    };
    if (m.unit) {
      register.unit = m.unit;
    }
    return register;
  }

  private registerTypeForFunctionCode(functionCode: number): string {
    switch (functionCode) {
      case 1:
      case 5:
      case 15:
        return 'coil';
      case 2:
        return 'discrete';
      case 4:
        return 'input';
      // FC3 (read holding) and FC6/FC16 (write holding) both target holding regs.
      default:
        return 'holding';
    }
  }

  private edgeDataType(dataType: VfdDataType): string {
    switch (dataType) {
      case VfdDataType.INT16:
        return 'i16';
      case VfdDataType.UINT32:
        return 'u32';
      case VfdDataType.INT32:
        return 'i32';
      case VfdDataType.FLOAT32:
        return 'f32';
      // uint16 + the 16-bit control/status words are all u16 on the wire.
      default:
        return 'u16';
    }
  }

  private dedupeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
    const seen = new Set<string>();
    const out: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      const key = `${start}:${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([start, end]);
      }
    }
    return out;
  }

  private clampU8(n: number): number {
    if (!Number.isInteger(n) || n < 0) {
      return 0;
    }
    return n > U8_MAX ? U8_MAX : n;
  }

  private async dispatch(
    tenantId: string,
    edgeDeviceId: string,
    cmd: { command: string; params: Record<string, unknown>; intent: string },
  ): Promise<EdgeProvisionResult> {
    const mqtt = this.mqttClient;
    if (!mqtt || !mqtt.isConnectedToBroker()) {
      return {
        success: false,
        error: 'not connected to MQTT broker for edge provisioning command',
      };
    }

    const commandId = randomUUID();
    const startTime = Date.now();
    const envelope = {
      commandId,
      command: cmd.command,
      timestamp: new Date().toISOString(),
      params: cmd.params,
    };
    if (!validateCommandEnvelope(envelope)) {
      return {
        success: false,
        commandId,
        error: `${cmd.command} envelope violates the canonical contract: ${formatValidationErrors(
          validateCommandEnvelope,
        )}`,
      };
    }

    const result = new Promise<EdgeProvisionResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(commandId);
        this.logger.warn(
          `Edge command (${cmd.intent}) timed out with no ack (command ${commandId})`,
        );
        resolve({
          success: false,
          commandId,
          error: 'edge gateway did not acknowledge the command within the timeout',
        });
      }, this.ackTimeoutMs);
      this.pending.set(commandId, { commandId, startTime, resolve, timeout });
    });

    try {
      await mqtt.publish(`tenants/${tenantId}/devices/${edgeDeviceId}/commands`, envelope);
      this.logger.debug(
        `Edge command (${cmd.intent}) published to gateway ${edgeDeviceId} (command ${commandId})`,
      );
    } catch (error) {
      this.discard(commandId);
      return {
        success: false,
        commandId,
        error: `failed to publish edge command: ${(error as Error).message}`,
      };
    }

    return result;
  }

  private discard(commandId: string): void {
    const pending = this.pending.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(commandId);
    }
  }
}
