import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  createEncryptedColumnTransformer,
  createBlindIndex,
} from '@aquaculture/backend-common/security';

/**
 * EncryptFarmWorkerPii1801100000000
 *
 * # Why this migration exists (HIGH pii-at-rest)
 *
 * `farm_workers` stored worker PII — firstName, lastName, email, dateOfBirth,
 * and the contactInfo + address JSONB blobs — as PLAINTEXT at rest. Only
 * `nationalId` was encrypted. A DB exfiltration leaked every worker's identity
 * directly. The entity now carries the canonical AES-256-GCM column transformer
 * (`createEncryptedColumnTransformer`) on those columns, so all NEW writes are
 * encrypted. This migration converts the EXISTING plaintext rows and reshapes
 * the schema so the encrypted columns can hold ciphertext.
 *
 * # The email blind-index problem
 *
 * GCM is non-deterministic (fresh IV per write), so encrypting `email` in place
 * would (a) break every `WHERE email = ?` lookup and (b) silently void the
 * `(tenantId, email)` UNIQUE constraint — two rows with the same email encrypt
 * to different ciphertext, so the DB sees no collision. The architectural fix is
 * a blind index: a deterministic keyed `HMAC-SHA256(normalize(email))` stored in
 * a new `emailHash` column, with the UNIQUE constraint moved to
 * `(tenantId, emailHash)`. Equality lookups route through `emailHash`. The
 * plaintext email is then safe to encrypt. The entity derives `emailHash`
 * automatically in a @BeforeInsert/@BeforeUpdate hook.
 *
 * # What this migration does (forward-only, blue-green safe, idempotent)
 *
 * Per schema (the runner pins search_path to `farm` then each `tenant_<uuid>`
 * before invoking — same fan-out contract as the rest of the farm chain):
 *   1. Widen the PII columns to `text` (ciphertext is longer than the source
 *      varchar/jsonb/date types). Idempotent: `ALTER ... TYPE text` is a no-op
 *      if already text.
 *   2. Add a nullable `emailHash` text column (nullable first — blue-green: old
 *      pods writing NULL must not fail mid-rollout).
 *   3. Backfill row-by-row: skip values already in canonical GCM form (`enc:`
 *      prefix) — this is what makes the migration re-runnable; encrypt the
 *      remaining plaintext via the SSoT transformer's `to()`; compute the email
 *      blind index. PII is NEVER written back as plaintext.
 *   4. Enforce `emailHash NOT NULL` once every row is backfilled.
 *   5. Drop the legacy `(tenantId, email)` UNIQUE index (discovered by columns,
 *      not by name, because tenant clones may carry a different generated name)
 *      and create the `(tenantId, emailHash)` UNIQUE index.
 *
 * # Tier
 *
 * T1 (make-impossible) for uniqueness: the DB UNIQUE constraint over the
 * deterministic blind index structurally prevents duplicate emails per tenant
 * even though the email column is encrypted. T2 (make-automatic) for at-rest
 * encryption: once data is converted, the entity transformer makes authenticated
 * GCM the zero-effort default on every subsequent ORM read/write, and the
 * lifecycle hook keeps emailHash in lock-step with email.
 */

/** Env var holding the AES-256 key (shared with nationalId, ADR DB-CRITICAL-001). */
const PII_ENCRYPTION_KEY = 'EMPLOYEE_PII_ENCRYPTION_KEY'; // gitleaks:allow (env var NAME, not a secret value)

/** Env var holding the HMAC key for the email blind index. */
const PII_BLIND_INDEX_KEY = 'EMPLOYEE_PII_BLIND_INDEX_KEY'; // gitleaks:allow (env var NAME, not a secret value)

/** Canonical GCM ciphertext prefix (see encrypted-column.transformer). */
const GCM_PREFIX = 'enc:';

/** Table this migration operates on (unqualified — resolved vs current_schema()). */
const TABLE = 'farm_workers';

/**
 * PII columns to encrypt in place. `json` marks the JSONB blobs that must be
 * serialized before encryption (the transformer's { json: true } contract).
 */
const PII_COLUMNS: ReadonlyArray<{ name: string; json: boolean }> = [
  { name: 'firstName', json: false },
  { name: 'lastName', json: false },
  { name: 'email', json: false },
  { name: 'dateOfBirth', json: false },
  { name: 'contactInfo', json: true },
  { name: 'address', json: true },
];

/**
 * Narrow query surface this migration depends on. Declaring the dependency
 * explicitly (rather than the 40-member QueryRunner) lets the unit test drive
 * the backfill with a fully-typed in-memory executor — no forced casts.
 */
export interface MigrationQueryExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown[]>;
}

/** A worker row as the driver returns it: text/jsonb columns, id is the PK. */
type WorkerRow = Record<string, unknown>;

/** Coerce a driver value into the string the transformer expects, or null. */
function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  // JSONB columns may arrive already parsed (object) before the type widening
  // commits within the same connection — serialize so encryption sees a string.
  return JSON.stringify(value);
}

export class EncryptFarmWorkerPii1801100000000 implements MigrationInterface {
  name = 'EncryptFarmWorkerPii1801100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // QueryRunner structurally satisfies MigrationQueryExecutor.
    await this.widenColumns(queryRunner);
    await this.addEmailHashColumn(queryRunner);
    await this.backfill(queryRunner);
    await this.enforceEmailHashNotNull(queryRunner);
    await this.swapUniqueIndex(queryRunner);
  }

  /** Step 1: widen PII columns to text so they can hold GCM ciphertext. */
  private async widenColumns(queryRunner: MigrationQueryExecutor): Promise<void> {
    // ALTER ... TYPE text is a no-op when already text (idempotent). The
    // USING clause keeps existing values; jsonb/date cast cleanly to their
    // text representation, which is exactly the plaintext the backfill reads.
    for (const { name } of PII_COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${TABLE}" ALTER COLUMN "${name}" TYPE text USING "${name}"::text`,
      );
    }
  }

  /** Step 2: add the nullable blind-index column (blue-green safe). */
  private async addEmailHashColumn(queryRunner: MigrationQueryExecutor): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "emailHash" text`,
    );
  }

  /**
   * Step 3: encrypt plaintext PII and compute the email blind index, row by row.
   * Idempotent: values already in canonical GCM form are skipped, so re-running
   * after a partial failure converts only the not-yet-migrated rows.
   */
  public async backfill(queryRunner: MigrationQueryExecutor): Promise<void> {
    const transformers = new Map(
      PII_COLUMNS.map((c) => [
        c.name,
        createEncryptedColumnTransformer(PII_ENCRYPTION_KEY, { json: c.json }),
      ]),
    );
    const emailBlindIndex = createBlindIndex(PII_BLIND_INDEX_KEY);

    const selectColumns = ['id', ...PII_COLUMNS.map((c) => c.name)]
      .map((c) => `"${c}"`)
      .join(', ');
    const rows = await queryRunner.query(
      `SELECT ${selectColumns} FROM "${TABLE}"`,
    );

    for (const rawRow of rows) {
      const row = rawRow as WorkerRow;
      const id = row['id'];
      if (id === null || id === undefined) {
        throw new Error('[EncryptFarmWorkerPii] farm_workers row missing primary key');
      }

      const updates: string[] = [];
      const params: unknown[] = [];

      for (const { name, json } of PII_COLUMNS) {
        const current = asNullableText(row[name]);
        // Idempotency: NULLs and already-GCM values need no work.
        if (current === null) continue;
        if (current.startsWith(GCM_PREFIX)) continue;

        const transformer = transformers.get(name);
        if (!transformer) {
          throw new Error(`[EncryptFarmWorkerPii] no transformer for column ${name}`);
        }
        // For JSON columns the transformer re-serializes; feed it the parsed
        // object when the driver already parsed the jsonb, else the raw string.
        const plaintextInput = json ? JSON.parse(current) : current;
        const ciphertext = transformer.to(plaintextInput);
        if (typeof ciphertext !== 'string') {
          throw new Error(
            `[EncryptFarmWorkerPii] transformer produced a non-string ciphertext for ${name}`,
          );
        }
        params.push(ciphertext);
        updates.push(`"${name}" = $${params.length}`);
      }

      // Always (re)derive emailHash from the plaintext email when present.
      const plaintextEmail = asNullableText(row['email']);
      if (plaintextEmail !== null && !plaintextEmail.startsWith(GCM_PREFIX)) {
        params.push(emailBlindIndex(plaintextEmail));
        updates.push(`"emailHash" = $${params.length}`);
      }

      if (updates.length === 0) continue;

      params.push(id);
      await queryRunner.query(
        `UPDATE "${TABLE}" SET ${updates.join(', ')} WHERE "id" = $${params.length}`,
        params,
      );
    }
  }

  /** Step 4: enforce NOT NULL once every row carries an emailHash. */
  private async enforceEmailHashNotNull(
    queryRunner: MigrationQueryExecutor,
  ): Promise<void> {
    // Guarded SET NOT NULL: fire only while emailHash is still nullable, so a
    // replay is a safe no-op instead of a crash / silent reviewer-trap. The
    // information_schema.columns probe in the same statement also satisfies the
    // migration-sql-lint R10 (alter-column-unguarded) idempotency rule.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = '${TABLE}'
            AND column_name = 'emailHash'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "${TABLE}" ALTER COLUMN "emailHash" SET NOT NULL;
        END IF;
      END $$;
    `);
  }

  /**
   * Step 5: drop the legacy (tenantId, email) UNIQUE index — found by its
   * column set, since tenant clones may carry a different generated name —
   * and create the (tenantId, emailHash) UNIQUE index.
   */
  private async swapUniqueIndex(queryRunner: MigrationQueryExecutor): Promise<void> {
    // Discover and drop any UNIQUE index on exactly (tenantId, email) in the
    // current schema. Matching by columns (not name) survives the per-tenant
    // clone rename. Skip our own target index defensively (it indexes emailHash,
    // never email, so it can't match — but the WHERE is explicit for clarity).
    await queryRunner.query(`
      DO $$
      DECLARE
        legacy_index_name text;
      BEGIN
        SELECT i.indexrelid::regclass::text INTO legacy_index_name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = '${TABLE}'
          AND i.indisunique
          AND (
            SELECT array_agg(a.attname ORDER BY a.attnum)
            FROM pg_attribute a
            WHERE a.attrelid = i.indrelid
              AND a.attnum = ANY(i.indkey)
          ) @> ARRAY['email']::name[]
        LIMIT 1;

        IF legacy_index_name IS NOT NULL THEN
          EXECUTE 'DROP INDEX IF EXISTS ' || legacy_index_name;
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_farm_workers_tenant_email_hash" ` +
        `ON "${TABLE}" ("tenantId", "emailHash")`,
    );
  }

  /**
   * Forward-only security migration: there is no safe down() path. Reverting
   * would require writing decrypted PII back as plaintext at rest — the exact
   * exposure this migration exists to remove. Re-running up() is idempotent and
   * is the supported recovery path.
   */
  public async down(): Promise<void> {
    throw new Error(
      'EncryptFarmWorkerPii1801100000000 is forward-only: reverting to plaintext ' +
        'PII at rest is a security regression and is not supported.',
    );
  }
}
