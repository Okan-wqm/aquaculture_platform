import React, { useEffect, useState } from 'react';
import { useProtocolDetails, useProtocolValidation } from '../../../hooks/useProtocols';
import { DynamicFormRenderer } from '../DynamicFormRenderer';
import { JSONSchema, ValidationError } from '../../../types/registration.types';
import { Spinner } from '@aquaculture/shared-ui';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';

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
        <Spinner size="lg" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">
          Loading protocol configuration...
        </span>
      </div>
    );
  }

  if (error || !protocol) {
    return (
      <div className="p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300">
        Failed to load protocol configuration: {error?.message || 'Protocol not found'}
      </div>
    );
  }

  const schema = protocol.configurationSchema as JSONSchema;

  return (
    <div className="space-y-6">
      {/* Protocol info header */}
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <Info className="w-6 h-6 text-info-600 dark:text-info-400" aria-hidden="true" />
          </div>
          <div className="ml-3">
            <h3 className="text-lg font-medium text-info-900 dark:text-info-100">
              {protocol.name}
            </h3>
            <p className="text-sm text-info-700 dark:text-info-300 mt-1">{protocol.description}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <span className="px-2 py-1 bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 text-xs rounded">
                {protocol.category}
              </span>
              <span className="px-2 py-1 bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 text-xs rounded">
                {protocol.subcategory}
              </span>
              <span className="px-2 py-1 bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 text-xs rounded">
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
          className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-gray-500"
        >
          {validating ? 'Validating...' : 'Validate Configuration'}
        </button>
      </div>

      {/* Validation status */}
      {showValidation && Object.keys(combinedErrors).length === 0 && (
        <div className="p-3 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg text-success-700 dark:text-success-300 flex items-center">
          <CircleCheck className="w-5 h-5 mr-2" aria-hidden="true" />
          Configuration is valid
        </div>
      )}

      {showValidation && Object.keys(combinedErrors).length > 0 && (
        <div className="p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
          <div className="flex items-center text-error-700 dark:text-error-300 mb-2">
            <CircleAlert className="w-5 h-5 mr-2" aria-hidden="true" />
            <span className="font-medium">Please fix the following errors:</span>
          </div>
          <ul className="list-disc list-inside text-sm text-error-600 dark:text-error-400">
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
