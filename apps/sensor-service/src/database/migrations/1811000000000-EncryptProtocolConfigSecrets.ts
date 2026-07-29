import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  DEV_FALLBACK_KEY,
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedValue,
  resolveEncryptionKey,
} from '../../infrastructure/vault/credential-crypto';
import {
  hasSecretField,
  mapProtocolSecretFields,
} from '../../infrastructure/vault/protocol-secret-fields';

/**
 * SENSOR-MEDIUM-080 — encrypt existing plaintext protocol credentials at rest.
 *
 * The `sensors.protocol_configuration` jsonb column carries live device/vendor
 * credentials (Basic-auth passwords, bearer tokens, API keys, OAuth2 secrets,
 * CoAP PSKs). The read-echo exploit was closed by GraphQL redaction
 * (SENSOR-HIGH-081); this closes the residual at-rest / backup-leak vector.
 *
 * The entity now carries a field-level AES-256-GCM transformer that encrypts
 * secret-named fields on every write. This is the blue-green backfill for rows
 * written BEFORE the transformer: it re-writes each row's secret fields as
 * ciphertext (non-secret fields — host, port, topic — are left verbatim so the
 * `protocol_configuration->>'topic'` index and MQTT hot path keep working).
 *
 * Data-only migration (no DDL): SELECT/UPDATE over `sensors` in the canonical
 * `sensor` source schema AND every provisioned `tenant_*` schema (the sensor
 * runner invokes migrations once, so the fan-out is explicit — same contract as
 * the DDL migrations in this chain). Idempotent + re-runnable: already-`enc:`
 * fields are skipped, and a row whose secrets are all encrypted is not rewritten.
 *
 * Key: the same `CREDENTIAL_ENCRYPTION_KEY` the runtime `CredentialVaultService`
 * uses, resolved lazily — an empty or secret-free table needs no key at all, so
 * a fresh CI database migrates cleanly. When a secret must be encrypted and no
 * key is configured, production fails closed (never persist a real key with the
 * public dev fallback); dev/test fall back exactly as the runtime service does,
 * keeping migration ciphertext decryptable by the booting app.
 */
export class EncryptProtocolConfigSecrets1811000000000 implements MigrationInterface {
  name = 'EncryptProtocolConfigSecrets1811000000000';

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
        '[EncryptProtocolConfigSecrets] CREDENTIAL_ENCRYPTION_KEY is required in production ' +
          'to encrypt existing protocol credentials at rest.',
      );
    }
    this.cachedKey = Buffer.from(DEV_FALLBACK_KEY, 'utf8');
    return this.cachedKey;
  }

  private async sensorSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ nspname: string }> = await queryRunner.query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'sensor' OR nspname LIKE 'tenant\\_%'`,
    );
    const schemas: string[] = [];
    for (const { nspname } of rows) {
      const exists: unknown[] = await queryRunner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'sensors'`,
        [nspname],
      );
      if (exists.length > 0) {
        schemas.push(nspname);
      }
    }
    return schemas;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const schema of await this.sensorSchemas(queryRunner)) {
      const rows: Array<{ id: string; protocol_configuration: Record<string, unknown> | null }> =
        await queryRunner.query(
          `SELECT id, protocol_configuration FROM "${schema}"."sensors" WHERE protocol_configuration IS NOT NULL`,
        );
      for (const row of rows) {
        const config = row.protocol_configuration;
        if (!config || typeof config !== 'object' || !hasSecretField(config)) {
          continue;
        }
        const encrypted = mapProtocolSecretFields(config, (value) =>
          isEncryptedValue(value) ? value : encryptSecretValue(value, this.resolveKey()),
        );
        if (JSON.stringify(encrypted) === JSON.stringify(config)) {
          continue; // already fully encrypted — idempotent no-op
        }
        await queryRunner.query(
          `UPDATE "${schema}"."sensors" SET protocol_configuration = $1 WHERE id = $2`,
          [JSON.stringify(encrypted), row.id],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse the backfill: decrypt secret fields back to plaintext. Requires the
    // same key that encrypted them.
    for (const schema of await this.sensorSchemas(queryRunner)) {
      const rows: Array<{ id: string; protocol_configuration: Record<string, unknown> | null }> =
        await queryRunner.query(
          `SELECT id, protocol_configuration FROM "${schema}"."sensors" WHERE protocol_configuration IS NOT NULL`,
        );
      for (const row of rows) {
        const config = row.protocol_configuration;
        if (!config || typeof config !== 'object' || !hasSecretField(config)) {
          continue;
        }
        const decrypted = mapProtocolSecretFields(config, (value) =>
          isEncryptedValue(value) ? decryptSecretValue(value, this.resolveKey()) : value,
        );
        if (JSON.stringify(decrypted) === JSON.stringify(config)) {
          continue;
        }
        await queryRunner.query(
          `UPDATE "${schema}"."sensors" SET protocol_configuration = $1 WHERE id = $2`,
          [JSON.stringify(decrypted), row.id],
        );
      }
    }
  }
}
