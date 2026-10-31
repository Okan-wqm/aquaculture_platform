/**
 * SENSOR-MEDIUM-161: the wizard sends the unit it picked as it is — farm, not
 * the browser, decides whether it is a tank — and a level below a changed one
 * never survives the change, because the wizard merges the step's updates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';

import { ParentDeviceInfoStep } from '../ParentDeviceInfoStep';
import { toRegisterParentInput } from '../../../../types/registration.types';

const TANK = { id: 'tank-1', name: 'Tank 1', code: 'T1', isTank: true };
const BIOFILTER = { id: 'bio-1', name: 'Biofilter', code: 'BF', isTank: false };

const useEquipmentList = vi.fn();

vi.mock('../../../../hooks/useEquipment', () => ({
  useEquipmentList: (filter: unknown, pagination: unknown, options: unknown) =>
    useEquipmentList(filter, pagination, options),
}));
vi.mock('../../../../hooks/useLocationHierarchy', () => ({
  useSiteList: () => ({
    data: {
      items: [
        { id: 'site-1', name: 'Nordfjord', code: 'NF' },
        { id: 'site-2', name: 'Vest', code: 'VE' },
      ],
    },
    isLoading: false,
    isSuccess: true,
  }),
  useDepartmentsBySite: () => ({
    data: [{ id: 'dept-1', name: 'Smolt', code: 'SM', isActive: true }],
    isLoading: false,
    isSuccess: true,
  }),
  useSystemsBySite: () => ({
    data: [{ id: 'sys-1', name: 'RAS', code: 'R1', departmentId: 'dept-1' }],
    isLoading: false,
    isSuccess: true,
  }),
}));

const LEVELS = { siteId: 'site-1', departmentId: 'dept-1', systemId: 'sys-1' };
const LOCATION = { name: 'Probe', ...LEVELS };

describe('ParentDeviceInfoStep placement (SENSOR-MEDIUM-161)', () => {
  beforeEach(() => {
    useEquipmentList.mockReset();
    useEquipmentList.mockReturnValue({
      data: { items: [TANK, BIOFILTER] },
      isLoading: false,
      isSuccess: true,
    });
  });

  it('asks the server for the picked system’s units and offers them after an explicit none', () => {
    render(<ParentDeviceInfoStep values={LOCATION} onChange={vi.fn()} />);
    expect(useEquipmentList).toHaveBeenCalledWith(
      { departmentId: 'dept-1', systemId: 'sys-1', isActive: true },
      { limit: 100 },
      { enabled: true },
    );
    const unit = screen.getByLabelText('Tank or equipment');
    expect([...unit.querySelectorAll('option')].map((o) => o.value)).toEqual([
      '',
      'tank-1',
      'bio-1',
    ]);
  });

  it('records the picked unit as unitId, tank or not, and can go back to none', () => {
    const onChange = vi.fn();
    render(<ParentDeviceInfoStep values={LOCATION} onChange={onChange} />);
    const unit = screen.getByLabelText('Tank or equipment');

    fireEvent.change(unit, { target: { value: 'bio-1' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...LEVELS, unitId: 'bio-1' });

    fireEvent.change(unit, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...LEVELS, unitId: undefined });
  });

  it('clears every level below a changed one explicitly, so the merge cannot keep it', () => {
    const onChange = vi.fn();
    render(<ParentDeviceInfoStep values={{ ...LOCATION, unitId: 'tank-1' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^Site/), { target: { value: 'site-2' } });
    expect(onChange).toHaveBeenLastCalledWith({
      siteId: 'site-2',
      departmentId: undefined,
      systemId: undefined,
      unitId: undefined,
    });
  });

  it('sends the unit as unitId in the registration input', () => {
    const input = toRegisterParentInput({ ...LOCATION, unitId: 'tank-1' }, 'mqtt', {});
    expect(input).toMatchObject({ siteId: 'site-1', systemId: 'sys-1', unitId: 'tank-1' });
  });
});
