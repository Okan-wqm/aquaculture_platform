import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { ClassifyImpersonationSessionsLifecycle1808300000000 } from '../1808300000000-ClassifyImpersonationSessionsLifecycle';

describe('ClassifyImpersonationSessionsLifecycle1808300000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('removes the UPDATE blocker and installs an idempotent DELETE-only guard', async () => {
    const migration = new ClassifyImpersonationSessionsLifecycle1808300000000();

    await migration.up(queryRunner);

    const statements = queryRunner.query.mock.calls.map(([statement]) => String(statement));
    const sql = statements.join('\n');
    const dropUpdateTrigger = statements.findIndex((statement) =>
      statement.includes('DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update'),
    );
    const dropConsolidatedFunction = statements.findIndex((statement) =>
      statement.includes(
        'DROP FUNCTION IF EXISTS "admin".impersonation_sessions_prevent_update_or_delete()',
      ),
    );
    const dropDeleteTrigger = statements.findIndex((statement) =>
      statement.includes('DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_delete'),
    );
    const createDeleteTrigger = statements.findIndex((statement) =>
      statement.includes('CREATE TRIGGER trg_impersonation_sessions_prevent_delete'),
    );

    expect(dropUpdateTrigger).toBeGreaterThanOrEqual(0);
    expect(dropConsolidatedFunction).toBeGreaterThan(dropUpdateTrigger);
    expect(dropDeleteTrigger).toBeGreaterThan(dropConsolidatedFunction);
    expect(createDeleteTrigger).toBeGreaterThan(dropDeleteTrigger);
    expect(sql).toMatch(
      /CREATE TRIGGER trg_impersonation_sessions_prevent_delete\s+BEFORE DELETE ON "admin"\."impersonation_sessions"/,
    );
    expect(sql).not.toMatch(/CREATE\s+TRIGGER[\s\S]*BEFORE\s+UPDATE/i);
    expect(sql).toContain('REVOKE DELETE ON "admin"."impersonation_sessions" FROM PUBLIC');
  });

  it('refuses rollback instead of restoring the lifecycle-breaking trigger', async () => {
    const migration = new ClassifyImpersonationSessionsLifecycle1808300000000();

    await expect(migration.down()).rejects.toThrow(
      'reinstalling the BEFORE UPDATE guard would disable every impersonation session lifecycle transition',
    );
  });
});
