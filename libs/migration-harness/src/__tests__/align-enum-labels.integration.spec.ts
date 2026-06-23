import { alignEnumLabels } from '@aquaculture/backend-common/database';

import {
  bootPostgresContainer,
  shutdownHarness,
  type HarnessContext,
} from '../index';

import {
  expectHarnessContext,
  queryRows,
  withHarnessSchema,
} from './test-helpers';

describe('alignEnumLabels — Phase 3 Class F primitive', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('adds entity-only labels to an existing pg_enum', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS enum_test`);
      try {
        await qr.query(
          `CREATE TYPE enum_test.widget_status AS ENUM ('draft', 'active')`,
        );
        const result = await alignEnumLabels(qr, {
          schema: 'enum_test',
          targets: [
            {
              typeName: 'widget_status',
              entityLabels: ['draft', 'active', 'archived'],
            },
          ],
        });
        expect(result.added['widget_status']).toEqual(['archived']);

        const rows = await queryRows<{ label: string }>(
          qr,
          `SELECT e.enumlabel AS label FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
             JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE n.nspname = 'enum_test' AND t.typname = 'widget_status'
            ORDER BY e.enumsortorder`,
        );
        expect(rows.map((r) => r.label)).toEqual([
          'draft',
          'active',
          'archived',
        ]);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
      }
    });
  });

  it('is idempotent — running twice on synced enum is a no-op', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS enum_test`);
      try {
        await qr.query(
          `CREATE TYPE enum_test.widget_status AS ENUM ('draft', 'active', 'archived')`,
        );
        const result = await alignEnumLabels(qr, {
          schema: 'enum_test',
          targets: [
            {
              typeName: 'widget_status',
              entityLabels: ['draft', 'active', 'archived'],
            },
          ],
        });
        expect(result.added).toEqual({});
        expect(result.inSync).toEqual(['widget_status']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
      }
    });
  });

  it('REFUSES when DB has labels the entity does not declare (removal path)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS enum_test`);
      try {
        await qr.query(
          `CREATE TYPE enum_test.widget_status AS ENUM ('draft', 'active', 'archived', 'deprecated')`,
        );
        await expect(
          alignEnumLabels(qr, {
            schema: 'enum_test',
            targets: [
              {
                typeName: 'widget_status',
                entityLabels: ['draft', 'active', 'archived'],
              },
            ],
          }),
        ).rejects.toThrow(/additive-only|DROP VALUE|deprecated/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
      }
    });
  });

  it('throws when the target pg_enum does not exist in the schema', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS enum_test`);
      try {
        await expect(
          alignEnumLabels(qr, {
            schema: 'enum_test',
            targets: [
              { typeName: 'nonexistent_enum', entityLabels: ['a', 'b'] },
            ],
          }),
        ).rejects.toThrow(/no such pg_enum/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
      }
    });
  });

  it('handles multiple target types in one invocation', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS enum_test`);
      try {
        await qr.query(
          `CREATE TYPE enum_test.type_a AS ENUM ('x')`,
        );
        await qr.query(
          `CREATE TYPE enum_test.type_b AS ENUM ('p', 'q')`,
        );
        const result = await alignEnumLabels(qr, {
          schema: 'enum_test',
          targets: [
            { typeName: 'type_a', entityLabels: ['x', 'y', 'z'] },
            { typeName: 'type_b', entityLabels: ['p', 'q', 'r'] },
          ],
        });
        expect(result.added['type_a']).toEqual(['y', 'z']);
        expect(result.added['type_b']).toEqual(['r']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
      }
    });
  });

  it('quotes embedded single quotes safely (SQL injection guard)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS enum_test`);
      try {
        await qr.query(
          `CREATE TYPE enum_test.widget_status AS ENUM ('normal')`,
        );
        const result = await alignEnumLabels(qr, {
          schema: 'enum_test',
          targets: [
            {
              typeName: 'widget_status',
              entityLabels: [
                'normal',
                `O'Brien`, // legitimate label containing a quote
              ],
            },
          ],
        });
        expect(result.added['widget_status']).toEqual([`O'Brien`]);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
      }
    });
  });

  it('returns empty result when targets=[]', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      const result = await alignEnumLabels(qr, {
        schema: 'enum_test',
        targets: [],
      });
      expect(result).toEqual({ added: {}, inSync: [] });
    });
  });

  it('rejects unsafe identifier at call site', async () => {
    const qr = {} as never;
    await expect(
      alignEnumLabels(qr, {
        schema: 'enum_test',
        targets: [
          { typeName: `bad"; DROP--`, entityLabels: ['a'] },
        ],
      }),
    ).rejects.toThrow(/SAFE_IDENT_RE/);
  });

  it('rejects empty entityLabels list', async () => {
    const qr = {} as never;
    await expect(
      alignEnumLabels(qr, {
        schema: 'enum_test',
        targets: [{ typeName: 'foo', entityLabels: [] }],
      }),
    ).rejects.toThrow(/non-empty/);
  });
});
