import {
  Moon,
  Sun,
  Bell,
  Cloud,
  Database,
  Trash2,
  HardDrive,
  Fingerprint,
  LogOut,
  ChevronRight,
  Shield,
  X,
  Monitor,
} from 'lucide-react';
import type { JSX } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/hooks/useAuth';
import { useDarkMode } from '@/hooks/useDarkMode';
import type { DarkModePreference } from '@/hooks/useDarkMode';
import { useNotifications } from '@/hooks/useNotifications';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useWebAuthn, storeBiometricEmail } from '@/hooks/useWebAuthn';
import { clearCache, clearAllOperations } from '@/pwa/offline-queue';
import type { Role } from '@/types';
import { runAsyncAction } from '@/utils/async-action';

// ============================================================================
// Constants
// ============================================================================

/** localStorage key for the last successful sync timestamp */
const LAST_SYNC_KEY = 'aquamobil_last_sync_at';

/** App version sourced from build-time env variable */
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '1.0.0';

// Role badge configuration — maps each auth role to a color scheme so workers
// and admins can quickly identify their privilege level at a glance.
//
// FE-MEDIUM-051: keyed by the codegen'd backend `Role` enum, so the config keys
// are EXACTLY the four canonical roles. A `Record<Role, ...>` makes adding or
// renaming a backend role a compile-time exhaustiveness error here (tier-3
// detectable) — the old MANAGER/OPERATOR/VIEWER entries were phantom values the
// server never emits and have been removed.
const ROLE_BADGE_CONFIG: Record<Role, { bg: string; text: string; label: string }> = {
  SUPER_ADMIN: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', label: 'Super Admin' },
  TENANT_ADMIN: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', label: 'Tenant Admin' },
  MODULE_MANAGER: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300', label: 'Manager' },
  MODULE_USER: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', label: 'Operator' },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract user initials from their display name for the avatar circle.
 * Takes the first letter of the first and last words so "John Doe" => "JD"
 * and a single-word name like "Admin" => "A".
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0).toUpperCase() ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0).toUpperCase() ?? '') : '';
  return first + last;
}

/**
 * Format a timestamp into a human-readable relative string like "5 min ago".
 * Falls back to "Never" when no timestamp is stored.
 */
function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return 'Never';

  const diffMs = Date.now() - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

/**
 * Retrieve the last sync timestamp from localStorage.
 */
function getLastSyncTime(): string | null {
  try {
    return localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

// ============================================================================
// Confirmation Dialog Sub-component
// ============================================================================

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor?: string;
  // MT-MEDIUM-050: onConfirm may be async (the logout path awaits a device wipe);
  // a rejection is surfaced to the caller, which sets `errorMessage` below.
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Error surfaced inside the dialog when a confirm action fails. */
  errorMessage?: string | null;
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmColor = 'bg-red-600',
  onConfirm,
  onCancel,
  errorMessage,
}: ConfirmDialogProps): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      {/* Backdrop — click (or keyboard activation) dismisses the dialog. A real
          <button> is keyboard-operable (Enter/Space) and focusable for free. */}
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{message}</p>
        {/* MT-MEDIUM-050: a failed device wipe is shown here so the user is never
            told the logout succeeded while plaintext-recoverable data remains. */}
        {errorMessage && (
          <p className="text-sm text-red-600 dark:text-red-400 mb-4" role="alert">
            {errorMessage}
          </p>
        )}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            // WHY void-wrap: onConfirm may be async (logout awaits a device
            // wipe). The DOM onClick handler must return void, not a Promise —
            // the caller owns the rejection (MT-MEDIUM-050 surfaces it).
            onClick={() => {
              void onConfirm();
            }}
            className={`flex-1 py-2.5 rounded-xl ${confirmColor} text-white font-medium text-sm transition-colors`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Section Menu Item Sub-component
// ============================================================================

interface MenuRowProps {
  icon: typeof Cloud;
  iconColor: string;
  iconBg: string;
  label: string;
  subtitle?: string;
  badge?: number;
  showChevron?: boolean;
  destructive?: boolean;
  rightContent?: React.ReactNode;
  onClick?: () => void;
  isLast?: boolean;
}

function MenuRow({
  icon: Icon,
  iconColor,
  iconBg,
  label,
  subtitle,
  badge,
  showChevron = true,
  destructive = false,
  rightContent,
  onClick,
  isLast = false,
}: MenuRowProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-4 p-4 touch-feedback transition-all text-left ${
        !isLast ? 'border-b border-gray-50 dark:border-gray-800' : ''
      }`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconBg}`}>
        <Icon size={20} className={iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <span
          className={`font-medium ${
            destructive ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
          }`}
        >
          {label}
        </span>
        {subtitle && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{subtitle}</p>
        )}
      </div>
      {badge != null && badge > 0 && (
        <span className="bg-red-500 text-white text-[11px] font-bold rounded-full min-w-[22px] h-[22px] flex items-center justify-center px-1.5">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {rightContent}
      {showChevron && !rightContent && (
        <ChevronRight size={18} className="text-gray-300 dark:text-gray-600 flex-shrink-0" />
      )}
    </button>
  );
}

// ============================================================================
// Section Header Sub-component
// ============================================================================

function SectionHeader({ title }: { title: string }): JSX.Element {
  return (
    <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-5 mb-2">
      {title}
    </h2>
  );
}

// ============================================================================
// Biometric Panel (reused from MorePage logic with identical UI)
// ============================================================================

interface BiometricPanelProps {
  onClose: () => void;
}

function BiometricPanel({ onClose }: BiometricPanelProps): JSX.Element {
  const { user } = useAuth();
  const {
    isRegistering,
    credentials,
    error: biometricError,
    clearError: clearBiometricError,
    registerCredential,
    removeCredential,
  } = useWebAuthn();

  const [deviceName, setDeviceName] = useState('');
  const [setupSuccess, setSetupSuccess] = useState(false);

  const handleEnable = async (): Promise<void> => {
    clearBiometricError();
    setSetupSuccess(false);
    const name = deviceName.trim() || undefined;
    const success = await registerCredential(name);
    if (success) {
      setSetupSuccess(true);
      setDeviceName('');
      // Persist email for biometric login lookup on the login screen
      if (user?.email) {
        storeBiometricEmail(user.email);
      }
    }
  };

  const handleRemove = async (credentialId: string): Promise<void> => {
    clearBiometricError();
    await removeCredential(credentialId);
  };

  return (
    <div className="px-5 pt-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800 p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-emerald-600" />
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Biometric Authentication
            </h3>
          </div>
          <button
            onClick={() => {
              onClose();
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
            Biometric login enabled successfully! You can now use biometric authentication on the
            login screen.
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
                    onClick={() => { void handleRemove(cred.credentialId); }}
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
            onClick={() => { void handleEnable(); }}
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
  );
}

// ============================================================================
// AccountPage — Main Export
// ============================================================================

export function AccountPage(): JSX.Element {
  const navigate = useNavigate();
  const { user, tenantId: authTenantId, logout } = useAuth();
  const { pendingCount, isOnline, isSyncing, syncNow } = useOfflineQueue();
  const { unreadCount } = useNotifications();
  const { isSupported: biometricSupported, hasCredentials } = useWebAuthn();
  const { preference: themePreference, setPreference: setThemePreference } = useDarkMode();

  // UI state for confirmation dialogs and expandable panels
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [showClearQueueDialog, setShowClearQueueDialog] = useState(false);
  const [showBiometricPanel, setShowBiometricPanel] = useState(false);
  const [storageMb, setStorageMb] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState(() => formatRelativeTime(getLastSyncTime()));

  // Estimate storage usage via the Storage API — only available in secure
  // contexts (HTTPS / localhost). Display as "X.X MB" for operator awareness.
  useEffect(() => {
    if (navigator.storage?.estimate) {
      navigator.storage
        .estimate()
        .then((estimate) => {
          if (estimate.usage != null) {
            const mb = (estimate.usage / (1024 * 1024)).toFixed(1);
            setStorageMb(mb);
          }
        })
        .catch(() => {
          // Storage API unavailable — non-critical
        });
    }
  }, []);

  // Refresh the "last synced" label every 30 seconds so it stays up to date
  useEffect(() => {
    const timer = setInterval(() => {
      setLastSyncLabel(formatRelativeTime(getLastSyncTime()));
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // After a sync completes, persist the current timestamp and update label
  const handleSyncNow = useCallback(async () => {
    const result = await syncNow();
    if (result.success > 0) {
      try {
        localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      } catch {
        // non-critical
      }
      setLastSyncLabel(formatRelativeTime(new Date().toISOString()));
    }
  }, [syncNow]);

  // Suppress unused variable warning — handleSyncNow is wired to the Sync Status row
  // via navigate('/sync') currently, but kept as a utility for future inline-sync button.
  void handleSyncNow;

  const handleClearCache = useCallback(async () => {
    await clearCache();
    // Re-estimate storage after clearing
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      if (estimate.usage != null) {
        setStorageMb((estimate.usage / (1024 * 1024)).toFixed(1));
      }
    }
  }, []);

  const [clearQueueError, setClearQueueError] = useState<string | null>(null);
  const handleClearQueue = useCallback(async () => {
    setClearQueueError(null);
    try {
      // SECURITY (C11): Clear only the current tenant's queue, not other tenants' ops
      await clearAllOperations(authTenantId ?? undefined);
      setShowClearQueueDialog(false);
      // The OfflineProvider will refresh the pending count on next tick
    } catch (err) {
      setClearQueueError(
        err instanceof Error
          ? `Queue could not be cleared: ${err.message}. Please retry.`
          : 'Queue could not be cleared. Please retry.',
      );
    }
  }, [authTenantId]);

  // MT-MEDIUM-050: logout() AWAITS the full on-device wipe and REJECTS if it
  // fails. A failed wipe must NOT present as a clean logout, so on rejection we
  // keep the confirmation dialog open and surface the error instead of
  // navigating away as if the device were clean. The session is only torn down
  // once the wipe has provably completed.
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const handleLogout = useCallback(async () => {
    setLogoutError(null);
    try {
      await logout();
      setShowLogoutDialog(false);
    } catch (err) {
      setLogoutError(
        err instanceof Error
          ? `Logout could not complete: ${err.message}. Your data was not fully cleared — please retry.`
          : 'Logout could not complete — your data was not fully cleared. Please retry.',
      );
    }
  }, [logout]);

  // Derive user display values
  const userName = user?.name ?? 'User';
  const userEmail = user?.email ?? '';
  // FE-MEDIUM-051: fall back to the least-privileged canonical role (MODULE_USER)
  // when no user is loaded — the old 'VIEWER' default was a phantom value.
  const userRole: Role = user?.role ?? 'MODULE_USER';
  const userTenantId = user?.tenantId;
  const initials = getInitials(userName);
  const roleBadge = ROLE_BADGE_CONFIG[userRole];

  // Three-way theme options for the segmented control
  const themeOptions: Array<{ value: DarkModePreference; icon: typeof Sun; label: string }> = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* ================================================================
          Profile Header — gradient banner with avatar, name, and role
          ================================================================ */}
      <div className="bg-gradient-to-br from-gray-800 via-gray-700 to-gray-600 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-4 py-5">
            {/* Avatar circle with ocean gradient and user initials */}
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-ocean-400 to-ocean-600 flex items-center justify-center text-xl font-bold text-white shadow-lg flex-shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-bold tracking-tight truncate">{userName}</h1>
              <p className="text-sm text-gray-300 truncate">{userEmail}</p>
              <div className="flex items-center gap-2 mt-1.5">
                {/* Role badge — color-coded pill */}
                <span
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${roleBadge.bg} ${roleBadge.text}`}
                >
                  {roleBadge.label}
                </span>
                {userTenantId && (
                  <span className="text-[11px] text-gray-400">Tenant: {userTenantId}</span>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* Curved wave transition matching other page headers */}
        <div className="relative">
          <svg
            viewBox="0 0 400 20"
            fill="none"
            className="w-full block"
            preserveAspectRatio="none"
          >
            <path
              d="M0 20V0c100 15 200 15 400 0v20z"
              className="fill-gray-50 dark:fill-gray-950"
            />
          </svg>
        </div>
      </div>

      {/* ================================================================
          PREFERENCES Section
          ================================================================ */}
      <div className="pt-4">
        <SectionHeader title="Preferences" />
        <div className="px-5">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800">
            {/* Dark Mode — three-way segmented control */}
            <div className="flex items-center gap-4 p-4 border-b border-gray-50 dark:border-gray-800">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-indigo-50 dark:bg-indigo-900/30">
                <Moon size={20} className="text-indigo-600" />
              </div>
              <span className="font-medium text-gray-900 dark:text-white flex-1">Dark Mode</span>
              {/* Segmented control — compact to fit mobile widths */}
              <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                {themeOptions.map((opt) => {
                  const OptIcon = opt.icon;
                  const isActive = themePreference === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setThemePreference(opt.value)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                        isActive
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      <OptIcon size={14} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Notifications — navigates to the notifications page */}
            <MenuRow
              icon={Bell}
              iconColor="text-amber-600"
              iconBg="bg-amber-50 dark:bg-amber-900/30"
              label="Notifications"
              badge={unreadCount}
              onClick={() => navigate('/notifications')}
              isLast
            />
          </div>
        </div>
      </div>

      {/* ================================================================
          DATA & SYNC Section
          ================================================================ */}
      <div className="pt-6">
        <SectionHeader title="Data & Sync" />
        <div className="px-5">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800">
            {/* Sync Status */}
            <MenuRow
              icon={Cloud}
              iconColor="text-ocean-600"
              iconBg="bg-ocean-50 dark:bg-ocean-900/30"
              label="Sync Status"
              subtitle={
                isSyncing
                  ? 'Syncing...'
                  : isOnline
                    ? `Online${pendingCount > 0 ? ` - ${pendingCount} pending` : ''}`
                    : 'Offline'
              }
              badge={pendingCount}
              onClick={() => navigate('/sync')}
            />

            {/* Clear Cache — safe operation, only removes data cache (not the offline queue) */}
            <MenuRow
              icon={Database}
              iconColor="text-sky-600"
              iconBg="bg-sky-50 dark:bg-sky-900/30"
              label="Clear Cache"
              subtitle="Remove cached data to free space"
              onClick={() => { void handleClearCache(); }}
            />

            {/* Clear Queue — destructive, permanently deletes unsynced operations */}
            <MenuRow
              icon={Trash2}
              iconColor="text-orange-600"
              iconBg="bg-orange-50 dark:bg-orange-900/30"
              label="Clear Offline Queue"
              subtitle={
                pendingCount > 0
                  ? `${pendingCount} unsynced operation${pendingCount !== 1 ? 's' : ''}`
                  : 'No pending operations'
              }
              badge={pendingCount}
              destructive={pendingCount > 0}
              onClick={() => {
                if (pendingCount > 0) {
                  setClearQueueError(null);
                  setShowClearQueueDialog(true);
                } else {
                  // No pending operations — nothing to clear, no confirmation needed
                  runAsyncAction(handleClearQueue, 'account-clear-empty-queue');
                }
              }}
            />

            {/* Storage usage — read-only info row */}
            <div className="flex items-center gap-4 p-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gray-50 dark:bg-gray-800">
                <HardDrive size={20} className="text-gray-600 dark:text-gray-400" />
              </div>
              <span className="font-medium text-gray-900 dark:text-white flex-1">Storage</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {storageMb != null ? `${storageMb} MB used` : 'Estimating...'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================
          SECURITY Section
          ================================================================ */}
      <div className="pt-6">
        <SectionHeader title="Security" />
        <div className="px-5">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800">
            {/* Biometric — only shown when the device supports WebAuthn */}
            {biometricSupported && (
              <MenuRow
                icon={Fingerprint}
                iconColor="text-emerald-600"
                iconBg="bg-emerald-50 dark:bg-emerald-900/30"
                label="Biometric Login"
                subtitle={hasCredentials ? 'Enabled' : 'Set up'}
                onClick={() => setShowBiometricPanel(!showBiometricPanel)}
              />
            )}

            {/* Log Out — destructive action, requires confirmation */}
            <MenuRow
              icon={LogOut}
              iconColor="text-red-600"
              iconBg="bg-red-50 dark:bg-red-900/30"
              label="Log Out"
              destructive
              onClick={() => setShowLogoutDialog(true)}
              isLast
            />
          </div>
        </div>
      </div>

      {/* Biometric Setup Panel — expanded below the security section */}
      {showBiometricPanel && biometricSupported && (
        <BiometricPanel onClose={() => setShowBiometricPanel(false)} />
      )}

      {/* ================================================================
          Footer — app version and last sync time
          ================================================================ */}
      <div className="px-5 pt-6 pb-2 flex flex-col items-center gap-1">
        <p className="text-xs text-gray-400 dark:text-gray-500">App Version: {APP_VERSION}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">Last synced: {lastSyncLabel}</p>
      </div>

      {/* Bottom spacer for the fixed tab bar */}
      <div className="h-24" />

      {/* ================================================================
          Confirmation Dialogs
          ================================================================ */}

      {/* Logout confirmation */}
      {showLogoutDialog && (
        <ConfirmDialog
          title="Log Out"
          message="Are you sure you want to log out?"
          confirmLabel="Log Out"
          confirmColor="bg-red-600"
          onConfirm={handleLogout}
          onCancel={() => {
            setLogoutError(null);
            setShowLogoutDialog(false);
          }}
          errorMessage={logoutError}
        />
      )}

      {/* Clear queue confirmation — surfaces the pending count so the user
          understands the data loss before committing */}
      {showClearQueueDialog && (
        <ConfirmDialog
          title="Clear Offline Queue"
          message={`You have ${pendingCount} unsynced operation${pendingCount !== 1 ? 's' : ''}. Clearing will permanently delete them.`}
          confirmLabel="Clear Queue"
          confirmColor="bg-red-600"
          onConfirm={handleClearQueue}
          onCancel={() => {
            setClearQueueError(null);
            setShowClearQueueDialog(false);
          }}
          errorMessage={clearQueueError}
        />
      )}
    </div>
  );
}
