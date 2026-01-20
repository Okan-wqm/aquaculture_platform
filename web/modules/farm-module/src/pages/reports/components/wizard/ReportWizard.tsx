/**
 * Report Wizard Component
 * Generic multi-step wizard for scheduled regulatory reports
 *
 * Follows the SensorRegistrationWizard pattern from sensor-module
 */
import React, { useState, useCallback, ReactNode } from 'react';
import { WizardStepIndicator, WizardStep } from './WizardStepIndicator';

// ============================================================================
// Types
// ============================================================================

export interface ReportWizardStep extends WizardStep {
  /** Content to render for this step */
  content: ReactNode;
  /** Validation function for this step - returns true if valid */
  isValid?: () => boolean;
  /** Whether this step can be skipped */
  optional?: boolean;
}

export interface ReportWizardProps {
  /** Whether the wizard is open */
  isOpen: boolean;
  /** Close handler */
  onClose: () => void;
  /** Submit handler - called when final step is confirmed */
  onSubmit: () => Promise<void>;
  /** Success callback */
  onSuccess?: () => void;
  /** Wizard title */
  title: string;
  /** Subtitle/description */
  subtitle?: string;
  /** Steps configuration */
  steps: ReportWizardStep[];
  /** Current form data (for resetting) */
  formData?: Record<string, unknown>;
  /** Loading state for submit */
  isSubmitting?: boolean;
  /** Error message */
  error?: string | null;
  /** Clear error handler */
  onClearError?: () => void;
  /** Submit button text */
  submitButtonText?: string;
  /** Maximum width class */
  maxWidth?: 'max-w-2xl' | 'max-w-3xl' | 'max-w-4xl' | 'max-w-5xl';
}

// ============================================================================
// Component
// ============================================================================

export const ReportWizard: React.FC<ReportWizardProps> = ({
  isOpen,
  onClose,
  onSubmit,
  onSuccess,
  title,
  subtitle,
  steps,
  isSubmitting = false,
  error,
  onClearError,
  submitButtonText = 'Submit Report',
  maxWidth = 'max-w-4xl',
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  // Combined error state
  const displayError = error || localError;

  // Clear errors when changing steps
  const clearErrors = useCallback(() => {
    setLocalError(null);
    onClearError?.();
  }, [onClearError]);

  // Validate current step
  const validateCurrentStep = useCallback((): boolean => {
    const step = steps[currentStep];
    if (!step) return false;
    if (step.optional) return true;
    if (step.isValid) return step.isValid();
    return true;
  }, [steps, currentStep]);

  // Can proceed to next step
  const canProceed = validateCurrentStep();

  // Navigation
  const nextStep = useCallback(() => {
    if (currentStep < steps.length - 1) {
      if (!validateCurrentStep()) {
        setLocalError('Please complete all required fields before proceeding');
        return;
      }
      clearErrors();
      setCurrentStep((prev) => prev + 1);
    }
  }, [currentStep, steps.length, validateCurrentStep, clearErrors]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      clearErrors();
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep, clearErrors]);

  const goToStep = useCallback(
    (stepIndex: number) => {
      if (stepIndex < currentStep) {
        clearErrors();
        setCurrentStep(stepIndex);
      }
    },
    [currentStep, clearErrors]
  );

  // Reset wizard
  const reset = useCallback(() => {
    setCurrentStep(0);
    setLocalError(null);
    onClearError?.();
  }, [onClearError]);

  // Handle close
  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // Handle submit
  const handleSubmit = useCallback(async () => {
    if (!validateCurrentStep()) {
      setLocalError('Please complete all required fields');
      return;
    }

    try {
      await onSubmit();
      reset();
      onSuccess?.();
    } catch (err) {
      setLocalError((err as Error).message);
    }
  }, [validateCurrentStep, onSubmit, reset, onSuccess]);

  // Don't render if closed
  if (!isOpen) return null;

  const currentStepData = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={handleClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className={`relative bg-white rounded-xl shadow-xl w-full ${maxWidth} max-h-[90vh] overflow-hidden`}>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
              {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 focus:outline-none"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Progress Stepper */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
            <WizardStepIndicator
              steps={steps}
              currentStep={currentStep}
              onStepClick={goToStep}
            />
          </div>

          {/* Current Step Info */}
          {currentStepData && (
            <div className="px-6 py-3 bg-blue-50 border-b border-blue-100">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-blue-900">
                    Step {currentStep + 1}: {currentStepData.title}
                  </h3>
                  {currentStepData.description && (
                    <p className="text-xs text-blue-700">{currentStepData.description}</p>
                  )}
                </div>
                {currentStepData.optional && (
                  <span className="px-2 py-0.5 text-xs font-medium text-blue-600 bg-blue-100 rounded">
                    Optional
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Content */}
          <div className="p-6 overflow-y-auto max-h-[calc(90vh-280px)]">
            {/* Error Message */}
            {displayError && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex">
                  <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <div className="ml-3">
                    <p className="text-sm text-red-700">{displayError}</p>
                  </div>
                  <button
                    type="button"
                    onClick={clearErrors}
                    className="ml-auto text-red-400 hover:text-red-600"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Step Content */}
            {currentStepData?.content}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-t border-gray-200">
            {/* Left side - Back/Cancel */}
            <button
              type="button"
              onClick={currentStep === 0 ? handleClose : prevStep}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              {currentStep === 0 ? 'Cancel' : 'Back'}
            </button>

            {/* Right side - Skip/Next/Submit */}
            <div className="flex items-center space-x-3">
              {/* Skip button for optional steps */}
              {currentStepData?.optional && !isLastStep && (
                <button
                  type="button"
                  onClick={nextStep}
                  className="px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  Skip
                </button>
              )}

              {/* Next/Submit button */}
              {isLastStep ? (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isSubmitting || !canProceed}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <span className="flex items-center">
                      <svg
                        className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Submitting...
                    </span>
                  ) : (
                    submitButtonText
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={nextStep}
                  disabled={!canProceed}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReportWizard;
