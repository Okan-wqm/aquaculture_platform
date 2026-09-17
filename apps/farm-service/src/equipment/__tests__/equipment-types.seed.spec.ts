/**
 * Ekipman ↔ alt-ekipman kataloğunun tek-yazarlı olduğunun kanıtı.
 *
 * WHY these tests exist: the sub-equipment catalogue used to declare its own
 * `compatibleEquipmentTypes` list, which drifted from the live equipment
 * catalogue ('fish-tank' / 'auto-feeder' / 'water-pump' against
 * 'tank-circular' / 'feeder-automatic' / 'pump-centrifugal'). Nothing noticed,
 * because the constant was imported by no file and the tier was never seeded —
 * the first operator to try would have been rejected on every pairing. The
 * relation now has exactly one author (the equipment side) and these tests pin
 * that it stays that way.
 */
import {
  EQUIPMENT_TYPES_SEED,
  SUB_EQUIPMENT_TYPES_SEED,
  buildSubEquipmentTypeSeed,
  type SubEquipmentTypeDeclaration,
} from '../seeds/equipment-types.seed';

describe('equipment ↔ sub-equipment catalogue', () => {
  it('derives every compatibility entry from the live equipment catalogue', () => {
    const liveCodes = new Set(EQUIPMENT_TYPES_SEED.map((type) => type.code));

    for (const subType of SUB_EQUIPMENT_TYPES_SEED) {
      expect(subType.compatibleEquipmentTypes.length).toBeGreaterThan(0);
      for (const code of subType.compatibleEquipmentTypes) {
        expect(liveCodes.has(code)).toBe(true);
      }
    }
  });

  it('makes the two directions of the relation agree row by row', () => {
    for (const equipmentType of EQUIPMENT_TYPES_SEED) {
      for (const subCode of equipmentType.allowedSubEquipmentTypes) {
        const subType = SUB_EQUIPMENT_TYPES_SEED.find((candidate) => candidate.code === subCode);
        expect(subType).toBeDefined();
        expect(subType?.compatibleEquipmentTypes).toContain(equipmentType.code);
      }
    }
  });

  it('carries the codes an operator actually meets, not the drifted ones', () => {
    const feedDropPoint = SUB_EQUIPMENT_TYPES_SEED.find(
      (subType) => subType.code === 'feed-drop-point',
    );
    expect(feedDropPoint).toBeDefined();
    expect(feedDropPoint?.compatibleEquipmentTypes).toContain('tank-circular');
    expect(feedDropPoint?.compatibleEquipmentTypes).toContain('cage-floating');
    // The drifted codes were never real equipment types.
    expect(feedDropPoint?.compatibleEquipmentTypes).not.toContain('fish-tank');

    const hopper = SUB_EQUIPMENT_TYPES_SEED.find((subType) => subType.code === 'hopper');
    expect(hopper?.compatibleEquipmentTypes).toContain('feeder-automatic');
    expect(hopper?.compatibleEquipmentTypes).not.toContain('auto-feeder');
  });

  it('leaves no sub-equipment type named "feeder" — a feeder is an Equipment row', () => {
    // Part of the identity decision: the dosing machine is an Equipment row of
    // category FEEDING. Keeping a SUB-equipment type called "feeder" is what
    // made "SubEquipment feeder ID" look plausible in the first place.
    expect(SUB_EQUIPMENT_TYPES_SEED.some((subType) => subType.code === 'feeder')).toBe(false);
    expect(EQUIPMENT_TYPES_SEED.some((type) => type.code === 'feeder-automatic')).toBe(true);
  });

  it('refuses a sub-equipment code that no equipment type accepts', () => {
    const orphan: SubEquipmentTypeDeclaration = {
      name: 'Orphan Part',
      code: 'orphan-part',
      description: 'no equipment type lists this',
      specificationSchema: { fields: [] },
    };

    expect(() =>
      buildSubEquipmentTypeSeed(EQUIPMENT_TYPES_SEED, [...SUB_EQUIPMENT_TYPES_SEED, orphan]),
    ).toThrow(/orphan-part/);
  });

  it('refuses an equipment type that accepts an undeclared sub-equipment code', () => {
    // Drop one declaration and the relation stops being total; the builder must
    // say so rather than seed a slot nothing can fill.
    const withoutHopper = SUB_EQUIPMENT_TYPES_SEED.filter((subType) => subType.code !== 'hopper');

    expect(() => buildSubEquipmentTypeSeed(EQUIPMENT_TYPES_SEED, withoutHopper)).toThrow(/hopper/);
  });

  it('refuses a duplicated sub-equipment code', () => {
    const duplicated = [...SUB_EQUIPMENT_TYPES_SEED, SUB_EQUIPMENT_TYPES_SEED[0]!];

    expect(() => buildSubEquipmentTypeSeed(EQUIPMENT_TYPES_SEED, duplicated)).toThrow(
      /declared twice/,
    );
  });
});
