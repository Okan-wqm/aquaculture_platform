/**
 * HR Analytics Page
 *
 * BUG-009: Hard-coded mock analytics data removed.
 * Uses pre-aggregated stats from useHRDashboardStats and department list.
 */

import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, TrendingUp, Users, Calendar, Award, Clock, Download } from 'lucide-react';
import { useHRDashboardStats, useDepartments } from '../hooks';
import { useHrFinanceSummary } from '../hooks/useHrFinance';

const HRAnalyticsPage: React.FC = () => {
  const { data: stats, isLoading: loadingStats } = useHRDashboardStats();
  const { data: departments, isLoading: loadingDepts } = useDepartments();

  // Real per-department headcount from the HR finance read model — replaces
  // the former hard-coded 0%-width placeholder bars (HR-HIGH-001). The query
  // is manager/admin-gated; on a non-privileged view it simply resolves empty
  // and the breakdown shows honest em-dashes rather than fake zeros.
  const currentYear = new Date().getUTCFullYear();
  const { data: financeSummary } = useHrFinanceSummary(
    `${currentYear}-01-01`,
    `${currentYear}-12-31`,
    'YEAR',
  );

  const headcountByDepartment = useMemo(() => {
    const map = new Map<string, number>();
    for (const dept of financeSummary?.byDepartment ?? []) {
      if (dept.departmentHrId) {
        map.set(dept.departmentHrId, dept.headcount);
      }
    }
    return map;
  }, [financeSummary]);

  const maxHeadcount = useMemo(
    () => Math.max(1, ...[...headcountByDepartment.values()]),
    [headcountByDepartment],
  );

  const isLoading = loadingStats || loadingDepts;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">HR Analytics</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Human resources metrics and insights
          </p>
        </div>
        <button className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600">
          <Download className="h-4 w-4" />
          Export Report
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl border border-gray-100 bg-gray-100 dark:border-gray-700 dark:bg-gray-700"
            />
          ))
        ) : (
          <>
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Total Employees</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {stats?.totalEmployees ?? '-'}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {stats?.activeEmployees ?? '-'} active
                  </p>
                </div>
                <div className="rounded-lg bg-indigo-50 p-3 dark:bg-indigo-900/30">
                  <Users className="h-6 w-6 text-indigo-600" />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Departments</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {stats?.totalDepartments ?? departments?.length ?? '-'}
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-50 p-3 dark:bg-emerald-900/30">
                  <BarChart3 className="h-6 w-6 text-emerald-600" />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Offshore</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {stats?.offshoreEmployees ?? '-'}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">Currently deployed</p>
                </div>
                <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-900/30">
                  <TrendingUp className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">On Leave</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {stats?.onLeaveEmployees ?? '-'}
                  </p>
                </div>
                <div className="rounded-lg bg-amber-50 p-3 dark:bg-amber-900/30">
                  <Calendar className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Department Breakdown */}
      {departments && departments.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Department Breakdown
          </h3>
          <div className="space-y-3">
            {departments.map((dept) => {
              const headcount = headcountByDepartment.get(dept.id);
              const widthPct =
                headcount !== undefined ? Math.round((headcount / maxHeadcount) * 100) : 0;
              return (
                <div key={dept.id} className="flex items-center gap-4">
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: dept.colorCode || '#6366f1' }}
                  />
                  <span className="w-40 truncate text-sm text-gray-700 dark:text-gray-300">
                    {dept.name}
                  </span>
                  <div className="flex-1 rounded-full bg-gray-200 dark:bg-gray-700" style={{ height: 6 }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${widthPct}%`,
                        backgroundColor: dept.colorCode || '#6366f1',
                      }}
                    />
                  </div>
                  <span className="w-12 text-right text-sm text-gray-500">
                    {headcount !== undefined ? headcount : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Links to detailed reports */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Link
          to="/hr/reports"
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
        >
          <BarChart3 className="mb-2 h-8 w-8 text-gray-400" />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Detailed Reports</p>
        </Link>
        <Link
          to="/hr/payroll/reports"
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
        >
          <Award className="mb-2 h-8 w-8 text-gray-400" />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Payroll Reports</p>
        </Link>
        <Link
          to="/hr/training/certifications"
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
        >
          <Clock className="mb-2 h-8 w-8 text-gray-400" />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Certification Status</p>
        </Link>
      </div>
    </div>
  );
};

export default HRAnalyticsPage;
