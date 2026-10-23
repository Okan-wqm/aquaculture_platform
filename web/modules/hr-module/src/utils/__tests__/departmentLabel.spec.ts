import { describe, expect, it } from 'vitest';

import { en } from '../../../../../shared-ui/src/i18n/locales/en';
import { tr } from '../../../../../shared-ui/src/i18n/locales/tr';
import { departmentLabel } from '../departmentLabel';
import type { Translate } from '../moduleLabels';

const english: Translate = (key) => en[key];
const turkish: Translate = (key) => tr[key];

describe('departmentLabel', () => {
  it('names the department and the module it belongs to', () => {
    expect(departmentLabel({ name: 'Operations', moduleCode: 'FARM' }, english)).toBe(
      'Operations · Production',
    );
  });

  it('names a department with no module as company-wide', () => {
    expect(departmentLabel({ name: 'Finance', moduleCode: null }, english)).toBe(
      'Finance · Company-wide',
    );
  });

  it("names the module in the reader's language", () => {
    expect(departmentLabel({ name: 'Operasyon', moduleCode: 'FARM' }, turkish)).toBe(
      'Operasyon · Üretim',
    );
  });
});
