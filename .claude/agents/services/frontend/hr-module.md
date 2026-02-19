---
name: hr-module
description: Knowledge base for the HR Module frontend
---

# HR Module Knowledge Base

## Overview

The HR Module is a Module Federation remote at `/hr/*`. It provides Human Resources management for aquaculture operations: employee lifecycle, scheduling, attendance, leave management, payroll, performance, training/certifications, and aquaculture-specific crew management (offshore rotations, sea/land split). Notably, it creates its own dedicated `QueryClient`.

## Directory Structure

```
web/modules/hr-module/src/
  Module.tsx              # Route definitions + QueryClientProvider wrapper
  main.tsx
  pages/
    HRDashboardPage.tsx          # /hr (index)
    EmployeesPage.tsx            # Legacy employees page
    EmployeeDetailPage.tsx       # /hr/employees/:employeeId
    EmployeeFormPage.tsx         # /hr/employees/new & /hr/employees/:id/edit
    DepartmentsPage.tsx          # /hr/departments
    AttendancePage.tsx           # /hr/attendance
    LeavesPage.tsx               # Legacy leaves page
    PayrollPage.tsx              # /hr/payroll
    PerformancePage.tsx          # /hr/performance
    TrainingPage.tsx             # /hr/training
    HRAnalyticsPage.tsx          # /hr/analytics
    employees/
      EmployeesListPage.tsx      # /hr/employees (modernized, lazy-loaded)
    leaves/
      LeavesPage.tsx             # /hr/leaves (modernized, lazy-loaded)
    crew/
      CrewAssignmentsPage.tsx    # /hr/crew (lazy-loaded)
      OffshoreRotationsPage.tsx  # /hr/crew/rotations (lazy-loaded)
    training/
      CertificationDashboardPage.tsx  # /hr/training/certifications (lazy-loaded)
    scheduling/
      WeeklySchedulePage.tsx     # /hr/scheduling & /hr/attendance/schedules (lazy-loaded)
      TeamOverviewPage.tsx       # /hr/scheduling/team-overview (lazy-loaded)
      SchedulingSettingsPage.tsx # /hr/scheduling/settings (lazy-loaded)
    index.ts
  components/
    common/
      DataTable.tsx              # HR-local data table
      DepartmentBadge.tsx
      EmployeeAvatar.tsx
      StatusBadge.tsx
      index.ts
    employee/
      EmployeeCard.tsx
      index.ts
    leave/
      LeaveBalanceWidget.tsx
      index.ts
    attendance/
      TimeClockWidget.tsx        # Live clock-in/out widget
      index.ts
    certification/
      CertificationExpiryAlert.tsx
      index.ts
    crew/
      SeaLandSplitView.tsx       # Split view: sea vs land crew assignments
      index.ts
    scheduling/
      WeeklyCalendarGrid.tsx     # Calendar grid for weekly schedule
      ShiftCell.tsx              # Individual shift cell (drag/click)
      ShiftPalette.tsx           # Shift type picker
      WeekNavigator.tsx          # Week prev/next navigation
      CopyWeekModal.tsx          # Copy previous week's schedule
      PrintScheduleButton.tsx
      SchedulingErrorBoundary.tsx
      SchedulingKeyboardContext.tsx  # Keyboard shortcut context for scheduling
      index.ts
    index.ts
  graphql/
    employee.operations.ts
    attendance.operations.ts
    leave.operations.ts
    certification.operations.ts
    aquaculture.operations.ts     # Crew/offshore specific operations
    performance.operations.ts
    scheduling.operations.ts
    fragments.ts
    index.ts
  hooks/
    useGraphQL.ts                # Local GraphQL fetch wrapper
    useEmployees.ts
    useAttendance.ts
    useLeaves.ts
    useCertifications.ts
    useAquaculture.ts            # Crew/offshore hooks
    usePerformance.ts
    useScheduling.ts
    index.ts
  types/
    employee.types.ts
    attendance.types.ts
    leave.types.ts
    certification.types.ts
    aquaculture.types.ts
    performance.types.ts
    scheduling.types.ts
    common.types.ts
    index.ts
```

## Pages / Components

### HRDashboardPage (`/hr`)
Overview KPIs: headcount, attendance rate today, pending leave requests, upcoming certifications expiring. Links to key sections.

### EmployeesListPage (`/hr/employees`) — modernized
Full employee list with filters (department, status, role). Columns: name, department, position, status, hire date, actions. Uses `useEmployees` hook with React Query.

### Scheduling (`/hr/scheduling`)
Weekly scheduling grid:
- `WeeklyCalendarGrid` renders a 7-column × N-employee grid
- `ShiftCell` handles drag-to-assign or click-to-assign shifts
- `ShiftPalette` shows available shift types with color coding
- `WeekNavigator` navigates weeks
- `CopyWeekModal` to duplicate previous week
- `SchedulingKeyboardContext` provides keyboard shortcuts (arrow keys, Enter, Delete)
- `PrintScheduleButton` opens print-optimized view

### CrewAssignmentsPage (`/hr/crew`)
Aquaculture-specific: assigns crew members to sites/vessels. `SeaLandSplitView` shows current crew at-sea vs on-land.

### OffshoreRotationsPage (`/hr/crew/rotations`)
Manages offshore rotation schedules (e.g. 2 weeks on / 2 weeks off patterns).

### CertificationDashboardPage (`/hr/training/certifications`)
Tracks employee certifications with expiry dates. `CertificationExpiryAlert` highlights upcoming expirations. Regulatory compliance view.

### AttendancePage (`/hr/attendance`)
Attendance records with date range filter. `TimeClockWidget` shows real-time clock-in status.

### LeavesPage (`/hr/leaves`) — modernized
Leave request list, approval workflow, leave balance widget.

## State Management

- **@tanstack/react-query** — own `QueryClient` created per module:
  ```typescript
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 30 * 60 * 1000, retry: 1, refetchOnWindowFocus: false } }
  });
  ```
- All pages are wrapped in `QueryClientProvider client={queryClient}` in `Module.tsx`
- `SchedulingKeyboardContext` — React Context for keyboard state in scheduling grid
- No Zustand store

## GraphQL Operations

Organized by domain in separate files:

```graphql
# employee.operations.ts
query Employees($filters) { employees { id firstName lastName email department position status hireDate } }
query Employee($id) { employee { id ... } }
mutation CreateEmployee($input) { createEmployee { id } }
mutation UpdateEmployee($id, $input) { updateEmployee { id } }

# attendance.operations.ts
query Attendance($startDate, $endDate) { attendance { employeeId date clockIn clockOut totalHours } }
mutation ClockIn($employeeId) { clockIn { id clockIn } }
mutation ClockOut($recordId) { clockOut { id clockOut totalHours } }

# leave.operations.ts
query LeaveRequests($status, $startDate, $endDate) { leaveRequests { id employeeId type startDate endDate status } }
query LeaveBalances($employeeId) { leaveBalances { type balance used remaining } }
mutation RequestLeave($input) { requestLeave { id status } }
mutation ApproveLeave($id) { approveLeave { id status } }
mutation RejectLeave($id, $reason) { rejectLeave { id status } }

# certification.operations.ts
query Certifications($employeeId) { certifications { id type issueDate expiryDate status } }
mutation RecordCertification($input) { recordCertification { id } }

# aquaculture.operations.ts
query CrewAssignments { crewAssignments { employeeId siteId role startDate endDate isAtSea } }
query OffshoreRotations { offshoreRotations { employeeId rotationPattern nextSeaDate nextLandDate } }

# scheduling.operations.ts
query WeeklySchedule($weekStart) { weeklySchedule { employeeId shifts { date shiftType startTime endTime } } }
mutation SaveSchedule($input) { saveSchedule { weekStart savedShifts } }
```

## Routing

```
/hr                         -> HRDashboardPage
/hr/dashboard               -> HRDashboardPage
/hr/employees               -> EmployeesListPage (lazy)
/hr/employees/new           -> EmployeeFormPage
/hr/employees/:employeeId   -> EmployeeDetailPage
/hr/employees/:employeeId/edit -> EmployeeFormPage
/hr/departments             -> DepartmentsPage
/hr/attendance              -> AttendancePage
/hr/attendance/schedules    -> WeeklySchedulePage (lazy)
/hr/scheduling              -> WeeklySchedulePage (lazy)
/hr/scheduling/weekly       -> WeeklySchedulePage (lazy)
/hr/scheduling/team-overview -> TeamOverviewPage (lazy)
/hr/scheduling/settings     -> SchedulingSettingsPage (lazy)
/hr/leaves                  -> LeavesPage (lazy)
/hr/leaves/calendar         -> PlaceholderPage
/hr/leaves/balances         -> PlaceholderPage
/hr/leaves/types            -> PlaceholderPage
/hr/payroll                 -> PayrollPage
/hr/payroll/payslips        -> PlaceholderPage
/hr/payroll/reports         -> PlaceholderPage
/hr/performance             -> PerformancePage
/hr/training                -> TrainingPage
/hr/training/certifications -> CertificationDashboardPage (lazy)
/hr/crew                    -> CrewAssignmentsPage (lazy)
/hr/crew/rotations          -> OffshoreRotationsPage (lazy)
/hr/analytics               -> HRAnalyticsPage
```

Several routes are `PlaceholderPage` — not yet implemented.

## Key Dependencies

- `@tanstack/react-query` — data fetching (module-local QueryClient)
- `@aquaculture/shared-ui` — shared components, graphqlClient (via `useGraphQL.ts`)
- Vite + Module Federation
- Tailwind CSS

## Known Gotchas

- HR module creates its **own** `QueryClient` — it does NOT share query cache with other modules. This is intentional for module isolation but means HR data is fetched independently.
- New pages (`EmployeesListPage`, `LeavesPage`, `CrewAssignmentsPage`, etc.) are lazy-loaded via `React.lazy`. Old pages (`EmployeesPage`, `LeavesPage` at root) still exist as legacy — the modernized versions in subfolders take precedence in routes.
- Several routes (payslips, leave calendar, leave balances, leave types, performance goals, org chart) are `PlaceholderPage` — "coming soon".
- `useGraphQL.ts` is a local wrapper — it does NOT use `@aquaculture/shared-ui`'s `useGraphQL.ts`. Check which one is in use.
- Scheduling component uses `SchedulingKeyboardContext` for keyboard shortcuts — must be wrapped in its provider.
- `SchedulingErrorBoundary` wraps the scheduling grid separately for isolated error handling.
- Aquaculture-specific crew features (offshore rotations, sea/land split) are unique to this platform — not standard HR module features.

## Related Backend Services

- **hr-service** — all HR data (employees, attendance, leaves, payroll, certifications, scheduling, crew)
- **gateway-api** (port 3000) — all GraphQL requests
