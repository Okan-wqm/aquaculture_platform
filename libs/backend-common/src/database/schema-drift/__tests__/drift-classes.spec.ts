import {
  DRIFT_CLASSES,
  DRIFT_CLASS_LIST,
  type DriftClassId,
  isDriftClassId,
} from '../drift-classes';

describe('drift-classes registry', () => {
  it('every spec id matches its key (record → id parity)', () => {
    for (const [key, spec] of Object.entries(DRIFT_CLASSES)) {
      expect(spec.id).toBe(key as DriftClassId);
    }
  });

  it('every spec has a non-empty single-letter label (A-K)', () => {
    for (const spec of DRIFT_CLASS_LIST) {
      expect(spec.label).toMatch(/^[A-Z]+$/);
      expect(spec.label.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('labels are unique (no two classes share A-K)', () => {
    const labels = DRIFT_CLASS_LIST.map((s) => s.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });

  // 10 → 11: Class K (foreign_key_presence) was added to the registry by the
  // Faz 1.8 day-one baseline reset, which updated the class-K assertion below
  // but not this count. Nothing caught it because libs/backend-common had no
  // Nx project and therefore no CI test lane — this suite had never run.
  it('exactly 11 classes registered', () => {
    expect(DRIFT_CLASS_LIST).toHaveLength(11);
  });

  it('severity is "error" | "warn" only', () => {
    for (const spec of DRIFT_CLASS_LIST) {
      expect(['error', 'warn']).toContain(spec.severity);
    }
  });

  it('classes A-D (v2 baseline) all map to a real primitive name (not null)', () => {
    const baseline: DriftClassId[] = [
      'schema_location',
      'uuid_type',
      'nullability',
      'missing_column',
    ];
    for (const id of baseline) {
      expect(DRIFT_CLASSES[id].primitive).toBeTruthy();
    }
  });

  it('refusal classes (H, I, J, K) have null primitive by design', () => {
    expect(DRIFT_CLASSES.data_cast_incompatible.primitive).toBeNull();
    expect(DRIFT_CLASSES.per_tenant_shape_divergence.primitive).toBeNull();
    expect(DRIFT_CLASSES.encrypted_column_protection.primitive).toBeNull();
    // Class K — foreign_key_presence is a count-based detection class
    // (no primitive). Resolution path is Faz 6 baseline reset + reviewer
    // discipline, not a backfill primitive.
    expect(DRIFT_CLASSES.foreign_key_presence.primitive).toBeNull();
  });

  it('isDriftClassId validates known IDs', () => {
    expect(isDriftClassId('schema_location')).toBe(true);
    expect(isDriftClassId('encrypted_column_protection')).toBe(true);
  });

  it('isDriftClassId rejects unknown strings', () => {
    expect(isDriftClassId('nonsense')).toBe(false);
    expect(isDriftClassId('')).toBe(false);
    expect(isDriftClassId(null)).toBe(false);
    expect(isDriftClassId(undefined)).toBe(false);
    expect(isDriftClassId(42)).toBe(false);
  });

  it('DRIFT_CLASSES is frozen (prevent accidental mutation in tests)', () => {
    expect(Object.isFrozen(DRIFT_CLASSES)).toBe(true);
    expect(Object.isFrozen(DRIFT_CLASS_LIST)).toBe(true);
  });

  it('planRef is non-empty for every class (traceability)', () => {
    for (const spec of DRIFT_CLASS_LIST) {
      expect(spec.planRef.length).toBeGreaterThan(0);
    }
  });

  it('description is present and non-trivial (failure-message usability)', () => {
    for (const spec of DRIFT_CLASS_LIST) {
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });
});
