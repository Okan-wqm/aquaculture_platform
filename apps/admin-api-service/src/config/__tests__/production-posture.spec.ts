import {
  ADMIN_API_PRODUCTION_POSTURE,
  assertProductionPosture,
  productionPostureViolations,
} from '../production-posture';

const SOUND_PRODUCTION_ENV = {
  NODE_ENV: 'production',
  ENABLE_DEBUG_TOOLS: 'false',
  ENABLE_DB_EXPLORER_WRITES: 'false',
  ENABLE_RAW_SQL_EXPLORER: 'false',
  WALG_BACKUP_EPOCH: 'epoch-20260716-001',
};

describe('admin-api production posture', () => {
  it('accepts an environment that states every decision', () => {
    expect(productionPostureViolations(SOUND_PRODUCTION_ENV)).toEqual([]);
    expect(() => assertProductionPosture(SOUND_PRODUCTION_ENV)).not.toThrow();
  });

  it.each(ADMIN_API_PRODUCTION_POSTURE.pinnedFalse)(
    'refuses production when %s is absent — an omission is not a decision',
    (name) => {
      const env: Record<string, string | undefined> = {
        ...SOUND_PRODUCTION_ENV,
        [name]: undefined,
      };
      expect(productionPostureViolations(env)).toEqual([
        `${name} is not set; production must state ${name}=false explicitly`,
      ]);
      expect(() => assertProductionPosture(env)).toThrow(/production posture is not declared/);
    },
  );

  it.each(ADMIN_API_PRODUCTION_POSTURE.pinnedFalse)(
    'refuses production when %s is anything but the literal false',
    (name) => {
      for (const value of ['true', 'TRUE', '1', 'yes', '']) {
        const env = { ...SOUND_PRODUCTION_ENV, [name]: value };
        expect(productionPostureViolations(env)).toHaveLength(1);
        expect(() => assertProductionPosture(env)).toThrow(name);
      }
    },
  );

  it('reports every violation at once so an operator fixes the deploy in one round', () => {
    const violations = productionPostureViolations({ NODE_ENV: 'production' });
    expect(violations).toHaveLength(
      ADMIN_API_PRODUCTION_POSTURE.pinnedFalse.length +
        ADMIN_API_PRODUCTION_POSTURE.required.length,
    );
  });

  it('is a no-op outside production so local toggles keep working', () => {
    expect(() =>
      assertProductionPosture({ NODE_ENV: 'development', ENABLE_DEBUG_TOOLS: 'true' }),
    ).not.toThrow();
    expect(() => assertProductionPosture({ NODE_ENV: 'test' })).not.toThrow();
  });
});
