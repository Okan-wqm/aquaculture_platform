/**
 * Certification Dashboard Page
 *
 * Comprehensive view of employee certifications including:
 * - Safety certifications
 * - Diving certifications
 * - Vessel operation licenses
 * - Equipment qualifications
 */

import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Shield,
  Award,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Plus,
  Search,
  Filter,
  Download,
  Eye,
  RefreshCw,
  Users,
  Calendar,
  FileText,
} from 'lucide-react';
import { cn } from '@shared-ui/utils';
import {
  useCertificationTypes,
  useExpiringCertifications,
  useEmployeeCertifications,
  useEmployees,
} from '../../hooks';
import { DataTable, StatusBadge, EmployeeAvatar } from '../../components/common';
import { CertificationExpiryAlert } from '../../components/certification';
import type { Column } from '../../components/common';
import type {
  CertificationType,
  EmployeeCertification,
  CertificationCategory,
  CertificationStatus,
  PaginationInput,
} from '../../types';

// ============================================================================
// Constants
// ============================================================================

const CERTIFICATION_CATEGORY_CONFIG: Record<
  CertificationCategory,
  { label: string; color: string; icon: React.ReactNode }
> = {
  diving: {
    label: 'Diving',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    icon: <Shield className="h-4 w-4" />,
  },
  safety: {
    label: 'Safety',
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    icon: <Shield className="h-4 w-4" />,
  },
  vessel: {
    label: 'Vessel',
    color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    icon: <Award className="h-4 w-4" />,
  },
  equipment: {
    label: 'Equipment',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    icon: <Award className="h-4 w-4" />,
  },
  first_aid: {
    label: 'First Aid',
    color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    icon: <Shield className="h-4 w-4" />,
  },
  regulatory: {
    label: 'Regulatory',
    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    icon: <FileText className="h-4 w-4" />,
  },
  professional: {
    label: 'Professional',
    color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    icon: <Award className="h-4 w-4" />,
  },
};

const STATUS_CONFIG: Record<CertificationStatus, { label: string; variant: 'success' | 'warning' | 'error' | 'neutral' }> = {
  active: { label: 'Active', variant: 'success' },
  expired: { label: 'Expired', variant: 'error' },
  expiring_soon: { label: 'Expiring Soon', variant: 'warning' },
  pending: { label: 'Pending', variant: 'neutral' },
  revoked: { label: 'Revoked', variant: 'error' },
};

// ============================================================================
// Components
// ============================================================================

interface StatCardProps {
  title: string;
  value: number | string;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
  trend?: { value: number; isPositive: boolean };
  isLoading?: boolean;
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  color,
  trend,
  isLoading,
}) => (
  <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{title}</p>
        {isLoading ? (
          <div className="mt-1 h-8 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        ) : (
          <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        )}
        {subtitle && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
        {trend && (
          <p
            className={cn(
              'mt-1 text-xs font-medium',
              trend.isPositive ? 'text-green-600' : 'text-red-600'
            )}
          >
            {trend.isPositive ? '+' : ''}{trend.value}% from last month
          </p>
        )}
      </div>
      <div className={cn('rounded-lg p-3', color)}>{icon}</div>
    </div>
  </div>
);

const CertificationTypeCard: React.FC<{
  type: CertificationType;
  activeCount: number;
  expiringCount: number;
}> = ({ type, activeCount, expiringCount }) => {
  const categoryConfig = CERTIFICATION_CATEGORY_CONFIG[type.category] || CERTIFICATION_CATEGORY_CONFIG.professional;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={cn('rounded-lg p-2', categoryConfig.color)}>{categoryConfig.icon}</div>
          <div>
            <h4 className="font-medium text-gray-900 dark:text-white">{type.name}</h4>
            <p className="text-sm text-gray-500 dark:text-gray-400">{categoryConfig.label}</p>
          </div>
        </div>
        {type.isMandatory && (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
            Required
          </span>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-gray-100 pt-3 dark:border-gray-700">
        <div>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{activeCount}</p>
          <p className="text-xs text-gray-500">Active</p>
        </div>
        <div>
          <p
            className={cn(
              'text-2xl font-bold',
              expiringCount > 0
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-900 dark:text-white'
            )}
          >
            {expiringCount}
          </p>
          <p className="text-xs text-gray-500">Expiring</p>
        </div>
      </div>
      {type.validityPeriodMonths && (
        <p className="mt-3 text-xs text-gray-500">
          Valid for {type.validityPeriodMonths} months
        </p>
      )}
    </div>
  );
};

// ============================================================================
// Certification Dashboard Page
// ============================================================================

export function CertificationDashboardPage() {
  const [searchParams] = useSearchParams();
  const renewCertId = searchParams.get('renew');

  // State
  const [activeTab, setActiveTab] = useState<'overview' | 'certifications' | 'types' | 'compliance'>(
    'overview'
  );
  const [categoryFilter, setCategoryFilter] = useState<CertificationCategory | ''>('');
  const [statusFilter, setStatusFilter] = useState<CertificationStatus | ''>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, offset: 0 });

  // Data fetching
  const { data: certTypes, isLoading: loadingTypes } = useCertificationTypes(
    categoryFilter ? { category: categoryFilter } : undefined
  );
  const { data: expiring30, isLoading: loadingExpiring30 } = useExpiringCertifications(30);
  const { data: expiring7 } = useExpiringCertifications(7);
  const { data: employees, isLoading: loadingEmployees } = useEmployees({}, { limit: 1000 });

  // Calculate stats
  const totalCertTypes = certTypes?.length || 0;
  const mandatoryCertTypes = certTypes?.filter((t) => t.isMandatory).length || 0;
  const expiringIn30Days = expiring30?.length || 0;
  const expiringIn7Days = expiring7?.length || 0;
  const expiredCount = expiring30?.filter((c) => new Date(c.expiryDate) < new Date()).length || 0;

  // All certifications from employees
  const allCertifications: EmployeeCertification[] = employees?.items?.flatMap(
    (emp) =>
      emp.certifications?.map((cert) => ({
        ...cert,
        employee: emp,
      })) || []
  ) || [];

  const activeCertifications = allCertifications.filter((c) => c.status === 'active');
  const totalActive = activeCertifications.length;

  // Calculate compliance rate
  const employeesWithMandatoryCerts = employees?.items?.filter((emp) => {
    const mandatoryTypes = certTypes?.filter((t) => t.isMandatory) || [];
    const empCertTypeIds = emp.certifications?.map((c) => c.certificationTypeId) || [];
    return mandatoryTypes.every((mt) => empCertTypeIds.includes(mt.id));
  }).length || 0;
  const complianceRate = employees?.total
    ? Math.round((employeesWithMandatoryCerts / employees.total) * 100)
    : 0;

  // Certification columns
  const certificationColumns: Column<EmployeeCertification>[] = [
    {
      key: 'employee',
      header: 'Employee',
      sortable: true,
      accessor: (row) => (
        <div className="flex items-center gap-3">
          {row.employee && (
            <>
              <EmployeeAvatar
                firstName={row.employee.firstName}
                lastName={row.employee.lastName}
                avatarUrl={row.employee.avatarUrl}
                size="sm"
              />
              <div>
                <p className="font-medium text-gray-900 dark:text-white">
                  {row.employee.firstName} {row.employee.lastName}
                </p>
                <p className="text-sm text-gray-500">{row.employee.employeeNumber}</p>
              </div>
            </>
          )}
        </div>
      ),
    },
    {
      key: 'certification',
      header: 'Certification',
      accessor: (row) => {
        const category = row.certificationType?.category;
        const config = category
          ? CERTIFICATION_CATEGORY_CONFIG[category]
          : CERTIFICATION_CATEGORY_CONFIG.professional;
        return (
          <div className="flex items-center gap-2">
            <div className={cn('rounded p-1', config.color)}>{config.icon}</div>
            <div>
              <p className="font-medium text-gray-900 dark:text-white">
                {row.certificationType?.name}
              </p>
              <p className="text-sm text-gray-500">{row.certificateNumber}</p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'issuedBy',
      header: 'Issued By',
      accessor: (row) => (
        <span className="text-gray-600 dark:text-gray-300">{row.issuingAuthority || '-'}</span>
      ),
    },
    {
      key: 'dates',
      header: 'Validity',
      sortable: true,
      accessor: (row) => {
        const expiryDate = new Date(row.expiryDate);
        const daysUntilExpiry = Math.ceil(
          (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        const isExpired = daysUntilExpiry < 0;
        const isExpiringSoon = daysUntilExpiry >= 0 && daysUntilExpiry <= 30;

        return (
          <div className="text-sm">
            <p className="text-gray-900 dark:text-white">
              {new Date(row.issueDate).toLocaleDateString()} -{' '}
              {expiryDate.toLocaleDateString()}
            </p>
            <p
              className={cn(
                'text-xs',
                isExpired
                  ? 'text-red-600 dark:text-red-400'
                  : isExpiringSoon
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-500'
              )}
            >
              {isExpired
                ? `Expired ${Math.abs(daysUntilExpiry)} days ago`
                : `${daysUntilExpiry} days remaining`}
            </p>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => {
        const config = STATUS_CONFIG[row.status] || STATUS_CONFIG.pending;
        return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
      },
    },
    {
      key: 'actions',
      header: '',
      width: '100px',
      align: 'right',
      accessor: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            title="View"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-indigo-600 dark:hover:bg-gray-700"
            title="Renew"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      offset: (page - 1) * (pagination.limit || 20),
    });
  };

  const filteredCertifications = allCertifications.filter((cert) => {
    if (statusFilter && cert.status !== statusFilter) return false;
    if (
      categoryFilter &&
      cert.certificationType?.category !== categoryFilter
    )
      return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesEmployee =
        cert.employee?.firstName.toLowerCase().includes(query) ||
        cert.employee?.lastName.toLowerCase().includes(query);
      const matchesCert = cert.certificationType?.name.toLowerCase().includes(query);
      if (!matchesEmployee && !matchesCert) return false;
    }
    return true;
  });

  const isLoading = loadingTypes || loadingExpiring30 || loadingEmployees;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Certification Dashboard
          </h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Track and manage employee certifications and compliance
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">
            <Download className="h-4 w-4" />
            Export
          </button>
          <button className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            <Plus className="h-4 w-4" />
            Add Certification
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          title="Active Certs"
          value={totalActive}
          icon={<CheckCircle className="h-5 w-5 text-green-600" />}
          color="bg-green-50 dark:bg-green-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Cert Types"
          value={totalCertTypes}
          subtitle={`${mandatoryCertTypes} mandatory`}
          icon={<Award className="h-5 w-5 text-indigo-600" />}
          color="bg-indigo-50 dark:bg-indigo-900/30"
          isLoading={loadingTypes}
        />
        <StatCard
          title="Expiring Soon"
          value={expiringIn30Days}
          subtitle="Within 30 days"
          icon={<Clock className="h-5 w-5 text-amber-600" />}
          color="bg-amber-50 dark:bg-amber-900/30"
          isLoading={loadingExpiring30}
        />
        <StatCard
          title="Critical"
          value={expiringIn7Days}
          subtitle="Within 7 days"
          icon={<AlertTriangle className="h-5 w-5 text-orange-600" />}
          color="bg-orange-50 dark:bg-orange-900/30"
        />
        <StatCard
          title="Expired"
          value={expiredCount}
          icon={<XCircle className="h-5 w-5 text-red-600" />}
          color="bg-red-50 dark:bg-red-900/30"
        />
        <StatCard
          title="Compliance"
          value={`${complianceRate}%`}
          subtitle="Mandatory certs"
          icon={<Shield className="h-5 w-5 text-emerald-600" />}
          color="bg-emerald-50 dark:bg-emerald-900/30"
          isLoading={loadingEmployees || loadingTypes}
        />
      </div>

      {/* Expiring Certifications Alert */}
      {expiring30 && expiring30.length > 0 && (
        <CertificationExpiryAlert
          certifications={expiring30.slice(0, 5)}
          onRenewClick={(cert) => {
            console.log('Renew certification:', cert.id);
          }}
        />
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('overview')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'overview'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('certifications')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'certifications'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          All Certifications
        </button>
        <button
          onClick={() => setActiveTab('types')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'types'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Certification Types
        </button>
        <button
          onClick={() => setActiveTab('compliance')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'compliance'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Compliance Report
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Certification Types by Category */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              Certification Types
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {certTypes?.map((type) => {
                const activeCount = allCertifications.filter(
                  (c) => c.certificationTypeId === type.id && c.status === 'active'
                ).length;
                const expiringCount =
                  expiring30?.filter((c) => c.certificationTypeId === type.id).length || 0;
                return (
                  <CertificationTypeCard
                    key={type.id}
                    type={type}
                    activeCount={activeCount}
                    expiringCount={expiringCount}
                  />
                );
              })}
            </div>
          </div>

          {/* Recent Certifications */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Recent Certifications
              </h3>
              <button
                onClick={() => setActiveTab('certifications')}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
              >
                View All
              </button>
            </div>
            <DataTable
              data={activeCertifications.slice(0, 5)}
              columns={certificationColumns}
              keyExtractor={(row) => row.id}
              isLoading={loadingEmployees}
              emptyMessage="No certifications found"
            />
          </div>
        </div>
      )}

      {activeTab === 'certifications' && (
        <div className="space-y-4">
          {/* Search and Filters */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search certifications..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as CertificationCategory | '')}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
                <option value="">All Categories</option>
                <option value="diving">Diving</option>
                <option value="safety">Safety</option>
                <option value="vessel">Vessel</option>
                <option value="equipment">Equipment</option>
                <option value="first_aid">First Aid</option>
                <option value="regulatory">Regulatory</option>
                <option value="professional">Professional</option>
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as CertificationStatus | '')}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="expiring_soon">Expiring Soon</option>
                <option value="expired">Expired</option>
                <option value="pending">Pending</option>
                <option value="revoked">Revoked</option>
              </select>
            </div>
          </div>

          {/* Certifications Table */}
          <DataTable
            data={filteredCertifications}
            columns={certificationColumns}
            keyExtractor={(row) => row.id}
            isLoading={loadingEmployees}
            emptyMessage="No certifications found"
            total={filteredCertifications.length}
            page={Math.floor((pagination.offset || 0) / (pagination.limit || 20)) + 1}
            pageSize={pagination.limit || 20}
            onPageChange={handlePageChange}
          />
        </div>
      )}

      {activeTab === 'types' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {certTypes?.length || 0} certification types configured
            </p>
            <button className="flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-4 w-4" />
              Add Certification Type
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {certTypes?.map((type) => {
              const activeCount = allCertifications.filter(
                (c) => c.certificationTypeId === type.id && c.status === 'active'
              ).length;
              const expiringCount =
                expiring30?.filter((c) => c.certificationTypeId === type.id).length || 0;
              return (
                <CertificationTypeCard
                  key={type.id}
                  type={type}
                  activeCount={activeCount}
                  expiringCount={expiringCount}
                />
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'compliance' && (
        <div className="space-y-6">
          {/* Compliance Summary */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              Compliance Summary
            </h3>
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Compliance Rate Chart Placeholder */}
              <div className="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-gray-50 p-8 dark:border-gray-700 dark:bg-gray-900">
                <div className="relative flex h-32 w-32 items-center justify-center">
                  <svg className="h-full w-full -rotate-90">
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="12"
                      fill="none"
                      className="text-gray-200 dark:text-gray-700"
                    />
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="12"
                      fill="none"
                      strokeDasharray={`${complianceRate * 3.52} 352`}
                      className={cn(
                        complianceRate >= 90
                          ? 'text-green-500'
                          : complianceRate >= 70
                          ? 'text-amber-500'
                          : 'text-red-500'
                      )}
                    />
                  </svg>
                  <span className="absolute text-2xl font-bold text-gray-900 dark:text-white">
                    {complianceRate}%
                  </span>
                </div>
                <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                  Overall Compliance Rate
                </p>
              </div>

              {/* Compliance Breakdown */}
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-green-100 p-2 dark:bg-green-900/30">
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">Fully Compliant</p>
                      <p className="text-sm text-gray-500">All mandatory certifications</p>
                    </div>
                  </div>
                  <span className="text-2xl font-bold text-green-600">
                    {employeesWithMandatoryCerts}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-amber-100 p-2 dark:bg-amber-900/30">
                      <AlertTriangle className="h-5 w-5 text-amber-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">Expiring Soon</p>
                      <p className="text-sm text-gray-500">Within 30 days</p>
                    </div>
                  </div>
                  <span className="text-2xl font-bold text-amber-600">{expiringIn30Days}</span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-red-100 p-2 dark:bg-red-900/30">
                      <XCircle className="h-5 w-5 text-red-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">Non-Compliant</p>
                      <p className="text-sm text-gray-500">Missing mandatory certs</p>
                    </div>
                  </div>
                  <span className="text-2xl font-bold text-red-600">
                    {(employees?.total || 0) - employeesWithMandatoryCerts}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Mandatory Certifications Status */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              Mandatory Certification Status
            </h3>
            <div className="space-y-3">
              {certTypes
                ?.filter((t) => t.isMandatory)
                .map((type) => {
                  const totalEmployees = employees?.total || 0;
                  const certifiedCount = allCertifications.filter(
                    (c) => c.certificationTypeId === type.id && c.status === 'active'
                  ).length;
                  const percentage = totalEmployees
                    ? Math.round((certifiedCount / totalEmployees) * 100)
                    : 0;

                  return (
                    <div key={type.id} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-gray-900 dark:text-white">
                          {type.name}
                        </span>
                        <span className="text-gray-500">
                          {certifiedCount}/{totalEmployees} ({percentage}%)
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            percentage >= 90
                              ? 'bg-green-500'
                              : percentage >= 70
                              ? 'bg-amber-500'
                              : 'bg-red-500'
                          )}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CertificationDashboardPage;
