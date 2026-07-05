/**
 * regulatoryIdentity + reportPeriod SSoT specs (FARM-HIGH-127/128).
 *
 * Locks the fail-closed identity contract that replaces the silent
 * `lokalitetsnummer: mapping?.lokalitetsnummer || 0` the REST tabs used to ship,
 * and the 0-vs-1-indexed month conversion the monthly tabs used to disagree on.
 */
import { describe, expect, it } from 'vitest';
import { buildRegulatoryIdentity, RegulatoryConfigError } from '../regulatoryIdentity';
import { toBackendReportMonth, fromBackendReportMonth } from '../reportPeriod';
import type { RegulatorySettings } from '../../../../hooks/useRegulatory';

const FULL: RegulatorySettings = {
  organisationNumber: '987654321',
  defaultContactName: 'Ola Nordmann',
  defaultContactEmail: 'ola@farm.no',
  defaultContactPhone: '+4798989898',
  siteLocalityMappings: [
    { siteId: 'site-1', lokalitetsnummer: 12345 },
    { siteId: 'site-2', lokalitetsnummer: 67890 },
  ],
} as RegulatorySettings;

describe('buildRegulatoryIdentity (fail-closed)', () => {
  it('resolves the real lokalitetsnummer for a mapped site — never 0', () => {
    const id = buildRegulatoryIdentity(FULL, 'site-2');
    expect(id.lokalitetsnummer).toBe(67890);
    expect(id.organisasjonsnummer).toBe('987654321');
    expect(id.kontaktperson).toEqual({
      navn: 'Ola Nordmann',
      epost: 'ola@farm.no',
      telefonnummer: '+4798989898',
    });
  });

  it('THROWS instead of shipping lokalitetsnummer 0 when the site has no mapping', () => {
    expect(() => buildRegulatoryIdentity(FULL, 'site-unmapped')).toThrow(RegulatoryConfigError);
    expect(() => buildRegulatoryIdentity(FULL, '')).toThrow(/locality number/i);
  });

  it('THROWS when the org number or contact is unconfigured', () => {
    const noOrg = { ...FULL, organisationNumber: '' } as RegulatorySettings;
    expect(() => buildRegulatoryIdentity(noOrg, 'site-1')).toThrow(/organisation number/i);
    const noContact = { ...FULL, defaultContactName: '', defaultContactEmail: '' } as RegulatorySettings;
    expect(() => buildRegulatoryIdentity(noContact, 'site-1')).toThrow(/contact/i);
  });

  it('guarantees telefonnummer is a string even when unconfigured', () => {
    const noPhone = { ...FULL, defaultContactPhone: undefined } as RegulatorySettings;
    expect(buildRegulatoryIdentity(noPhone, 'site-1').kontaktperson.telefonnummer).toBe('');
  });

  it('THROWS when settings are not loaded yet (never a silent 0)', () => {
    expect(() => buildRegulatoryIdentity(undefined, 'site-1')).toThrow(RegulatoryConfigError);
  });
});

describe('toBackendReportMonth (0-indexed form → 1–12 backend)', () => {
  it('maps January(0)→1 and December(11)→12', () => {
    expect(toBackendReportMonth(0)).toBe(1);
    expect(toBackendReportMonth(11)).toBe(12);
  });
  it('round-trips with fromBackendReportMonth', () => {
    for (let m = 0; m < 12; m++) {
      expect(fromBackendReportMonth(toBackendReportMonth(m))).toBe(m);
    }
  });
});
