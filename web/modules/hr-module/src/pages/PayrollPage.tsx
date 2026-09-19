/**
 * Payroll Page
 *
 * Full payroll management: list, create, approve payrolls.
 * SEC-003: Role gate — only payroll_admin / hr_manager may access this page.
 * Salary values are sensitive PII and must NOT be visible to unprivileged users.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Plus, Search, Filter, CheckCircle, Clock, FileText, TrendingUp } from 'lucide-react';
import {
  cn,
  Modal,
  useAuth,
  useConfirm,
  SearchableSelect,
  formatCurrency as sharedFormatCurrency,
  parseMoney,
  DEFAULT_CURRENCY,
  DataTable,
  type DataTableColumn,
  Spinner,
  PageHeader,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import {
  usePayrolls,
  usePendingPayrolls,
  useCreatePayroll,
  useApprovePayroll,
  useEmployees,
} from '../hooks';
import { derivePaginationMetadataV1 } from '@platform/pagination-contracts';
import { StatusBadge, EmployeeAvatar } from '../components/common';
import type { Payroll, PayrollFilterInput, CreatePayrollInput, Employee } from '../types';
import {
  PayrollStatus,
  PayPeriodType,
  PAYROLL_STATUS_CONFIG,
  PAY_PERIOD_TYPE_LABELS,
} from '../types';

// ============================================================================
// Helpers
// ============================================================================

function formatCurrency(amount: number | undefined | null, currency = DEFAULT_CURRENCY): string {
  if (amount == null) return '-';
  return sharedFormatCurrency(amount, currency);
}

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ============================================================================
// Create Payroll Modal
// ============================================================================

interface CreatePayrollModalProps {
  employees: readonly Employee[];
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: CreatePayrollInput) => void;
  isSubmitting: boolean;
}

function CreatePayrollModal({
  employees,
  isOpen,
  onClose,
  onSubmit,
  isSubmitting,
}: CreatePayrollModalProps) {
  const [employeeId, setEmployeeId] = useState('');
  const [payPeriodType, setPayPeriodType] = useState<PayPeriodType>(PayPeriodType.MONTHLY);
  const [payPeriodStart, setPayPeriodStart] = useState('');
  const [payPeriodEnd, setPayPeriodEnd] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [notes, setNotes] = useState('');

  // Work hours
  const [regularHours, setRegularHours] = useState(160);
  const [overtimeHours, setOvertimeHours] = useState(0);
  const [holidayHours, setHolidayHours] = useState(0);
  const [sickLeaveHours, setSickLeaveHours] = useState(0);
  const [vacationHours, setVacationHours] = useState(0);

  // Earnings
  const [baseSalary, setBaseSalary] = useState(0);
  const [overtimePay, setOvertimePay] = useState(0);
  const [bonus, setBonus] = useState(0);
  const [commission, setCommission] = useState(0);
  const [allowances, setAllowances] = useState(0);

  // Deductions
  const [tax, setTax] = useState(0);
  const [socialSecurity, setSocialSecurity] = useState(0);
  const [healthInsurance, setHealthInsurance] = useState(0);
  const [retirement, setRetirement] = useState(0);
  const [otherDeductions, setOtherDeductions] = useState(0);

  // Auto-calculate totals
  const grossPay = baseSalary + overtimePay + bonus + commission + allowances;
  const totalDeductions = tax + socialSecurity + healthInsurance + retirement + otherDeductions;
  const netPay = grossPay - totalDeductions;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId || !payPeriodStart || !payPeriodEnd) return;

    onSubmit({
      employeeId,
      payPeriodType,
      payPeriodStart,
      payPeriodEnd,
      workHours: {
        regularHours,
        overtimeHours: overtimeHours || undefined,
        holidayHours: holidayHours || undefined,
        sickLeaveHours: sickLeaveHours || undefined,
        vacationHours: vacationHours || undefined,
      },
      earnings: {
        baseSalary,
        overtime: overtimePay || undefined,
        bonus: bonus || undefined,
        commission: commission || undefined,
        allowances: allowances || undefined,
      },
      deductions: {
        tax: tax || undefined,
        socialSecurity: socialSecurity || undefined,
        healthInsurance: healthInsurance || undefined,
        retirement: retirement || undefined,
        otherDeductions: otherDeductions || undefined,
      },
      currency,
      notes: notes || undefined,
    });
  };

  const resetForm = () => {
    setEmployeeId('');
    setPayPeriodType(PayPeriodType.MONTHLY);
    setPayPeriodStart('');
    setPayPeriodEnd('');
    setCurrency(DEFAULT_CURRENCY);
    setNotes('');
    setRegularHours(160);
    setOvertimeHours(0);
    setHolidayHours(0);
    setSickLeaveHours(0);
    setVacationHours(0);
    setBaseSalary(0);
    setOvertimePay(0);
    setBonus(0);
    setCommission(0);
    setAllowances(0);
    setTax(0);
    setSocialSecurity(0);
    setHealthInsurance(0);
    setRetirement(0);
    setOtherDeductions(0);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="xl"
      title="Create Payroll"
      showCloseButton={!isSubmitting}
      closeOnEscape={!isSubmitting}
      closeOnOverlayClick={!isSubmitting}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="create-payroll-form"
            disabled={
              isSubmitting || !employeeId || !payPeriodStart || !payPeriodEnd || baseSalary <= 0
            }
          >
            {isSubmitting && <Spinner size="sm" color="white" />}
            Create Payroll
          </Button>
        </>
      }
    >
      <form id="create-payroll-form" onSubmit={handleSubmit} className="px-6 py-4">
        <div className="space-y-6">
          {/* Employee & Period */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Pay Period
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <SearchableSelect
                  label="Employee"
                  required
                  options={employees.map((emp) => ({
                    value: emp.id,
                    label: `${emp.firstName} ${emp.lastName} (${emp.employeeNumber})`,
                  }))}
                  value={employeeId}
                  onChange={(val) => setEmployeeId(String(val))}
                  placeholder="Select employee..."
                  searchPlaceholder="Search employees..."
                  size="md"
                />
              </div>

              <div>
                <label
                  htmlFor="payroll-payPeriodType"
                  className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Pay Period Type <span className="text-error-500">*</span>
                </label>
                <select
                  id="payroll-payPeriodType"
                  value={payPeriodType}
                  onChange={(e) => setPayPeriodType(e.target.value as PayPeriodType)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                >
                  {Object.entries(PAY_PERIOD_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="payroll-currency"
                  className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Currency
                </label>
                <Select
                  fullWidth
                  options={[
                    { value: 'USD', label: 'USD' },
                    { value: 'EUR', label: 'EUR' },
                    { value: 'GBP', label: 'GBP' },
                    { value: 'TRY', label: 'TRY' },
                    { value: 'NOK', label: 'NOK' },
                  ]}
                  id="payroll-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </div>

              <div>
                <label
                  htmlFor="payroll-periodStart"
                  className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Period Start <span className="text-error-500">*</span>
                </label>
                <Input
                  fullWidth
                  id="payroll-periodStart"
                  type="date"
                  value={payPeriodStart}
                  onChange={(e) => setPayPeriodStart(e.target.value)}
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="payroll-periodEnd"
                  className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Period End <span className="text-error-500">*</span>
                </label>
                <Input
                  fullWidth
                  id="payroll-periodEnd"
                  type="date"
                  value={payPeriodEnd}
                  onChange={(e) => setPayPeriodEnd(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          {/* Work Hours */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Work Hours
            </h3>
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {[
                { label: 'Regular', value: regularHours, setter: setRegularHours },
                { label: 'Overtime', value: overtimeHours, setter: setOvertimeHours },
                { label: 'Holiday', value: holidayHours, setter: setHolidayHours },
                { label: 'Sick Leave', value: sickLeaveHours, setter: setSickLeaveHours },
                { label: 'Vacation', value: vacationHours, setter: setVacationHours },
              ].map(({ label, value, setter }) => {
                const fieldId = `payroll-hours-${label.toLowerCase().replace(/\s+/g, '-')}`;
                return (
                  <div key={label}>
                    <label
                      htmlFor={fieldId}
                      className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                    >
                      {label}
                    </label>
                    <Input
                      fullWidth
                      id={fieldId}
                      type="number"
                      min="0"
                      max="744"
                      step="0.5"
                      value={value}
                      onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Earnings */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Earnings
            </h3>
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {[
                { label: 'Base Salary', value: baseSalary, setter: setBaseSalary },
                { label: 'Overtime Pay', value: overtimePay, setter: setOvertimePay },
                { label: 'Bonus', value: bonus, setter: setBonus },
                { label: 'Commission', value: commission, setter: setCommission },
                { label: 'Allowances', value: allowances, setter: setAllowances },
              ].map(({ label, value, setter }) => {
                const fieldId = `payroll-earning-${label.toLowerCase().replace(/\s+/g, '-')}`;
                return (
                  <div key={label}>
                    <label
                      htmlFor={fieldId}
                      className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                    >
                      {label}
                    </label>
                    <Input
                      fullWidth
                      id={fieldId}
                      type="number"
                      min="0"
                      step="0.01"
                      value={value}
                      onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
              Gross Pay:{' '}
              <span className="text-success-600 dark:text-success-400">
                {formatCurrency(grossPay, currency)}
              </span>
            </div>
          </div>

          {/* Deductions */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Deductions
            </h3>
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {[
                { label: 'Tax', value: tax, setter: setTax },
                { label: 'Social Security', value: socialSecurity, setter: setSocialSecurity },
                { label: 'Health Insurance', value: healthInsurance, setter: setHealthInsurance },
                { label: 'Retirement', value: retirement, setter: setRetirement },
                { label: 'Other', value: otherDeductions, setter: setOtherDeductions },
              ].map(({ label, value, setter }) => {
                const fieldId = `payroll-deduction-${label.toLowerCase().replace(/\s+/g, '-')}`;
                return (
                  <div key={label}>
                    <label
                      htmlFor={fieldId}
                      className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                    >
                      {label}
                    </label>
                    <Input
                      fullWidth
                      id={fieldId}
                      type="number"
                      min="0"
                      step="0.01"
                      value={value}
                      onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
              Total Deductions:{' '}
              <span className="text-error-600 dark:text-error-400">
                {formatCurrency(totalDeductions, currency)}
              </span>
            </div>
          </div>

          {/* Net Pay Summary */}
          <div className="rounded-lg border border-primary-200 bg-primary-50 p-4 dark:border-primary-800 dark:bg-primary-900/20">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-primary-700 dark:text-primary-300">
                Net Pay
              </span>
              <span className="text-xl font-bold text-primary-700 dark:text-primary-300">
                {formatCurrency(netPay, currency)}
              </span>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label
              htmlFor="payroll-notes"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Notes
            </label>
            <Textarea
              fullWidth
              id="payroll-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Optional notes..."
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// Summary Card
// ============================================================================

interface SummaryCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  iconBg: string;
  subtitle?: string;
}

function SummaryCard({ title, value, icon, iconBg, subtitle }: SummaryCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
        <div className={cn('rounded-lg p-2.5', iconBg)}>{icon}</div>
      </div>
    </div>
  );
}

// ============================================================================
// Payroll Page
// ============================================================================

const PayrollPage: React.FC = () => {
  const { user } = useAuth();

  // SEC-003: Payroll data is sensitive PII (salary, bank info, tax ID).
  // Only privileged roles may see this page.
  const isAuthorised =
    user?.role === 'SUPER_ADMIN' ||
    user?.role === 'TENANT_ADMIN' ||
    user?.role === 'MODULE_MANAGER';

  // State
  const [activeTab, setActiveTab] = useState<'all' | 'pending'>('all');
  const [filter, setFilter] = useState<PayrollFilterInput>({ limit: 20, page: 1 });
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Data fetching
  const { data: allPayrolls, isLoading: loadingAll } = usePayrolls(filter);
  const { data: pendingPayrolls, isLoading: loadingPending } = usePendingPayrolls();
  const { data: employeesData } = useEmployees(undefined, { limit: 1000, page: 1 });

  // Mutations
  const createMutation = useCreatePayroll();
  const approveMutation = useApprovePayroll();
  const confirm = useConfirm();

  // FE-HIGH-086: approving a payroll releases money; it asks first, like a
  // routine delete does elsewhere.
  const handleApprove = useCallback(
    async (id: string): Promise<void> => {
      if (
        !(await confirm({
          title: 'Approve this payroll?',
          message: 'Approval marks the period as payable. It cannot be undone from here.',
          confirmText: 'Approve',
          cancelText: 'Cancel',
          variant: 'warning',
        }))
      )
        return;
      approveMutation.mutate(id);
    },
    [confirm, approveMutation],
  );

  const employees = employeesData?.items || [];

  // Determine which data to show based on active tab
  const displayData = activeTab === 'pending' ? pendingPayrolls : allPayrolls?.items;
  const isLoading = activeTab === 'pending' ? loadingPending : loadingAll;

  // Calculate summary stats
  const totalCount = allPayrolls?.total ?? 0;
  const pendingCount = pendingPayrolls?.length ?? 0;
  const thisMonthNetPay = useMemo(() => {
    const items = allPayrolls?.items || [];
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    return items
      .filter((p) => {
        const start = new Date(p.payPeriodStart);
        return start.getMonth() === currentMonth && start.getFullYear() === currentYear;
      })
      .reduce((sum, p) => sum + parseMoney(p.netPayDecimal), 0);
  }, [allPayrolls?.items]);

  // Client-side search filter
  const filteredData = useMemo(() => {
    if (!displayData) return [];
    if (!searchQuery) return displayData;
    const q = searchQuery.toLowerCase();
    return displayData.filter((p) => {
      const empName = p.employee
        ? `${p.employee.firstName} ${p.employee.lastName}`.toLowerCase()
        : '';
      return (
        empName.includes(q) ||
        p.payrollNumber?.toLowerCase().includes(q) ||
        p.status?.toLowerCase().includes(q)
      );
    });
  }, [displayData, searchQuery]);

  // Table columns
  const columns: DataTableColumn<Payroll>[] = useMemo(
    () => [
      {
        key: 'employee',
        header: 'Employee',
        render: (_value, row) => (
          <div className="flex items-center gap-3">
            {row.employee ? (
              <>
                <EmployeeAvatar
                  firstName={row.employee.firstName}
                  lastName={row.employee.lastName}
                  size="sm"
                />
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">
                    {row.employee.firstName} {row.employee.lastName}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{row.payrollNumber}</p>
                </div>
              </>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">{row.payrollNumber}</span>
            )}
          </div>
        ),
      },
      {
        key: 'period',
        header: 'Period',
        render: (_value, row) => (
          <div className="text-sm">
            <p className="text-gray-900 dark:text-white">
              {formatDate(row.payPeriodStart)} - {formatDate(row.payPeriodEnd)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {PAY_PERIOD_TYPE_LABELS[row.payPeriodType] || row.payPeriodType}
            </p>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        render: (_value, row) => {
          const config = PAYROLL_STATUS_CONFIG[row.status] || {
            label: row.status,
            variant: 'default',
          };
          return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
        },
      },
      {
        key: 'grossPay',
        header: 'Gross Pay',
        align: 'right',
        render: (_value, row) => (
          <span className="font-medium text-gray-900 dark:text-white">
            {formatCurrency(parseMoney(row.earningsGrossPayDecimal), row.currency)}
          </span>
        ),
      },
      {
        key: 'deductions',
        header: 'Deductions',
        align: 'right',
        render: (_value, row) => (
          <span className="text-error-600 dark:text-error-400">
            {formatCurrency(parseMoney(row.deductionsTotalDecimal), row.currency)}
          </span>
        ),
      },
      {
        key: 'netPay',
        header: 'Net Pay',
        align: 'right',
        render: (_value, row) => (
          <span className="font-semibold text-success-700 dark:text-success-400">
            {formatCurrency(parseMoney(row.netPayDecimal), row.currency)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        width: '80px',
        align: 'right',
        render: (_value, row) => (
          <div className="flex items-center justify-end gap-2">
            {row.status === PayrollStatus.PENDING_APPROVAL && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Approve"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleApprove(row.id);
                }}
                disabled={approveMutation.isPending}
                title="Approve"
              >
                <CheckCircle className="h-4 w-4" />
              </Button>
            )}
          </div>
        ),
      },
    ],

    [approveMutation.isPending, handleApprove],
  );

  // Stable keyExtractor
  const keyExtractor = useCallback((row: Payroll) => row.id, []);

  // Pagination
  const handlePageChange = (page: number) => {
    setFilter((prev) => ({
      ...prev,
      page,
    }));
  };

  // Filter changes
  const handleStatusFilter = (status: string) => {
    setFilter((prev) => ({
      ...prev,
      status: status ? (status as PayrollStatus) : undefined,
      page: 1,
    }));
  };

  // Create payroll handler
  const handleCreatePayroll = (input: CreatePayrollInput) => {
    createMutation.mutate(input, {
      onSuccess: () => {
        setShowCreateModal(false);
      },
    });
  };

  // ========================================================================
  // Unauthorised view
  // ========================================================================

  if (!isAuthorised) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="rounded-full bg-error-100 p-4 dark:bg-error-900/30">
          <Lock className="h-8 w-8 text-error-600 dark:text-error-400" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Access Restricted</h2>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Payroll information is restricted to HR managers and payroll administrators.
          </p>
        </div>
        <Link
          to="/hr"
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          Back to HR Dashboard
        </Link>
      </div>
    );
  }

  // ========================================================================
  // Authorised view
  // ========================================================================

  return (
    <div className="space-y-6 p-6">
      {/* Create Modal */}
      <CreatePayrollModal
        employees={employees}
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreatePayroll}
        isSubmitting={createMutation.isPending}
      />

      {/* Header */}
      <PageHeader
        title="Payroll"
        description="Salary and payment management"
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setShowCreateModal(true)}
          >
            Create Payroll
          </Button>
        }
      />

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard
          title="Total Payrolls"
          value={totalCount}
          icon={<FileText className="h-5 w-5 text-primary-600 dark:text-primary-400" />}
          iconBg="bg-primary-100 dark:bg-primary-900/30"
          subtitle="All time records"
        />
        <SummaryCard
          title="Pending Approval"
          value={pendingCount}
          icon={<Clock className="h-5 w-5 text-warning-600 dark:text-warning-400" />}
          iconBg="bg-warning-100 dark:bg-warning-900/30"
          subtitle="Awaiting review"
        />
        <SummaryCard
          title="This Month Net Pay"
          value={formatCurrency(thisMonthNetPay)}
          icon={<TrendingUp className="h-5 w-5 text-success-600 dark:text-success-400" />}
          iconBg="bg-success-100 dark:bg-success-900/30"
          subtitle="Current pay period"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('all')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'all'
              ? 'border-primary-600 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-100',
          )}
        >
          All Payrolls
        </button>
        <button
          onClick={() => setActiveTab('pending')}
          className={cn(
            'flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'pending'
              ? 'border-primary-600 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-100',
          )}
        >
          Pending Approval
          {pendingCount > 0 && (
            <span className="rounded-full bg-warning-100 dark:bg-warning-900/40 px-2 py-0.5 text-xs font-medium text-warning-700 dark:text-warning-300">
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search payrolls..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-primary-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1',
            showFilters
              ? 'bg-primary-50 text-primary-600 ring-primary-200 dark:bg-primary-900/30 dark:text-primary-400'
              : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200',
          )}
        >
          <Filter className="h-4 w-4" />
          Filters
        </button>
      </div>

      {/* Filter Panel */}
      {showFilters && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label
                htmlFor="payroll-filter-status"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Status
              </label>
              <select
                id="payroll-filter-status"
                value={filter.status || ''}
                onChange={(e) => handleStatusFilter(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Statuses</option>
                {Object.entries(PAYROLL_STATUS_CONFIG).map(([value, config]) => (
                  <option key={value} value={value}>
                    {config.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <SearchableSelect
                label="Employee"
                options={employees.map((emp) => ({
                  value: emp.id,
                  label: `${emp.firstName} ${emp.lastName} (${emp.employeeNumber})`,
                }))}
                value={filter.employeeId || ''}
                onChange={(val) =>
                  setFilter((prev) => ({
                    ...prev,
                    employeeId: val ? String(val) : undefined,
                    page: 1,
                  }))
                }
                placeholder="All Employees"
                searchPlaceholder="Search employees..."
                size="md"
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setFilter({ limit: 20, page: 1 })}>
              Clear all filters
            </Button>
          </div>
        </div>
      )}

      {/* Data Table */}
      <DataTable<Payroll>
        data={filteredData || []}
        columns={columns}
        keyExtractor={keyExtractor}
        loading={isLoading}
        emptyMessage="No payroll records found"
        pagination={
          activeTab !== 'pending' && allPayrolls
            ? derivePaginationMetadataV1(allPayrolls.total, filter.page || 1, filter.limit || 20)
            : undefined
        }
        onPageChange={activeTab === 'pending' ? undefined : handlePageChange}
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />
    </div>
  );
};

export default PayrollPage;
