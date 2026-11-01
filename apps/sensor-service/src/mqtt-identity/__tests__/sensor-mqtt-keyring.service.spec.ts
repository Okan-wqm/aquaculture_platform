import { collaborator } from '@aquaculture/testing';
import type { ConfigService } from '@nestjs/config';

import { SensorMqttKeyringService } from '../sensor-mqtt-keyring.service';

/**
 * Production does not start without the keyring the deploy bootstrap writes;
 * elsewhere a missing keyring closes issuing and verifying; a malformed one
 * stops the service everywhere (ADR-047 §1).
 */

function service(env: Record<string, string | undefined>): SensorMqttKeyringService {
  // Untyped so it stands in for ConfigService's generic get<T>.
  const get = jest.fn();
  get.mockImplementation((key: string) => env[key]);
  return new SensorMqttKeyringService(collaborator<ConfigService>({ get }, 'ConfigService'));
}

const KEYRING = JSON.stringify([{ kid: 'k-1', secret: 'cd'.repeat(32), status: 'active' }]);

describe('SensorMqttKeyringService', () => {
  it('loads the keyring', () => {
    const keyring = service({ MQTT_SENSOR_SECRET_KEYRING: KEYRING, NODE_ENV: 'production' });
    keyring.onModuleInit();
    expect(keyring.current()?.active.kid).toBe('k-1');
  });

  it('refuses to start in production without one', () => {
    expect(() => service({ NODE_ENV: 'production' }).onModuleInit()).toThrow(
      /MQTT_SENSOR_SECRET_KEYRING is required in production/,
    );
  });

  it('starts closed elsewhere without one', () => {
    const keyring = service({ NODE_ENV: 'development' });
    keyring.onModuleInit();
    expect(keyring.current()).toBeNull();
  });

  it('refuses to start with a malformed one', () => {
    expect(() =>
      service({ MQTT_SENSOR_SECRET_KEYRING: '[]', NODE_ENV: 'development' }).onModuleInit(),
    ).toThrow(/exactly one active/);
  });
});
