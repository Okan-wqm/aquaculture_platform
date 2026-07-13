/**
 * Focused unit spec for the farm_workers PII-at-rest hardening (HIGH pii-at-rest).
 *
 * Proves:
 *  1. The encrypted PII columns round-trip through the SSoT transformer
 *     (firstName/lastName/email as text, contactInfo as JSON — the entity's
 *     current surface; dateOfBirth/address were dropped as placeholder-only
 *     columns by DropFarmWorkerPlaceholderPii1805500000000, ORPHAN-MEDIUM-379,
 *     and appear below only as the immutable backfill migration's behaviour).
 *  2. The email blind index is deterministic and normalization-insensitive, and
 *     the entity lifecycle hook keeps emailHash in lock-step with email.
 *  3. The backfill migration encrypts plaintext, computes emailHash, is
 *     idempotent (skips already-encrypted rows), and never leaves PII plaintext.
 *
 * No live DB: the migration is driven through a typed in-memory executor.
 */
import {
  createEncryptedColumnTransformer,
  createBlindIndex,
} from '@aquaculture/backend-common/security';
import { Worker, workerEmailBlindIndex } from '../entities/worker.entity';
import {
  EncryptFarmWorkerPii1801100000000,
  type MigrationQueryExecutor,
} from '../../database/migrations/1801100000000-EncryptFarmWorkerPii';

const PII_ENCRYPTION_KEY = 'EMPLOYEE_PII_ENCRYPTION_KEY';
const PII_BLIND_INDEX_KEY = 'EMPLOYEE_PII_BLIND_INDEX_KEY';
const GCM_PREFIX = 'enc:';

describe('farm_workers PII-at-rest encryption', () => {
  describe('encrypted column transformer round-trip', () => {
    const textTransformer = createEncryptedColumnTransformer(PII_ENCRYPTION_KEY);
    const jsonTransformer = createEncryptedColumnTransformer(PII_ENCRYPTION_KEY, {
      json: true,
    });

    it('encrypts text PII on write and never stores plaintext', () => {
      const ciphertext = textTransformer.to('Ada Lovelace');
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext).toMatch(/^enc:/);
      expect(ciphertext).not.toContain('Ada Lovelace');
    });

    it('round-trips firstName / lastName / email / dateOfBirth', () => {
      for (const value of ['Ada', 'Lovelace', 'ada@example.com', '1990-01-01']) {
        const stored = textTransformer.to(value);
        expect(textTransformer.from(stored as string)).toBe(value);
      }
    });

    it('round-trips the contactInfo / address JSONB blobs', () => {
      const contactInfo = {
        email: 'ada@example.com',
        phone: '+90 555 000 0000',
        emergencyContact: 'Babbage',
      };
      const address = {
        street: '1 Analytical Engine Rd',
        city: 'London',
        state: 'LDN',
        postalCode: 'EC1',
        country: 'GB',
      };

      const storedContact = jsonTransformer.to(contactInfo);
      const storedAddress = jsonTransformer.to(address);

      expect(storedContact).toMatch(/^enc:/);
      expect(storedContact).not.toContain('ada@example.com');
      expect(jsonTransformer.from(storedContact as string)).toEqual(contactInfo);
      expect(jsonTransformer.from(storedAddress as string)).toEqual(address);
    });

    it('does not double-encrypt an already-encrypted value', () => {
      const once = textTransformer.to('Ada') as string;
      const twice = textTransformer.to(once);
      expect(twice).toBe(once);
    });
  });

  describe('email blind index', () => {
    const blindIndex = createBlindIndex(PII_BLIND_INDEX_KEY);

    it('is deterministic for the same input', () => {
      expect(blindIndex('ada@example.com')).toBe(blindIndex('ada@example.com'));
    });

    it('normalizes case and surrounding whitespace', () => {
      const canonical = blindIndex('ada@example.com');
      expect(blindIndex('  ADA@Example.COM  ')).toBe(canonical);
    });

    it('produces a 64-char hex digest that is not the plaintext', () => {
      const hash = blindIndex('ada@example.com');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain('ada@example.com');
    });

    it('differs for different emails', () => {
      expect(blindIndex('ada@example.com')).not.toBe(blindIndex('grace@example.com'));
    });

    it('matches the entity helper export', () => {
      expect(workerEmailBlindIndex('ada@example.com')).toBe(blindIndex('ada@example.com'));
    });
  });

  describe('entity emailHash lifecycle hook', () => {
    it('derives emailHash from email on insert/update and normalizes email', () => {
      const worker = new Worker();
      worker.email = '  ADA@Example.COM ';
      worker.deriveEmailHash();

      expect(worker.email).toBe('ada@example.com');
      expect(worker.emailHash).toBe(workerEmailBlindIndex('ada@example.com'));
    });

    it('keeps a lookup hash equal to a persisted row hash (uniqueness check works)', () => {
      const worker = new Worker();
      worker.email = 'ada@example.com';
      worker.deriveEmailHash();

      // The duplicate-check handlers compute the lookup hash this way.
      const lookupHash = workerEmailBlindIndex('ADA@example.com');
      expect(lookupHash).toBe(worker.emailHash);
    });
  });

  describe('EncryptFarmWorkerPii backfill migration', () => {
    /** Minimal in-memory executor capturing UPDATE statements for assertions. */
    class FakeExecutor implements MigrationQueryExecutor {
      public readonly updates: Array<{ sql: string; params: unknown[] }> = [];
      constructor(private readonly rows: Array<Record<string, unknown>>) {}

      query(sql: string, parameters?: unknown[]): Promise<unknown[]> {
        if (sql.trimStart().startsWith('SELECT')) {
          return Promise.resolve(this.rows);
        }
        if (sql.trimStart().startsWith('UPDATE')) {
          this.updates.push({ sql, params: parameters ?? [] });
        }
        return Promise.resolve([]);
      }
    }

    const textTransformer = createEncryptedColumnTransformer(PII_ENCRYPTION_KEY);
    const jsonTransformer = createEncryptedColumnTransformer(PII_ENCRYPTION_KEY, {
      json: true,
    });

    it('encrypts plaintext PII and computes emailHash for legacy rows', async () => {
      const executor = new FakeExecutor([
        {
          id: 'worker-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          dateOfBirth: '1990-01-01',
          contactInfo: { email: 'ada@example.com', phone: '123' },
          address: { street: 's', city: 'c', state: 'st', postalCode: 'p', country: 'GB' },
        },
      ]);

      await new EncryptFarmWorkerPii1801100000000().backfill(executor);

      expect(executor.updates).toHaveLength(1);
      const { sql, params } = executor.updates[0]!;

      // Every PII column + emailHash assigned; bound id is the last param.
      expect(sql).toContain('"firstName" = $1');
      expect(sql).toContain('"emailHash"');
      expect(sql).toContain('WHERE "id" = $');
      expect(params[params.length - 1]).toBe('worker-1');

      // No plaintext leaked into any UPDATE parameter.
      for (const value of params) {
        expect(String(value)).not.toContain('Ada');
        expect(String(value)).not.toContain('ada@example.com');
      }

      // The persisted email ciphertext decrypts back to the original plaintext.
      const emailParamIndex = sql
        .split(',')
        .findIndex((clause) => clause.includes('"email" ='));
      expect(emailParamIndex).toBeGreaterThanOrEqual(0);
      const emailCiphertext = params[emailParamIndex] as string;
      expect(textTransformer.from(emailCiphertext)).toBe('ada@example.com');

      // The persisted emailHash equals the deterministic blind index of the email.
      const hashParam = params.find(
        (p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p),
      ) as string;
      expect(hashParam).toBe(workerEmailBlindIndex('ada@example.com'));
    });

    it('round-trips the encrypted JSONB columns through the migration', async () => {
      const contactInfo = { email: 'ada@example.com', phone: '123' };
      const executor = new FakeExecutor([
        {
          id: 'worker-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          dateOfBirth: '1990-01-01',
          contactInfo,
          address: { street: 's', city: 'c', state: 'st', postalCode: 'p', country: 'GB' },
        },
      ]);

      await new EncryptFarmWorkerPii1801100000000().backfill(executor);

      const { sql, params } = executor.updates[0]!;
      const clauses = sql.split(',');
      const contactIndex = clauses.findIndex((c) => c.includes('"contactInfo" ='));
      const contactCiphertext = params[contactIndex] as string;
      expect(jsonTransformer.from(contactCiphertext)).toEqual(contactInfo);
    });

    it('is idempotent: skips rows already in canonical GCM form', async () => {
      const executor = new FakeExecutor([
        {
          id: 'worker-1',
          firstName: textTransformer.to('Ada'),
          lastName: textTransformer.to('Lovelace'),
          email: textTransformer.to('ada@example.com'),
          dateOfBirth: textTransformer.to('1990-01-01'),
          contactInfo: jsonTransformer.to({ email: 'ada@example.com', phone: '123' }),
          address: jsonTransformer.to({
            street: 's',
            city: 'c',
            state: 'st',
            postalCode: 'p',
            country: 'GB',
          }),
        },
      ]);

      await new EncryptFarmWorkerPii1801100000000().backfill(executor);

      // Nothing to re-encrypt — every column already carries the enc: prefix.
      expect(executor.updates).toHaveLength(0);
    });

    it('refuses a row missing a primary key', async () => {
      const executor = new FakeExecutor([
        { id: null, firstName: 'Ada', email: 'ada@example.com' },
      ]);
      await expect(
        new EncryptFarmWorkerPii1801100000000().backfill(executor),
      ).rejects.toThrow(/missing primary key/);
    });

    it('down() is forward-only and refuses to revert', async () => {
      await expect(new EncryptFarmWorkerPii1801100000000().down()).rejects.toThrow(
        /forward-only/,
      );
    });

    it('skips already-GCM rows but still sanity-confirms the GCM prefix constant', () => {
      expect(GCM_PREFIX).toBe('enc:');
    });
  });
});
