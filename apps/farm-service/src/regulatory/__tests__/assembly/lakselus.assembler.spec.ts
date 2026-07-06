/**
 * LakselusReportAssembler — temperature from the ONE WaterTemperatureService
 * path with sensor/manual provenance; lice counts always blocking
 * MANUAL_REQUIRED until the Phase-2 lice_counts entity exists.
 */
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { LakselusReportAssembler } from '../../assembly/assemblers/lakselus.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(
  reading: Awaited<ReturnType<WaterTemperatureService['getSiteCurrentTemperature']>>,
): LakselusReportAssembler {
  const service: Pick<WaterTemperatureService, 'getSiteCurrentTemperature'> = {
    getSiteCurrentTemperature: jest.fn().mockResolvedValue(reading),
  };
  return new LakselusReportAssembler(service as WaterTemperatureService);
}

describe('LakselusReportAssembler', () => {
  it('uses the site sensor reading with SENSOR provenance (id + timestamp)', async () => {
    const measuredAt = new Date('2026-07-05T06:00:00Z');
    const assembler = makeAssembler({
      celsius: 12.4,
      source: 'sensor',
      measuredAt,
      sensorId: 'sensor-7',
    });

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.sjøtemperatur).toBe(12.4);
    const meta = fields.find((f) => f.path === '/sjøtemperatur');
    expect(meta).toMatchObject({
      provenance: ReportFieldProvenance.SENSOR,
      sensorId: 'sensor-7',
      measuredAt,
      blocking: false,
    });
  });

  it('uses a manual measurement with RECORDS provenance', async () => {
    const assembler = makeAssembler({
      celsius: 11.0,
      source: 'manual',
      measuredAt: new Date('2026-07-04T10:00:00Z'),
    });

    const { fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(fields.find((f) => f.path === '/sjøtemperatur')?.provenance).toBe(
      ReportFieldProvenance.RECORDS,
    );
  });

  it('blocks on missing temperature AND always blocks on lice counts (no guessing)', async () => {
    const assembler = makeAssembler(null);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 27);

    expect(draftPayload.sjøtemperatur).toBeNull();
    const temperature = fields.find((f) => f.path === '/sjøtemperatur');
    expect(temperature?.provenance).toBe(ReportFieldProvenance.MANUAL_REQUIRED);
    expect(temperature?.blocking).toBe(true);

    const counting = fields.find((f) => f.path === '/lusetelling');
    expect(counting?.blocking).toBe(true);
    expect(draftPayload.lusetelling).toEqual({
      voksneHunnlus: 0,
      bevegeligeLus: 0,
      fastsittendeLus: 0,
    });
  });
});
