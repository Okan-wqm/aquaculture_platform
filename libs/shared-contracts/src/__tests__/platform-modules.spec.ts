import {
  ACTIVE_OWNER_MODULE_CODES,
  MODULE_DESCRIPTORS,
  OWNER_MODULE,
  OWNER_MODULE_CODES,
  PLATFORM_MODULE,
  PLATFORM_MODULE_CODES,
  isActiveOwnerModuleCode,
  isOwnerModuleCode,
  isPlatformModuleCode,
  type ActiveOwnerModuleCode,
  type OwnerModuleCode,
  type PlatformModuleCode,
} from '../modules/platform-modules';

/**
 * The module dictionary (RBAC-MEDIUM-023, HR-MEDIUM-064; ADR-051 §2, ADR-052 Decision 4) — the one
 * declaration of the platform's module codes. These pin the owner decisions the dictionary
 * encodes: the owner modules are farm, hr, sensor and hydroponics (D4), hydroponics is reserved
 * (D3), and alert and ai are tenant modules that own no data of their own.
 */

/** True when A and B are the same type — the type-level half of these tests. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('module dictionary (SSoT)', () => {
  it('lists every tenant module code, in the auth catalogue order', () => {
    expect(PLATFORM_MODULE_CODES).toEqual(['farm', 'hr', 'sensor', 'hydroponics', 'alert', 'ai']);
    expect(Object.values(PLATFORM_MODULE)).toEqual(PLATFORM_MODULE_CODES);
  });

  it('names the owner modules farm, hr, sensor and hydroponics (D4)', () => {
    expect(OWNER_MODULE).toEqual({
      FARM: 'farm',
      HR: 'hr',
      SENSOR: 'sensor',
      HYDROPONICS: 'hydroponics',
    });
    expect(OWNER_MODULE_CODES).toEqual(['farm', 'hr', 'sensor', 'hydroponics']);
  });

  it('describes every code once, under its own key, and derives ownership from the descriptor', () => {
    expect(Object.keys(MODULE_DESCRIPTORS)).toEqual(PLATFORM_MODULE_CODES);
    for (const code of PLATFORM_MODULE_CODES) {
      expect(MODULE_DESCRIPTORS[code].code).toBe(code);
    }
    expect(PLATFORM_MODULE_CODES.filter((code) => MODULE_DESCRIPTORS[code].owner)).toEqual(
      OWNER_MODULE_CODES,
    );
  });

  it('keeps alert and ai as tenant modules that are not owner modules (D4)', () => {
    expect(MODULE_DESCRIPTORS.alert.owner).toBe(false);
    expect(MODULE_DESCRIPTORS.ai.owner).toBe(false);
  });

  it('reserves hydroponics: an owner module whose features do not ship (D3)', () => {
    expect(MODULE_DESCRIPTORS.hydroponics).toEqual({
      code: 'hydroponics',
      owner: true,
      lifecycle: 'reserved',
    });
    expect(ACTIVE_OWNER_MODULE_CODES).toEqual(['farm', 'hr', 'sensor']);
  });

  it('is frozen at every level, so no consumer can widen it at runtime', () => {
    for (const value of [
      PLATFORM_MODULE,
      PLATFORM_MODULE_CODES,
      OWNER_MODULE,
      OWNER_MODULE_CODES,
      ACTIVE_OWNER_MODULE_CODES,
      MODULE_DESCRIPTORS,
      ...Object.values(MODULE_DESCRIPTORS),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(OWNER_MODULE, 'ALERT', 'alert')).toBe(false);
    expect(Reflect.set(MODULE_DESCRIPTORS.hydroponics, 'lifecycle', 'active')).toBe(false);
  });

  describe('type guards (values that cross a trust boundary: a claim, a stored row, a request)', () => {
    const NOT_A_CODE: readonly unknown[] = [
      'FARM',
      'Farm',
      ' farm',
      'messaging',
      '',
      'toString',
      'constructor',
      '__proto__',
      null,
      undefined,
      1,
      {},
      ['farm'],
    ];

    it('isPlatformModuleCode accepts exactly the six tenant module codes', () => {
      expect(PLATFORM_MODULE_CODES.every(isPlatformModuleCode)).toBe(true);
      expect(NOT_A_CODE.filter(isPlatformModuleCode)).toEqual([]);
    });

    it('isOwnerModuleCode drops alert, ai and unknown codes', () => {
      expect(PLATFORM_MODULE_CODES.filter(isOwnerModuleCode)).toEqual(OWNER_MODULE_CODES);
      expect(NOT_A_CODE.filter(isOwnerModuleCode)).toEqual([]);
    });

    it('isActiveOwnerModuleCode also drops the reserved hydroponics', () => {
      expect(PLATFORM_MODULE_CODES.filter(isActiveOwnerModuleCode)).toEqual(
        ACTIVE_OWNER_MODULE_CODES,
      );
      expect(NOT_A_CODE.filter(isActiveOwnerModuleCode)).toEqual([]);
    });
  });

  it('derives the code types from the dictionary (checked by the compiler)', () => {
    const platform: Equals<
      PlatformModuleCode,
      'farm' | 'hr' | 'sensor' | 'hydroponics' | 'alert' | 'ai'
    > = true;
    const owner: Equals<OwnerModuleCode, 'farm' | 'hr' | 'sensor' | 'hydroponics'> = true;
    const active: Equals<ActiveOwnerModuleCode, 'farm' | 'hr' | 'sensor'> = true;
    const hrKey: Equals<(typeof OWNER_MODULE)['HR'], 'hr'> = true;
    expect([platform, owner, active, hrKey]).toEqual([true, true, true, true]);
  });
});
