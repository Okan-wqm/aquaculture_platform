import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MeasurementSource } from '../../entities/water-quality-measurement.entity';
import { CreateWaterQualityInput } from '../create-water-quality.input';

/**
 * FARM-AI v3 (Sprint 2.3) — SENSOR_AUTOMATIC spoof guard.
 *
 * The create-water-quality GraphQL input is the HUMAN entry path. A client
 * (user or AI-driven) submitting source: sensor_auto / sensor_trigger makes
 * hand-entered data look machine-produced — downstream consumers that treat
 * machine sources differently (trend rules, the action_watch rule engine,
 * drift checks) would silently trust spoofed readings. Machine provenance is
 * set by the sensor ingestion path server-side, never accepted from input.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

function inputWith(source: MeasurementSource): CreateWaterQualityInput {
  return plainToInstance(CreateWaterQualityInput, {
    tankId: UUID,
    measuredAt: new Date().toISOString(),
    source,
    equipmentId: UUID,
    dynamicParameters: { ph: 7.2 },
  });
}

async function sourceErrors(source: MeasurementSource) {
  const errors = await validate(inputWith(source));
  return errors.filter((e) => e.property === 'source');
}

describe('CreateWaterQualityInput.source — machine provenance pinned out (FARM-AI 2.3)', () => {
  it.each([MeasurementSource.MANUAL, MeasurementSource.LAB_ANALYSIS, MeasurementSource.CALIBRATION])(
    'accepts the human-enterable source %s',
    async (source) => {
      expect(await sourceErrors(source)).toHaveLength(0);
    },
  );

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

  it('the rejection message says WHO may set machine provenance', async () => {
    const errors = await sourceErrors(MeasurementSource.SENSOR_AUTOMATIC);
    const first = errors[0];
    if (!first) throw new Error('expected a source error');
    expect(first.constraints?.isHumanMeasurementSource).toContain('machine provenance');
  });
});
