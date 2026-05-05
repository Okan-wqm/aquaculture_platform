import React, { useState } from 'react';
import {
  Building2,
  Bell,
  Shield,
  Globe,
  Palette,
  Smartphone,
  ChevronRight,
  Lock,
} from 'lucide-react';
import { useAuthContext } from '@aquaculture/shared-ui';
import {
  useMyTenant,
  useUpdateTenantSettings,
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  useMobileUsersData,
  useUpdateMobileUserSettings,
} from '../hooks/useTenantData';
import { logError } from '../utils/error-handling';

/**
 * Settings section definition.
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

// TenantUser type is now provided by useMobileUsersData hook (TenantUserBasic)

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
 * TenantSettings Page -- tab navigation + section composition.
 *
 * SEC-007: Only TENANT_ADMIN (or higher) can modify settings.
 * Lower roles see a read-only view with editing controls disabled.
 *
 * Each section is a self-contained component that manages its own data
 * fetching, form state, and save logic.
 */
const TenantSettings: React.FC = () => {
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
  const [notifDirty, setNotifDirty] = useState(false);

  // TanStack Query for notification preferences
  const { data: notifData, isLoading: notifLoading } = useNotificationPreferences(activeSection === 'notifications');
  const updateNotifPrefsMutation = useUpdateNotificationPreferences();
  const notifSaving = updateNotifPrefsMutation.isPending;

  // Populate notification prefs when data arrives
  useEffect(() => {
    if (notifData) {
      setNotifPrefs({
        emailEnabled: notifData.emailEnabled,
        smsEnabled: notifData.smsEnabled,
        pushEnabled: notifData.pushEnabled,
        quietHoursStart: notifData.quietHoursStart || '',
        quietHoursEnd: notifData.quietHoursEnd || '',
        quietHoursTimezone: notifData.quietHoursTimezone || 'Europe/Istanbul',
        alertNotifications: notifData.alertNotifications,
        taskNotifications: notifData.taskNotifications,
        systemNotifications: notifData.systemNotifications,
      });
      setNotifDirty(false);
    }
  }, [notifData]);

  const updateNotifPref = <K extends keyof typeof notifPrefs>(key: K, value: (typeof notifPrefs)[K]) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
    setNotifDirty(true);
  };

  const saveNotificationPreferences = async () => {
    setSaveError(null);
    try {
      await updateNotifPrefsMutation.mutateAsync({
        emailEnabled: notifPrefs.emailEnabled,
        smsEnabled: notifPrefs.smsEnabled,
        pushEnabled: notifPrefs.pushEnabled,
        quietHoursStart: notifPrefs.quietHoursStart || undefined,
        quietHoursEnd: notifPrefs.quietHoursEnd || undefined,
        quietHoursTimezone: notifPrefs.quietHoursTimezone,
        alertNotifications: notifPrefs.alertNotifications,
        taskNotifications: notifPrefs.taskNotifications,
        systemNotifications: notifPrefs.systemNotifications,
      });
      setNotifDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('TenantSettings.saveNotificationPreferences', err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save notification preferences');
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

  // Mobile Users state - using TanStack Query
  const { data: mobileData, isLoading: mobileLoading, error: mobileQueryError } = useMobileUsersData(activeSection === 'mobileUsers');
  const updateMobileSettingsMutation = useUpdateMobileUserSettings();
  const mobileUsers = mobileData?.users ?? [];
  const [mobileSettings, setMobileSettings] = useState<Map<string, MobileUserSettingsData>>(new Map());
  const mobileError = mobileQueryError ? (mobileQueryError as Error).message : null;
  const mobileSaving = updateMobileSettingsMutation.isPending;
  const [dirtyUserIds, setDirtyUserIds] = useState<Set<string>>(new Set());

  // Sync settings from query
  useEffect(() => {
    if (mobileData?.settings) {
      setMobileSettings(mobileData.settings);
      setDirtyUserIds(new Set());
    }
  }, [mobileData?.settings]);

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
    try {
      await Promise.all(
        Array.from(dirtyUserIds).map((userId) => {
          const settings = getUserSettings(userId);
          return updateMobileSettingsMutation.mutateAsync({
            userId,
            isMobileEnabled: settings.isMobileEnabled,
            mortality: settings.allowedFeatures.mortality,
            cull: settings.allowedFeatures.cull,
            harvest: settings.allowedFeatures.harvest,
            feeding: settings.allowedFeatures.feeding,
            waterQuality: settings.allowedFeatures.waterQuality,
            tankView: settings.allowedFeatures.tankView,
          });
        }),
      );

      setDirtyUserIds(new Set());
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      logError('TenantSettings.saveMobileSettings', err);
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
        return <GeneralSettings canEdit={canEditSettings} />;
      case 'notifications':
        return <NotificationSettings />;
      case 'security':
        return <SecuritySettings />;
      case 'localization':
        return <LocalizationSettings />;
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
        return <MobileSettings />;
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
            onClick={() => { /* refetch handled by TanStack Query */ }}
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
        {!canEditSettings && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg border border-amber-200">
            <Lock className="w-3.5 h-3.5" />
            Read-only access
          </div>
        )}
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
                      activeSection === section.id ? 'text-tenant-600' : 'text-gray-500'
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
                      activeSection === section.id ? 'text-tenant-600' : 'text-gray-500'
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
