/**
 * Employee Form Page
 *
 * Create / edit employee.
 * CRIT-2 / BUG-002: connected to real API (createEmployee / updateEmployee mutations).
 * Updated: all backend-required fields (personal info, contact, address, financial, aquaculture).
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { maskNationalId } from '../utils/pii-mask';
import {
  ArrowLeft,
  Save,
  User,
  Mail,
  Phone,
  Building2,
  Calendar,
  AlertCircle,
  MapPin,
  DollarSign,
  Anchor,
  CreditCard,
  ShieldCheck,
} from 'lucide-react';
import { useEmployee, useCreateEmployee, useUpdateEmployee, useDepartments } from '../hooks';
import type {
  CreateEmployeeInput,
  UpdateEmployeeInput,
  EmploymentType,
  ContactInfo,
  Address,
  PersonnelCategory,
  Department,
} from '../types';

// ============================================================================
// Constants
// ============================================================================

const inputClass =
  'w-full px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white';
const inputDisabledClass =
  'w-full px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:disabled:bg-gray-800';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2';
const sectionClass =
  'bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:border-gray-700 dark:bg-gray-800';

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'TRY', label: 'TRY - Turkish Lira' },
  { value: 'GBP', label: 'GBP - British Pound' },
  { value: 'NOK', label: 'NOK - Norwegian Krone' },
  { value: 'SEK', label: 'SEK - Swedish Krona' },
  { value: 'JPY', label: 'JPY - Japanese Yen' },
  { value: 'CAD', label: 'CAD - Canadian Dollar' },
  { value: 'AUD', label: 'AUD - Australian Dollar' },
];

/**
 * Map DepartmentHR type (from the departments entity) back to the legacy
 * department enum string that the employee entity expects.
 */
function mapDepartmentType(dept: Department): string {
  return dept.type || dept.code || dept.name.toLowerCase();
}

// ============================================================================
// Employee Form Page
// ============================================================================

const EmployeeFormPage: React.FC = () => {
  const { employeeId } = useParams<{ employeeId: string }>();
  const navigate = useNavigate();
  const isEditing = Boolean(employeeId);

  // Fetch existing employee for edit mode
  const { data: employee, isLoading: loadingEmployee } = useEmployee(employeeId || '');

  // Fetch departments from API
  const { data: departments, isLoading: loadingDepartments } = useDepartments();

  const createMutation = useCreateEmployee();
  const updateMutation = useUpdateEmployee();

  const isSubmitting = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error || updateMutation.error;

  // ------------------------------------------------------------------
  // Form state
  // ------------------------------------------------------------------
  const [formData, setFormData] = useState({
    // Basic
    firstName: '',
    lastName: '',
    email: '',
    // Personal
    dateOfBirth: '',
    nationalId: '',
    // Contact
    contactPhone: '',
    contactEmail: '',
    emergencyContact: '',
    emergencyPhone: '',
    // Address
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    // Work
    departmentHrId: '',
    department: '',
    position: '',
    hireDate: '',
    employmentType: 'FULL_TIME' as string,
    // Financial
    baseSalary: '',
    currency: 'USD',
    // Aquaculture
    personnelCategory: '' as string,
    seaWorthy: false,
  });

  // Populate form when editing
  useEffect(() => {
    if (isEditing && employee) {
      setFormData({
        firstName: employee.firstName || '',
        lastName: employee.lastName || '',
        email: employee.email || '',
        dateOfBirth: '',
        nationalId: '',
        contactPhone: employee.contactInfo?.phone || '',
        contactEmail: employee.contactInfo?.email || employee.email || '',
        emergencyContact: employee.contactInfo?.emergencyContact || '',
        emergencyPhone: employee.contactInfo?.emergencyPhone || '',
        street: employee.address?.street || '',
        city: employee.address?.city || '',
        state: employee.address?.state || '',
        postalCode: employee.address?.postalCode || '',
        country: employee.address?.country || '',
        departmentHrId: employee.departmentHrId || '',
        department: employee.department || '',
        position: employee.position || '',
        hireDate: employee.hireDate || '',
        employmentType: employee.employmentType || 'FULL_TIME',
        baseSalary: '',
        currency: employee.currency || 'USD',
        personnelCategory: employee.personnelCategory || '',
        seaWorthy: employee.seaWorthy ?? false,
      });
    }
  }, [isEditing, employee]);

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
      const checked = (e.target as HTMLInputElement).checked;
      setFormData((prev) => ({ ...prev, [name]: checked }));
    } else {
      setFormData((prev) => ({ ...prev, [name]: value }));
    }
  };

  /**
   * When a department is selected from the dropdown, set both
   * departmentHrId (the entity UUID) and department (the legacy enum string).
   */
  const handleDepartmentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;
    const dept = (departments || []).find((d) => d.id === selectedId);
    setFormData((prev) => ({
      ...prev,
      departmentHrId: selectedId,
      department: dept ? mapDepartmentType(dept) : '',
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const contactInfo: ContactInfo = {
      email: formData.contactEmail || formData.email,
      phone: formData.contactPhone,
      emergencyContact: formData.emergencyContact || undefined,
      emergencyPhone: formData.emergencyPhone || undefined,
    };

    const address: Address = {
      street: formData.street,
      city: formData.city,
      state: formData.state,
      postalCode: formData.postalCode,
      country: formData.country,
    };

    if (isEditing && employeeId) {
      const input: UpdateEmployeeInput = {
        id: employeeId,
        firstName: formData.firstName,
        lastName: formData.lastName,
        contactInfo,
        address,
        position: formData.position || undefined,
        currency: formData.currency || undefined,
        personnelCategory: (formData.personnelCategory as PersonnelCategory) || undefined,
        seaWorthy: formData.seaWorthy,
      };
      updateMutation.mutate(input, {
        onSuccess: () => navigate(`/hr/employees/${employeeId}`),
      });
    } else {
      const input: CreateEmployeeInput = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        dateOfBirth: formData.dateOfBirth,
        nationalId: formData.nationalId,
        contactInfo,
        address,
        department: formData.department || undefined,
        departmentHrId: formData.departmentHrId || undefined,
        position: formData.position || undefined,
        hireDate: formData.hireDate || new Date().toISOString().split('T')[0]!,
        employmentType: formData.employmentType as EmploymentType,
        baseSalary: formData.baseSalary ? Number(formData.baseSalary) : 0,
        currency: formData.currency || undefined,
        personnelCategory: (formData.personnelCategory as PersonnelCategory) || undefined,
        seaWorthy: formData.seaWorthy,
      };
      createMutation.mutate(input, {
        onSuccess: (data) => navigate(`/hr/employees/${data.createEmployee.id}`),
      });
    }
  };

  // ------------------------------------------------------------------
  // Loading state
  // ------------------------------------------------------------------

  if (isEditing && loadingEmployee) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          to={isEditing && employeeId ? `/hr/employees/${employeeId}` : '/hr/employees'}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors dark:hover:bg-gray-700"
        >
          <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {isEditing ? 'Edit Employee' : 'New Employee'}
          </h1>
          <p className="text-gray-500 dark:text-gray-400">
            {isEditing ? 'Update employee information' : 'Create a new employee record'}
          </p>
        </div>
      </div>

      {/* Error Banner */}
      {mutationError && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-900/20">
          <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-600" />
          <p className="text-sm text-red-700 dark:text-red-300">
            {mutationError.message || 'An error occurred while saving the employee.'}
          </p>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ============================================================ */}
        {/* Basic Information */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Basic Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={labelClass}>
                <User className="w-4 h-4 inline mr-2" />
                First Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="firstName"
                value={formData.firstName}
                onChange={handleChange}
                className={inputClass}
                placeholder="First name"
                required
              />
            </div>
            <div>
              <label className={labelClass}>
                Last Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="lastName"
                value={formData.lastName}
                onChange={handleChange}
                className={inputClass}
                placeholder="Last name"
                required
              />
            </div>
            <div>
              <label className={labelClass}>
                <Mail className="w-4 h-4 inline mr-2" />
                Email <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                disabled={isEditing}
                className={inputDisabledClass}
                placeholder="email@example.com"
                required={!isEditing}
              />
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Personal Information */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            <ShieldCheck className="w-5 h-5 inline mr-2" />
            Personal Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={labelClass}>
                <Calendar className="w-4 h-4 inline mr-2" />
                Date of Birth <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                name="dateOfBirth"
                value={formData.dateOfBirth}
                onChange={handleChange}
                className={isEditing ? inputDisabledClass : inputClass}
                disabled={isEditing}
                required={!isEditing}
              />
            </div>
            <div>
              <label className={labelClass}>
                <CreditCard className="w-4 h-4 inline mr-2" />
                National ID <span className="text-red-500">*</span>
              </label>
              {/* HR-HIGH-017: Mask national ID in display mode. Only show full ID
                  during initial creation. In edit mode, show masked value. */}
              <input
                type="text"
                name="nationalId"
                value={isEditing ? maskNationalId(formData.nationalId) : formData.nationalId}
                onChange={handleChange}
                className={isEditing ? inputDisabledClass : inputClass}
                disabled={isEditing}
                placeholder="National ID / SSN"
                required={!isEditing}
                maxLength={50}
              />
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Contact Information */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            <Phone className="w-5 h-5 inline mr-2" />
            Contact Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={labelClass}>
                Contact Email <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                name="contactEmail"
                value={formData.contactEmail}
                onChange={handleChange}
                className={inputClass}
                placeholder="contact@example.com"
                required={!isEditing}
              />
            </div>
            <div>
              <label className={labelClass}>
                Phone <span className="text-red-500">*</span>
              </label>
              <input
                type="tel"
                name="contactPhone"
                value={formData.contactPhone}
                onChange={handleChange}
                className={inputClass}
                placeholder="+1 555 000 0000"
                required={!isEditing}
              />
            </div>
            <div>
              <label className={labelClass}>Emergency Contact Name</label>
              <input
                type="text"
                name="emergencyContact"
                value={formData.emergencyContact}
                onChange={handleChange}
                className={inputClass}
                placeholder="Emergency contact full name"
                maxLength={100}
              />
            </div>
            <div>
              <label className={labelClass}>Emergency Phone</label>
              <input
                type="tel"
                name="emergencyPhone"
                value={formData.emergencyPhone}
                onChange={handleChange}
                className={inputClass}
                placeholder="+1 555 000 0000"
              />
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Address */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            <MapPin className="w-5 h-5 inline mr-2" />
            Address
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="md:col-span-2">
              <label className={labelClass}>
                Street Address <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="street"
                value={formData.street}
                onChange={handleChange}
                className={inputClass}
                placeholder="123 Main St"
                required={!isEditing}
                maxLength={255}
              />
            </div>
            <div>
              <label className={labelClass}>
                City <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="city"
                value={formData.city}
                onChange={handleChange}
                className={inputClass}
                placeholder="City"
                required={!isEditing}
                maxLength={100}
              />
            </div>
            <div>
              <label className={labelClass}>
                State / Province <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="state"
                value={formData.state}
                onChange={handleChange}
                className={inputClass}
                placeholder="State"
                required={!isEditing}
                maxLength={100}
              />
            </div>
            <div>
              <label className={labelClass}>
                Postal Code <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="postalCode"
                value={formData.postalCode}
                onChange={handleChange}
                className={inputClass}
                placeholder="12345"
                required={!isEditing}
                maxLength={20}
              />
            </div>
            <div>
              <label className={labelClass}>
                Country <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="country"
                value={formData.country}
                onChange={handleChange}
                className={inputClass}
                placeholder="Country"
                required={!isEditing}
                maxLength={100}
              />
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Work Information */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            <Building2 className="w-5 h-5 inline mr-2" />
            Work Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={labelClass}>
                Department
              </label>
              {/* WHY: Guard against empty department list — new tenants won't have departments yet.
                  Show a helpful message instead of a broken empty dropdown that confuses users
                  into thinking the form is broken. */}
              {!loadingDepartments && (!departments || departments.filter(d => d.isActive).length === 0) ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
                  No departments found. Please create a department first in the{' '}
                  <a href="/hr/departments" className="font-medium underline hover:no-underline">
                    Departments
                  </a>{' '}
                  page.
                </div>
              ) : (
                <select
                  name="departmentHrId"
                  value={formData.departmentHrId}
                  onChange={handleDepartmentChange}
                  disabled={isEditing}
                  className={isEditing ? inputDisabledClass : inputClass}
                >
                  <option value="">
                    {loadingDepartments ? 'Loading departments...' : 'Select department'}
                  </option>
                  {(departments || [])
                    .filter((d) => d.isActive)
                    .map((dept) => (
                      <option key={dept.id} value={dept.id}>
                        {dept.name} ({dept.code})
                      </option>
                    ))}
                </select>
              )}
            </div>
            <div>
              <label className={labelClass}>Position</label>
              <input
                type="text"
                name="position"
                value={formData.position}
                onChange={handleChange}
                disabled={isEditing}
                className={isEditing ? inputDisabledClass : inputClass}
                placeholder="e.g. Site Manager, Dive Operator"
              />
            </div>
            <div>
              <label className={labelClass}>
                <Calendar className="w-4 h-4 inline mr-2" />
                Hire Date
              </label>
              <input
                type="date"
                name="hireDate"
                value={formData.hireDate}
                onChange={handleChange}
                disabled={isEditing}
                className={isEditing ? inputDisabledClass : inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Employment Type</label>
              <select
                name="employmentType"
                value={formData.employmentType}
                onChange={handleChange}
                className={inputClass}
              >
                <option value="FULL_TIME">Full Time</option>
                <option value="PART_TIME">Part Time</option>
                <option value="CONTRACT">Contract</option>
                <option value="SEASONAL">Seasonal</option>
              </select>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Financial Information */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            <DollarSign className="w-5 h-5 inline mr-2" />
            Financial Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={labelClass}>
                Base Salary {!isEditing && <span className="text-red-500">*</span>}
              </label>
              <input
                type="number"
                name="baseSalary"
                value={formData.baseSalary}
                onChange={handleChange}
                className={inputClass}
                placeholder="0.00"
                min="0"
                max="100000000"
                step="0.01"
                required={!isEditing}
              />
            </div>
            <div>
              <label className={labelClass}>Currency</label>
              <select
                name="currency"
                value={formData.currency}
                onChange={handleChange}
                className={inputClass}
              >
                {CURRENCY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Aquaculture Information */}
        {/* ============================================================ */}
        <div className={sectionClass}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            <Anchor className="w-5 h-5 inline mr-2" />
            Aquaculture Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className={labelClass}>Personnel Category</label>
              <select
                name="personnelCategory"
                value={formData.personnelCategory}
                onChange={handleChange}
                className={inputClass}
              >
                <option value="">Select category</option>
                <option value="OFFSHORE">Offshore</option>
                <option value="ONSHORE">Onshore</option>
                <option value="HYBRID">Hybrid</option>
              </select>
            </div>
            <div className="flex items-center">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="seaWorthy"
                  checked={formData.seaWorthy}
                  onChange={handleChange}
                  className="w-5 h-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Sea Worthy
                </span>
              </label>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                Certified for offshore deployment
              </span>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* Actions */}
        {/* ============================================================ */}
        <div className="flex items-center justify-end gap-4">
          <Link
            to={isEditing && employeeId ? `/hr/employees/${employeeId}` : '/hr/employees'}
            className="px-6 py-2 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isEditing ? 'Save Changes' : 'Create Employee'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default EmployeeFormPage;
