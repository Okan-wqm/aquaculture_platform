import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';

import { type SignedStatement, STATEMENT } from './edge-contract';
import { EdgeCommandPublisher } from './edge-command-publisher.service';
import { EdgeAgentChannel, type EdgeDevice } from './entities/edge-device.entity';
import { ProvisioningReservationService } from './provisioning-reservation.service';

/**
 * The cloud-signed statements a Suderra OS agent hands to root (ADR-048
 * DEC-5.8, DEC-5.14; sens-api-gateway commands/root_handoff.rs): the
 * activation receipt and the device-lifecycle request. Each travels as the
 * `statement` parameter of a signed command — the DSSE envelope JSON exactly
 * as the cloud signed it — through EdgeCommandPublisher.
 *
 * The receipt is minted at the commit (ProvisioningReservationService) and
 * kept on the device row until the agent reports it handed to root. It is
 * delivered when the device comes online after the commit, and again on
 * every later reconnect until that report arrives: the commit happens at
 * CONNECT, before the agent has subscribed, so a publish at commit time
 * would be lost.
 */

type ReceiptHolder = Pick<
  EdgeDevice,
  | 'id'
  | 'tenantId'
  | 'deviceCode'
  | 'agentChannel'
  | 'activationReceipt'
  | 'activationReceiptHandedAt'
>;

/** The device a command response arrived from, as its topic names it. */
export interface HandoffResponder {
  /** The topic's device level: the device UUID, or the device code on legacy topics. */
  readonly deviceCode: string;
  /** The topic's tenant level; absent on legacy tenant-less topics. */
  readonly tenantId?: string;
}

/** How long a receipt hand-over waits for the agent's report. */
const HANDOFF_ACK_TIMEOUT_MS = 60_000;

@Injectable()
export class EdgeRootHandoffService {
  private readonly logger = new Logger(EdgeRootHandoffService.name);
  private readonly pendingReceipts = new Map<
    string,
    {
      readonly tenantId: string;
      readonly deviceId: string;
      readonly deviceCode: string;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly commands: EdgeCommandPublisher,
    private readonly reservations: ProvisioningReservationService,
  ) {}

  /** Delivers a receipt the agent has not yet reported handed to root. */
  async deliverActivationReceipt(device: ReceiptHolder): Promise<boolean> {
    if (
      device.agentChannel !== EdgeAgentChannel.SUDERRA_OS ||
      device.activationReceipt === null ||
      device.activationReceiptHandedAt !== null
    ) {
      return false;
    }
    const commandId = randomUUID();
    const timeout = setTimeout(
      () => this.pendingReceipts.delete(commandId),
      HANDOFF_ACK_TIMEOUT_MS,
    );
    timeout.unref();
    this.pendingReceipts.set(commandId, {
      tenantId: device.tenantId,
      deviceId: device.id,
      deviceCode: device.deviceCode,
      timeout,
    });
    try {
      await this.commands.publish(
        { tenantId: device.tenantId, deviceId: device.id },
        {
          commandId,
          command: 'activation_receipt',
          params: { statement: device.activationReceipt },
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      this.pendingReceipts.delete(commandId);
      throw error;
    }
    return true;
  }

  /**
   * Settles a receipt hand-over from the agent's command response. Returns
   * true when the response answered one. Only the device the receipt went to
   * can answer it: a response under another device's topic settles nothing.
   */
  async handleResponse(
    responder: HandoffResponder,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const commandId = payload['commandId'];
    if (typeof commandId !== 'string') return false;
    const pending = this.pendingReceipts.get(commandId);
    if (pending === undefined) return false;
    const sameDevice =
      responder.deviceCode === pending.deviceId || responder.deviceCode === pending.deviceCode;
    if (
      !sameDevice ||
      (responder.tenantId !== undefined && responder.tenantId !== pending.tenantId)
    ) {
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingReceipts.delete(commandId);
    const result = payload['result'];
    const handed =
      payload['success'] === true &&
      typeof result === 'object' &&
      result !== null &&
      (result as Record<string, unknown>)['handed_to_root'] === true;
    if (handed) {
      await this.reservations.markReceiptHanded(
        { id: pending.deviceId, tenantId: pending.tenantId },
        new Date(),
      );
      this.logger.log({ event: 'activation_receipt_handed', deviceId: pending.deviceId });
    } else {
      this.logger.warn({
        event: 'activation_receipt_refused_by_agent',
        deviceId: pending.deviceId,
        error: typeof payload['error'] === 'string' ? payload['error'] : null,
      });
    }
    return true;
  }

  /** Hands a device-lifecycle statement to the agent for root (DEC-5.14). */
  async requestLifecycle(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    statement: SignedStatement<typeof STATEMENT.deviceLifecycle>,
  ): Promise<void> {
    await this.commands.publish(
      { tenantId: device.tenantId, deviceId: device.id },
      {
        commandId: randomUUID(),
        command: 'lifecycle_request',
        params: { statement: JSON.stringify(statement.envelope) },
      },
    );
  }
}
