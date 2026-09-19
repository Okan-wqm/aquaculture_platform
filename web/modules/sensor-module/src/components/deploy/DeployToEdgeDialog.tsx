/**
 * Deploy To Edge Dialog
 *
 * Canonical device-picker + deploy dialog for every deployable artifact
 * (process diagram, SCADA package). The artifact is described via props and
 * the deploy action is injected, so each caller binds its own mutation —
 * one dialog, one UX, N artifact types.
 */

import React, { useState, useEffect } from 'react';
import { Modal, Spinner } from '@aquaculture/shared-ui';
import { Monitor, Wifi, WifiOff, Upload, CheckCircle, AlertCircle } from 'lucide-react';
import { useEdgeDevices, EdgeDevice, formatLastSeen } from '../../hooks/useEdgeDevices';

export type DeployAccent = 'cyan' | 'purple';

// Tailwind needs full class literals — no string interpolation.
const ACCENT_CLASSES: Record<
  DeployAccent,
  {
    icon: string;
    checkbox: string;
    radio: string;
    rowSelected: string;
    buttonDisabled: string;
    buttonEnabled: string;
  }
> = {
  cyan: {
    icon: 'text-cyan-600',
    checkbox: 'rounded text-cyan-600 focus:ring-cyan-500',
    radio: 'text-cyan-600 focus:ring-cyan-500',
    rowSelected: 'bg-cyan-50 cursor-pointer',
    buttonDisabled: 'bg-cyan-400 cursor-not-allowed',
    buttonEnabled: 'bg-cyan-600 hover:bg-cyan-700',
  },
  purple: {
    icon: 'text-purple-600',
    checkbox: 'rounded text-purple-600 focus:ring-purple-500',
    radio: 'text-purple-600 focus:ring-purple-500',
    rowSelected: 'bg-purple-50 cursor-pointer',
    buttonDisabled: 'bg-purple-400 cursor-not-allowed',
    buttonEnabled: 'bg-purple-600 hover:bg-purple-700',
  },
};

export interface DeployToEdgeDialogProps {
  /** Dialog title, e.g. "Deploy SCADA Package" */
  title: string;
  /** Artifact kind label shown above the name, e.g. "Proses" / "SCADA Package" */
  artifactLabel: string;
  /** Human-readable artifact name */
  artifactName: string;
  /** Accent colour keyed to the calling surface (process = cyan, SCADA = purple) */
  accent?: DeployAccent;
  /** Optional artifact-specific preview block (stats grid, size summary, …) */
  preview?: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  /** Deploy the artifact to the chosen device; the caller binds its own mutation. */
  onDeploy: (deviceId: string) => Promise<{ success: boolean; message?: string }>;
}

export const DeployToEdgeDialog: React.FC<DeployToEdgeDialogProps> = ({
  title,
  artifactLabel,
  artifactName,
  accent = 'cyan',
  preview,
  isOpen,
  onClose,
  onDeploy,
}) => {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [showOnlineOnly, setShowOnlineOnly] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: deviceConnection, isLoading, isError, error } = useEdgeDevices({ limit: 100 });
  const classes = ACCENT_CLASSES[accent];

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedDeviceId(null);
      setDeploySuccess(false);
      setIsDeploying(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const devices = deviceConnection?.items || [];
  const filteredDevices = showOnlineOnly ? devices.filter((d) => d.isOnline) : devices;

  const handleDeploy = async (): Promise<void> => {
    if (!selectedDeviceId || isDeploying) return;

    setIsDeploying(true);
    setErrorMessage(null);
    try {
      const result = await onDeploy(selectedDeviceId);
      if (result.success) {
        setDeploySuccess(true);
        setTimeout(() => {
          onClose();
        }, 2000);
      } else {
        setErrorMessage(result.message || 'Deploy error');
      }
    } catch (deployError) {
      setErrorMessage(deployError instanceof Error ? deployError.message : 'Deploy error');
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      className="max-h-[85vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 flex flex-col"
      title={
        <span className="flex items-center gap-2">
          <Monitor className={`w-5 h-5 ${classes.icon}`} />
          {title}
        </span>
      }
    >

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Artifact info */}
          <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">{artifactLabel}</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">{artifactName}</p>
          </div>

          {/* Artifact-specific preview */}
          {preview}

          {/* Deploy result */}
          {deploySuccess && (
            <div className="p-3 rounded-lg flex items-center gap-2 bg-green-50 text-green-700 border border-green-200">
              <CheckCircle className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm font-medium">Deploy started successfully!</span>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 rounded-lg flex items-center gap-2 bg-red-50 text-red-700 border border-red-200">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">{errorMessage}</span>
            </div>
          )}

          {/* Online filter */}
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Select Edge Device</label>
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showOnlineOnly}
                onChange={(e) => setShowOnlineOnly(e.target.checked)}
                className={classes.checkbox}
              />
              Online only
            </label>
          </div>

          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Spinner size="md" color="inherit" className={classes.icon} />
              <span className="ml-2 text-gray-500 dark:text-gray-400">Loading devices...</span>
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm">
              {(error as Error)?.message || 'Could not load devices'}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !isError && filteredDevices.length === 0 && (
            <div className="p-4 bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-lg text-sm text-center">
              {showOnlineOnly
                ? 'No online edge devices found.'
                : 'No edge devices registered yet.'}
            </div>
          )}

          {/* Device list */}
          {!isLoading && !isError && filteredDevices.length > 0 && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700 max-h-72 overflow-y-auto">
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
                          ? classes.rowSelected
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer'
                    }`}
                  >
                    <input
                      type="radio"
                      name="edgeDevice"
                      checked={isSelected}
                      onChange={() => !isDisabled && setSelectedDeviceId(device.id)}
                      disabled={isDisabled}
                      className={classes.radio}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {device.deviceName}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">{device.deviceCode}</span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        Last seen: {formatLastSeen(device.lastSeenAt)}
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
                          <WifiOff className="w-4 h-4 text-gray-500 dark:text-gray-400" />
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
        <div className="flex gap-3 p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-b-xl">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 font-medium transition-colors"
          >
            {deploySuccess ? 'Close' : 'Cancel'}
          </button>
          {!deploySuccess && (
            <button
              onClick={handleDeploy}
              disabled={!selectedDeviceId || isDeploying}
              className={`flex-1 px-4 py-2.5 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
                !selectedDeviceId || isDeploying ? classes.buttonDisabled : classes.buttonEnabled
              }`}
            >
              {isDeploying ? (
                <>
                  <Spinner size="sm" color="inherit" />
                  Deploying...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Deploy
                </>
              )}
            </button>
          )}
        </div>
    </Modal>
  );
};

export default DeployToEdgeDialog;
