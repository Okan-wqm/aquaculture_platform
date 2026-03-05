/**
 * Deploy SCADA Dialog
 * Deploys a SCADA package to an edge device.
 * Based on the DeployToEdgeDialog pattern.
 */

import React, { useState, useEffect } from 'react';
import {
  Monitor,
  Wifi,
  WifiOff,
  Upload,
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  Package,
} from 'lucide-react';
import { useEdgeDevices, EdgeDevice, formatLastSeen } from '../../hooks/useEdgeDevices';
import { useDeployScadaPackage, ScadaPackageData } from '../../hooks/useScadaPackage';

interface DeployScadaDialogProps {
  packageId: string;
  packageName: string;
  packageData: ScadaPackageData;
  isOpen: boolean;
  onClose: () => void;
}

export const DeployScadaDialog: React.FC<DeployScadaDialogProps> = ({
  packageId,
  packageName,
  packageData,
  isOpen,
  onClose,
}) => {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [showOnlineOnly, setShowOnlineOnly] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);

  const { data: deviceConnection, isLoading, isError, error } = useEdgeDevices({ limit: 100 });
  const deployMutation = useDeployScadaPackage();

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedDeviceId(null);
      setDeploySuccess(false);
      deployMutation.reset();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const devices = deviceConnection?.items || [];
  const filteredDevices = showOnlineOnly ? devices.filter((d) => d.isOnline) : devices;

  // Deploy preview stats
  const screenCount = packageData.screens?.length || 0;
  const widgetCount = packageData.screens?.reduce((sum, s) => sum + (s.widgets?.length || 0), 0) || 0;
  const alarmCount = packageData.alarmRules?.length || 0;
  const jsonSize = new Blob([JSON.stringify(packageData)]).size;
  const jsonSizeStr = jsonSize < 1024
    ? `${jsonSize} B`
    : jsonSize < 1024 * 1024
      ? `${(jsonSize / 1024).toFixed(1)} KB`
      : `${(jsonSize / (1024 * 1024)).toFixed(1)} MB`;

  const handleDeploy = async () => {
    if (!selectedDeviceId) return;

    try {
      const result = await deployMutation.mutateAsync({ packageId, deviceId: selectedDeviceId });
      if (result.success) {
        setDeploySuccess(true);
        setTimeout(() => {
          onClose();
        }, 2000);
      }
    } catch {
      // Error handled by mutation state
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Monitor className="w-5 h-5 text-purple-600" />
            SCADA Paketi Deploy Et
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            title="Kapat"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Package info */}
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
            <p className="text-sm text-gray-500">SCADA Paketi</p>
            <p className="font-medium text-gray-900">{packageName}</p>
          </div>

          {/* Deploy preview */}
          <div className="grid grid-cols-4 gap-2">
            <div className="p-2 bg-purple-50 rounded-lg text-center border border-purple-100">
              <p className="text-lg font-bold text-purple-700">{screenCount}</p>
              <p className="text-xs text-purple-600">Ekran</p>
            </div>
            <div className="p-2 bg-blue-50 rounded-lg text-center border border-blue-100">
              <p className="text-lg font-bold text-blue-700">{widgetCount}</p>
              <p className="text-xs text-blue-600">Widget</p>
            </div>
            <div className="p-2 bg-orange-50 rounded-lg text-center border border-orange-100">
              <p className="text-lg font-bold text-orange-700">{alarmCount}</p>
              <p className="text-xs text-orange-600">Alarm</p>
            </div>
            <div className="p-2 bg-gray-50 rounded-lg text-center border border-gray-200">
              <p className="text-lg font-bold text-gray-700">{jsonSizeStr}</p>
              <p className="text-xs text-gray-500">Boyut</p>
            </div>
          </div>

          {/* Deploy result */}
          {deploySuccess && (
            <div className="p-3 rounded-lg flex items-center gap-2 bg-green-50 text-green-700 border border-green-200">
              <CheckCircle className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm font-medium">Deploy basariyla baslatildi!</span>
            </div>
          )}

          {deployMutation.isError && (
            <div className="p-3 rounded-lg flex items-center gap-2 bg-red-50 text-red-700 border border-red-200">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">{(deployMutation.error as Error)?.message || 'Deploy hatasi'}</span>
            </div>
          )}

          {/* Online filter */}
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">
              Edge Device Sec
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showOnlineOnly}
                onChange={(e) => setShowOnlineOnly(e.target.checked)}
                className="rounded text-purple-600 focus:ring-purple-500"
              />
              Sadece online
            </label>
          </div>

          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 text-purple-600 animate-spin" />
              <span className="ml-2 text-gray-500">Cihazlar yukleniyor...</span>
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm">
              {(error as Error)?.message || 'Cihazlar yuklenemedi'}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !isError && filteredDevices.length === 0 && (
            <div className="p-4 bg-gray-50 text-gray-500 rounded-lg text-sm text-center">
              {showOnlineOnly
                ? 'Online edge device bulunamadi.'
                : 'Henuz edge device kaydedilmemis.'}
            </div>
          )}

          {/* Device list */}
          {!isLoading && !isError && filteredDevices.length > 0 && (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 max-h-72 overflow-y-auto">
              {filteredDevices.map((device: EdgeDevice) => {
                const isOnline = device.isOnline;
                const isDisabled = !isOnline;
                const isSelected = selectedDeviceId === device.id;

                return (
                  <label
                    key={device.id}
                    className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                      isDisabled
                        ? 'opacity-50 cursor-not-allowed'
                        : isSelected
                          ? 'bg-purple-50 cursor-pointer'
                          : 'hover:bg-gray-50 cursor-pointer'
                    }`}
                  >
                    <input
                      type="radio"
                      name="edgeDevice"
                      checked={isSelected}
                      onChange={() => !isDisabled && setSelectedDeviceId(device.id)}
                      disabled={isDisabled}
                      className="text-purple-600 focus:ring-purple-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {device.deviceName}
                        </span>
                        <span className="text-xs text-gray-400">
                          {device.deviceCode}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Son gorulme: {formatLastSeen(device.lastSeenAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isOnline ? (
                        <>
                          <span className="w-2 h-2 rounded-full bg-green-500" />
                          <Wifi className="w-4 h-4 text-green-600" />
                        </>
                      ) : (
                        <>
                          <span className="w-2 h-2 rounded-full bg-gray-400" />
                          <WifiOff className="w-4 h-4 text-gray-400" />
                        </>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors"
          >
            {deploySuccess ? 'Kapat' : 'Iptal'}
          </button>
          {!deploySuccess && (
            <button
              onClick={handleDeploy}
              disabled={!selectedDeviceId || deployMutation.isPending}
              className={`flex-1 px-4 py-2.5 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
                !selectedDeviceId || deployMutation.isPending
                  ? 'bg-purple-400 cursor-not-allowed'
                  : 'bg-purple-600 hover:bg-purple-700'
              }`}
            >
              {deployMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Deploy ediliyor...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Deploy Et
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeployScadaDialog;
