import React, { useState, useCallback } from 'react';
import { Modal, Spinner, Button } from '@aquaculture/shared-ui';
import { ProtocolSelectionStep } from './steps/ProtocolSelectionStep';
import { ProtocolConfigurationStep } from './steps/ProtocolConfigurationStep';
import { ConnectionTestStep } from './steps/ConnectionTestStep';
import { ParentDeviceInfoStep } from './steps/ParentDeviceInfoStep';
import { ChildSensorsStep } from './steps/ChildSensorsStep';
import { ReviewStep } from './steps/ReviewStep';
import { ChildSensorFormModal } from './ChildSensorFormModal';
import { useSensorRegistration } from '../../hooks/useSensorRegistration';
import { useSensorParameterCatalog } from '../../hooks/useSensorParameterCatalog';
import {
  ProtocolInfo,
  ProtocolDetails,
  ConnectionTestResult,
  ParentDeviceInfo,
  ChildSensorConfig,
  RegisterParentWithChildrenInput,
  RegisterChildSensorInput,
  ParameterCatalog,
  inferChildSensorConfig,
  SensorType,
} from '../../types/registration.types';
import { Check } from 'lucide-react';

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
  const [connectionTestResult, setConnectionTestResult] = useState<ConnectionTestResult | null>(
    null,
  );

  // Parent-Child state
  const [parentDeviceInfo, setParentDeviceInfo] = useState<Partial<ParentDeviceInfo>>({});
  const [childSensors, setChildSensors] = useState<ChildSensorConfig[]>([]);

  // SENSOR-MEDIUM-065: parameter catalog (units/ranges/SensorType per channel key)
  // fetched from the backend SSoT — used to prefill auto-discovered child sensors.
  const { catalog: parameterCatalog } = useSensorParameterCatalog();

  // Modal state
  const [editingChild, setEditingChild] = useState<ChildSensorConfig | null>(null);
  const [isChildModalOpen, setIsChildModalOpen] = useState(false);

  // Validation for each step
  const validateStep = useCallback(
    (step: number): boolean => {
      switch (step) {
        case 0:
          return !!selectedProtocol;
        case 1: {
          // BUG-008: validate all required fields from the protocol schema, not just non-empty object
          // ProtocolDetails (which extends ProtocolInfo) holds the schema as `configurationSchema`
          const required: string[] =
            (selectedProtocolInfo as ProtocolDetails | null)?.configurationSchema?.required || [];
          if (required.length === 0) {
            // No schema-required fields — accept any non-empty config
            return Object.keys(protocolConfig).length > 0;
          }
          return required.every((field) => {
            const val = protocolConfig[field];
            return val !== undefined && val !== '' && val !== null;
          });
        }
        case 2:
          return true; // Connection test is optional but recommended
        case 3:
          // SENSOR-HIGH-024: enforce the Site + Department the step marks
          // required (*), so the location hierarchy is actually supplied.
          return (
            !!parentDeviceInfo.name && !!parentDeviceInfo.siteId && !!parentDeviceInfo.departmentId
          );
        case 4:
          return childSensors.filter((c) => c.selected).length > 0;
        case 5:
          return true; // Review step
        default:
          return false;
      }
    },
    [selectedProtocol, protocolConfig, parentDeviceInfo, childSensors],
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
      const discovered = discoverChildSensorsFromData(
        result.sampleData,
        parentDeviceInfo.name,
        parameterCatalog,
      );
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

  // SENSOR-HIGH-117: create-mode handler — opens the modal blank so the
  // operator can enter parameters manually when the connection test could
  // not run (e.g. internal broker behind the SSRF guard).
  const handleAddChild = () => {
    setEditingChild(null);
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
        // SENSOR-HIGH-024: serialize the location hierarchy the wizard collects
        // (and marks required). It was previously dropped — only the dead legacy
        // farm/pond/tank keys were sent — so devices persisted with NULL
        // site/department and were orphaned from the site tree.
        siteId: parentDeviceInfo.siteId,
        departmentId: parentDeviceInfo.departmentId,
        systemId: parentDeviceInfo.systemId,
        equipmentId: parentDeviceInfo.equipmentId,
        location: parentDeviceInfo.location,
      },
      children: selectedChildren.map(
        (c): RegisterChildSensorInput => ({
          name: c.name,
          type: c.type,
          // SENSOR-MEDIUM-071: carry the per-child custom type-definition so the
          // backend bootstraps its default channels in the registration transaction.
          typeDefinitionId: c.typeDefinitionId,
          dataPath: c.dataPath,
          unit: c.unit,
          minValue: c.minValue,
          maxValue: c.maxValue,
          calibrationEnabled: c.calibrationEnabled,
          calibrationMultiplier: c.calibrationMultiplier,
          calibrationOffset: c.calibrationOffset,
          alertThresholds: c.alertThresholds,
          displaySettings: c.displaySettings,
        }),
      ),
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
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="xl"
      title="Register New Sensor Device"
      showCloseButton={!isSubmitting}
      closeOnEscape={!isSubmitting}
      closeOnOverlayClick={!isSubmitting}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="secondary" onClick={currentStep === 0 ? handleClose : prevStep}>
            {currentStep === 0 ? 'Cancel' : 'Back'}
          </Button>

          <div className="flex items-center space-x-3">
            {currentStep === STEPS.length - 1 ? (
              <Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? (
                  <span className="flex items-center">
                    <Spinner size="sm" color="white" className="-ml-1 mr-2" />
                    Registering...
                  </span>
                ) : (
                  'Register Device & Sensors'
                )}
              </Button>
            ) : (
              <Button variant="primary" onClick={nextStep} disabled={!canProceed}>
                Next
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* Progress stepper */}
      <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          {STEPS.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <button
                onClick={() => index < currentStep && goToStep(index)}
                disabled={index > currentStep}
                aria-current={index === currentStep ? 'step' : undefined}
                className={`flex items-center ${
                  index < currentStep ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    index < currentStep
                      ? 'bg-success-500 text-white'
                      : index === currentStep
                        ? 'bg-info-600 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {index < currentStep ? (
                    <Check className="w-5 h-5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </div>
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
              </button>
              {index < STEPS.length - 1 && (
                <div
                  className={`hidden md:block w-12 h-0.5 mx-2 ${
                    index < currentStep ? 'bg-success-500' : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="p-6 overflow-y-auto flex-1 min-h-0">
        {/* Error message */}
        {error && (
          <div className="mb-4 p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300">
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
          <ParentDeviceInfoStep values={parentDeviceInfo} onChange={handleParentInfoChange} />
        )}
        {currentStep === 4 && (
          <ChildSensorsStep
            childSensors={childSensors}
            onChange={handleChildSensorsChange}
            onEditSensor={handleEditChild}
            onAddSensor={handleAddChild}
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
        existingDataPaths={childSensors.map((c) => c.dataPath)}
        isOpen={isChildModalOpen}
        onClose={() => {
          setIsChildModalOpen(false);
          setEditingChild(null);
        }}
        onSave={handleSaveChild}
      />
    </Modal>
  );
}

/**
 * Helper to discover child sensors from sample data
 */
function discoverChildSensorsFromData(
  sampleData: Record<string, unknown>,
  parentName: string | undefined,
  catalog: ParameterCatalog,
): ChildSensorConfig[] {
  const sensors: ChildSensorConfig[] = [];

  function processValue(key: string, value: unknown, path: string = key) {
    // Handle numeric values
    if (typeof value === 'number') {
      sensors.push(inferChildSensorConfig(path, value, parentName, catalog));
      return;
    }

    // Handle string values that might be numeric
    if (typeof value === 'string') {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        sensors.push(inferChildSensorConfig(path, num, parentName, catalog));
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
