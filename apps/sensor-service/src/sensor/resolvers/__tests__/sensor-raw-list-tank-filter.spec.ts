/**
 * sensorRawList tankId filter (MOB-MEDIUM-008).
 *
 * AquaMobil's tank screens are keyed by the FARM container UUID
 * (farmStockInventory → container.containerId), and sensors are registered
 * against that same UUID in `sensor.tank_id` (indexed column). The mobile
 * live-readings surface therefore joins at the RESOLVER level —
 * `sensorRawList(tankId: <containerId>)` — instead of a client-side heuristic
 * over the free-form pondId field. This spec pins that filter (and its
 * tenant scoping) so the mobile join cannot silently regress.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorReading } from '../../../database/entities/sensor-reading.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { SensorIngestionService } from '../../services/sensor-ingestion.service';
import { SensorQueryService } from '../../services/sensor-query.service';
import { SensorResolver } from '../sensor.resolver';

describe('SensorResolver.listSensors tankId filter (MOB-MEDIUM-008)', () => {
  let resolver: SensorResolver;
  let sensorRepository: jest.Mocked<Repository<Sensor>>;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const tankId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorResolver,
        {
          provide: getRepositoryToken(Sensor),
          useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(SensorReading), useValue: {} },
        { provide: SensorIngestionService, useValue: {} },
        { provide: SensorQueryService, useValue: {} },
      ],
    }).compile();

    resolver = module.get(SensorResolver);
    sensorRepository = module.get(getRepositoryToken(Sensor));
  });

  it('applies the tankId filter alongside the tenant scope', async () => {
    await resolver.listSensors(tenantId, 1, 20, undefined, undefined, tankId);

    expect(sensorRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, tankId },
      }),
    );
  });

  it('omits the tankId clause when the arg is absent (existing behaviour intact)', async () => {
    await resolver.listSensors(tenantId, 1, 20);

    const call = sensorRepository.find.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ tenantId });
  });

  // ==========================================================================
  // SEC-HIGH-096 (2026-08-23 scan №41): decrypted protocol credentials must
  // never leave the raw-entity read paths unmasked.
  // ==========================================================================

  const sensorWithCreds = (): Sensor => {
    const sensor = new Sensor();
    sensor.id = 's1';
    sensor.tenantId = tenantId;
    sensor.protocolConfiguration = {
      host: 'mqtt.internal',
      topic: 'tenants/1/telemetry',
      password: 'hunter2',
      apiKey: 'sk-live-123',
      auth: { clientId: 'a', clientSecret: 'topsecret' },
    };
    return sensor;
  };

  it('sensorRawList masks secret-named protocol fields, keeps non-secrets', async () => {
    sensorRepository.find.mockResolvedValue([sensorWithCreds()]);

    const results = await resolver.listSensors(tenantId, 1, 20);
    const result = results[0];
    if (!result) throw new Error('expected one sensor row');

    expect(result.protocolConfiguration).toMatchObject({
      host: 'mqtt.internal',
      topic: 'tenants/1/telemetry',
      password: '***',
      apiKey: '***',
      auth: { clientId: 'a', clientSecret: '***' },
    });
  });

  it('getSensor masks secret-named protocol fields', async () => {
    sensorRepository.findOne.mockResolvedValue(sensorWithCreds());

    const result = await resolver.getSensor('s1', tenantId);

    expect(result.protocolConfiguration?.['password']).toBe('***');
    expect(result.protocolConfiguration?.['host']).toBe('mqtt.internal');
  });

  it('resolveReference NEVER takes tenantId from the representation (context only)', async () => {
    sensorRepository.findOne.mockResolvedValue(sensorWithCreds());

    // No user context: must fail closed to null even though the
    // representation offers a tenantId.
    const result = await resolver.resolveReference(
      { __typename: 'Sensor', id: 's1', tenantId },
      {},
    );

    expect(result).toBeNull();
    expect(sensorRepository.findOne).not.toHaveBeenCalled();
  });
});
