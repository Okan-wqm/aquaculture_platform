import { resolveUpsertOverwriteColumns } from '../upsert-configuration.handler';

describe('resolveUpsertOverwriteColumns', () => {
  it('preserves the stored value_type on a non-secret upsert', () => {
    // The public setConfiguration mutation carries no valueType argument. A
    // plain write must not downgrade a seeded number/boolean/json row to
    // string, or typed consumers of getTypedValue() silently regress to raw
    // strings.
    expect(resolveUpsertOverwriteColumns(false)).not.toContain('value_type');
  });

  it('stamps value_type on a secret upsert so redaction is enforced by type', () => {
    expect(resolveUpsertOverwriteColumns(true)).toContain('value_type');
  });

  it('always overwrites the value, audit actor and tombstone lifecycle columns', () => {
    for (const isSecret of [true, false]) {
      const columns = resolveUpsertOverwriteColumns(isSecret);
      for (const expected of [
        'value',
        'is_secret',
        'updated_by',
        'updated_at',
        'is_active',
        'deleted_at',
        'deleted_by',
        'delete_reason',
        'retention_until',
        'suppress_fallback',
      ]) {
        expect(columns).toContain(expected);
      }
    }
  });
});
