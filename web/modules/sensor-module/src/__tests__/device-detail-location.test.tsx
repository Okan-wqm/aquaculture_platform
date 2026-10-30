/**
 * SENSOR-MEDIUM-161/206 on the device page: a sensor's place is shown by name
 * (never a raw id); "Change location" — not the dead edit link to a route that
 * does not exist — moves it through relocateSensor, sending the unit as it is
 * for farm to classify; a child sensor and a role the resolver refuses get no
 * such button; a refusal is worded by its code in the user's language; and the
 * page shows the place the move answered with.
 */
import { GraphQLClientError } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from '../pages/DeviceDetailPage';

const graphqlFetch = vi.fn();
const toast = vi.fn();
const canMutate = vi.fn();

vi.mock('@aquaculture/shared-ui', async (original) => ({
  ...(await original<typeof import('@aquaculture/shared-ui')>()),
  useToast: () => ({ toast }),
  useCanMutateSensor: (name: string) => canMutate(name),
}));
vi.mock('../config/api', () => ({
  graphqlFetch: (query: string, variables: unknown) => graphqlFetch(query, variables),
}));
vi.mock('../components/channels/ChannelManagerPanel', () => ({
  ChannelManagerPanel: () => null,
}));

const NAMES: Record<string, string> = {
  'site-1': 'Nordfjord Hovedanlegg',
  'dept-1': 'Smolt Avdeling A',
  'sys-1': 'RAS Modul 2',
  'tank-3': 'Tank 3',
};
const named = (id: string | undefined) =>
  id === undefined
    ? { data: undefined, isPending: false, isError: false }
    : { data: { id, name: NAMES[id] }, isPending: false, isError: false };

vi.mock('../hooks/useLocationHierarchy', () => ({
  useSiteList: () => ({
    data: { items: [{ id: 'site-1', name: NAMES['site-1'], code: 'NFH-001' }] },
    isLoading: false,
    isSuccess: true,
  }),
  useDepartmentsBySite: () => ({
    data: [{ id: 'dept-1', name: NAMES['dept-1'], code: 'DP-A', isActive: true }],
    isLoading: false,
    isSuccess: true,
  }),
  useSystemsBySite: () => ({
    data: [{ id: 'sys-1', name: NAMES['sys-1'], code: 'SYS-1', departmentId: 'dept-1' }],
    isLoading: false,
    isSuccess: true,
  }),
  useSiteName: (id?: string) => named(id),
  useDepartmentName: (id?: string) => named(id),
  useSystemName: (id?: string) => named(id),
}));
vi.mock('../hooks/useEquipment', () => ({
  useEquipmentList: () => ({
    data: { items: [{ id: 'tank-3', name: NAMES['tank-3'], code: 'T3', isTank: true }] },
    isLoading: false,
    isSuccess: true,
  }),
  useEquipment: (id: string) =>
    id === 'gone'
      ? {
          data: undefined,
          isPending: false,
          isError: true,
          error: new GraphQLClientError('Equipment not found', 'NOT_FOUND'),
        }
      : named(id || undefined),
}));

const SENSOR = {
  id: 'sensor-1',
  name: 'Codex Su Sıcaklığı Simülatörü',
  type: 'MULTI_PARAMETER',
  serialNumber: 'SN-1',
  registrationStatus: 'draft',
  siteId: 'site-1',
  departmentId: 'dept-1',
  systemId: null,
  tankId: null,
  equipmentId: null,
  isParentDevice: false,
  parentId: null,
  createdAt: '2026-09-16T00:00:00Z',
  updatedAt: '2026-10-30T00:00:00Z',
};

function renderPage(sensor: Record<string, unknown> = SENSOR): void {
  graphqlFetch.mockImplementation(async (query: string) => {
    if (query.includes('relocateSensor')) {
      return {
        relocateSensor: {
          id: 'sensor-1',
          siteId: 'site-1',
          departmentId: 'dept-1',
          systemId: 'sys-1',
          tankId: 'tank-3',
          equipmentId: null,
        },
      };
    }
    if (query.includes('readings(')) return { readings: [] };
    return { sensor };
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/sensor/devices/sensor-1']}>
        <Routes>
          <Route path="/sensor/devices/:deviceId" element={<DeviceDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function moveToTank3(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: /Change location/ }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('System'), { target: { value: 'sys-1' } });
  fireEvent.change(within(dialog).getByLabelText('Tank or equipment'), {
    target: { value: 'tank-3' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  return dialog;
}

describe('DeviceDetailPage location', () => {
  beforeEach(() => {
    graphqlFetch.mockReset();
    toast.mockReset();
    canMutate.mockReset();
    canMutate.mockReturnValue(true);
  });

  it('shows the place by name and has no link to the missing edit route', async () => {
    renderPage();
    const location = await screen.findByTestId('device-location');
    expect(within(location).getByText('Nordfjord Hovedanlegg')).toBeTruthy();
    expect(within(location).getByText('Smolt Avdeling A')).toBeTruthy();
    expect(within(location).getAllByText('Not set')).toHaveLength(2);
    expect(document.querySelector('a[href$="/edit"]')).toBeNull();
    expect(canMutate).toHaveBeenCalledWith('relocateSensor');
  });

  it('says a unit farm no longer has is not found, never its raw id', async () => {
    renderPage({ ...SENSOR, tankId: 'gone' });
    const location = await screen.findByTestId('device-location');
    expect(within(location).getByText('Not found or inactive')).toBeTruthy();
    expect(within(location).queryByText('gone')).toBeNull();
  });

  it('moves the sensor through relocateSensor and shows the place it answered with', async () => {
    renderPage();
    await moveToTank3();

    await waitFor(() => {
      expect(graphqlFetch).toHaveBeenCalledWith(expect.stringContaining('relocateSensor'), {
        input: {
          sensorId: 'sensor-1',
          siteId: 'site-1',
          departmentId: 'dept-1',
          systemId: 'sys-1',
          unitId: 'tank-3',
        },
      });
    });
    const location = await screen.findByTestId('device-location');
    await waitFor(() => expect(within(location).getByText('Tank 3')).toBeTruthy());
    expect(within(location).getByText('RAS Modul 2')).toBeTruthy();
    // The page did not read the sensor again to learn where it stands.
    const sensorReads = graphqlFetch.mock.calls.filter(([query]) =>
      String(query).includes('query GetSensor'),
    );
    expect(sensorReads).toHaveLength(1);
  });

  it('words a refusal by its code in the user’s language', async () => {
    renderPage();
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('relocateSensor')) {
        throw new GraphQLClientError(
          'The tank or equipment is not active',
          'PLACEMENT_REFUSED_UNIT',
        );
      }
      if (query.includes('readings(')) return { readings: [] };
      return { sensor: SENSOR };
    });
    await moveToTank3();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: 'Location could not be saved',
        description: 'The tank or equipment is not active or is not in this department and system.',
        variant: 'error',
      }),
    );
  });

  it('offers no move for a child sensor, which stands where its parent device stands', async () => {
    renderPage({ ...SENSOR, parentId: 'parent-1' });
    await screen.findByTestId('device-location');
    expect(screen.queryByRole('button', { name: /Change location/ })).toBeNull();
  });

  it('offers no move to a role the resolver refuses', async () => {
    canMutate.mockReturnValue(false);
    renderPage();
    await screen.findByTestId('device-location');
    expect(screen.queryByRole('button', { name: /Change location/ })).toBeNull();
  });
});
