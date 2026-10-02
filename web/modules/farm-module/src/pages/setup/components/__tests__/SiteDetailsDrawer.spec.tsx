import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { Site } from '../../../../hooks/useSites';
import { SiteDetailsDrawer } from '../SiteDetailsDrawer';

/**
 * FE-MEDIUM-310: "View Details" is a read. The drawer renders the record the
 * list already holds and offers nothing to edit or save.
 */
const SITE: Site = {
  id: 'site-1',
  name: 'Bergen North',
  code: 'BGN-01',
  lokalitetsnummer: 12345,
  type: 'SEA_CAGE',
  status: 'ACTIVE',
  description: 'North production site',
  location: { latitude: 60.391263, longitude: 5.322054 },
  address: { street: 'Kaiveien 1', postalCode: '5003', city: 'Bergen', country: 'Norway' },
  country: 'Norway',
  region: 'Vestland',
  timezone: null,
  totalArea: 2500,
  monitoringRadiusM: 1000,
  monitoringLocationRevision: 1,
  siteManager: 'Kari Nordmann',
  contactEmail: 'site@example.test',
  contactPhone: null,
  isActive: true,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

function detail(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const row = term.parentElement;
  if (row === null) throw new Error(`no row for ${label}`);
  return within(row).getByRole('definition');
}

describe('SiteDetailsDrawer', () => {
  it('renders the site record read-only', () => {
    render(<SiteDetailsDrawer site={SITE} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Bergen North')).toBeInTheDocument();
    expect(detail('Code')).toHaveTextContent('BGN-01');
    expect(detail('Lokalitetsnummer')).toHaveTextContent('12345');
    expect(detail('Address')).toHaveTextContent('Kaiveien 1, 5003 Bergen, Norway');
    expect(detail('Coordinates')).toHaveTextContent('60.39126, 5.32205');
    expect(detail('Timezone')).toHaveTextContent('Inherited from the tenant');
    expect(detail('Contact phone')).toHaveTextContent('Not set');

    // Nothing to type into and no save path.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('closes through its close control', async () => {
    const onClose = vi.fn();
    render(<SiteDetailsDrawer site={SITE} onClose={onClose} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without a site', () => {
    render(<SiteDetailsDrawer site={null} onClose={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
