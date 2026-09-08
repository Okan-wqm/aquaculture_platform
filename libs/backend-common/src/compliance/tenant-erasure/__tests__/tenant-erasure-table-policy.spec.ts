import {
  erasedTables,
  requiredColumns,
  tenantErasurePolicyProblems,
  tenantRowPredicate,
  type TenantErasureTablePolicies,
} from '../tenant-erasure-table-policy';
import { TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE } from '../tenant-erasure-target-registry';

/**
 * ADMIN-CRITICAL-009 — the erasure plan is declared, complete and checked;
 * nothing is derived from column names at runtime.
 */
describe('tenant-erasure table policy', () => {
  describe('the registry is complete for every source-schema target', () => {
    for (const options of Object.values(TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE)) {
      if (options.mode !== 'source-schema-tenant-column') continue;
      it(`${options.targetService}: every registered table has exactly one policy and every cascade resolves`, () => {
        expect(
          tenantErasurePolicyProblems(options.moduleName, options.tables, [
            options.outbox.table,
            options.proofLedger.table,
          ]),
        ).toEqual([]);
      });
    }
  });

  describe('tenantErasurePolicyProblems', () => {
    it('names a registered table with no policy and a policy for an unregistered table', () => {
      const problems = tenantErasurePolicyProblems(
        'config',
        {
          configurations: { kind: 'tenant-column', column: 'tenant_id' },
          ghosts: { kind: 'excluded', reason: 'not real' },
        },
        ['config_outbox', 'tenant_erasure_target_proofs'],
      );
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'configuration_history' has no erasure policy"),
          expect.stringContaining("'ghosts', which MODULE_SCHEMAS does not register"),
        ]),
      );
    });

    it('refuses an outbox or proof ledger that is not excluded', () => {
      const problems = tenantErasurePolicyProblems(
        'config',
        {
          configurations: { kind: 'tenant-column', column: 'tenant_id' },
          configuration_history: { kind: 'tenant-column', column: 'tenant_id' },
          migrations: { kind: 'excluded', reason: 'ledger' },
          config_outbox: { kind: 'tenant-column', column: 'tenantId' },
          tenant_erasure_target_proofs: { kind: 'excluded', reason: 'proofs' },
        },
        ['config_outbox', 'tenant_erasure_target_proofs'],
      );
      expect(problems).toEqual([
        expect.stringContaining(
          "'config_outbox' is the target's outbox or proof ledger and must be 'excluded'",
        ),
      ]);
    });

    it('refuses a cascade into an excluded or missing parent, a cycle, and an empty reason', () => {
      const policies: TenantErasureTablePolicies = {
        configurations: { kind: 'cascade-via', parent: 'configuration_history', foreignKey: 'id' },
        configuration_history: {
          kind: 'cascade-via',
          parent: 'configurations',
          foreignKey: 'configuration_id',
        },
        migrations: { kind: 'excluded', reason: '  ' },
        config_outbox: { kind: 'cascade-via', parent: 'nowhere', foreignKey: 'x' },
        tenant_erasure_target_proofs: {
          kind: 'cascade-via',
          parent: 'migrations',
          foreignKey: 'y',
        },
      };
      const problems = tenantErasurePolicyProblems('config', policies, []);
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cascade cycle through 'configurations'"),
          expect.stringContaining("'migrations' is excluded without a reason"),
          expect.stringContaining("'config_outbox' cascades via 'nowhere', which has no policy"),
          expect.stringContaining(
            "'tenant_erasure_target_proofs' cascades via 'migrations', which is excluded",
          ),
        ]),
      );
    });

    it('rejects identifiers that are not SQL identifiers', () => {
      const problems = tenantErasurePolicyProblems(
        'config',
        {
          configurations: { kind: 'tenant-column', column: 'tenant_id; DROP TABLE x' },
          configuration_history: { kind: 'tenant-column', column: 'tenant_id' },
          migrations: { kind: 'excluded', reason: 'ledger' },
          config_outbox: { kind: 'excluded', reason: 'outbox' },
          tenant_erasure_target_proofs: { kind: 'excluded', reason: 'proofs' },
        },
        [],
      );
      expect(problems).toEqual([expect.stringContaining('is not an identifier')]);
    });

    it('reports an unknown module', () => {
      expect(tenantErasurePolicyProblems('no-such-module', {}, [])).toEqual([
        "no MODULE_SCHEMAS entry for module 'no-such-module'",
      ]);
    });
  });

  describe('tenantRowPredicate', () => {
    const policies: TenantErasureTablePolicies = {
      support_tickets: { kind: 'tenant-column', column: 'tenantId' },
      ticket_comments: { kind: 'cascade-via', parent: 'support_tickets', foreignKey: 'ticketId' },
      comment_reactions: {
        kind: 'cascade-via',
        parent: 'ticket_comments',
        foreignKey: 'commentId',
        parentKey: 'uuid',
      },
      audit_logs: { kind: 'excluded', reason: 'WORM' },
    };

    it('binds the tenant as $1 for a tenant column', () => {
      expect(tenantRowPredicate('admin', 'support_tickets', policies)).toBe('"tenantId" = $1');
    });

    it('nests one sub-select per cascade hop, honouring a custom parent key', () => {
      expect(tenantRowPredicate('admin', 'comment_reactions', policies)).toBe(
        '"commentId" IN (SELECT "uuid" FROM "admin"."ticket_comments" WHERE "ticketId" IN (SELECT "id" FROM "admin"."support_tickets" WHERE "tenantId" = $1))',
      );
    });

    it('has no predicate for an excluded table', () => {
      expect(() => tenantRowPredicate('admin', 'audit_logs', policies)).toThrow(
        /no erasing policy/,
      );
    });

    it('lists the columns the database must have and the tables that are erased', () => {
      expect(erasedTables(policies)).toEqual([
        'support_tickets',
        'ticket_comments',
        'comment_reactions',
      ]);
      expect(requiredColumns(policies)).toEqual([
        { table: 'support_tickets', column: 'tenantId' },
        { table: 'ticket_comments', column: 'ticketId' },
        { table: 'support_tickets', column: 'id' },
        { table: 'comment_reactions', column: 'commentId' },
        { table: 'ticket_comments', column: 'uuid' },
      ]);
    });
  });
});
