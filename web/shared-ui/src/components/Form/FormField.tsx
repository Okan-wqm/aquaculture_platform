/**
 * FormField Component
 * Wrapper component for form fields with validation display
 */

import React from 'react';

export interface FormFieldProps {
  label?: string;
  htmlFor?: string;
  error?: string;
  helperText?: string;
  required?: boolean;
  touched?: boolean;
  showErrorOnlyWhenTouched?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  htmlFor,
  error,
  helperText,
  required = false,
  touched = true,
  showErrorOnlyWhenTouched = true,
  className = '',
  children,
}) => {
  const showError = error && (showErrorOnlyWhenTouched ? touched : true);

  return (
    <div className={`mb-4 ${className}`}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      {children}

      {showError && (
        <p className="mt-1 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {!showError && helperText && (
        <p className="mt-1 text-sm text-gray-500">
          {helperText}
        </p>
      )}
    </div>
  );
};

export default FormField;
