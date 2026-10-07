import {
  CHANNEL_KEYS,
  channelKeyMeaning,
  channelKeyUnit,
  effectiveQuantity,
  isAcceptedUnit,
  MEASURED_QUANTITIES,
  measuredQuantity,
  parseQuantityId,
  QUANTITY_FAMILIES,
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
    for (const members of Object.values(QUANTITY_FAMILIES)) {
      const units = new Set(members.map((id) => measuredQuantity(id).unit));
      expect(units.size).toBe(1);
    }
  });

  it('keys channels in lower case only, since lookups lowercase', () => {
    for (const key of Object.keys(CHANNEL_KEYS)) {
      expect(key).toBe(key.toLowerCase());
    }
    expect(channelKeyMeaning('DO')).toEqual({
      quantity: 'dissolvedOxygen',
      readingParameter: 'dissolvedOxygen',
    });
    expect(channelKeyMeaning('constructor')).toBeUndefined();
    expect(channelKeyUnit('flux_capacitor')).toBeUndefined();
  });

  it('separates the bases a probe can report hydrogen sulfide and ammonia on', () => {
    expect(channelKeyUnit('h2s')).toBe('µg/L');
    expect(channelKeyMeaning('total_sulfide')?.quantity).toBe('totalSulfide');
    expect(channelKeyMeaning('tan')?.quantity).toBe('tan');
    expect(channelKeyMeaning('nh4')?.quantity).toBe('nh4');
    // `ammonia` and `nh3` say neither which ammonia nor which basis.
    expect(channelKeyMeaning('ammonia')?.family).toBe('ammonia');
    expect(channelKeyMeaning('nh3')?.family).toBe('ammonia');
    expect(channelKeyUnit('nh3')).toBe('mg/L');
  });

  describe('effectiveQuantity', () => {
    it('reads the quantity a key names when nothing was declared', () => {
      expect(effectiveQuantity('pH')).toBe('ph');
      expect(effectiveQuantity('water_temp', null)).toBe('temperature');
    });

    it('has no quantity for a family key until its member is declared', () => {
      expect(effectiveQuantity('ammonia')).toBeNull();
      expect(effectiveQuantity('nh3', 'tan')).toBe('tan');
      expect(effectiveQuantity('nh3', 'nh3')).toBe('nh3');
    });

    it('refuses a declaration that contradicts what the key names', () => {
      expect(effectiveQuantity('ammonia', 'salinity')).toBeNull();
      expect(effectiveQuantity('ph', 'temperature')).toBeNull();
      expect(effectiveQuantity('ph', 'ph')).toBe('ph');
    });

    it('takes a declaration for a key outside the vocabulary', () => {
      expect(effectiveQuantity('probe_7_ch2', 'h2s')).toBe('h2s');
      expect(effectiveQuantity('probe_7_ch2')).toBeNull();
    });
  });

  it('parses a quantity id from untrusted input', () => {
    expect(parseQuantityId('tan')).toBe('tan');
    expect(parseQuantityId('TAN')).toBeNull();
    expect(parseQuantityId(42)).toBeNull();
  });
});
