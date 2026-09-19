/**
 * Wizard Step Indicator Component
 * Displays progress through wizard steps with numbered circles and connecting lines
 */
import React from 'react';
import { Check } from 'lucide-react';

export interface WizardStep {
  id: string;
  title: string;
  description?: string;
}

interface WizardStepIndicatorProps {
  steps: WizardStep[];
  currentStep: number;
  onStepClick?: (stepIndex: number) => void;
  compact?: boolean;
}

export const WizardStepIndicator: React.FC<WizardStepIndicatorProps> = ({
  steps,
  currentStep,
  onStepClick,
  compact = false,
}) => {
  const handleStepClick = (index: number) => {
    // Only allow clicking on completed steps
    if (index < currentStep && onStepClick) {
      onStepClick(index);
    }
  };

  return (
    <div className="flex items-center justify-between">
      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          {/* Step */}
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => handleStepClick(index)}
              disabled={index >= currentStep}
              className={`flex items-center ${
                index < currentStep ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              {/* Circle */}
              <div
                className={`
                  flex items-center justify-center rounded-full text-sm font-medium
                  ${compact ? 'w-6 h-6' : 'w-8 h-8'}
                  ${
                    index < currentStep
                      ? 'bg-success-500 text-white'
                      : index === currentStep
                        ? 'bg-info-600 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }
                `}
              >
                {index < currentStep ? (
                  <Check className={compact ? 'w-4 h-4' : 'w-5 h-5'} aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </div>

              {/* Step Title (hidden on mobile) */}
              {!compact && (
                <div className="ml-2 hidden md:block">
                  <p
                    className={`text-sm font-medium ${
                      index === currentStep
                        ? 'text-info-600 dark:text-info-400'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    {step.title}
                  </p>
                </div>
              )}
            </button>
          </div>

          {/* Connector Line */}
          {index < steps.length - 1 && (
            <div
              className={`
                hidden md:block flex-1 mx-2
                ${compact ? 'h-0.5' : 'h-0.5'}
                ${index < currentStep ? 'bg-success-500' : 'bg-gray-200 dark:bg-gray-700'}
              `}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export default WizardStepIndicator;
