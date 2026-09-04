import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MonitoringPolygon, Site } from '../../../../hooks/useSites';
import { SiteFormModal } from '../SiteFormModal';

vi.mock('@aquaculture/shared-ui', () => ({
  Modal: ({ isOpen, title, children }: { isOpen: boolean; title?: string; children: ReactNode }) =>
    isOpen ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

vi.mock('../SiteContactsSection', () => ({
  default: () => <div data-testid="site-contacts" />,
}));

const POLYGON: MonitoringPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [5.0, 60.1],
      [5.4, 60.1],
      [5.4, 60.4],
      [5.0, 60.4],
      [5.0, 60.1],
    ],
  ],
};

describe('SiteFormModal', () => {
  it('submits a sea-cage site with the complete monitoring and regulatory identity', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<SiteFormModal isOpen onClose={vi.fn()} onSave={onSave} site={null} />);

    // W5: a new site starts INHERITED, not on a hardcoded zone. The column is
    // nullable precisely so "the operator chose UTC" and "the operator chose
    // nothing" stop being the same value; defaulting the form to a concrete
    // zone would put the ambiguity straight back. Picking a zone below is the
    // deliberate act the payload assertion then checks.
    expect(screen.getByLabelText('Timezone')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Timezone'), 'Europe/Oslo');

    await user.type(screen.getByLabelText(/^Site Name/), 'Bergen North');
    await user.type(screen.getByLabelText(/^Site Code/), 'bgn-01');
    await user.selectOptions(screen.getByLabelText('Site Type'), 'SEA_CAGE');
    await user.type(screen.getByLabelText('Lokalitetsnummer'), '12345');
    await user.type(screen.getByLabelText('Organisation Number Override'), '987654321');
    await user.type(screen.getByLabelText('Total Area (m²)'), '12500');

    await user.click(screen.getByRole('button', { name: 'Location Info' }));
    await user.type(screen.getByLabelText('Country'), 'Norway');
    await user.type(screen.getByLabelText('Region'), 'Vestland');
    await user.type(screen.getByLabelText('Latitude'), '60.3913');
    await user.type(screen.getByLabelText('Longitude'), '5.3221');
    await user.clear(screen.getByLabelText('Monitoring Radius (m)'));
    await user.type(screen.getByLabelText('Monitoring Radius (m)'), '3500');
    fireEvent.change(screen.getByLabelText('Monitoring Area GeoJSON'), {
      target: { value: JSON.stringify(POLYGON) },
    });

    await user.click(screen.getByRole('button', { name: 'Contact Info' }));
    await user.type(screen.getByLabelText('Site Manager'), 'Ada Nordmann');

    await user.click(screen.getByRole('button', { name: 'Create Site' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Bergen North',
        code: 'BGN-01',
        type: 'SEA_CAGE',
        lokalitetsnummer: 12345,
        organisationNumberOverride: '987654321',
        timezone: 'Europe/Oslo',
        totalArea: 12500,
        country: 'Norway',
        region: 'Vestland',
        siteManager: 'Ada Nordmann',
        location: { latitude: 60.3913, longitude: 5.3221, altitude: '' },
        monitoringRadiusM: 3500,
        monitoringArea: POLYGON,
      }),
    );
  });

  it('fails closed when a sea cage has no valid coordinate, radius, or GeoJSON geometry', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<SiteFormModal isOpen onClose={vi.fn()} onSave={onSave} site={null} />);

    await user.type(screen.getByLabelText(/^Site Name/), 'Invalid Cage');
    await user.type(screen.getByLabelText(/^Site Code/), 'bad');
    await user.selectOptions(screen.getByLabelText('Site Type'), 'SEA_CAGE');
    await user.click(screen.getByRole('button', { name: 'Location Info' }));
    await user.type(screen.getByLabelText('Latitude'), '91');
    await user.type(screen.getByLabelText('Longitude'), '-181');
    await user.clear(screen.getByLabelText('Monitoring Radius (m)'));
    await user.type(screen.getByLabelText('Monitoring Radius (m)'), '20001');
    fireEvent.change(screen.getByLabelText('Monitoring Area GeoJSON'), {
      target: { value: '{"type":"Point"}' },
    });
    await user.click(screen.getByRole('button', { name: 'Create Site' }));

    expect(screen.getByText('Latitude must be between -90 and 90')).toBeInTheDocument();
    expect(screen.getByText('Longitude must be between -180 and 180')).toBeInTheDocument();
    expect(
      screen.getByText('Monitoring radius must be a whole number between 100 and 20000 metres'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Use a Polygon or MultiPolygon geometry, not a Feature or extra properties.',
      ),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('hydrates every persisted field including the areaM2-backed totalArea contract', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const site: Site = {
      id: 'site-1',
      name: 'Existing Cage',
      code: 'CAGE-1',
      type: 'SEA_CAGE',
      status: 'ACTIVE',
      description: 'Existing description',
      lokalitetsnummer: 54321,
      organisationNumberOverride: '123456789',
      location: { latitude: 60.2, longitude: 5.1, altitude: 14 },
      address: {
        street: 'Harbour 1',
        city: 'Bergen',
        state: 'Vestland',
        postalCode: '5003',
        country: 'Norway',
      },
      country: 'Norway',
      region: 'Vestland',
      timezone: 'Europe/Oslo',
      totalArea: 4321,
      siteManager: 'Existing Manager',
      contactEmail: 'manager@example.test',
      contactPhone: '+4712345678',
      monitoringRadiusM: 2500,
      monitoringArea: POLYGON,
      monitoringLocationRevision: 7,
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    };

    render(<SiteFormModal isOpen onClose={vi.fn()} onSave={onSave} site={site} />);
    await user.click(screen.getByRole('button', { name: 'Update Site' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SEA_CAGE',
        organisationNumberOverride: '123456789',
        region: 'Vestland',
        totalArea: 4321,
        siteManager: 'Existing Manager',
        monitoringRadiusM: 2500,
        monitoringArea: POLYGON,
        location: { latitude: 60.2, longitude: 5.1, altitude: 14 },
      }),
    );
  });
});
