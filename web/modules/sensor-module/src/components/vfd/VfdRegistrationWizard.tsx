import React, { useCallback } from 'react';
import { VfdBrandSelectionStep } from './steps/VfdBrandSelectionStep';
import { VfdProtocolSelectionStep } from './steps/VfdProtocolSelectionStep';
import { VfdBasicInfoStep } from './steps/VfdBasicInfoStep';
import { VfdProtocolConfigStep } from './steps/VfdProtocolConfigStep';
import { VfdConnectionTestStep } from './steps/VfdConnectionTestStep';
import { VfdReviewStep } from './steps/VfdReviewStep';
import {
  useVfdRegistration,
  useVfdRegistrationWizard,
} from '../../hooks/useVfdRegistration';
import {
  VfdBrandInfo,
  VfdProtocol,
  VfdConnectionTestResult,
  RegisterVfdInput,
  VfdProtocolConfiguration,
} from '../../types/vfd.types';

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

export function VfdRegistrationWizard({
  isOpen,
  onClose,
  onSuccess,
}: VfdRegistrationWizardProps) {
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
    [wizard.selectedBrand, wizard.selectedProtocol, wizard.basicInfo, wizard.protocolConfig]
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
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={handleClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-blue-600 to-indigo-600">
            <div>
              <h2 className="text-xl font-semibold text-white">Yeni VFD Cihazı Kaydet</h2>
              <p className="text-sm text-blue-100">Frekans konvertör cihazınızı sisteme ekleyin</p>
            </div>
            <button
              onClick={handleClose}
              className="text-white/80 hover:text-white focus:outline-none"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Progress stepper */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
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
                          : 'bg-gray-200 text-gray-600'
                      }`}
                    >
                      {index < wizard.currentStep ? (
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
                    <div className="ml-2 hidden lg:block">
                      <p
                        className={`text-sm font-medium ${
                          index === wizard.currentStep ? 'text-blue-600' : 'text-gray-600'
                        }`}
                      >
                        {step.title}
                      </p>
                    </div>
                  </button>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`hidden md:block w-8 lg:w-12 h-0.5 mx-2 transition-colors ${
                        index < wizard.currentStep ? 'bg-green-500' : 'bg-gray-200'
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
            {wizard.error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 flex items-center">
                <svg className="w-5 h-5 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
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

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-t border-gray-200">
            <button
              onClick={wizard.currentStep === 0 ? handleClose : wizard.prevStep}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              {wizard.currentStep === 0 ? 'İptal' : 'Geri'}
            </button>

            <div className="flex items-center space-x-3">
              {/* Skip button for optional steps */}
              {wizard.currentStep === 4 && !wizard.connectionTestResult?.success && (
                <button
                  onClick={handleSkipOptionalStep}
                  className="px-4 py-2 text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 focus:outline-none"
                >
                  Test Atla
                </button>
              )}

              {wizard.currentStep === STEPS.length - 1 ? (
                <button
                  onClick={handleSubmit}
                  disabled={wizard.isSubmitting || registering}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {wizard.isSubmitting || registering ? (
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
                      Kaydediliyor...
                    </span>
                  ) : (
                    'VFD Kaydet'
                  )}
                </button>
              ) : (
                <button
                  onClick={wizard.nextStep}
                  disabled={!canProceed}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  İleri
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VfdRegistrationWizard;
