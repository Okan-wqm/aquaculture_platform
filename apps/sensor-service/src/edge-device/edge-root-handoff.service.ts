import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';

import { DeviceDirectoryService } from './device-directory.service';
import { EdgeCommandPublisher } from './edge-command-publisher.service';
import { EdgeUpdateRequestService } from './edge-update-request.service';
import {
  DeviceLifecycleState,
  EdgeAgentChannel,
  type EdgeDevice,
} from './entities/edge-device.entity';
import {
  HANDOFF_REDELIVERY_INTERVAL_MS,
  type HandoffKind,
  ProvisioningReservationService,
} from './provisioning-reservation.service';

/**
 * The cloud-signed statements a Suderra OS agent hands to root (ADR-048
 * DEC-5.8, DEC-5.14; sens-api-gateway commands/root_handoff.rs): the
 * activation receipt and the device-lifecycle statement that opens a
 * re-provisioning window. Each travels as the `statement` parameter of a
 * signed command — the DSSE envelope JSON exactly as the cloud stored it —
 * through EdgeCommandPublisher.
 *
 * Both are stored on the device row and delivered until the agent reports
 * the statement handed to root: on every heartbeat that finds one pending,
 * at most once per HANDOFF_REDELIVERY_INTERVAL_MS (the pace is a claimed
 * timestamp on the row, shared by every replica), and the lifecycle
 * statement also right after it is issued. Nothing waits in memory: the
 * agent's response names the statement by digest, and whichever replica
 * receives it settles the row (ProvisioningReservationService.settleHandoff).
 * A delivery never fails its trigger — a refused publish is logged and the
 * next paced heartbeat retries it.
 */

type HandoffHolder = Pick<
  EdgeDevice,
  | 'id'
  | 'tenantId'
  | 'agentChannel'
  | 'activationReceipt'
  | 'activationReceiptSentAt'
  | 'activationReceiptHandedAt'
  | 'lifecycleRequest'
  | 'lifecycleRequestSentAt'
  | 'lifecycleRequestHandedAt'
  | 'maintenanceExpiresAt'
>;

/** The device a command response arrived from, as its topic names it. */
export interface HandoffResponder {
  /** The topic's device level: the device UUID, or the device code on legacy topics. */
  readonly deviceCode: string;
  /** The topic's tenant level; absent on legacy tenant-less topics. */
  readonly tenantId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paced(lastSent: Date | null, now: Date): boolean {
  return lastSent === null || lastSent.getTime() <= now.getTime() - HANDOFF_REDELIVERY_INTERVAL_MS;
}

@Injectable()
export class EdgeRootHandoffService {
  private readonly logger = new Logger(EdgeRootHandoffService.name);

  constructor(
    private readonly commands: EdgeCommandPublisher,
    private readonly reservations: ProvisioningReservationService,
    private readonly devices: DeviceDirectoryService,
    private readonly updateRequests: EdgeUpdateRequestService,
  ) {}

  /**
   * A heartbeat from a Suderra OS device: closes its re-provisioning window
   * when it lapsed unused (root is ACTIVE again on its own, DEC-5.14), then
   * delivers whatever the device is owed. Judged first from the row the
   * caller already holds, so a heartbeat with nothing pending costs no query.
   */
  async onHeartbeat(
    device: HandoffHolder & Pick<EdgeDevice, 'lifecycleState'>,
    now: Date,
  ): Promise<void> {
    if (device.agentChannel !== EdgeAgentChannel.SUDERRA_OS) return;
    if (
      device.lifecycleState === DeviceLifecycleState.MAINTENANCE &&
      device.maintenanceExpiresAt !== null &&
      device.maintenanceExpiresAt <= now &&
      (await this.reservations.settleLapsedMaintenance(device, now))
    ) {
      this.logger.log({ event: 'reprovisioning_window_lapsed', deviceId: device.id });
      return;
    }
    await this.deliverPending(device, now);
  }

  /** Delivers whatever the device is owed now (see {@link onHeartbeat}). */
  async deliverPending(device: HandoffHolder, now: Date): Promise<void> {
    if (device.agentChannel !== EdgeAgentChannel.SUDERRA_OS) return;
    if (
      device.activationReceipt !== null &&
      device.activationReceiptHandedAt === null &&
      paced(device.activationReceiptSentAt, now)
    ) {
      await this.deliverActivationReceipt(device, now);
    }
    if (
      device.lifecycleRequest !== null &&
      device.lifecycleRequestHandedAt === null &&
      device.maintenanceExpiresAt !== null &&
      device.maintenanceExpiresAt > now &&
      paced(device.lifecycleRequestSentAt, now)
    ) {
      await this.deliverLifecycleRequest(device, now);
    }
    await this.deliverUpdateRequests(device, now);
  }

  /**
   * The update requests the device is owed (ADR-048 DEC-2.12): each delivered inside
   * its window, at most once per redelivery interval, until the agent hands it to
   * root. A failure is logged and never fails the heartbeat.
   */
  private async deliverUpdateRequests(device: HandoffHolder, now: Date): Promise<void> {
    try {
      await this.updateRequests.deliverDue(device, now, HANDOFF_REDELIVERY_INTERVAL_MS);
    } catch (error) {
      this.logger.warn({
        event: 'update_request_delivery_failed',
        deviceId: device.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Claims and publishes one delivery of the pending receipt. True when one was published. */
  deliverActivationReceipt(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
  ): Promise<boolean> {
    return this.deliver(device, 'activation_receipt', () =>
      this.reservations.claimReceiptDelivery(device, now),
    );
  }

  /** Claims and publishes one delivery of the pending lifecycle statement. */
  deliverLifecycleRequest(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
  ): Promise<boolean> {
    return this.deliver(device, 'lifecycle_request', () =>
      this.reservations.claimLifecycleDelivery(device, now),
    );
  }

  private async deliver(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    command: HandoffKind,
    claim: () => Promise<string | null>,
  ): Promise<boolean> {
    try {
      const statement = await claim();
      if (statement === null) return false;
      const commandId = randomUUID();
      await this.commands.publish(
        { tenantId: device.tenantId, deviceId: device.id },
        { commandId, command, params: { statement } },
      );
      this.logger.log({ event: 'root_handoff_delivered', deviceId: device.id, command, commandId });
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'root_handoff_delivery_failed',
        deviceId: device.id,
        command,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Settles a hand-over from the agent's command response. Returns true when
   * the response was a hand-over response (its result carries
   * `handed_to_root`), settled or not. A success names the statement by its
   * digest; only that statement, stored on the responding device's own row,
   * is marked handed.
   */
  async handleResponse(
    responder: HandoffResponder,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const result = payload['result'];
    if (!isRecord(result) || typeof result['handed_to_root'] !== 'boolean') return false;
    if (payload['success'] !== true || result['handed_to_root'] !== true) {
      const commandId = typeof payload['commandId'] === 'string' ? payload['commandId'] : null;
      const reasons = Array.isArray(result['reasons']) ? result['reasons'].map(String) : [];
      this.logger.warn({
        event: 'root_handoff_refused_by_agent',
        device: responder.deviceCode,
        commandId,
        reasons,
        error: typeof payload['error'] === 'string' ? payload['error'] : null,
      });
      if (commandId !== null && UUID.test(commandId) && reasons.length > 0) {
        await this.recordUpdateRefusal(responder, commandId, reasons);
      }
      return true;
    }
    const reported = result['statement_digest'];
    const sha256 = isRecord(reported) ? reported['sha256'] : undefined;
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      this.logger.warn({ event: 'root_handoff_digest_missing', device: responder.deviceCode });
      return true;
    }
    const device = await this.devices.findDevice(
      UUID.test(responder.deviceCode) ? 'id' : 'device_code',
      responder.deviceCode,
    );
    if (
      device === null ||
      (responder.tenantId !== undefined && responder.tenantId !== device.tenantId)
    ) {
      return true;
    }
    const now = new Date();
    const settled = await this.reservations.settleHandoff(device, { sha256 }, now);
    if (settled !== null) {
      this.logger.log({ event: 'root_handoff_settled', deviceId: device.id, kind: settled });
    } else if (await this.updateRequests.markHanded(device, sha256, now)) {
      // An update request: the spool holds it. Only its result concludes it.
      this.logger.log({ event: 'update_request_handed', deviceId: device.id, sha256 });
    } else {
      this.logger.warn({ event: 'root_handoff_digest_unknown', deviceId: device.id, sha256 });
    }
    return true;
  }

  /** An agent's refusal of a `request_update` names the command, so it finds its request. */
  private async recordUpdateRefusal(
    responder: HandoffResponder,
    commandId: string,
    reasons: readonly string[],
  ): Promise<void> {
    const device = await this.devices.findDevice(
      UUID.test(responder.deviceCode) ? 'id' : 'device_code',
      responder.deviceCode,
    );
    if (
      device === null ||
      (responder.tenantId !== undefined && responder.tenantId !== device.tenantId)
    ) {
      return;
    }
    await this.updateRequests.recordHandoffRefusal(device, commandId, reasons, new Date());
  }
}
