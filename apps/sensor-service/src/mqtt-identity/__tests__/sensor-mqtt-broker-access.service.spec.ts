import { collaborator } from '@aquaculture/testing';

import { SensorRegistrationStatus } from '../../database/entities/sensor.entity';
import { SensorMqttBrokerAccess } from '../sensor-mqtt-broker-access.service';
import type {
  SensorMqttIdentityService,
  SensorMqttPrincipal,
} from '../sensor-mqtt-identity.service';
import { sensorMqttDataTopic } from '../sensor-mqtt-topic';

/**
 * What the broker lets a sensor's own principal do (ADR-047 §1, §3): CONNECT
 * under its username as client ID with its secret while it is not suspended,
 * then PUBLISH to its own data topic and nothing else.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';
const SENSOR = 'f0b8b1a6-df19-42de-ba9a-8523c949ea65';
const OTHER_SENSOR = 'a1b2c3d4-0000-4000-8000-000000000001';
const USERNAME = `s${'q'.repeat(22)}`;
const SECRET = 'the-issued-secret';

function access(status: SensorRegistrationStatus | null): {
  access: SensorMqttBrokerAccess;
  findPrincipal: jest.Mock;
} {
  const principal: SensorMqttPrincipal | null =
    status === null
      ? null
      : {
          username: USERNAME,
          tenantId: TENANT,
          sensorId: SENSOR,
          registrationStatus: status,
          secret: { hmac: 'h', kid: 'k' },
        };
  const findPrincipal = jest.fn().mockResolvedValue(principal);
  const verifySecret = jest.fn(
    (_principal: SensorMqttPrincipal, presented: string) => presented === SECRET,
  );
  return {
    access: new SensorMqttBrokerAccess(
      collaborator<SensorMqttIdentityService>(
        { findPrincipal, verifySecret },
        'SensorMqttIdentityService',
      ),
    ),
    findPrincipal,
  };
}

describe('SensorMqttBrokerAccess', () => {
  describe('CONNECT', () => {
    it.each([
      SensorRegistrationStatus.DRAFT,
      SensorRegistrationStatus.TEST_FAILED,
      SensorRegistrationStatus.ACTIVE,
    ])('admits a %s sensor under its username with its secret', async (status) => {
      await expect(
        access(status).access.connectDenial(USERNAME, SECRET, USERNAME),
      ).resolves.toBeNull();
    });

    it('refuses another client ID before reading anything', async () => {
      const { access: subject, findPrincipal } = access(SensorRegistrationStatus.ACTIVE);
      await expect(subject.connectDenial(USERNAME, SECRET, `${USERNAME}x`)).resolves.toBe(
        'client_id_mismatch',
      );
      await expect(subject.connectDenial(USERNAME, SECRET, undefined)).resolves.toBe(
        'client_id_mismatch',
      );
      expect(findPrincipal).not.toHaveBeenCalled();
    });

    it('refuses an unknown principal, a suspended sensor and a wrong secret', async () => {
      await expect(access(null).access.connectDenial(USERNAME, SECRET, USERNAME)).resolves.toBe(
        'principal_not_found',
      );
      await expect(
        access(SensorRegistrationStatus.SUSPENDED).access.connectDenial(USERNAME, SECRET, USERNAME),
      ).resolves.toBe('suspended');
      await expect(
        access(SensorRegistrationStatus.ACTIVE).access.connectDenial(USERNAME, 'wrong', USERNAME),
      ).resolves.toBe('secret_mismatch');
    });
  });

  describe('topic access', () => {
    const own = sensorMqttDataTopic(TENANT, SENSOR);

    it('grants PUBLISH to its own data topic', async () => {
      await expect(
        access(SensorRegistrationStatus.DRAFT).access.mayAccess(USERNAME, own, 2),
      ).resolves.toBe(true);
    });

    it.each([1, 3, 4, 5])('grants nothing else on its own topic (acc=%d)', async (acc) => {
      await expect(
        access(SensorRegistrationStatus.ACTIVE).access.mayAccess(USERNAME, own, acc),
      ).resolves.toBe(false);
    });

    it.each([
      sensorMqttDataTopic(TENANT, OTHER_SENSOR),
      sensorMqttDataTopic(OTHER_TENANT, SENSOR),
      'tenants/+/sensors/+/data',
      `tenants/${TENANT}/sensors/${SENSOR}/status`,
      `tenants/${TENANT}/devices/${SENSOR}/telemetry`,
      'sensors/farm-01/water-quality',
      'test/anything',
    ])('refuses PUBLISH to %s', async (topic) => {
      await expect(
        access(SensorRegistrationStatus.ACTIVE).access.mayAccess(USERNAME, topic, 2),
      ).resolves.toBe(false);
    });

    it('refuses a suspended or vanished principal on its own topic', async () => {
      await expect(
        access(SensorRegistrationStatus.SUSPENDED).access.mayAccess(USERNAME, own, 2),
      ).resolves.toBe(false);
      await expect(access(null).access.mayAccess(USERNAME, own, 2)).resolves.toBe(false);
    });
  });
});
