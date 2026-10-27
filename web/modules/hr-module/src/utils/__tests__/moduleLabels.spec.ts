import { describe, expect, it } from 'vitest';

import { en } from '../../../../../shared-ui/src/i18n/locales/en';
import { tr } from '../../../../../shared-ui/src/i18n/locales/tr';
import {
  ASSIGNABLE_MODULE_CODES,
  MODULE_CODES,
  moduleChoicesFor,
  moduleLabel,
  scopeLabel,
  type Translate,
} from '../moduleLabels';

const english: Translate = (key) => en[key];
const turkish: Translate = (key) => tr[key];

describe('moduleLabels', () => {
  it('names each module the way its workspace is named in the console, and HR by its module', () => {
    expect(MODULE_CODES.map((code) => moduleLabel(code, english))).toEqual([
      en['nav.workspace.aqua'],
      en['nav.workspace.gh'],
      en['nav.workspace.ctl'],
      en['hr.module.hr'],
    ]);
  });

  it('lists every labelled module once, in display order', () => {
    expect(MODULE_CODES).toEqual(['FARM', 'HYDROPONICS', 'SENSOR', 'HR']);
  });

  // WHY: release R1 adds HR to the wire enum; contract rule C1 lets the web send it from R2
  // (PKG-01 PR2, RBAC-MEDIUM-032), which changes this expectation to MODULE_CODES.
  it('offers a department every labelled module but HR, the value R1 adds to the wire', () => {
    expect(ASSIGNABLE_MODULE_CODES).toEqual(['FARM', 'HYDROPONICS', 'SENSOR']);
  });

  it('offers a department its own module even when that module is not assignable', () => {
    expect(moduleChoicesFor('HR')).toEqual(['FARM', 'HYDROPONICS', 'SENSOR', 'HR']);
    expect(moduleChoicesFor('SENSOR')).toEqual(ASSIGNABLE_MODULE_CODES);
    expect(moduleChoicesFor(null)).toEqual(ASSIGNABLE_MODULE_CODES);
    expect(moduleChoicesFor(undefined)).toEqual(ASSIGNABLE_MODULE_CODES);
  });

  it('labels a module code by its module name', () => {
    expect(moduleLabel('HYDROPONICS', english)).toBe('Greenhouse');
  });

  it('labels no module — null or absent — as company-wide', () => {
    expect(moduleLabel(null, english)).toBe('Company-wide');
    expect(moduleLabel(undefined, english)).toBe('Company-wide');
  });

  it('names the scope of a screen: its module, or every module', () => {
    expect(scopeLabel('SENSOR', english)).toBe('Control & sensors');
    expect(scopeLabel(null, english)).toBe('All modules');
    expect(scopeLabel(undefined, english)).toBe('All modules');
  });

  it("speaks the reader's language, module names included", () => {
    expect(moduleLabel('FARM', turkish)).toBe('Üretim');
    expect(moduleLabel(null, turkish)).toBe('Şirket geneli');
    expect(scopeLabel(null, turkish)).toBe('Tüm modüller');
  });
});
