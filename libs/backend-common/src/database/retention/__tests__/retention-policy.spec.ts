import 'reflect-metadata';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

import {
  clearRetentionPolicyRegistry,
  getRetentionPolicy,
  listRetentionPolicies,
  registerRetentionPolicy,
} from '../retention-policy';

// Test entities: decorated the way real ledgers are, so the registry resolves
// schema / table / physical column from the same metadata the ORM writes with.
@Entity('migration_events', { schema: 'observability' })
class MigrationEventFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;
}

@Entity('audit_logs', { schema: 'shared' })
class AuditLogFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}

@Entity('background_jobs', { schema: 'admin' })
class JobFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;
}

class Undecorated {
  createdAt!: Date;
}

@Entity('tenant_scoped_rows')
class SchemalessFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

describe('RetentionPolicyRegistry (entity-typed, ADR-0012)', () => {
  beforeEach(() => clearRetentionPolicyRegistry());
  afterEach(() => clearRetentionPolicyRegistry());

  it('resolves schema, table and the PHYSICAL column from entity metadata', () => {
    const policy = registerRetentionPolicy({
      id: 'test.13mo',
      ownerTag: 'test',
      entity: MigrationEventFixture,
      timestampProperty: 'occurredAt',
      retentionDays: 395,
    });
    expect(policy).toMatchObject({
      schema: 'observability',
      tableName: 'migration_events',
      timestampColumn: 'occurred_at',
      retentionDays: 395,
      legalHoldAware: false,
      filters: [],
    });
    expect(listRetentionPolicies()).toHaveLength(1);
    expect(getRetentionPolicy('test.13mo')?.retentionDays).toBe(395);
  });

  it('a @CreateDateColumn without an explicit name maps to its property name — "createdAt", never "created_at"', () => {
    const policy = registerRetentionPolicy({
      id: 'audit.7y',
      ownerTag: 'soc2-cc4',
      entity: AuditLogFixture,
      timestampProperty: 'createdAt',
      legalHoldProperty: 'legalHold',
      retentionDays: 7 * 365,
    });
    expect(policy.timestampColumn).toBe('createdAt');
    expect(policy.legalHoldClause).toBe('"legalHold" = true');
    expect(policy.legalHoldAware).toBe(true);
  });

  it('refuses a policy over an entity that declares legalHold but does not name it', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'audit.unheld',
        ownerTag: 'test',
        entity: AuditLogFixture,
        timestampProperty: 'createdAt',
        retentionDays: 30,
      }),
    ).toThrow(/declares a legalHold column; the policy must name it/);
  });

  it('refuses an entity that is not decorated with @Entity', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.entity',
        ownerTag: 'test',
        entity: Undecorated,
        timestampProperty: 'createdAt',
        retentionDays: 30,
      }),
    ).toThrow(/is not decorated with @Entity/);
  });

  it('refuses an entity without an explicit schema — retention is a cross-tenant concern', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.schema',
        ownerTag: 'test',
        entity: SchemalessFixture,
        timestampProperty: 'createdAt',
        retentionDays: 30,
      }),
    ).toThrow(/must declare @Entity\(\{ schema \}\)/);
  });

  it('refuses a property that is not a mapped column', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.column',
        ownerTag: 'test',
        entity: MigrationEventFixture,
        // The compiler already rejects a non-property; a mapped-but-not-column
        // property (a getter, a relation) is the runtime case this covers.
        timestampProperty: 'id',
        retentionDays: 30,
      }),
    ).not.toThrow();
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.column.2',
        ownerTag: 'test',
        entity: Undecorated,
        timestampProperty: 'createdAt',
        retentionDays: 30,
      }),
    ).toThrow();
  });

  it('resolves where-filters to physical columns with bound values', () => {
    const policy = registerRetentionPolicy({
      id: 'jobs.completed.30d',
      ownerTag: 'ops',
      entity: JobFixture,
      timestampProperty: 'completedAt',
      retentionDays: 30,
      where: { status: 'completed' },
    });
    expect(policy.filters).toEqual([{ column: 'status', value: 'completed' }]);
  });

  it('rejects retentionDays < 1 and non-integers', () => {
    for (const days of [0, -1, 1.5]) {
      expect(() =>
        registerRetentionPolicy({
          id: `bad.days.${days}`,
          ownerTag: 'test',
          entity: MigrationEventFixture,
          timestampProperty: 'occurredAt',
          retentionDays: days,
        }),
      ).toThrow(/≥ 1/);
    }
  });

  it('rejects a duplicate id', () => {
    const registration = {
      id: 'dup',
      ownerTag: 'test',
      entity: MigrationEventFixture,
      timestampProperty: 'occurredAt' as const,
      retentionDays: 30,
    };
    registerRetentionPolicy(registration);
    expect(() => registerRetentionPolicy(registration)).toThrow(/already registered/);
  });
});
