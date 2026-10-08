/**
 * Sources tab: a reader sees where each parameter is read at the point and
 * cannot change it; a writer unbinding a primary is told which backup took
 * over (the promoted row the unbind answers with).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const permissions = vi.hoisted(() => ({ canMutate: true }));

vi.mock('@aquaculture/shared-ui', async () => ({
  ...(await (await import('../../../../../test-utils/sharedUiMock')).createSharedUiMock()),
  useCanMutate: () => permissions.canMutate,
}));
// The picker's own lists (sites, systems, tanks, equipment) are not under test here.
vi.mock('../PointPicker', () => ({ PointPicker: () => null }));

import { confirmMock } from '../../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../../test-utils/renderWithProviders';
import { SourcesTab } from '../SourcesTab';

import { channelSource, parameterConfig, sourceAtPoint, TANK_ID } from './sourceFixtures';

const TAN = { id: 'p-tan', code: 'tan', name: 'TAN' };
const PRIMARY = channelSource('s-primary', TAN, 'tan_probe_a', 'PRIMARY');
const BACKUP = channelSource('s-backup', TAN, 'tan_probe_b', 'BACKUP');

function routes(): void {
  routeGraphql([
    {
      match: 'query ParameterConfigs',
      result: { parameterConfigs: [parameterConfig(TAN.id, TAN.code, TAN.name, 'tan')] },
    },
    {
      match: 'query ParameterSourcesAtPoint',
      result: {
        parameterSourcesAtPoint: [
          sourceAtPoint(PRIMARY, TAN, 0.41),
          sourceAtPoint(BACKUP, TAN, 0.44, ['CHANNEL_DISABLED']),
        ],
      },
    },
    {
      match: 'query WaterChemistryInputs',
      result: {
        waterChemistryInputs: {
          set: 'TOXICITY',
          point: { kind: 'TANK', id: TANK_ID },
          asOf: '2026-10-08T10:00:00.000Z',
          verdict: 'INCOMPLETE',
          problems: ['INPUTS_INCOMPLETE'],
          systemType: null,
          volumeM3: null,
          tankWaterM3: null,
          inputs: [],
        },
      },
    },
    {
      match: 'mutation UnbindParameterChannel',
      result: {
        unbindParameterChannel: { unbound: PRIMARY, promoted: { ...BACKUP, priority: 'PRIMARY' } },
      },
    },
  ]);
}

function renderTab(): void {
  renderWithProviders(<SourcesTab />, {
    route: `/water-chemistry?tab=sources&point=tank:${TANK_ID}`,
    path: 'water-chemistry',
  });
}

describe('SourcesTab', () => {
  beforeEach(() => {
    routes();
    confirmMock.mockResolvedValue(true);
  });

  it('shows a reader where each parameter is read, and offers no write', async () => {
    permissions.canMutate = false;
    renderTab();

    const row = await screen.findByText('TAN', { selector: 'div' });
    const tableRow = row.closest('tr');
    expect(tableRow).not.toBeNull();
    expect(within(tableRow as HTMLElement).getByText('0.41')).toBeInTheDocument();
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    // The backup's problem is shown in words.
    expect(screen.getByText('The channel is disabled')).toBeInTheDocument();
    for (const action of ['Bind', 'Add backup', 'Replace', 'Unbind']) {
      expect(screen.queryByRole('button', { name: action })).toBeNull();
    }
  });

  it('tells a writer which backup took over when the primary is unbound', async () => {
    permissions.canMutate = true;
    const user = userEvent.setup();
    renderTab();

    await screen.findByText('0.41');
    const [unbindPrimary] = screen.getAllByRole('button', { name: 'Unbind' });
    await user.click(unbindPrimary as HTMLElement);

    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'TAN: tan_probe_a unbound; the backup tan_probe_b is now the primary.',
      ),
    );
  });
});
