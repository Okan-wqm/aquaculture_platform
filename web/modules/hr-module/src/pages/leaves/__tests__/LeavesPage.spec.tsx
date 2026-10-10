/**
 * LeavesPage — the status filter speaks the contract's vocabulary.
 *
 * F-015: the filter's options were hand-copied from the backend enum and drifted
 * from it twice over — DRAFT and WITHDRAWN were missing, so those requests could
 * not be filtered at all, and the four that remained were lower-case, which the
 * GraphQL enum input rejects. An `as LeaveRequestStatus` assertion on the change
 * handler kept the compiler quiet about both. These tests pin the replacement:
 * the options are DERIVED from LEAVE_STATUS_CONFIG — the exhaustive
 * Record<LeaveRequestStatus, …> that mirrors hr-service's enum — and a selected
 * status reaches useLeaveRequests as the enum member name the $status variable
 * requires.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LeaveRequest, LeaveRequestFilterInput, PaginationInput } from '../../../types';
import { LEAVE_STATUS_CONFIG } from '../../../types';
import { LeavesPage } from '../LeavesPage';

type LeaveRequestsQuery = (
  filter?: LeaveRequestFilterInput,
  pagination?: PaginationInput,
) => { data: { items: LeaveRequest[]; total: number }; isLoading: boolean };

const mocks = vi.hoisted(() => ({
  leaveRequests: vi.fn<LeaveRequestsQuery>(),
}));

vi.mock('../../../hooks/useLeaves', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useLeaves')>();
  return {
    ...actual,
    useLeaveRequests: mocks.leaveRequests,
    usePendingLeaveApprovals: () => ({ data: [], isLoading: false }),
    useLeaveTypes: () => ({ data: [] }),
    useApproveLeaveRequest: () => ({ mutate: vi.fn(), isPending: false }),
    useRejectLeaveRequest: () => ({ mutate: vi.fn(), isPending: false }),
    // The page mounts NewLeaveRequestModal whatever `open` is, so the modal's
    // hooks run on every render too. Left live they reach the real query path and
    // the render fails for a reason unrelated to the filter under test.
    useCreateLeaveRequest: () => ({ mutate: vi.fn(), isPending: false }),
    useCalculateLeaveDays: () => ({ data: undefined, isFetching: false }),
  };
});

vi.mock('../../../hooks/useEmployees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useEmployees')>();
  return {
    ...actual,
    useCurrentEmployeeId: () => 'employee-1',
    useEmployees: () => ({ data: { items: [], total: 0 } }),
  };
});

/** Renders the page, opens the filter panel and returns the status control. */
function statusFilter(): HTMLSelectElement {
  render(
    <MemoryRouter>
      <LeavesPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
  const control = screen.getByLabelText('Status');
  if (!(control instanceof HTMLSelectElement)) {
    throw new Error('The status filter is not a native <select>');
  }
  return control;
}

function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

function lastQueriedFilter(): LeaveRequestFilterInput | undefined {
  const { calls } = mocks.leaveRequests.mock;
  return calls[calls.length - 1]?.[0];
}

describe('LeavesPage status filter', () => {
  beforeEach(() => {
    mocks.leaveRequests.mockReset();
    mocks.leaveRequests.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
    });
  });

  it('offers the clear-selection sentinel and all six contract statuses, none lower-case', () => {
    expect(optionValues(statusFilter())).toEqual([
      '',
      'DRAFT',
      'PENDING',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
      'WITHDRAWN',
    ]);
  });

  it('derives the offered statuses from LEAVE_STATUS_CONFIG rather than a local copy', () => {
    const [sentinel, ...statuses] = optionValues(statusFilter());

    expect(sentinel).toBe('');
    expect(statuses).toEqual(Object.keys(LEAVE_STATUS_CONFIG));
  });

  it('sends a selected status to the query as the enum member name', () => {
    const select = statusFilter();

    fireEvent.change(select, { target: { value: 'WITHDRAWN' } });

    expect(lastQueriedFilter()).toEqual({ status: 'WITHDRAWN' });
  });
});
