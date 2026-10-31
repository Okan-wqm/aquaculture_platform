import { collaborator } from '@aquaculture/testing';

import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { RegistrationResolver } from '../resolvers/registration.resolver';
import type { SensorPlacementService } from '../services/sensor-placement.service';
import type { SensorRegistrationService } from '../services/sensor-registration.service';

/**
 * `sensor(id)` is this resolver's read model alone; the raw-entity copy in
 * SensorResolver is gone. The column transformer decrypts protocol
 * credentials on read (SENSOR-MEDIUM-080), so this is where they are masked
 * (SENSOR-HIGH-081, SEC-HIGH-096), and it carries the ADR-047 fields the
 * device page reads.
 */
describe('RegistrationResolver.getSensor', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const getSensor = jest.fn();
  const resolver = new RegistrationResolver(
    collaborator<SensorRegistrationService>({ getSensor }, 'SensorRegistrationService'),
    collaborator<SensorPlacementService>({}, 'SensorPlacementService'),
  );

  const stored = (protocolCode: string, extra: Partial<Sensor> = {}): Sensor =>
    Object.assign(new Sensor(), {
      id: 'sensor-1',
      name: 'Probe',
      tenantId: TENANT,
      protocol: Object.assign(new SensorProtocol(), { code: protocolCode }),
      protocolConfiguration: {
        host: 'mqtt.internal',
        topic: 'tenants/1/telemetry',
        password: 'hunter2',
        apiKey: 'sk-live-123',
        auth: { clientId: 'a', clientSecret: 'topsecret' },
      },
      ...extra,
    });

  beforeEach(() => getSensor.mockReset());

  it('masks secret-named protocol fields and keeps the rest', async () => {
    getSensor.mockResolvedValue(stored('MODBUS_TCP'));

    const sensor = await resolver.getSensor('sensor-1', TENANT);

    expect(getSensor).toHaveBeenCalledWith('sensor-1', TENANT);
    expect(sensor?.protocolConfiguration).toEqual({
      host: 'mqtt.internal',
      topic: 'tenants/1/telemetry',
      password: '***',
      apiKey: '***',
      auth: { clientId: 'a', clientSecret: '***' },
    });
  });

  it('says a platform-broker sensor is activated by its data and names its broker username', async () => {
    getSensor.mockResolvedValue(stored('MQTT', { mqttUsername: 'sabcdefghijklmnopqrstuv' }));

    const sensor = await resolver.getSensor('sensor-1', TENANT);

    expect(sensor).toMatchObject({
      activatedByData: true,
      mqttUsername: 'sabcdefghijklmnopqrstuv',
    });
  });

  it('says a sensor the platform connects to is not activated by its data', async () => {
    getSensor.mockResolvedValue(stored('MODBUS_TCP'));

    const sensor = await resolver.getSensor('sensor-1', TENANT);

    expect(sensor).toMatchObject({ activatedByData: false, mqttUsername: null });
  });

  it('answers null for a sensor the tenant does not have', async () => {
    getSensor.mockResolvedValue(null);

    await expect(resolver.getSensor('missing', TENANT)).resolves.toBeNull();
  });
});
