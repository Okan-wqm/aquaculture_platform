/**
 * EdgeCommandPublisher — the single command publish path (ADR-048 DEC-9.2;
 * SENSOR-HIGH-206). The device row, not the caller, decides the wire form:
 * a Suderra OS agent gets a signed platform-actor envelope or nothing, a
 * generic-Linux agent the legacy CommandMessage.
 */
import { BadRequestException } from '@nestjs/common';

import { collaborator } from '@aquaculture/testing';

import { type MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import {
  type CommandEnvelopeSignerService,
  CommandParamsEncodingError,
  type SignedCommandEnvelope,
} from '../command-envelope-signer.service';
import { type DeviceDirectoryService } from '../device-directory.service';
import {
  EdgeCommandPublisher,
  EdgeCommandRefusedError,
  edgeCommandTopic,
} from '../edge-command-publisher.service';
import { EdgeAgentChannel, EdgeDevice } from '../entities/edge-device.entity';

const TENANT = '7e570000-0000-4000-8000-000000000001';
const OTHER_TENANT = '7e570000-0000-4000-8000-000000000002';
const OS_DEVICE = '7e570000-0000-4000-8000-0000000000d1';
const LINUX_DEVICE = '7e570000-0000-4000-8000-0000000000d2';
const COMMAND = {
  commandId: '7e570000-0000-4000-8000-0000000000e1',
  command: 'reboot',
  params: { reason: 'operator request' },
};

const ENVELOPE: SignedCommandEnvelope = {
  cmd: 'reboot',
  params: { reason: 'operator request' },
  actor: [],
  tenant_id: [],
  iat_unix_secs: 1,
  exp_unix_secs: 2,
  claimed_policy_version: 1,
  jti: COMMAND.commandId,
  nonce: 'n',
  cmd_hash: [],
  signature: [],
  co_approver_actor: null,
  co_approver_signature: null,
};

function device(id: string, channel: EdgeAgentChannel): EdgeDevice {
  return Object.assign(new EdgeDevice(), { id, tenantId: TENANT, agentChannel: channel });
}

function harness(
  options: { mqtt?: 'connected' | 'disconnected' | 'absent'; signerEnabled?: boolean } = {},
): {
  publisher: EdgeCommandPublisher;
  publish: jest.Mock;
  findDevice: jest.Mock;
  signPlatformCommand: jest.Mock;
} {
  const publish = jest.fn(async (): Promise<void> => undefined);
  const findDevice = jest.fn(
    async (_column: string, value: string): Promise<EdgeDevice | null> =>
      value === OS_DEVICE
        ? device(OS_DEVICE, EdgeAgentChannel.SUDERRA_OS)
        : value === LINUX_DEVICE
          ? device(LINUX_DEVICE, EdgeAgentChannel.GENERIC_LINUX)
          : null,
  );
  const signPlatformCommand = jest.fn((): SignedCommandEnvelope => ENVELOPE);
  const state = options.mqtt ?? 'connected';
  const mqtt =
    state === 'absent'
      ? null
      : collaborator<MqttClientService>(
          { publish, isConnectedToBroker: () => state === 'connected' },
          'MqttClientService',
        );
  const publisher = new EdgeCommandPublisher(
    mqtt,
    collaborator<DeviceDirectoryService>({ findDevice }, 'DeviceDirectoryService'),
    collaborator<CommandEnvelopeSignerService>(
      { enabled: options.signerEnabled ?? true, signPlatformCommand },
      'CommandEnvelopeSignerService',
    ),
  );
  return { publisher, publish, findDevice, signPlatformCommand };
}

describe('EdgeCommandPublisher (ADR-048 DEC-9.2)', () => {
  it('signs a platform-actor envelope for a Suderra OS device, under the command id as jti', async () => {
    const { publisher, publish, signPlatformCommand } = harness();
    await publisher.publish({ tenantId: TENANT, deviceId: OS_DEVICE }, COMMAND);
    expect(signPlatformCommand).toHaveBeenCalledWith({
      cmd: 'reboot',
      params: { reason: 'operator request' },
      tenantId: TENANT,
      jti: COMMAND.commandId,
    });
    expect(publish).toHaveBeenCalledWith(
      `tenants/${TENANT}/devices/${OS_DEVICE}/commands`,
      ENVELOPE,
    );
  });

  it('keeps the legacy CommandMessage for a generic-Linux device (DEC-28 P2)', async () => {
    const { publisher, publish, signPlatformCommand } = harness();
    await publisher.publish({ tenantId: TENANT, deviceId: LINUX_DEVICE }, COMMAND);
    expect(signPlatformCommand).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(`tenants/${TENANT}/devices/${LINUX_DEVICE}/commands`, {
      commandId: COMMAND.commandId,
      command: 'reboot',
      params: { reason: 'operator request' },
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('publishes nothing to a Suderra OS device when this deployment holds no command key', async () => {
    const { publisher, publish, signPlatformCommand } = harness({ signerEnabled: false });
    await expect(
      publisher.publish({ tenantId: TENANT, deviceId: OS_DEVICE }, COMMAND),
    ).rejects.toThrow(EdgeCommandRefusedError);
    expect(signPlatformCommand).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses params the agent cannot canonicalize as a request error, publishing nothing', async () => {
    const { publisher, publish, signPlatformCommand } = harness();
    signPlatformCommand.mockImplementationOnce(() => {
      throw new CommandParamsEncodingError('Nested objects are not supported (key: meta)');
    });
    const refused = publisher.publish(
      { tenantId: TENANT, deviceId: OS_DEVICE },
      { ...COMMAND, params: { meta: { a: 1 } } },
    );
    await expect(refused).rejects.toThrow(EdgeCommandRefusedError);
    await expect(refused).rejects.toMatchObject({ status: 400 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a device of another tenant and an unknown device', async () => {
    const { publisher, publish } = harness();
    await expect(
      publisher.publish({ tenantId: OTHER_TENANT, deviceId: OS_DEVICE }, COMMAND),
    ).rejects.toThrow(EdgeCommandRefusedError);
    await expect(
      publisher.publish(
        { tenantId: TENANT, deviceId: '7e570000-0000-4000-8000-0000000000ff' },
        COMMAND,
      ),
    ).rejects.toThrow(EdgeCommandRefusedError);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses identifiers that would widen or redirect the topic before any lookup', async () => {
    const { publisher, publish, findDevice } = harness();
    for (const target of [
      { tenantId: '+', deviceId: OS_DEVICE },
      { tenantId: TENANT, deviceId: '#' },
      { tenantId: TENANT, deviceId: `${OS_DEVICE}/commands/x` },
      { tenantId: '', deviceId: OS_DEVICE },
    ]) {
      await expect(publisher.publish(target, COMMAND)).rejects.toThrow(EdgeCommandRefusedError);
    }
    expect(findDevice).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(() => edgeCommandTopic({ tenantId: TENANT, deviceId: OS_DEVICE })).not.toThrow();
  });

  it('refuses without a broker connection and reports availability', async () => {
    for (const mqtt of ['absent', 'disconnected'] as const) {
      const { publisher, findDevice } = harness({ mqtt });
      expect(publisher.isAvailable()).toBe(false);
      expect(() => publisher.assertAvailable()).toThrow(BadRequestException);
      await expect(
        publisher.publish({ tenantId: TENANT, deviceId: OS_DEVICE }, COMMAND),
      ).rejects.toThrow(BadRequestException);
      expect(findDevice).not.toHaveBeenCalled();
    }
    expect(harness().publisher.isAvailable()).toBe(true);
  });
});
