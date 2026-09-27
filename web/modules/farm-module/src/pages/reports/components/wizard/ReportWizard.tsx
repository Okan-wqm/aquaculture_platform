/**
 * Report Wizard Component
 * Generic multi-step wizard for scheduled regulatory reports
 *
 * Follows the SensorRegistrationWizard pattern from sensor-module
 */
import React, { useState, useCallback, ReactNode } from 'react';
import { Modal, Spinner, Button } from '@aquaculture/shared-ui';
import { WizardStepIndicator, WizardStep } from './WizardStepIndicator';
import { CircleX, X } from 'lucide-react';

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
    [currentStep, clearErrors],
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

  const currentStepData = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  // Map the legacy maxWidth prop onto the shared Modal size scale.
  const modalSize: 'lg' | 'xl' | 'full' =
    maxWidth === 'max-w-5xl' ? 'full' : maxWidth === 'max-w-4xl' ? 'xl' : 'lg';

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
      description={subtitle}
      size={modalSize}
    >
      {/* Negate the Modal body padding so the wizard bands stay full-bleed */}
      <div className="-m-4">
        {/* Progress Stepper */}
        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <WizardStepIndicator steps={steps} currentStep={currentStep} onStepClick={goToStep} />
        </div>

        {/* Current Step Info */}
        {currentStepData && (
          <div className="px-6 py-3 bg-info-50 dark:bg-info-900/20 border-b border-info-100 dark:border-info-800">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-info-900 dark:text-info-100">
                  Step {currentStep + 1}: {currentStepData.title}
                </h3>
                {currentStepData.description && (
                  <p className="text-xs text-info-700 dark:text-info-300">
                    {currentStepData.description}
                  </p>
                )}
              </div>
              {currentStepData.optional && (
                <span className="px-2 py-0.5 text-xs font-medium text-info-600 dark:text-info-400 bg-info-100 dark:bg-info-900/40 rounded">
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
            <div className="mb-4 p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
              <div className="flex">
                <CircleX className="h-5 w-5 text-error-400" aria-hidden="true" />
                <div className="ml-3">
                  <p className="text-sm text-error-700 dark:text-error-300">{displayError}</p>
                </div>
                <Button variant="ghost" type="button" onClick={clearErrors}>
                  <X className="w-4 h-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}

          {/* Step Content */}
          {currentStepData?.content}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 rounded-b-lg">
          {/* Left side - Back/Cancel */}
          <Button
            variant="secondary"
            type="button"
            onClick={currentStep === 0 ? handleClose : prevStep}
          >
            {currentStep === 0 ? 'Cancel' : 'Back'}
          </Button>

          {/* Right side - Skip/Next/Submit */}
          <div className="flex items-center space-x-3">
            {/* Skip button for optional steps */}
            {currentStepData?.optional && !isLastStep && (
              <Button variant="ghost" type="button" onClick={nextStep}>
                Skip
              </Button>
            )}

            {/* Next/Submit button */}
            {isLastStep ? (
              <Button
                variant="primary"
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting || !canProceed}
              >
                {isSubmitting ? (
                  <span className="flex items-center">
                    <Spinner size="sm" color="white" className="-ml-1 mr-2" />
                    Submitting...
                  </span>
                ) : (
                  submitButtonText
                )}
              </Button>
            ) : (
              <Button variant="primary" type="button" onClick={nextStep} disabled={!canProceed}>
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ReportWizard;
