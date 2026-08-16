/**
 * `admin.impersonation_sessions` is destructive-DDL protected and
 * hard-delete guarded, but lifecycle UPDATEs are required. This invariant pins
 * the policy SSoT, both baseline consumers, and the net trigger state produced
 * by the effective admin migration sequence.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  APPEND_ONLY_TABLES,
  LIFECYCLE_MUTATED_TABLES,
  PROTECTED_TABLE_POLICIES,
  PROTECTED_TABLES,
  ROW_DELETE_POLICY,
  ROW_MUTATION_POLICY,
  rowGuardTablePoliciesForSchema,
} from '../../libs/backend-common/src/constants/protected-tables';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_MIGRATIONS = resolve(REPO_ROOT, 'apps/admin-api-service/src/migrations');
const UPDATE_TRIGGER = 'trg_impersonation_sessions_prevent_update';
const DELETE_TRIGGER = 'trg_impersonation_sessions_prevent_delete';

function upBody(source: string): string {
  const up = /(^|\n)\s*(?:public\s+)?async\s+up\s*\(/.exec(source);
  if (!up) return '';
  const down = /(^|\n)\s*(?:public\s+)?async\s+down\s*\(/.exec(source);
  return source.slice(up.index, down && down.index > up.index ? down.index : source.length);
}

function adminMigrationSources(): string[] {
  return readdirSync(ADMIN_MIGRATIONS)
    .filter((name) => /^[0-9].*\.ts$/.test(name))
    .sort()
    .map((name) => readFileSync(resolve(ADMIN_MIGRATIONS, name), 'utf8'));
}

function netImpersonationTriggerState(): Readonly<{
  update: boolean;
  delete: boolean;
}> {
  const state = { update: false, delete: false };
  const event = new RegExp(
    `(CREATE|DROP)\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?["']?(${UPDATE_TRIGGER}|${DELETE_TRIGGER})["']?`,
    'gi',
  );

  for (const source of adminMigrationSources()) {
    for (const match of upBody(source).matchAll(event)) {
      const operation = match[1]?.toUpperCase();
      const trigger = match[2]?.toLowerCase();
      if (trigger === UPDATE_TRIGGER) state.update = operation === 'CREATE';
      if (trigger === DELETE_TRIGGER) state.delete = operation === 'CREATE';
    }
  }
  return state;
}

describe('INVARIANT: impersonation_sessions is lifecycle-mutated and retention-guarded', () => {
  it('derives destructive-DDL and row classifications from one complete policy SSoT', () => {
    const policyNames = PROTECTED_TABLE_POLICIES.map((policy) => policy.qualifiedName);
    const uniqueNames = new Set(policyNames);

    expect(uniqueNames.size).toBe(policyNames.length);
    expect(PROTECTED_TABLES).toEqual(policyNames);
    expect(APPEND_ONLY_TABLES).toEqual(
      PROTECTED_TABLE_POLICIES.filter(
        (policy) => policy.rowMutation === ROW_MUTATION_POLICY.APPEND_ONLY,
      ).map((policy) => policy.qualifiedName),
    );

    const table = 'admin.impersonation_sessions';
    const policy = PROTECTED_TABLE_POLICIES.find((candidate) => candidate.qualifiedName === table);
    expect(policy).toEqual({
      qualifiedName: table,
      rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
      rowDelete: ROW_DELETE_POLICY.DENY,
    });
    expect(PROTECTED_TABLES).toContain(table);
    expect(APPEND_ONLY_TABLES).not.toContain(table);
    expect(LIFECYCLE_MUTATED_TABLES).toContain(table);

    // Current ledgers added after the historical branch remain represented;
    // rebuilding this architecture must not regress to that stale subset.
    expect(APPEND_ONLY_TABLES).toEqual(
      expect.arrayContaining([
        'shared.access_logs',
        'event_store.stored_events',
        'event_store.snapshots',
        'farm.tenant_erasure_audit',
        'sensor.vfd_command_audit_logs',
      ]),
    );
  });

  it('leaves the UPDATE blocker absent and the DELETE-only guard present after all up migrations', () => {
    expect(netImpersonationTriggerState()).toEqual({
      update: false,
      delete: true,
    });
  });

  it('makes both baseline tools consume row guards from the same policy projection', () => {
    const generator = readFileSync(
      resolve(REPO_ROOT, 'scripts/migration/baseline-generator.ts'),
      'utf8',
    );
    const apply = readFileSync(
      resolve(REPO_ROOT, 'scripts/migration/apply-audit-immutability.mjs'),
      'utf8',
    );

    for (const source of [generator, apply]) {
      expect(source).toContain('rowGuardTablePoliciesForSchema');
      expect(source).toContain('policy.rowMutation');
      expect(source).toContain('policy.rowDelete');
    }
    expect(generator).not.toContain('PROTECTED_TABLE_NAMES');
    expect(apply).not.toMatch(/tables:\s*\[/);

    const baselineSchemas = new Set(
      [...apply.matchAll(/schema:\s*'([a-z_]+)'/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    );
    const serviceOwnedRowGuardSchemas = new Set(
      PROTECTED_TABLE_POLICIES.flatMap((policy) => {
        const schema = policy.qualifiedName.slice(0, policy.qualifiedName.indexOf('.'));
        if (schema === 'shared') return [];
        return rowGuardTablePoliciesForSchema(schema).some(
          (guarded) => guarded.qualifiedName === policy.qualifiedName,
        )
          ? [schema]
          : [];
      }),
    );

    for (const schema of serviceOwnedRowGuardSchemas) {
      expect(baselineSchemas.has(schema)).toBe(true);
    }
  });
});
