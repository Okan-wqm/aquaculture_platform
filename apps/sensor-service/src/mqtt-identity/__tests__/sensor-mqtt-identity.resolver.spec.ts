import { collaborator } from '@aquaculture/testing';

import {
  SensorMqttCredentialsType,
  SensorMqttIdentityResolver,
} from '../sensor-mqtt-identity.resolver';
import type { SensorMqttIdentityService } from '../sensor-mqtt-identity.service';

/**
 * rotateSensorMqttCredentials issues the credential as the calling user, whom
 * the audit row names, and answers with the one copy of the password.
 */
describe('SensorMqttIdentityResolver.rotateSensorMqttCredentials', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  it('rotates as the calling user and answers with the issued credential', async () => {
    const issued = {
      sensorId: 'sensor-1',
      host: 'app.suderra.com',
      port: 8883,
      tls: true,
      clientId: `s${'a'.repeat(22)}`,
      username: `s${'a'.repeat(22)}`,
      password: 'p'.repeat(43),
      topic: `tenants/${TENANT}/sensors/sensor-1/data`,
    };
    const rotate = jest.fn().mockResolvedValue(issued);
    const resolver = new SensorMqttIdentityResolver(
      collaborator<SensorMqttIdentityService>({ rotate }, 'SensorMqttIdentityService'),
    );

    const answer = await resolver.rotateSensorMqttCredentials('sensor-1', TENANT, {
      sub: 'operator-1',
    });

    expect(rotate).toHaveBeenCalledWith(TENANT, 'sensor-1', 'operator-1');
    expect(answer).toBeInstanceOf(SensorMqttCredentialsType);
    expect(answer).toEqual(issued);
  });
});
