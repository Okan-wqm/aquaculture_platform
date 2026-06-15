import { createDecipheriv } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';

/**
 * ReEncryptSecretsCbcToGcm1801000000000
 *
 * # Why this migration exists (HIGH sentinel-cbc)
 *
 * Sentinel Hub + Maskinporten/regulatory secrets were previously encrypted with
 * a bespoke, UNAUTHENTICATED AES-256-CBC scheme inside the service layer. That
 * scheme is vulnerable to the ciphertext-malleability / padding-oracle class and
 * stored ciphertext as `<iv_hex>:<ct_hex>` (no integrity tag, no version prefix).
 *
 * The entities now carry the canonical authenticated AES-256-GCM column
 * transformer (`createEncryptedColumnTransformer`). The GCM transformer's
 * `from()` treats any value that does NOT start with the `enc:` prefix as
 * plaintext and returns it AS-IS. Legacy CBC rows have no `enc:` prefix, so
 * without this migration the ORM would serve raw `iv:ct` garbage to callers.
 *
 * # What this migration does
 *
 * Forward-only, per-row re-encryption, run once per schema (the db-migrate
 * runner pins `search_path` to `farm` then each `tenant_<uuid>` before invoking
 * this class — same fan-out contract as the rest of the farm chain). For each
 * legacy secret column it:
 *   1. Skips NULL values and values already in canonical GCM form (`enc:` prefix)
 *      — this is what makes the migration idempotent and re-runnable.
 *   2. Decrypts the legacy `<iv_hex>:<ct_hex>` value using the SAME key
 *      derivation the old CBC service used: `Buffer.from(oldKey.slice(0, 32))`
 *      (first 32 ASCII chars), `aes-256-cbc`.
 *   3. Re-encrypts the plaintext into canonical GCM via the SSoT transformer's
 *      `to()` — secrets are NEVER written back as plaintext at rest.
 *   4. Writes the new ciphertext with a raw UPDATE bound by primary key.
 *
 * # Key resolution
 *
 * The legacy CBC key and the new GCM key both come from the same env var per
 * domain (`SENTINEL_HUB_ENCRYPTION_KEY` / `REGULATORY_ENCRYPTION_KEY`, each with
 * an `ENCRYPTION_KEY` fallback for the legacy read path). The byte derivation
 * differs by design: CBC used the first 32 ASCII chars; the GCM transformer
 * resolves the same env var with its own (hex-or-ascii) rule for the write path.
 * If a domain's legacy key is unset at migration time, that domain is skipped
 * (no legacy rows could have been written without it) — surfaced via a log line.
 *
 * # Tier
 *
 * T2 (make-automatic): once data is migrated, the entity transformer makes
 * authenticated GCM the zero-effort default on every subsequent ORM read/write.
 * A T3 CI gate banning `aes-256-cbc` / raw `createCipheriv` outside the security
 * lib is recommended as follow-up (see migration PR open question).
 */

/** Legacy CBC parameters — fixed by the historical service implementation. */
const LEGACY_CBC_ALGORITHM = 'aes-256-cbc';
const LEGACY_KEY_BYTES = 32;

/** Canonical GCM ciphertext prefix (see encrypted-column.transformer). */
const GCM_PREFIX = 'enc:';

/**
 * Narrow query surface this migration depends on. Declaring the dependency
 * explicitly (rather than the full QueryRunner) lets the unit test drive the
 * re-encryption logic with a fully-typed in-memory executor, avoiding any
 * forced cast of a 40-member QueryRunner.
 */
export interface MigrationQueryExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown[]>;
}

interface SecretTable {
  /** Unqualified table name (resolved against current_schema()). */
  table: string;
  /** Physical secret column names holding legacy CBC ciphertext. */
  columns: string[];
  /** Env var holding the GCM key (transformer write path + legacy CBC primary read). */
  primaryKeyEnv: string;
  /** Fallback env var the legacy CBC read path also accepted. */
  fallbackKeyEnv: string;
}

const SECRET_TABLES: readonly SecretTable[] = [
  {
    table: 'sentinel_hub_settings',
    columns: ['client_id', 'client_secret', 'instance_id'],
    primaryKeyEnv: 'SENTINEL_HUB_ENCRYPTION_KEY',
    fallbackKeyEnv: 'ENCRYPTION_KEY',
  },
  {
    table: 'regulatory_settings',
    columns: ['maskinporten_client_id', 'maskinporten_private_key_encrypted'],
    primaryKeyEnv: 'REGULATORY_ENCRYPTION_KEY',
    fallbackKeyEnv: 'ENCRYPTION_KEY',
  },
] as const;

/** A row's secret columns are stored as text (or NULL). */
type SecretRow = Record<string, string | null>;

/** Type guard for the table-existence probe result shape. */
function isPresenceRow(value: unknown): value is { present: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { present?: unknown }).present === 'boolean'
  );
}

/**
 * Narrow an opaque driver row into the secret-row shape. Postgres returns text
 * columns as `string | null`; any other runtime type for a secret column would
 * be a schema contract violation and is coerced to null so it is treated as
 * "nothing to migrate" rather than silently mangled.
 */
function asSecretRow(value: unknown): SecretRow {
  if (typeof value !== 'object' || value === null) {
    throw new Error('[ReEncryptSecretsCbcToGcm] expected an object row from the driver');
  }
  const out: SecretRow = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = typeof raw === 'string' ? raw : null;
  }
  return out;
}

/**
 * Resolve the legacy CBC key buffer exactly as the old service did:
 * first 32 ASCII chars of the env value, UTF-8 encoded.
 */
function resolveLegacyKey(primaryEnv: string, fallbackEnv: string): Buffer | null {
  const raw = process.env[primaryEnv] ?? process.env[fallbackEnv];
  if (!raw || raw.length < LEGACY_KEY_BYTES) {
    return null;
  }
  return Buffer.from(raw.slice(0, LEGACY_KEY_BYTES));
}

/**
 * Decrypt a legacy `<iv_hex>:<ct_hex>` CBC value into plaintext.
 * Throws on malformed input or auth-less CBC failure — the caller decides
 * how to treat a row that cannot be converted.
 */
function decryptLegacyCbc(value: string, key: Buffer): string {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) {
    throw new Error('legacy value missing iv:ct separator');
  }
  const ivHex = value.slice(0, separatorIndex);
  const ctHex = value.slice(separatorIndex + 1);
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(LEGACY_CBC_ALGORITHM, key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export class ReEncryptSecretsCbcToGcm1801000000000 implements MigrationInterface {
  name = 'ReEncryptSecretsCbcToGcm1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // QueryRunner structurally satisfies MigrationQueryExecutor (its query()
    // returns Promise<any>, assignable to Promise<unknown[]> at the call site).
    await this.reEncrypt(queryRunner);
  }

  /**
   * Core re-encryption loop, typed against the narrow executor so it is unit
   * testable with an in-memory double.
   */
  public async reEncrypt(executor: MigrationQueryExecutor): Promise<void> {
    for (const spec of SECRET_TABLES) {
      await this.migrateTable(executor, spec);
    }
  }

  private async migrateTable(
    queryRunner: MigrationQueryExecutor,
    spec: SecretTable,
  ): Promise<void> {
    // Skip schemas that do not have the table (e.g. tenant schemas predating it).
    const tableExists = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1
       ) AS present`,
      [spec.table],
    );
    const probe = tableExists[0];
    if (!isPresenceRow(probe) || !probe.present) {
      return;
    }

    const legacyKey = resolveLegacyKey(spec.primaryKeyEnv, spec.fallbackKeyEnv);
    const gcmTransformer = createEncryptedColumnTransformer(spec.primaryKeyEnv);

    const selectColumns = ['id', ...spec.columns].map((c) => `"${c}"`).join(', ');
    const rawRows = await queryRunner.query(
      `SELECT ${selectColumns} FROM "${spec.table}"`,
    );

    for (const rawRow of rawRows) {
      const row = asSecretRow(rawRow);
      const updates: string[] = [];
      const params: string[] = [];

      for (const column of spec.columns) {
        const current = row[column];

        // Idempotency: NULLs and already-GCM rows need no work.
        if (current === null || current === undefined) {
          continue;
        }
        if (current.startsWith(GCM_PREFIX)) {
          continue;
        }

        // Legacy CBC row but the legacy key is unavailable — cannot convert.
        if (legacyKey === null) {
          throw new Error(
            `[ReEncryptSecretsCbcToGcm] ${spec.table}.${column} holds legacy CBC ` +
              `ciphertext but ${spec.primaryKeyEnv} (or ${spec.fallbackKeyEnv}) is unset ` +
              'or shorter than 32 chars. Provide the original key to migrate this column.',
          );
        }

        const plaintext = decryptLegacyCbc(current, legacyKey);
        const reEncrypted = gcmTransformer.to(plaintext);
        if (typeof reEncrypted !== 'string') {
          throw new Error(
            `[ReEncryptSecretsCbcToGcm] transformer produced a non-string ciphertext ` +
              `for ${spec.table}.${column}`,
          );
        }

        params.push(reEncrypted);
        updates.push(`"${column}" = $${params.length}`);
      }

      if (updates.length === 0) {
        continue;
      }

      const id = row['id'];
      if (id === null || id === undefined) {
        throw new Error(`[ReEncryptSecretsCbcToGcm] ${spec.table} row missing primary key`);
      }
      params.push(id);
      await queryRunner.query(
        `UPDATE "${spec.table}" SET ${updates.join(', ')} WHERE "id" = $${params.length}`,
        params,
      );
    }
  }

  /**
   * Forward-only security migration: there is no safe down() path. Reverting
   * would require re-encrypting plaintext with the broken, unauthenticated CBC
   * scheme this migration exists to retire. Re-running up() is idempotent and is
   * the supported recovery path.
   */
  public async down(): Promise<void> {
    throw new Error(
      'ReEncryptSecretsCbcToGcm1801000000000 is forward-only: reverting to ' +
        'unauthenticated AES-256-CBC is a security regression and is not supported.',
    );
  }
}
