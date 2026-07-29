/**
 * SENSOR-MEDIUM-044 backfill migration — encrypts existing plaintext LoRaWAN
 * AppKeys across the sensor + tenant schemas, idempotently.
 */
import { QueryRunner } from 'typeorm';

import {
  DEV_FALLBACK_KEY,
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedValue,
} from '../../../infrastructure/vault/credential-crypto';
import { EncryptLoraAppKeysAtRest1812000000000 } from '../1812000000000-EncryptLoraAppKeysAtRest';

const DEV_KEY = Buffer.from(DEV_FALLBACK_KEY, 'utf8');
const APP_KEY = '00112233445566778899AABBCCDDEEFF';

interface LoraRow {
  id: string;
  app_key: string;
}

interface Captured {
  id: string;
  appKey: string;
}

/** QueryRunner double serving one `sensor` schema; captures UPDATEs. `rows` is
 *  what the plaintext-only SELECT (WHERE NOT LIKE 'enc:%') returns. */
function makeQueryRunner(rows: LoraRow[]): { queryRunner: QueryRunner; updates: Captured[] } {
  const updates: Captured[] = [];
  const query = async (sql: string, params?: unknown[]): Promise<unknown> => {
    if (sql.includes('pg_namespace')) {
      return [{ nspname: 'sensor' }];
    }
    if (sql.includes('information_schema.tables')) {
      return [{ exists: 1 }];
    }
    if (sql.includes("NOT LIKE 'enc:%'")) {
      return rows;
    }
    if (sql.startsWith('UPDATE')) {
      const [appKey, id] = params as [string, string];
      updates.push({ id, appKey });
      return [];
    }
    return [];
  };
  const queryRunner = { query } as Pick<QueryRunner, 'query'> as QueryRunner;
  return { queryRunner, updates };
}

describe('EncryptLoraAppKeysAtRest1812000000000', () => {
  it('encrypts a plaintext AppKey and preserves the original value under decryption', async () => {
    const { queryRunner, updates } = makeQueryRunner([{ id: 'd1', app_key: APP_KEY }]);

    await new EncryptLoraAppKeysAtRest1812000000000().up(queryRunner);

    expect(updates).toHaveLength(1);
    expect(isEncryptedValue(updates[0]!.appKey)).toBe(true);
    expect(updates[0]!.appKey).not.toContain(APP_KEY);
    expect(decryptSecretValue(updates[0]!.appKey, DEV_KEY)).toBe(APP_KEY);
  });

  it('is a no-op when no plaintext rows remain (all already enc:)', async () => {
    // The migration's WHERE NOT LIKE 'enc:%' returns nothing when all rows are
    // already encrypted — the double filters idempotency at the SQL layer.
    const { queryRunner, updates } = makeQueryRunner([]);
    await new EncryptLoraAppKeysAtRest1812000000000().up(queryRunner);
    expect(updates).toHaveLength(0);
  });

  it('down() decrypts an encrypted AppKey back to plaintext', async () => {
    const encrypted = encryptSecretValue(APP_KEY, DEV_KEY);
    // For down(), the SELECT filters LIKE 'enc:%'; reuse the same runner which
    // returns `rows` for any non-namespace/non-information_schema SELECT.
    const updates: Captured[] = [];
    const query = async (sql: string, params?: unknown[]): Promise<unknown> => {
      if (sql.includes('pg_namespace')) return [{ nspname: 'sensor' }];
      if (sql.includes('information_schema.tables')) return [{ exists: 1 }];
      if (sql.includes("LIKE 'enc:%'") && sql.startsWith('SELECT')) {
        return [{ id: 'd1', app_key: encrypted }];
      }
      if (sql.startsWith('UPDATE')) {
        const [appKey, id] = params as [string, string];
        updates.push({ id, appKey });
        return [];
      }
      return [];
    };
    const queryRunner = { query } as Pick<QueryRunner, 'query'> as QueryRunner;

    await new EncryptLoraAppKeysAtRest1812000000000().down(queryRunner);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.appKey).toBe(APP_KEY);
  });
});
