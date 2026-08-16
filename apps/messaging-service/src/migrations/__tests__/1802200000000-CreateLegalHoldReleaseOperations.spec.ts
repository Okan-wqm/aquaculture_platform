import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';

import {
  PROTECTED_TABLE_POLICIES,
  ROW_DELETE_POLICY,
  ROW_MUTATION_POLICY,
  rowGuardTablePoliciesForSchema,
} from '@aquaculture/backend-common/constants';
import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';

import { LegalHoldReleaseOperation } from '../../compliance/entities/legal-hold-release-operation.entity';
import {
  LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT,
  LegalHold,
} from '../../compliance/entities/legal-hold.entity';
import { CreateLegalHoldReleaseOperations1802200000000 } from '../1802200000000-CreateLegalHoldReleaseOperations';

const LEGAL_HOLD_CHECKS = [
  'chk_legal_hold_no_self_approval',
  'chk_legal_hold_release_reason',
  'chk_legal_hold_release_state',
] as const;

const RELEASE_OPERATION_CHECKS = [
  'chk_legal_hold_release_operation_distinct_actors',
  'chk_legal_hold_release_operation_reason',
  'chk_legal_hold_release_operation_state',
  'chk_legal_hold_release_operation_status',
  'chk_legal_hold_release_operation_temporal_evidence',
  'chk_legal_hold_release_operation_token_evidence',
] as const;

function constraintNames(sql: string): string[] {
  return [...sql.matchAll(/ADD CONSTRAINT\s+"(chk_[^"]+)"|CONSTRAINT\s+"(chk_[^"]+)"/g)]
    .flatMap((match) => [match[1] ?? match[2]])
    .filter((name): name is string => name !== undefined)
    .sort();
}

function normalizedSqlExpression(expression: string): string {
  return expression.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

function checkExpression(sql: string, constraintName: string): string {
  const constraintOffset = sql.indexOf(`CONSTRAINT "${constraintName}"`);
  if (constraintOffset < 0) {
    throw new Error(`Missing CHECK constraint ${constraintName}`);
  }

  const checkOffset = sql.indexOf('CHECK', constraintOffset);
  const openingParenthesis = sql.indexOf('(', checkOffset);
  if (checkOffset < 0 || openingParenthesis < 0) {
    throw new Error(`Missing CHECK expression for ${constraintName}`);
  }

  let depth = 0;
  let quoted = false;
  for (let cursor = openingParenthesis; cursor < sql.length; cursor += 1) {
    const character = sql[cursor];
    if (character === "'") {
      if (quoted && sql[cursor + 1] === "'") {
        cursor += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return normalizedSqlExpression(sql.slice(openingParenthesis + 1, cursor));
      }
    }
  }

  throw new Error(`Unterminated CHECK expression for ${constraintName}`);
}

type EntityConstructor = abstract new (...args: never[]) => object;

function isForeignKeyTargetFactory(value: unknown): value is () => EntityConstructor {
  return (
    typeof value === 'function' && !Function.prototype.toString.call(value).startsWith('class ')
  );
}

describe('CreateLegalHoldReleaseOperations1802200000000', () => {
  it('installs durable idempotency, typed transitions, retention, and tenant-clone FK healing', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner: Pick<QueryRunner, 'query'> = { query };

    await new CreateLegalHoldReleaseOperations1802200000000().up(queryRunner as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('legal_hold_release_operations');
    expect(sql).toContain('uq_legal_hold_release_operation_initiation_request');
    expect(sql).toContain('uq_legal_hold_release_operation_authorization_request');
    expect(sql).toContain('uq_legal_hold_release_operation_pending_hold');
    expect(sql).toContain('uq_legal_hold_id_tenant');
    expect(sql).toContain('FOREIGN KEY ("holdId", "tenantId")');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS')).toBeLessThan(
      sql.indexOf('ADD CONSTRAINT "fk_legal_hold_release_operation_hold"'),
    );
    expect(sql).toContain('chk_legal_hold_release_operation_status');
    expect(sql).toContain('chk_legal_hold_release_operation_distinct_actors');
    expect(sql).toContain('chk_legal_hold_release_operation_token_evidence');
    expect(sql).toContain('chk_legal_hold_release_operation_state');
    expect(sql).toContain('chk_legal_hold_release_operation_temporal_evidence');
    expect(sql).toContain('"status" = \'EXPIRED\'');
    expect(sql).toContain('"expiredAt" >= "expiresAt"');
    expect(sql).toContain('"authorizedAt" < "expiresAt"');
    expect(sql).toContain('"expiredBy" uuid');
    expect(sql).toContain('chk_legal_hold_no_self_approval');
    expect(sql).toContain('chk_legal_hold_release_reason');
    expect(sql).toContain('chk_legal_hold_release_state');
    expect(sql).toContain('"isActive" = true\n                AND "releasedBy" IS NULL');
    expect(sql).toContain('"isActive" = false\n                AND "releasedBy" IS NOT NULL');
    expect(sql).toContain('NOT VALID');
    expect(sql).toContain("IF TG_OP = 'INSERT'");
    expect(sql).toContain('IF OLD."status" <> \'PENDING\'');
    expect(sql).toContain("IF NEW.\"status\" NOT IN ('RELEASED', 'EXPIRED')");
    expect(sql).toContain('identity and initiation evidence are immutable');
    expect(sql).toContain('trg_legal_hold_release_operations_enforce_transition');
    expect(sql).toContain('trg_legal_hold_release_operations_prevent_delete');
    expect(sql).toContain('BEFORE DELETE ON "legal_hold_release_operations"');
    expect(sql).toContain('REVOKE DELETE ON "legal_hold_release_operations" FROM PUBLIC');
    expect(sql).toContain('trg_legal_holds_prevent_delete');
    expect(sql).toContain('BEFORE DELETE ON "legal_holds"');
    expect(sql).toContain('REVOKE DELETE ON "legal_holds" FROM PUBLIC');
    expect(
      sql.match(/CREATE OR REPLACE FUNCTION "legal_hold_records_prevent_delete"/g),
    ).toHaveLength(1);
    expect(sql).toContain(LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT);
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER trg_legal_hold_release_operation_evidence_parity',
    );
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_legal_hold_release_evidence_parity');
    expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
    expect(sql).toContain('RELEASED legal hold operation has no exact released hold evidence');
    expect(sql).toContain('Released legal hold has no exact two-person operation evidence');
    expect(sql).toContain('A released legal hold cannot be reactivated');
  });

  it('keeps all nine migration CHECK expressions and the composite FK equal to entity metadata', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner: Pick<QueryRunner, 'query'> = { query };
    await new CreateLegalHoldReleaseOperations1802200000000().up(queryRunner as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    const expectedChecks = [...LEGAL_HOLD_CHECKS, ...RELEASE_OPERATION_CHECKS].sort();
    const metadata = getMetadataArgsStorage();
    const metadataChecks = [
      ...metadata.filterChecks(LegalHold),
      ...metadata.filterChecks(LegalHoldReleaseOperation),
    ];
    const metadataCheckNames = metadataChecks
      .map((check) => check.name)
      .filter((name): name is string => name !== undefined)
      .sort();

    expect(constraintNames(sql)).toEqual(expectedChecks);
    expect(metadataCheckNames).toEqual(expectedChecks);
    for (const check of metadataChecks) {
      expect(typeof check.name).toBe('string');
      expect(typeof check.expression).toBe('string');
      if (typeof check.name === 'string' && typeof check.expression === 'string') {
        expect(checkExpression(sql, check.name)).toBe(normalizedSqlExpression(check.expression));
      }
    }

    const foreignKeys = metadata.filterForeignKeys(LegalHoldReleaseOperation);
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]).toEqual(
      expect.objectContaining({
        name: 'fk_legal_hold_release_operation_hold',
        columnNames: ['holdId', 'tenantId'],
        referencedColumnNames: ['id', 'tenantId'],
        onDelete: 'RESTRICT',
      }),
    );
    const targetFactory = foreignKeys[0]?.type;
    expect(isForeignKeyTargetFactory(targetFactory)).toBe(true);
    if (isForeignKeyTargetFactory(targetFactory)) {
      expect(targetFactory()).toBe(LegalHold);
    }

    const reviewDeadlineColumn = metadata
      .filterColumns(LegalHold)
      .find((column) => column.propertyName === 'expiresAt');
    expect(reviewDeadlineColumn?.options.comment).toBe(LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT);
  });

  it('projects the per-tenant table and its delete-deny lifecycle policy from canonical catalogs', () => {
    const messagingSchema = MODULE_SCHEMAS.find((schema) => schema.moduleName === 'messaging');
    expect(messagingSchema?.tables).toContain('legal_hold_release_operations');
    expect(messagingSchema?.infrastructureTables).not.toContain('legal_hold_release_operations');

    const policy = PROTECTED_TABLE_POLICIES.find(
      (candidate) => candidate.qualifiedName === 'messaging.legal_hold_release_operations',
    );
    expect(policy).toEqual({
      qualifiedName: 'messaging.legal_hold_release_operations',
      rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
      rowDelete: ROW_DELETE_POLICY.DENY,
    });
    expect(rowGuardTablePoliciesForSchema('messaging')).toContainEqual(policy);

    const holdPolicy = PROTECTED_TABLE_POLICIES.find(
      (candidate) => candidate.qualifiedName === 'messaging.legal_holds',
    );
    expect(holdPolicy).toEqual({
      qualifiedName: 'messaging.legal_holds',
      rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
      rowDelete: ROW_DELETE_POLICY.DENY,
    });
    expect(rowGuardTablePoliciesForSchema('messaging')).toContainEqual(holdPolicy);
  });

  it('fails the runner post-condition closed unless the live catalog proves the contract', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ contract_valid: true }])
      .mockResolvedValueOnce([{ contract_valid: false }])
      .mockResolvedValueOnce([]);
    const queryRunner: Pick<QueryRunner, 'query'> = { query };
    const migration = new CreateLegalHoldReleaseOperations1802200000000();

    await expect(migration.postCondition(queryRunner as QueryRunner)).resolves.toBe(true);
    await expect(migration.postCondition(queryRunner as QueryRunner)).resolves.toBe(false);
    await expect(migration.postCondition(queryRunner as QueryRunner)).resolves.toBe(false);

    const probeSql = String(query.mock.calls[0]?.[0]);
    expect(probeSql).toContain("constraint_state.confdeltype = 'r'");
    expect(probeSql).toContain('col_description(target.hold_table, attribute.attnum)');
    expect(probeSql).toContain(LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT);
    expect(probeSql).toContain('trigger_state.tgtype = 23');
    expect(probeSql).toContain('trigger_state.tgtype = 11');
    expect(probeSql).toContain("trigger_state.tgname = 'trg_legal_holds_prevent_delete'");
    expect(probeSql).toContain("function_state.proname = 'legal_hold_records_prevent_delete'");
    expect(probeSql).toContain('bool_and(trigger_state.tgdeferrable)');
    expect(probeSql).toContain('bool_and(trigger_state.tginitdeferred)');
    expect(probeSql).toContain('bool_and(trigger_state.tgtype = 21)');
  });

  it('is forward-only because authorization evidence is not disposable', async () => {
    await expect(new CreateLegalHoldReleaseOperations1802200000000().down()).rejects.toThrow(
      'forward-only',
    );
  });
});
