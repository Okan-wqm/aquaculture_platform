/**
 * SENSOR-MEDIUM-172: the unit picked in the wizard is recorded where it
 * belongs — a tank as tankId, other water equipment as equipmentId — and a
 * picked system narrows the units on the server, so a system pick still offers
 * its tanks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

import { ParentDeviceInfoStep } from '../ParentDeviceInfoStep';
import { toRegisterParentInput } from '../../../../types/registration.types';

const TANK = { id: 'tank-1', name: 'Tank 1', code: 'T1', isTank: true };
const BIOFILTER = { id: 'bio-1', name: 'Biofilter', code: 'BF', isTank: false };

const useEquipmentList = vi.fn();

vi.mock('../../../../hooks/useEquipment', () => ({
  useEquipmentList: (filter: unknown) => useEquipmentList(filter),
}));
vi.mock('../../../../hooks/useLocationHierarchy', () => ({
  useSiteList: () => ({ data: { items: [] }, isLoading: false }),
  useDepartmentsBySite: () => ({ data: [], isLoading: false }),
  useSystemsByDepartment: () => ({ data: [], isLoading: false }),
}));

const LOCATION = { name: 'Probe', siteId: 'site-1', departmentId: 'dept-1', systemId: 'sys-1' };

describe('ParentDeviceInfoStep placement (SENSOR-MEDIUM-172)', () => {
  beforeEach(() => {
    useEquipmentList.mockReset();
    useEquipmentList.mockReturnValue({ data: { items: [TANK, BIOFILTER] }, isLoading: false });
  });

  it('asks the server for the picked system’s units and offers them all', () => {
    const { container } = render(<ParentDeviceInfoStep values={LOCATION} onChange={vi.fn()} />);
    expect(useEquipmentList).toHaveBeenCalledWith({
      departmentId: 'dept-1',
      systemId: 'sys-1',
      isActive: true,
    });
    const options = [...container.querySelectorAll('#equipmentId option')].map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['', 'tank-1', 'bio-1']);
  });

  it('records a tank pick as tankId and an equipment pick as equipmentId, never both', () => {
    const onChange = vi.fn();
    const { container } = render(<ParentDeviceInfoStep values={LOCATION} onChange={onChange} />);
    const select = container.querySelector('#equipmentId') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'tank-1' } });
    expect(onChange).toHaveBeenLastCalledWith({ tankId: 'tank-1', equipmentId: undefined });

    fireEvent.change(select, { target: { value: 'bio-1' } });
    expect(onChange).toHaveBeenLastCalledWith({ tankId: undefined, equipmentId: 'bio-1' });
  });

  it('sends the placement the step chose in the registration input', () => {
    const input = toRegisterParentInput({ ...LOCATION, tankId: 'tank-1' }, 'mqtt', {});
    expect(input).toMatchObject({ siteId: 'site-1', systemId: 'sys-1', tankId: 'tank-1' });
    expect(input.equipmentId).toBeUndefined();
  });
});
