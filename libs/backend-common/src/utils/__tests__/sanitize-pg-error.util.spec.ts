import {
  PG_ERROR_ROW_LEAK_PATTERN,
  assertNoPgRowLeak,
  sanitizePgError,
} from '../sanitize-pg-error.util';

describe('sanitize-pg-error', () => {
  describe('sanitizePgError — row-leak redaction (primary contract)', () => {
    it('redacts Key (col)=(value) pattern from unique-constraint errors', () => {
      const err = {
        message:
          'duplicate key value violates unique constraint "idx_ssn"\n  Key (ssn)=(123-45-6789) already exists.',
        code: '23505',
        constraint: 'idx_ssn',
      };
      const out = sanitizePgError(err);
      expect(out.template).not.toContain('123-45-6789');
      expect(out.template).toContain('Key (<1 col>)=<redacted>');
      expect(out.sqlState).toBe('23505');
      expect(out.constraintName).toBe('idx_ssn');
    });

    it('redacts multi-column Key (c1, c2)=(v1, v2)', () => {
      const err = {
        message:
          'duplicate key value violates unique constraint "idx_composite"\n  Key (tenant_id, email)=(abc-123, leaked@example.com) already exists.',
        code: '23505',
      };
      const out = sanitizePgError(err);
      expect(out.template).not.toContain('abc-123');
      expect(out.template).not.toContain('leaked@example.com');
      expect(out.template).toContain('Key (<2 cols>)=<redacted>');
    });

    it('redacts "Failing row contains (...)" pattern (check-constraint violation)', () => {
      const err = {
        message:
          'new row for relation "payrolls" violates check constraint "chk_salary"\n  Failing row contains (42, jane@example.com, 150000.00, 2026-04-21).',
        code: '23514',
        constraint: 'chk_salary',
        table: 'payrolls',
      };
      const out = sanitizePgError(err);
      expect(out.template).not.toContain('jane@example.com');
      expect(out.template).not.toContain('150000.00');
      expect(out.template).toContain('Failing row contains <redacted>');
    });

    it('redacts DETAIL: lines entirely (catches edge cases)', () => {
      const err = {
        message:
          'ERROR: insert or update on table "orders" violates foreign key constraint\nDETAIL:  Key (customer_id)=(leaked-customer-uuid) is not present in table "customers".',
        code: '23503',
      };
      const out = sanitizePgError(err);
      expect(out.template).not.toContain('leaked-customer-uuid');
      expect(out.template).toContain('DETAIL: <redacted>');
    });

    it('falls back to maskPii for stray PII patterns not wrapped in Key() or Failing row', () => {
      const err = {
        message:
          'ERROR: user user@example.com not found in table "accounts" (phone +1-555-123-4567)',
      };
      const out = sanitizePgError(err);
      expect(out.template).not.toContain('user@example.com');
      expect(out.template).not.toContain('555-123-4567');
      expect(out.template).toContain('[EMAIL-REDACTED]');
    });
  });

  describe('sanitizePgError — structural extraction', () => {
    it('extracts SQLSTATE when in whitelisted prefix', () => {
      const err = { message: 'x', code: '23505' };
      expect(sanitizePgError(err).sqlState).toBe('23505');
    });

    it('masks SQLSTATE to xxx suffix when outside whitelist (oracle prevention)', () => {
      const err = { message: 'x', code: '99999' };
      const out = sanitizePgError(err);
      expect(out.sqlState).toBe('99xxx');
    });

    it('returns null SQLSTATE when missing', () => {
      expect(sanitizePgError({ message: 'x' }).sqlState).toBeNull();
    });

    it('returns null SQLSTATE when code is malformed', () => {
      expect(sanitizePgError({ message: 'x', code: 'notreal' }).sqlState).toBeNull();
    });

    it('builds schema.table relation when both present', () => {
      const err = { message: 'x', schema: 'hr', table: 'payrolls' };
      expect(sanitizePgError(err).relation).toBe('hr.payrolls');
    });

    it('returns table-only relation when schema missing', () => {
      const err = { message: 'x', table: 'payrolls' };
      expect(sanitizePgError(err).relation).toBe('payrolls');
    });

    it('splits column list correctly', () => {
      const err = { message: 'x', column: 'tenant_id, email, created_at' };
      expect(sanitizePgError(err).columns).toEqual([
        'tenant_id',
        'email',
        'created_at',
      ]);
    });

    it('unwraps TypeORM QueryFailedError .driverError', () => {
      const err = {
        message: 'QueryFailedError: duplicate key',
        driverError: {
          message:
            'duplicate key value violates unique constraint "idx"\n  Key (id)=(leak) already exists.',
          code: '23505',
          constraint: 'idx',
        },
      };
      const out = sanitizePgError(err);
      expect(out.constraintName).toBe('idx');
      expect(out.sqlState).toBe('23505');
    });
  });

  describe('sanitizePgError — defensive input handling', () => {
    it('handles string throw', () => {
      const out = sanitizePgError('plain string');
      expect(out.template).toBe('plain string');
      expect(out.sqlState).toBeNull();
    });

    it('handles null / undefined', () => {
      expect(sanitizePgError(null).sqlState).toBeNull();
      expect(sanitizePgError(undefined).sqlState).toBeNull();
    });

    it('handles non-object throw (number)', () => {
      const out = sanitizePgError(42);
      expect(out.template).toBe('42');
    });

    it('truncates runaway templates at 500 chars', () => {
      const long = 'x'.repeat(2000);
      const out = sanitizePgError({ message: long });
      expect(out.template.length).toBeLessThanOrEqual(500);
      expect(out.template.endsWith('...')).toBe(true);
    });
  });

  describe('PG_ERROR_ROW_LEAK_PATTERN + assertNoPgRowLeak', () => {
    it('pattern matches Key (col)=(value)', () => {
      expect(PG_ERROR_ROW_LEAK_PATTERN.test('Key (ssn)=(123)')).toBe(true);
    });

    it('pattern matches Failing row contains (', () => {
      expect(
        PG_ERROR_ROW_LEAK_PATTERN.test('Failing row contains (1, 2, 3)'),
      ).toBe(true);
    });

    it('pattern does NOT match sanitized output', () => {
      const err = {
        message:
          'duplicate key\n  Key (ssn)=(123-45-6789) already exists.',
        code: '23505',
      };
      const out = sanitizePgError(err);
      expect(PG_ERROR_ROW_LEAK_PATTERN.test(out.template)).toBe(false);
    });

    it('assertNoPgRowLeak throws on un-sanitized input', () => {
      expect(() =>
        assertNoPgRowLeak('Key (id)=(leak) exists'),
      ).toThrow(/row-leak pattern/);
    });

    it('assertNoPgRowLeak passes on sanitized input', () => {
      expect(() =>
        assertNoPgRowLeak('Key (<1 col>)=<redacted> exists'),
      ).not.toThrow();
    });
  });
});
