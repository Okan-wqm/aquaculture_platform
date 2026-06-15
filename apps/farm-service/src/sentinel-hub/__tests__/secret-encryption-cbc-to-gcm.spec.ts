/**
 * Secret encryption migration spec (HIGH sentinel-cbc).
 *
 * Proves the two halves of the CBC -> GCM hardening:
 *  (a) a value written through the canonical AES-256-GCM column transformer
 *      round-trips (to() then from() recovers the plaintext, and the stored
 *      form carries the authenticated `enc:` envelope).
 *  (b) the ReEncryptSecretsCbcToGcm migration converts a legacy unauthenticated
 *      `<iv_hex>:<ct_hex>` CBC sample into the canonical GCM `enc:` format,
 *      decryptable back to the original plaintext, and is idempotent for rows
 *      already in GCM form.
 *
 * No live DB: the migration runs against a typed in-memory QueryRunner stub.
 */
import { createCipheriv } from 'crypto';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';

import {
  ReEncryptSecretsCbcToGcm1801000000000,
  type MigrationQueryExecutor,
} from '../../database/migrations/1801000000000-ReEncryptSecretsCbcToGcm';

const SENTINEL_KEY_ENV = 'SENTINEL_HUB_ENCRYPTION_KEY';
const GCM_PREFIX = 'enc:';

/**
 * Exactly-32-char key. The GCM transformer requires 32 ASCII chars (or 64 hex);
 * the legacy CBC path used the first 32 chars. At exactly 32 chars both paths
 * derive identical key bytes from the SAME env var, which is the precondition
 * for the migration to decrypt-CBC then re-encrypt-GCM with one key.
 */
const TEST_KEY = 'sentinel-hub-aes256-key-01234567';

/**
 * Reproduce the legacy bespoke AES-256-CBC encryption the old service used:
 * `Buffer.from(key.slice(0, 32))` as the key, random IV, output `iv:ct` hex.
 */
function legacyCbcEncrypt(plaintext: string, key: string): string {
  const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * In-memory executor backed by a mutable row table. Fully typed against the
 * migration's narrow MigrationQueryExecutor contract — no QueryRunner cast.
 */
function buildExecutor(rows: Array<Record<string, string | null>>): {
  executor: MigrationQueryExecutor;
  rows: Array<Record<string, string | null>>;
} {
  const state = rows;

  const executor: MigrationQueryExecutor = {
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      if (sql.includes('information_schema.tables')) {
        // Table-existence probe — the sentinel table exists; the regulatory
        // table is absent in this fixture so the migration skips it.
        const tableName = typeof params?.[0] === 'string' ? params[0] : '';
        return [{ present: tableName === 'sentinel_hub_settings' }];
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM "sentinel_hub_settings"')) {
        return state.map((row) => ({ ...row }));
      }

      if (sql.startsWith('UPDATE') && sql.includes('"sentinel_hub_settings"')) {
        const args = params ?? [];
        const id = args[args.length - 1];
        const target = state.find((row) => row['id'] === id);
        if (!target) {
          throw new Error(`stub UPDATE for unknown id ${String(id)}`);
        }
        // Parse "col" = $n assignments in order; values are params[0..n-1].
        const assignments = sql
          .slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE'))
          .split(',')
          .map((part) => part.trim());
        assignments.forEach((assignment, index) => {
          const column = assignment.slice(1, assignment.indexOf('"', 1));
          const value = args[index];
          target[column] = typeof value === 'string' ? value : null;
        });
        return [];
      }

      throw new Error(`unexpected query in stub: ${sql}`);
    },
  };

  return { executor, rows: state };
}

describe('secret encryption: CBC -> GCM hardening (HIGH sentinel-cbc)', () => {
  const originalEnv = process.env[SENTINEL_KEY_ENV];

  beforeAll(() => {
    process.env[SENTINEL_KEY_ENV] = TEST_KEY;
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env[SENTINEL_KEY_ENV];
    } else {
      process.env[SENTINEL_KEY_ENV] = originalEnv;
    }
  });

  describe('(a) GCM column transformer round-trip', () => {
    it('to() produces an authenticated enc: envelope that from() recovers', () => {
      const transformer = createEncryptedColumnTransformer(SENTINEL_KEY_ENV);
      const plaintext = 'cdse-client-secret-value';

      const stored = transformer.to(plaintext);

      expect(typeof stored).toBe('string');
      expect(stored as string).toMatch(/^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      expect(stored).not.toContain(plaintext);

      const recovered = transformer.from(stored as string);
      expect(recovered).toBe(plaintext);
    });

    it('to() is idempotent — an already-encrypted value is not double-wrapped', () => {
      const transformer = createEncryptedColumnTransformer(SENTINEL_KEY_ENV);
      const once = transformer.to('instance-id-123') as string;
      const twice = transformer.to(once);
      expect(twice).toBe(once);
    });
  });

  describe('(b) migration converts legacy CBC ciphertext to GCM', () => {
    it('re-encrypts iv:ct rows into enc: form decryptable to original plaintext', async () => {
      const transformer = createEncryptedColumnTransformer(SENTINEL_KEY_ENV);
      const clientIdPlain = 'sh-client-id';
      const clientSecretPlain = 'sh-client-secret';

      const legacyRow: Record<string, string | null> = {
        id: '11111111-1111-1111-1111-111111111111',
        client_id: legacyCbcEncrypt(clientIdPlain, TEST_KEY),
        client_secret: legacyCbcEncrypt(clientSecretPlain, TEST_KEY),
        instance_id: null,
      };

      // Sanity: the fixture is genuine legacy CBC (no enc: prefix, has iv:ct).
      expect(legacyRow['client_id']).not.toMatch(/^enc:/);
      expect(legacyRow['client_id']).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

      const { executor, rows } = buildExecutor([legacyRow]);

      await new ReEncryptSecretsCbcToGcm1801000000000().reEncrypt(executor);

      const migrated = rows[0];
      if (!migrated) {
        throw new Error('expected the migrated row to be present');
      }
      const migratedClientId = migrated['client_id'];
      const migratedClientSecret = migrated['client_secret'];
      if (migratedClientId === null || migratedClientId === undefined) {
        throw new Error('expected client_id to be re-encrypted, not null');
      }
      if (migratedClientSecret === null || migratedClientSecret === undefined) {
        throw new Error('expected client_secret to be re-encrypted, not null');
      }

      expect(migratedClientId).toMatch(/^enc:/);
      expect(migratedClientSecret).toMatch(/^enc:/);
      // NULL columns stay NULL.
      expect(migrated['instance_id']).toBeNull();

      // Round-trip the migrated ciphertext back to the original plaintext.
      expect(transformer.from(migratedClientId)).toBe(clientIdPlain);
      expect(transformer.from(migratedClientSecret)).toBe(clientSecretPlain);
    });

    it('is idempotent — already-GCM rows are left untouched (no double-encryption)', async () => {
      const transformer = createEncryptedColumnTransformer(SENTINEL_KEY_ENV);
      const alreadyGcm = transformer.to('already-migrated-secret') as string;

      const gcmRow: Record<string, string | null> = {
        id: '22222222-2222-2222-2222-222222222222',
        client_id: alreadyGcm,
        client_secret: null,
        instance_id: null,
      };

      const { executor, rows } = buildExecutor([gcmRow]);

      await new ReEncryptSecretsCbcToGcm1801000000000().reEncrypt(executor);

      const after = rows[0];
      if (!after) {
        throw new Error('expected the row to be present');
      }
      const afterClientId = after['client_id'];
      if (afterClientId === null || afterClientId === undefined) {
        throw new Error('expected client_id to remain present');
      }
      // Unchanged ciphertext, still decrypts to the original plaintext.
      expect(afterClientId).toBe(alreadyGcm);
      expect(transformer.from(afterClientId)).toBe('already-migrated-secret');
    });
  });
});
