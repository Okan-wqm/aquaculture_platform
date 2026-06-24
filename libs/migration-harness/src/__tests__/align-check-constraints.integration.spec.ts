import { alignCheckConstraints, sql } from '@aquaculture/backend-common/database';

import {
  bootPostgresContainer,
  shutdownHarness,
  type HarnessContext,
} from '../index';

import { expectHarnessContext, withHarnessSchema } from './test-helpers';

describe('alignCheckConstraints — Phase 3 Class G primitive', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('adds a named CHECK constraint that the DB lacks', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS check_test`);
      try {
        await qr.query(
          `CREATE TABLE check_test.widget (id uuid PRIMARY KEY, amount numeric NOT NULL)`,
        );
        const result = await alignCheckConstraints(qr, {
          schema: 'check_test',
          table: 'widget',
          desired: [
            {
              name: 'chk_widget_amount_positive',
              expression: sql.fragment`${sql.ident('amount')} > 0`,
            },
          ],
        });
        expect(result.added).toEqual(['chk_widget_amount_positive']);
        // Verify: inserting an invalid row should fail.
        await expect(
          qr.query(
            `INSERT INTO check_test.widget (id, amount) VALUES ('11111111-1111-1111-1111-111111111111', -5)`,
          ),
        ).rejects.toThrow();
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS check_test CASCADE`);
      }
    });
  });

  it('is idempotent — re-running a present constraint yields alreadyPresent', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS check_test`);
      try {
        await qr.query(
          `CREATE TABLE check_test.widget (
             id uuid PRIMARY KEY,
             amount numeric NOT NULL,
             CONSTRAINT chk_widget_amount_positive CHECK (amount > 0)
           )`,
        );
        const result = await alignCheckConstraints(qr, {
          schema: 'check_test',
          table: 'widget',
          desired: [
            {
              name: 'chk_widget_amount_positive',
              expression: sql.fragment`${sql.ident('amount')} > 0`,
            },
          ],
        });
        expect(result.added).toEqual([]);
        expect(result.alreadyPresent).toEqual(['chk_widget_amount_positive']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS check_test CASCADE`);
      }
    });
  });

  it('drops a constraint named in allowlistToDrop when present in DB', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS check_test`);
      try {
        await qr.query(
          `CREATE TABLE check_test.widget (
             id uuid PRIMARY KEY,
             amount numeric,
             CONSTRAINT chk_legacy_amount CHECK (amount IS NOT NULL)
           )`,
        );
        const result = await alignCheckConstraints(qr, {
          schema: 'check_test',
          table: 'widget',
          desired: [],
          allowlistToDrop: ['chk_legacy_amount'],
        });
        expect(result.dropped).toEqual(['chk_legacy_amount']);
        // Verify: previously-blocked NULL insert now succeeds.
        await qr.query(
          `INSERT INTO check_test.widget (id, amount) VALUES ('11111111-1111-1111-1111-111111111111', NULL)`,
        );
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS check_test CASCADE`);
      }
    });
  });

  it('drop is idempotent — allowlist entry absent from DB → dropAlreadyAbsent', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS check_test`);
      try {
        await qr.query(
          `CREATE TABLE check_test.widget (id uuid PRIMARY KEY, amount numeric)`,
        );
        const result = await alignCheckConstraints(qr, {
          schema: 'check_test',
          table: 'widget',
          desired: [],
          allowlistToDrop: ['chk_never_existed'],
        });
        expect(result.dropped).toEqual([]);
        expect(result.dropAlreadyAbsent).toEqual(['chk_never_existed']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS check_test CASCADE`);
      }
    });
  });

  it('handles add + drop in one invocation (atomic under the envelope)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS check_test`);
      try {
        await qr.query(
          `CREATE TABLE check_test.widget (
             id uuid PRIMARY KEY,
             amount numeric NOT NULL,
             CONSTRAINT chk_old CHECK (amount < 1000000)
           )`,
        );
        const result = await alignCheckConstraints(qr, {
          schema: 'check_test',
          table: 'widget',
          desired: [
            {
              name: 'chk_new_positive',
              expression: sql.fragment`${sql.ident('amount')} > 0`,
            },
          ],
          allowlistToDrop: ['chk_old'],
        });
        expect(result.added).toEqual(['chk_new_positive']);
        expect(result.dropped).toEqual(['chk_old']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS check_test CASCADE`);
      }
    });
  });

  it('rejects ambiguous intent (name in both desired + allowlistToDrop)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await expect(
        alignCheckConstraints(qr, {
          schema: 'check_test',
          table: 'widget',
          desired: [
            {
              name: 'chk_x',
              expression: sql.fragment`1 = 1`,
            },
          ],
          allowlistToDrop: ['chk_x'],
        }),
      ).rejects.toThrow(/BOTH desired/);
    });
  });

  it('rejects unsafe identifier in constraint name', async () => {
    const qr = {} as never;
    await expect(
      alignCheckConstraints(qr, {
        schema: 'check_test',
        table: 'widget',
        desired: [
          {
            name: `bad"; DROP--`,
            expression: sql.fragment`1 = 1`,
          },
        ],
      }),
    ).rejects.toThrow(/SAFE_IDENT_RE/);
  });

  it('returns empty result when desired=[] and allowlistToDrop=[]', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      const result = await alignCheckConstraints(qr, {
        schema: 'check_test',
        table: 'widget',
        desired: [],
      });
      expect(result).toEqual({
        added: [],
        alreadyPresent: [],
        dropped: [],
        dropAlreadyAbsent: [],
      });
    });
  });
});
