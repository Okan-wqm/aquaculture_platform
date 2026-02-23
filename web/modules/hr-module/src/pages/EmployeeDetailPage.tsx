/**
 * Employee Detail Page
 *
 * Personel detay sayfası — connected to real API (BUG-001 fix).
 */

import React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Edit,
  Mail,
  Phone,
  Building2,
  Calendar,
  Clock,
  Award,
  GraduationCap,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@aquaculture/shared-ui';
import { useEmployee } from '../hooks';

// ============================================================================
// Employee Detail Page
// ============================================================================

const EmployeeDetailPage: React.FC = () => {
  const { employeeId } = useParams<{ employeeId: string }>();
  const { user } = useAuth();

  // CRIT-1 / BUG-001: fetch real employee data instead of mock object
  const { data: employee, isLoading, error } = useEmployee(employeeId || '');

  // SEC-005: only payroll-admin/manager roles should see payroll shortcut
  const isPayrollAdmin =
    user?.roles?.includes('payroll_admin') ||
    user?.roles?.includes('hr_manager') ||
    user?.role === 'payroll_admin' ||
    user?.role === 'hr_manager';

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center p-6">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
      </div>
    );
  }

  if (error || !employee) {
    return (
      <div className="flex h-64 flex-col items-center justify-center p-6 text-center">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-gray-700 dark:text-gray-300">
          {error ? 'Failed to load employee data.' : 'Employee not found.'}
        </p>
        <Link to="/hr/employees" className="mt-4 text-indigo-600 hover:underline">
          Back to Employees
        </Link>
      </div>
    );
  }

  const fullName = `${employee.firstName} ${employee.lastName}`;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/hr/employees"
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors dark:hover:bg-gray-700"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{fullName}</h1>
            <p className="text-gray-500 dark:text-gray-400">{employee.position}</p>
          </div>
        </div>
        <Link
          to={`/hr/employees/${employeeId}/edit`}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
        >
          <Edit className="w-4 h-4" />
          Edit
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-col items-center text-center">
            <div className="w-24 h-24 rounded-full bg-violet-100 flex items-center justify-center mb-4 dark:bg-violet-900/30">
              <span className="text-3xl font-bold text-violet-600">
                {employee.firstName?.[0]}{employee.lastName?.[0]}
              </span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{fullName}</h2>
            <p className="text-gray-500 dark:text-gray-400">{employee.position}</p>
            <span className={`mt-2 px-3 py-1 rounded-full text-sm font-medium ${
              employee.status === 'active'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
            }`}>
              {employee.status}
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
              <Mail className="w-5 h-5" />
              <span>{employee.email}</span>
            </div>
            {employee.contactInfo?.phone && (
              <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                <Phone className="w-5 h-5" />
                <span>{employee.contactInfo.phone}</span>
              </div>
            )}
            {employee.department && (
              <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                <Building2 className="w-5 h-5" />
                <span>{employee.department}</span>
              </div>
            )}
            {employee.hireDate && (
              <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                <Calendar className="w-5 h-5" />
                <span>Hired: {new Date(employee.hireDate).toLocaleDateString()}</span>
              </div>
            )}
          </div>
        </div>

        {/* Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Work Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Work Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500">Employee Number</p>
                <p className="font-medium text-gray-900 dark:text-white">{employee.employeeNumber || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Employment Type</p>
                <p className="font-medium text-gray-900 dark:text-white">{employee.employmentType || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Department</p>
                <p className="font-medium text-gray-900 dark:text-white">{employee.department || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Position</p>
                <p className="font-medium text-gray-900 dark:text-white">{employee.position || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Personnel Category</p>
                <p className="font-medium text-gray-900 dark:text-white">{employee.personnelCategory || '-'}</p>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Link
              to={`/hr/attendance?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-cyan-200 hover:bg-cyan-50 transition-all dark:border-gray-700 dark:bg-gray-800 dark:hover:border-cyan-800"
            >
              <Clock className="w-8 h-8 text-cyan-600 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">Attendance</span>
            </Link>
            <Link
              to={`/hr/leaves?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-yellow-200 hover:bg-yellow-50 transition-all dark:border-gray-700 dark:bg-gray-800 dark:hover:border-yellow-800"
            >
              <Calendar className="w-8 h-8 text-yellow-600 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">Leaves</span>
            </Link>
            {/* SEC-005: only show payroll link to authorised roles */}
            {isPayrollAdmin && (
              <Link
                to={`/hr/payroll?employee=${employeeId}`}
                className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-green-200 hover:bg-green-50 transition-all dark:border-gray-700 dark:bg-gray-800 dark:hover:border-green-800"
              >
                <Award className="w-8 h-8 text-green-600 mb-2" />
                <span className="text-sm font-medium text-gray-900 dark:text-white">Payroll</span>
              </Link>
            )}
            <Link
              to={`/hr/performance?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-orange-200 hover:bg-orange-50 transition-all dark:border-gray-700 dark:bg-gray-800 dark:hover:border-orange-800"
            >
              <Award className="w-8 h-8 text-orange-600 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">Performance</span>
            </Link>
            <Link
              to={`/hr/training?employee=${employeeId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-indigo-200 hover:bg-indigo-50 transition-all dark:border-gray-700 dark:bg-gray-800 dark:hover:border-indigo-800"
            >
              <GraduationCap className="w-8 h-8 text-indigo-600 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">Training</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmployeeDetailPage;
