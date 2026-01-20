import React, { useEffect, useState } from 'react';
import { useProtocolDetails, useProtocolValidation } from '../../../hooks/useProtocols';
import { DynamicFormRenderer } from '../DynamicFormRenderer';
import { JSONSchema, ValidationError } from '../../../types/registration.types';

interface ProtocolConfigurationStepProps {
  protocolCode: string;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
  onValidationChange?: (isValid: boolean) => void;
}

export function ProtocolConfigurationStep({
  protocolCode,
  values,
  onChange,
  errors: externalErrors = {},
  onValidationChange,
}: ProtocolConfigurationStepProps) {
  const { protocol, loading, error } = useProtocolDetails(protocolCode);
  const { validate, loading: validating } = useProtocolValidation();
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [showValidation, setShowValidation] = useState(false);

  // Apply defaults when protocol loads
  useEffect(() => {
    if (protocol?.defaultConfiguration && Object.keys(values).length === 0) {
      onChange(protocol.defaultConfiguration);
    }
  }, [protocol, onChange, values]);

  // Validate on blur or explicit validation
  const handleValidate = async () => {
    setShowValidation(true);
    const result = await validate(protocolCode, values);

    const errorMap: Record<string, string> = {};
    result.errors.forEach((err) => {
      errorMap[err.field] = err.message;
    });
    setValidationErrors(errorMap);

    if (onValidationChange) {
      onValidationChange(result.isValid);
    }
  };

  const handleFieldChange = (field: string, value: unknown) => {
    const newValues = { ...values, [field]: value };
    onChange(newValues);

    // Clear validation error for this field
    if (validationErrors[field]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const combinedErrors = { ...validationErrors, ...externalErrors };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Loading protocol configuration...</span>
      </div>
    );
  }

  if (error || !protocol) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        Failed to load protocol configuration: {error?.message || 'Protocol not found'}
      </div>
    );
  }

  const schema = protocol.configurationSchema as JSONSchema;

  return (
    <div className="space-y-6">
      {/* Protocol info header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-lg font-medium text-blue-900">{protocol.name}</h3>
            <p className="text-sm text-blue-700 mt-1">{protocol.description}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                {protocol.category}
              </span>
              <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                {protocol.subcategory}
              </span>
              <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                {protocol.connectionType}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Dynamic form */}
      <DynamicFormRenderer
        schema={schema}
        values={values}
        onChange={handleFieldChange}
        errors={showValidation ? combinedErrors : externalErrors}
      />

      {/* Validation button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleValidate}
          disabled={validating}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
        >
          {validating ? 'Validating...' : 'Validate Configuration'}
        </button>
      </div>

      {/* Validation status */}
      {showValidation && Object.keys(combinedErrors).length === 0 && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 flex items-center">
          <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          Configuration is valid
        </div>
      )}

      {showValidation && Object.keys(combinedErrors).length > 0 && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center text-red-700 mb-2">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span className="font-medium">Please fix the following errors:</span>
          </div>
          <ul className="list-disc list-inside text-sm text-red-600">
            {Object.entries(combinedErrors).map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default ProtocolConfigurationStep;
