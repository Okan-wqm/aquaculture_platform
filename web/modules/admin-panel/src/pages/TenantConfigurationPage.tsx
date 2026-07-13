/**
 * Tenant Configuration Page
 *
 * Tenant-level ayarlarin yonetimi icin sayfa.
 * Her tab kendi sub-resource endpoint'ini kullanir (granular GET/PUT).
 *
 * Sub-resources: user-limits, storage, api, api-keys, webhooks,
 * domain/branding, security (IP whitelist/blacklist), notifications,
 * features/modules, data-retention
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Card,
  Button,
  Badge,
  Input,
  Modal
} from '@aquaculture/shared-ui';
import { tenantConfigApi } from '../services/api/tenant-config';
import type {
  UserLimitsConfig,
  StorageConfig,
  ApiConfig,
  DataRetentionConfig,
  DomainConfig,
  BrandingConfig,
  TenantSecurityConfig,
  TenantNotificationConfig,
  FeatureFlagsConfig,
  WebhookConfig,
} from '../services/api/tenant-config';

// ============================================================================
// Tab Types
// ============================================================================

type TabType = 'limits' | 'storage' | 'api' | 'webhooks' | 'branding' | 'security' | 'notifications' | 'features' | 'retention';

// ============================================================================
// Helper: Alert Banner
// ============================================================================

const AlertBanner: React.FC<{
  type: 'success' | 'error';
  message: string;
  onDismiss: () => void;
}> = ({ type, message, onDismiss }) => {
  const colorMap = {
    success: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', btn: 'text-green-400 hover:text-green-600' },
    error: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', btn: 'text-red-400 hover:text-red-600' },
  };
  const c = colorMap[type];
  return (
    <div className={`${c.bg} border ${c.border} rounded-lg p-3 flex items-center justify-between`}>
      <span className={`${c.text} text-sm`}>{message}</span>
      <button onClick={onDismiss} className={`${c.btn} ml-4`}>
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
};

// ============================================================================
// Helper: Section Save Button
// ============================================================================

const SectionSaveButton: React.FC<{
  saving: boolean;
  onClick: () => void;
  label?: string;
}> = ({ saving, onClick, label = 'Save Changes' }) => (
  <div className="flex justify-end pt-4 border-t border-gray-200 mt-6">
    <Button variant="primary" onClick={onClick} loading={saving}>
      {label}
    </Button>
  </div>
);

// ============================================================================
// Helper: IP List Manager
// ============================================================================

const IpListManager: React.FC<{
  title: string;
  description: string;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  ips: string[];
  onAdd: (ip: string) => void;
  onRemove: (ip: string) => void;
  adding: boolean;
}> = ({ title, description, enabled, onToggleEnabled, ips, onAdd, onRemove, adding }) => {
  const [newIp, setNewIp] = useState('');

  const handleAdd = () => {
    const trimmed = newIp.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setNewIp('');
  };

  return (
    <Card title={title}>
      <p className="text-sm text-gray-500 mb-4">{description}</p>
      <div className="flex items-center mb-4">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggleEnabled(e.target.checked)}
          className="h-4 w-4 text-blue-600 rounded"
        />
        <span className="ml-2 text-sm text-gray-700">Enabled</span>
      </div>
      {enabled && (
        <>
          <div className="flex space-x-2 mb-4">
            <Input
              type="text"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              placeholder="192.168.1.0/24"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Button variant="primary" size="sm" onClick={handleAdd} loading={adding}>
              Add
            </Button>
          </div>
          <div className="space-y-2">
            {ips.length === 0 && (
              <p className="text-sm text-gray-400 italic">No IP addresses configured.</p>
            )}
            {ips.map((ip) => (
              <div key={ip} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                <code className="text-sm font-mono text-gray-700">{ip}</code>
                <Button variant="ghost" size="sm" className="text-red-600" onClick={() => onRemove(ip)}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const TenantConfigurationPage: React.FC = () => {
  const { tenantId } = useParams<{ tenantId: string }>();

  // Global UI state
  const [activeTab, setActiveTab] = useState<TabType>('limits');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Per-section data state
  const [userLimits, setUserLimits] = useState<UserLimitsConfig | null>(null);
  const [storageConfig, setStorageConfig] = useState<StorageConfig | null>(null);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [domainConfig, setDomainConfig] = useState<DomainConfig | null>(null);
  const [brandingConfig, setBrandingConfig] = useState<BrandingConfig | null>(null);
  const [securityConfig, setSecurityConfig] = useState<TenantSecurityConfig | null>(null);
  const [notificationConfig, setNotificationConfig] = useState<TenantNotificationConfig | null>(null);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlagsConfig | null>(null);
  const [dataRetention, setDataRetention] = useState<DataRetentionConfig | null>(null);

  // Section loading tracking
  const [sectionLoading, setSectionLoading] = useState(false);

  // Modals
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookConfig | null>(null);
  const [showDomainModal, setShowDomainModal] = useState(false);
  const [domainVerification, setDomainVerification] = useState<{ token: string; dnsRecord: string } | null>(null);

  // IP list operation state
  const [ipAdding, setIpAdding] = useState(false);

  // ---------------------------------------------------------------------------
  // Data Loading (per-tab, lazy)
  // ---------------------------------------------------------------------------

  const showFeedback = useCallback((type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    if (type === 'success') {
      setTimeout(() => setFeedback(null), 3000);
    }
  }, []);

  const loadTabData = useCallback(async (tab: TabType) => {
    if (!tenantId) return;
    setSectionLoading(true);
    try {
      switch (tab) {
        case 'limits': {
          const data = await tenantConfigApi.getUserLimits(tenantId);
          setUserLimits(data);
          break;
        }
        case 'storage': {
          const data = await tenantConfigApi.getStorageConfig(tenantId);
          setStorageConfig(data);
          break;
        }
        case 'api': {
          const data = await tenantConfigApi.getApiConfig(tenantId);
          setApiConfig(data);
          break;
        }
        case 'webhooks': {
          const data = await tenantConfigApi.getWebhooks(tenantId);
          setWebhooks(data);
          break;
        }
        case 'branding': {
          const [domain, branding] = await Promise.all([
            tenantConfigApi.getDomainConfig(tenantId),
            tenantConfigApi.getBrandingConfig(tenantId),
          ]);
          setDomainConfig(domain);
          setBrandingConfig(branding);
          break;
        }
        case 'security': {
          const data = await tenantConfigApi.getSecurityConfig(tenantId);
          setSecurityConfig(data);
          break;
        }
        case 'notifications': {
          const data = await tenantConfigApi.getNotificationConfig(tenantId);
          setNotificationConfig(data);
          break;
        }
        case 'features': {
          const data = await tenantConfigApi.getFeatureFlags(tenantId);
          setFeatureFlags(data);
          break;
        }
        case 'retention': {
          const data = await tenantConfigApi.getDataRetentionConfig(tenantId);
          setDataRetention(data);
          break;
        }
      }
    } catch (error) {
      console.error(`Failed to load ${tab} data:`, error);
      showFeedback('error', `Failed to load ${tab} data. Please try again.`);
    } finally {
      setSectionLoading(false);
    }
  }, [tenantId, showFeedback]);

  // Load data when tab changes
  useEffect(() => {
    loadTabData(activeTab);
  }, [activeTab, loadTabData]);

  // ---------------------------------------------------------------------------
  // Per-section Save Handlers
  // ---------------------------------------------------------------------------

  const saveUserLimits = async () => {
    if (!tenantId || !userLimits) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateUserLimits(tenantId, userLimits);
      setUserLimits(updated);
      showFeedback('success', 'User limits saved successfully.');
    } catch (error) {
      console.error('Failed to save user limits:', error);
      showFeedback('error', 'Failed to save user limits.');
    } finally {
      setSaving(false);
    }
  };

  const saveStorageConfig = async () => {
    if (!tenantId || !storageConfig) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateStorageConfig(tenantId, storageConfig);
      setStorageConfig(updated);
      showFeedback('success', 'Storage configuration saved successfully.');
    } catch (error) {
      console.error('Failed to save storage config:', error);
      showFeedback('error', 'Failed to save storage configuration.');
    } finally {
      setSaving(false);
    }
  };

  const saveApiConfig = async () => {
    if (!tenantId || !apiConfig) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateApiConfig(tenantId, {
        enabled: apiConfig.enabled,
        rateLimitPerMinute: apiConfig.rateLimitPerMinute,
        rateLimitPerHour: apiConfig.rateLimitPerHour,
        rateLimitPerDay: apiConfig.rateLimitPerDay,
        maxConcurrentRequests: apiConfig.maxConcurrentRequests,
        webhooksEnabled: apiConfig.webhooksEnabled,
        webhookRetryCount: apiConfig.webhookRetryCount,
      });
      setApiConfig(updated);
      showFeedback('success', 'API configuration saved successfully.');
    } catch (error) {
      console.error('Failed to save API config:', error);
      showFeedback('error', 'Failed to save API configuration.');
    } finally {
      setSaving(false);
    }
  };

  const saveBrandingConfig = async () => {
    if (!tenantId || !brandingConfig) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateBranding(tenantId, brandingConfig);
      setBrandingConfig(updated);
      showFeedback('success', 'Branding configuration saved successfully.');
    } catch (error) {
      console.error('Failed to save branding config:', error);
      showFeedback('error', 'Failed to save branding configuration.');
    } finally {
      setSaving(false);
    }
  };

  const saveSecurityConfig = async () => {
    if (!tenantId || !securityConfig) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateSecurityConfig(tenantId, securityConfig);
      setSecurityConfig(updated);
      showFeedback('success', 'Security configuration saved successfully.');
    } catch (error) {
      console.error('Failed to save security config:', error);
      showFeedback('error', 'Failed to save security configuration.');
    } finally {
      setSaving(false);
    }
  };

  const saveNotificationConfig = async () => {
    if (!tenantId || !notificationConfig) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateNotificationConfig(tenantId, notificationConfig);
      setNotificationConfig(updated);
      showFeedback('success', 'Notification configuration saved successfully.');
    } catch (error) {
      console.error('Failed to save notification config:', error);
      showFeedback('error', 'Failed to save notification configuration.');
    } finally {
      setSaving(false);
    }
  };

  const saveFeatureFlags = async () => {
    if (!tenantId || !featureFlags) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateFeatureFlags(tenantId, featureFlags);
      setFeatureFlags(updated);
      showFeedback('success', 'Feature flags saved successfully.');
    } catch (error) {
      console.error('Failed to save feature flags:', error);
      showFeedback('error', 'Failed to save feature flags.');
    } finally {
      setSaving(false);
    }
  };

  const saveDataRetention = async () => {
    if (!tenantId || !dataRetention) return;
    setSaving(true);
    try {
      const updated = await tenantConfigApi.updateDataRetentionConfig(tenantId, dataRetention);
      setDataRetention(updated);
      showFeedback('success', 'Data retention configuration saved successfully.');
    } catch (error) {
      console.error('Failed to save data retention config:', error);
      showFeedback('error', 'Failed to save data retention configuration.');
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // API Key Handlers
  // ---------------------------------------------------------------------------

  const handleCreateApiKey = async (name: string, scopes: string[]) => {
    if (!tenantId) return;
    try {
      const result = await tenantConfigApi.createTenantApiKey(tenantId, { name, scopes });
      setNewApiKey(result.apiKey);
      // Reload API config to get updated keys list
      const updated = await tenantConfigApi.getApiConfig(tenantId);
      setApiConfig(updated);
      showFeedback('success', 'API key created successfully.');
    } catch (error) {
      console.error('Failed to create API key:', error);
      showFeedback('error', 'Failed to create API key.');
    }
  };

  const handleRevokeApiKey = async (keyId: string) => {
    if (!tenantId) return;
    try {
      await tenantConfigApi.revokeTenantApiKey(tenantId, keyId);
      const updated = await tenantConfigApi.getApiConfig(tenantId);
      setApiConfig(updated);
      showFeedback('success', 'API key revoked.');
    } catch (error) {
      console.error('Failed to revoke API key:', error);
      showFeedback('error', 'Failed to revoke API key.');
    }
  };

  // ---------------------------------------------------------------------------
  // Webhook Handlers
  // ---------------------------------------------------------------------------

  const handleCreateWebhook = async (data: { name: string; url: string; events: string[]; secret?: string; retryEnabled?: boolean; retryCount?: number }) => {
    if (!tenantId) return;
    try {
      await tenantConfigApi.createWebhook(tenantId, data);
      const updated = await tenantConfigApi.getWebhooks(tenantId);
      setWebhooks(updated);
      setShowWebhookModal(false);
      showFeedback('success', 'Webhook created successfully.');
    } catch (error) {
      console.error('Failed to create webhook:', error);
      showFeedback('error', 'Failed to create webhook.');
    }
  };

  const handleUpdateWebhook = async (webhookId: string, updates: { name?: string; url?: string; events?: string[]; retryEnabled?: boolean; retryCount?: number }) => {
    if (!tenantId) return;
    try {
      await tenantConfigApi.updateWebhook(tenantId, webhookId, updates);
      const updated = await tenantConfigApi.getWebhooks(tenantId);
      setWebhooks(updated);
      setEditingWebhook(null);
      setShowWebhookModal(false);
      showFeedback('success', 'Webhook updated successfully.');
    } catch (error) {
      console.error('Failed to update webhook:', error);
      showFeedback('error', 'Failed to update webhook.');
    }
  };

  const handleDeleteWebhook = async (webhookId: string) => {
    if (!tenantId) return;
    try {
      await tenantConfigApi.deleteWebhook(tenantId, webhookId);
      setWebhooks(prev => prev.filter(w => w.id !== webhookId));
      showFeedback('success', 'Webhook deleted.');
    } catch (error) {
      console.error('Failed to delete webhook:', error);
      showFeedback('error', 'Failed to delete webhook.');
    }
  };

  // ---------------------------------------------------------------------------
  // Domain Verification Handlers
  // ---------------------------------------------------------------------------

  const handleInitiateDomainVerification = async (customDomain: string) => {
    if (!tenantId) return;
    try {
      const result = await tenantConfigApi.initiateCustomDomainVerification(tenantId, customDomain);
      setDomainVerification({ token: result.verificationToken, dnsRecord: result.dnsRecord });
      const updated = await tenantConfigApi.getDomainConfig(tenantId);
      setDomainConfig(updated);
      showFeedback('success', 'Domain verification initiated. Add the DNS record shown below.');
    } catch (error) {
      console.error('Failed to initiate domain verification:', error);
      showFeedback('error', 'Failed to initiate domain verification.');
    }
  };

  const handleConfirmDomain = async () => {
    if (!tenantId) return;
    try {
      const result = await tenantConfigApi.confirmCustomDomain(tenantId);
      if (result.verified) {
        const updated = await tenantConfigApi.getDomainConfig(tenantId);
        setDomainConfig(updated);
        setDomainVerification(null);
        setShowDomainModal(false);
        showFeedback('success', 'Custom domain verified successfully!');
      } else {
        showFeedback('error', 'Domain verification failed. Please check your DNS records.');
      }
    } catch (error) {
      console.error('Failed to confirm domain:', error);
      showFeedback('error', 'Failed to verify domain.');
    }
  };

  // ---------------------------------------------------------------------------
  // IP Whitelist / Blacklist Handlers
  // ---------------------------------------------------------------------------

  const handleAddToIpWhitelist = async (ip: string) => {
    if (!tenantId || !securityConfig) return;
    setIpAdding(true);
    try {
      const updated = await tenantConfigApi.addToIpWhitelist(tenantId, ip);
      setSecurityConfig({ ...securityConfig, ipWhitelist: updated });
    } catch (error) {
      console.error('Failed to add to IP whitelist:', error);
      showFeedback('error', 'Failed to add IP to whitelist.');
    } finally {
      setIpAdding(false);
    }
  };

  const handleRemoveFromIpWhitelist = async (ip: string) => {
    if (!tenantId || !securityConfig) return;
    try {
      const updated = await tenantConfigApi.removeFromIpWhitelist(tenantId, ip);
      setSecurityConfig({ ...securityConfig, ipWhitelist: updated });
    } catch (error) {
      console.error('Failed to remove from IP whitelist:', error);
      showFeedback('error', 'Failed to remove IP from whitelist.');
    }
  };

  const handleAddToIpBlacklist = async (ip: string) => {
    if (!tenantId || !securityConfig) return;
    setIpAdding(true);
    try {
      const updated = await tenantConfigApi.addToIpBlacklist(tenantId, ip);
      setSecurityConfig({ ...securityConfig, ipBlacklist: updated });
    } catch (error) {
      console.error('Failed to add to IP blacklist:', error);
      showFeedback('error', 'Failed to add IP to blacklist.');
    } finally {
      setIpAdding(false);
    }
  };

  const handleRemoveFromIpBlacklist = async (ip: string) => {
    if (!tenantId || !securityConfig) return;
    try {
      const updated = await tenantConfigApi.removeFromIpBlacklist(tenantId, ip);
      setSecurityConfig({ ...securityConfig, ipBlacklist: updated });
    } catch (error) {
      console.error('Failed to remove from IP blacklist:', error);
      showFeedback('error', 'Failed to remove IP from blacklist.');
    }
  };

  // ---------------------------------------------------------------------------
  // Module Enable/Disable Handlers
  // ---------------------------------------------------------------------------

  const handleToggleModule = async (moduleCode: string, enable: boolean) => {
    if (!tenantId) return;
    try {
      const updatedModules = enable
        ? await tenantConfigApi.enableModule(tenantId, moduleCode)
        : await tenantConfigApi.disableModule(tenantId, moduleCode);
      setFeatureFlags(prev => prev ? { ...prev, enabledModules: updatedModules } : prev);
    } catch (error) {
      console.error(`Failed to ${enable ? 'enable' : 'disable'} module:`, error);
      showFeedback('error', `Failed to ${enable ? 'enable' : 'disable'} module.`);
    }
  };

  // ---------------------------------------------------------------------------
  // Tab config
  // ---------------------------------------------------------------------------

  const tabs: { id: TabType; label: string; icon: string }[] = [
    { id: 'limits', label: 'User Limits', icon: '👥' },
    { id: 'storage', label: 'Storage', icon: '💾' },
    { id: 'api', label: 'API Configuration', icon: '🔌' },
    { id: 'webhooks', label: 'Webhooks', icon: '🔗' },
    { id: 'branding', label: 'Domain & Branding', icon: '🎨' },
    { id: 'security', label: 'Security', icon: '🔒' },
    { id: 'notifications', label: 'Notifications', icon: '🔔' },
    { id: 'features', label: 'Feature Flags', icon: '⚡' },
    { id: 'retention', label: 'Data Retention', icon: '📁' },
  ];

  // ---------------------------------------------------------------------------
  // Render: Loading spinner
  // ---------------------------------------------------------------------------

  const renderSectionLoading = () => (
    <div className="flex items-center justify-center h-48">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
    </div>
  );

  // ---------------------------------------------------------------------------
  // Render: User Limits Tab
  // ---------------------------------------------------------------------------

  const renderUserLimitsTab = () => {
    if (!userLimits) return renderSectionLoading();
    return (
      <Card title="User Limits">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Maximum Users</label>
            <Input
              type="number"
              value={userLimits.maxUsers}
              onChange={(e) => setUserLimits({ ...userLimits, maxUsers: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Maximum Admins</label>
            <Input
              type="number"
              value={userLimits.maxAdmins}
              onChange={(e) => setUserLimits({ ...userLimits, maxAdmins: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Max Module Managers</label>
            <Input
              type="number"
              value={userLimits.maxModuleManagers}
              onChange={(e) => setUserLimits({ ...userLimits, maxModuleManagers: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Max Concurrent Sessions</label>
            <Input
              type="number"
              value={userLimits.maxConcurrentSessions}
              onChange={(e) => setUserLimits({ ...userLimits, maxConcurrentSessions: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Session Timeout (min)</label>
            <Input
              type="number"
              value={userLimits.sessionTimeoutMinutes}
              onChange={(e) => setUserLimits({ ...userLimits, sessionTimeoutMinutes: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Inactive Cleanup (days)</label>
            <Input
              type="number"
              value={userLimits.inactiveUserCleanupDays}
              onChange={(e) => setUserLimits({ ...userLimits, inactiveUserCleanupDays: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="allowGuestAccess"
              checked={userLimits.allowGuestAccess}
              onChange={(e) => setUserLimits({ ...userLimits, allowGuestAccess: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded"
            />
            <label htmlFor="allowGuestAccess" className="ml-2 text-sm text-gray-700">
              Allow Guest Access
            </label>
          </div>
        </div>
        <SectionSaveButton saving={saving} onClick={saveUserLimits} />
      </Card>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Storage Tab
  // ---------------------------------------------------------------------------

  const renderStorageTab = () => {
    if (!storageConfig) return renderSectionLoading();
    const usagePercent = storageConfig.totalStorageGB > 0
      ? (storageConfig.usedStorageGB / storageConfig.totalStorageGB) * 100
      : 0;
    return (
      <Card title="Storage Settings">
        <div className="mb-6">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-600">Used Space</span>
            <span className="font-medium">
              {storageConfig.usedStorageGB} GB / {storageConfig.totalStorageGB} GB
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-blue-600'}`}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Total Storage (GB)</label>
            <Input
              type="number"
              value={storageConfig.totalStorageGB}
              onChange={(e) => setStorageConfig({ ...storageConfig, totalStorageGB: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Max File Size (MB)</label>
            <Input
              type="number"
              value={storageConfig.maxFileSizeMB}
              onChange={(e) => setStorageConfig({ ...storageConfig, maxFileSizeMB: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Version Retention Count</label>
            <Input
              type="number"
              value={storageConfig.versionRetentionCount}
              onChange={(e) => setStorageConfig({ ...storageConfig, versionRetentionCount: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="enableFileVersioning"
              checked={storageConfig.enableFileVersioning}
              onChange={(e) => setStorageConfig({ ...storageConfig, enableFileVersioning: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded"
            />
            <label htmlFor="enableFileVersioning" className="ml-2 text-sm text-gray-700">
              File Versioning
            </label>
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="compressionEnabled"
              checked={storageConfig.compressionEnabled}
              onChange={(e) => setStorageConfig({ ...storageConfig, compressionEnabled: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded"
            />
            <label htmlFor="compressionEnabled" className="ml-2 text-sm text-gray-700">
              Compression Enabled
            </label>
          </div>
        </div>
        <SectionSaveButton saving={saving} onClick={saveStorageConfig} />
      </Card>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: API Configuration Tab
  // ---------------------------------------------------------------------------

  const renderApiTab = () => {
    if (!apiConfig) return renderSectionLoading();
    return (
      <div className="space-y-6">
        <Card title="API Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="apiEnabled"
                checked={apiConfig.enabled}
                onChange={(e) => setApiConfig({ ...apiConfig, enabled: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="apiEnabled" className="ml-2 text-sm text-gray-700">
                API Access Enabled
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Rate Limit / Minute</label>
              <Input
                type="number"
                value={apiConfig.rateLimitPerMinute}
                onChange={(e) => setApiConfig({ ...apiConfig, rateLimitPerMinute: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Rate Limit / Hour</label>
              <Input
                type="number"
                value={apiConfig.rateLimitPerHour}
                onChange={(e) => setApiConfig({ ...apiConfig, rateLimitPerHour: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Rate Limit / Day</label>
              <Input
                type="number"
                value={apiConfig.rateLimitPerDay}
                onChange={(e) => setApiConfig({ ...apiConfig, rateLimitPerDay: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Max Concurrent Requests</label>
              <Input
                type="number"
                value={apiConfig.maxConcurrentRequests}
                onChange={(e) => setApiConfig({ ...apiConfig, maxConcurrentRequests: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Webhook Retry Count</label>
              <Input
                type="number"
                value={apiConfig.webhookRetryCount}
                onChange={(e) => setApiConfig({ ...apiConfig, webhookRetryCount: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <SectionSaveButton saving={saving} onClick={saveApiConfig} />
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
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Used</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {(apiConfig.apiKeys || []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                      No API keys configured. Click "New Key" to create one.
                    </td>
                  </tr>
                )}
                {(apiConfig.apiKeys || []).map((key) => (
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
                        {key.isActive ? 'Active' : 'Revoked'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      {key.isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600"
                          onClick={() => handleRevokeApiKey(key.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Webhooks Tab
  // ---------------------------------------------------------------------------

  const renderWebhooksTab = () => {
    return (
      <Card
        title="Webhooks"
        headerAction={
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setEditingWebhook(null); setShowWebhookModal(true); }}
          >
            Add Webhook
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">URL</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Events</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Triggered</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {webhooks.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                    No webhooks configured. Click "Add Webhook" to create one.
                  </td>
                </tr>
              )}
              {webhooks.map((webhook) => (
                <tr key={webhook.id}>
                  <td className="px-4 py-3 text-sm text-gray-900">{webhook.name}</td>
                  <td className="px-4 py-3 text-sm font-mono text-gray-600 max-w-xs truncate">
                    {webhook.url}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap gap-1">
                      {webhook.events.slice(0, 3).map(e => (
                        <Badge key={e} variant="default">{e}</Badge>
                      ))}
                      {webhook.events.length > 3 && (
                        <Badge variant="default">+{webhook.events.length - 3}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={webhook.isActive ? 'success' : 'error'}>
                      {webhook.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                    {webhook.lastStatus && (
                      <Badge
                        variant={webhook.lastStatus === 'success' ? 'success' : 'error'}
                        className="ml-1"
                      >
                        {webhook.lastStatus}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {webhook.lastTriggeredAt
                      ? new Date(webhook.lastTriggeredAt).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex space-x-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setEditingWebhook(webhook); setShowWebhookModal(true); }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        onClick={() => handleDeleteWebhook(webhook.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Domain & Branding Tab
  // ---------------------------------------------------------------------------

  const renderBrandingTab = () => {
    if (!domainConfig || !brandingConfig) return renderSectionLoading();
    return (
      <div className="space-y-6">
        {/* Domain Configuration */}
        <Card
          title="Custom Domain"
          headerAction={
            <Button variant="secondary" size="sm" onClick={() => setShowDomainModal(true)}>
              {domainConfig.customDomain ? 'Change Domain' : 'Add Custom Domain'}
            </Button>
          }
        >
          {domainConfig.customDomain ? (
            <div className="space-y-3">
              <div className="flex items-center space-x-3">
                <span className="text-sm font-medium text-gray-700">Domain:</span>
                <code className="bg-gray-100 px-2 py-1 rounded text-sm">{domainConfig.customDomain}</code>
                <Badge variant={domainConfig.customDomainVerified ? 'success' : 'warning'}>
                  {domainConfig.customDomainVerified ? 'Verified' : 'Pending Verification'}
                </Badge>
              </div>
              {domainConfig.subdomain && (
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-medium text-gray-700">Subdomain:</span>
                  <code className="bg-gray-100 px-2 py-1 rounded text-sm">{domainConfig.subdomain}</code>
                </div>
              )}
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="redirectToCustomDomain"
                  checked={domainConfig.redirectToCustomDomain}
                  onChange={(e) => setDomainConfig({ ...domainConfig, redirectToCustomDomain: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor="redirectToCustomDomain" className="ml-2 text-sm text-gray-700">
                  Redirect to custom domain
                </label>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No custom domain configured.</p>
          )}
        </Card>

        {/* Brand Identity */}
        <Card title="Brand Identity">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Company Name</label>
              <Input
                type="text"
                value={brandingConfig.companyName}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, companyName: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Logo URL</label>
              <Input
                type="url"
                value={brandingConfig.logoUrl || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, logoUrl: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Favicon URL</label>
              <Input
                type="url"
                value={brandingConfig.faviconUrl || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, faviconUrl: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Font Family</label>
              <Input
                type="text"
                value={brandingConfig.fontFamily}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, fontFamily: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Support Email</label>
              <Input
                type="email"
                value={brandingConfig.supportEmail || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, supportEmail: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Support Phone</label>
              <Input
                type="text"
                value={brandingConfig.supportPhone || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, supportPhone: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Privacy Policy URL</label>
              <Input
                type="url"
                value={brandingConfig.privacyPolicyUrl || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, privacyPolicyUrl: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Terms of Service URL</label>
              <Input
                type="url"
                value={brandingConfig.termsOfServiceUrl || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, termsOfServiceUrl: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Login Background URL</label>
              <Input
                type="url"
                value={brandingConfig.loginBackgroundUrl || ''}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, loginBackgroundUrl: e.target.value })}
              />
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="showPoweredBy"
                checked={brandingConfig.showPoweredBy}
                onChange={(e) => setBrandingConfig({ ...brandingConfig, showPoweredBy: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="showPoweredBy" className="ml-2 text-sm text-gray-700">
                Show "Powered By" Badge
              </label>
            </div>
          </div>
        </Card>

        {/* Color Scheme */}
        <Card title="Color Scheme">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { key: 'primaryColor' as const, label: 'Primary Color' },
              { key: 'secondaryColor' as const, label: 'Secondary Color' },
              { key: 'accentColor' as const, label: 'Accent Color' },
              { key: 'headerColor' as const, label: 'Header Color' },
            ].map(({ key, label }) => (
              <div key={key}>
                <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
                <div className="flex items-center space-x-2">
                  <input
                    type="color"
                    value={brandingConfig[key] as string}
                    onChange={(e) => setBrandingConfig({ ...brandingConfig, [key]: e.target.value })}
                    className="h-10 w-14 rounded cursor-pointer"
                  />
                  <span className="text-xs font-mono text-gray-500">{brandingConfig[key]}</span>
                </div>
              </div>
            ))}
          </div>
          <SectionSaveButton saving={saving} onClick={saveBrandingConfig} />
        </Card>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Security Tab
  // ---------------------------------------------------------------------------

  const renderSecurityTab = () => {
    if (!securityConfig) return renderSectionLoading();
    return (
      <div className="space-y-6">
        <Card title="Multi-Factor Authentication (MFA)">
          <div className="space-y-4">
            {/* ADR-042: "Require MFA for All Users" is managed by the tenant's
                own admin (tenant-admin module → auth-service policy), not by
                SUPER_ADMIN. The old checkbox wrote to a fabricated field that
                nothing enforced. */}
            <p className="text-sm text-gray-500">
              MFA enforcement for all users is managed by the tenant&apos;s own
              administrator (Tenant Admin → Security Policy).
            </p>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="mfaRequiredForAdmins"
                checked={securityConfig.mfaRequiredForAdmins}
                onChange={(e) => setSecurityConfig({ ...securityConfig, mfaRequiredForAdmins: e.target.checked })}
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
              <label className="block text-sm font-medium text-gray-700 mb-2">Minimum Password Length</label>
              <Input
                type="number"
                value={securityConfig.passwordMinLength}
                onChange={(e) => setSecurityConfig({ ...securityConfig, passwordMinLength: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password Expiry (days, 0 = never)</label>
              <Input
                type="number"
                value={securityConfig.passwordExpiryDays}
                onChange={(e) => setSecurityConfig({ ...securityConfig, passwordExpiryDays: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password History Count</label>
              <Input
                type="number"
                value={securityConfig.passwordHistoryCount}
                onChange={(e) => setSecurityConfig({ ...securityConfig, passwordHistoryCount: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="flex flex-col space-y-2">
              {[
                { key: 'passwordRequireUppercase' as const, label: 'Require uppercase' },
                { key: 'passwordRequireLowercase' as const, label: 'Require lowercase' },
                { key: 'passwordRequireNumbers' as const, label: 'Require numbers' },
                { key: 'passwordRequireSpecialChars' as const, label: 'Require special characters' },
                { key: 'preventCommonPasswords' as const, label: 'Prevent common passwords' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center">
                  <input
                    type="checkbox"
                    checked={securityConfig[key] as boolean}
                    onChange={(e) => setSecurityConfig({ ...securityConfig, [key]: e.target.checked })}
                    className="h-4 w-4 text-blue-600 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Login & Session Security">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Max Failed Login Attempts</label>
              <Input
                type="number"
                value={securityConfig.maxLoginAttempts}
                onChange={(e) => setSecurityConfig({ ...securityConfig, maxLoginAttempts: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Account Lockout Duration (min)</label>
              <Input
                type="number"
                value={securityConfig.lockoutDurationMinutes}
                onChange={(e) => setSecurityConfig({ ...securityConfig, lockoutDurationMinutes: parseInt(e.target.value) || 0 })}
              />
            </div>
            {/* ADR-042: session timeout is managed by the tenant's own admin
                (auth-service policy — it clamps refresh-token TTL); the old
                input wrote to a fabricated field that nothing enforced. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Session Timeout (min)</label>
              <p className="text-sm text-gray-500">
                Managed by the tenant&apos;s administrator (Tenant Admin → Security Policy).
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Remember Me (days)</label>
              <Input
                type="number"
                value={securityConfig.rememberMeDays}
                onChange={(e) => setSecurityConfig({ ...securityConfig, rememberMeDays: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="singleSessionPerUser"
                checked={securityConfig.singleSessionPerUser}
                onChange={(e) => setSecurityConfig({ ...securityConfig, singleSessionPerUser: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="singleSessionPerUser" className="ml-2 text-sm text-gray-700">
                Single Session Per User
              </label>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="terminateSessionsOnPasswordChange"
                checked={securityConfig.terminateSessionsOnPasswordChange}
                onChange={(e) => setSecurityConfig({ ...securityConfig, terminateSessionsOnPasswordChange: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="terminateSessionsOnPasswordChange" className="ml-2 text-sm text-gray-700">
                Terminate Sessions on Password Change
              </label>
            </div>
          </div>
        </Card>

        {/* IP Whitelist */}
        <IpListManager
          title="IP Whitelist"
          description="Only allow access from these IP addresses/ranges."
          enabled={securityConfig.ipWhitelistEnabled}
          onToggleEnabled={(enabled) => setSecurityConfig({ ...securityConfig, ipWhitelistEnabled: enabled })}
          ips={securityConfig.ipWhitelist}
          onAdd={handleAddToIpWhitelist}
          onRemove={handleRemoveFromIpWhitelist}
          adding={ipAdding}
        />

        {/* IP Blacklist */}
        <IpListManager
          title="IP Blacklist"
          description="Block access from these IP addresses/ranges."
          enabled={securityConfig.ipBlacklistEnabled}
          onToggleEnabled={(enabled) => setSecurityConfig({ ...securityConfig, ipBlacklistEnabled: enabled })}
          ips={securityConfig.ipBlacklist}
          onAdd={handleAddToIpBlacklist}
          onRemove={handleRemoveFromIpBlacklist}
          adding={ipAdding}
        />

        <SectionSaveButton saving={saving} onClick={saveSecurityConfig} label="Save Security Settings" />
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Notifications Tab
  // ---------------------------------------------------------------------------

  const renderNotificationsTab = () => {
    if (!notificationConfig) return renderSectionLoading();
    return (
      <div className="space-y-6">
        <Card title="Email Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="emailEnabled"
                checked={notificationConfig.emailEnabled}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, emailEnabled: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="emailEnabled" className="ml-2 text-sm text-gray-700">
                Email Notifications Enabled
              </label>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="customSmtpEnabled"
                checked={notificationConfig.customSmtpEnabled}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, customSmtpEnabled: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="customSmtpEnabled" className="ml-2 text-sm text-gray-700">
                Custom SMTP
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Sender Name</label>
              <Input
                type="text"
                value={notificationConfig.emailFromName || ''}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, emailFromName: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Sender Email Address</label>
              <Input
                type="email"
                value={notificationConfig.emailFromAddress || ''}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, emailFromAddress: e.target.value })}
              />
            </div>
          </div>
        </Card>

        <Card title="Notification Channels">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="smsEnabled"
                checked={notificationConfig.smsEnabled}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, smsEnabled: e.target.checked })}
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
                checked={notificationConfig.pushEnabled}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, pushEnabled: e.target.checked })}
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
                checked={notificationConfig.slackEnabled}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, slackEnabled: e.target.checked })}
                className="h-4 w-4 text-blue-600 rounded"
              />
              <label htmlFor="slackEnabled" className="ml-2 text-sm text-gray-700">
                Slack Integration
              </label>
            </div>
          </div>
          {notificationConfig.slackEnabled && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Slack Webhook URL</label>
                <Input
                  type="url"
                  value={notificationConfig.slackWebhookUrl || ''}
                  onChange={(e) => setNotificationConfig({ ...notificationConfig, slackWebhookUrl: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Default Channel</label>
                <Input
                  type="text"
                  value={notificationConfig.slackDefaultChannel || ''}
                  onChange={(e) => setNotificationConfig({ ...notificationConfig, slackDefaultChannel: e.target.value })}
                  placeholder="#general"
                />
              </div>
            </div>
          )}
        </Card>

        <Card title="Notification Preferences">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Digest Frequency</label>
              <select
                value={notificationConfig.digestFrequency}
                onChange={(e) => setNotificationConfig({ ...notificationConfig, digestFrequency: e.target.value })}
                className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm p-2 border"
              >
                <option value="realtime">Real-time</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="space-y-3">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="quietHoursEnabled"
                  checked={notificationConfig.quietHoursEnabled}
                  onChange={(e) => setNotificationConfig({ ...notificationConfig, quietHoursEnabled: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor="quietHoursEnabled" className="ml-2 text-sm text-gray-700">
                  Enable Quiet Hours
                </label>
              </div>
              {notificationConfig.quietHoursEnabled && (
                <div className="flex space-x-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Start</label>
                    <Input
                      type="time"
                      value={notificationConfig.quietHoursStart || '22:00'}
                      onChange={(e) => setNotificationConfig({ ...notificationConfig, quietHoursStart: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">End</label>
                    <Input
                      type="time"
                      value={notificationConfig.quietHoursEnd || '08:00'}
                      onChange={(e) => setNotificationConfig({ ...notificationConfig, quietHoursEnd: e.target.value })}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        <SectionSaveButton saving={saving} onClick={saveNotificationConfig} label="Save Notification Settings" />
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Feature Flags Tab
  // ---------------------------------------------------------------------------

  const renderFeaturesTab = () => {
    if (!featureFlags) return renderSectionLoading();

    const availableModules = [
      { code: 'sensor', label: 'Sensor Module' },
      { code: 'farm', label: 'Farm Module' },
      { code: 'hr', label: 'HR Module' },
      { code: 'hydroponics', label: 'Hydroponics Module' },
      { code: 'alert', label: 'Alert Module' },
      { code: 'billing', label: 'Billing Module' },
      { code: 'config', label: 'Config Module' },
    ];

    const featureToggles: { key: keyof FeatureFlagsConfig; label: string }[] = [
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
      { key: 'customIntegrations', label: 'Custom Integrations' },
      { key: 'iotDeviceSupport', label: 'IoT Device Support' },
    ];

    return (
      <div className="space-y-6">
        {/* Module Management */}
        <Card title="Enabled Modules">
          <p className="text-sm text-gray-500 mb-4">
            Toggle modules on/off for this tenant. Changes take effect immediately.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {availableModules.map(({ code, label }) => {
              const isEnabled = featureFlags.enabledModules.includes(code);
              return (
                <div key={code} className={`flex items-center justify-between p-3 rounded-lg ${isEnabled ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
                  <span className="text-sm text-gray-700">{label}</span>
                  <button
                    onClick={() => handleToggleModule(code, !isEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isEnabled ? 'bg-green-600' : 'bg-gray-300'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Feature Toggles */}
        <Card title="Feature Toggles">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {featureToggles.map(({ key, label }) => (
              <div key={key} className="flex items-center p-3 bg-gray-50 rounded-lg">
                <input
                  type="checkbox"
                  id={key}
                  checked={featureFlags[key] as boolean}
                  onChange={(e) => setFeatureFlags({ ...featureFlags, [key]: e.target.checked })}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor={key} className="ml-3 text-sm text-gray-700">
                  {label}
                </label>
              </div>
            ))}
          </div>
          <SectionSaveButton saving={saving} onClick={saveFeatureFlags} />
        </Card>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Data Retention Tab
  // ---------------------------------------------------------------------------

  const renderRetentionTab = () => {
    if (!dataRetention) return renderSectionLoading();

    const retentionFields: { key: keyof DataRetentionConfig; label: string }[] = [
      { key: 'auditLogRetentionDays', label: 'Audit Log (days)' },
      { key: 'activityLogRetentionDays', label: 'Activity Log (days)' },
      { key: 'sensorDataRetentionDays', label: 'Sensor Data (days)' },
      { key: 'alertHistoryRetentionDays', label: 'Alert History (days)' },
      { key: 'deletedDataRetentionDays', label: 'Deleted Data (days)' },
      { key: 'backupRetentionDays', label: 'Backup (days)' },
    ];

    return (
      <Card title="Data Retention Policies">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {retentionFields.map(({ key, label }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
              <Input
                type="number"
                value={dataRetention[key] as number}
                onChange={(e) => setDataRetention({ ...dataRetention, [key]: parseInt(e.target.value) || 0 })}
              />
            </div>
          ))}
          <div className="flex items-center">
            <input
              type="checkbox"
              id="autoDeleteEnabled"
              checked={dataRetention.autoDeleteEnabled}
              onChange={(e) => setDataRetention({ ...dataRetention, autoDeleteEnabled: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded"
            />
            <label htmlFor="autoDeleteEnabled" className="ml-2 text-sm text-gray-700">
              Auto-Delete Enabled
            </label>
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="archiveBeforeDelete"
              checked={dataRetention.archiveBeforeDelete}
              onChange={(e) => setDataRetention({ ...dataRetention, archiveBeforeDelete: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded"
            />
            <label htmlFor="archiveBeforeDelete" className="ml-2 text-sm text-gray-700">
              Archive Before Delete
            </label>
          </div>
        </div>
        <SectionSaveButton saving={saving} onClick={saveDataRetention} />
      </Card>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Tab Content Switcher
  // ---------------------------------------------------------------------------

  const renderTabContent = () => {
    if (sectionLoading) return renderSectionLoading();

    switch (activeTab) {
      case 'limits': return renderUserLimitsTab();
      case 'storage': return renderStorageTab();
      case 'api': return renderApiTab();
      case 'webhooks': return renderWebhooksTab();
      case 'branding': return renderBrandingTab();
      case 'security': return renderSecurityTab();
      case 'notifications': return renderNotificationsTab();
      case 'features': return renderFeaturesTab();
      case 'retention': return renderRetentionTab();
      default: return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Main Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant Configuration</h1>
          <p className="text-gray-500 mt-1">Tenant ID: {tenantId}</p>
        </div>
      </div>

      {/* Feedback alert */}
      {feedback && (
        <AlertBanner
          type={feedback.type}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
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
        {renderTabContent()}
      </div>

      {/* API Key Modal */}
      {showApiKeyModal && (
        <Modal
          isOpen={showApiKeyModal}
          onClose={() => { setShowApiKeyModal(false); setNewApiKey(null); }}
          title="New API Key"
        >
          {newApiKey ? (
            <div className="space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 mb-2">
                  Save this key in a secure location! It will not be shown again.
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
                  showFeedback('success', 'API key copied to clipboard.');
                }}
              >
                Copy to Clipboard
              </Button>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                const keyName = formData.get('keyName') as string;
                const scopesRaw = formData.get('keyScopes') as string;
                const scopes = scopesRaw ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean) : ['read', 'write'];
                await handleCreateApiKey(keyName, scopes);
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Key Name</label>
                <Input type="text" name="keyName" placeholder="Production API Key" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Permissions (comma-separated)
                </label>
                <Input type="text" name="keyScopes" placeholder="read, write" defaultValue="read, write" />
              </div>
              <div className="flex space-x-3">
                <Button type="submit" variant="primary" fullWidth>
                  Create
                </Button>
                <Button type="button" variant="secondary" fullWidth onClick={() => setShowApiKeyModal(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {/* Webhook Modal */}
      {showWebhookModal && (
        <Modal
          isOpen={showWebhookModal}
          onClose={() => { setShowWebhookModal(false); setEditingWebhook(null); }}
          title={editingWebhook ? 'Edit Webhook' : 'Add Webhook'}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              const name = formData.get('webhookName') as string;
              const url = formData.get('webhookUrl') as string;
              const eventsRaw = formData.get('webhookEvents') as string;
              const events = eventsRaw ? eventsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
              const secret = formData.get('webhookSecret') as string;
              const retryEnabled = (formData.get('webhookRetry') as string) === 'on';
              const retryCount = parseInt(formData.get('webhookRetryCount') as string) || 3;

              if (editingWebhook) {
                await handleUpdateWebhook(editingWebhook.id, { name, url, events, retryEnabled, retryCount });
              } else {
                await handleCreateWebhook({ name, url, events, secret: secret || undefined, retryEnabled, retryCount });
              }
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Webhook Name</label>
              <Input type="text" name="webhookName" placeholder="Order notifications" defaultValue={editingWebhook?.name || ''} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">URL</label>
              <Input type="url" name="webhookUrl" placeholder="https://example.com/webhook" defaultValue={editingWebhook?.url || ''} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Events (comma-separated)</label>
              <Input type="text" name="webhookEvents" placeholder="user.created, alert.triggered" defaultValue={editingWebhook?.events?.join(', ') || ''} />
            </div>
            {!editingWebhook && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Secret (optional)</label>
                <Input type="password" name="webhookSecret" placeholder="Webhook signing secret" />
              </div>
            )}
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  name="webhookRetry"
                  id="webhookRetry"
                  defaultChecked={editingWebhook?.retryEnabled ?? true}
                  className="h-4 w-4 text-blue-600 rounded"
                />
                <label htmlFor="webhookRetry" className="ml-2 text-sm text-gray-700">
                  Enable Retries
                </label>
              </div>
              <div>
                <Input
                  type="number"
                  name="webhookRetryCount"
                  placeholder="3"
                  defaultValue={editingWebhook?.retryCount ?? 3}
                />
              </div>
            </div>
            <div className="flex space-x-3">
              <Button type="submit" variant="primary" fullWidth>
                {editingWebhook ? 'Update' : 'Create'}
              </Button>
              <Button type="button" variant="secondary" fullWidth onClick={() => { setShowWebhookModal(false); setEditingWebhook(null); }}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Domain Verification Modal */}
      {showDomainModal && (
        <Modal
          isOpen={showDomainModal}
          onClose={() => { setShowDomainModal(false); setDomainVerification(null); }}
          title="Custom Domain Setup"
        >
          {domainVerification ? (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-800 mb-2">
                  Add the following DNS TXT record to verify domain ownership:
                </p>
                <code className="block bg-white p-3 rounded border text-sm break-all">
                  {domainVerification.dnsRecord}
                </code>
              </div>
              <p className="text-sm text-gray-500">
                After adding the DNS record, click "Verify" to confirm ownership.
              </p>
              <div className="flex space-x-3">
                <Button variant="primary" fullWidth onClick={handleConfirmDomain}>
                  Verify Domain
                </Button>
                <Button variant="secondary" fullWidth onClick={() => { setShowDomainModal(false); setDomainVerification(null); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                const domain = formData.get('customDomain') as string;
                await handleInitiateDomainVerification(domain);
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Custom Domain</label>
                <Input
                  type="text"
                  name="customDomain"
                  placeholder="app.yourdomain.com"
                  defaultValue={domainConfig?.customDomain || ''}
                  required
                />
              </div>
              <div className="flex space-x-3">
                <Button type="submit" variant="primary" fullWidth>
                  Start Verification
                </Button>
                <Button type="button" variant="secondary" fullWidth onClick={() => setShowDomainModal(false)}>
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
