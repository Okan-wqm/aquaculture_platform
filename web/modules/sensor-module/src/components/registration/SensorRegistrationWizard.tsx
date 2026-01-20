import React, { useState, useCallback } from 'react';
import { ProtocolSelectionStep } from './steps/ProtocolSelectionStep';
import { ProtocolConfigurationStep } from './steps/ProtocolConfigurationStep';
import { ConnectionTestStep } from './steps/ConnectionTestStep';
import { ParentDeviceInfoStep } from './steps/ParentDeviceInfoStep';
import { ChildSensorsStep } from './steps/ChildSensorsStep';
import { ReviewStep } from './steps/ReviewStep';
import { ChildSensorFormModal } from './ChildSensorFormModal';
import { useSensorRegistration } from '../../hooks/useSensorRegistration';
import {
  ProtocolInfo,
  ConnectionTestResult,
  ParentDeviceInfo,
  ChildSensorConfig,
  RegisterParentWithChildrenInput,
  RegisterChildSensorInput,
  inferChildSensorConfig,
  SensorType,
} from '../../types/registration.types';

interface SensorRegistrationWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (parentId: string, childIds: string[]) => void;
}

const STEPS = [
  { id: 'protocol', title: 'Select Protocol', description: 'Choose the communication protocol' },
  { id: 'config', title: 'Protocol Configuration', description: 'Configure connection settings' },
  { id: 'test', title: 'Connection Test', description: 'Test connection and discover data' },
  { id: 'parent', title: 'Device Information', description: 'Enter parent device details' },
  { id: 'children', title: 'Configure Sensors', description: 'Setup individual sensors' },
  { id: 'review', title: 'Review & Register', description: 'Confirm and register all' },
];

export function SensorRegistrationWizard({
  isOpen,
  onClose,
  onSuccess,
}: SensorRegistrationWizardProps) {
  // Registration hook
  const { registerParentWithChildren, loading: registrationLoading } = useSensorRegistration();

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Protocol state
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  const [selectedProtocolInfo, setSelectedProtocolInfo] = useState<ProtocolInfo | null>(null);
  const [protocolConfig, setProtocolConfig] = useState<Record<string, unknown>>({});

  // Connection test state
  const [connectionTestResult, setConnectionTestResult] = useState<ConnectionTestResult | null>(null);

  // Parent-Child state
  const [parentDeviceInfo, setParentDeviceInfo] = useState<Partial<ParentDeviceInfo>>({});
  const [childSensors, setChildSensors] = useState<ChildSensorConfig[]>([]);

  // Modal state
  const [editingChild, setEditingChild] = useState<ChildSensorConfig | null>(null);
  const [isChildModalOpen, setIsChildModalOpen] = useState(false);

  // Validation for each step
  const validateStep = useCallback(
    (step: number): boolean => {
      switch (step) {
        case 0:
          return !!selectedProtocol;
        case 1:
          return Object.keys(protocolConfig).length > 0;
        case 2:
          return true; // Connection test is optional but recommended
        case 3:
          return !!parentDeviceInfo.name;
        case 4:
          return childSensors.filter((c) => c.selected).length > 0;
        case 5:
          return true; // Review step
        default:
          return false;
      }
    },
    [selectedProtocol, protocolConfig, parentDeviceInfo, childSensors]
  );

  const canProceed = validateStep(currentStep);

  const nextStep = () => {
    if (currentStep < STEPS.length - 1 && canProceed) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const goToStep = (step: number) => {
    if (step < currentStep) {
      setCurrentStep(step);
    }
  };

  const reset = () => {
    setCurrentStep(0);
    setError(null);
    setSelectedProtocol(null);
    setSelectedProtocolInfo(null);
    setProtocolConfig({});
    setConnectionTestResult(null);
    setParentDeviceInfo({});
    setChildSensors([]);
    setIsSubmitting(false);
  };

  // Protocol selection handler
  const handleProtocolSelect = (protocol: ProtocolInfo) => {
    setSelectedProtocol(protocol.code);
    setSelectedProtocolInfo(protocol);
    setProtocolConfig({});
    setConnectionTestResult(null);
    setChildSensors([]);
  };

  // Protocol config handler
  const handleProtocolConfigChange = (config: Record<string, unknown>) => {
    setProtocolConfig(config);
  };

  // Connection test handler
  const handleConnectionTestComplete = (result: ConnectionTestResult) => {
    setConnectionTestResult(result);

    // Auto-discover child sensors from sample data
    if (result.success && result.sampleData) {
      const discovered = discoverChildSensorsFromData(result.sampleData, parentDeviceInfo.name);
      setChildSensors(discovered);
    }
  };

  // Parent info handler
  const handleParentInfoChange = (updates: Partial<ParentDeviceInfo>) => {
    setParentDeviceInfo((prev) => ({ ...prev, ...updates }));
  };

  // Child sensors handler
  const handleChildSensorsChange = (sensors: ChildSensorConfig[]) => {
    setChildSensors(sensors);
  };

  // Edit child handler
  const handleEditChild = (child: ChildSensorConfig) => {
    setEditingChild(child);
    setIsChildModalOpen(true);
  };

  // Save child handler
  const handleSaveChild = (child: ChildSensorConfig) => {
    setChildSensors((prev) => {
      const idx = prev.findIndex((c) => c.dataPath === child.dataPath);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = child;
        return updated;
      }
      return [...prev, child];
    });
    setIsChildModalOpen(false);
    setEditingChild(null);
  };

  // Submit handler
  const handleSubmit = async () => {
    const selectedChildren = childSensors.filter((c) => c.selected);

    if (!selectedProtocol || !parentDeviceInfo.name || selectedChildren.length === 0) {
      setError('Please complete all required fields');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const input: RegisterParentWithChildrenInput = {
      parent: {
        name: parentDeviceInfo.name!,
        protocolCode: selectedProtocol,
        protocolConfiguration: protocolConfig,
        manufacturer: parentDeviceInfo.manufacturer,
        model: parentDeviceInfo.model,
        serialNumber: parentDeviceInfo.serialNumber,
        description: parentDeviceInfo.description,
        farmId: parentDeviceInfo.farmId,
        pondId: parentDeviceInfo.pondId,
        tankId: parentDeviceInfo.tankId,
        location: parentDeviceInfo.location,
      },
      children: selectedChildren.map((c): RegisterChildSensorInput => ({
        name: c.name,
        type: c.type,
        dataPath: c.dataPath,
        unit: c.unit,
        minValue: c.minValue,
        maxValue: c.maxValue,
        calibrationEnabled: c.calibrationEnabled,
        calibrationMultiplier: c.calibrationMultiplier,
        calibrationOffset: c.calibrationOffset,
        alertThresholds: c.alertThresholds,
        displaySettings: c.displaySettings,
      })),
      skipConnectionTest: !connectionTestResult?.success,
    };

    try {
      // Call the actual GraphQL mutation
      const result = await registerParentWithChildren(input);

      if (result.success && result.parent) {
        const parentId = result.parent.id;
        const childIds = result.children?.map((c) => c.id) || [];

        reset();
        onSuccess?.(parentId, childIds);
        onClose();
      } else {
        setError(result.error || 'Registration failed');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={handleClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">Register New Sensor Device</h2>
            <button
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

          {/* Progress stepper */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between">
              {STEPS.map((step, index) => (
                <div key={step.id} className="flex items-center">
                  <button
                    onClick={() => index < currentStep && goToStep(index)}
                    disabled={index > currentStep}
                    className={`flex items-center ${
                      index < currentStep ? 'cursor-pointer' : 'cursor-default'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                        index < currentStep
                          ? 'bg-green-500 text-white'
                          : index === currentStep
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-200 text-gray-600'
                      }`}
                    >
                      {index < currentStep ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
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
                    <div className="ml-2 hidden md:block">
                      <p
                        className={`text-sm font-medium ${
                          index === currentStep ? 'text-blue-600' : 'text-gray-600'
                        }`}
                      >
                        {step.title}
                      </p>
                    </div>
                  </button>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`hidden md:block w-12 h-0.5 mx-2 ${
                        index < currentStep ? 'bg-green-500' : 'bg-gray-200'
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="p-6 overflow-y-auto max-h-[calc(90vh-220px)]">
            {/* Error message */}
            {error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                {error}
              </div>
            )}

            {/* Step content */}
            {currentStep === 0 && (
              <ProtocolSelectionStep
                selectedProtocol={selectedProtocol}
                onSelect={handleProtocolSelect}
              />
            )}
            {currentStep === 1 && selectedProtocol && (
              <ProtocolConfigurationStep
                protocolCode={selectedProtocol}
                values={protocolConfig}
                onChange={handleProtocolConfigChange}
              />
            )}
            {currentStep === 2 && selectedProtocol && (
              <ConnectionTestStep
                protocolCode={selectedProtocol}
                config={protocolConfig}
                onTestComplete={handleConnectionTestComplete}
                testResult={connectionTestResult}
              />
            )}
            {currentStep === 3 && (
              <ParentDeviceInfoStep
                values={parentDeviceInfo}
                onChange={handleParentInfoChange}
              />
            )}
            {currentStep === 4 && (
              <ChildSensorsStep
                childSensors={childSensors}
                onChange={handleChildSensorsChange}
                onEditSensor={handleEditChild}
                parentName={parentDeviceInfo.name}
              />
            )}
            {currentStep === 5 && (
              <ReviewStep
                protocol={selectedProtocolInfo}
                basicInfo={parentDeviceInfo}
                protocolConfig={protocolConfig}
                connectionTestResult={connectionTestResult}
                childSensors={childSensors.filter((c) => c.selected)}
                onEdit={goToStep}
              />
            )}
          </div>

          {/* Child Sensor Form Modal */}
          <ChildSensorFormModal
            sensor={editingChild || undefined}
            isOpen={isChildModalOpen}
            onClose={() => {
              setIsChildModalOpen(false);
              setEditingChild(null);
            }}
            onSave={handleSaveChild}
          />

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-t border-gray-200">
            <button
              onClick={currentStep === 0 ? handleClose : prevStep}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              {currentStep === 0 ? 'Cancel' : 'Back'}
            </button>

            <div className="flex items-center space-x-3">
              {currentStep === STEPS.length - 1 ? (
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
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
                      Registering...
                    </span>
                  ) : (
                    'Register Device & Sensors'
                  )}
                </button>
              ) : (
                <button
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
}

/**
 * Helper to discover child sensors from sample data
 */
function discoverChildSensorsFromData(
  sampleData: Record<string, unknown>,
  parentName?: string
): ChildSensorConfig[] {
  const sensors: ChildSensorConfig[] = [];

  function processValue(key: string, value: unknown, path: string = key) {
    // Handle numeric values
    if (typeof value === 'number') {
      sensors.push(inferChildSensorConfig(path, value, parentName));
      return;
    }

    // Handle string values that might be numeric
    if (typeof value === 'string') {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        sensors.push(inferChildSensorConfig(path, num, parentName));
        return;
      }
    }

    // Handle nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        processValue(nestedKey, nestedValue, `${path}.${nestedKey}`);
      }
    }
  }

  // Skip certain keys that are not sensor values
  const skipKeys = ['timestamp', 'time', 'id', 'device_id', 'sensor_id', 'version'];

  for (const [key, value] of Object.entries(sampleData)) {
    if (!skipKeys.includes(key.toLowerCase())) {
      processValue(key, value);
    }
  }

  return sensors;
}

export default SensorRegistrationWizard;
