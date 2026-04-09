/**
 * FormField Component
 * Wrapper component for form fields with validation display
 *
 * FE-HIGH-018: WCAG 2.1 AA compliant — provides:
 *   - aria-describedby linking error/helper messages to the input
 *   - aria-required on mandatory fields
 *   - aria-invalid when validation fails
 *   - Visual error indicator (not color-only — includes icon + text)
 *
 * @see FE-HIGH-018
 */

import React, { useId } from 'react';

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
  // Generate stable unique IDs for aria associations
  const autoId = useId();
  const errorId = `${htmlFor ?? autoId}-error`;
  const helperId = `${htmlFor ?? autoId}-helper`;

  const showError = error && (showErrorOnlyWhenTouched ? touched : true);

  // Build aria-describedby value for child input cloning
  const describedBy = showError ? errorId : helperText ? helperId : undefined;

  return (
    <div className={`mb-4 ${className}`}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          {label}
          {/* FE-HIGH-018: aria-required communicated visually AND semantically */}
          {required && (
            <span className="text-red-500 ml-1" aria-hidden="true">*</span>
          )}
        </label>
      )}

      {/*
        FE-HIGH-018: Clone the child input to inject a11y attributes.
        This makes WCAG compliance automatic for any input wrapped in FormField.
      */}
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          const a11yProps: Record<string, unknown> = {};

          if (describedBy) {
            a11yProps['aria-describedby'] = describedBy;
          }
          if (showError) {
            a11yProps['aria-invalid'] = true;
          }
          if (required) {
            a11yProps['aria-required'] = true;
          }

          // Only clone if we have a11y props to inject
          if (Object.keys(a11yProps).length > 0) {
            return React.cloneElement(child, a11yProps);
          }
        }
        return child;
      })}

      {/* FE-HIGH-018: Error message with role="alert" for screen reader announcement.
          Includes a visual icon so error is not indicated by color alone (WCAG 1.4.1). */}
      {showError && (
        <p
          id={errorId}
          className="mt-1 text-sm text-red-600 flex items-center gap-1"
          role="alert"
        >
          <svg
            className="w-4 h-4 flex-shrink-0"
            fill="currentColor"
            viewBox="0 0 20 20"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          {error}
        </p>
      )}

      {!showError && helperText && (
        <p id={helperId} className="mt-1 text-sm text-gray-500">
          {helperText}
        </p>
      )}
    </div>
  );
};

export default FormField;
