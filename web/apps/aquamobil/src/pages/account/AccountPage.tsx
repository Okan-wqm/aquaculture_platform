/**
 * AccountPage — the v4 Account screen.
 *
 * WHAT CHANGED: the page was a grey ground carrying a grey-gradient profile
 * banner with an SVG wave, then three "Preferences / Data & Sync / Security"
 * cards of hand-rolled rows. The banner is gone — it spent the top third of the
 * screen on an identity the worker already knows, above the two things they
 * actually come here for (is my work synced, and make the controls bigger).
 *
 * The v4 grouping puts those first: a sync card carrying the pending count, the
 * connection state, then Display (theme + touch targets), then the device data
 * rows, then who is signed in and the way out. Identity is now a row near the
 * bottom rather than a banner at the top.
 *
 * The theme and density controls themselves are unchanged — they already drive
 * `data-theme` / `data-density` (src/hooks/useTheme.ts, useDensity.ts); only
 * their surroundings were restyled, and the hand-rolled segment strips were
 * swapped for <SegmentedControl>, which brings the 44px touch floor and a
 * group label the hand-rolled version did not have.
 */
import {
  Moon,
  Sun,
  Palette,
  Hand,
  Bell,
  Database,
  Trash2,
  HardDrive,
  Fingerprint,
  LogOut,
  Shield,
  Wifi,
  WifiOff,
  X,
  Monitor,
} from 'lucide-react';
import type { JSX } from 'react';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import {
  Button,
  Card,
  Chip,
  IconButton,
  ListRow,
  SegmentedControl,
  StatusDot,
  type SegmentedOption,
} from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useDensity } from '@/hooks/useDensity';
import type { Density } from '@/hooks/useDensity';
import { useNotifications } from '@/hooks/useNotifications';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTheme } from '@/hooks/useTheme';
import type { ThemePreference } from '@/hooks/useTheme';
import { useWebAuthn, storeBiometricEmail } from '@/hooks/useWebAuthn';
import { clearCache, clearAllOperations } from '@/pwa/offline-queue';
import type { Role } from '@/types';
import { runAsyncAction } from '@/utils/async-action';
import { getLastSyncAt } from '@/utils/last-sync';

// ============================================================================
// Constants
// ============================================================================

// MOB-LOW-011: the last-sync stamp lives in the shared util (single SSoT —
// useOfflineQueue.syncNow records it at the drain convergence point).

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
//
// WHY the `type-*` tokens rather than the semantic ramp: a role badge is
// CATEGORICAL colour, the same job the per-log-type hues do — four values that
// must be told apart at a glance, none of which is an alarm, a watch or a
// success. Reaching for `crit` because the old badge was red would say
// "something is wrong with this account". These four keep the previous hue
// relationships (coral / blue / purple / green) and, unlike the raw palette they
// replace, resolve correctly in all three themes.
const ROLE_BADGE_CONFIG: Record<Role, { bg: string; text: string; label: string }> = {
  SUPER_ADMIN: {
    bg: 'bg-type-mortality-dim',
    text: 'text-type-mortality',
    label: 'Super Admin',
  },
  TENANT_ADMIN: { bg: 'bg-type-water-dim', text: 'text-type-water', label: 'Tenant Admin' },
  MODULE_MANAGER: {
    bg: 'bg-type-transfer-dim',
    text: 'text-type-transfer',
    label: 'Manager',
  },
  MODULE_USER: { bg: 'bg-type-harvest-dim', text: 'text-type-harvest', label: 'Operator' },
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

// ============================================================================
// Confirmation Dialog Sub-component
// ============================================================================

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
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
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
      />
      {/* Dialog */}
      <Card className="relative max-w-sm w-full p-6">
        <h3 className="text-head font-semibold text-ink-1 mb-2">{title}</h3>
        <p className="text-body text-ink-2 mb-6">{message}</p>
        {/* MT-MEDIUM-050: a failed device wipe is shown here so the user is never
            told the logout succeeded while plaintext-recoverable data remains. */}
        {errorMessage && (
          <p className="text-body text-crit mb-4" role="alert">
            {errorMessage}
          </p>
        )}
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          {/* Both callers of this dialog are destructive (log out wipes the
              device, clearing the queue deletes unsynced work), so the confirm
              is the coral `danger` button rather than a colour passed in. */}
          <Button
            variant="danger"
            className="flex-1"
            // WHY void-wrap: onConfirm may be async (logout awaits a device
            // wipe). The DOM onClick handler must return void, not a Promise —
            // the caller owns the rejection (MT-MEDIUM-050 surfaces it).
            onClick={() => {
              void onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ============================================================================
// Section Header + count badge
// ============================================================================

function SectionHeader({ title }: { title: string }): JSX.Element {
  return <h2 className="text-body font-semibold text-ink-3 px-1">{title}</h2>;
}

/**
 * The pending / unread counter carried by a row.
 *
 * WHY amber rather than the coral it used to be: unsent work and unread
 * notifications are things to WATCH, not alarms. Coral is spent on alarms only,
 * and a permanently-coral badge on this screen would train the eye to ignore it.
 */
function CountBadge({ count }: { count: number }): JSX.Element {
  return (
    <span className="text-meta font-semibold tabular-nums px-2 py-0.5 rounded-full bg-warn-dim text-warn">
      {count > 99 ? '99+' : count}
    </span>
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
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield size={18} className="text-acc" aria-hidden />
          <h3 className="text-title font-semibold text-ink-1">Biometric Authentication</h3>
        </div>
        <IconButton
          aria-label="Close biometric setup"
          onClick={() => {
            onClose();
            clearBiometricError();
            setSetupSuccess(false);
          }}
          className="bg-surface-2 rounded-xl"
        >
          <X size={18} className="text-ink-2" />
        </IconButton>
      </div>

      <p className="text-body text-ink-2 mb-4">
        Use Face ID, Touch ID, or fingerprint to sign in quickly without entering your password.
      </p>

      {/* Error message */}
      {biometricError && (
        <div className="mb-4 p-3 bg-crit-dim border border-crit rounded-xl text-body text-crit">
          {biometricError}
        </div>
      )}

      {/* Success message — green confirms. There is no `ok-dim` token, so the
          confirmation sits on the recessed surface and carries the green in its
          text, the way the "All clear" badge does. */}
      {setupSuccess && (
        <div className="mb-4 p-3 bg-surface-2 border border-line rounded-xl text-body text-ok">
          Biometric login enabled successfully! You can now use biometric authentication on the
          login screen.
        </div>
      )}

      {/* Registered credentials */}
      {credentials.length > 0 && (
        <div className="mb-4">
          <h4 className="text-meta font-semibold text-ink-3 mb-2">Registered Devices</h4>
          <div className="space-y-2">
            {credentials.map((cred) => (
              <div
                key={cred.credentialId}
                className="flex items-center justify-between gap-3 p-3 bg-surface-2 rounded-xl"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Fingerprint size={18} className="text-ok shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-body font-medium text-ink-1 truncate">{cred.deviceName}</p>
                    <p className="text-meta text-ink-3">
                      Last used: {new Date(cred.lastUsedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                {/* Removing an enrolled device is destructive, hence coral. It
                    was a ~32px target; IconButton bakes the 44px floor in. */}
                <IconButton
                  aria-label={`Remove ${cred.deviceName}`}
                  title="Remove credential"
                  onClick={() => {
                    void handleRemove(cred.credentialId);
                  }}
                  className="text-crit shrink-0"
                >
                  <Trash2 size={16} />
                </IconButton>
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
          // The focus ring is owned by the global `input:focus` rule in
          // src/styles/main.css, which paints it with the accent token.
          className="w-full px-4 py-2.5 rounded-xl border border-line bg-surface-2 text-ink-1 placeholder:text-ink-3 text-body outline-none transition-all"
        />
        <Button
          variant="primary"
          block
          onClick={() => {
            void handleEnable();
          }}
          disabled={isRegistering}
        >
          {isRegistering ? (
            <>
              <span className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
              Setting up...
            </>
          ) : (
            <>
              <Fingerprint size={18} />
              {credentials.length > 0 ? 'Add Another Device' : 'Enable Biometric Login'}
            </>
          )}
        </Button>
      </div>
    </Card>
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
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const { density, setDensity } = useDensity();

  // UI state for confirmation dialogs and expandable panels
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [showClearQueueDialog, setShowClearQueueDialog] = useState(false);
  const [showBiometricPanel, setShowBiometricPanel] = useState(false);
  const [storageMb, setStorageMb] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState(() => formatRelativeTime(getLastSyncAt()));

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
      setLastSyncLabel(formatRelativeTime(getLastSyncAt()));
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // After a sync completes, persist the current timestamp and update label
  const handleSyncNow = useCallback(async () => {
    const result = await syncNow();
    if (result.success > 0) {
      // syncNow already recorded the shared last-sync stamp (MOB-LOW-011).
      setLastSyncLabel(formatRelativeTime(getLastSyncAt()));
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

  // v4 ships three themes, so the control is four-way with System.
  // Night = dark hall / night shift, Day = deck glare, Colour = colour-coded.
  const themeOptions: ReadonlyArray<SegmentedOption<ThemePreference>> = [
    { value: 'night', icon: <Moon size={14} aria-hidden />, label: 'Night' },
    { value: 'day', icon: <Sun size={14} aria-hidden />, label: 'Day' },
    { value: 'colour', icon: <Palette size={14} aria-hidden />, label: 'Colour' },
    { value: 'system', icon: <Monitor size={14} aria-hidden />, label: 'System' },
  ];

  // Gloved operation enlarges every control at once (src/hooks/useDensity.ts).
  const densityOptions: ReadonlyArray<SegmentedOption<Density>> = [
    { value: 'standard', icon: <Hand size={14} aria-hidden />, label: 'Standard' },
    { value: 'glove', icon: <Hand size={14} aria-hidden />, label: 'Gloves' },
  ];

  const connectionTone = isSyncing ? 'accent' : isOnline ? 'ok' : 'warn';
  const connectionLabel = isSyncing ? 'Syncing...' : isOnline ? 'Online' : 'Offline';

  return (
    <div className="pb-32">
      <AppHeader title="Account" showAvatar={false} />

      <div className="px-4 flex flex-col gap-5">
        {/* ================================================================
            SYNC — the first question this screen answers: is my work safe?
            ================================================================ */}
        <section className="flex flex-col gap-2">
          <SectionHeader title="Sync" />

          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-display font-mono font-semibold text-ink-1 tabular-nums">
                  {pendingCount}
                </div>
                <div className="text-meta text-ink-3">
                  {pendingCount === 1 ? 'entry waiting to sync' : 'entries waiting to sync'}
                </div>
              </div>
              <Chip tone={connectionTone}>
                <StatusDot tone={connectionTone} live={isSyncing} />
                {connectionLabel}
              </Chip>
            </div>
            <Button variant="primary" block onClick={() => navigate('/sync')}>
              Sync Status
            </Button>
            <p className="text-meta text-ink-3">Last synced: {lastSyncLabel}</p>
          </Card>

          {/* Connection — the same fact the chip carries, said in words, because
              "Offline" is the explanation for a queue that is not draining. */}
          <ListRow
            leading={isOnline ? <Wifi size={18} /> : <WifiOff size={18} />}
            tone={connectionTone}
            title="Connection"
            subtitle={
              isOnline
                ? 'Entries send as you log them'
                : 'Entries queue on this device until signal returns'
            }
            trailing={connectionLabel}
          />
        </section>

        {/* ================================================================
            DISPLAY — theme and touch density
            ================================================================ */}
        <section className="flex flex-col gap-2">
          <SectionHeader title="Display" />

          {/* Theme — four-way control (Night / Day / Colour / System).
              WHY the control sits on its own row rather than inline with the
              label: four options with labels overflow a 360px phone. */}
          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-acc-dim">
                <Moon size={20} className="text-acc" aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-title font-medium text-ink-1 block">Theme</span>
                <span className="text-meta text-ink-3">Night hall, deck glare, colour-coded</span>
              </div>
            </div>
            <SegmentedControl
              label="Theme"
              options={themeOptions}
              value={themePreference}
              onChange={setThemePreference}
            />
          </Card>

          {/* Touch targets — gloved operation enlarges every control at once. */}
          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-acc-dim">
                <Hand size={20} className="text-acc" aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-title font-medium text-ink-1 block">Touch targets</span>
                <span className="text-meta text-ink-3">
                  Gloves enlarges every control you press
                </span>
              </div>
            </div>
            <SegmentedControl
              label="Touch targets"
              options={densityOptions}
              value={density}
              onChange={setDensity}
            />
          </Card>
        </section>

        {/* ================================================================
            DATA & NOTIFICATIONS
            ================================================================ */}
        <section className="flex flex-col gap-2">
          <SectionHeader title="Data & Notifications" />

          <ListRow
            leading={<Bell size={18} />}
            tone="accent"
            title="Notifications"
            trailing={unreadCount > 0 ? <CountBadge count={unreadCount} /> : undefined}
            onClick={() => navigate('/notifications')}
          />

          {/* Clear Cache — safe operation, only removes data cache (not the offline queue) */}
          <ListRow
            leading={<Database size={18} />}
            tone="accent"
            title="Clear Cache"
            subtitle="Remove cached data to free space"
            onClick={() => {
              void handleClearCache();
            }}
          />

          {/* Clear Queue — destructive, permanently deletes unsynced operations.
              The label turns coral only when there is something to lose. */}
          <ListRow
            leading={<Trash2 size={18} />}
            tone="crit"
            title={
              pendingCount > 0 ? (
                <span className="text-crit">Clear Offline Queue</span>
              ) : (
                'Clear Offline Queue'
              )
            }
            subtitle={
              pendingCount > 0
                ? `${pendingCount} unsynced operation${pendingCount !== 1 ? 's' : ''}`
                : 'No pending operations'
            }
            trailing={pendingCount > 0 ? <CountBadge count={pendingCount} /> : undefined}
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
          <ListRow
            leading={<HardDrive size={18} />}
            tone="neutral"
            title="Storage"
            trailing={storageMb != null ? `${storageMb} MB used` : 'Estimating...'}
          />
        </section>

        {/* ================================================================
            SECURITY
            ================================================================ */}
        {biometricSupported && (
          <section className="flex flex-col gap-2">
            <SectionHeader title="Security" />

            <ListRow
              leading={<Fingerprint size={18} />}
              tone={hasCredentials ? 'ok' : 'accent'}
              title="Biometric Login"
              subtitle={hasCredentials ? 'Enabled' : 'Set up'}
              onClick={() => setShowBiometricPanel(!showBiometricPanel)}
            />

            {/* Biometric Setup Panel — expands directly under the row that opens
                it, rather than below the whole section as it used to. */}
            {showBiometricPanel && <BiometricPanel onClose={() => setShowBiometricPanel(false)} />}
          </section>
        )}

        {/* ================================================================
            ACCOUNT — who is signed in, and the way out
            ================================================================ */}
        <section className="flex flex-col gap-2">
          <SectionHeader title="Account" />

          <Card className="p-4 flex items-center gap-4">
            {/* Avatar — the accent fill AppHeader's avatar wears, so the same
                person reads the same on both. */}
            <span
              aria-hidden
              className="w-14 h-14 shrink-0 rounded-2xl bg-acc text-acc-on inline-flex items-center justify-center text-head font-mono font-semibold"
            >
              {initials}
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-title font-semibold text-ink-1 truncate">{userName}</h3>
              <p className="text-body text-ink-3 truncate">{userEmail}</p>
              <div className="flex items-center gap-2 mt-1.5">
                {/* Role badge — colour-coded pill */}
                <span
                  className={`text-meta font-semibold px-2 py-0.5 rounded-full ${roleBadge.bg} ${roleBadge.text}`}
                >
                  {roleBadge.label}
                </span>
                {userTenantId && (
                  <span className="text-meta text-ink-3 truncate">Tenant: {userTenantId}</span>
                )}
              </div>
            </div>
          </Card>

          {/* Log Out — destructive action, requires confirmation */}
          <ListRow
            leading={<LogOut size={18} />}
            tone="crit"
            title={<span className="text-crit">Log Out</span>}
            onClick={() => setShowLogoutDialog(true)}
          />
        </section>

        {/* App version — the machine value, so it is set in mono. */}
        <p className="text-meta text-ink-3 text-center">App Version: {APP_VERSION}</p>
      </div>

      {/* ================================================================
          Confirmation Dialogs
          ================================================================ */}

      {/* Logout confirmation */}
      {showLogoutDialog && (
        <ConfirmDialog
          title="Log Out"
          message="Are you sure you want to log out?"
          confirmLabel="Log Out"
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
