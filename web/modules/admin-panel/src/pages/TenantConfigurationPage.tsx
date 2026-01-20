/**
 * Tenant Configuration Page
 *
 * Tenant-level ayarların yönetimi için sayfa.
 * User limits, storage, API, branding, security ve notification ayarları.
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
  const [activeTab, setActiveTab] = useState<TabType>('limits');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);

  useEffect(() => {
    loadConfiguration();
  }, [tenantId]);

  const loadConfiguration = async () => {
    try {
      setLoading(true);
      // Mock data - replace with API call
      const mockConfig: TenantConfiguration = {
        id: '1',
        tenantId: tenantId || '',
        userLimits: {
          maxUsers: 50,
          maxAdmins: 5,
          maxModuleManagers: 10,
          maxConcurrentSessions: 3,
          sessionTimeoutMinutes: 480,
          inactiveUserCleanupDays: 90,
          allowGuestAccess: false,
        },
        storageConfig: {
          totalStorageGB: 100,
          usedStorageGB: 45.5,
          maxFileSizeMB: 100,
          allowedFileTypes: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'jpg', 'png'],
          enableFileVersioning: true,
          versionRetentionCount: 5,
          compressionEnabled: true,
        },
        apiConfig: {
          enabled: true,
          rateLimitPerMinute: 100,
          rateLimitPerHour: 1000,
          rateLimitPerDay: 10000,
          maxConcurrentRequests: 10,
          apiKeys: [
            {
              id: '1',
              name: 'Production API Key',
              prefix: 'aq_prod_',
              permissions: ['read', 'write'],
              createdAt: '2024-01-01',
              isActive: true,
            },
          ],
          webhooksEnabled: true,
          webhookRetryCount: 3,
          ipWhitelist: [],
        },
        dataRetention: {
          auditLogRetentionDays: 90,
          activityLogRetentionDays: 30,
          sensorDataRetentionDays: 365,
          alertHistoryRetentionDays: 180,
          deletedDataRetentionDays: 30,
          backupRetentionDays: 30,
          autoDeleteEnabled: true,
          archiveBeforeDelete: true,
        },
        domainConfig: {
          customDomain: 'app.example.com',
          customDomainVerified: true,
          subdomain: 'acme',
          redirectToCustomDomain: true,
          allowedOrigins: ['https://example.com'],
        },
        brandingConfig: {
          logoUrl: 'https://example.com/logo.png',
          primaryColor: '#3B82F6',
          secondaryColor: '#6B7280',
          accentColor: '#10B981',
          headerColor: '#1F2937',
          fontFamily: 'Inter',
          companyName: 'ACME Corp',
          supportEmail: 'support@acme.com',
          showPoweredBy: false,
        },
        securityConfig: {
          mfaRequired: true,
          mfaRequiredForAdmins: true,
          allowedMfaMethods: ['totp', 'email'],
          ssoEnabled: false,
          passwordMinLength: 12,
          passwordRequireUppercase: true,
          passwordRequireLowercase: true,
          passwordRequireNumbers: true,
          passwordRequireSpecialChars: true,
          passwordExpiryDays: 90,
          ipWhitelistEnabled: false,
          ipWhitelist: [],
          ipBlacklistEnabled: false,
          ipBlacklist: [],
          geoBlockingEnabled: false,
          allowedCountries: [],
          blockedCountries: [],
          maxLoginAttempts: 5,
          lockoutDurationMinutes: 30,
          sessionTimeoutMinutes: 480,
          singleSessionPerUser: false,
        },
        notificationConfig: {
          emailEnabled: true,
          emailFromName: 'ACME Support',
          emailFromAddress: 'noreply@acme.com',
          customSmtpEnabled: true,
          smsEnabled: false,
          pushEnabled: true,
          slackEnabled: true,
          slackWebhookUrl: 'https://hooks.slack.com/...',
          webhookEnabled: true,
          digestFrequency: 'daily',
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
        },
        featureFlags: {
          enabledModules: ['farm', 'sensor', 'alert', 'hr', 'billing'],
          advancedAnalytics: true,
          customReports: true,
          dataExport: true,
          dataImport: true,
          bulkOperations: true,
          auditLog: true,
          apiAccess: true,
          mobileAccess: true,
          offlineMode: false,
          thirdPartyIntegrations: true,
          customIntegrations: false,
          iotDeviceSupport: true,
          betaFeatures: [],
        },
        createdAt: '2024-01-01',
        updatedAt: '2024-03-15',
      };
      setConfig(mockConfig);
    } catch (error) {
      console.error('Failed to load configuration:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    try {
      setSaving(true);
      await new Promise(resolve => setTimeout(resolve, 1000));
      alert('Configuration saved successfully!');
    } catch (error) {
      console.error('Failed to save configuration:', error);
      alert('Failed to save configuration');
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
    { id: 'limits', label: 'Kullanıcı Limitleri', icon: '👥' },
    { id: 'storage', label: 'Depolama', icon: '💾' },
    { id: 'api', label: 'API & Webhooks', icon: '🔌' },
    { id: 'branding', label: 'Marka & Görünüm', icon: '🎨' },
    { id: 'security', label: 'Güvenlik', icon: '🔒' },
    { id: 'notifications', label: 'Bildirimler', icon: '🔔' },
    { id: 'features', label: 'Özellikler', icon: '⚡' },
    { id: 'retention', label: 'Veri Saklama', icon: '📁' },
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
          <h1 className="text-2xl font-bold text-gray-900">Tenant Konfigürasyonu</h1>
          <p className="text-gray-500 mt-1">Tenant ID: {tenantId}</p>
        </div>
        <Button
          variant="primary"
          onClick={handleSave}
          loading={saving}
        >
          Değişiklikleri Kaydet
        </Button>
      </div>

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
          <Card title="Kullanıcı Limitleri">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maksimum Kullanıcı
                </label>
                <Input
                  type="number"
                  value={config.userLimits.maxUsers}
                  onChange={(e) => updateConfig('userLimits', { maxUsers: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maksimum Admin
                </label>
                <Input
                  type="number"
                  value={config.userLimits.maxAdmins}
                  onChange={(e) => updateConfig('userLimits', { maxAdmins: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maks. Eş Zamanlı Oturum
                </label>
                <Input
                  type="number"
                  value={config.userLimits.maxConcurrentSessions}
                  onChange={(e) => updateConfig('userLimits', { maxConcurrentSessions: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Oturum Zaman Aşımı (dk)
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
                  Misafir Erişimine İzin Ver
                </label>
              </div>
            </div>
          </Card>
        )}

        {/* Storage Tab */}
        {activeTab === 'storage' && (
          <Card title="Depolama Ayarları">
            <div className="mb-6">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">Kullanılan Alan</span>
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
                  Toplam Depolama (GB)
                </label>
                <Input
                  type="number"
                  value={config.storageConfig.totalStorageGB}
                  onChange={(e) => updateConfig('storageConfig', { totalStorageGB: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Maks. Dosya Boyutu (MB)
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
                  Dosya Versiyonlama
                </label>
              </div>
            </div>
          </Card>
        )}

        {/* API Tab */}
        {activeTab === 'api' && (
          <div className="space-y-6">
            <Card title="API Ayarları">
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
                    API Erişimi Aktif
                  </label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Rate Limit / Dakika
                  </label>
                  <Input
                    type="number"
                    value={config.apiConfig.rateLimitPerMinute}
                    onChange={(e) => updateConfig('apiConfig', { rateLimitPerMinute: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Rate Limit / Saat
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
              title="API Anahtarları"
              headerAction={
                <Button variant="primary" size="sm" onClick={() => setShowApiKeyModal(true)}>
                  Yeni Anahtar
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ad</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Prefix</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">İzinler</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">İşlemler</th>
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
                            {key.isActive ? 'Aktif' : 'Pasif'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Button variant="ghost" size="sm" className="text-red-600">
                            İptal Et
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
            <Card title="Çok Faktörlü Kimlik Doğrulama (MFA)">
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
                    Tüm Kullanıcılar İçin MFA Zorunlu
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
                    Adminler İçin MFA Zorunlu
                  </label>
                </div>
              </div>
            </Card>

            <Card title="Şifre Politikası">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Minimum Şifre Uzunluğu
                  </label>
                  <Input
                    type="number"
                    value={config.securityConfig.passwordMinLength}
                    onChange={(e) => updateConfig('securityConfig', { passwordMinLength: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Şifre Süresi (gün)
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
                    <span className="ml-2 text-sm text-gray-700">Büyük harf zorunlu</span>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.securityConfig.passwordRequireNumbers}
                      onChange={(e) => updateConfig('securityConfig', { passwordRequireNumbers: e.target.checked })}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">Rakam zorunlu</span>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={config.securityConfig.passwordRequireSpecialChars}
                      onChange={(e) => updateConfig('securityConfig', { passwordRequireSpecialChars: e.target.checked })}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">Özel karakter zorunlu</span>
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Giriş Güvenliği">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Maks. Başarısız Giriş Denemesi
                  </label>
                  <Input
                    type="number"
                    value={config.securityConfig.maxLoginAttempts}
                    onChange={(e) => updateConfig('securityConfig', { maxLoginAttempts: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Hesap Kilitleme Süresi (dk)
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
                    Kullanıcı Başına Tek Oturum
                  </label>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Notifications Tab */}
        {activeTab === 'notifications' && (
          <div className="space-y-6">
            <Card title="Email Ayarları">
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
                    Email Bildirimleri Aktif
                  </label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Gönderen Adı
                  </label>
                  <Input
                    type="text"
                    value={config.notificationConfig.emailFromName || ''}
                    onChange={(e) => updateConfig('notificationConfig', { emailFromName: e.target.value })}
                  />
                </div>
              </div>
            </Card>

            <Card title="Diğer Bildirim Kanalları">
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
                    SMS Bildirimleri
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
                    Push Bildirimleri
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
                    Slack Entegrasyonu
                  </label>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Features Tab */}
        {activeTab === 'features' && (
          <Card title="Özellik Bayrakları">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { key: 'advancedAnalytics', label: 'Gelişmiş Analitik' },
                { key: 'customReports', label: 'Özel Raporlar' },
                { key: 'dataExport', label: 'Veri Dışa Aktarma' },
                { key: 'dataImport', label: 'Veri İçe Aktarma' },
                { key: 'bulkOperations', label: 'Toplu İşlemler' },
                { key: 'auditLog', label: 'Denetim Günlüğü' },
                { key: 'apiAccess', label: 'API Erişimi' },
                { key: 'mobileAccess', label: 'Mobil Erişim' },
                { key: 'offlineMode', label: 'Çevrimdışı Mod' },
                { key: 'thirdPartyIntegrations', label: '3. Parti Entegrasyonlar' },
                { key: 'iotDeviceSupport', label: 'IoT Cihaz Desteği' },
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
          <Card title="Veri Saklama Politikaları">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                { key: 'auditLogRetentionDays', label: 'Denetim Günlüğü (gün)' },
                { key: 'activityLogRetentionDays', label: 'Aktivite Günlüğü (gün)' },
                { key: 'sensorDataRetentionDays', label: 'Sensör Verisi (gün)' },
                { key: 'alertHistoryRetentionDays', label: 'Alarm Geçmişi (gün)' },
                { key: 'backupRetentionDays', label: 'Yedekleme (gün)' },
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
                  Otomatik Silme Aktif
                </label>
              </div>
            </div>
          </Card>
        )}

        {/* Branding Tab */}
        {activeTab === 'branding' && (
          <div className="space-y-6">
            <Card title="Marka Kimliği">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Şirket Adı
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
                    Destek Email
                  </label>
                  <Input
                    type="email"
                    value={config.brandingConfig.supportEmail || ''}
                    onChange={(e) => updateConfig('brandingConfig', { supportEmail: e.target.value })}
                  />
                </div>
              </div>
            </Card>

            <Card title="Renk Şeması">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                {[
                  { key: 'primaryColor', label: 'Ana Renk' },
                  { key: 'secondaryColor', label: 'İkincil Renk' },
                  { key: 'accentColor', label: 'Vurgu Rengi' },
                  { key: 'headerColor', label: 'Header Rengi' },
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
          title="Yeni API Anahtarı"
        >
          {newApiKey ? (
            <div className="space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 mb-2">
                  Bu anahtarı güvenli bir yere kaydedin!
                </p>
                <code className="block bg-white p-3 rounded border text-sm break-all">
                  {newApiKey}
                </code>
              </div>
              <Button
                variant="primary"
                fullWidth
                onClick={() => {
                  navigator.clipboard.writeText(newApiKey);
                  alert('Anahtar panoya kopyalandı!');
                }}
              >
                Kopyala
              </Button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setNewApiKey('aq_prod_xxxxxxxxxxxxxxxxxxxxxxxxxxxx');
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Anahtar Adı
                </label>
                <Input type="text" placeholder="Production API Key" required />
              </div>
              <div className="flex space-x-3">
                <Button type="submit" variant="primary" fullWidth>
                  Oluştur
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  fullWidth
                  onClick={() => setShowApiKeyModal(false)}
                >
                  İptal
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
