/**
 * Payroll Page
 *
 * Full payroll management: list, create, approve payrolls.
 * SEC-003: Role gate — only payroll_admin / hr_manager may access this page.
 * Salary values are sensitive PII and must NOT be visible to unprivileged users.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Lock,
  Plus,
  Search,
  Filter,
  CheckCircle,
  X,
  Clock,
  FileText,
  TrendingUp,
} from 'lucide-react';
import { cn, useAuth, SearchableSelect, formatCurrency as sharedFormatCurrency, parseMoney, DEFAULT_CURRENCY } from '@aquaculture/shared-ui';
import {
  usePayrolls,
  usePendingPayrolls,
  useCreatePayroll,
  useApprovePayroll,
  useEmployees,
} from '../hooks';
import { DataTable, StatusBadge, EmployeeAvatar } from '../components/common';
import type { Column } from '../components/common';
import type {
  Payroll,
  PayrollFilterInput,
  CreatePayrollInput,
  Employee,
} from '../types';
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-10">
      <div className="w-full max-w-3xl rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Create Payroll
          </h2>
          <button
            onClick={handleClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form id="create-payroll-form" onSubmit={handleSubmit} className="max-h-[70vh] overflow-y-auto px-6 py-4">
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
                  <label htmlFor="payroll-payPeriodType" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Pay Period Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="payroll-payPeriodType"
                    value={payPeriodType}
                    onChange={(e) => setPayPeriodType(e.target.value as PayPeriodType)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  >
                    {Object.entries(PAY_PERIOD_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="payroll-currency" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Currency
                  </label>
                  <select
                    id="payroll-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="TRY">TRY</option>
                    <option value="NOK">NOK</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="payroll-periodStart" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Period Start <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="payroll-periodStart"
                    type="date"
                    value={payPeriodStart}
                    onChange={(e) => setPayPeriodStart(e.target.value)}
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  />
                </div>

                <div>
                  <label htmlFor="payroll-periodEnd" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Period End <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="payroll-periodEnd"
                    type="date"
                    value={payPeriodEnd}
                    onChange={(e) => setPayPeriodEnd(e.target.value)}
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
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
                      <label htmlFor={fieldId} className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        {label}
                      </label>
                      <input
                        id={fieldId}
                        type="number"
                        min="0"
                        max="744"
                        step="0.5"
                        value={value}
                        onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
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
                      <label htmlFor={fieldId} className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        {label}
                      </label>
                      <input
                        id={fieldId}
                        type="number"
                        min="0"
                        step="0.01"
                        value={value}
                        onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
                Gross Pay: <span className="text-green-600 dark:text-green-400">{formatCurrency(grossPay, currency)}</span>
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
                      <label htmlFor={fieldId} className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        {label}
                      </label>
                      <input
                        id={fieldId}
                        type="number"
                        min="0"
                        step="0.01"
                        value={value}
                        onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
                Total Deductions: <span className="text-red-600 dark:text-red-400">{formatCurrency(totalDeductions, currency)}</span>
              </div>
            </div>

            {/* Net Pay Summary */}
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                  Net Pay
                </span>
                <span className="text-xl font-bold text-indigo-700 dark:text-indigo-300">
                  {formatCurrency(netPay, currency)}
                </span>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label htmlFor="payroll-notes" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Notes
              </label>
              <textarea
                id="payroll-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="Optional notes..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <button
            onClick={handleClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-600 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-payroll-form"
            disabled={isSubmitting || !employeeId || !payPeriodStart || !payPeriodEnd || baseSalary <= 0}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            Create Payroll
          </button>
        </div>
      </div>
    </div>
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
          {subtitle && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
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
  const columns: Column<Payroll>[] = useMemo(
    () => [
      {
        key: 'employee',
        header: 'Employee',
        sortable: true,
        accessor: (row) => (
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
                  <p className="text-xs text-gray-500">{row.payrollNumber}</p>
                </div>
              </>
            ) : (
              <span className="text-gray-500">{row.payrollNumber}</span>
            )}
          </div>
        ),
      },
      {
        key: 'period',
        header: 'Period',
        sortable: true,
        accessor: (row) => (
          <div className="text-sm">
            <p className="text-gray-900 dark:text-white">
              {formatDate(row.payPeriodStart)} - {formatDate(row.payPeriodEnd)}
            </p>
            <p className="text-xs text-gray-500">
              {PAY_PERIOD_TYPE_LABELS[row.payPeriodType] || row.payPeriodType}
            </p>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        sortable: true,
        accessor: (row) => {
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
        accessor: (row) => (
          <span className="font-medium text-gray-900 dark:text-white">
            {formatCurrency(parseMoney(row.earningsGrossPayDecimal), row.currency)}
          </span>
        ),
      },
      {
        key: 'deductions',
        header: 'Deductions',
        align: 'right',
        accessor: (row) => (
          <span className="text-red-600 dark:text-red-400">
            {formatCurrency(parseMoney(row.deductionsTotalDecimal), row.currency)}
          </span>
        ),
      },
      {
        key: 'netPay',
        header: 'Net Pay',
        align: 'right',
        accessor: (row) => (
          <span className="font-semibold text-green-700 dark:text-green-400">
            {formatCurrency(parseMoney(row.netPayDecimal), row.currency)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        width: '80px',
        align: 'right',
        accessor: (row) => (
          <div className="flex items-center justify-end gap-2">
            {row.status === PayrollStatus.PENDING_APPROVAL && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  approveMutation.mutate(row.id);
                }}
                disabled={approveMutation.isPending}
                className="rounded p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                title="Approve"
              >
                <CheckCircle className="h-4 w-4" />
              </button>
            )}
          </div>
        ),
      },
    ],
     
    [approveMutation.isPending]
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
        <div className="rounded-full bg-red-100 p-4 dark:bg-red-900/30">
          <Lock className="h-8 w-8 text-red-600" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Access Restricted</h2>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Payroll information is restricted to HR managers and payroll administrators.
          </p>
        </div>
        <Link
          to="/hr"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Payroll</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Salary and payment management
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          Create Payroll
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard
          title="Total Payrolls"
          value={totalCount}
          icon={<FileText className="h-5 w-5 text-indigo-600" />}
          iconBg="bg-indigo-100 dark:bg-indigo-900/30"
          subtitle="All time records"
        />
        <SummaryCard
          title="Pending Approval"
          value={pendingCount}
          icon={<Clock className="h-5 w-5 text-amber-600" />}
          iconBg="bg-amber-100 dark:bg-amber-900/30"
          subtitle="Awaiting review"
        />
        <SummaryCard
          title="This Month Net Pay"
          value={formatCurrency(thisMonthNetPay)}
          icon={<TrendingUp className="h-5 w-5 text-green-600" />}
          iconBg="bg-green-100 dark:bg-green-900/30"
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
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          All Payrolls
        </button>
        <button
          onClick={() => setActiveTab('pending')}
          className={cn(
            'flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'pending'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Pending Approval
          {pendingCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search payrolls..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1',
            showFilters
              ? 'bg-indigo-50 text-indigo-600 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400'
              : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200'
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
              <label htmlFor="payroll-filter-status" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
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
            <button
              onClick={() => setFilter({ limit: 20, page: 1 })}
              className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              Clear all filters
            </button>
          </div>
        </div>
      )}

      {/* Data Table */}
      <DataTable
        data={filteredData || []}
        columns={columns}
        keyExtractor={keyExtractor}
        isLoading={isLoading}
        emptyMessage="No payroll records found"
        total={activeTab === 'pending' ? undefined : allPayrolls?.total}
        page={
          activeTab === 'pending'
            ? 1
            : filter.page || 1
        }
        pageSize={filter.limit || 20}
        onPageChange={activeTab === 'pending' ? undefined : handlePageChange}
      />
    </div>
  );
};

export default PayrollPage;
