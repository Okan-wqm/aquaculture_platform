import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';

import {
  validateCommandEnvelope,
  formatValidationErrors,
} from '@platform/sensor-contracts/validators';

import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import { VfdDevice } from '../entities/vfd-device.entity';

/**
 * Result of an edge-delegated VFD register read. `success` is TRUE only when the
 * owning edge gateway actually read the register from the drive and returned its
 * value — never a cloud-side fabrication (SENSOR-CRITICAL-007). `found` is false
 * when the edge answered but the target register was not among the drive's
 * configured registers (so the value is unknowable, not zero).
 */
export interface VfdEdgeReadResult {
  success: boolean;
  /** The command correlation id (also the ack key). */
  commandId: string;
  /** The register was present in the edge's response. */
  found: boolean;
  /** Raw (unscaled) register value, when found. */
  rawValue?: number;
  /** Edge-scaled value, when the edge applied a scale to the register. */
  scaledValue?: number;
  /** Populated on failure/timeout; the edge's reason when it reported one. */
  error?: string;
  /** Round-trip latency to the edge ack, when an ack arrived. */
  latencyMs?: number;
}

interface PendingRead {
  commandId: string;
  edgeModbusDeviceName: string;
  address: number;
  startTime: number;
  resolve: (result: VfdEdgeReadResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const U16_MAX = 0xffff;

/**
 * Edge-delegated VFD read primitive (SENSOR-CRITICAL-007, Faz 1 Slice 4).
 *
 * The cloud does NOT open a socket to the drive. It publishes a `read_modbus`
 * command envelope to the owning edge gateway (the same tenant-scoped,
 * mTLS-ACL-authenticated command topic every other cloud→edge command uses) and
 * awaits the gateway's real read, correlated by the per-read command id. The edge
 * reads every configured register of the drive; this primitive extracts the ONE
 * register the caller asked for (by address) from that response.
 *
 * A `found:false` result means the edge answered but the register is not in the
 * drive's provisioned register map — the caller MUST treat that as "unknown",
 * never as zero (a fail-open motor-state read is exactly the SENSOR-HIGH-074
 * hazard). Authentication mirrors VfdEdgeWriteService: the envelope is unsigned;
 * the broker's per-tenant mTLS ACL is the authority.
 */
@Injectable()
export class VfdEdgeReadService {
  private readonly logger = new Logger(VfdEdgeReadService.name);
  private readonly readTimeoutMs = 10000;
  private readonly pendingReads = new Map<string, PendingRead>();

  constructor(
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
  ) {}

  /**
   * Publish a read of the drive's configured registers to its edge gateway and
   * resolve with the value of the register at `address`. Rejects (fail-closed)
   * when the drive is not bound to a gateway or the address is out of Modbus
   * range; resolves `success:false` on publish failure, edge-reported failure, or
   * ack timeout, and `found:false` when the register is absent from the response.
   *
   * @param intent human-readable label for logs (e.g. "motor status word").
   */
  async readRegister(
    device: VfdDevice,
    address: number,
    intent: string,
  ): Promise<VfdEdgeReadResult> {
    const edgeDeviceId = device.edgeDeviceId;
    const edgeModbusDeviceName = device.edgeModbusDeviceName;
    if (!edgeDeviceId || !edgeModbusDeviceName) {
      // Fail-closed: an unbound drive has no gateway to read from.
      throw new BadRequestException(
        `VFD ${device.id} is not bound to an edge gateway; ` +
          'edge-delegated reads require both edgeDeviceId and edgeModbusDeviceName',
      );
    }
    this.assertU16('register address', address);

    const mqtt = this.ensureMqtt();
    const commandId = randomUUID();
    const startTime = Date.now();

    const result = new Promise<VfdEdgeReadResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReads.delete(commandId);
        this.logger.warn(
          `Edge read (${intent}) on VFD ${device.id} timed out with no gateway ack (command ${commandId})`,
        );
        resolve({
          success: false,
          commandId,
          found: false,
          error: 'Edge gateway did not acknowledge the read within the timeout',
        });
      }, this.readTimeoutMs);
      this.pendingReads.set(commandId, {
        commandId,
        edgeModbusDeviceName,
        address,
        startTime,
        resolve,
        timeout,
      });
    });

    const envelope = {
      commandId,
      command: 'read_modbus',
      timestamp: new Date().toISOString(),
      params: { device: edgeModbusDeviceName },
    };
    if (!validateCommandEnvelope(envelope)) {
      this.discard(commandId);
      throw new BadRequestException(
        `read_modbus envelope violates the canonical contract: ${formatValidationErrors(
          validateCommandEnvelope,
        )}`,
      );
    }

    try {
      await mqtt.publish(`tenants/${device.tenantId}/devices/${edgeDeviceId}/commands`, envelope);
      this.logger.debug(
        `Edge read (${intent}) published to gateway ${edgeDeviceId} → ${edgeModbusDeviceName}[${address}] (command ${commandId})`,
      );
    } catch (error) {
      this.discard(commandId);
      return {
        success: false,
        commandId,
        found: false,
        error: `Failed to publish edge read command: ${(error as Error).message}`,
      };
    }

    return result;
  }

  /**
   * Resolve a pending read with the edge gateway's response. Called by the MQTT
   * listener for every command response; a no-op when the commandId is not one of
   * ours. Extracts the target register (by device name + address) from the edge's
   * `read_modbus` result payload.
   */
  handleReadResponse(payload: Record<string, unknown>): void {
    const commandId = typeof payload['commandId'] === 'string' ? payload['commandId'] : undefined;
    if (!commandId) {
      return;
    }
    const pending = this.pendingReads.get(commandId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingReads.delete(commandId);

    const latencyMs = Date.now() - pending.startTime;
    const success = payload['success'] === true;
    if (!success) {
      const edgeError = typeof payload['error'] === 'string' ? payload['error'] : undefined;
      pending.resolve({
        success: false,
        commandId,
        found: false,
        latencyMs,
        error: edgeError ?? 'Edge gateway reported the read failed',
      });
      return;
    }

    const value = this.extractRegister(
      payload['result'],
      pending.edgeModbusDeviceName,
      pending.address,
    );
    pending.resolve({
      success: true,
      commandId,
      found: value !== null,
      latencyMs,
      ...(value ? { rawValue: value.rawValue, scaledValue: value.scaledValue } : {}),
      ...(value === null
        ? { error: `Register ${pending.address} not present in the drive's edge register map` }
        : {}),
    });
  }

  /**
   * Pull the register at `address` for `deviceName` out of the edge's read_modbus
   * result: `{ devices: [{ device, values: [{ address, raw_value, scaled_value }] }] }`.
   * Returns null when the device or register is absent (unknown, not zero).
   */
  private extractRegister(
    result: unknown,
    deviceName: string,
    address: number,
  ): { rawValue: number; scaledValue?: number } | null {
    if (!result || typeof result !== 'object') {
      return null;
    }
    const devices = (result as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) {
      return null;
    }
    for (const dev of devices) {
      if (!dev || typeof dev !== 'object') continue;
      if ((dev as { device?: unknown }).device !== deviceName) continue;
      const values = (dev as { values?: unknown }).values;
      if (!Array.isArray(values)) continue;
      for (const v of values) {
        if (!v || typeof v !== 'object') continue;
        if ((v as { address?: unknown }).address !== address) continue;
        const raw = (v as { raw_value?: unknown }).raw_value;
        if (typeof raw !== 'number') continue;
        const scaled = (v as { scaled_value?: unknown }).scaled_value;
        return {
          rawValue: raw,
          ...(typeof scaled === 'number' ? { scaledValue: scaled } : {}),
        };
      }
    }
    return null;
  }

  private ensureMqtt(): MqttClientService {
    if (!this.mqttClient) {
      throw new BadRequestException('MQTT service not available for edge-delegated VFD read');
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker for edge-delegated VFD read');
    }
    return this.mqttClient;
  }

  private assertU16(label: string, n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > U16_MAX) {
      throw new BadRequestException(
        `Modbus ${label} must be an integer in 0..${U16_MAX}; got ${n}`,
      );
    }
  }

  private discard(commandId: string): void {
    const pending = this.pendingReads.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingReads.delete(commandId);
    }
  }
}
