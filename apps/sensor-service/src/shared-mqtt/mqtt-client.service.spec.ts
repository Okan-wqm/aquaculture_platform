import { IPublishPacket } from 'mqtt';

import {
  DurableAckClient,
  buildMqttIngressOptions,
  installDurableAckGate,
} from './mqtt-client.service';

const PACKET: IPublishPacket = {
  cmd: 'publish',
  qos: 1,
  dup: false,
  retain: false,
  topic: 'sensors/tenant/sensor/data',
  payload: Buffer.from('{"sourceEventId":"edge:1"}'),
  messageId: 42,
};

describe('MqttClientService durable QoS1 gate', () => {
  it('requires a deployment-stable client id and persistent session', () => {
    expect(() =>
      buildMqttIngressOptions({
        clientId: '',
        username: undefined,
        password: undefined,
      }),
    ).toThrow('MQTT_CLIENT_ID');

    expect(
      buildMqttIngressOptions({
        clientId: 'aqua-sensor-ingress-primary',
        username: 'sensor-service',
        password: 'secret',
      }),
    ).toMatchObject({
      clientId: 'aqua-sensor-ingress-primary',
      clean: false,
      reconnectPeriod: 0,
      username: 'sensor-service',
      password: 'secret',
    });
  });

  it('calls mqtt.js completion exactly once and only after durable work resolves', async () => {
    let commit: (() => void) | undefined;
    const durableWork = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const client: DurableAckClient = {
      handleMessage: jest.fn(),
      end: jest.fn(),
    };
    const callback = jest.fn();
    installDurableAckGate(client, () => durableWork, jest.fn());

    client.handleMessage(PACKET, callback);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    if (commit === undefined) throw new Error('test commit resolver was not installed');
    commit();
    await durableWork;
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith();
  });

  it('withholds completion and invokes controlled redelivery when durable work fails', async () => {
    const client: DurableAckClient = {
      handleMessage: jest.fn(),
      end: jest.fn(),
    };
    const callback = jest.fn();
    const retry = jest.fn().mockResolvedValue(undefined);
    installDurableAckGate(client, () => Promise.reject(new Error('postgres unavailable')), retry);

    client.handleMessage(PACKET, callback);
    await new Promise((resolve) => setImmediate(resolve));

    expect(callback).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'postgres unavailable' }),
    );
  });
});
