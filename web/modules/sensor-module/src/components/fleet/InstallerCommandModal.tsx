/**
 * Installer Command Modal
 *
 * Displays the installer command after a device is created via provisioning.
 * Allows copying the command to clipboard for easy installation.
 */

import React, { useState, useCallback } from 'react';
import {
  X,
  Copy,
  Check,
  Terminal,
  Clock,
  AlertCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import {
  ProvisionedDeviceResponse,
  RegenerateTokenResponse,
  useRegenerateDeviceToken,
} from '../../hooks/useEdgeDevices';

interface InstallerCommandModalProps {
  isOpen: boolean;
  onClose: () => void;
  provisioningData: ProvisionedDeviceResponse | RegenerateTokenResponse | null;
}

export function InstallerCommandModal({
  isOpen,
  onClose,
  provisioningData,
}: InstallerCommandModalProps) {
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const { mutate: regenerateToken, isPending: isRegenerating } = useRegenerateDeviceToken();

  const handleCopyCommand = useCallback(async () => {
    if (!provisioningData?.installerCommand) return;

    try {
      await navigator.clipboard.writeText(provisioningData.installerCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [provisioningData?.installerCommand]);

  const handleCopyUrl = useCallback(async () => {
    if (!provisioningData?.installerUrl) return;

    try {
      await navigator.clipboard.writeText(provisioningData.installerUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [provisioningData?.installerUrl]);

  const formatExpiryTime = useCallback((expiresAt: string) => {
    const expiry = new Date(expiresAt);
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffMs <= 0) {
      return 'Token expired';
    }

    if (diffHours >= 1) {
      return `${diffHours} saat ${diffMinutes} dakika`;
    }
    return `${diffMinutes} dakika`;
  }, []);

  const isTokenExpired = useCallback(() => {
    if (!provisioningData?.tokenExpiresAt) return false;
    return new Date(provisioningData.tokenExpiresAt) <= new Date();
  }, [provisioningData?.tokenExpiresAt]);

  if (!isOpen || !provisioningData) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-green-600 to-green-700">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-lg">
                <Terminal className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">
                  Cihaz Basariyla Olusturuldu!
                </h2>
                <p className="text-sm text-green-100">
                  Asagidaki komutu Linux cihazinizda calistirin
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-white/80 hover:text-white focus:outline-none p-1 rounded-lg hover:bg-white/10 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            {/* Device Info */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Cihaz Kodu:</span>
                  <span className="ml-2 font-mono font-semibold text-gray-900">
                    {provisioningData.deviceCode}
                  </span>
                </div>
                <div className="flex items-center">
                  <Clock className="w-4 h-4 text-gray-400 mr-1" />
                  <span className="text-gray-500">Token suresi:</span>
                  <span
                    className={`ml-2 font-medium ${
                      isTokenExpired() ? 'text-red-600' : 'text-green-600'
                    }`}
                  >
                    {formatExpiryTime(provisioningData.tokenExpiresAt)}
                  </span>
                </div>
              </div>
            </div>

            {/* Token Expired Warning */}
            {isTokenExpired() && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span className="text-sm">
                  Token suresi dolmus. Yeniden olusturmak icin asagidaki dugmeyi
                  kullanin.
                </span>
              </div>
            )}

            {/* Installer Command */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Kurulum Komutu
              </label>
              <div className="relative">
                <div className="bg-gray-900 rounded-lg p-4 pr-12 font-mono text-sm text-green-400 overflow-x-auto">
                  <code>{provisioningData.installerCommand}</code>
                </div>
                <button
                  onClick={handleCopyCommand}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-white transition-colors"
                  title="Kopyala"
                >
                  {copied ? (
                    <Check className="w-5 h-5 text-green-400" />
                  ) : (
                    <Copy className="w-5 h-5" />
                  )}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Bu komutu Linux terminalinizde root olarak calistirin (sudo ile)
              </p>
            </div>

            {/* Installer URL */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Installer URL (Alternatif)
              </label>
              <div className="relative">
                <div className="bg-gray-100 rounded-lg p-3 pr-12 font-mono text-xs text-gray-600 overflow-x-auto break-all">
                  {provisioningData.installerUrl}
                </div>
                <button
                  onClick={handleCopyUrl}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-gray-600 transition-colors"
                  title="Kopyala"
                >
                  {copiedUrl ? (
                    <Check className="w-5 h-5 text-green-500" />
                  ) : (
                    <Copy className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            {/* Steps */}
            <div className="bg-blue-50 rounded-lg p-4">
              <h3 className="font-medium text-blue-900 mb-3">Kurulum Adimlari</h3>
              <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                <li>Linux cihaziniza SSH ile baglanin</li>
                <li>Yukaridaki komutu kopyalayip terminale yapistiirin</li>
                <li>Kurulum otomatik olarak tamamlanacaktir</li>
                <li>Cihaz, bu sayfada "Online" olarak gorunecektir</li>
              </ol>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-t border-gray-200">
            <button
              onClick={() => {
                regenerateToken(provisioningData.deviceId);
              }}
              disabled={isRegenerating}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500 disabled:opacity-50 transition-colors"
            >
              {isRegenerating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Token Yenile
            </button>
            <button
              onClick={onClose}
              className="px-5 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 transition-colors"
            >
              Tamam
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default InstallerCommandModal;
