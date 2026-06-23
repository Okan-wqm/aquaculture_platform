import { Cloud, Bell, LogOut, MoreHorizontal, ChevronRight, Fingerprint, Shield, Trash2, X } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/hooks/useAuth';
import { useNotifications } from '@/hooks/useNotifications';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useWebAuthn, storeBiometricEmail } from '@/hooks/useWebAuthn';

interface MenuItem {
  id: string;
  icon: typeof Cloud;
  label: string;
  path?: string;
  action?: () => void;
  iconColor: string;
  iconBg: string;
  badge?: number;
  subtitle?: string;
}

export function MorePage(): JSX.Element {
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const { pendingCount } = useOfflineQueue();
  const { unreadCount } = useNotifications();
  const {
    isSupported: biometricSupported,
    isRegistering,
    credentials,
    hasCredentials,
    error: biometricError,
    clearError: clearBiometricError,
    registerCredential,
    removeCredential,
  } = useWebAuthn();

  const [showBiometricPanel, setShowBiometricPanel] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [setupSuccess, setSetupSuccess] = useState(false);

  const handleEnableBiometric = async (): Promise<void> => {
    clearBiometricError();
    setSetupSuccess(false);
    const name = deviceName.trim() || undefined;
    const success = await registerCredential(name);
    if (success) {
      setSetupSuccess(true);
      setDeviceName('');
      // Store email for biometric login lookup
      if (user?.email) {
        storeBiometricEmail(user.email);
      }
    }
  };

  const handleRemoveCredential = async (credentialId: string): Promise<void> => {
    clearBiometricError();
    await removeCredential(credentialId);
  };

  const menuItems: MenuItem[] = [
    {
      id: 'sync',
      icon: Cloud,
      label: 'Synchronization',
      path: '/sync',
      iconColor: 'text-ocean-600',
      iconBg: 'bg-ocean-50 dark:bg-ocean-900/30',
      badge: pendingCount,
    },
    {
      id: 'notifications',
      icon: Bell,
      label: 'Notifications',
      path: '/notifications',
      iconColor: 'text-amber-600',
      iconBg: 'bg-amber-50 dark:bg-amber-900/30',
      badge: unreadCount,
    },
    // Only show biometric option if browser supports WebAuthn
    ...(biometricSupported
      ? [
          {
            id: 'biometric',
            icon: Fingerprint,
            label: 'Biometric Login',
            action: () => setShowBiometricPanel(!showBiometricPanel),
            iconColor: 'text-emerald-600',
            iconBg: 'bg-emerald-50 dark:bg-emerald-900/30',
            subtitle: hasCredentials ? 'Enabled' : 'Set up',
          },
        ]
      : []),
    {
      id: 'logout',
      icon: LogOut,
      label: 'Log Out',
      // WHY void-wrap: logout() returns a Promise but MenuItem.action expects a
      // void-returning handler. Fire-and-forget the logout; the auth provider
      // owns the teardown/redirect and any error surfacing.
      action: () => { void logout(); },
      iconColor: 'text-red-600',
      iconBg: 'bg-red-50 dark:bg-red-900/30',
    },
  ];

  const handlePress = (item: MenuItem): void => {
    if (item.action) {
      item.action();
    } else if (item.path) {
      navigate(item.path);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <MoreHorizontal size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">More</h1>
          </div>
        </div>
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Menu list */}
      <div className="px-5 pt-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800">
          {menuItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => handlePress(item)}
                className={`w-full flex items-center gap-4 p-4 touch-feedback transition-all text-left ${
                  index < menuItems.length - 1 ? 'border-b border-gray-50 dark:border-gray-800' : ''
                }`}
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.iconBg}`}>
                  <Icon size={20} className={item.iconColor} />
                </div>
                <div className="flex-1">
                  <span className="font-medium text-gray-900 dark:text-white">{item.label}</span>
                  {item.subtitle && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{item.subtitle}</p>
                  )}
                </div>
                {item.badge != null && item.badge > 0 && (
                  <span className="bg-red-500 text-white text-[11px] font-bold rounded-full min-w-[22px] h-[22px] flex items-center justify-center px-1.5">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
                {item.path && (
                  <ChevronRight size={18} className="text-gray-300 dark:text-gray-600" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Biometric Setup Panel */}
      {showBiometricPanel && biometricSupported && (
        <div className="px-5 pt-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800 p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Shield size={18} className="text-emerald-600" />
                <h3 className="font-semibold text-gray-900 dark:text-white">Biometric Authentication</h3>
              </div>
              <button
                onClick={() => {
                  setShowBiometricPanel(false);
                  clearBiometricError();
                  setSetupSuccess(false);
                }}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Use Face ID, Touch ID, or fingerprint to sign in quickly without entering your password.
            </p>

            {/* Error message */}
            {biometricError && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-300">
                {biometricError}
              </div>
            )}

            {/* Success message */}
            {setupSuccess && (
              <div className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl text-sm text-emerald-600 dark:text-emerald-300">
                Biometric login enabled successfully! You can now use biometric authentication on the login screen.
              </div>
            )}

            {/* Registered credentials */}
            {credentials.length > 0 && (
              <div className="mb-4">
                <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                  Registered Devices
                </h4>
                <div className="space-y-2">
                  {credentials.map((cred) => (
                    <div
                      key={cred.credentialId}
                      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-xl"
                    >
                      <div className="flex items-center gap-3">
                        <Fingerprint size={18} className="text-emerald-600" />
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {cred.deviceName}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Last used: {new Date(cred.lastUsedAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => { void handleRemoveCredential(cred.credentialId); }}
                        className="p-2 text-red-400 hover:text-red-600 transition-colors"
                        title="Remove credential"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add new credential */}
            <div className="space-y-3">
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Device name (e.g., My iPhone)"
                maxLength={100}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder:text-gray-400 text-sm"
              />
              <button
                onClick={() => { void handleEnableBiometric(); }}
                disabled={isRegistering}
                className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl shadow-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
              >
                {isRegistering ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    Setting up...
                  </>
                ) : (
                  <>
                    <Fingerprint size={18} />
                    {credentials.length > 0 ? 'Add Another Device' : 'Enable Biometric Login'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
