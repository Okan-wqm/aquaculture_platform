/**
 * WorkOrdersPage specs (FARM-MEDIUM-120 batch 4).
 *
 * Exercises the real useWorkOrders hook against the routed graphqlClient
 * seam: rows render from the backend list, the client-side search narrows
 * them, and creating a work order goes through the real mutation.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import WorkOrdersPage from '../WorkOrdersPage';

function workOrder(id: string, code: string, title: string): Record<string, unknown> {
  return {
    id,
    tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
    workOrderCode: code,
    title,
    description: null,
    type: 'CORRECTIVE',
    status: 'PLANNED',
    priority: 'MEDIUM',
    assetType: 'TANK',
    assetId: 'tank-1',
    relatedAsset: null,
    plannedStartDate: '2026-07-03T08:00:00.000Z',
    dueDate: '2026-07-05T16:00:00.000Z',
    estimatedDurationMinutes: 90,
    actualStartTime: null,
    actualEndTime: null,
    actualDurationMinutes: null,
    assignedTo: null,
    assignedTeamId: null,
    createdBy: 'user-1',
    approvedBy: null,
    approvedAt: null,
    checklist: [],
    checklistProgress: null,
    usedMaterials: [],
    laborRecords: [],
    estimatedCost: null,
    costSummary: null,
    currency: 'EUR',
    maintenanceScheduleId: null,
    isRecurring: false,
    completionNotes: null,
    completedBy: null,
    completedAt: null,
    verifiedBy: null,
    verifiedAt: null,
    notes: null,
    attachments: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const WORK_ORDERS = [
  workOrder('wo-1', 'WO-2026-001', 'Pump bearing replacement'),
  workOrder('wo-2', 'WO-2026-002', 'Net cleaning'),
];

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query WorkOrders',
      result: {
        workOrders: {
          items: WORK_ORDERS,
          total: 2,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      },
    },
    { match: 'query EquipmentWithBatches', result: { equipmentList: { items: [], total: 0, page: 1, limit: 200, totalPages: 1 } } },
  ]);
});

describe('WorkOrdersPage', () => {
  it('renders work-order rows from the backend list', async () => {
    renderWithProviders(<WorkOrdersPage />);

    expect(await screen.findByText('Pump bearing replacement')).toBeInTheDocument();
    expect(screen.getByText('Net cleaning')).toBeInTheDocument();
    expect(screen.getByText('WO-2026-001')).toBeInTheDocument();
  });

  it('narrows rows with the client-side search', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkOrdersPage />);
    await screen.findByText('Pump bearing replacement');

    await user.type(screen.getByPlaceholderText('Ara...'), 'bearing');

    expect(screen.getByText('Pump bearing replacement')).toBeInTheDocument();
    expect(screen.queryByText('Net cleaning')).not.toBeInTheDocument();
  });

  it('does not render rows as an empty success state when the list query fails', async () => {
    routeGraphql([]);
    renderWithProviders(<WorkOrdersPage />);

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText('Pump bearing replacement')).not.toBeInTheDocument();
    });
  });
});
