/**
 * WaterQualityValidationService Unit Tests
 *
 * Focuses on the phase 6.5 strict-mode gate and the legacy
 * pass-through behaviour it replaces. Uses hand-rolled doubles for
 * ParameterConfigCacheService and WaterQualityParamEquipment
 * repository — no DB, no NestJS test module.
 */
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { WaterQualityValidationService } from '../water-quality-validation.service';
import { ParameterConfigCacheService } from '../parameter-config-cache.service';
import { WaterQualityParamEquipment } from '../../entities/water-quality-param-equipment.entity';
import {
  WaterQualityParameterConfig,
  ParameterDataType,
} from '../../entities/water-quality-parameter-config.entity';

class StubConfigService {
  constructor(private readonly values: Record<string, string> = {}) {}
  get<T = string>(key: string): T | undefined {
    const raw = this.values[key];
    return raw === undefined ? undefined : (raw as unknown as T);
  }
}

interface CacheDouble {
  getActiveConfigs: jest.Mock;
}

interface MappingRepoDouble {
  find: jest.Mock;
}

function makeService(opts: {
  configs?: Partial<WaterQualityParameterConfig>[];
  env?: Record<string, string>;
}): {
  service: WaterQualityValidationService;
  cache: CacheDouble;
  mappingRepo: MappingRepoDouble;
} {
  const cache: CacheDouble = {
    getActiveConfigs: jest.fn().mockResolvedValue(opts.configs ?? []),
  };
  const mappingRepo: MappingRepoDouble = {
    find: jest.fn().mockResolvedValue([]),
  };
  const service = new WaterQualityValidationService(
    cache as unknown as ParameterConfigCacheService,
    mappingRepo as unknown as Repository<WaterQualityParamEquipment>,
    new StubConfigService(opts.env ?? {}) as unknown as ConfigService,
  );
  return { service, cache, mappingRepo };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('WaterQualityValidationService strict mode', () => {
  it('rejects submission when strict mode is on and tenant has no configs', async () => {
    const { service } = makeService({ configs: [] });
    const result = await service.validate(TENANT, { pH: 7.2 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      field: '__tenant__',
      code: 'NO_ACTIVE_PARAMETER_CONFIGS',
    });
  });

  it('passes when strict mode is on but the submission is empty', async () => {
    const { service } = makeService({ configs: [] });
    const result = await service.validate(TENANT, {});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('falls back to legacy pass-through when WQ_STRICT_VALIDATION=false', async () => {
    const { service } = makeService({
      configs: [],
      env: { WQ_STRICT_VALIDATION: 'false' },
    });
    const result = await service.validate(TENANT, { pH: 7.2 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts common truthy / falsy env spellings for the switch', async () => {
    const cases: Array<[string, boolean]> = [
      ['true', false], // strict ON → invalid
      ['1', false],
      ['yes', false],
      ['on', false],
      ['false', true], // strict OFF → valid (legacy)
      ['0', true],
      ['no', true],
      ['OFF', true],
    ];
    for (const [raw, expectedValid] of cases) {
      const { service } = makeService({
        configs: [],
        env: { WQ_STRICT_VALIDATION: raw },
      });
      const result = await service.validate(TENANT, { pH: 7.2 });
      expect(result.valid).toBe(expectedValid);
    }
  });

  it('ignores strict mode when tenant HAS configs — downstream validators run', async () => {
    const { service } = makeService({
      configs: [
        {
          code: 'pH',
          name: 'pH',
          dataType: ParameterDataType.NUMBER,
          isRequired: false,
        } as Partial<WaterQualityParameterConfig>,
      ],
    });
    const result = await service.validate(TENANT, { pH: 7.2 });
    expect(result.valid).toBe(true);
  });

  it('strict mode gate does not cover tenants that carry at least one config', async () => {
    // Even if a typo is submitted, strict mode's gate is about
    // ZERO configs; once a single config exists the UNKNOWN_PARAMETER
    // branch runs and produces per-field errors instead.
    const { service } = makeService({
      configs: [
        {
          code: 'pH',
          name: 'pH',
          dataType: ParameterDataType.NUMBER,
          isRequired: false,
        } as Partial<WaterQualityParameterConfig>,
      ],
    });
    const result = await service.validate(TENANT, { temeprature: 14 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      field: 'temeprature',
      code: 'UNKNOWN_PARAMETER',
    });
  });
});
