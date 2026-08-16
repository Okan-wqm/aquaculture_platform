import {
  ADMIN_CONTROL_CHARACTER_FREE_PATTERN,
  replaceAdminControlCharacters,
} from './admin-text-boundary';

describe('admin text boundary', () => {
  it('admits operator-visible Unicode while rejecting every Unicode control code', () => {
    expect(ADMIN_CONTROL_CHARACTER_FREE_PATTERN.test('İşlem.Query_üretim')).toBe(true);
    expect(ADMIN_CONTROL_CHARACTER_FREE_PATTERN.test('Query.farms\nMutation.deleteFarm')).toBe(
      false,
    );
    expect(
      ADMIN_CONTROL_CHARACTER_FREE_PATTERN.test(`Query.farms${String.fromCharCode(0x85)}`),
    ).toBe(false);
  });

  it('normalizes the same control-code class at the error-envelope boundary', () => {
    expect(replaceAdminControlCharacters(`bad\u0000line\nnext${String.fromCharCode(0x85)}`)).toBe(
      'bad line next ',
    );
  });
});
