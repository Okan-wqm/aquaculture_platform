/**
 * Edge Device Registration Wizard
 *
 * Modal wizard for registering new edge controllers (Revolution Pi, Industrial PC, etc.)
 * Uses zero-touch provisioning - creates device and shows installer command.
 */

import React, { useState, useCallback } from 'react';
import { Button, Input, Modal, Select, Spinner, Textarea } from '@aquaculture/shared-ui';
import { Server, CheckCircle, AlertCircle } from 'lucide-react';
import {
  useCreateProvisionedDevice,
  DeviceModel,
  CreateProvisionedDeviceInput,
  ProvisionedDeviceResponse,
} from '../../hooks/useEdgeDevices';
import { InstallerCommandModal } from './InstallerCommandModal';

interface EdgeDeviceWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (deviceId: string) => void;
}

interface FormData {
  deviceModel: DeviceModel | '';
  deviceName: string;
  siteId: string;
  serialNumber: string;
  description: string;
}

const DEVICE_MODELS: { value: DeviceModel; label: string; prefix: string }[] = [
  { value: DeviceModel.REVOLUTION_PI_CONNECT_4, label: 'Revolution Pi Connect 4', prefix: 'RPI' },
  { value: DeviceModel.REVOLUTION_PI_COMPACT, label: 'Revolution Pi Compact', prefix: 'RPC' },
  { value: DeviceModel.RASPBERRY_PI_4, label: 'Raspberry Pi 4', prefix: 'PI4' },
  { value: DeviceModel.RASPBERRY_PI_5, label: 'Raspberry Pi 5', prefix: 'PI5' },
  { value: DeviceModel.INDUSTRIAL_PC, label: 'Industrial PC', prefix: 'IPC' },
  { value: DeviceModel.CUSTOM, label: 'Custom / Other', prefix: 'EDG' },
];

export function EdgeDeviceWizard({ isOpen, onClose, onSuccess }: EdgeDeviceWizardProps) {
  const [formData, setFormData] = useState<FormData>({
    deviceModel: '',
    deviceName: '',
    siteId: '',
    serialNumber: '',
    description: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [provisioningResult, setProvisioningResult] = useState<ProvisionedDeviceResponse | null>(
    null,
  );
  const [showInstallerModal, setShowInstallerModal] = useState(false);

  const { mutate: createDevice, isPending: isCreating } = useCreateProvisionedDevice();

  const handleInputChange = useCallback(
    (field: keyof FormData) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const value = e.target.value;
        setFormData((prev) => ({ ...prev, [field]: value }));
        setError(null);
      },
    [],
  );

  const validateForm = useCallback((): boolean => {
    // Device name is optional but if provided should be meaningful
    if (formData.deviceName && formData.deviceName.length < 2) {
      setError('Cihaz adı en az 2 karakter olmalıdır');
      return false;
    }
    return true;
  }, [formData]);

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;

    const input: CreateProvisionedDeviceInput = {
      ...(formData.deviceModel && { deviceModel: formData.deviceModel as DeviceModel }),
      ...(formData.deviceName && { deviceName: formData.deviceName }),
      ...(formData.siteId && { siteId: formData.siteId }),
      ...(formData.serialNumber && { serialNumber: formData.serialNumber }),
      ...(formData.description && { description: formData.description }),
    };

    createDevice(input, {
      onSuccess: (result) => {
        console.log('Edge device provisioned successfully:', result.deviceId);
        setProvisioningResult(result);
        setShowInstallerModal(true);
        onSuccess?.(result.deviceId);
      },
      onError: (err) => {
        console.error('Failed to provision edge device:', err);
        setError(
          err instanceof Error ? err.message : 'Cihaz oluşturulamadı. Lütfen tekrar deneyin.',
        );
      },
    });
  }, [formData, validateForm, createDevice, onSuccess]);

  const handleClose = useCallback(() => {
    setFormData({
      deviceModel: '',
      deviceName: '',
      siteId: '',
      serialNumber: '',
      description: '',
    });
    setError(null);
    setProvisioningResult(null);
    setShowInstallerModal(false);
    onClose();
  }, [onClose]);

  const handleInstallerModalClose = useCallback(() => {
    setShowInstallerModal(false);
    handleClose();
  }, [handleClose]);

  if (!isOpen) return null;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        size="md"
        showCloseButton={!isCreating}
        closeOnEscape={!isCreating}
        closeOnOverlayClick={!isCreating}
        title={
          <span className="flex items-center gap-3">
            <span className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <Server className="w-6 h-6 text-gray-700 dark:text-gray-300" />
            </span>
            <span>Yeni Edge Controller Kaydet</span>
          </span>
        }
        description="Industrial IoT kontrol cihazınızı sisteme ekleyin"
        bodyClassName="p-6 space-y-5"
        footer={
          <div className="flex w-full items-center justify-between">
            <Button variant="secondary" onClick={handleClose}>
              İptal
            </Button>
            <Button variant="primary" size="lg" onClick={handleSubmit} disabled={isCreating}>
              {isCreating ? (
                <>
                  <Spinner size="sm" color="inherit" />
                  Oluşturuluyor...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4" />
                  Cihaz Oluştur
                </>
              )}
            </Button>
          </div>
        }
      >
        {error && (
          <div className="flex items-center gap-2 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {/* Info Box */}
        <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
          <p className="text-sm text-info-800 dark:text-info-200">
            Cihaz oluşturulduktan sonra size bir kurulum komutu verilecek. Bu komutu Linux
            cihazınızda çalıştırarak otomatik kurulum yapabilirsiniz.
          </p>
        </div>

        {/* Device Model */}
        <Select
          label="Cihaz Modeli"
          value={formData.deviceModel}
          onChange={handleInputChange('deviceModel')}
          placeholder="Model seçin (opsiyonel)..."
          options={DEVICE_MODELS.map((model) => ({ value: model.value, label: model.label }))}
        />

        {/* Device Name & Serial Number */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Cihaz Adı
            </label>
            <Input
              fullWidth
              type="text"
              value={formData.deviceName}
              onChange={handleInputChange('deviceName')}
              placeholder="Bodrum RAS Controller"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Opsiyonel - otomatik oluşturulur
            </p>
          </div>
          <Input
            label="Seri Numarasi"
            fullWidth
            type="text"
            value={formData.serialNumber}
            onChange={handleInputChange('serialNumber')}
            placeholder="123456789"
          />
        </div>

        {/* Description */}
        <Textarea
          label="Açıklama (Opsiyonel)"
          className="resize-none"
          fullWidth
          value={formData.description}
          onChange={handleInputChange('description')}
          placeholder="Ana RAS sistemini kontrol eden edge controller..."
          rows={2}
        />
      </Modal>

      {/* Installer Command Modal */}
      <InstallerCommandModal
        isOpen={showInstallerModal}
        onClose={handleInstallerModalClose}
        provisioningData={provisioningResult}
      />
    </>
  );
}

export default EdgeDeviceWizard;
