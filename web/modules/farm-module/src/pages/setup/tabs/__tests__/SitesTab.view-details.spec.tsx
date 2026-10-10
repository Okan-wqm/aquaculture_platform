import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { Site } from '../../../../hooks/useSites';

/**
 * FE-MEDIUM-310: "View Details" opened the site EDIT form (#1670 pointed it
 * at handleEdit), a write surface shown even to users without updateSite. It
 * now opens the read-only details drawer for every viewer; the edit form opens
 * only from the permission-gated edit button.
 */
const canMutate = vi.hoisted(() => ({ value: false }));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aquaculture/shared-ui')>()),
  useCanMutate: () => canMutate.value,
}));

const SITE: Site = {
  id: 'site-1',
  name: 'Bergen North',
  code: 'BGN-01',
  type: 'SEA_CAGE',
  status: 'ACTIVE',
  region: 'Vestland',
  country: 'Norway',
  totalArea: 2500,
  monitoringRadiusM: 1000,
  monitoringLocationRevision: 1,
  isActive: true,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const idleMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock('../../../../hooks/useSites', () => ({
  useSiteList: () => ({
    data: { items: [SITE], total: 1 },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateSite: () => idleMutation,
  useUpdateSite: () => idleMutation,
  useDeleteSite: () => idleMutation,
  useSiteDeletePreview: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('../../components/SiteFormModal', () => ({
  SiteFormModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <form aria-label="site edit form" /> : null,
}));

import { SitesTab } from '../SitesTab';

describe('SitesTab View Details', () => {
  beforeEach(() => {
    canMutate.value = false;
  });

  it('opens the read-only details for a user who cannot update sites', async () => {
    render(<SitesTab />);

    await userEvent.setup().click(screen.getByRole('button', { name: /View Details/ }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Bergen North');
    expect(screen.getByRole('dialog')).toHaveTextContent('BGN-01');
    expect(screen.queryByRole('form', { name: 'site edit form' })).toBeNull();
  });

  it('keeps the edit form behind the edit button for a user who can update sites', async () => {
    canMutate.value = true;
    render(<SitesTab />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /View Details/ }));
    expect(screen.queryByRole('form', { name: 'site edit form' })).toBeNull();

    await user.click(screen.getByTitle('Edit'));
    expect(screen.getByRole('form', { name: 'site edit form' })).toBeInTheDocument();
  });
});
