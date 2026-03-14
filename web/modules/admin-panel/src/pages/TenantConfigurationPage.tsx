/**
 * Tenant Configuration Page
 *
 * Tenant-level ayarların yönetimi için sayfa.
 * User limits, storage, API, branding, security ve notification ayarları.
 *
 * Sprint 3 Fix (Grup Q / C10-36): Mock data removed, real API integration via settingsApi.
 */

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  Card,
  Button,
  Badge,
  Input,
  Modal
} from '@aquaculture/shared-ui';
import { settingsApi } from '../services/adminApi';
import type { TenantConfiguration as ApiTenantConfiguration } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface TenantConfiguration {
  id: string;
  tenantId: string;
  userLimits: UserLimitsConfig;
  storageConfig: StorageConfig;
  apiConfig: ApiConfig;
  dataRetention: DataRetentionConfig;
  domainConfig: DomainConfig;
  brandingConfig: BrandingConfig;
  securityConfig: TenantSecurityConfig;
  notificationConfig: TenantNotificationConfig;
  featureFlags: FeatureFlagsConfig;
  createdAt: string;
  updatedAt: string;
}

interface UserLimitsConfig {
  maxUsers: number;
  maxAdmins: number;
  maxModuleManagers: number;
  maxConcurrentSessions: number;
  sessionTimeoutMinutes: number;
  inactiveUserCleanupDays: number;
  allowGuestAccess: boolean;
}

interface StorageConfig {
  totalStorageGB: number;
  usedStorageGB: number;
  maxFileSizeMB: number;
  allowedFileTypes: string[];
  enableFileVersioning: boolean;
  versionRetentionCount: number;
  compressionEnabled: boolean;
}

interface ApiConfig {
  enabled: boolean;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  rateLimitPerDay: number;
  maxConcurrentRequests: number;
  apiKeys: ApiKeyConfig[];
  webhooksEnabled: boolean;
  webhookRetryCount: number;
  ipWhitelist: string[];
}

interface ApiKeyConfig {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  isActive: boolean;
}

interface DataRetentionConfig {
  auditLogRetentionDays: number;
  activityLogRetentionDays: number;
  sensorDataRetentionDays: number;
  alertHistoryRetentionDays: number;
  deletedDataRetentionDays: number;
  backupRetentionDays: number;
  autoDeleteEnabled: boolean;
  archiveBeforeDelete: boolean;
}

interface DomainConfig {
  customDomain?: string;
  customDomainVerified: boolean;
  subdomain?: string;
  redirectToCustomDomain: boolean;
  allowedOrigins: string[];
}

interface BrandingConfig {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headerColor: string;
  fontFamily: string;
  companyName: string;
  supportEmail?: string;
  supportPhone?: string;
  showPoweredBy: boolean;
}

interface TenantSecurityConfig {
  mfaRequired: boolean;
  mfaRequiredForAdmins: boolean;
  allowedMfaMethods: string[];
  ssoEnabled: boolean;
  ssoProvider?: string;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireNumbers: boolean;
  passwordRequireSpecialChars: boolean;
  passwordExpiryDays: number;
  ipWhitelistEnabled: boolean;
  ipWhitelist: string[];
  ipBlacklistEnabled: boolean;
  ipBlacklist: string[];
  geoBlockingEnabled: boolean;
  allowedCountries: string[];
  blockedCountries: string[];
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  sessionTimeoutMinutes: number;
  singleSessionPerUser: boolean;
}

interface TenantNotificationConfig {
  emailEnabled: boolean;
  emailFromName?: string;
  emailFromAddress?: string;
  customSmtpEnabled: boolean;
  smsEnabled: boolean;
  smsProvider?: string;
  pushEnabled: boolean;
  slackEnabled: boolean;
  slackWebhookUrl?: string;
  webhookEnabled: boolean;
  digestFrequency: string;
  quietHoursEnabled: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

interface FeatureFlagsConfig {
  enabledModules: string[];
  advancedAnalytics: boolean;
  customReports: boolean;
  dataExport: boolean;
  dataImport: boolean;
  bulkOperations: boolean;
  auditLog: boolean;
  apiAccess: boolean;
  mobileAccess: boolean;
  offlineMode: boolean;
  thirdPartyIntegrations: boolean;
  customIntegrations: boolean;
  iotDeviceSupport: boolean;
  betaFeatures: string[];
}

type TabType = 'limits' | 'storage' | 'api' | 'branding' | 'security' | 'notifications' | 'features' | 'retention';

// ============================================================================
// Component
// ============================================================================

const TenantConfigurationPage: React.FC = () => {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [config, setConfig] = useState<TenantConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('limits');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);

  useEffect(() => {
    loadConfiguration();
  }, [tenantId]);

  const loadConfiguration = async () => {
    if (!tenantId) return;
    try {
      setLoading(true);
      setSaveError(null);
      const apiConfig = await settingsApi.getTenantConfig(tenantId);
      // Map API response (flat configuration record) into local TenantConfiguration shape.
      // The backend returns { tenantId, configuration: Record<string,unknown>, branding?, apiKeys?, webhooks?, updatedAt }
      // We spread the configuration record into our detailed local config structure.
      const cfg = apiConfig.configuration || {};
      const localConfig: TenantConfiguration = {
        id: apiConfig.tenantId,
        tenantId: apiConfig.tenantId,
        userLimits: (cfg.userLimits as UserLimitsConfig) || {
          maxUsers: 50, maxAdmins: 5, maxModuleManagers: 10, maxConcurrentSessions: 3,
          sessionTimeoutMinutes: 480, inactiveUserCleanupDays: 90, allowGuestAccess: false,
        },
        storageConfig: (cfg.storageConfig as StorageConfig) || {
          totalStorageGB: 100, usedStorageGB: 0, maxFileSizeMB: 100,
          allowedFileTypes: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'jpg', 'png'],
          enableFileVersioning: true, versionRetentionCount: 5, compressionEnabled: true,
        },
        apiConfig: {
          enabled: true,
          rateLimitPerMinute: ((cfg.apiConfig as Record<string, unknown>)?.rateLimitPerMinute as number) || 100,
          rateLimitPerHour: ((cfg.apiConfig as Record<string, unknown>)?.rateLimitPerHour as number) || 1000,
          rateLimitPerDay: ((cfg.apiConfig as Record<string, unknown>)?.rateLimitPerDay as number) || 10000,
          maxConcurrentRequests: ((cfg.apiConfig as Record<string, unknown>)?.maxConcurrentRequests as number) || 10,
          apiKeys: (apiConfig.apiKeys || []).map(k => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            permissions: k.scopes || [],
            expiresAt: k.expiresAt,
            lastUsedAt: k.lastUsedAt,
            createdAt: '',
            isActive: true,
          })),
          webhooksEnabled: ((cfg.apiConfig as Record<string, unknown>)?.webhooksEnabled as boolean) ?? true,
          webhookRetryCount: ((cfg.apiConfig as Record<string, unknown>)?.webhookRetryCount as number) || 3,
          ipWhitelist: ((cfg.apiConfig as Record<string, unknown>)?.ipWhitelist as string[]) || [],
        },
        dataRetention: (cfg.dataRetention as DataRetentionConfig) || {
          auditLogRetentionDays: 90, activityLogRetentionDays: 30, sensorDataRetentionDays: 365,
          alertHistoryRetentionDays: 180, deletedDataRetentionDays: 30, backupRetentionDays: 30,
          autoDeleteEnabled: true, archiveBeforeDelete: true,
        },
        domainConfig: (cfg.domainConfig as DomainConfig) || {
          customDomainVerified: false, redirectToCustomDomain: false, allowedOrigins: [],
        },
        brandingConfig: {
          logoUrl: apiConfig.branding?.logo,
          primaryColor: apiConfig.branding?.primaryColor || '#3B82F6',
          secondaryColor: apiConfig.branding?.secondaryColor || '#6B7280',
          accentColor: ((cfg.brandingConfig as Record<string, unknown>)?.accentColor as string) || '#10B981',
          headerColor: ((cfg.brandingConfig as Record<string, unknown>)?.headerColor as string) || '#1F2937',
          fontFamily: ((cfg.brandingConfig as Record<string, unknown>)?.fontFamily as string) || 'Inter',
          companyName: ((cfg.brandingConfig as Record<string, unknown>)?.companyName as string) || '',
          supportEmail: ((cfg.brandingConfig as Record<string, unknown>)?.supportEmail as string),
          showPoweredBy: ((cfg.brandingConfig as Record<string, unknown>)?.showPoweredBy as boolean) ?? true,
        },
        securityConfig: (cfg.securityConfig as TenantSecurityConfig) || {
          mfaRequired: false, mfaRequiredForAdmins: true, allowedMfaMethods: ['totp'],
          ssoEnabled: false, passwordMinLength: 8, passwordRequireUppercase: true,
          passwordRequireLowercase: true, passwordRequireNumbers: true, passwordRequireSpecialChars: false,
          passwordExpiryDays: 90, ipWhitelistEnabled: false, ipWhitelist: [],
          ipBlacklistEnabled: false, ipBlacklist: [], geoBlockingEnabled: false,
          allowedCountries: [], blockedCountries: [], maxLoginAttempts: 5,
          lockoutDurationMinutes: 30, sessionTimeoutMinutes: 480, singleSessionPerUser: false,
        },
        notificationConfig: (cfg.notificationConfig as TenantNotificationConfig) || {
          emailEnabled: true, customSmtpEnabled: false, smsEnabled: false,
          pushEnabled: false, slackEnabled: false, webhookEnabled: false,
          digestFrequency: 'daily', quietHoursEnabled: false,
        },
        featureFlags: (cfg.featureFlags as FeatureFlagsConfig) || {
          enabledModules: [], advancedAnalytics: false, customReports: false,
          dataExport: true, dataImport: true, bulkOperations: false,
          auditLog: true, apiAccess: true, mobileAccess: true, offlineMode: false,
          thirdPartyIntegrations: false, customIntegrations: false, iotDeviceSupport: false,
          betaFeatures: [],
        },
        createdAt: apiConfig.updatedAt,
        updatedAt: apiConfig.updatedAt,
      };
      setConfig(localConfig);
    } catch (error) {
      console.error('Failed to load configuration:', error);
      setSaveError('Failed to load tenant configuration. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config || !tenantId) return;
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);
      await settingsApi.updateTenantConfig(tenantId, {
        configuration: {
          userLimits: config.userLimits,
          storageConfig: config.storageConfig,
          apiConfig: {
            enabled: config.apiConfig.enabled,
            rateLimitPerMinute: config.apiConfig.rateLimitPerMinute,
            rateLimitPerHour: config.apiConfig.rateLimitPerHour,
            rateLimitPerDay: config.apiConfig.rateLimitPerDay,
            maxConcurrentRequests: config.apiConfig.maxConcurrentRequests,
            webhooksEnabled: config.apiConfig.webhooksEnabled,
            webhookRetryCount: config.apiConfig.webhookRetryCount,
            ipWhitelist: config.apiConfig.ipWhitelist,
          },
          dataRetention: config.dataRetention,
          domainConfig: config.domainConfig,
          brandingConfig: config.brandingConfig,
          securityConfig: config.securityConfig,
          notificationConfig: config.notificationConfig,
          featureFlags: config.featureFlags,
        },
        branding: {
          logo: config.brandingConfig.logoUrl,
          primaryColor: config.brandingConfig.primaryColor,
          secondaryColor: config.brandingConfig.secondaryColor,
        },
      });
      setSaveSuccess(true);
    } catch (error) {
      console.error('Failed to save configuration:', error);
      setSaveError('Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = <K extends keyof TenantConfiguration>(
    section: K,
    updates: Partial<TenantConfiguration[K]>
  ) => {
    if (!config) return;
    const currentSection = config[section];
    if (typeof currentSection === 'object' && currentSection !== null) {
      setConfig({
        ...config,
        [section]: { ...currentSection, ...updates },
      });
    }
  };

  const tabs: { id: TabType; label: string; icon: string }[] = [
    { id: 'limits', label: 'User Limits', icon: '👥' },
    { id: 'storage', label: 'Storage', icon: '💾' },
    { id: 'api', label: 'API & Webhooks', icon: '🔌' },
    { id: 'branding', label: 'Branding & Appearance', icon: '🎨' },
    { id: 'security', label: 'Security', icon: '🔒' },
    { id: 'notifications', label: 'Notifications', icon: '🔔' },
    { id: 'features', label: 'Features', icon: '⚡' },
    { id: 'retention', label: 'Data Retention', icon: '📁' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Configuration not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Configuration</h1>
          <p className="text-gray-500 mt-1">Tenant ID: {tenantId}</p>
        </div>
        <Button
          variant="primary"
          onClick={handleSave}
          loading={saving}
        >
          Save Changes
        </Button>
      </div>

      {/* Save success/error */}
      {saveSuccess && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center justify-between">
          <span className="text-green-700 text-sm">Configuration saved successfully.</span>
          <button onClick={() => setSaveSuccess(false)} className="text-green-400 hover:text-green-600 ml-4">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
      {saveError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between">
          <span className="text-red-700 text-sm">{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-600 ml-4">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-4 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <span className="mr-2">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {/* User Limits Tab */}
        {activeTab === 'limits' && (
          <Card title="User Limits">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maximum Users
                </label>
                <Input
                  type="number"
                  value={config.userLimits.maxUsers}
                  onChange={(e) => updateConfig('userLimits', { maxUsers: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maximum Admins
                </label>
                <Input
                  type="number"
                  value={config.userLimits.maxAdmins}
                  onChange={(e) => updateConfig('userLimits', { maxAdmins: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Max Concurrent Sessions
                </label>
                <Input
                  type="number"
                  value={config.userLimits.maxConcurrentSessions}
                  onChange={(e) => updateConfig('userLimits', { maxConcurrentSessions: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Session Timeout (min)
                </label>
                <Input
                  type="number"
                  value={config.userLimits.sessionTimeoutMinutes}
                  onChange={(e) => updateConfig('userLimits', { sessionTimeoutMinutes: parseInt(e.target.value) })}
                />
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="allowGuestAccess"
                  checked={config.userLimits.allowGuestAccess}
                  onChange={(e) => updateConfig('userLimits', { allowGuestAccess: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor="allowGuestAccess" className="ml-2 text-sm text-gray-700">
                  Allow Guest Access
                </label>
              </div>
            </div>
          </Card>
        )}

        {/* Storage Tab */}
        {activeTab === 'storage' && (
          <Card title="Storage Settings">
            <div className="mb-6">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">Used Space</span>
                <span className="font-medium">
                  {config.storageConfig.usedStorageGB} GB / {config.storageConfig.totalStorageGB} GB
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all"
                  style={{
                    width: `${(config.storageConfig.usedStorageGB / config.storageConfig.totalStorageGB) * 100}%`,
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Total Storage (GB)
                </label>
                <Input
                  type="number"
                  value={config.storageConfig.totalStorageGB}
                  onChange={(e) => updateConfig('storageConfig', { totalStorageGB: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Max File Size (MB)
                </label>
                <Input
                  type="number"
                  value={config.storageConfig.maxFileSizeMB}
                  onChange={(e) => updateConfig('storageConfig', { maxFileSizeMB: parseInt(e.target.value) })}
                />
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="enableFileVersioning"
                  checked={config.storageConfig.enableFileVersioning}
                  onChange={(e) => updateConfig('storageConfig', { enableFileVersioning: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor="enableFileVersioning" className="ml-2 text-sm text-gray-700">
                  File Versioning
                </label>
              </div>
            </div>
          </Card>
        )}

        {/* API Tab */}
        {activeTab === 'api' && (
          <div className="space-y-6">
            <Card title="API Settings">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="apiEnabled"
                    checked={config.apiConfig.enabled}
                    onChange={(e) => updateConfig('apiConfig', { enabled: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="apiEnabled" className="ml-2 text-sm text-gray-700">
                    API Access Enabled
                  </label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Rate Limit / Minute
                  </label>
                  <Input
                    type="number"
                    value={config.apiConfig.rateLimitPerMinute}
                    onChange={(e) => updateConfig('apiConfig', { rateLimitPerMinute: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Rate Limit / Hour
                  </label>
                  <Input
                    type="number"
                    value={config.apiConfig.rateLimitPerHour}
                    onChange={(e) => updateConfig('apiConfig', { rateLimitPerHour: parseInt(e.target.value) })}
                  />
                </div>
              </div>
            </Card>

            <Card
              title="API Keys"
              headerAction={
                <Button variant="primary" size="sm" onClick={() => setShowApiKeyModal(true)}>
                  New Key
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Prefix</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Permissions</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {config.apiConfig.apiKeys.map((key) => (
                      <tr key={key.id}>
                        <td className="px-4 py-3 text-sm text-gray-900">{key.name}</td>
                        <td className="px-4 py-3 text-sm font-mono text-gray-600">{key.prefix}...</td>
                        <td className="px-4 py-3 text-sm">
                          {key.permissions.map(p => (
                            <Badge key={p} variant="default" className="mr-1">{p}</Badge>
                          ))}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={key.isActive ? 'success' : 'error'}>
                            {key.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Button variant="ghost" size="sm" className="text-red-600">
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* Security Tab */}
        {activeTab === 'security' && (
          <div className="space-y-6">
            <Card title="Multi-Factor Authentication (MFA)">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="mfaRequired"
                    checked={config.securityConfig.mfaRequired}
                    onChange={(e) => updateConfig('securityConfig', { mfaRequired: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="mfaRequired" className="ml-2 text-sm text-gray-700">
                    Require MFA for All Users
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="mfaRequiredForAdmins"
                    checked={config.securityConfig.mfaRequiredForAdmins}
                    onChange={(e) => updateConfig('securityConfig', { mfaRequiredForAdmins: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="mfaRequiredForAdmins" className="ml-2 text-sm text-gray-700">
                    Require MFA for Admins
                  </label>
                </div>
              </div>
            </Card>

            <Card title="Password Policy">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Minimum Password Length
                  </label>
                  <Input
                    type="number"
                    value={config.securityConfig.passwordMinLength}
                    onChange={(e) => updateConfig('securityConfig', { passwordMinLength: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Password Expiry (days)
                  </label>
                  <Input
                    type="number"
                    value={config.securityConfig.passwordExpiryDays}
                    onChange={(e) => updateConfig('securityConfig', { passwordExpiryDays: parseInt(e.target.value) })}
                  />
                </div>
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.securityConfig.passwordRequireUppercase}
                      onChange={(e) => updateConfig('securityConfig', { passwordRequireUppercase: e.target.checked })}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">Require uppercase</span>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.securityConfig.passwordRequireNumbers}
                      onChange={(e) => updateConfig('securityConfig', { passwordRequireNumbers: e.target.checked })}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">Require numbers</span>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.securityConfig.passwordRequireSpecialChars}
                      onChange={(e) => updateConfig('securityConfig', { passwordRequireSpecialChars: e.target.checked })}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">Require special characters</span>
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Login Security">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Max Failed Login Attempts
                  </label>
                  <Input
                    type="number"
                    value={config.securityConfig.maxLoginAttempts}
                    onChange={(e) => updateConfig('securityConfig', { maxLoginAttempts: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Account Lockout Duration (min)
                  </label>
                  <Input
                    type="number"
                    value={config.securityConfig.lockoutDurationMinutes}
                    onChange={(e) => updateConfig('securityConfig', { lockoutDurationMinutes: parseInt(e.target.value) })}
                  />
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="singleSessionPerUser"
                    checked={config.securityConfig.singleSessionPerUser}
                    onChange={(e) => updateConfig('securityConfig', { singleSessionPerUser: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="singleSessionPerUser" className="ml-2 text-sm text-gray-700">
                    Single Session Per User
                  </label>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Notifications Tab */}
        {activeTab === 'notifications' && (
          <div className="space-y-6">
            <Card title="Email Settings">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="emailEnabled"
                    checked={config.notificationConfig.emailEnabled}
                    onChange={(e) => updateConfig('notificationConfig', { emailEnabled: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="emailEnabled" className="ml-2 text-sm text-gray-700">
                    Email Notifications Enabled
                  </label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Sender Name
                  </label>
                  <Input
                    type="text"
                    value={config.notificationConfig.emailFromName || ''}
                    onChange={(e) => updateConfig('notificationConfig', { emailFromName: e.target.value })}
                  />
                </div>
              </div>
            </Card>

            <Card title="Other Notification Channels">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="smsEnabled"
                    checked={config.notificationConfig.smsEnabled}
                    onChange={(e) => updateConfig('notificationConfig', { smsEnabled: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="smsEnabled" className="ml-2 text-sm text-gray-700">
                    SMS Notifications
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="pushEnabled"
                    checked={config.notificationConfig.pushEnabled}
                    onChange={(e) => updateConfig('notificationConfig', { pushEnabled: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="pushEnabled" className="ml-2 text-sm text-gray-700">
                    Push Notifications
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="slackEnabled"
                    checked={config.notificationConfig.slackEnabled}
                    onChange={(e) => updateConfig('notificationConfig', { slackEnabled: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor="slackEnabled" className="ml-2 text-sm text-gray-700">
                    Slack Integration
                  </label>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Features Tab */}
        {activeTab === 'features' && (
          <Card title="Feature Flags">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { key: 'advancedAnalytics', label: 'Advanced Analytics' },
                { key: 'customReports', label: 'Custom Reports' },
                { key: 'dataExport', label: 'Data Export' },
                { key: 'dataImport', label: 'Data Import' },
                { key: 'bulkOperations', label: 'Bulk Operations' },
                { key: 'auditLog', label: 'Audit Log' },
                { key: 'apiAccess', label: 'API Access' },
                { key: 'mobileAccess', label: 'Mobile Access' },
                { key: 'offlineMode', label: 'Offline Mode' },
                { key: 'thirdPartyIntegrations', label: 'Third-Party Integrations' },
                { key: 'iotDeviceSupport', label: 'IoT Device Support' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center p-3 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    id={key}
                    checked={config.featureFlags[key as keyof FeatureFlagsConfig] as boolean}
                    onChange={(e) => updateConfig('featureFlags', { [key]: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <label htmlFor={key} className="ml-3 text-sm text-gray-700">
                    {label}
                  </label>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Data Retention Tab */}
        {activeTab === 'retention' && (
          <Card title="Data Retention Policies">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                { key: 'auditLogRetentionDays', label: 'Audit Log (days)' },
                { key: 'activityLogRetentionDays', label: 'Activity Log (days)' },
                { key: 'sensorDataRetentionDays', label: 'Sensor Data (days)' },
                { key: 'alertHistoryRetentionDays', label: 'Alert History (days)' },
                { key: 'backupRetentionDays', label: 'Backup (days)' },
              ].map(({ key, label }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {label}
                  </label>
                  <Input
                    type="number"
                    value={config.dataRetention[key as keyof DataRetentionConfig] as number}
                    onChange={(e) => updateConfig('dataRetention', { [key]: parseInt(e.target.value) })}
                  />
                </div>
              ))}
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="autoDeleteEnabled"
                  checked={config.dataRetention.autoDeleteEnabled}
                  onChange={(e) => updateConfig('dataRetention', { autoDeleteEnabled: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor="autoDeleteEnabled" className="ml-2 text-sm text-gray-700">
                  Auto-Delete Enabled
                </label>
              </div>
            </div>
          </Card>
        )}

        {/* Branding Tab */}
        {activeTab === 'branding' && (
          <div className="space-y-6">
            <Card title="Brand Identity">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Company Name
                  </label>
                  <Input
                    type="text"
                    value={config.brandingConfig.companyName}
                    onChange={(e) => updateConfig('brandingConfig', { companyName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Logo URL
                  </label>
                  <Input
                    type="url"
                    value={config.brandingConfig.logoUrl || ''}
                    onChange={(e) => updateConfig('brandingConfig', { logoUrl: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Support Email
                  </label>
                  <Input
                    type="email"
                    value={config.brandingConfig.supportEmail || ''}
                    onChange={(e) => updateConfig('brandingConfig', { supportEmail: e.target.value })}
                  />
                </div>
              </div>
            </Card>

            <Card title="Color Scheme">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                {[
                  { key: 'primaryColor', label: 'Primary Color' },
                  { key: 'secondaryColor', label: 'Secondary Color' },
                  { key: 'accentColor', label: 'Accent Color' },
                  { key: 'headerColor', label: 'Header Color' },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {label}
                    </label>
                    <div className="flex items-center space-x-2">
                      <input
                        type="color"
                        value={config.brandingConfig[key as keyof BrandingConfig] as string}
                        onChange={(e) => updateConfig('brandingConfig', { [key]: e.target.value })}
                        className="h-10 w-14 rounded cursor-pointer"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* API Key Modal */}
      {showApiKeyModal && (
        <Modal
          isOpen={showApiKeyModal}
          onClose={() => {
            setShowApiKeyModal(false);
            setNewApiKey(null);
          }}
          title="New API Key"
        >
          {newApiKey ? (
            <div className="space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 mb-2">
                  Save this key in a secure location!
                </p>
                <code className="block bg-white p-3 rounded border text-sm break-all">
                  {newApiKey}
                </code>
              </div>
              <Button
                variant="primary"
                fullWidth
                onClick={() => {
                  navigator.clipboard.writeText(newApiKey).catch(console.error);
                  setSaveSuccess(true);
                }}
              >
                Copy
              </Button>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!tenantId) return;
                const formData = new FormData(e.currentTarget);
                const keyName = formData.get('keyName') as string;
                try {
                  const result = await settingsApi.createTenantApiKey(tenantId, {
                    name: keyName,
                    scopes: ['read', 'write'],
                  });
                  setNewApiKey(result.apiKey);
                  // Reload config to get updated API keys list
                  loadConfiguration();
                } catch (err) {
                  console.error('Failed to create API key:', err);
                  setSaveError('Failed to create API key. Please try again.');
                }
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Key Name
                </label>
                <Input type="text" name="keyName" placeholder="Production API Key" required />
              </div>
              <div className="flex space-x-3">
                <Button type="submit" variant="primary" fullWidth>
                  Create
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  fullWidth
                  onClick={() => setShowApiKeyModal(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
};

export default TenantConfigurationPage;
