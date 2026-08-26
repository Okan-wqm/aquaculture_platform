import {
  clearRetentionPolicyRegistry,
  getRetentionPolicy,
  listRetentionPolicies,
  registerRetentionPolicy,
} from '../retention-policy';

describe('RetentionPolicyRegistry', () => {
  beforeEach(() => clearRetentionPolicyRegistry());
  afterEach(() => clearRetentionPolicyRegistry());

  it('registers + lists a single policy', () => {
    registerRetentionPolicy({
      id: 'test.90d',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 'migration_events',
      timestampColumn: 'occurred_at',
      retentionDays: 90,
    });
    expect(listRetentionPolicies()).toHaveLength(1);
    expect(getRetentionPolicy('test.90d')?.retentionDays).toBe(90);
  });

  it('registers an ISO-8601 calendar-period policy', () => {
    registerRetentionPolicy({
      id: 'test.5y',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 'migration_events',
      timestampColumn: 'occurred_at',
      retentionPeriod: 'P5Y',
    });

    expect(getRetentionPolicy('test.5y')?.retentionPeriod).toBe('P5Y');
  });

  it('rejects invalid calendar periods', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.period',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 'migration_events',
        timestampColumn: 'occurred_at',
        retentionPeriod: '5 years',
      }),
    ).toThrow(/ISO-8601/);
  });

  it('rejects unsafe schema identifier', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.schema',
        ownerTag: 'test',
        schema: 'obs"; DROP TABLE x--',
        tableName: 't',
        timestampColumn: 'c',
        retentionDays: 30,
      }),
    ).toThrow(/invalid schema/);
  });

  it('rejects unsafe tableName identifier', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.table',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 'bad"; DROP--',
        timestampColumn: 'c',
        retentionDays: 30,
      }),
    ).toThrow(/invalid tableName/);
  });

  it('rejects unsafe timestampColumn identifier', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.col',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 't',
        timestampColumn: 'c; DROP',
        retentionDays: 30,
      }),
    ).toThrow(/invalid timestampColumn/);
  });

  it('rejects retentionDays < 1', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.days',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 't',
        timestampColumn: 'c',
        retentionDays: 0,
      }),
    ).toThrow(/≥ 1/);
  });

  it('rejects non-integer retentionDays', () => {
    expect(() =>
      registerRetentionPolicy({
        id: 'bad.float',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 't',
        timestampColumn: 'c',
        retentionDays: 30.5,
      }),
    ).toThrow(/integer/);
  });

  it('rejects duplicate policy id — uniqueness is a hard contract', () => {
    registerRetentionPolicy({
      id: 'dup',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 't1',
      timestampColumn: 'c',
      retentionDays: 30,
    });
    expect(() =>
      registerRetentionPolicy({
        id: 'dup',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 't2',
        timestampColumn: 'c',
        retentionDays: 30,
      }),
    ).toThrow(/already registered/);
  });

  it('rejects empty policy.id', () => {
    expect(() =>
      registerRetentionPolicy({
        id: '',
        ownerTag: 'test',
        schema: 'observability',
        tableName: 't',
        timestampColumn: 'c',
        retentionDays: 30,
      }),
    ).toThrow();
  });

  it('clear resets the registry', () => {
    registerRetentionPolicy({
      id: 'a',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 't',
      timestampColumn: 'c',
      retentionDays: 30,
    });
    clearRetentionPolicyRegistry();
    expect(listRetentionPolicies()).toEqual([]);
  });

  it('honors optional legalHoldClause + legalHoldParams', () => {
    registerRetentionPolicy({
      id: 'hold.test',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 'emergency_overrides',
      timestampColumn: 'created_at',
      retentionDays: 2556,
      legalHoldClause: 'revoked_at IS NULL AND expires_at > NOW()',
    });
    const p = getRetentionPolicy('hold.test');
    expect(p?.legalHoldClause).toContain('revoked_at IS NULL');
  });
});
