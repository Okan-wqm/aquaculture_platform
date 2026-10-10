import { describe, expect, it } from 'vitest';

import { fromGraphqlEnumName, toGraphqlEnumName } from '../graphql-enum';

/**
 * FE-HIGH-309: backend TS enums carry lower-case VALUES ('disinfectant'),
 * while the GraphQL wire protocol takes and returns enum NAMES
 * ('DISINFECTANT'). Forms hold values, so requests failed with
 * `Value "disinfectant" does not exist in "ChemicalType" enum`.
 */
describe('graphql enum bridge', () => {
  it('maps a form value to the GraphQL enum name for requests', () => {
    expect(toGraphqlEnumName('disinfectant')).toBe('DISINFECTANT');
    expect(toGraphqlEnumName('small_size')).toBe('SMALL_SIZE');
  });

  it('maps a GraphQL enum name back to the form value for responses', () => {
    expect(fromGraphqlEnumName('WOUND_CARE')).toBe('wound_care');
  });

  it('round-trips a value', () => {
    expect(fromGraphqlEnumName(toGraphqlEnumName('ph_adjuster'))).toBe('ph_adjuster');
  });

  it('leaves an absent value absent instead of sending an empty enum name', () => {
    expect(toGraphqlEnumName('')).toBeUndefined();
    expect(toGraphqlEnumName(null)).toBeUndefined();
    expect(fromGraphqlEnumName(undefined)).toBeUndefined();
  });
});
