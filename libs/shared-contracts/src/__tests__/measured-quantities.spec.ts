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
} from '../measurement/quantities';

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
      expect(effectiveQuantity('do', 'oxygenSaturation')).toBe('oxygenSaturation');
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

  it('parses a quantity id from untrusted input', () => {
    expect(parseQuantityId('tan')).toBe('tan');
    expect(parseQuantityId('TAN')).toBeNull();
    expect(parseQuantityId(42)).toBeNull();
  });
});
