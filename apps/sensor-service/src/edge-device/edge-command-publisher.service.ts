import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

import {
  CommandEnvelopeSignerService,
  CommandParamsEncodingError,
  type SignedCommandEnvelope,
} from './command-envelope-signer.service';
import { DeviceDirectoryService } from './device-directory.service';
import { EdgeAgentChannel } from './entities/edge-device.entity';

/**
 * The one component that publishes to an edge device's command topic
 * (ADR-048 DEC-9.2). `tests/invariants/edge-command-publish-chokepoint.spec.ts`
 * fails the build when anything else writes `…/commands`.
 *
 * The device, not the caller, decides the wire form: the publisher reads the
 * device's channel from its own row. A Suderra OS agent accepts only signed
 * command envelopes (DEC-9.1, Enforcing compiled in), so it gets a
 * platform-actor envelope from CommandEnvelopeSignerService, or — when this
 * deployment has no signer — no command at all. A generic-Linux agent keeps
 * the legacy unsigned CommandMessage until its fleet moves to signed
 * commands (DEC-28 P2, SENSOR-CRITICAL-201).
 */

export interface EdgeCommand {
  /** Correlation id: the agent reports the result under it (the envelope's jti). */
  readonly commandId: string;
  readonly command: string;
  readonly params: Record<string, unknown>;
}

export interface EdgeCommandTarget {
  readonly tenantId: string;
  /** The edge device's UUID: the agent subscribes to tenants/{tenant}/devices/{id}/commands. */
  readonly deviceId: string;
}

/** A command that is not published, and why. Nothing reached the broker. */
export class EdgeCommandRefusedError extends BadRequestException {
  constructor(reason: string) {
    super(`Edge command not published: ${reason}`);
  }
}

/** One MQTT topic level: no wildcard (+, #), no separator (/), nothing else odd. */
const TOPIC_LEVEL = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The command topic of one device. Neither identifier can contain an MQTT
 * wildcard or a level separator, so no caller can widen or redirect the topic
 * (the SENSOR-LOW-235 class, cloud side).
 */
export function edgeCommandTopic(target: EdgeCommandTarget): string {
  if (!TOPIC_LEVEL.test(target.tenantId) || !TOPIC_LEVEL.test(target.deviceId)) {
    throw new EdgeCommandRefusedError('tenant and device must be single topic levels');
  }
  return `tenants/${target.tenantId}/devices/${target.deviceId}/commands`;
}

@Injectable()
export class EdgeCommandPublisher {
  private readonly logger = new Logger(EdgeCommandPublisher.name);

  constructor(
    // @Global SharedMqttModule provides it; a boot without MQTT refuses at
    // publish time instead of failing module construction.
    @Optional()
    @Inject(MqttClientService)
    private readonly mqtt: MqttClientService | null,
    private readonly devices: DeviceDirectoryService,
    private readonly signer: CommandEnvelopeSignerService,
  ) {}

  /** True when a command could reach the broker now. */
  isAvailable(): boolean {
    return this.mqtt !== null && this.mqtt.isConnectedToBroker();
  }

  /** Throws unless a command could reach the broker now. */
  assertAvailable(): MqttClientService {
    if (this.mqtt === null) {
      throw new BadRequestException('MQTT service not available');
    }
    if (!this.mqtt.isConnectedToBroker()) {
      throw new BadRequestException('Not connected to MQTT broker');
    }
    return this.mqtt;
  }

  async publish(target: EdgeCommandTarget, command: EdgeCommand): Promise<void> {
    const topic = edgeCommandTopic(target);
    const mqtt = this.assertAvailable();
    const device = await this.devices.findDevice('id', target.deviceId);
    if (device === null || device.tenantId !== target.tenantId) {
      throw new EdgeCommandRefusedError('the device is not a device of this tenant');
    }
    const signed = device.agentChannel === EdgeAgentChannel.SUDERRA_OS;
    if (signed && !this.signer.enabled) {
      throw new EdgeCommandRefusedError(
        'the device accepts only signed commands and this deployment holds no command key',
      );
    }
    const payload = signed
      ? this.signedEnvelope(command, device.tenantId)
      : {
          commandId: command.commandId,
          command: command.command,
          params: command.params,
          timestamp: new Date().toISOString(),
        };
    await mqtt.publish(topic, payload);
    this.logger.debug({
      event: 'edge_command_published',
      deviceId: device.id,
      command: command.command,
      commandId: command.commandId,
      signed,
    });
  }

  /**
   * The platform-actor envelope for a Suderra OS device. Parameters the
   * agent would canonicalize differently (a nested object, a number it
   * writes in another form) are the caller's request error, refused before
   * anything is signed — never a server error.
   */
  private signedEnvelope(command: EdgeCommand, tenantId: string): SignedCommandEnvelope {
    try {
      return this.signer.signPlatformCommand({
        cmd: command.command,
        params: command.params,
        tenantId,
        jti: command.commandId,
      });
    } catch (error) {
      if (error instanceof CommandParamsEncodingError) {
        throw new EdgeCommandRefusedError(error.message);
      }
      throw error;
    }
  }
}
