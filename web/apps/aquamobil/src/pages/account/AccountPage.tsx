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
import { useI18n, type I18nContextValue } from '@aquaculture/shared-ui/i18n';
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
  ConfirmSheet,
  IconButton,
  Input,
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
 * Format a timestamp into a human-readable relative string like "5 min ago",
 * in the reader's language. Falls back to "Never" when no timestamp is stored.
 */
function formatRelativeTime(isoString: string | null, t: I18nContextValue['t']): string {
  if (!isoString) return t('m.account.relative.never');
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return t('m.account.relative.never');

  const diffMs = Date.now() - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return t('m.account.relative.justNow');
  if (diffMin < 60) return t('m.account.relative.minutes', { n: diffMin });
  if (diffHour < 24) return t('m.account.relative.hours', { n: diffHour });
  return t('m.account.relative.days', { n: diffDay });
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
  const { t } = useI18n();
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
  const [currentPassword, setCurrentPassword] = useState('');
  const [setupSuccess, setSetupSuccess] = useState(false);

  const handleEnable = async (): Promise<void> => {
    clearBiometricError();
    setSetupSuccess(false);
    if (!currentPassword) {
      // SEC-CRITICAL-002: registration is gated on password re-authentication
      // server-side; block the ceremony client-side too so the user never
      // reaches a guaranteed-rejected submit.
      return;
    }
    const name = deviceName.trim() || undefined;
    const success = await registerCredential(name, currentPassword);
    if (success) {
      setSetupSuccess(true);
      setDeviceName('');
      setCurrentPassword('');
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
          <h3 className="text-title font-semibold text-ink-1">{t('m.account.biometric.title')}</h3>
        </div>
        <IconButton
          aria-label={t('m.account.biometric.close')}
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

      <p className="text-body text-ink-2 mb-4">{t('m.account.biometric.intro')}</p>

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
          {t('m.account.biometric.enabled')}
        </div>
      )}

      {/* Registered credentials */}
      {credentials.length > 0 && (
        <div className="mb-4">
          <h4 className="text-meta font-semibold text-ink-3 mb-2">
            {t('m.account.biometric.devices')}
          </h4>
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
                      {t('m.account.biometric.lastUsed', {
                        date: new Date(cred.lastUsedAt).toLocaleDateString(),
                      })}
                    </p>
                  </div>
                </div>
                {/* Removing an enrolled device is destructive, hence coral. It
                    was a ~32px target; IconButton bakes the 44px floor in. */}
                <IconButton
                  aria-label={t('m.account.biometric.remove', { device: cred.deviceName })}
                  title={t('m.account.biometric.removeTitle')}
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

      {/* Add new credential. The password re-confirms the account before a new
          authenticator is bound to it — a borrowed, unlocked phone must not be
          able to enrol its owner's biometrics. */}
      <div className="space-y-3">
        <Input
          label={t('m.account.biometric.deviceName')}
          hideLabel
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder={t('m.account.biometric.deviceNamePlaceholder')}
          maxLength={100}
        />
        <Input
          label={t('m.account.biometric.currentPassword')}
          hideLabel
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder={t('m.account.biometric.currentPasswordPlaceholder')}
          maxLength={128}
          autoComplete="current-password"
        />
        <Button
          variant="primary"
          block
          onClick={() => {
            void handleEnable();
          }}
          disabled={!currentPassword}
          loading={isRegistering}
        >
          {isRegistering ? (
            t('m.account.biometric.settingUp')
          ) : (
            <>
              <Fingerprint size={18} />
              {credentials.length > 0
                ? t('m.account.biometric.addAnother')
                : t('m.account.biometric.enable')}
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
  const { t } = useI18n();
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
  // The stamp is state; the label is derived at render so it follows the
  // language. The tick re-renders the relative label while the stamp is unchanged.
  const [lastSyncAt, setLastSyncAt] = useState(() => getLastSyncAt());
  const [, setLabelTick] = useState(0);
  const lastSyncLabel = formatRelativeTime(lastSyncAt, t);

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
      setLastSyncAt(getLastSyncAt());
      setLabelTick((tick) => tick + 1);
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // After a sync completes, persist the current timestamp and update label
  const handleSyncNow = useCallback(async () => {
    const result = await syncNow();
    if (result.success > 0) {
      // syncNow already recorded the shared last-sync stamp (MOB-LOW-011).
      setLastSyncAt(getLastSyncAt());
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
    { value: 'night', icon: <Moon size={14} aria-hidden />, label: t('m.account.theme.night') },
    { value: 'day', icon: <Sun size={14} aria-hidden />, label: t('m.account.theme.day') },
    {
      value: 'colour',
      icon: <Palette size={14} aria-hidden />,
      label: t('m.account.theme.colour'),
    },
    {
      value: 'system',
      icon: <Monitor size={14} aria-hidden />,
      label: t('m.account.theme.system'),
    },
  ];

  // Gloved operation enlarges every control at once (src/hooks/useDensity.ts).
  const densityOptions: ReadonlyArray<SegmentedOption<Density>> = [
    {
      value: 'standard',
      icon: <Hand size={14} aria-hidden />,
      label: t('m.account.touch.standard'),
    },
    { value: 'glove', icon: <Hand size={14} aria-hidden />, label: t('m.account.touch.gloves') },
  ];

  const connectionTone = isSyncing ? 'accent' : isOnline ? 'ok' : 'warn';
  const connectionLabel = isSyncing
    ? t('m.account.state.syncing')
    : isOnline
      ? t('m.account.state.online')
      : t('m.account.state.offline');

  return (
    <div>
      <AppHeader title={t('m.account.title')} showAvatar={false} />

      <div className="px-4 flex flex-col gap-5">
        {/* ================================================================
            SYNC — the first question this screen answers: is my work safe?
            ================================================================ */}
        <section className="flex flex-col gap-2">
          <SectionHeader title={t('m.account.sync')} />

          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-display font-mono font-semibold text-ink-1 tabular-nums">
                  {pendingCount}
                </div>
                <div className="text-meta text-ink-3">
                  {pendingCount === 1 ? t('m.account.waiting.one') : t('m.account.waiting.other')}
                </div>
              </div>
              <Chip tone={connectionTone}>
                <StatusDot tone={connectionTone} live={isSyncing} />
                {connectionLabel}
              </Chip>
            </div>
            <Button variant="primary" block onClick={() => navigate('/sync')}>
              {t('m.account.syncStatus')}
            </Button>
            <p className="text-meta text-ink-3">
              {t('m.account.lastSynced', { when: lastSyncLabel })}
            </p>
          </Card>

          {/* Connection — the same fact the chip carries, said in words, because
              "Offline" is the explanation for a queue that is not draining. */}
          <ListRow
            leading={isOnline ? <Wifi size={18} /> : <WifiOff size={18} />}
            tone={connectionTone}
            title={t('m.account.connection')}
            subtitle={isOnline ? t('m.account.connectionOnline') : t('m.account.connectionOffline')}
            trailing={connectionLabel}
          />
        </section>

        {/* ================================================================
            DISPLAY — theme and touch density
            ================================================================ */}
        <section className="flex flex-col gap-2">
          <SectionHeader title={t('m.account.display')} />

          {/* Theme — four-way control (Night / Day / Colour / System).
              WHY the control sits on its own row rather than inline with the
              label: four options with labels overflow a 360px phone. */}
          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-acc-dim">
                <Moon size={20} className="text-acc" aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-title font-medium text-ink-1 block">
                  {t('m.account.theme')}
                </span>
                <span className="text-meta text-ink-3">{t('m.account.themeHint')}</span>
              </div>
            </div>
            <SegmentedControl
              label={t('m.account.theme')}
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
                <span className="text-title font-medium text-ink-1 block">
                  {t('m.account.touch')}
                </span>
                <span className="text-meta text-ink-3">{t('m.account.touchHint')}</span>
              </div>
            </div>
            <SegmentedControl
              label={t('m.account.touch')}
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
          <SectionHeader title={t('m.account.dataNotifications')} />

          <ListRow
            leading={<Bell size={18} />}
            tone="accent"
            title={t('m.account.notifications')}
            trailing={unreadCount > 0 ? <CountBadge count={unreadCount} /> : undefined}
            onClick={() => navigate('/notifications')}
          />

          {/* Clear Cache — safe operation, only removes data cache (not the offline queue) */}
          <ListRow
            leading={<Database size={18} />}
            tone="accent"
            title={t('m.account.clearCache')}
            subtitle={t('m.account.clearCacheHint')}
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
                <span className="text-crit">{t('m.account.clearQueue')}</span>
              ) : (
                t('m.account.clearQueue')
              )
            }
            subtitle={
              pendingCount > 0
                ? pendingCount === 1
                  ? t('m.account.unsynced.one')
                  : t('m.account.unsynced.other', { count: pendingCount })
                : t('m.account.noPending')
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
            title={t('m.account.storage')}
            trailing={
              storageMb != null
                ? t('m.account.storageUsed', { mb: storageMb })
                : t('m.account.estimating')
            }
          />
        </section>

        {/* ================================================================
            SECURITY
            ================================================================ */}
        {biometricSupported && (
          <section className="flex flex-col gap-2">
            <SectionHeader title={t('m.account.security')} />

            <ListRow
              leading={<Fingerprint size={18} />}
              tone={hasCredentials ? 'ok' : 'accent'}
              title={t('m.account.biometricLogin')}
              subtitle={
                hasCredentials ? t('m.account.biometricEnabled') : t('m.account.biometricSetUp')
              }
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
          <SectionHeader title={t('m.account.title')} />

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
                  <span className="text-meta text-ink-3 truncate">
                    {t('m.account.tenant', { id: userTenantId })}
                  </span>
                )}
              </div>
            </div>
          </Card>

          {/* Log Out — destructive action, requires confirmation */}
          <ListRow
            leading={<LogOut size={18} />}
            tone="crit"
            title={<span className="text-crit">{t('m.account.logOut')}</span>}
            onClick={() => setShowLogoutDialog(true)}
          />
        </section>

        {/* App version — the machine value, so it is set in mono. */}
        <p className="text-meta text-ink-3 text-center">
          {t('m.account.appVersion', { version: APP_VERSION })}
        </p>
      </div>

      {/* ================================================================
          Confirmation Dialogs
          ================================================================ */}

      {/* Logout confirmation */}
      <ConfirmSheet
        isOpen={showLogoutDialog}
        title={t('m.account.logOut')}
        message={t('m.account.logOutConfirm')}
        confirmLabel={t('m.account.logOut')}
        onConfirm={handleLogout}
        onCancel={() => {
          setLogoutError(null);
          setShowLogoutDialog(false);
        }}
        errorMessage={logoutError}
      />

      {/* Clear queue confirmation — surfaces the pending count so the user
          understands the data loss before committing */}
      <ConfirmSheet
        isOpen={showClearQueueDialog}
        title={t('m.account.clearQueue')}
        message={
          pendingCount === 1
            ? t('m.account.clearQueueConfirm.one')
            : t('m.account.clearQueueConfirm.other', { count: pendingCount })
        }
        confirmLabel={t('m.account.clearQueueAction')}
        onConfirm={handleClearQueue}
        onCancel={() => {
          setClearQueueError(null);
          setShowClearQueueDialog(false);
        }}
        errorMessage={clearQueueError}
      />
    </div>
  );
}
