import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  DEV_FALLBACK_KEY,
  decryptSecretValue,
  encryptSecretValue,
  resolveEncryptionKey,
} from '../../infrastructure/vault/credential-crypto';

/**
 * SENSOR-MEDIUM-044 — encrypt existing plaintext LoRaWAN AppKeys at rest.
 *
 * `lora_devices.app_key` is the 128-bit OTAA root key — the LoRaWAN root of
 * trust; a DB read or backup dump of a plaintext key lets an attacker
 * impersonate or decrypt end devices. The column already carries the AES-256-GCM
 * `EncryptedColumnTransformer` (new writes are encrypted, added in #941), but
 * rows written before it remain plaintext. This is the blue-green backfill for
 * those rows.
 *
 * Data-only migration (no DDL): UPDATE over `lora_devices` in the canonical
 * `sensor` source schema AND every provisioned `tenant_*` schema (the sensor
 * runner invokes migrations once, so the fan-out is explicit). Idempotent +
 * re-runnable — only rows whose `app_key` is not already in `enc:` form are
 * rewritten. Uses the same `CREDENTIAL_ENCRYPTION_KEY` and byte-identical `enc:`
 * format as the runtime `CredentialVaultService`, resolved lazily so a table
 * with no plaintext key (fresh CI DB) needs no key at all; production fails
 * closed when a key must be used but none is configured.
 */
export class EncryptLoraAppKeysAtRest1812000000000 implements MigrationInterface {
  name = 'EncryptLoraAppKeysAtRest1812000000000';

  private cachedKey: Buffer | null = null;

  private resolveKey(): Buffer {
    if (this.cachedKey) {
      return this.cachedKey;
    }
    const resolved = resolveEncryptionKey(process.env['CREDENTIAL_ENCRYPTION_KEY']);
    if (resolved) {
      this.cachedKey = resolved;
      return resolved;
    }
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        '[EncryptLoraAppKeysAtRest] CREDENTIAL_ENCRYPTION_KEY is required in production ' +
          'to encrypt existing LoRaWAN AppKeys at rest.',
      );
    }
    this.cachedKey = Buffer.from(DEV_FALLBACK_KEY, 'utf8');
    return this.cachedKey;
  }

  private async loraSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ nspname: string }> = await queryRunner.query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'sensor' OR nspname LIKE 'tenant\\_%'`,
    );
    const schemas: string[] = [];
    for (const { nspname } of rows) {
      const exists: unknown[] = await queryRunner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'lora_devices'`,
        [nspname],
      );
      if (exists.length > 0) {
        schemas.push(nspname);
      }
    }
    return schemas;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const schema of await this.loraSchemas(queryRunner)) {
      // Only plaintext rows — already-`enc:` keys are skipped (idempotent).
      const rows: Array<{ id: string; app_key: string }> = await queryRunner.query(
        `SELECT id, app_key FROM "${schema}"."lora_devices" WHERE app_key IS NOT NULL AND app_key NOT LIKE 'enc:%'`,
      );
      for (const row of rows) {
        await queryRunner.query(
          `UPDATE "${schema}"."lora_devices" SET app_key = $1 WHERE id = $2`,
          [encryptSecretValue(row.app_key, this.resolveKey()), row.id],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse the backfill: decrypt `enc:` keys back to plaintext (requires the
    // same key that encrypted them).
    for (const schema of await this.loraSchemas(queryRunner)) {
      const rows: Array<{ id: string; app_key: string }> = await queryRunner.query(
        `SELECT id, app_key FROM "${schema}"."lora_devices" WHERE app_key LIKE 'enc:%'`,
      );
      for (const row of rows) {
        await queryRunner.query(
          `UPDATE "${schema}"."lora_devices" SET app_key = $1 WHERE id = $2`,
          [decryptSecretValue(row.app_key, this.resolveKey()), row.id],
        );
      }
    }
  }
}
