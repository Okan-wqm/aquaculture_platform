/**
 * Edge Device Registration Wizard
 *
 * Modal wizard for registering new edge controllers (Revolution Pi, Industrial PC, etc.)
 * Uses zero-touch provisioning - creates device and shows installer command.
 */

import React, { useState, useCallback } from 'react';
import { X, Server, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
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
  const [provisioningResult, setProvisioningResult] = useState<ProvisionedDeviceResponse | null>(null);
  const [showInstallerModal, setShowInstallerModal] = useState(false);

  const { mutate: createDevice, isPending: isCreating } = useCreateProvisionedDevice();

  const handleInputChange = useCallback(
    (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setFormData((prev) => ({ ...prev, [field]: value }));
      setError(null);
    },
    []
  );

  const validateForm = useCallback((): boolean => {
    // Device name is optional but if provided should be meaningful
    if (formData.deviceName && formData.deviceName.length < 2) {
      setError('Cihaz adi en az 2 karakter olmalidir');
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
        setError(err instanceof Error ? err.message : 'Cihaz olusturulamadi. Lutfen tekrar deneyin.');
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
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50 transition-opacity" onClick={handleClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-700 to-gray-900">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-lg">
                <Server className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Yeni Edge Controller Kaydet</h2>
                <p className="text-sm text-gray-300">Industrial IoT kontrol cihazınızı sisteme ekleyin</p>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="text-white/80 hover:text-white focus:outline-none p-1 rounded-lg hover:bg-white/10 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-5">
            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            )}

            {/* Info Box */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                Cihaz olusturulduktan sonra size bir kurulum komutu verilecek.
                Bu komutu Linux cihazinizda calistirarak otomatik kurulum yapabilirsiniz.
              </p>
            </div>

            {/* Device Model */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cihaz Modeli
              </label>
              <select
                value={formData.deviceModel}
                onChange={handleInputChange('deviceModel')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 bg-white"
              >
                <option value="">Model secin (opsiyonel)...</option>
                {DEVICE_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Device Name & Serial Number */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cihaz Adi
                </label>
                <input
                  type="text"
                  value={formData.deviceName}
                  onChange={handleInputChange('deviceName')}
                  placeholder="Bodrum RAS Controller"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
                <p className="mt-1 text-xs text-gray-500">Opsiyonel - otomatik olusturulur</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Seri Numarasi</label>
                <input
                  type="text"
                  value={formData.serialNumber}
                  onChange={handleInputChange('serialNumber')}
                  placeholder="123456789"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Aciklama (Opsiyonel)</label>
              <textarea
                value={formData.description}
                onChange={handleInputChange('description')}
                placeholder="Ana RAS sistemini kontrol eden edge controller..."
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 resize-none"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-t border-gray-200">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500 transition-colors"
            >
              Iptal
            </button>
            <button
              onClick={handleSubmit}
              disabled={isCreating}
              className="flex items-center gap-2 px-5 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Olusturuluyor...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4" />
                  Cihaz Olustur
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Installer Command Modal */}
      <InstallerCommandModal
        isOpen={showInstallerModal}
        onClose={handleInstallerModalClose}
        provisioningData={provisioningResult}
      />
    </div>
  );
}

export default EdgeDeviceWizard;
