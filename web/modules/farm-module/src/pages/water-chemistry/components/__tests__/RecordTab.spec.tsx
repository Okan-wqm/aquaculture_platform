import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WaterQualityFilters } from '../../../../hooks/useWaterQuality';

/**
 * RecordTab's recent entries are read by unit. A non-tank unit (a biofilter,
 * a sump) is filed as `equipmentId` with no `tankId`, so a list filtered by
 * `tankId` showed nothing for it after a successful save.
 */

const listCalls: Array<WaterQualityFilters | undefined> = [];

vi.mock('@aquaculture/shared-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aquaculture/shared-ui')>()),
  useAuth: () => ({ tenantId: 'tenant-1', token: 'token' }),
  useTenantScopedStorage: () => ({ read: () => null, write: () => undefined }),
}));
vi.mock('@aquaculture/farm-shared', () => ({ DynamicMeasurementForm: () => null }));
vi.mock('../../../../hooks/useEquipmentParameters', () => ({
  useEquipmentParameterConfigs: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../../../hooks/useSystems', () => ({
  useSystemList: () => ({ data: { items: [] } }),
}));
vi.mock('../../../../hooks/useEquipment', () => ({
  useEquipmentList: () => ({
    data: { items: [{ id: 'biofilter-1', name: 'Biofilter', code: 'BF-1' }] },
    isLoading: false,
  }),
}));
vi.mock('../../../../hooks/useWaterQuality', () => ({
  useCreateWaterQuality: () => ({ mutate: vi.fn(), isPending: false }),
  useWaterQualityList: (filters?: WaterQualityFilters) => {
    listCalls.push(filters);
    return { data: { items: [] }, isLoading: false };
  },
}));

import { RecordTab } from '../RecordTab';

afterEach(() => {
  listCalls.length = 0;
  cleanup();
});

describe('RecordTab recent entries', () => {
  it('lists the picked unit’s measurements by unitId', () => {
    const { container } = render(React.createElement(RecordTab));
    const select = container.querySelector('#record-equipment-select');
    if (!(select instanceof HTMLSelectElement)) throw new Error('equipment select not rendered');

    fireEvent.change(select, { target: { value: 'biofilter-1' } });

    expect(listCalls.at(-1)).toEqual({ unitId: 'biofilter-1', limit: 5 });
    expect(listCalls.some((filters) => filters?.tankId !== undefined)).toBe(false);
  });
});
