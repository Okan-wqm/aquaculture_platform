import { describe, expect, it } from 'vitest';

import { en } from '../../../../../shared-ui/src/i18n/locales/en';
import { tr } from '../../../../../shared-ui/src/i18n/locales/tr';
import { MODULE_CODES, moduleLabel, scopeLabel, type Translate } from '../moduleLabels';

const english: Translate = (key) => en[key];
const turkish: Translate = (key) => tr[key];

describe('moduleLabels', () => {
  it('names each module the way its workspace is named in the console', () => {
    expect(MODULE_CODES.map((code) => moduleLabel(code, english))).toEqual([
      en['nav.workspace.aqua'],
      en['nav.workspace.gh'],
      en['nav.workspace.ctl'],
    ]);
  });

  it('lists every labelled module once, in display order', () => {
    expect(MODULE_CODES).toEqual(['FARM', 'HYDROPONICS', 'SENSOR']);
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
