import {
  CHANNEL_KEYS,
  channelKeyMeaning,
  channelKeyUnit,
  declarableQuantities,
  effectiveQuantity,
  isAcceptedUnit,
  MEASURED_QUANTITIES,
  measuredQuantity,
  parseQuantityId,
  QUANTITY_FAMILIES,
  readingParameterOfChannelKey,
  toCanonicalUnit,
  unitConversion,
} from '../measurement/quantities';

/**
 * Ids persisted in sensor_data_channels.declared_quantity and the declaration
 * ledger. Append-only: renaming or removing one would turn stored
 * declarations into "none".
 */
const PERSISTED_QUANTITY_IDS = [
  'temperature',
  'ph',
  'dissolvedOxygen',
  'oxygenSaturation',
  'salinity',
  'conductivity',
  'specificConductance',
  'tan',
  'nh3',
  'nh4',
  'nh4Ion',
  'nitriteN',
  'nitriteIon',
  'nitrateN',
  'nitrateIon',
  'h2s',
  'totalSulfide',
  'totalSulfideAsS',
  'alkalinity',
  'calcium',
  'hardness',
  'co2',
  'turbidity',
  'waterLevel',
  'flowRate',
  'pressure',
  'barometricPressure',
  'orp',
  'tds',
  'chlorine',
  'chloride',
  'ozone',
  'humidity',
  'batteryLevel',
  'signalStrength',
];

describe('measured-quantity registry', () => {
  it('names each quantity once, and accepts its own canonical unit', () => {
    const ids = MEASURED_QUANTITIES.map((quantity) => quantity.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const quantity of MEASURED_QUANTITIES) {
      expect(isAcceptedUnit(quantity.id, quantity.unit)).toBe(true);
    }
  });

  it('gives every member of a family one unit, so one key can name the family', () => {
    for (const { members } of Object.values(QUANTITY_FAMILIES)) {
      const units = new Set(members.map((id) => measuredQuantity(id).unit));
      expect(units.size).toBe(1);
    }
  });

  it('keys channels in lower case only, since lookups lowercase', () => {
    for (const key of Object.keys(CHANNEL_KEYS)) {
      expect(key).toBe(key.toLowerCase());
    }
    expect(channelKeyMeaning('DO')?.quantity).toBe('dissolvedOxygen');
    expect(channelKeyMeaning('constructor')).toBeUndefined();
    expect(channelKeyUnit('flux_capacitor')).toBeUndefined();
  });

  it('says which basis a key leaves open', () => {
    expect(channelKeyUnit('h2s')).toBe('µg/L');
    expect(channelKeyMeaning('tan')?.quantity).toBe('tan');
    // `ammonia`/`nh3` and `nitrite`/`nitrate` say neither which form nor basis.
    for (const key of ['ammonia', 'nh3', 'nitrite', 'no2', 'nitrate', 'no3']) {
      expect(channelKeyMeaning(key)?.family).toBeDefined();
      expect(effectiveQuantity(key)).toBeNull();
    }
    expect(channelKeyUnit('nh3')).toBe('mg/L');
  });

  it('lands each key on the reading parameter of its quantity or family', () => {
    expect(readingParameterOfChannelKey('o2')).toBe('dissolvedOxygen');
    expect(readingParameterOfChannelKey('nh3')).toBe('ammonia');
    expect(readingParameterOfChannelKey('no2')).toBe('nitrite');
    // Quantities the event has no field for land nowhere.
    expect(readingParameterOfChannelKey('tan')).toBeUndefined();
    expect(readingParameterOfChannelKey('oxygen_saturation')).toBeUndefined();
    expect(readingParameterOfChannelKey('__proto__')).toBeUndefined();
  });

  describe('effectiveQuantity', () => {
    it('reads the quantity a key names when nothing was declared', () => {
      expect(effectiveQuantity('pH')).toBe('ph');
      expect(effectiveQuantity('water_temp', null)).toBe('temperature');
    });

    it('takes a declared family member', () => {
      expect(effectiveQuantity('nh3', 'tan')).toBe('tan');
      expect(effectiveQuantity('nitrite', 'nitriteN')).toBe('nitriteN');
    });

    it('takes a declared alternate the key is known to carry', () => {
      expect(effectiveQuantity('ec', 'specificConductance')).toBe('specificConductance');
      expect(effectiveQuantity('sulfide', 'totalSulfideAsS')).toBe('totalSulfideAsS');
      expect(effectiveQuantity('pressure', 'barometricPressure')).toBe('barometricPressure');
      expect(effectiveQuantity('cl', 'chloride')).toBe('chloride');
      expect(effectiveQuantity('nh4', 'nh4Ion')).toBe('nh4Ion');
    });

    it('refuses a declaration the key does not allow', () => {
      expect(effectiveQuantity('ammonia', 'salinity')).toBeNull();
      expect(effectiveQuantity('ph', 'temperature')).toBeNull();
      expect(effectiveQuantity('chlorine', 'chloride')).toBeNull();
      // % saturation would be published as mg/L dissolved oxygen by key.
      expect(effectiveQuantity('do', 'oxygenSaturation')).toBeNull();
      expect(effectiveQuantity('ph', 'ph')).toBe('ph');
    });

    it('takes any declaration for a key outside the vocabulary', () => {
      expect(effectiveQuantity('probe_7_ch2', 'h2s')).toBe('h2s');
      expect(effectiveQuantity('probe_7_ch2')).toBeNull();
      expect(declarableQuantities('probe_7_ch2')).toHaveLength(MEASURED_QUANTITIES.length);
    });
  });

  it('accepts the pH scale label the water-chemistry pages show as a pH unit', () => {
    expect(isAcceptedUnit('ph', 'NBS')).toBe(true);
  });

  it('keeps every persisted quantity id, each short enough for its column', () => {
    const ids: string[] = MEASURED_QUANTITIES.map((quantity) => quantity.id);
    expect(ids.slice(0, PERSISTED_QUANTITY_IDS.length)).toEqual(PERSISTED_QUANTITY_IDS);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(32);
    }
  });

  it('declares an alternate only where it lands on the key’s own reading parameter', () => {
    // The flat event projects by key; a declaration must not move a value onto
    // a parameter it is not (until the event carries the quantity).
    for (const key of Object.keys(CHANNEL_KEYS)) {
      const meaning = channelKeyMeaning(key);
      if (meaning?.quantity === undefined) continue;
      const own = measuredQuantity(meaning.quantity);
      for (const alternate of meaning.alternates ?? []) {
        const other = measuredQuantity(alternate);
        expect({
          key,
          alternate,
          field: 'readingParameter' in other ? other.readingParameter : undefined,
        }).toEqual({
          key,
          alternate,
          field: 'readingParameter' in own ? own.readingParameter : undefined,
        });
      }
    }
  });

  it('converts a device unit to the canonical unit', () => {
    expect(toCanonicalUnit('temperature', '°F', 212)).toBeCloseTo(100, 10);
    expect(toCanonicalUnit('temperature', 'K', 273.15)).toBeCloseTo(0, 10);
    expect(toCanonicalUnit('conductivity', 'mS/cm', 52)).toBe(52_000);
    expect(toCanonicalUnit('waterLevel', 'm', 1.25)).toBe(125);
    expect(toCanonicalUnit('h2s', 'mg/L', 0.015)).toBeCloseTo(15, 10);
    expect(toCanonicalUnit('ph', 'NBS', 7.9)).toBe(7.9);
    expect(toCanonicalUnit('waterLevel', '%', 40)).toBeNull();
    expect(unitConversion('salinity', 'ppt')).toEqual({ unit: 'ppt', factor: 1 });
  });

  it('parses a quantity id from untrusted input', () => {
    expect(parseQuantityId('tan')).toBe('tan');
    expect(parseQuantityId('TAN')).toBeNull();
    expect(parseQuantityId(42)).toBeNull();
  });
});
