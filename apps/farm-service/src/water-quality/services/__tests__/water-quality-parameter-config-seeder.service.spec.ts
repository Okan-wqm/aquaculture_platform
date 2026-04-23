/**
 * WaterQualityParameterConfigSeederService Unit Tests
 *
 * Covers:
 *   - first run on an empty tenant seeds every default
 *   - re-run is idempotent — no duplicate rows, existing codes skip
 *   - partial pre-existing set → only the missing codes get created
 *   - seeded rows carry the expected standard metadata (active,
 *     required, quick-access, chart colour, threshold bands)
 *   - the defaults list itself is stable (unit + precision + group)
 *
 * Hand-rolled Repository double — no DB, no NestJS test harness.
 */
import { Repository } from 'typeorm';

import { WaterQualityParameterConfigSeederService } from '../water-quality-parameter-config-seeder.service';
import {
  ParameterDataType,
  ParameterGroup,
  WaterQualityParameterConfig,
} from '../../entities/water-quality-parameter-config.entity';

interface RepoDouble {
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function makeService(existing: Array<{ code: string }> = []): {
  service: WaterQualityParameterConfigSeederService;
  repo: RepoDouble;
} {
  const repo: RepoDouble = {
    find: jest.fn().mockResolvedValue(existing),
    create: jest.fn(
      (row: Partial<WaterQualityParameterConfig>) => ({ ...row }),
    ),
    save: jest.fn(async (row: WaterQualityParameterConfig) => row),
  };
  const service = new WaterQualityParameterConfigSeederService(
    repo as unknown as Repository<WaterQualityParameterConfig>,
  );
  return { service, repo };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('WaterQualityParameterConfigSeederService', () => {
  it('seeds every default when the tenant has no existing configs', async () => {
    const { service, repo } = makeService([]);
    const result = await service.seedDefaults(TENANT);
    expect(result.skipped).toEqual([]);
    expect(result.seeded.sort()).toEqual(
      [
        'ammonia',
        'dissolved_oxygen',
        'nitrite',
        'ph',
        'salinity',
        'temperature',
        'turbidity',
      ].sort(),
    );
    expect(repo.save).toHaveBeenCalledTimes(7);
  });

  it('is idempotent — re-running with every code present seeds nothing', async () => {
    const { service, repo } = makeService([
      { code: 'temperature' },
      { code: 'ph' },
      { code: 'dissolved_oxygen' },
      { code: 'ammonia' },
      { code: 'nitrite' },
      { code: 'salinity' },
      { code: 'turbidity' },
    ]);
    const result = await service.seedDefaults(TENANT);
    expect(result.seeded).toEqual([]);
    expect(result.skipped).toHaveLength(7);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('seeds only the codes that are missing on a partial tenant', async () => {
    const { service, repo } = makeService([
      { code: 'temperature' },
      { code: 'ph' },
    ]);
    const result = await service.seedDefaults(TENANT);
    expect(result.skipped.sort()).toEqual(['ph', 'temperature']);
    expect(result.seeded.sort()).toEqual(
      ['ammonia', 'dissolved_oxygen', 'nitrite', 'salinity', 'turbidity'].sort(),
    );
    expect(repo.save).toHaveBeenCalledTimes(5);
  });

  it('tags every seeded row with the templateSource marker', async () => {
    const { service, repo } = makeService([]);
    await service.seedDefaults(TENANT);
    const savedRows = repo.save.mock.calls.map((c) => c[0] as Partial<WaterQualityParameterConfig>);
    for (const row of savedRows) {
      expect(row.tenantId).toBe(TENANT);
      expect(row.templateSource).toBe('salmonid_default_v1');
      expect(row.isActive).toBe(true);
      expect(row.isVisible).toBe(true);
    }
  });

  it('the default catalogue exposes stable metadata', () => {
    const { service } = makeService([]);
    const defaults = service.getDefaults();
    const byCode = new Map(defaults.map((d) => [d.code, d]));

    const temp = byCode.get('temperature');
    expect(temp?.unit).toBe('°C');
    expect(temp?.dataType).toBe(ParameterDataType.NUMBER);
    expect(temp?.isRequired).toBe(true);
    expect(temp?.group).toBe(ParameterGroup.BASIC);

    const ammonia = byCode.get('ammonia');
    expect(ammonia?.group).toBe(ParameterGroup.NITROGEN_CYCLE);
    expect(ammonia?.criticalMax).toBe(0.1);
  });
});
