/**
 * Departments Page
 *
 * BUG-006: Mock data replaced with real API hook (useDepartments).
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Building2, Users, Plus, ChevronRight } from 'lucide-react';
import { useDepartments } from '../hooks';

const DepartmentsPage: React.FC = () => {
  const { data: departments, isLoading } = useDepartments();

  const totalEmployees = departments?.reduce((sum, d) => sum + (d.employeeCount || 0), 0) ?? 0;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Departments</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            {departments?.length ?? '-'} departments, {totalEmployees} employees
          </p>
        </div>
        <button className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          <Plus className="w-4 h-4" />
          New Department
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-gray-100 bg-gray-100 dark:border-gray-700 dark:bg-gray-700"
            />
          ))}
        </div>
      )}

      {/* Departments Grid */}
      {!isLoading && departments && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {departments.map((department) => (
            <div
              key={department.id}
              className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
            >
              <div
                className="h-2"
                style={{ backgroundColor: department.colorCode || '#6366f1' }}
              />
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className="rounded-lg p-3"
                      style={{ backgroundColor: `${department.colorCode || '#6366f1'}20` }}
                    >
                      <Building2
                        className="h-6 w-6"
                        style={{ color: department.colorCode || '#6366f1' }}
                      />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-white">
                        {department.name}
                      </h3>
                      {department.manager && (
                        <p className="text-sm text-gray-500">
                          {department.manager.firstName} {department.manager.lastName}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {department.description && (
                  <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                    {department.description}
                  </p>
                )}

                <div className="mt-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-gray-500">
                    <Users className="h-4 w-4" />
                    <span className="text-sm">{department.employeeCount ?? '-'} employees</span>
                  </div>
                  <Link
                    to={`/hr/employees?departmentId=${department.id}`}
                    className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                  >
                    View
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && (!departments || departments.length === 0) && (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-center dark:border-gray-600 dark:bg-gray-800/50">
          <Building2 className="mb-3 h-10 w-10 text-gray-400" />
          <p className="text-gray-500">No departments found</p>
        </div>
      )}

      {/* Organization Chart placeholder */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Organization Chart
        </h3>
        <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-800/50">
          <p className="text-gray-500">
            <Link
              to="/hr/organization"
              className="text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View full organization chart
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default DepartmentsPage;
