/**
 * The Postgres type name an enum column lives under.
 *
 * TypeORM derives it as `<table>_<column lowercased>_enum`. The drift validator looks the type up by
 * that name; a derivation that kept the column's case looked for `departments_hr_moduleCode_enum`,
 * found no such type, and so never compared the labels of ANY camelCase enum column (a label an
 * entity added without ALTER TYPE ... ADD VALUE hid behind the same "type missing" noise).
 */
import { resolveEnumTypeName } from '../enum-type-name';

describe('resolveEnumTypeName', () => {
  it('uses the explicit type name when the column declares one', () => {
    expect(resolveEnumTypeName('employees_laborcategory_enum', 'employees', 'laborCategory')).toBe(
      'employees_laborcategory_enum',
    );
  });

  it('lowercases a camelCase column the way TypeORM does', () => {
    expect(resolveEnumTypeName(undefined, 'departments_hr', 'moduleCode')).toBe(
      'departments_hr_modulecode_enum',
    );
    expect(resolveEnumTypeName(undefined, 'employees', 'employmentType')).toBe(
      'employees_employmenttype_enum',
    );
  });

  it('leaves an already-lowercase column alone', () => {
    expect(resolveEnumTypeName(undefined, 'employees', 'status')).toBe('employees_status_enum');
  });

  it('keeps the table name as it is (TypeORM does not lowercase it)', () => {
    expect(resolveEnumTypeName(undefined, 'Audit_Log', 'level')).toBe('Audit_Log_level_enum');
  });

  it('treats an empty explicit name as absent', () => {
    expect(resolveEnumTypeName('', 'employees', 'status')).toBe('employees_status_enum');
  });
});
