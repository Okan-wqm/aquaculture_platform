import React, { useState, useEffect, useCallback } from 'react';
import {
  Building2,
  Bell,
  Shield,
  Globe,
  Palette,
  Smartphone,
  Save,
  ChevronRight,
  Info,
  Check,
  RefreshCw,
  AlertCircle,
  Lock,
} from 'lucide-react';
import { useAuthContext } from '@aquaculture/shared-ui';
import { useMyTenant, useUpdateTenantSettings } from '../hooks/useTenantData';
import { graphqlRequest } from '../services/tenant-api.service';
import {
  TENANT_USERS_QUERY,
  GET_NOTIFICATION_PREFERENCES_QUERY,
  UPDATE_NOTIFICATION_PREFERENCES_MUTATION,
  GET_MOBILE_USERS_SETTINGS_QUERY,
  UPDATE_MOBILE_USER_SETTINGS_MUTATION,
} from '../graphql';
import { logError } from '../utils/error-handling';

const executeGraphQL = graphqlRequest;

/**
 * Settings section type
 */
interface SettingsSection {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}

/**
 * Mobile user settings from API
 */
interface MobileUserSettingsData {
  id: string;
  userId: string;
  tenantId: string;
  isMobileEnabled: boolean;
  allowedFeatures: {
    mortality: boolean;
    cull: boolean;
    harvest: boolean;
    feeding: boolean;
    waterQuality: boolean;
    tankView: boolean;
  };
}

interface TenantUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
}

/**
 * Settings sections
 */
const settingsSections: SettingsSection[] = [
  {
    id: 'general',
    title: 'General',
    description: 'Basic tenant information and preferences',
    icon: <Building2 className="w-5 h-5" />,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Configure notification preferences',
    icon: <Bell className="w-5 h-5" />,
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Security settings and access controls',
    icon: <Shield className="w-5 h-5" />,
  },
  {
    id: 'localization',
    title: 'Localization',
    description: 'Language and regional settings',
    icon: <Globe className="w-5 h-5" />,
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Customize look and feel',
    icon: <Palette className="w-5 h-5" />,
  },
  {
    id: 'mobileUsers',
    title: 'Mobile Users',
    description: 'AquaMobil access and feature permissions',
    icon: <Smartphone className="w-5 h-5" />,
  },
];

/**
 * Toggle switch component
 */
const Toggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
  description?: string;
}> = ({ enabled, onChange, label, description }) => (
  <div className="flex items-center justify-between py-4">
    <div>
      <p className="text-sm font-medium text-gray-900">{label}</p>
      {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
    </div>
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:ring-offset-2 ${
        enabled ? 'bg-tenant-600' : 'bg-gray-200'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  </div>
);

/**
 * Small inline toggle for table cells
 */
const SmallToggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}> = ({ enabled, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!enabled)}
    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
      enabled ? 'bg-tenant-600' : 'bg-gray-200'
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
        enabled ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);

// Feature labels for the table header
const FEATURE_COLUMNS = [
  { key: 'mortality' as const, label: 'Mortality' },
  { key: 'cull' as const, label: 'Cull' },
  { key: 'harvest' as const, label: 'Harvest' },
  { key: 'tankView' as const, label: 'Tank View' },
] as const;

/**
 * TenantSettings Page
 *
 * SEC-007: Only TENANT_ADMIN (or higher) can modify settings.
 * Lower roles see a read-only view with editing controls disabled.
 */
const TenantSettings: React.FC = () => {
  // SEC-007: Check if current user has TENANT_ADMIN privileges for editing
  const { hasRoleOrHigher } = useAuthContext();
  const canEditSettings = hasRoleOrHigher('TENANT_ADMIN');

  const [activeSection, setActiveSection] = useState('general');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch real tenant data
  const { data: tenantData } = useMyTenant();
  const updateSettingsMutation = useUpdateTenantSettings();

  // Form state - populated from API
  const [tenantName, setTenantName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [address, setAddress] = useState('');

  // Populate form from real tenant data on load
  useEffect(() => {
    if (tenantData) {
      setTenantName(tenantData.name || '');
      setContactEmail(tenantData.contactEmail || '');
      setContactPhone(tenantData.contactPhone || '');
      setAddress(tenantData.address || '');
    }
  }, [tenantData]);

  // Notification preferences (per-user, fetched from backend)
  const [notifPrefs, setNotifPrefs] = useState({
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: false,
    quietHoursStart: '' as string,
    quietHoursEnd: '' as string,
    quietHoursTimezone: 'Europe/Istanbul',
    alertNotifications: true,
    taskNotifications: true,
    systemNotifications: true,
  });
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifDirty, setNotifDirty] = useState(false);

  // Load notification preferences when section is active
  useEffect(() => {
    if (activeSection === 'notifications') {
      setNotifLoading(true);
      executeGraphQL<{ getMyNotificationPreferences: typeof notifPrefs }>(
        GET_NOTIFICATION_PREFERENCES_QUERY,
      )
        .then((data) => {
          const p = data.getMyNotificationPreferences;
          setNotifPrefs({
            emailEnabled: p.emailEnabled,
            smsEnabled: p.smsEnabled,
            pushEnabled: p.pushEnabled,
            quietHoursStart: p.quietHoursStart || '',
            quietHoursEnd: p.quietHoursEnd || '',
            quietHoursTimezone: p.quietHoursTimezone || 'Europe/Istanbul',
            alertNotifications: p.alertNotifications,
            taskNotifications: p.taskNotifications,
            systemNotifications: p.systemNotifications,
          });
          setNotifDirty(false);
        })
        .catch((err) => {
          logError('TenantSettings.loadNotificationPreferences', err);
        })
        .finally(() => setNotifLoading(false));
    }
  }, [activeSection]);

  const updateNotifPref = <K extends keyof typeof notifPrefs>(key: K, value: (typeof notifPrefs)[K]) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
    setNotifDirty(true);
  };

  const saveNotificationPreferences = async () => {
    setNotifSaving(true);
    setSaveError(null);
    try {
      await executeGraphQL(UPDATE_NOTIFICATION_PREFERENCES_MUTATION, {
        input: {
          emailEnabled: notifPrefs.emailEnabled,
          smsEnabled: notifPrefs.smsEnabled,
          pushEnabled: notifPrefs.pushEnabled,
          quietHoursStart: notifPrefs.quietHoursStart || null,
          quietHoursEnd: notifPrefs.quietHoursEnd || null,
          quietHoursTimezone: notifPrefs.quietHoursTimezone,
          alertNotifications: notifPrefs.alertNotifications,
          taskNotifications: notifPrefs.taskNotifications,
          systemNotifications: notifPrefs.systemNotifications,
        },
      });
      setNotifDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('TenantSettings.saveNotificationPreferences', err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save notification preferences');
    } finally {
      setNotifSaving(false);
    }
  };

  // Security settings
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState('30');
  const [ipWhitelist, setIpWhitelist] = useState(false);

  // Localization settings
  const [language, setLanguage] = useState('en');
  const [timezone, setTimezone] = useState('UTC');
  const [dateFormat, setDateFormat] = useState('MM/DD/YYYY');

  // Mobile Users state
  const [mobileUsers, setMobileUsers] = useState<TenantUser[]>([]);
  const [mobileSettings, setMobileSettings] = useState<Map<string, MobileUserSettingsData>>(new Map());
  const [mobileLoading, setMobileLoading] = useState(false);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [mobileSaving, setMobileSaving] = useState(false);
  const [dirtyUserIds, setDirtyUserIds] = useState<Set<string>>(new Set());

  const loadMobileData = useCallback(async () => {
    setMobileLoading(true);
    setMobileError(null);
    try {
      // Load users and mobile settings in parallel
      const [usersData, settingsData] = await Promise.all([
        executeGraphQL<{ tenantUsers: TenantUser[] }>(TENANT_USERS_QUERY),
        executeGraphQL<{ getMobileUsersSettings: MobileUserSettingsData[] }>(GET_MOBILE_USERS_SETTINGS_QUERY),
      ]);

      setMobileUsers(usersData.tenantUsers || []);

      const settingsMap = new Map<string, MobileUserSettingsData>();
      for (const s of settingsData.getMobileUsersSettings || []) {
        settingsMap.set(s.userId, s);
      }
      setMobileSettings(settingsMap);
      setDirtyUserIds(new Set());
    } catch (err) {
      setMobileError((err as Error).message);
    } finally {
      setMobileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSection === 'mobileUsers') {
      loadMobileData();
    }
  }, [activeSection, loadMobileData]);

  // Get or create default settings for a user
  const getUserSettings = (userId: string): MobileUserSettingsData => {
    return mobileSettings.get(userId) || {
      id: '',
      userId,
      tenantId: '',
      isMobileEnabled: true,
      allowedFeatures: {
        mortality: true,
        cull: true,
        harvest: true,
        feeding: false,
        waterQuality: false,
        tankView: true,
      },
    };
  };

  // Update local state for a user's mobile settings
  const updateUserMobileSetting = (
    userId: string,
    field: 'isMobileEnabled' | keyof MobileUserSettingsData['allowedFeatures'],
    value: boolean,
  ) => {
    const current = getUserSettings(userId);
    let updated: MobileUserSettingsData;

    if (field === 'isMobileEnabled') {
      updated = { ...current, isMobileEnabled: value };
    } else {
      updated = {
        ...current,
        allowedFeatures: { ...current.allowedFeatures, [field]: value },
      };
    }

    setMobileSettings((prev) => {
      const next = new Map(prev);
      next.set(userId, updated);
      return next;
    });
    setDirtyUserIds((prev) => new Set(prev).add(userId));
  };

  // Save changed mobile settings — use Promise.all instead of serial loop (PERF-002)
  const saveMobileSettings = async () => {
    setMobileSaving(true);
    setMobileError(null);

    try {
      await Promise.all(
        Array.from(dirtyUserIds).map((userId) => {
          const settings = getUserSettings(userId);
          return executeGraphQL(UPDATE_MOBILE_USER_SETTINGS_MUTATION, {
            input: {
              userId,
              isMobileEnabled: settings.isMobileEnabled,
              mortality: settings.allowedFeatures.mortality,
              cull: settings.allowedFeatures.cull,
              harvest: settings.allowedFeatures.harvest,
              feeding: settings.allowedFeatures.feeding,
              waterQuality: settings.allowedFeatures.waterQuality,
              tankView: settings.allowedFeatures.tankView,
            },
          });
        }),
      );

      setDirtyUserIds(new Set());
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setMobileError((err as Error).message);
    } finally {
      setMobileSaving(false);
    }
  };

  // Apply settings to all users
  const applyToAll = (field: 'isMobileEnabled' | keyof MobileUserSettingsData['allowedFeatures'], value: boolean) => {
    for (const user of mobileUsers) {
      updateUserMobileSetting(user.id, field, value);
    }
  };

  const handleSave = useCallback(async () => {
    if (activeSection === 'mobileUsers') {
      await saveMobileSettings();
      return;
    }

    if (activeSection === 'notifications') {
      await saveNotificationPreferences();
      return;
    }

    if (activeSection !== 'general') {
      // SEC-005: Non-persisted sections (security, localization, appearance)
      // must NOT give false confirmation. The Save button is disabled for these sections
      // so this branch should not be reached, but return early as a safety guard.
      return;
    }

    setLoading(true);
    setSaveError(null);
    try {
      await updateSettingsMutation.mutateAsync({
        name: tenantName,
        contactEmail,
        contactPhone,
        address,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('TenantSettings.handleSave', err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setLoading(false);
    }
  }, [activeSection, tenantName, contactEmail, contactPhone, address, updateSettingsMutation, saveMobileSettings, saveNotificationPreferences]);

  const renderSection = () => {
    switch (activeSection) {
      case 'general':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tenant Name
              </label>
              <input
                type="text"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                disabled={!canEditSettings}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contact Email
              </label>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                disabled={!canEditSettings}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contact Phone
              </label>
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                disabled={!canEditSettings}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Address
              </label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                rows={3}
                disabled={!canEditSettings}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent resize-none disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>
          </div>
        );

      case 'notifications':
        if (notifLoading) {
          return (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin text-tenant-600" />
            </div>
          );
        }
        return (
          <div className="space-y-6">
            {/* Channel toggles */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Channels</h3>
              <div className="divide-y divide-gray-100">
                <Toggle
                  enabled={notifPrefs.emailEnabled}
                  onChange={(v) => updateNotifPref('emailEnabled', v)}
                  label="Email Notifications"
                  description="Receive important updates via email"
                />
                <Toggle
                  enabled={notifPrefs.smsEnabled}
                  onChange={(v) => updateNotifPref('smsEnabled', v)}
                  label="SMS Notifications"
                  description="Receive critical alerts via text message"
                />
                <Toggle
                  enabled={notifPrefs.pushEnabled}
                  onChange={(v) => updateNotifPref('pushEnabled', v)}
                  label="Push Notifications"
                  description="Receive push notifications on your devices"
                />
              </div>
            </div>

            {/* Category toggles */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Categories</h3>
              <div className="divide-y divide-gray-100">
                <Toggle
                  enabled={notifPrefs.alertNotifications}
                  onChange={(v) => updateNotifPref('alertNotifications', v)}
                  label="Alert Notifications"
                  description="Sensor threshold breaches and critical alerts"
                />
                <Toggle
                  enabled={notifPrefs.taskNotifications}
                  onChange={(v) => updateNotifPref('taskNotifications', v)}
                  label="Task Notifications"
                  description="Task assignments, updates, and reminders"
                />
                <Toggle
                  enabled={notifPrefs.systemNotifications}
                  onChange={(v) => updateNotifPref('systemNotifications', v)}
                  label="System Notifications"
                  description="System updates, maintenance notices, and reports"
                />
              </div>
            </div>

            {/* Quiet hours */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Quiet Hours</h3>
              <p className="text-xs text-gray-500 mb-3">
                Suppress non-critical notifications during specified hours. Critical alerts are always delivered.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={notifPrefs.quietHoursStart}
                    onChange={(e) => updateNotifPref('quietHoursStart', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
                  <input
                    type="time"
                    value={notifPrefs.quietHoursEnd}
                    onChange={(e) => updateNotifPref('quietHoursEnd', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
                  <select
                    value={notifPrefs.quietHoursTimezone}
                    onChange={(e) => updateNotifPref('quietHoursTimezone', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
                  >
                    <option value="Europe/Istanbul">Europe/Istanbul (UTC+3)</option>
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">America/New York (UTC-5)</option>
                    <option value="America/Los_Angeles">America/Los Angeles (UTC-8)</option>
                    <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
                    <option value="Europe/London">Europe/London (UTC+0/+1)</option>
                    <option value="Europe/Berlin">Europe/Berlin (UTC+1/+2)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Dirty indicator */}
            {notifDirty && (
              <div className="flex items-center gap-2 text-sm text-tenant-600">
                <Info className="w-4 h-4" />
                <span>You have unsaved changes</span>
              </div>
            )}
          </div>
        );

      case 'security':
        return (
          <div className="space-y-6">
            {/* SEC-005: Security settings are not yet persisted to the backend.
                Display a prominent warning so users are never misled into believing
                2FA enforcement or session timeout changes have been applied. */}
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">
                <strong>Not yet available:</strong> Security settings (2FA enforcement, session timeout, IP whitelist) are not currently persisted. Changes made here will not take effect. Contact your system administrator to configure these security controls.
              </p>
            </div>
            <div className="opacity-50 pointer-events-none space-y-6">
              <Toggle
                enabled={twoFactorRequired}
                onChange={setTwoFactorRequired}
                label="Require Two-Factor Authentication"
                description="All users must enable 2FA to access the system"
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Session Timeout (minutes)
                </label>
                <select
                  value={sessionTimeout}
                  onChange={(e) => setSessionTimeout(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
                >
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="480">8 hours</option>
                </select>
              </div>
              <Toggle
                enabled={ipWhitelist}
                onChange={setIpWhitelist}
                label="IP Whitelist"
                description="Restrict access to specific IP addresses"
              />
            </div>
          </div>
        );

      case 'localization':
        return (
          <div className="space-y-6">
            {/* SEC-005: Localization settings are not yet persisted to the backend.
                Display a clear notice so users are not misled into thinking changes are saved. */}
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-700">
                <strong>Not yet available:</strong> Localization settings are not currently persisted. Changes made here will not be saved. This section is coming soon.
              </p>
            </div>
            <div className="opacity-50 pointer-events-none space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
                >
                  <option value="en">English</option>
                  <option value="tr">Turkish</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Timezone
                </label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
                >
                  <option value="UTC">UTC</option>
                  <option value="Europe/Istanbul">Europe/Istanbul (UTC+3)</option>
                  <option value="America/New_York">America/New York (UTC-5)</option>
                  <option value="America/Los_Angeles">America/Los Angeles (UTC-8)</option>
                  <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date Format
                </label>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500"
                >
                  <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                </select>
              </div>
            </div>
          </div>
        );

      case 'appearance':
        return (
          <div className="space-y-6">
            <div className="p-6 bg-gray-50 rounded-lg text-center">
              <Palette className="w-12 h-12 text-gray-500 mx-auto" />
              <h3 className="mt-4 text-sm font-medium text-gray-900">
                Appearance Settings
              </h3>
              <p className="mt-2 text-sm text-gray-500">
                Custom theming and branding options coming soon.
              </p>
            </div>
          </div>
        );

      case 'mobileUsers':
        return renderMobileUsersSection();

      default:
        return null;
    }
  };

  const renderMobileUsersSection = () => {
    if (mobileLoading) {
      return (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-tenant-600" />
        </div>
      );
    }

    if (mobileError) {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load mobile settings</p>
            <p className="text-sm text-red-600">{mobileError}</p>
          </div>
          <button
            onClick={loadMobileData}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }

    if (mobileUsers.length === 0) {
      return (
        <div className="py-12 text-center">
          <Smartphone className="w-12 h-12 text-gray-500 mx-auto" />
          <h3 className="mt-4 text-sm font-medium text-gray-900">No users found</h3>
          <p className="mt-1 text-sm text-gray-500">
            Add users to your tenant first to configure mobile access.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Bulk actions */}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Apply to all:</span>
          <button
            onClick={() => applyToAll('isMobileEnabled', true)}
            className="px-2 py-1 bg-green-50 text-green-700 rounded hover:bg-green-100 transition-colors"
          >
            Enable All
          </button>
          <button
            onClick={() => applyToAll('isMobileEnabled', false)}
            className="px-2 py-1 bg-red-50 text-red-700 rounded hover:bg-red-100 transition-colors"
          >
            Disable All
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Mobile
                </th>
                {FEATURE_COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {mobileUsers.map((user) => {
                const settings = getUserSettings(user.id);
                const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];
                const isDirty = dirtyUserIds.has(user.id);

                return (
                  <tr
                    key={user.id}
                    className={`hover:bg-gray-50 transition-colors ${isDirty ? 'bg-tenant-50/30' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-xs font-medium">
                          {name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{name}</p>
                          <p className="text-xs text-gray-500">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <SmallToggle
                        enabled={settings.isMobileEnabled}
                        onChange={(v) => updateUserMobileSetting(user.id, 'isMobileEnabled', v)}
                      />
                    </td>
                    {FEATURE_COLUMNS.map((col) => (
                      <td key={col.key} className="px-4 py-3 text-center">
                        <SmallToggle
                          enabled={settings.allowedFeatures[col.key]}
                          onChange={(v) => updateUserMobileSetting(user.id, col.key, v)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Dirty indicator */}
        {dirtyUserIds.size > 0 && (
          <div className="flex items-center gap-2 text-sm text-tenant-600">
            <Info className="w-4 h-4" />
            <span>{dirtyUserIds.size} user(s) have unsaved changes</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage your tenant settings and preferences
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* SEC-007: Read-only notice for non-admin users */}
          {!canEditSettings && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg border border-amber-200">
              <Lock className="w-3.5 h-3.5" />
              Read-only access
            </div>
          )}
          {/* SEC-005: Disable Save for sections not yet persisted to the backend */}
          {/* SEC-007: Hide Save button entirely for non-admin users */}
          {canEditSettings && (
          <button
            onClick={handleSave}
            disabled={
              loading ||
              updateSettingsMutation.isPending ||
              (activeSection === 'mobileUsers' && (mobileSaving || dirtyUserIds.size === 0)) ||
              (activeSection === 'notifications' && (notifSaving || !notifDirty)) ||
              ['security', 'localization', 'appearance'].includes(activeSection)
            }
            title={
              ['security', 'localization', 'appearance'].includes(activeSection)
                ? 'This section is not yet persisted — settings cannot be saved'
                : undefined
            }
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saved ? (
              <>
                <Check className="w-4 h-4" />
                Saved!
              </>
            ) : (loading || updateSettingsMutation.isPending || mobileSaving || notifSaving) ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
          )}
          {saveError && canEditSettings && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {saveError}
            </p>
          )}
        </div>
      </div>

      {/* Settings Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <nav className="divide-y divide-gray-100">
              {settingsSections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                    activeSection === section.id
                      ? 'bg-tenant-50 text-tenant-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`flex-shrink-0 ${
                      activeSection === section.id
                        ? 'text-tenant-600'
                        : 'text-gray-500'
                    }`}
                  >
                    {section.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{section.title}</p>
                    <p className="text-xs text-gray-500 truncate hidden sm:block">
                      {section.description}
                    </p>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 flex-shrink-0 ${
                      activeSection === section.id
                        ? 'text-tenant-600'
                        : 'text-gray-500'
                    }`}
                  />
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Settings Content */}
        <div className="lg:col-span-3">
          <div className="bg-white rounded-xl border border-gray-100 p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">
                {settingsSections.find((s) => s.id === activeSection)?.title}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                {settingsSections.find((s) => s.id === activeSection)?.description}
              </p>
            </div>
            {renderSection()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantSettings;
