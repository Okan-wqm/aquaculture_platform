import { BadRequestException } from '@nestjs/common';

import { validateSqlIdentifier } from '../sql-identifier.util';

describe('validateSqlIdentifier', () => {
  it('accepts simple alphanumeric schema names', () => {
    expect(validateSqlIdentifier('tenant_abc123', 'schema')).toBe('tenant_abc123');
  });

  it('accepts identifiers starting with underscore', () => {
    expect(validateSqlIdentifier('_internal_view', 'table')).toBe('_internal_view');
  });

  it('accepts identifiers at the 63-char Postgres NAMEDATALEN cap', () => {
    const id = 'a'.repeat(63);
    expect(validateSqlIdentifier(id, 'table')).toBe(id);
  });

  it.each([
    ['', 'empty string'],
    ['1leading_digit', 'leading digit'],
    ['contains-hyphen', 'hyphen'],
    ['contains.dot', 'dot'],
    ['has space', 'space'],
    ['has"quote', 'double-quote'],
    ['ends_with;', 'semicolon'],
    ['drop_then--inject', 'comment marker'],
    ['unicode_émoji', 'non-ASCII'],
  ])('rejects %s (%s)', (input) => {
    expect(() => validateSqlIdentifier(input, 'schema')).toThrow(BadRequestException);
  });

  it('rejects identifier longer than 63 chars (Postgres NAMEDATALEN)', () => {
    const tooLong = 'a'.repeat(64);
    expect(() => validateSqlIdentifier(tooLong, 'table')).toThrow(BadRequestException);
  });

  it('error message names the rejected identifier and the kind', () => {
    expect.assertions(2);
    try {
      validateSqlIdentifier('bad-name;', 'index');
    } catch (e) {
      expect((e as Error).message).toContain('bad-name;');
      expect((e as Error).message).toContain('index');
    }
  });

  it('accepts each documented kind value', () => {
    expect(validateSqlIdentifier('s', 'schema')).toBe('s');
    expect(validateSqlIdentifier('t', 'table')).toBe('t');
    expect(validateSqlIdentifier('c', 'column')).toBe('c');
    expect(validateSqlIdentifier('i', 'index')).toBe('i');
    expect(validateSqlIdentifier('r', 'role')).toBe('r');
  });

  it('uses default kind=schema when no kind argument supplied', () => {
    expect.assertions(1);
    try {
      validateSqlIdentifier('bad name');
    } catch (e) {
      expect((e as Error).message).toContain('schema');
    }
  });
});
