import {
  newSensorMqttSecret,
  newSensorMqttUsername,
  parseSensorSecretKeyring,
  SENSOR_MQTT_USERNAME_PATTERN,
  sensorSecretHmac,
  verifySensorSecret,
} from '../sensor-mqtt-secret';
import { parseSensorMqttDataTopic, sensorMqttDataTopic } from '../sensor-mqtt-topic';

/**
 * The credential a sensor's own broker principal is issued (ADR-047 §1): the
 * username's shape, the secret's strength, the keyring's rules and the HMAC
 * check the broker's CONNECT runs.
 */

const PEPPER_A = 'a1'.repeat(32);
const PEPPER_B = 'b2'.repeat(32);

function keyring(entries: unknown[]): string {
  return JSON.stringify(entries);
}

describe('sensor MQTT credential', () => {
  it('issues usernames of the shape the broker and the database check', () => {
    const issued = new Set(Array.from({ length: 200 }, () => newSensorMqttUsername()));
    expect(issued.size).toBe(200);
    for (const username of issued) {
      expect(username).toMatch(SENSOR_MQTT_USERNAME_PATTERN);
      expect(username).toHaveLength(23);
    }
  });

  it('issues 256-bit secrets as unpadded base64url', () => {
    const secret = newSensorMqttSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
  });

  it('verifies a secret under the pepper its row names, and only that secret', () => {
    const ring = parseSensorSecretKeyring(
      keyring([
        { kid: 'k1', secret: PEPPER_A, status: 'previous' },
        { kid: 'k2', secret: PEPPER_B, status: 'active' },
      ]),
    );
    expect(ring.active.kid).toBe('k2');

    const secret = newSensorMqttSecret();
    const underOld = { hmac: sensorSecretHmac(ring.byKid.get('k1')!, secret), kid: 'k1' };
    const underNew = { hmac: sensorSecretHmac(ring.active, secret), kid: 'k2' };
    expect(verifySensorSecret(ring, underOld, secret)).toBe(true);
    expect(verifySensorSecret(ring, underNew, secret)).toBe(true);
    expect(verifySensorSecret(ring, underNew, newSensorMqttSecret())).toBe(false);
    // The HMAC of one pepper does not verify under another.
    expect(verifySensorSecret(ring, { hmac: underOld.hmac, kid: 'k2' }, secret)).toBe(false);
  });

  it('stops verifying a credential whose pepper was disabled or removed', () => {
    const before = parseSensorSecretKeyring(keyring([{ kid: 'k1', secret: PEPPER_A }]));
    const secret = newSensorMqttSecret();
    const stored = { hmac: sensorSecretHmac(before.active, secret), kid: 'k1' };

    const disabled = parseSensorSecretKeyring(
      keyring([
        { kid: 'k1', secret: PEPPER_A, status: 'disabled' },
        { kid: 'k2', secret: PEPPER_B, status: 'active' },
      ]),
    );
    expect(verifySensorSecret(disabled, stored, secret)).toBe(false);
    const removed = parseSensorSecretKeyring(keyring([{ kid: 'k2', secret: PEPPER_B }]));
    expect(verifySensorSecret(removed, stored, secret)).toBe(false);
  });

  it.each([
    ['not JSON', '{', /must be JSON/],
    ['not an array', '{"kid":"k1"}', /JSON array/],
    [
      'no active key',
      keyring([{ kid: 'k1', secret: PEPPER_A, status: 'previous' }]),
      /exactly one active/,
    ],
    [
      'two active keys',
      keyring([
        { kid: 'k1', secret: PEPPER_A },
        { kid: 'k2', secret: PEPPER_B },
      ]),
      /exactly one active/,
    ],
    [
      'a kid twice',
      keyring([
        { kid: 'k1', secret: PEPPER_A },
        { kid: 'k1', secret: PEPPER_B, status: 'previous' },
      ]),
      /twice/,
    ],
    ['a short secret', keyring([{ kid: 'k1', secret: 'ab'.repeat(16) }]), /64 hex/],
    ['a kid the column cannot hold', keyring([{ kid: 'k'.repeat(65), secret: PEPPER_A }]), /kid/],
    ['an unknown status', keyring([{ kid: 'k1', secret: PEPPER_A, status: 'old' }]), /status/],
  ])('refuses a keyring with %s', (_case, raw, message) => {
    expect(() => parseSensorSecretKeyring(raw)).toThrow(message);
  });
});

describe('sensor MQTT data topic', () => {
  const tenantId = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
  const sensorId = 'f0b8b1a6-df19-42de-ba9a-8523c949ea65';

  it('names the tenant and the sensor, and reads them back', () => {
    const topic = sensorMqttDataTopic(tenantId, sensorId);
    expect(topic).toBe(`tenants/${tenantId}/sensors/${sensorId}/data`);
    expect(parseSensorMqttDataTopic(topic)).toEqual({ tenantId, sensorId });
  });

  it.each([
    'tenants/+/sensors/+/data',
    `tenants/${tenantId}/sensors/${sensorId}/data/extra`,
    `tenants/${tenantId}/devices/${sensorId}/data`,
    `tenants/${tenantId.toUpperCase()}/sensors/${sensorId}/data`,
    'sensors/farm-01/water-quality',
  ])('is not a sensor data topic: %s', (topic) => {
    expect(parseSensorMqttDataTopic(topic)).toBeNull();
  });
});
