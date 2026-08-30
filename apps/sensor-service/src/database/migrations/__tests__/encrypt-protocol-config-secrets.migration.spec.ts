/**
 * SENSOR-MEDIUM-080 backfill migration — encrypts existing plaintext protocol
 * secrets across the sensor + tenant schemas, idempotently.
 */
import { QueryRunner } from 'typeorm';

import {
  DEV_FALLBACK_KEY,
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedValue,
} from '../../../infrastructure/vault/credential-crypto';
import { EncryptProtocolConfigSecrets1811000000000 } from '../1811000000000-EncryptProtocolConfigSecrets';

const DEV_KEY = Buffer.from(DEV_FALLBACK_KEY, 'utf8');

interface SensorRow {
  id: string;
  protocol_configuration: Record<string, unknown> | null;
}

interface Captured {
  id: string;
  config: Record<string, unknown>;
}

/**
 * Build a QueryRunner whose `query` serves one `sensor` schema with the given
 * rows and records UPDATEs. Typed through Pick to avoid stubbing all ~40 members.
 */
function makeQueryRunner(rows: SensorRow[]): { queryRunner: QueryRunner; updates: Captured[] } {
  const updates: Captured[] = [];
  const query = async (sql: string, params?: unknown[]): Promise<unknown> => {
    if (sql.includes('pg_namespace')) {
      return [{ nspname: 'sensor' }];
    }
    if (sql.includes('information_schema.tables')) {
      return [{ exists: 1 }];
    }
    if (sql.includes('SELECT id, protocol_configuration')) {
      return rows;
    }
    if (sql.startsWith('UPDATE')) {
      const [configJson, id] = params as [string, string];
      updates.push({ id, config: JSON.parse(configJson) as Record<string, unknown> });
      return [];
    }
    return [];
  };
  const queryRunner = { query } as Pick<QueryRunner, 'query'> as QueryRunner;
  return { queryRunner, updates };
}

describe('EncryptProtocolConfigSecrets1811000000000', () => {
  it('encrypts plaintext secret fields and leaves non-secret fields untouched', async () => {
    const { queryRunner, updates } = makeQueryRunner([
      {
        id: 's1',
        protocol_configuration: {
          host: '10.0.0.5',
          topic: 'farm/1/temp',
          password: 'plain-pw',
        },
      },
    ]);

    await new EncryptProtocolConfigSecrets1811000000000().up(queryRunner);

    expect(updates).toHaveLength(1);
    const cfg = updates[0]!.config;
    expect(cfg.host).toBe('10.0.0.5');
    expect(cfg.topic).toBe('farm/1/temp');
    expect(isEncryptedValue(String(cfg.password))).toBe(true);
    expect(decryptSecretValue(String(cfg.password), DEV_KEY)).toBe('plain-pw');
  });

  it('is a no-op for rows with no secret field', async () => {
    const { queryRunner, updates } = makeQueryRunner([
      { id: 's1', protocol_configuration: { host: 'h', topic: 't', port: 1 } },
    ]);
    await new EncryptProtocolConfigSecrets1811000000000().up(queryRunner);
    expect(updates).toHaveLength(0);
  });

  it('is idempotent — already-encrypted rows are not rewritten', async () => {
    const { queryRunner, updates } = makeQueryRunner([
      {
        id: 's1',
        protocol_configuration: {
          host: 'h',
          password: encryptSecretValue('plain-pw', DEV_KEY),
        },
      },
    ]);
    await new EncryptProtocolConfigSecrets1811000000000().up(queryRunner);
    expect(updates).toHaveLength(0);
  });
});
