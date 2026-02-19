/**
 * HR Module Root
 *
 * Main routing component for the Human Resources module.
 * Includes aquaculture-specific features: crew management, offshore rotations, certifications.
 */

import React, { Suspense, lazy, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// All pages are lazy-loaded to minimize initial chunk size (PERF-010)
const HRDashboardPage = lazy(() => import('./pages/HRDashboardPage'));
const EmployeeDetailPage = lazy(() => import('./pages/EmployeeDetailPage'));
const EmployeeFormPage = lazy(() => import('./pages/EmployeeFormPage'));
const DepartmentsPage = lazy(() => import('./pages/DepartmentsPage'));
const AttendancePage = lazy(() => import('./pages/AttendancePage'));
const PayrollPage = lazy(() => import('./pages/PayrollPage'));
const PerformancePage = lazy(() => import('./pages/PerformancePage'));
const TrainingPage = lazy(() => import('./pages/TrainingPage'));
const HRAnalyticsPage = lazy(() => import('./pages/HRAnalyticsPage'));

// Modernized lazy-loaded pages
const EmployeesListPage = lazy(() => import('./pages/employees/EmployeesListPage'));
const LeavesListPage = lazy(() => import('./pages/leaves/LeavesPage'));
const CrewAssignmentsPage = lazy(() => import('./pages/crew/CrewAssignmentsPage'));
const OffshoreRotationsPage = lazy(() => import('./pages/crew/OffshoreRotationsPage'));
const CertificationDashboardPage = lazy(() => import('./pages/training/CertificationDashboardPage'));
const WeeklySchedulePage = lazy(() => import('./pages/scheduling/WeeklySchedulePage'));
const TeamOverviewPage = lazy(() => import('./pages/scheduling/TeamOverviewPage'));
const SchedulingSettingsPage = lazy(() => import('./pages/scheduling/SchedulingSettingsPage'));

// Loading fallback
function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
    </div>
  );
}

// Placeholder for pages not yet implemented
function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center p-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
      <p className="mt-2 text-gray-500 dark:text-gray-400">This page is coming soon.</p>
    </div>
  );
}

// ============================================================================
// HR Module
// ============================================================================

const HRModule: React.FC = () => {
  // QueryClient created inside component so it is tied to the component lifecycle,
  // not shared across HMR cycles or parallel module instances (PERF-002).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5 minutes
            gcTime: 10 * 60 * 1000, // 10 minutes — reduced to limit PII heap accumulation
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Dashboard */}
          <Route index element={<HRDashboardPage />} />
          <Route path="dashboard" element={<HRDashboardPage />} />

          {/* Employees - Use modernized page */}
          <Route path="employees" element={<EmployeesListPage />} />
          <Route path="employees/new" element={<EmployeeFormPage />} />
          <Route path="employees/:employeeId" element={<EmployeeDetailPage />} />
          <Route path="employees/:employeeId/edit" element={<EmployeeFormPage />} />

          {/* Departments */}
          <Route path="departments" element={<DepartmentsPage />} />

          {/* Attendance */}
          <Route path="attendance" element={<AttendancePage />} />
          <Route path="attendance/shifts" element={<PlaceholderPage title="Shift Management" />} />
          <Route path="attendance/schedules" element={<WeeklySchedulePage />} />

          {/* Scheduling */}
          <Route path="scheduling" element={<WeeklySchedulePage />} />
          <Route path="scheduling/weekly" element={<WeeklySchedulePage />} />
          <Route path="scheduling/team-overview" element={<TeamOverviewPage />} />
          <Route path="scheduling/settings" element={<SchedulingSettingsPage />} />

          {/* Leaves - Use modernized page */}
          <Route path="leaves" element={<LeavesListPage />} />
          <Route path="leaves/calendar" element={<PlaceholderPage title="Leave Calendar" />} />
          <Route path="leaves/balances" element={<PlaceholderPage title="Leave Balances" />} />
          <Route path="leaves/types" element={<PlaceholderPage title="Leave Types" />} />

          {/* Payroll */}
          <Route path="payroll" element={<PayrollPage />} />
          <Route path="payroll/payslips" element={<PlaceholderPage title="Payslips" />} />
          <Route path="payroll/reports" element={<PlaceholderPage title="Payroll Reports" />} />

          {/* Performance */}
          <Route path="performance" element={<PerformancePage />} />
          <Route path="performance/goals" element={<PlaceholderPage title="Goals & OKRs" />} />
          <Route path="performance/reviews" element={<PlaceholderPage title="Review Cycles" />} />

          {/* Training & Certifications */}
          <Route path="training" element={<TrainingPage />} />
          <Route path="training/courses" element={<PlaceholderPage title="Training Courses" />} />
          <Route path="training/certifications" element={<CertificationDashboardPage />} />
          <Route path="training/compliance" element={<PlaceholderPage title="Compliance Dashboard" />} />

          {/* Aquaculture - Crew Management */}
          <Route path="crew" element={<CrewAssignmentsPage />} />
          <Route path="crew/rotations" element={<OffshoreRotationsPage />} />
          <Route path="crew/work-areas" element={<PlaceholderPage title="Work Areas" />} />
          <Route path="crew/transport" element={<PlaceholderPage title="Transport Schedule" />} />

          {/* Organization */}
          <Route path="organization" element={<PlaceholderPage title="Organization Structure" />} />
          <Route path="organization/positions" element={<PlaceholderPage title="Positions" />} />

          {/* Analytics */}
          <Route path="analytics" element={<HRAnalyticsPage />} />
          <Route path="reports" element={<PlaceholderPage title="HR Reports" />} />

          {/* Settings */}
          <Route path="settings" element={<PlaceholderPage title="HR Settings" />} />

          {/* Unknown routes */}
          <Route path="*" element={<Navigate to="/hr" replace />} />
        </Routes>
      </Suspense>
    </QueryClientProvider>
  );
};

export default HRModule;
