/**
 * Installer Command Modal
 *
 * Displays the installer command after a device is created via provisioning.
 * Allows copying the command to clipboard for easy installation.
 */

import React, { useState, useCallback } from 'react';
import { Modal, Spinner, Button } from '@aquaculture/shared-ui';
import { Copy, Check, Terminal, Clock, AlertCircle, RefreshCw } from 'lucide-react';
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

// SEC-005: mask the token portion of the installer command so it isn't visible over the shoulder
function maskInstallerCommand(cmd: string): string {
  // Mask --token <TOKEN> or --bootstrap-token <TOKEN> flag format
  let masked = cmd.replace(
    /(--(?:bootstrap-)?token\s+)(\S+)/gi,
    (_, prefix, token) =>
      `${prefix}${token.slice(0, 4)}${'*'.repeat(Math.max(8, token.length - 4))}`,
  );
  // Mask ?token=<TOKEN> URL query parameter format
  masked = masked.replace(
    /(\?token=)([^"&\s]+)/gi,
    (_, prefix, token) =>
      `${prefix}${token.slice(0, 4)}${'*'.repeat(Math.max(8, token.length - 4))}`,
  );
  return masked;
}

export function InstallerCommandModal({
  isOpen,
  onClose,
  provisioningData,
}: InstallerCommandModalProps) {
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [revealed, setRevealed] = useState(false);

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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      bodyClassName=""
      title={
        <span className="flex items-center gap-3">
          <span className="p-2 bg-success-100 dark:bg-success-900/40 rounded-lg">
            <Terminal className="w-6 h-6 text-success-700 dark:text-success-300" />
          </span>
          Cihaz Başarıyla Oluşturuldu!
        </span>
      }
      description="Aşağıdaki komutu Linux cihazınızda çalıştırın"
    >
      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Device Info */}
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Cihaz Kodu:</span>
              <span className="ml-2 font-mono font-semibold text-gray-900 dark:text-gray-100">
                {provisioningData.deviceCode}
              </span>
            </div>
            <div className="flex items-center">
              <Clock className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-1" />
              <span className="text-gray-500 dark:text-gray-400">Token süresi:</span>
              <span
                className={`ml-2 font-medium ${
                  isTokenExpired()
                    ? 'text-error-600 dark:text-error-400'
                    : 'text-success-600 dark:text-success-400'
                }`}
              >
                {formatExpiryTime(provisioningData.tokenExpiresAt)}
              </span>
            </div>
          </div>
        </div>

        {/* Token Expired Warning */}
        {isTokenExpired() && (
          <div className="flex items-center gap-2 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="text-sm">
              Token süresi dolmuş. Yeniden oluşturmak için aşağıdaki düğmeyi kullanın.
            </span>
          </div>
        )}

        {/* Installer Command — SEC-005: token masked by default with reveal toggle */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Kurulum Komutu
            </label>
            <Button variant="ghost" size="xs" onClick={() => setRevealed((r) => !r)}>
              {revealed ? 'Gizle' : "Token'ı Göster"}
            </Button>
          </div>
          <div className="relative">
            <div className="bg-gray-900 rounded-lg p-4 pr-12 font-mono text-sm text-success-400 overflow-x-auto">
              <code>
                {revealed
                  ? provisioningData.installerCommand
                  : maskInstallerCommand(provisioningData.installerCommand)}
              </code>
            </div>
            <Button
              variant="ghost"
              className="absolute right-2 top-1/2"
              onClick={handleCopyCommand}
              title="Kopyala"
            >
              {copied ? (
                <Check className="w-5 h-5 text-success-400" />
              ) : (
                <Copy className="w-5 h-5" />
              )}
            </Button>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Bu komutu Linux terminalinizde root olarak çalıştırın (sudo ile)
          </p>
        </div>

        {/* Installer URL */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Installer URL (Alternatif)
          </label>
          <div className="relative">
            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3 pr-12 font-mono text-xs text-gray-600 dark:text-gray-400 overflow-x-auto break-all">
              {provisioningData.installerUrl}
            </div>
            <Button
              variant="ghost"
              className="absolute right-2 top-1/2"
              onClick={handleCopyUrl}
              title="Kopyala"
            >
              {copiedUrl ? (
                <Check className="w-5 h-5 text-success-500" />
              ) : (
                <Copy className="w-5 h-5" />
              )}
            </Button>
          </div>
        </div>

        {/* Steps */}
        <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-4">
          <h3 className="font-medium text-info-900 dark:text-info-100 mb-3">Kurulum Adımları</h3>
          <ol className="list-decimal list-inside space-y-2 text-sm text-info-800 dark:text-info-200">
            <li>Linux cihazınıza SSH ile bağlanın</li>
            <li>Yukarıdaki komutu kopyalayıp terminale yapıştırın</li>
            <li>Kurulum otomatik olarak tamamlanacaktır</li>
            <li>Cihaz, bu sayfada "Online" olarak görünecektir</li>
          </ol>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
        <Button
          variant="secondary"
          onClick={() => {
            regenerateToken(provisioningData.deviceId);
          }}
          disabled={isRegenerating}
        >
          {isRegenerating ? (
            <Spinner size="sm" color="inherit" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Token Yenile
        </Button>
        <Button variant="primary" size="lg" onClick={onClose}>
          Tamam
        </Button>
      </div>
    </Modal>
  );
}

export default InstallerCommandModal;
