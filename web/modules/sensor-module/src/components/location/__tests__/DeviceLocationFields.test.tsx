/**
 * The shared location picker offers exactly what farm would accept
 * (SENSOR-MEDIUM-161/206): live departments only, the chosen department's
 * systems and the site-wide ones, no unit list before a department, a stored
 * level the lists do not offer shown as "current (not in the list)" rather
 * than as another option, and a list that failed to load said so.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceLocationFields } from '../DeviceLocationFields';

const useEquipmentList = vi.fn();
const useDepartmentsBySite = vi.fn();

vi.mock('../../../hooks/useEquipment', () => ({
  useEquipmentList: (filter: unknown, pagination: unknown, options: unknown) =>
    useEquipmentList(filter, pagination, options),
}));
vi.mock('../../../hooks/useLocationHierarchy', () => ({
  useSiteList: () => ({
    data: { items: [{ id: 'site-1', name: 'Nordfjord', code: 'NF' }] },
    isLoading: false,
    isSuccess: true,
  }),
  useDepartmentsBySite: (siteId: string) => useDepartmentsBySite(siteId),
  useSystemsBySite: () => ({
    data: [
      { id: 'loop-a', name: 'RAS A', code: 'RA', departmentId: 'dept-1' },
      { id: 'loop-b', name: 'RAS B', code: 'RB', departmentId: 'dept-2' },
      { id: 'oxygen', name: 'Oxygen line', code: 'OX', departmentId: null },
    ],
    isLoading: false,
    isSuccess: true,
  }),
}));

const optionsOf = (label: string | RegExp): string[] =>
  [...screen.getByLabelText(label).querySelectorAll('option')].map((o) => o.textContent ?? '');

describe('DeviceLocationFields', () => {
  beforeEach(() => {
    useEquipmentList.mockReset();
    useEquipmentList.mockReturnValue({ data: { items: [] }, isLoading: false, isSuccess: true });
    useDepartmentsBySite.mockReset();
    useDepartmentsBySite.mockReturnValue({
      data: [
        { id: 'dept-1', name: 'Smolt', code: 'SM', isActive: true },
        { id: 'dept-2', name: 'Grow-out', code: 'GO', isActive: true },
        { id: 'dept-old', name: 'Closed hatchery', code: 'CH', isActive: false },
      ],
      isLoading: false,
      isSuccess: true,
    });
  });

  it('offers live departments only', () => {
    render(<DeviceLocationFields value={{ siteId: 'site-1' }} onChange={vi.fn()} />);
    expect(optionsOf(/^Department/)).not.toContain('Closed hatchery (CH)');
    expect(optionsOf(/^Department/)).toContain('Smolt (SM)');
  });

  it('offers the department’s systems and the site-wide ones, not another department’s', () => {
    render(
      <DeviceLocationFields
        value={{ siteId: 'site-1', departmentId: 'dept-1' }}
        onChange={vi.fn()}
      />,
    );
    expect(optionsOf('System')).toEqual(['No system', 'RAS A (RA)', 'Oxygen line (OX)']);
  });

  it('reads no unit list before a department is chosen', () => {
    render(<DeviceLocationFields value={{ siteId: 'site-1' }} onChange={vi.fn()} />);
    expect(useEquipmentList).toHaveBeenCalledWith(
      { departmentId: undefined, systemId: undefined, isActive: true },
      { limit: 100 },
      { enabled: false },
    );
  });

  it('shows a stored level the list does not offer as the current place, and keeps it selected', () => {
    render(
      <DeviceLocationFields
        value={{ siteId: 'site-1', departmentId: 'dept-old' }}
        onChange={vi.fn()}
      />,
    );
    const department = screen.getByLabelText(/^Department/) as HTMLSelectElement;
    expect(department.value).toBe('dept-old');
    expect(department.selectedOptions[0]?.textContent).toBe('Current place (not in the list)');
  });

  it('says a list failed to load instead of showing an empty choice', () => {
    useDepartmentsBySite.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<DeviceLocationFields value={{ siteId: 'site-1' }} onChange={vi.fn()} />);
    expect(screen.getByText('The list could not be loaded')).toBeTruthy();
  });

  it('clears the levels below a changed department', () => {
    const onChange = vi.fn();
    render(
      <DeviceLocationFields
        value={{ siteId: 'site-1', departmentId: 'dept-1', systemId: 'loop-a', unitId: 'tank-1' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Department/), { target: { value: 'dept-2' } });
    expect(onChange).toHaveBeenLastCalledWith({ siteId: 'site-1', departmentId: 'dept-2' });
  });
});
