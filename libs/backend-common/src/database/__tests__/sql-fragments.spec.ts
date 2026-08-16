import {
  type SqlFragment,
  type SqlIdent,
  type SqlValue,
  executeSqlFragment,
  sql,
  sqlGuards,
} from '../sql-fragments';

describe('sql-fragments', () => {
  describe('sql.ident — identifier validation (security boundary)', () => {
    it('accepts valid identifiers and quotes them', () => {
      const i = sql.ident('hr');
      expect(i.quoted).toBe('"hr"');
      expect(i.raw).toBe('hr');
      expect(sqlGuards.isIdent(i)).toBe(true);
    });

    it('accepts snake_case + digits + underscores', () => {
      expect(sql.ident('tenant_abc123def456789a').quoted).toBe('"tenant_abc123def456789a"');
      expect(sql.ident('employee_certifications').quoted).toBe('"employee_certifications"');
    });

    it('rejects SQL injection attempts at construction', () => {
      expect(() => sql.ident('hr"; DROP TABLE users; --')).toThrow(/SAFE_IDENT_RE/);
      expect(() => sql.ident("hr'; DROP --")).toThrow(/SAFE_IDENT_RE/);
      expect(() => sql.ident('hr; DROP')).toThrow(/SAFE_IDENT_RE/);
    });

    it('rejects empty string', () => {
      expect(() => sql.ident('')).toThrow(/empty identifier/);
    });

    it('rejects identifiers exceeding 63-char PostgreSQL limit', () => {
      const tooLong = 'a'.repeat(64);
      expect(() => sql.ident(tooLong)).toThrow(/63-char/);
    });

    it('rejects names starting with a digit', () => {
      expect(() => sql.ident('1hr')).toThrow(/SAFE_IDENT_RE/);
    });

    it('rejects spaces + special chars + unicode', () => {
      expect(() => sql.ident('my table')).toThrow(/SAFE_IDENT_RE/);
      expect(() => sql.ident('hr.payrolls')).toThrow(/SAFE_IDENT_RE/);
      expect(() => sql.ident('üzer')).toThrow(/SAFE_IDENT_RE/);
      expect(() => sql.ident('hr-module')).toThrow(/SAFE_IDENT_RE/);
    });

    it('rejects reserved SQL keywords (even when syntactically valid)', () => {
      expect(() => sql.ident('select')).toThrow(/reserved SQL keyword/);
      expect(() => sql.ident('DROP')).toThrow(/reserved SQL keyword/);
      expect(() => sql.ident('Table')).toThrow(/reserved SQL keyword/);
    });

    it('rejects non-string input', () => {
      expect(() => sql.ident(123 as unknown as string)).toThrow(/expected string/);
      expect(() => sql.ident(null as unknown as string)).toThrow();
      expect(() => sql.ident(undefined as unknown as string)).toThrow();
    });
  });

  describe('sql.value — parameterised value', () => {
    it('brands arbitrary values', () => {
      const v = sql.value('some-uuid');
      expect(sqlGuards.isValue(v)).toBe(true);
      expect(v.value).toBe('some-uuid');
    });

    it('accepts null, number, Buffer, Date', () => {
      expect(sql.value(null).value).toBeNull();
      expect(sql.value(42).value).toBe(42);
      const d = new Date();
      expect(sql.value(d).value).toBe(d);
      const b = Buffer.from([0x1, 0x2]);
      expect(sql.value(b).value).toBe(b);
    });
  });

  describe('sql.fragment — tagged-template composition', () => {
    it('inlines SqlIdent as quoted name', () => {
      const schema = sql.ident('hr');
      const table = sql.ident('payrolls');
      const f = sql.fragment`SELECT * FROM ${schema}.${table}`;
      expect(f.sql).toBe('SELECT * FROM "hr"."payrolls"');
      expect(f.params).toEqual([]);
    });

    it('inlines SqlValue as placeholder and collects params', () => {
      const id = sql.value(42);
      const status = sql.value('active');
      const f = sql.fragment`SELECT * FROM t WHERE id = ${id} AND status = ${status}`;
      expect(f.sql).toBe('SELECT * FROM t WHERE id = $1 AND status = $2');
      expect(f.params).toEqual([42, 'active']);
    });

    it('composes nested fragments and rewrites placeholder indices', () => {
      const schema = sql.ident('hr');
      const id = sql.value('tenant-uuid');
      const innerId = sql.value(7);
      const innerFragment = sql.fragment`SELECT ${innerId}`;
      const f = sql.fragment`WITH inner AS (${innerFragment}) UPDATE ${schema}.t SET x = 1 WHERE id = ${id}`;
      expect(f.sql).toBe('WITH inner AS (SELECT $1) UPDATE "hr".t SET x = 1 WHERE id = $2');
      expect(f.params).toEqual([7, 'tenant-uuid']);
    });

    it('handles mixed identifiers, values, and literals', () => {
      const schema = sql.ident('hr');
      const table = sql.ident('employees');
      const col = sql.ident('status');
      const v = sql.value('active');
      const f = sql.fragment`ALTER TABLE ${schema}.${table} ALTER COLUMN ${col} SET DEFAULT ${v}`;
      expect(f.sql).toBe('ALTER TABLE "hr"."employees" ALTER COLUMN "status" SET DEFAULT $1');
      expect(f.params).toEqual(['active']);
    });

    it('runtime-rejects raw-string interpolation (belt-and-braces)', () => {
      // This is a TypeScript compile error, but if someone casts around
      // it, the runtime guard still throws.
      const bad = 'DROP TABLE users; --' as unknown as SqlIdent;
      expect(() => sql.fragment`SELECT * FROM ${bad}`).toThrow(/not an SqlIdent/);
    });

    it('returns a branded SqlFragment detectable by guard', () => {
      const f = sql.fragment`SELECT 1`;
      expect(sqlGuards.isFragment(f)).toBe(true);
    });
  });

  describe('executeSqlFragment — QueryRunner boundary', () => {
    it('calls qr.query with fragment.sql and fragment.params', async () => {
      const query = jest.fn().mockResolvedValue([{ x: 1 }]);
      const schema = sql.ident('hr');
      const id = sql.value('abc');
      const f = sql.fragment`SELECT * FROM ${schema}.t WHERE id = ${id}`;
      const result = await executeSqlFragment({ query }, f);
      expect(query).toHaveBeenCalledWith('SELECT * FROM "hr".t WHERE id = $1', ['abc']);
      expect(result).toEqual([{ x: 1 }]);
    });
  });

  describe('guards — duck-typing safety', () => {
    it('plain objects are not accepted as branded values', () => {
      expect(sqlGuards.isIdent({ quoted: '"hr"', raw: 'hr' })).toBe(false);
      expect(sqlGuards.isValue({ value: 42 })).toBe(false);
      expect(sqlGuards.isFragment({ sql: 'x', params: [] })).toBe(false);
    });

    it('null and primitives reject', () => {
      expect(sqlGuards.isIdent(null)).toBe(false);
      expect(sqlGuards.isIdent('hr')).toBe(false);
      expect(sqlGuards.isIdent(42)).toBe(false);
    });
  });

  describe('TypeScript compile-time guarantees (documented via examples)', () => {
    // These tests are primarily compiled and run; their real value is
    // that TypeScript refuses to compile the commented-out lines.
    it('SqlFragment cannot be constructed from raw string literal', () => {
      // @ts-expect-error — string literal does not satisfy SqlFragment
      const invalid: SqlFragment = 'SELECT * FROM hr';
      expect(invalid).toBeDefined(); // runtime fallback; TS should error first
    });

    it('sql.fragment interpolation refuses raw string type at compile time AND runtime', () => {
      const validIdent = sql.ident('hr');
      // OK path — compiles
      const okFragment = sql.fragment`SELECT FROM ${validIdent}`;
      expect(okFragment.sql).toBeDefined();

      // Raw string interpolation: compile-time rejected + runtime throws
      // (belt-and-braces — even if someone @ts-ignore's around it).
      expect(
        () =>
          // @ts-expect-error — raw string in interpolation slot refused by types
          sql.fragment`SELECT FROM ${'hr'}`,
      ).toThrow(/not an SqlIdent/);
    });

    it('sql.ident requires string (number rejected at compile)', () => {
      // @ts-expect-error — number not assignable to name parameter
      expect(() => sql.ident(42)).toThrow();
    });

    it('SqlValue: accepts unknown, no compile-time restriction on value type', () => {
      const v: SqlValue = sql.value(42);
      expect(v).toBeDefined();
    });
  });
});
