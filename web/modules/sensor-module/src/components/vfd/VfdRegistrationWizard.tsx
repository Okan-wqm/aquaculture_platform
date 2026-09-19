import React, { useCallback } from 'react';
import { Modal, Spinner, Button } from '@aquaculture/shared-ui';
import { VfdBrandSelectionStep } from './steps/VfdBrandSelectionStep';
import { VfdProtocolSelectionStep } from './steps/VfdProtocolSelectionStep';
import { VfdBasicInfoStep } from './steps/VfdBasicInfoStep';
import { VfdProtocolConfigStep } from './steps/VfdProtocolConfigStep';
import { VfdConnectionTestStep } from './steps/VfdConnectionTestStep';
import { VfdReviewStep } from './steps/VfdReviewStep';
import { useVfdRegistration, useVfdRegistrationWizard } from '../../hooks/useVfdRegistration';
import {
  VfdBrandInfo,
  VfdProtocol,
  VfdConnectionTestResult,
  RegisterVfdInput,
  VfdProtocolConfiguration,
} from '../../types/vfd.types';
import { Check, CircleX } from 'lucide-react';

interface VfdRegistrationWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (vfdDeviceId: string) => void;
}

const STEPS = [
  { id: 'brand', title: 'Marka', description: 'VFD markası seçin' },
  { id: 'protocol', title: 'Protokol', description: 'İletişim protokolünü seçin' },
  { id: 'basicInfo', title: 'Bilgiler', description: 'Temel bilgileri girin' },
  { id: 'protocolConfig', title: 'Ayarlar', description: 'Bağlantı ayarları' },
  { id: 'connectionTest', title: 'Test', description: 'Bağlantı testi' },
  { id: 'review', title: 'Onay', description: 'Gözden geçir ve kaydet' },
];

export function VfdRegistrationWizard({ isOpen, onClose, onSuccess }: VfdRegistrationWizardProps) {
  const wizard = useVfdRegistrationWizard();
  const { registerDevice, testConnection, loading: registering } = useVfdRegistration();

  // Validation for each step
  const validateStep = useCallback(
    (step: number): boolean => {
      switch (step) {
        case 0: // Brand selection
          return !!wizard.selectedBrand;
        case 1: // Protocol selection
          return !!wizard.selectedProtocol;
        case 2: // Basic info
          return !!wizard.basicInfo.name && wizard.basicInfo.name.length >= 2;
        case 3: // Protocol config
          return Object.keys(wizard.protocolConfig).length > 0;
        case 4: // Connection test
          return true; // Optional
        case 5: // Review
          return true;
        default:
          return false;
      }
    },
    [wizard.selectedBrand, wizard.selectedProtocol, wizard.basicInfo, wizard.protocolConfig],
  );

  const canProceed = validateStep(wizard.currentStep);

  const handleBrandSelect = (brand: VfdBrandInfo) => {
    wizard.setSelectedBrand(brand);
    wizard.setSelectedProtocol(undefined);
    wizard.updateProtocolConfig({});
    wizard.setConnectionTestResult(undefined);
  };

  const handleProtocolSelect = (protocol: VfdProtocol) => {
    wizard.setSelectedProtocol(protocol);
    wizard.updateProtocolConfig({});
    wizard.setConnectionTestResult(undefined);
  };

  const handleBasicInfoChange = (updates: Partial<RegisterVfdInput>) => {
    wizard.updateBasicInfo(updates);
  };

  const handleProtocolConfigChange = (config: Partial<VfdProtocolConfiguration>) => {
    wizard.updateProtocolConfig(config);
  };

  const handleConnectionTest = async () => {
    if (!wizard.selectedProtocol) return;

    wizard.setIsTestingConnection(true);
    wizard.setError(undefined);

    try {
      const result = await testConnection({
        protocol: wizard.selectedProtocol,
        configuration: wizard.protocolConfig as VfdProtocolConfiguration,
        brand: wizard.selectedBrand?.code,
        modelSeries: wizard.selectedModelSeries,
      });

      wizard.setConnectionTestResult(result);
    } catch (err) {
      wizard.setError((err as Error).message);
    } finally {
      wizard.setIsTestingConnection(false);
    }
  };

  const handleSubmit = async () => {
    const input = wizard.buildRegistrationInput();

    if (!input) {
      wizard.setError('Lütfen tüm gerekli alanları doldurun');
      return;
    }

    wizard.setIsSubmitting(true);
    wizard.setError(undefined);

    try {
      const result = await registerDevice(input);

      if (result.success && result.vfdDevice) {
        wizard.reset();
        onSuccess?.(result.vfdDevice.id);
        onClose();
      } else {
        wizard.setError(result.error || 'Kayıt başarısız oldu');
      }
    } catch (err) {
      wizard.setError((err as Error).message);
    } finally {
      wizard.setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    wizard.reset();
    onClose();
  };

  const handleSkipOptionalStep = () => {
    wizard.nextStep();
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="xl"
      title="Yeni VFD Cihazı Kaydet"
      description="Frekans konvertör cihazınızı sisteme ekleyin"
      showCloseButton={!(wizard.isSubmitting || registering)}
      closeOnEscape={!(wizard.isSubmitting || registering)}
      closeOnOverlayClick={!(wizard.isSubmitting || registering)}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
      footer={
        <div className="flex w-full items-center justify-between">
          <Button
            variant="secondary"
            onClick={wizard.currentStep === 0 ? handleClose : wizard.prevStep}
          >
            {wizard.currentStep === 0 ? 'İptal' : 'Geri'}
          </Button>

          <div className="flex items-center space-x-3">
            {/* Skip button for optional steps */}
            {wizard.currentStep === 4 && !wizard.connectionTestResult?.success && (
              <button
                onClick={handleSkipOptionalStep}
                className="px-4 py-2 text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-hidden"
              >
                Test Atla
              </button>
            )}

            {wizard.currentStep === STEPS.length - 1 ? (
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={wizard.isSubmitting || registering}
              >
                {wizard.isSubmitting || registering ? (
                  <span className="flex items-center">
                    <Spinner size="sm" color="white" className="-ml-1 mr-2" />
                    Kaydediliyor...
                  </span>
                ) : (
                  'VFD Kaydet'
                )}
              </Button>
            ) : (
              <Button variant="primary" onClick={wizard.nextStep} disabled={!canProceed}>
                İleri
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
                onClick={() => index < wizard.currentStep && wizard.goToStep(index)}
                disabled={index > wizard.currentStep}
                className={`flex items-center ${
                  index < wizard.currentStep ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                    index < wizard.currentStep
                      ? 'bg-green-500 text-white'
                      : index === wizard.currentStep
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {index < wizard.currentStep ? (
                    <Check className="w-5 h-5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </div>
                <div className="ml-2 hidden lg:block">
                  <p
                    className={`text-sm font-medium ${
                      index === wizard.currentStep
                        ? 'text-blue-600'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    {step.title}
                  </p>
                </div>
              </button>
              {index < STEPS.length - 1 && (
                <div
                  className={`hidden md:block w-8 lg:w-12 h-0.5 mx-2 transition-colors ${
                    index < wizard.currentStep ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'
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
        {wizard.error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 flex items-center">
            <CircleX className="w-5 h-5 mr-2 flex-shrink-0" aria-hidden="true" />
            {wizard.error}
          </div>
        )}

        {/* Step content */}
        {wizard.currentStep === 0 && (
          <VfdBrandSelectionStep
            selectedBrand={wizard.selectedBrand}
            onSelect={handleBrandSelect}
          />
        )}
        {wizard.currentStep === 1 && wizard.selectedBrand && (
          <VfdProtocolSelectionStep
            brand={wizard.selectedBrand}
            selectedProtocol={wizard.selectedProtocol}
            onSelect={handleProtocolSelect}
          />
        )}
        {wizard.currentStep === 2 && wizard.selectedBrand && (
          <VfdBasicInfoStep
            brand={wizard.selectedBrand}
            values={wizard.basicInfo}
            selectedModelSeries={wizard.selectedModelSeries}
            onModelSeriesChange={wizard.setSelectedModelSeries}
            onChange={handleBasicInfoChange}
          />
        )}
        {wizard.currentStep === 3 && wizard.selectedProtocol && (
          <VfdProtocolConfigStep
            protocol={wizard.selectedProtocol}
            brand={wizard.selectedBrand?.code}
            values={wizard.protocolConfig}
            onChange={handleProtocolConfigChange}
          />
        )}
        {wizard.currentStep === 4 && wizard.selectedProtocol && (
          <VfdConnectionTestStep
            protocol={wizard.selectedProtocol}
            config={wizard.protocolConfig as VfdProtocolConfiguration}
            brand={wizard.selectedBrand?.code}
            testResult={wizard.connectionTestResult}
            isTestingConnection={wizard.isTestingConnection}
            onTest={handleConnectionTest}
          />
        )}
        {wizard.currentStep === 5 && (
          <VfdReviewStep
            brand={wizard.selectedBrand}
            protocol={wizard.selectedProtocol}
            modelSeries={wizard.selectedModelSeries}
            basicInfo={wizard.basicInfo}
            protocolConfig={wizard.protocolConfig}
            connectionTestResult={wizard.connectionTestResult}
            onEdit={wizard.goToStep}
          />
        )}
      </div>
    </Modal>
  );
}

export default VfdRegistrationWizard;
