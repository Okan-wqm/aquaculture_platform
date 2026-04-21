/**
 * Drift-class registry — single source of truth for validator ↔ primitive parity.
 * ============================================================================
 *
 * Every drift class the platform checks has:
 *   1. A stable ID (used in logs, events, CI invariants)
 *   2. A severity tier (error / warn)
 *   3. The migration primitive that resolves it (Phase 3 shipping)
 *   4. A human-readable description
 *
 * The registry is the ONLY place these mappings live. `SchemaDriftValidator`
 * iterates it to decide what to check; migration primitives reference it in
 * their JSDoc; CI invariant `drift-class-parity.spec.ts` (Phase 2) asserts
 * every class ID has a matching detector AND a matching primitive.
 *
 * # Why a registry instead of scattered constants
 *
 * v2's 4 classes drifted between validator + primitives + docs — the classic
 * "add a check, forget to add the primitive that fixes it" failure mode. The
 * registry fails the build if parity breaks.
 *
 * # Classes
 *
 * | ID | Class                        | Primitive (Phase 3)              |
 * |----|------------------------------|----------------------------------|
 * | A  | schema_location              | pinSearchPath                    |
 * | B  | uuid_type                    | alignColumnType (uuid path)      |
 * | C  | nullability                  | alignColumnNullability           |
 * | D  | missing_column               | addMissingColumns                |
 * | E  | orphan_column                | dropOrphanedColumns (allowlist)  |
 * | F  | enum_labels                  | alignEnumLabels                  |
 * | G  | check_constraint             | alignCheckConstraints            |
 * | H  | data_cast_incompatible       | Phase 3.5 backfill + re-encode   |
 * | I  | per_tenant_shape_divergence  | Phase 6 per-tenant heals         |
 * | J  | encrypted_column_protection  | (refusal — no primitive; ADR-023)|
 *
 * Plan v3 §R11 + R15 are the authoritative specs for F / G / I / J.
 */

/**
 * Stable identifier for each drift class. Used as an event/log
 * discriminator and as the key across the validator, primitive, and CI
 * invariant layers. Never renumber — adding a new class appends an ID
 * to this literal union; removing a class requires a deprecation
 * migration that leaves the ID in place for historical event lookup.
 */
export type DriftClassId =
  | 'schema_location'
  | 'uuid_type'
  | 'nullability'
  | 'missing_column'
  | 'orphan_column'
  | 'enum_labels'
  | 'check_constraint'
  | 'data_cast_incompatible'
  | 'per_tenant_shape_divergence'
  | 'encrypted_column_protection';

export type DriftSeverity = 'error' | 'warn';

export interface DriftClassSpec {
  /** Stable ID — append-only; never renumber. */
  readonly id: DriftClassId;
  /**
   * Single-letter label (A-J) used in plan v3 cross-references. Kept
   * as a string to leave room for "AA", "AB" etc. if we ever exceed 26.
   */
  readonly label: string;
  /**
   * 'error' halts validator "Schema drift scan clean" emission.
   * 'warn' emits clean-with-warnings (Phase 8 decides final policy).
   * Default across v2 classes is 'error'; some Phase 2 additions may
   * opt to 'warn' during a rollout window.
   */
  readonly severity: DriftSeverity;
  /**
   * Migration primitive name that resolves this class. Referenced by
   * primitive JSDoc headers; CI invariant `drift-class-parity.spec.ts`
   * asserts the primitive is actually exported from
   * `@aquaculture/backend-common`.
   *
   * `null` means the class has no primitive (e.g. J — encrypted-column
   * is "refusal with remediation runbook", not a migration primitive).
   */
  readonly primitive: string | null;
  /** Short human description for failure messages + docs. */
  readonly description: string;
  /** Plan v3 revision ID that introduced or last touched this class. */
  readonly planRef: string;
}

export const DRIFT_CLASSES: Readonly<Record<DriftClassId, DriftClassSpec>> =
  Object.freeze({
    schema_location: {
      id: 'schema_location',
      label: 'A',
      severity: 'error',
      primitive: 'pinSearchPath',
      description:
        'Entity declares schema=S but the physical table lives in a different schema.',
      planRef: 'v2-original',
    },
    uuid_type: {
      id: 'uuid_type',
      label: 'B',
      severity: 'error',
      primitive: 'alignColumnType',
      description:
        'Entity column is typed uuid but the DB column data_type is not uuid.',
      planRef: 'v2-original',
    },
    nullability: {
      id: 'nullability',
      label: 'C',
      severity: 'error',
      primitive: 'alignColumnNullability',
      description:
        'Entity column is nullable:false but the DB column is_nullable=YES.',
      planRef: 'v2-original',
    },
    missing_column: {
      id: 'missing_column',
      label: 'D',
      severity: 'error',
      primitive: 'addMissingColumns',
      description:
        'Entity declares a column the DB does not have.',
      planRef: 'v2-original',
    },
    orphan_column: {
      id: 'orphan_column',
      label: 'E',
      severity: 'warn',
      primitive: 'dropOrphanedColumns',
      description:
        'DB has a column the entity does not declare. Warn-level — allowlist-gated drop because silent data loss class.',
      planRef: 'v3-R11',
    },
    enum_labels: {
      id: 'enum_labels',
      label: 'F',
      severity: 'error',
      primitive: 'alignEnumLabels',
      description:
        'Entity enum values differ from DB pg_enum labels (additive drift is auto-fix; removal requires explicit remap).',
      planRef: 'v3-R11',
    },
    check_constraint: {
      id: 'check_constraint',
      label: 'G',
      severity: 'error',
      primitive: 'alignCheckConstraints',
      description:
        'Entity @Check() decorator declares a constraint the DB lacks (or vice versa).',
      planRef: 'v3-R11',
    },
    data_cast_incompatible: {
      id: 'data_cast_incompatible',
      label: 'H',
      severity: 'error',
      primitive: null,
      description:
        'Entity type change requires a data migration (e.g. text → int on non-numeric rows). No primitive; Phase 3.5 backfill path.',
      planRef: 'v3-R11-multi-tenant',
    },
    per_tenant_shape_divergence: {
      id: 'per_tenant_shape_divergence',
      label: 'I',
      severity: 'error',
      primitive: null,
      description:
        'Two tenant_* schemas have diverging shapes for the same entity-declared table. Phase 6 heals per-tenant.',
      planRef: 'v3-R11-multi-tenant',
    },
    encrypted_column_protection: {
      id: 'encrypted_column_protection',
      label: 'J',
      severity: 'error',
      primitive: null,
      description:
        'Column decorated @EncryptedAtRest must have DB type bytea AND must NOT be altered by schema primitives. Refusal class — no primitive; remediation is a separate key-rotation runbook.',
      planRef: 'v3-R15-ADR-023',
    },
  });

/** Array view — stable order matching DriftClassId literal union order. */
export const DRIFT_CLASS_LIST: readonly DriftClassSpec[] = Object.freeze(
  Object.values(DRIFT_CLASSES),
);

/** Type guard for runtime validation of untrusted input. */
export function isDriftClassId(x: unknown): x is DriftClassId {
  return typeof x === 'string' && x in DRIFT_CLASSES;
}
