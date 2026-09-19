/**
 * HR Dashboard Page
 *
 * Main dashboard for the Human Resources module with aquaculture-specific features.
 * Displays workforce metrics, certification alerts, and crew status.
 */

import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  useHRDashboardStats,
  usePendingLeaveApprovals,
  useExpiringCertifications,
  useCurrentlyOffshore,
  useWorkAreas,
  useDepartments,
  useCurrentEmployeeId,
} from '../hooks';
import { CertificationExpiryAlert, SeaLandSplitView } from '../components';
import { cn, PageHeader } from '@aquaculture/shared-ui';

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
    positive: 'text-success-600 dark:text-success-400',
    negative: 'text-error-600 dark:text-error-400',
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
          {change && <p className={`mt-1 text-sm ${changeColors[changeType]}`}>{change}</p>}
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
        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-error-100 px-2 text-xs font-medium text-error-700 dark:bg-error-900/30 dark:text-error-400">
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
  const navigate = useNavigate();
  // CRIT-5 / BUG-011: use centralised hook instead of user?.id or user?.sub
  const employeeId = useCurrentEmployeeId();

  // CRIT-3 / PERF-001: use pre-aggregated stats query instead of limit:1000
  const { data: stats, isLoading: loadingStats } = useHRDashboardStats();
  const { data: pendingLeaves, isLoading: loadingLeaves } = usePendingLeaveApprovals(employeeId);
  const { data: expiringCerts, isLoading: loadingCerts } = useExpiringCertifications(30);
  const { data: offshoreEmployees, isLoading: loadingOffshore } = useCurrentlyOffshore();
  const { data: departments, isLoading: loadingDepts } = useDepartments();
  const { data: workAreas } = useWorkAreas();

  const totalEmployees = stats?.totalEmployees || 0;
  const activeEmployees = stats?.activeEmployees || 0;
  const onLeaveCount = stats?.onLeaveEmployees || 0;
  const offshoreCount = stats?.offshoreEmployees || offshoreEmployees?.length || 0;
  const departmentCount = stats?.totalDepartments || departments?.length || 0;
  const pendingLeavesCount = pendingLeaves?.length || 0;
  const expiringCertsCount = expiringCerts?.length || 0;

  const isLoading = loadingStats || loadingLeaves || loadingCerts || loadingOffshore;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <PageHeader
        title="HR Dashboard"
        description="Workforce management and human resources overview"
        actions={
          <Link
            to="/hr/employees/new"
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
          >
            <UserPlus className="h-4 w-4" />
            Add Employee
          </Link>
        }
      />

      {/* Primary Stats Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Employees"
          value={totalEmployees}
          change={`${activeEmployees} active`}
          changeType="neutral"
          icon={<Users className="h-6 w-6 text-primary-600 dark:text-primary-400" />}
          color="bg-primary-50 dark:bg-primary-900/30"
          isLoading={loadingStats}
        />
        <StatCard
          title="Offshore Crew"
          value={offshoreCount}
          change="Currently deployed"
          changeType="neutral"
          icon={<Ship className="h-6 w-6 text-info-600 dark:text-info-400" />}
          color="bg-info-50 dark:bg-info-900/30"
          isLoading={loadingStats || loadingOffshore}
        />
        <StatCard
          title="On Leave"
          value={onLeaveCount}
          icon={<Calendar className="h-6 w-6 text-warning-600 dark:text-warning-400" />}
          color="bg-warning-50 dark:bg-warning-900/30"
          isLoading={loadingStats}
        />
        <StatCard
          title="Departments"
          value={departmentCount}
          icon={<Building2 className="h-6 w-6 text-success-600 dark:text-success-400" />}
          color="bg-success-50 dark:bg-success-900/30"
          isLoading={loadingStats || loadingDepts}
        />
      </div>

      {/* Alerts Section */}
      {(pendingLeavesCount > 0 || expiringCertsCount > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {pendingLeavesCount > 0 && (
            <div className="rounded-xl border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-warning-100 p-2 dark:bg-warning-900/50">
                  <Clock className="h-5 w-5 text-warning-600 dark:text-warning-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-warning-900 dark:text-warning-100">
                    Pending Leave Approvals
                  </h3>
                  <p className="text-sm text-warning-700 dark:text-warning-300">
                    {pendingLeavesCount} request{pendingLeavesCount !== 1 ? 's' : ''} awaiting your
                    review
                  </p>
                </div>
                <Link
                  to="/hr/leaves"
                  className="rounded-lg bg-warning-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-warning-700"
                >
                  Review
                </Link>
              </div>
            </div>
          )}

          {expiringCertsCount > 0 && (
            <CertificationExpiryAlert
              onRenew={(certificationId) => {
                // SEC-008: use navigate() with encodeURIComponent instead of window.location.href
                navigate(
                  `/hr/training/certifications?renew=${encodeURIComponent(certificationId)}`,
                );
              }}
            />
          )}
        </div>
      )}

      {/* Aquaculture-Specific: Sea/Land Crew Split */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Anchor className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Crew Distribution
            </h3>
          </div>
          <Link
            to="/hr/crew"
            className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
          >
            Manage Crew
          </Link>
        </div>
        {/* SeaLandSplitView fetches its own data with an appropriate limit */}
        <SeaLandSplitView variant="compact" />
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
              icon={<Users className="h-5 w-5 text-primary-600 dark:text-primary-400" />}
              to="/hr/employees"
              color="bg-primary-50 dark:bg-primary-900/30"
            />
            <QuickAction
              title="Leave Management"
              description="Handle leave requests and balances"
              icon={<Calendar className="h-5 w-5 text-warning-600 dark:text-warning-400" />}
              to="/hr/leaves"
              color="bg-warning-50 dark:bg-warning-900/30"
              badge={pendingLeavesCount}
            />
            <QuickAction
              title="Attendance"
              description="Track time and attendance records"
              icon={<Clock className="h-5 w-5 text-info-600 dark:text-info-400" />}
              to="/hr/attendance"
              color="bg-info-50 dark:bg-info-900/30"
            />
            <QuickAction
              title="Payroll"
              description="Salary and payment management"
              icon={<DollarSign className="h-5 w-5 text-success-600 dark:text-success-400" />}
              to="/hr/payroll"
              color="bg-success-50 dark:bg-success-900/30"
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
              icon={<Ship className="h-5 w-5 text-info-600 dark:text-info-400" />}
              to="/hr/crew"
              color="bg-info-50 dark:bg-info-900/30"
            />
            <QuickAction
              title="Certifications"
              description="Safety and diving certifications"
              icon={<Shield className="h-5 w-5 text-success-600 dark:text-success-400" />}
              to="/hr/training/certifications"
              color="bg-success-50 dark:bg-success-900/30"
              badge={expiringCertsCount}
            />
            <QuickAction
              title="Training Programs"
              description="Courses and compliance training"
              icon={<GraduationCap className="h-5 w-5 text-accent-600 dark:text-accent-400" />}
              to="/hr/training"
              color="bg-accent-50 dark:bg-accent-900/30"
            />
            <QuickAction
              title="Offshore Rotations"
              description="View and manage rotation schedules"
              icon={<RefreshCw className="h-5 w-5 text-warning-600 dark:text-warning-400" />}
              to="/hr/crew/rotations"
              color="bg-warning-50 dark:bg-warning-900/30"
            />
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Onshore Crew"
          value={stats?.onshoreEmployees || 0}
          change="Currently onshore"
          changeType="positive"
          icon={<Anchor className="h-6 w-6 text-info-600 dark:text-info-400" />}
          color="bg-info-50 dark:bg-info-900/30"
          isLoading={loadingStats}
        />
        <StatCard
          title="Active Certifications"
          value={expiringCertsCount}
          icon={<Award className="h-6 w-6 text-accent-600 dark:text-accent-400" />}
          color="bg-accent-50 dark:bg-accent-900/30"
          isLoading={loadingCerts}
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
          icon={<AlertTriangle className="h-6 w-6 text-error-600 dark:text-error-400" />}
          color="bg-error-50 dark:bg-error-900/30"
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
              icon={<TrendingUp className="h-5 w-5 text-warning-600 dark:text-warning-400" />}
              to="/hr/performance"
              color="bg-warning-50 dark:bg-warning-900/30"
            />
            <QuickAction
              title="HR Analytics"
              description="Detailed reports and insights"
              icon={<BarChart3 className="h-5 w-5 text-accent-600 dark:text-accent-400" />}
              to="/hr/analytics"
              color="bg-accent-50 dark:bg-accent-900/30"
            />
            <QuickAction
              title="Departments"
              description="Organization structure and hierarchy"
              icon={<Building2 className="h-5 w-5 text-gray-600 dark:text-gray-400" />}
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
              {pendingLeaves && pendingLeaves.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-warning-50 p-2 dark:bg-warning-900/30">
                    <Calendar className="h-4 w-4 text-warning-600 dark:text-warning-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-900 dark:text-white">
                      {pendingLeaves[0].employee?.firstName} {pendingLeaves[0].employee?.lastName}{' '}
                      submitted a leave request
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(pendingLeaves[0].createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              )}

              {expiringCerts && expiringCerts.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-error-50 p-2 dark:bg-error-900/30">
                    <AlertTriangle className="h-4 w-4 text-error-600 dark:text-error-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-900 dark:text-white">
                      {expiringCerts[0].employee?.firstName}'s{' '}
                      {expiringCerts[0].certificationType?.name} expires soon
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Expires{' '}
                      {expiringCerts[0].expiryDate
                        ? new Date(expiringCerts[0].expiryDate).toLocaleDateString()
                        : 'N/A'}
                    </p>
                  </div>
                </div>
              )}

              {offshoreEmployees && offshoreEmployees.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="rounded-lg bg-info-50 p-2 dark:bg-info-900/30">
                    <Ship className="h-4 w-4 text-info-600 dark:text-info-400" />
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
                <div className="rounded-lg bg-success-50 p-2 dark:bg-success-900/30">
                  <UserCheck className="h-4 w-4 text-success-600 dark:text-success-400" />
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
