/**
 * Payroll Page
 *
 * CRIT-4 / BUG-003: Mock data removed — page now requires real payroll data from API.
 * SEC-003: Role gate added — only payroll_admin / hr_manager may access this page.
 * Salary values are sensitive PII and must NOT be visible to unprivileged users.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, Lock } from 'lucide-react';
import { useAuth } from '@aquaculture/shared-ui';

// ============================================================================
// Payroll Page
// ============================================================================

const PayrollPage: React.FC = () => {
  const { user } = useAuth();

  // SEC-003: Payroll data is sensitive PII (salary, bank info, tax ID).
  // Only privileged roles may see this page.
  const isAuthorised =
    user?.roles?.includes('payroll_admin') ||
    user?.roles?.includes('hr_manager') ||
    user?.role === 'payroll_admin' ||
    user?.role === 'hr_manager';

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

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Payroll</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Salary and payment management
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
            Authorised access
          </span>
        </div>
      </div>

      {/* Placeholder — payroll backend integration pending */}
      <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-center dark:border-gray-600 dark:bg-gray-800/50">
        <DollarSign className="mb-4 h-12 w-12 text-gray-400" />
        <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300">
          Payroll management coming soon
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          This module is under active development.
        </p>
        <div className="mt-4 flex gap-3">
          <Link
            to="/hr/payroll/payslips"
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:ring-gray-600"
          >
            View Payslips
          </Link>
          <Link
            to="/hr/payroll/reports"
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:ring-gray-600"
          >
            Payroll Reports
          </Link>
        </div>
      </div>
    </div>
  );
};

export default PayrollPage;
