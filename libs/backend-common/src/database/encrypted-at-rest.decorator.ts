/**
 * @EncryptedAtRest — declarative encrypted-column marker.
 * ============================================================================
 *
 * Attaches metadata to an entity property signalling that the column stores
 * cryptographically-encrypted data (e.g. pgp_sym_encrypt ciphertext). Read
 * by `SchemaDriftValidator` (Class J) and every Phase 3 migration primitive
 * so that:
 *
 *   1. DB column MUST be bytea — enforced by Class J drift check.
 *   2. Phase 3 primitives REFUSE to emit ALTER COLUMN TYPE / DROP against
 *      decorated properties. Remediation is an explicit key-rotation
 *      runbook, never a migration.
 *   3. Class B (uuid type mismatch) is suppressed for decorated columns
 *      because the entity's declared type is the cipher's logical output,
 *      not the storage shape.
 *
 * # Usage
 *
 * ```ts
 * import { Column, Entity, PrimaryColumn } from 'typeorm';
 * import { EncryptedAtRest } from '@aquaculture/backend-common/encrypted-at-rest.decorator.ts';
 *
 * @Entity('employees', { schema: 'hr' })
 * class Employee {
 *   @PrimaryColumn({ type: 'uuid' })
 *   id!: string;
 *
 *   @Column({ name: 'national_id', type: 'bytea' })
 *   @EncryptedAtRest({
 *     keyId: 'tenant-pii-v1',
 *     algorithm: 'pgp_sym',
 *   })
 *   nationalId!: Buffer;
 * }
 * ```
 *
 * # Why a property decorator instead of a @Column option extension
 *
 * `@Column` is TypeORM's; extending it would break on TypeORM upgrades.
 * Storing the metadata under our own Reflect key keeps the contract stable
 * and independent of TypeORM's schema-builder internals.
 *
 * See `docs/adr/023-encrypted-column-schema-contract.md` for the full
 * rationale + algorithm table + remediation runbook pointer.
 */
import 'reflect-metadata';

import { ClassConstructor, isClassConstructor } from '../types/class-constructor';

/** Reflect metadata key. Exported so the validator + primitives share it. */
export const ENCRYPTED_AT_REST_META_KEY = Symbol.for(
  '@aquaculture/backend-common:encrypted-at-rest',
);

/** Cipher/algorithm identifiers the platform supports today. */
export type EncryptionAlgorithm =
  /** pgcrypto symmetric (key stored in vault/HSM, passed at query time). */
  | 'pgp_sym'
  /** pgcrypto asymmetric (public-key encrypt, private-key decrypt). */
  | 'pgp_pub'
  /** Application-side AES-256-GCM (Node `crypto.createCipheriv`). */
  | 'aes_256_gcm';

export interface EncryptedAtRestOptions {
  /**
   * Logical key identifier — recorded in audit events + key-rotation
   * runbook. Does NOT include the key material itself. Versioned so
   * rotations are tracked without schema change (`tenant-pii-v1`,
   * `tenant-pii-v2`).
   */
  readonly keyId: string;
  readonly algorithm: EncryptionAlgorithm;
  /**
   * Optional freeform note recorded with the metadata (e.g. why this
   * column is encrypted, which regulation requires it). Surfaces in
   * audit-trail-completeness reports.
   */
  readonly reason?: string;
}

/**
 * Runtime-readable shape attached under ENCRYPTED_AT_REST_META_KEY.
 * Mirrors `EncryptedAtRestOptions` plus the property key for downstream
 * introspection without needing the decorator's invocation site.
 */
export interface EncryptedAtRestMetadata extends EncryptedAtRestOptions {
  /** Property name on the entity class (NOT the DB column name). */
  readonly propertyKey: string;
}

function readEncryptedMetadata(ctor: ClassConstructor): Map<string, EncryptedAtRestMetadata> {
  const metadata: unknown = Reflect.getMetadata(ENCRYPTED_AT_REST_META_KEY, ctor);
  if (metadata === undefined) {
    return new Map<string, EncryptedAtRestMetadata>();
  }
  if (!(metadata instanceof Map)) {
    throw new TypeError('@EncryptedAtRest metadata must be stored as a Map');
  }
  return metadata as Map<string, EncryptedAtRestMetadata>;
}

/**
 * Property-level decorator. Attaches the options to the entity prototype
 * under ENCRYPTED_AT_REST_META_KEY keyed by property name.
 *
 * Multiple decorators on the same property = last-write-wins; the
 * TypeScript emit order applies. In practice this never matters because
 * a column is either encrypted or not — use the primary decorator once.
 */
export function EncryptedAtRest(opts: EncryptedAtRestOptions): PropertyDecorator {
  if (!opts.keyId || typeof opts.keyId !== 'string') {
    throw new Error(
      `@EncryptedAtRest: keyId must be a non-empty string (got ${JSON.stringify(opts.keyId)})`,
    );
  }
  const algorithmsAllowed: readonly EncryptionAlgorithm[] = ['pgp_sym', 'pgp_pub', 'aes_256_gcm'];
  if (!algorithmsAllowed.includes(opts.algorithm)) {
    throw new Error(
      `@EncryptedAtRest: algorithm '${opts.algorithm}' not in allowlist [${algorithmsAllowed.join(', ')}]`,
    );
  }
  return (target: object, propertyKey: string | symbol): void => {
    if (typeof propertyKey !== 'string') {
      throw new Error(
        `@EncryptedAtRest: property key must be a string (got ${String(propertyKey)})`,
      );
    }
    const constructor: unknown = target.constructor;
    if (!isClassConstructor(constructor)) {
      throw new TypeError('@EncryptedAtRest target must have a class constructor');
    }
    const existing = readEncryptedMetadata(constructor);
    existing.set(propertyKey, {
      ...opts,
      propertyKey,
    });
    Reflect.defineMetadata(ENCRYPTED_AT_REST_META_KEY, existing, constructor);
  };
}

/**
 * Read all @EncryptedAtRest metadata for an entity class. Returns an
 * empty Map when no property on the class is decorated — safe to call
 * unconditionally. Keyed by property name (NOT DB column name —
 * callers that need DB names should look up via EntityMetadata.columns).
 */
export function getEncryptedAtRestMetadata(
  ctor: ClassConstructor,
): ReadonlyMap<string, EncryptedAtRestMetadata> {
  return readEncryptedMetadata(ctor);
}

/**
 * Convenience: is a specific property decorated? Returns the metadata
 * when true, `undefined` when not. Primitives call this at the column
 * level before proposing DDL.
 */
export function getEncryptedAtRestForProperty(
  ctor: ClassConstructor,
  propertyKey: string,
): EncryptedAtRestMetadata | undefined {
  return getEncryptedAtRestMetadata(ctor).get(propertyKey);
}
