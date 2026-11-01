import { collaborator } from '@aquaculture/testing';

import { Sensor } from '../../database/entities/sensor.entity';
import { RelocateSensorInput } from '../dto/register-sensor.dto';
import { RegistrationResolver } from '../resolvers/registration.resolver';
import type { SensorPlacementService } from '../services/sensor-placement.service';
import type { SensorRegistrationService } from '../services/sensor-registration.service';

/**
 * relocateSensor hands the move to SensorPlacementService with the caller as
 * the actor its audit row names (SENSOR-MEDIUM-206), and answers with the
 * sensor as it now stands. No @AuditedOperation: sensor-service records the
 * move in sensor_audit_logs inside the move's own transaction.
 */
describe('RegistrationResolver.relocateSensor', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const relocate = jest.fn();
  const resolver = new RegistrationResolver(
    collaborator<SensorRegistrationService>({}, 'SensorRegistrationService'),
    collaborator<SensorPlacementService>({ relocate }, 'SensorPlacementService'),
  );

  it('moves the sensor as the calling user and answers with where it now stands', async () => {
    relocate.mockResolvedValue(
      Object.assign(new Sensor(), {
        id: 'sensor-1',
        name: 'Probe',
        tenantId: TENANT,
        siteId: 'site-1',
        tankId: 'tank-3',
        protocolConfiguration: {},
      }),
    );
    const input = Object.assign(new RelocateSensorInput(), {
      sensorId: 'sensor-1',
      siteId: 'site-1',
      departmentId: 'dept-1',
      unitId: 'tank-3',
    });

    const moved = await resolver.relocateSensor(input, TENANT, {
      sub: 'operator-1',
      email: 'operator@example.test',
      tenantId: TENANT,
      roles: ['TENANT_ADMIN'],
    });

    expect(relocate).toHaveBeenCalledWith(
      TENANT,
      'sensor-1',
      { siteId: 'site-1', departmentId: 'dept-1', systemId: null, unitId: 'tank-3' },
      'operator-1',
    );
    expect(moved).toMatchObject({ id: 'sensor-1', siteId: 'site-1', tankId: 'tank-3' });
  });
});
