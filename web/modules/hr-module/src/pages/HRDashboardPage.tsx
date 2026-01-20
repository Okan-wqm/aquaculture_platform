/**
 * HR Dashboard Page
 *
 * Main dashboard for the Human Resources module with aquaculture-specific features.
 * Displays workforce metrics, certification alerts, and crew status.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  Building2,
  Clock,
  Calendar,
  DollarSign,
  TrendingUp,
  Award,
  GraduationCap,
  BarChart3,
  UserPlus,
  UserCheck,
  Ship,
  Anchor,
  AlertTriangle,
  Shield,
  RefreshCw,
} from 'lucide-react';
import {
  useEmployees,
  usePendingLeaveApprovals,
  useExpiringCertifications,
  useCurrentlyOffshore,
  useWorkAreas,
  useDepartments,
} from '../hooks';
import { useAuth } from '@shared-ui/hooks';
import { CertificationExpiryAlert, SeaLandSplitView } from '../components';
import { cn } from '@shared-ui/utils';

// ============================================================================
// Types
// ============================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  icon: React.ReactNode;
  color: string;
  isLoading?: boolean;
}

interface QuickActionProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  to: string;
  color: string;
  badge?: number;
}

// ============================================================================
// Components
// ============================================================================

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  change,
  changeType = 'neutral',
  icon,
  color,
  isLoading,
}) => {
  const changeColors = {
    positive: 'text-green-600 dark:text-green-400',
    negative: 'text-red-600 dark:text-red-400',
    neutral: 'text-gray-600 dark:text-gray-400',
  };

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{title}</p>
          {isLoading ? (
            <div className="mt-1 h-8 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          ) : (
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
          )}
          {change && (
            <p className={`mt-1 text-sm ${changeColors[changeType]}`}>{change}</p>
          )}
        </div>
        <div className={`rounded-lg p-3 ${color}`}>{icon}</div>
      </div>
    </div>
  );
};

const QuickAction: React.FC<QuickActionProps> = ({
  title,
  description,
  icon,
  to,
  color,
  badge,
}) => {
  return (
    <Link
      to={to}
      className="flex items-center gap-4 rounded-lg border border-gray-100 bg-white p-4 transition-all hover:border-gray-200 hover:shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600"
    >
      <div className={`rounded-lg p-3 ${color}`}>{icon}</div>
      <div className="flex-1">
        <h4 className="font-medium text-gray-900 dark:text-white">{title}</h4>
        <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      {badge !== undefined && badge > 0 && (
        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-red-100 px-2 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {badge}
        </span>
      )}
    </Link>
  );
};

const LoadingSkeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn('animate-pulse rounded bg-gray-200 dark:bg-gray-700', className)} />
);

// ============================================================================
// HR Dashboard Page
// ============================================================================

export function HRDashboardPage() {
  const { user } = useAuth();
  const employeeId = user?.sub || '';

  // Data fetching with hooks
  const { data: employees, isLoading: loadingEmployees } = useEmployees({}, { limit: 1000 });
  const { data: pendingLeaves, isLoading: loadingLeaves } = usePendingLeaveApprovals(employeeId);
  const { data: expiringCerts, isLoading: loadingCerts } = useExpiringCertifications(30);
  const { data: offshoreEmployees, isLoading: loadingOffshore } = useCurrentlyOffshore();
  const { data: departments, isLoading: loadingDepts } = useDepartments();
  const { data: workAreas } = useWorkAreas();

  // Calculate stats
  const totalEmployees = employees?.total || 0;
  const activeEmployees = employees?.items?.filter((e) => e.status === 'active').length || 0;
  const onLeaveCount = employees?.items?.filter((e) => e.status === 'on_leave').length || 0;
  const offshoreCount = offshoreEmployees?.length || 0;
  const onshoreCount = activeEmployees - offshoreCount;
  const pendingLeavesCount = pendingLeaves?.length || 0;
  const expiringCertsCount = expiringCerts?.length || 0;
  const departmentCount = departments?.length || 0;

  // Separate employees for sea/land view
  const offshoreList = employees?.items?.filter((e) => e.personnelCategory === 'offshore') || [];
  const onshoreList = employees?.items?.filter((e) => e.personnelCategory === 'onshore') || [];

  const isLoading = loadingEmployees || loadingLeaves || loadingCerts || loadingOffshore;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">HR Dashboard</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Workforce management and human resources overview
          </p>
        </div>
        <Link
          to="/hr/employees/new"
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          <UserPlus className="h-4 w-4" />
          Add Employee
        </Link>
      </div>

      {/* Primary Stats Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Employees"
          value={totalEmployees}
          change={`${activeEmployees} active`}
          changeType="neutral"
          icon={<Users className="h-6 w-6 text-indigo-600" />}
          color="bg-indigo-50 dark:bg-indigo-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Offshore Crew"
          value={offshoreCount}
          change="Currently deployed"
          changeType="neutral"
          icon={<Ship className="h-6 w-6 text-blue-600" />}
          color="bg-blue-50 dark:bg-blue-900/30"
          isLoading={loadingOffshore}
        />
        <StatCard
          title="On Leave"
          value={onLeaveCount}
          icon={<Calendar className="h-6 w-6 text-amber-600" />}
          color="bg-amber-50 dark:bg-amber-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Departments"
          value={departmentCount}
          icon={<Building2 className="h-6 w-6 text-emerald-600" />}
          color="bg-emerald-50 dark:bg-emerald-900/30"
          isLoading={loadingDepts}
        />
      </div>

      {/* Alerts Section */}
      {(pendingLeavesCount > 0 || expiringCertsCount > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {pendingLeavesCount > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-amber-100 p-2 dark:bg-amber-900/50">
                  <Clock className="h-5 w-5 text-amber-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-amber-900 dark:text-amber-100">
                    Pending Leave Approvals
                  </h3>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {pendingLeavesCount} request{pendingLeavesCount !== 1 ? 's' : ''} awaiting your
                    review
                  </p>
                </div>
                <Link
                  to="/hr/leaves"
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
                >
                  Review
                </Link>
              </div>
            </div>
          )}

          {expiringCertsCount > 0 && (
            <CertificationExpiryAlert
              certifications={expiringCerts || []}
              onRenewClick={(cert) => {
                // Navigate to certification renewal
                window.location.href = `/hr/training/certifications?renew=${cert.id}`;
              }}
            />
          )}
        </div>
      )}

      {/* Aquaculture-Specific: Sea/Land Crew Split */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Anchor className="h-5 w-5 text-indigo-600" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Crew Distribution
            </h3>
          </div>
          <Link
            to="/hr/crew"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Manage Crew
          </Link>
        </div>
        <SeaLandSplitView
          offshoreEmployees={offshoreList.slice(0, 6)}
          onshoreEmployees={onshoreList.slice(0, 6)}
          isLoading={loadingEmployees}
        />
      </div>

      {/* Quick Actions Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* People Management */}
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            People Management
          </h3>
          <div className="space-y-3">
            <QuickAction
              title="Employees"
              description="View and manage all employees"
              icon={<Users className="h-5 w-5 text-indigo-600" />}
              to="/hr/employees"
              color="bg-indigo-50 dark:bg-indigo-900/30"
            />
            <QuickAction
              title="Leave Management"
              description="Handle leave requests and balances"
              icon={<Calendar className="h-5 w-5 text-amber-600" />}
              to="/hr/leaves"
              color="bg-amber-50 dark:bg-amber-900/30"
              badge={pendingLeavesCount}
            />
            <QuickAction
              title="Attendance"
              description="Track time and attendance records"
              icon={<Clock className="h-5 w-5 text-cyan-600" />}
              to="/hr/attendance"
              color="bg-cyan-50 dark:bg-cyan-900/30"
            />
            <QuickAction
              title="Payroll"
              description="Salary and payment management"
              icon={<DollarSign className="h-5 w-5 text-green-600" />}
              to="/hr/payroll"
              color="bg-green-50 dark:bg-green-900/30"
            />
          </div>
        </div>

        {/* Aquaculture & Compliance */}
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Aquaculture & Compliance
          </h3>
          <div className="space-y-3">
            <QuickAction
              title="Crew Assignments"
              description="Offshore rotations and work areas"
              icon={<Ship className="h-5 w-5 text-blue-600" />}
              to="/hr/crew"
              color="bg-blue-50 dark:bg-blue-900/30"
            />
            <QuickAction
              title="Certifications"
              description="Safety and diving certifications"
              icon={<Shield className="h-5 w-5 text-emerald-600" />}
              to="/hr/training/certifications"
              color="bg-emerald-50 dark:bg-emerald-900/30"
              badge={expiringCertsCount}
            />
            <QuickAction
              title="Training Programs"
              description="Courses and compliance training"
              icon={<GraduationCap className="h-5 w-5 text-purple-600" />}
              to="/hr/training"
              color="bg-purple-50 dark:bg-purple-900/30"
            />
            <QuickAction
              title="Offshore Rotations"
              description="View and manage rotation schedules"
              icon={<RefreshCw className="h-5 w-5 text-orange-600" />}
              to="/hr/crew/rotations"
              color="bg-orange-50 dark:bg-orange-900/30"
            />
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Sea Worthy"
          value={employees?.items?.filter((e) => e.seaWorthy).length || 0}
          change="Certified for offshore"
          changeType="positive"
          icon={<Anchor className="h-6 w-6 text-teal-600" />}
          color="bg-teal-50 dark:bg-teal-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Active Certifications"
          value={
            employees?.items?.reduce((acc, e) => acc + (e.certifications?.length || 0), 0) || 0
          }
          icon={<Award className="h-6 w-6 text-purple-600" />}
          color="bg-purple-50 dark:bg-purple-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Work Areas"
          value={workAreas?.length || 0}
          change="Operational sites"
          changeType="neutral"
          icon={<Building2 className="h-6 w-6 text-slate-600" />}
          color="bg-slate-50 dark:bg-slate-900/30"
        />
        <StatCard
          title="Expiring Certs"
          value={expiringCertsCount}
          change="Within 30 days"
          changeType={expiringCertsCount > 0 ? 'negative' : 'positive'}
          icon={<AlertTriangle className="h-6 w-6 text-red-600" />}
          color="bg-red-50 dark:bg-red-900/30"
          isLoading={loadingCerts}
        />
      </div>

      {/* Analytics & Performance */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Performance & Analytics
          </h3>
          <div className="space-y-3">
            <QuickAction
              title="Performance Reviews"
              description="Employee evaluations and feedback"
              icon={<TrendingUp className="h-5 w-5 text-orange-600" />}
              to="/hr/performance"
              color="bg-orange-50 dark:bg-orange-900/30"
            />
            <QuickAction
              title="HR Analytics"
              description="Detailed reports and insights"
              icon={<BarChart3 className="h-5 w-5 text-violet-600" />}
              to="/hr/analytics"
              color="bg-violet-50 dark:bg-violet-900/30"
            />
            <QuickAction
              title="Departments"
              description="Organization structure and hierarchy"
              icon={<Building2 className="h-5 w-5 text-gray-600" />}
              to="/hr/departments"
              color="bg-gray-50 dark:bg-gray-700"
            />
          </div>
        </div>

        {/* Recent Activity */}
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Recent Activity
          </h3>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-4">
                  <LoadingSkeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <LoadingSkeleton className="h-4 w-3/4" />
                    <LoadingSkeleton className="h-3 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Dynamic activity based on data */}
              {pendingLeaves && pendingLeaves.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-amber-50 p-2 dark:bg-amber-900/30">
                    <Calendar className="h-4 w-4 text-amber-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-900 dark:text-white">
                      {pendingLeaves[0].employee?.firstName} {pendingLeaves[0].employee?.lastName}{' '}
                      submitted a leave request
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(pendingLeaves[0].requestedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              )}

              {expiringCerts && expiringCerts.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-red-50 p-2 dark:bg-red-900/30">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-900 dark:text-white">
                      {expiringCerts[0].employee?.firstName}'s {expiringCerts[0].certificationType?.name} expires soon
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Expires {new Date(expiringCerts[0].expiryDate).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              )}

              {offshoreEmployees && offshoreEmployees.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-blue-50 p-2 dark:bg-blue-900/30">
                    <Ship className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-900 dark:text-white">
                      {offshoreCount} crew members currently offshore
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Active deployment</p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-4">
                <div className="rounded-lg bg-green-50 p-2 dark:bg-green-900/30">
                  <UserCheck className="h-4 w-4 text-green-600" />
                </div>
                <div className="flex-1">
                  <p className="text-sm text-gray-900 dark:text-white">
                    {activeEmployees} employees currently active
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Workforce status</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default HRDashboardPage;
