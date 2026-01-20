/**
 * Wizard Step Indicator Component
 * Displays progress through wizard steps with numbered circles and connecting lines
 */
import React from 'react';

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
                      ? 'bg-green-500 text-white'
                      : index === currentStep
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-600'
                  }
                `}
              >
                {index < currentStep ? (
                  <svg className={compact ? 'w-4 h-4' : 'w-5 h-5'} fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  index + 1
                )}
              </div>

              {/* Step Title (hidden on mobile) */}
              {!compact && (
                <div className="ml-2 hidden md:block">
                  <p
                    className={`text-sm font-medium ${
                      index === currentStep ? 'text-blue-600' : 'text-gray-600'
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
                ${index < currentStep ? 'bg-green-500' : 'bg-gray-200'}
              `}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export default WizardStepIndicator;
