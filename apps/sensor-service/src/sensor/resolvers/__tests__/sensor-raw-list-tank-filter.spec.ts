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
        { provide: getRepositoryToken(Sensor), useValue: { find: jest.fn().mockResolvedValue([]) } },
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
});
