import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseLeastPrivilegeRoleAuthority } from '../least-privilege-role-authority';

const STAGE_008 = resolve(
  __dirname,
  '..',
  'sql',
  'platform-bootstrap',
  '008-least-privilege-hardening.sql',
);

function sqlWithRoleRows(rows: ReadonlyArray<Record<string, unknown>>): string {
  return `SELECT * FROM jsonb_to_recordset('${JSON.stringify(rows)}'::jsonb)`;
}

describe('least-privilege role authority compiler', () => {
  it('derives the config owner/runtime boundary from stage 008 without a copied role map', () => {
    const specs = parseLeastPrivilegeRoleAuthority(readFileSync(STAGE_008, 'utf8'), STAGE_008);

    expect(specs).toHaveLength(15);
    expect(specs.find((spec) => spec.schema_name === 'config')).toEqual({
      schema_name: 'config',
      owner_role: 'config_schema_owner',
      runtime_role: 'config_service',
      provisioner_role: null,
    });
  });

  it('rejects empty and structurally incomplete authorities', () => {
    expect(() => parseLeastPrivilegeRoleAuthority(sqlWithRoleRows([]))).toThrow(
      'compiled to an empty role map',
    );
    expect(() =>
      parseLeastPrivilegeRoleAuthority(sqlWithRoleRows([{ schema_name: 'config' }])),
    ).toThrow('outside the strict role schema');
  });

  it('rejects duplicate mutation coordinates', () => {
    const config = {
      schema_name: 'config',
      owner_role: 'config_schema_owner',
      runtime_role: 'config_service',
      provisioner_role: null,
    };
    expect(() =>
      parseLeastPrivilegeRoleAuthority(
        sqlWithRoleRows([
          config,
          {
            ...config,
            owner_role: 'other_schema_owner',
            runtime_role: 'other_service',
          },
        ]),
      ),
    ).toThrow('duplicates schema coordinate "config"');
  });
});
