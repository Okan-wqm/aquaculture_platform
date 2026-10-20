import { collaborator } from '@aquaculture/testing';

import { type MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import { type CommandEnvelopeSignerService } from '../command-envelope-signer.service';
import { type DeviceDirectoryService } from '../device-directory.service';
import { EdgeCommandPublisher } from '../edge-command-publisher.service';
import { EdgeAgentChannel, EdgeDevice } from '../entities/edge-device.entity';

/**
 * The real EdgeCommandPublisher over a broker double, for specs of the
 * services that publish commands: every device the directory double knows is
 * a generic-Linux device of its tenant, so the broker double receives the
 * legacy CommandMessage the spec inspects ({commandId, command, params,
 * timestamp}). Signed publishing has its own spec (edge-command-publisher).
 */
/** What a spec's broker double records: every command published, by topic. */
export interface BrokerDouble {
  publish(topic: string, message: string | object): Promise<void>;
  isConnectedToBroker(): boolean;
}

export function publisherOverBroker(
  mqtt: BrokerDouble,
  devices: ReadonlyArray<{ readonly id: string; readonly tenantId: string }>,
): EdgeCommandPublisher {
  const directory = collaborator<DeviceDirectoryService>(
    {
      findDevice: async (_column: string, value: string): Promise<EdgeDevice | null> => {
        const known = devices.find((d) => d.id === value);
        return known === undefined
          ? null
          : Object.assign(new EdgeDevice(), {
              id: known.id,
              tenantId: known.tenantId,
              agentChannel: EdgeAgentChannel.GENERIC_LINUX,
            });
      },
    },
    'DeviceDirectoryService',
  );
  return new EdgeCommandPublisher(
    collaborator<MqttClientService>(
      {
        publishDeviceCommand: (topic: string, message: string | object) =>
          mqtt.publish(topic, message),
        isConnectedToBroker: () => mqtt.isConnectedToBroker(),
      },
      'MqttClientService',
    ),
    directory,
    collaborator<CommandEnvelopeSignerService>({}, 'CommandEnvelopeSignerService'),
  );
}
