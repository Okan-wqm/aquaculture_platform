import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { MeasurementSource } from '../../entities/water-quality-measurement.entity';
import { CreateBatchWaterQualityInput } from '../create-batch-water-quality.input';

/**
 * FARM-MEDIUM-368 — the batch input carries the same machine-provenance gate
 * as the single create (create-water-quality.source.spec.ts). BulkRecordTab is
 * a human entry path; a sensor_auto / sensor_trigger batch made hand-entered
 * values look machine-produced to the trend rules, the action_watch rule
 * engine and drift checks. Machine sources come only from the sensor ingest
 * path.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';

function inputWith(source: MeasurementSource): CreateBatchWaterQualityInput {
  return plainToInstance(CreateBatchWaterQualityInput, {
    measuredAt: new Date().toISOString(),
    source,
    measurements: [{ equipmentId: UUID, dynamicParameters: { ph: 7.2 }, idempotencyKey: KEY }],
  });
}

async function sourceErrors(source: MeasurementSource): Promise<ValidationError[]> {
  const errors = await validate(inputWith(source));
  return errors.filter((e) => e.property === 'source');
}

describe('CreateBatchWaterQualityInput.source — machine provenance pinned out', () => {
  it.each([
    MeasurementSource.MANUAL,
    MeasurementSource.LAB_ANALYSIS,
    MeasurementSource.CALIBRATION,
  ])('accepts the human-enterable source %s', async (source) => {
    expect(await sourceErrors(source)).toHaveLength(0);
  });

  it.each([MeasurementSource.SENSOR_AUTOMATIC, MeasurementSource.SENSOR_TRIGGERED])(
    'rejects the machine source %s at the trust boundary',
    async (source) => {
      const errors = await sourceErrors(source);
      expect(errors).toHaveLength(1);
      const first = errors[0];
      if (!first) throw new Error('expected a source error');
      expect(first.constraints).toHaveProperty('isHumanMeasurementSource');
    },
  );

  it('validates the whole batch input clean for a human source', async () => {
    expect(await validate(inputWith(MeasurementSource.MANUAL))).toHaveLength(0);
  });
});
