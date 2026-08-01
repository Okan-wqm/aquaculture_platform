import { describe, expect, it } from 'vitest';

import type { MonitoringMultiPolygon } from '../../../../hooks/useSites';
import type { SiteFormData } from '../../components/SiteFormModal';
import { buildSiteMutationInput } from '../SitesTab';

const MULTI_POLYGON: MonitoringMultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [5.2, 60.2],
        [5.3, 60.2],
        [5.3, 60.3],
        [5.2, 60.2],
      ],
    ],
  ],
};

const FORM_DATA: SiteFormData = {
  name: 'North Cage',
  code: 'NC-1',
  type: 'SEA_CAGE',
  lokalitetsnummer: 12345,
  organisationNumberOverride: '987654321',
  description: 'North production cage',
  status: 'ACTIVE',
  country: 'Norway',
  region: 'Vestland',
  timezone: 'Europe/Oslo',
  totalArea: 2400,
  siteManager: 'Ola Nordmann',
  contactEmail: 'ola@example.test',
  contactPhone: '+4712345678',
  address: {
    street: 'Pier 1',
    city: 'Bergen',
    state: 'Vestland',
    postalCode: '5003',
  },
  location: { latitude: 60.39, longitude: 5.32, altitude: 8 },
  monitoringRadiusM: 4000,
  monitoringArea: MULTI_POLYGON,
};

describe('buildSiteMutationInput', () => {
  it('preserves all site fields in the API input', () => {
    expect(buildSiteMutationInput(FORM_DATA, false)).toEqual({
      name: 'North Cage',
      code: 'NC-1',
      type: 'SEA_CAGE',
      lokalitetsnummer: 12345,
      organisationNumberOverride: '987654321',
      description: 'North production cage',
      status: 'ACTIVE',
      country: 'Norway',
      region: 'Vestland',
      timezone: 'Europe/Oslo',
      totalArea: 2400,
      siteManager: 'Ola Nordmann',
      contactEmail: 'ola@example.test',
      contactPhone: '+4712345678',
      address: {
        street: 'Pier 1',
        city: 'Bergen',
        state: 'Vestland',
        postalCode: '5003',
        country: 'Norway',
      },
      location: { latitude: 60.39, longitude: 5.32, altitude: 8 },
      monitoringRadiusM: 4000,
      monitoringArea: MULTI_POLYGON,
    });
  });

  it('uses explicit nulls when an update clears persisted nullable fields', () => {
    const clearedFields: SiteFormData = {
      ...FORM_DATA,
      lokalitetsnummer: '',
      organisationNumberOverride: '',
      description: '',
      country: '',
      region: '',
      totalArea: '',
      siteManager: '',
      contactEmail: '',
      contactPhone: '',
      address: { street: '', city: '', state: '', postalCode: '' },
      location: { latitude: '', longitude: '', altitude: '' },
      monitoringArea: null,
    };

    const createInput = buildSiteMutationInput(clearedFields, false);
    expect(createInput).not.toHaveProperty('monitoringArea');
    expect(createInput).not.toHaveProperty('location');
    expect(createInput).not.toHaveProperty('address');

    expect(buildSiteMutationInput(clearedFields, true)).toEqual(
      expect.objectContaining({
        lokalitetsnummer: null,
        organisationNumberOverride: null,
        description: null,
        country: null,
        region: null,
        totalArea: null,
        siteManager: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        location: null,
        monitoringArea: null,
      }),
    );
  });
});
