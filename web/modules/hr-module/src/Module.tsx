/**
 * HR Module Root
 *
 * Main routing component for the Human Resources module.
 * Includes aquaculture-specific features: crew management, offshore rotations, certifications.
 */

import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Existing pages
import HRDashboardPage from './pages/HRDashboardPage';
import EmployeesPage from './pages/EmployeesPage';
import EmployeeDetailPage from './pages/EmployeeDetailPage';
import EmployeeFormPage from './pages/EmployeeFormPage';
import DepartmentsPage from './pages/DepartmentsPage';
import AttendancePage from './pages/AttendancePage';
import LeavesPage from './pages/LeavesPage';
import PayrollPage from './pages/PayrollPage';
import PerformancePage from './pages/PerformancePage';
import TrainingPage from './pages/TrainingPage';
import HRAnalyticsPage from './pages/HRAnalyticsPage';

// New modernized pages (lazy loaded)
const EmployeesListPage = lazy(() => import('./pages/employees/EmployeesListPage'));
const LeavesListPage = lazy(() => import('./pages/leaves/LeavesPage'));
const CrewAssignmentsPage = lazy(() => import('./pages/crew/CrewAssignmentsPage'));
const OffshoreRotationsPage = lazy(() => import('./pages/crew/OffshoreRotationsPage'));
const CertificationDashboardPage = lazy(() => import('./pages/training/CertificationDashboardPage'));

// Create a dedicated query client for the HR module
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 30 * 60 * 1000, // 30 minutes (formerly cacheTime)
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

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
          <Route path="attendance/schedules" element={<PlaceholderPage title="Schedules" />} />

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

          {/* Aquaculture - Crew Management (NEW) */}
          <Route path="crew" element={<CrewAssignmentsPage />} />
          <Route path="crew/rotations" element={<OffshoreRotationsPage />} />
          <Route path="crew/work-areas" element={<PlaceholderPage title="Work Areas" />} />
          <Route path="crew/transport" element={<PlaceholderPage title="Transport Schedule" />} />

          {/* Organization (NEW) */}
          <Route path="organization" element={<PlaceholderPage title="Organization Structure" />} />
          <Route path="organization/positions" element={<PlaceholderPage title="Positions" />} />

          {/* Analytics */}
          <Route path="analytics" element={<HRAnalyticsPage />} />
          <Route path="reports" element={<PlaceholderPage title="HR Reports" />} />

          {/* Settings (NEW) */}
          <Route path="settings" element={<PlaceholderPage title="HR Settings" />} />

          {/* Unknown routes */}
          <Route path="*" element={<Navigate to="/hr" replace />} />
        </Routes>
      </Suspense>
    </QueryClientProvider>
  );
};

export default HRModule;
