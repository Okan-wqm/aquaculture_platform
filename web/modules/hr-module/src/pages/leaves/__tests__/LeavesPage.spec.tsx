/**
 * LeavesPage — the status filter speaks the contract's vocabulary, and each tab reads its own list.
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
 *
 * Tabs: "All requests" pages the all-requests connection, "Pending approvals" pages the
 * approver's pending connection (its total is the tab badge), and "My requests" reads the
 * signed-in employee's own bare array — the server resolves that employee from the token, so the
 * page never filters by the auth user id (which is not an employee id) and offers no paging.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Employee,
  LeaveRequest,
  LeaveRequestFilterInput,
  PaginationInput,
} from '../../../types';
import {
  EmployeeStatus,
  EmploymentType,
  LEAVE_STATUS_CONFIG,
  LeaveRequestStatus,
} from '../../../types';
import { LeavesPage } from '../LeavesPage';

interface Page {
  items: LeaveRequest[];
  total: number;
}

type LeaveRequestsQuery = (
  filter?: LeaveRequestFilterInput,
  pagination?: PaginationInput,
) => { data: Page; isLoading: boolean };

type PendingApprovalsQuery = (pagination?: PaginationInput) => { data: Page; isLoading: boolean };

type MyLeaveRequestsQuery = (
  status?: LeaveRequestStatus,
  pagination?: PaginationInput,
  options?: { enabled?: boolean },
) => { data: LeaveRequest[] | undefined; isLoading: boolean; error?: Error | null };

const mocks = vi.hoisted(() => ({
  leaveRequests: vi.fn<LeaveRequestsQuery>(),
  pendingApprovals: vi.fn<PendingApprovalsQuery>(),
  myLeaveRequests: vi.fn<MyLeaveRequestsQuery>(),
}));

vi.mock('../../../hooks/useLeaves', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useLeaves')>();
  return {
    ...actual,
    useLeaveRequests: mocks.leaveRequests,
    usePendingLeaveApprovals: mocks.pendingApprovals,
    useMyLeaveRequests: mocks.myLeaveRequests,
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
    useEmployees: () => ({ data: { items: [], total: 0 } }),
  };
});

const employee = (firstName: string, lastName: string): Employee => ({
  id: `employee-${firstName}`,
  tenantId: 'tenant-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  isDeleted: false,
  employeeNumber: `E-${firstName}`,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.test`,
  status: EmployeeStatus.ACTIVE,
  employmentType: EmploymentType.FULL_TIME,
  hireDate: '2020-01-01',
  seaWorthy: false,
});

const leaveRequest = (id: string, firstName: string, lastName: string): LeaveRequest => ({
  id,
  tenantId: 'tenant-1',
  createdAt: '2026-10-15T08:00:00Z',
  updatedAt: '2026-10-15T08:00:00Z',
  isDeleted: false,
  requestNumber: `LR-${id}`,
  employeeId: `employee-${firstName}`,
  employee: employee(firstName, lastName),
  leaveTypeId: 'leave-type-1',
  startDate: '2026-11-02',
  endDate: '2026-11-03',
  totalDays: 2,
  isHalfDayStart: false,
  isHalfDayEnd: false,
  status: LeaveRequestStatus.PENDING,
  currentApprovalLevel: 1,
});

const EVERYONE = leaveRequest('all-1', 'Zed', 'Zane');
const AWAITING = leaveRequest('pending-1', 'Ada', 'Berg');
const OWN = leaveRequest('mine-1', 'Mia', 'Moe');

/** Renders the page and returns nothing: every assertion reads the screen or a hook mock. */
function renderPage(): void {
  render(
    <MemoryRouter>
      <LeavesPage />
    </MemoryRouter>,
  );
}

/** Renders the page, opens the filter panel and returns the status control. */
function statusFilter(): HTMLSelectElement {
  renderPage();
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

function lastCall<TArgs extends unknown[]>(mock: { mock: { calls: TArgs[] } }): TArgs {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  if (call === undefined) throw new Error('the hook was never called');
  return call;
}

function lastQueriedFilter(): LeaveRequestFilterInput | undefined {
  return lastCall(mocks.leaveRequests)[0];
}

function openTab(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

beforeEach(() => {
  mocks.leaveRequests.mockReset();
  mocks.leaveRequests.mockReturnValue({ data: { items: [EVERYONE], total: 1 }, isLoading: false });
  mocks.pendingApprovals.mockReset();
  mocks.pendingApprovals.mockReturnValue({ data: { items: [], total: 0 }, isLoading: false });
  mocks.myLeaveRequests.mockReset();
  mocks.myLeaveRequests.mockReturnValue({ data: undefined, isLoading: false });
});

describe('LeavesPage status filter', () => {
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

describe('LeavesPage pending approvals tab', () => {
  it('lists the pending page and shows the connection total in the tab badge', () => {
    mocks.pendingApprovals.mockReturnValue({
      data: { items: [AWAITING], total: 7 },
      isLoading: false,
    });
    renderPage();

    expect(screen.getByRole('button', { name: /Pending Approvals/ })).toHaveTextContent('7');

    openTab(/Pending Approvals/);

    expect(screen.getByText('Ada Berg')).toBeInTheDocument();
    expect(screen.queryByText('Zed Zane')).not.toBeInTheDocument();
  });

  it('shows no badge when nothing awaits approval', () => {
    renderPage();

    expect(screen.getByRole('button', { name: 'Pending Approvals' })).toBeInTheDocument();
  });

  it('pages the pending list like the others', () => {
    mocks.pendingApprovals.mockReturnValue({
      data: { items: [AWAITING], total: 45 },
      isLoading: false,
    });
    renderPage();
    openTab(/Pending Approvals/);

    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Next page'));

    expect(lastCall(mocks.pendingApprovals)[0]).toEqual({ limit: 20, page: 2 });
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  it('keeps the badge on the first page while another tab pages', () => {
    mocks.leaveRequests.mockReturnValue({
      data: { items: [EVERYONE], total: 45 },
      isLoading: false,
    });
    renderPage();

    fireEvent.click(screen.getByTitle('Next page'));

    expect(lastCall(mocks.leaveRequests)[1]).toEqual({ limit: 20, page: 2 });
    expect(lastCall(mocks.pendingApprovals)[0]).toEqual({ limit: 20, page: 1 });
  });

  it('starts every tab on its first page', () => {
    mocks.leaveRequests.mockReturnValue({
      data: { items: [EVERYONE], total: 45 },
      isLoading: false,
    });
    mocks.pendingApprovals.mockReturnValue({
      data: { items: [AWAITING], total: 45 },
      isLoading: false,
    });
    renderPage();
    fireEvent.click(screen.getByTitle('Next page'));
    expect(lastCall(mocks.leaveRequests)[1]).toEqual({ limit: 20, page: 2 });

    openTab(/Pending Approvals/);

    expect(lastCall(mocks.pendingApprovals)[0]).toEqual({ limit: 20, page: 1 });
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });
});

describe('LeavesPage my requests tab', () => {
  beforeEach(() => {
    mocks.myLeaveRequests.mockReturnValue({ data: [OWN], isLoading: false });
  });

  it('lists the signed-in employee’s own requests from useMyLeaveRequests', () => {
    renderPage();

    openTab(/My Requests/);

    expect(screen.getByText('Mia Moe')).toBeInTheDocument();
    expect(screen.queryByText('Zed Zane')).not.toBeInTheDocument();
  });

  it('says why the list is missing instead of claiming there are no requests', () => {
    mocks.myLeaveRequests.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Employee record not found for current user'),
    });
    renderPage();

    openTab(/My Requests/);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failed to load leave requests: Employee record not found for current user',
    );
  });

  it('shows no error banner on a tab whose list loaded', () => {
    renderPage();

    openTab(/My Requests/);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never narrows the all-requests list by the auth user id', () => {
    renderPage();

    openTab(/My Requests/);

    for (const [filter] of mocks.leaveRequests.mock.calls) {
      expect(filter?.employeeId).toBeUndefined();
    }
  });

  it('reads the own list only while its tab is showing', () => {
    renderPage();
    expect(lastCall(mocks.myLeaveRequests)[2]).toEqual({ enabled: false });

    openTab(/My Requests/);
    expect(lastCall(mocks.myLeaveRequests)[2]).toEqual({ enabled: true });

    openTab(/All Requests/);
    expect(lastCall(mocks.myLeaveRequests)[2]).toEqual({ enabled: false });
  });

  it('applies the status filter and sends no page', () => {
    renderPage();
    openTab(/My Requests/);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'APPROVED' } });

    const [status, pagination] = lastCall(mocks.myLeaveRequests);
    expect(status).toBe('APPROVED');
    expect(pagination).toBeUndefined();
  });

  it('offers no paging: the answer is a bare array with no total', () => {
    renderPage();

    openTab(/My Requests/);

    expect(screen.queryByTitle('Next page')).not.toBeInTheDocument();
    expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
  });
});
