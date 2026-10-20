import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import {
  validateCommandEnvelope,
  formatValidationErrors,
} from '@platform/sensor-contracts/validators';

import { EdgeCommandPublisher } from '../../edge-device/edge-command-publisher.service';
import { VfdDevice } from '../entities/vfd-device.entity';

/**
 * Result of an edge-delegated VFD register write. `success` is TRUE only when
 * the owning edge gateway actually transmitted the write and the drive
 * acknowledged it at the Modbus protocol level — never a cloud-side fabrication
 * (SENSOR-CRITICAL-007).
 */
export interface VfdEdgeWriteResult {
  success: boolean;
  /** The command correlation id (also the ack key). */
  commandId: string;
  /** Populated on failure/timeout; the edge's reason when it reported one. */
  error?: string;
  /** Round-trip latency to the edge ack, when an ack arrived. */
  latencyMs?: number;
}

interface PendingWrite {
  commandId: string;
  edgeDeviceId: string;
  startTime: number;
  resolve: (result: VfdEdgeWriteResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const U16_MAX = 0xffff;

/**
 * Edge-delegated VFD write primitive (SENSOR-CRITICAL-007, Faz 1 Slice 2).
 *
 * The cloud does NOT open a socket to the drive. It publishes a `write_modbus`
 * command envelope to the owning edge gateway (`tenants/{t}/devices/{edge}/
 * commands`, the same tenant-scoped, mTLS-ACL-authenticated topic every other
 * cloud→edge command uses) and awaits the gateway's real acknowledgement,
 * correlated by the per-write command id. A `success` therefore means the edge
 * `write_register` returned Ok — the drive echoed the Modbus write — not that a
 * cloud adapter *claimed* to have written.
 *
 * Authentication: the command goes out through EdgeCommandPublisher, the one
 * command publish path (ADR-048 DEC-9.2). A Suderra OS gateway receives it as
 * a platform-actor envelope signed with the command key — and, until SG-1
 * opens, refuses it, because the platform role grants no Modbus write
 * (DEC-9.4, DEC-13); a generic-Linux gateway receives the legacy unsigned
 * message until DEC-28 P2.
 */
@Injectable()
export class VfdEdgeWriteService {
  private readonly logger = new Logger(VfdEdgeWriteService.name);
  private readonly writeTimeoutMs = 10000;
  private readonly pendingWrites = new Map<string, PendingWrite>();

  constructor(
    // The single command publish path (ADR-048 DEC-9.2): it signs for a
    // Suderra OS gateway and fails closed when the broker is unavailable.
    private readonly commands: EdgeCommandPublisher,
  ) {}

  /**
   * Publish a single-register write to the drive's edge gateway and resolve
   * with the real edge acknowledgement. Rejects (fail-closed) when the drive is
   * not bound to an edge gateway or the write is out of Modbus range; resolves
   * `success:false` on publish failure, edge-reported failure, or ack timeout.
   *
   * @param intent human-readable label for logs/audit (e.g. "EMERGENCY_STOP").
   */
  async writeRegister(
    device: VfdDevice,
    address: number,
    value: number,
    intent: string,
  ): Promise<VfdEdgeWriteResult> {
    const edgeDeviceId = device.edgeDeviceId;
    const edgeModbusDeviceName = device.edgeModbusDeviceName;
    if (!edgeDeviceId || !edgeModbusDeviceName) {
      // Fail-closed: an unbound drive has no gateway to delegate to. The command
      // MUST NOT silently succeed (the exact SENSOR-CRITICAL-007 hazard).
      throw new BadRequestException(
        `VFD ${device.id} is not bound to an edge gateway; ` +
          'edge-delegated writes require both edgeDeviceId and edgeModbusDeviceName',
      );
    }
    this.assertU16('register address', address);
    this.assertU16('register value', value);

    this.ensureMqtt();
    const commandId = randomUUID();
    const startTime = Date.now();

    const result = new Promise<VfdEdgeWriteResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingWrites.delete(commandId);
        this.logger.warn(
          `Edge write (${intent}) on VFD ${device.id} timed out with no gateway ack (command ${commandId})`,
        );
        resolve({
          success: false,
          commandId,
          error: 'Edge gateway did not acknowledge the write within the timeout',
        });
      }, this.writeTimeoutMs);
      this.pendingWrites.set(commandId, { commandId, edgeDeviceId, startTime, resolve, timeout });
    });

    const envelope = {
      commandId,
      command: 'write_modbus',
      timestamp: new Date().toISOString(),
      params: { device: edgeModbusDeviceName, address, value },
    };
    if (!validateCommandEnvelope(envelope)) {
      this.discard(commandId);
      throw new BadRequestException(
        `write_modbus envelope violates the canonical contract: ${formatValidationErrors(
          validateCommandEnvelope,
        )}`,
      );
    }

    try {
      await this.commands.publish(
        { tenantId: device.tenantId, deviceId: edgeDeviceId },
        { commandId: envelope.commandId, command: envelope.command, params: envelope.params },
      );
      this.logger.debug(
        `Edge write (${intent}) published to gateway ${edgeDeviceId} → ${edgeModbusDeviceName}[${address}]=${value} (command ${commandId})`,
      );
    } catch (error) {
      this.discard(commandId);
      return {
        success: false,
        commandId,
        error: `Failed to publish edge write command: ${(error as Error).message}`,
      };
    }

    return result;
  }

  /**
   * Resolve a pending write with the edge gateway's acknowledgement. Called by
   * the MQTT listener for every command response; a no-op when the commandId is
   * not one of ours (the response belongs to a ping/scan/deploy instead). The
   * per-write random commandId is the authoritative correlation key.
   */
  handleWriteResponse(payload: Record<string, unknown>): void {
    const commandId = typeof payload['commandId'] === 'string' ? payload['commandId'] : undefined;
    if (!commandId) {
      return;
    }
    const pending = this.pendingWrites.get(commandId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingWrites.delete(commandId);

    const success = payload['success'] === true;
    const edgeError = typeof payload['error'] === 'string' ? payload['error'] : undefined;
    pending.resolve({
      success,
      commandId,
      latencyMs: Date.now() - pending.startTime,
      error: success ? undefined : (edgeError ?? 'Edge gateway reported the write failed'),
    });
  }

  private ensureMqtt(): void {
    if (!this.commands.isAvailable()) {
      throw new BadRequestException('Not connected to MQTT broker for edge-delegated VFD write');
    }
  }

  private assertU16(label: string, n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > U16_MAX) {
      throw new BadRequestException(
        `Modbus ${label} must be an integer in 0..${U16_MAX}; got ${n}`,
      );
    }
  }

  private discard(commandId: string): void {
    const pending = this.pendingWrites.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingWrites.delete(commandId);
    }
  }
}
