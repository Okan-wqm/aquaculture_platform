/**
 * System Settings Page
 *
 * Platform configuration and settings management for Super Admin.
 *
 * Data layer (ORPHAN-HIGH-373): settings are read from and written to
 * config-service through the gateway's federated GraphQL
 * (effectiveConfigurationsByService / setConfiguration) via
 * hooks/usePlatformConfiguration.ts — the legacy admin-api settings
 * endpoints are retired (410 Gone). Only the SMTP test send and the
 * system-info panel remain on live admin-api REST endpoints.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Card, Button, Input, Select, Alert } from '@aquaculture/shared-ui';
import { useAsyncData } from '../hooks';
import {
  usePlatformSettings,
  useSavePlatformSettings,
} from '../hooks/usePlatformConfiguration';
import {
  DEFAULT_PLATFORM_SETTINGS,
  buildBillingWrites,
  buildEmailWrites,
  buildGeneralWrites,
  buildRateLimitWrites,
  buildSecurityWrites,
} from '../services/api/platform-configuration';
import type {
  BillingConfig,
  EmailConfig,
  RateLimitsConfig,
  SecurityConfig,
} from '../services/api/platform-configuration';
import { settingsApi } from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface SystemInfo {
  platform?: Record<string, unknown>;
  server?: Record<string, unknown>;
  database?: Record<string, unknown>;
}

type TabId = 'general' | 'email' | 'security' | 'billing' | 'ratelimit' | 'system';

// ============================================================================
// Constants
// ============================================================================

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: 'cog' },
  { id: 'email', label: 'Email', icon: 'mail' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'billing', label: 'Billing', icon: 'credit-card' },
  { id: 'ratelimit', label: 'Rate Limit', icon: 'clock' },
  { id: 'system', label: 'System Info', icon: 'server' },
];

const SMTP_SECURE_OPTIONS = [
  { value: 'false', label: 'STARTTLS / Auto' },
  { value: 'true', label: 'SSL/TLS' },
];

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'TRY', label: 'TRY - Turkish Lira' },
  { value: 'GBP', label: 'GBP - British Pound' },
];

// ============================================================================
// Icons
// ============================================================================

const TabIcon: React.FC<{ name: string; className?: string }> = ({ name, className = 'w-4 h-4' }) => {
  const icons: Record<string, React.ReactNode> = {
    cog: (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    mail: (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    shield: (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    'credit-card': (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
    clock: (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    server: (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
      </svg>
    ),
  };
  return <>{icons[name] || null}</>;
};

// ============================================================================
// Form Components
// ============================================================================

interface FormSectionProps {
  title: string;
  children: React.ReactNode;
  onSave?: () => void;
  saving?: boolean;
}

const FormSection: React.FC<FormSectionProps> = ({ title, children, onSave, saving }) => (
  <Card className="p-6">
    <h2 className="text-lg font-semibold mb-4">{title}</h2>
    <div className="space-y-4">
      {children}
      {onSave && (
        <div className="flex justify-end pt-4 border-t">
          <Button onClick={onSave} loading={saving}>
            Save Changes
          </Button>
        </div>
      )}
    </div>
  </Card>
);

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

const CheckboxField: React.FC<CheckboxFieldProps> = ({ label, checked, onChange, disabled }) => (
  <label className="flex items-center space-x-2 cursor-pointer">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
    />
    <span className="text-sm text-gray-700">{label}</span>
  </label>
);

interface InfoGridProps {
  data: Record<string, unknown>;
  columns?: number;
}

const InfoGrid: React.FC<InfoGridProps> = ({ data, columns = 4 }) => (
  <div className={`grid grid-cols-2 md:grid-cols-${columns} gap-4`}>
    {Object.entries(data).map(([key, value]) => (
      <div key={key}>
        <p className="text-xs text-gray-500 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</p>
        <p className="font-medium text-gray-900 text-sm break-all">{String(value)}</p>
      </div>
    ))}
  </div>
);

// ============================================================================
// Tab Content Components
// ============================================================================

interface GeneralTabProps {
  platformName: string;
  platformVersion: string;
  maintenanceMode: boolean;
  onMaintenanceChange: (enabled: boolean) => void;
  onSave: () => void;
  saving: boolean;
}

const GeneralTab: React.FC<GeneralTabProps> = ({
  platformName,
  platformVersion,
  maintenanceMode,
  onMaintenanceChange,
  onSave,
  saving,
}) => (
  <FormSection title="General Settings" onSave={onSave} saving={saving}>
    <Input label="Platform Name" value={platformName} disabled />
    <Input label="Platform Version" value={platformVersion} disabled />
    <CheckboxField
      label="Maintenance Mode (Only Super Admin can access when enabled)"
      checked={maintenanceMode}
      onChange={onMaintenanceChange}
    />
  </FormSection>
);

interface EmailTabProps {
  config: EmailConfig;
  onChange: (config: EmailConfig) => void;
  onSave: () => void;
  onTest: () => void;
  saving: boolean;
  testing: boolean;
}

const EmailTab: React.FC<EmailTabProps> = ({ config, onChange, onSave, onTest, saving, testing }) => (
  <FormSection title="Email Settings" onSave={onSave} saving={saving}>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Input
        label="SMTP Host"
        value={config.smtpHost}
        onChange={(e) => onChange({ ...config, smtpHost: e.target.value })}
        placeholder="smtp.example.com"
      />
      <Input
        label="SMTP Port"
        type="number"
        value={config.smtpPort}
        onChange={(e) => onChange({ ...config, smtpPort: parseInt(e.target.value) || 587 })}
      />
      <Input
        label="SMTP Username"
        value={config.smtpUsername}
        onChange={(e) => onChange({ ...config, smtpUsername: e.target.value })}
      />
      <Select
        label="SMTP Security"
        value={String(config.smtpSecure)}
        onChange={(e) => onChange({ ...config, smtpSecure: e.target.value === 'true' })}
        options={SMTP_SECURE_OPTIONS}
      />
      <Input
        label="SMTP Password"
        type="password"
        value={config.smtpPassword ?? ''}
        onChange={(e) => onChange({ ...config, smtpPassword: e.target.value })}
        placeholder={config.hasSmtpPassword ? 'Existing password saved' : 'Enter SMTP password'}
      />
      <Input
        label="From Email"
        type="email"
        value={config.fromAddress}
        onChange={(e) => onChange({ ...config, fromAddress: e.target.value })}
        placeholder="noreply@example.com"
      />
      <Input
        label="From Name"
        value={config.fromName}
        onChange={(e) => onChange({ ...config, fromName: e.target.value })}
        placeholder="Aquaculture Platform"
      />
    </div>
    <div className="mt-4 flex justify-end">
      <Button
        variant="outline"
        onClick={onTest}
        loading={testing}
        disabled={!config.fromAddress || testing}
      >
        Send Test
      </Button>
    </div>
  </FormSection>
);

interface SecurityTabProps {
  config: SecurityConfig;
  onChange: (config: SecurityConfig) => void;
  onSave: () => void;
  saving: boolean;
}

const SecurityTab: React.FC<SecurityTabProps> = ({ config, onChange, onSave, saving }) => (
  <FormSection title="Security Settings" onSave={onSave} saving={saving}>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Input
        label="Session Timeout (minutes)"
        type="number"
        value={config.sessionTimeoutMinutes}
        onChange={(e) => onChange({ ...config, sessionTimeoutMinutes: parseInt(e.target.value) || 480 })}
      />
      <Input
        label="Max Login Attempts"
        type="number"
        value={config.maxLoginAttempts}
        onChange={(e) => onChange({ ...config, maxLoginAttempts: parseInt(e.target.value) || 5 })}
      />
      <Input
        label="Lockout Duration (minutes)"
        type="number"
        value={config.lockoutDurationMinutes}
        onChange={(e) => onChange({ ...config, lockoutDurationMinutes: parseInt(e.target.value) || 30 })}
      />
      <Input
        label="Min Password Length"
        type="number"
        value={config.passwordMinLength}
        onChange={(e) => onChange({ ...config, passwordMinLength: parseInt(e.target.value) || 8 })}
      />
    </div>
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-700">Password Requirements</p>
      <div className="flex flex-wrap gap-4">
        <CheckboxField
          label="Uppercase letter"
          checked={config.passwordRequireUppercase}
          onChange={(checked) => onChange({ ...config, passwordRequireUppercase: checked })}
        />
        <CheckboxField
          label="Number"
          checked={config.passwordRequireNumbers}
          onChange={(checked) => onChange({ ...config, passwordRequireNumbers: checked })}
        />
        <CheckboxField
          label="Special character"
          checked={config.passwordRequireSymbols}
          onChange={(checked) => onChange({ ...config, passwordRequireSymbols: checked })}
        />
      </div>
    </div>
    <CheckboxField
      label="Enable Two-Factor Authentication (MFA)"
      checked={config.mfaEnabled}
      onChange={(checked) => onChange({ ...config, mfaEnabled: checked })}
    />
    <CheckboxField
      label="Enforce HTTPS"
      checked={config.enforceHttps}
      onChange={(checked) => onChange({ ...config, enforceHttps: checked })}
    />
  </FormSection>
);

interface BillingTabProps {
  config: BillingConfig;
  onChange: (config: BillingConfig) => void;
  onSave: () => void;
  saving: boolean;
}

const BillingTab: React.FC<BillingTabProps> = ({ config, onChange, onSave, saving }) => (
  <FormSection title="Billing Settings" onSave={onSave} saving={saving}>
    <CheckboxField
      label="Enable Stripe Payments"
      checked={config.stripeEnabled}
      onChange={(checked) => onChange({ ...config, stripeEnabled: checked })}
    />
    {config.stripeEnabled && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label="Stripe Public Key"
          value={config.stripePublicKey}
          onChange={(e) => onChange({ ...config, stripePublicKey: e.target.value })}
          placeholder="pk_..."
        />
        <Input
          label="Stripe Secret Key"
          type="password"
          value={config.stripeSecretKey}
          onChange={(e) => onChange({ ...config, stripeSecretKey: e.target.value })}
          placeholder="sk_..."
        />
      </div>
    )}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Select
        label="Currency"
        value={config.defaultCurrency}
        onChange={(e) => onChange({ ...config, defaultCurrency: e.target.value })}
        options={CURRENCY_OPTIONS}
      />
      <Input
        label="Tax Rate (%)"
        type="number"
        value={config.taxRate}
        onChange={(e) => onChange({ ...config, taxRate: parseFloat(e.target.value) || 0 })}
      />
    </div>
  </FormSection>
);

interface RateLimitTabProps {
  config: RateLimitsConfig;
  onChange: (config: RateLimitsConfig) => void;
  onSave: () => void;
  saving: boolean;
}

const RateLimitTab: React.FC<RateLimitTabProps> = ({ config, onChange, onSave, saving }) => (
  <FormSection title="API Rate Limit Settings" onSave={onSave} saving={saving}>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Input
        label="Global Limit (requests/minute)"
        type="number"
        value={config.globalRpm}
        onChange={(e) => onChange({ ...config, globalRpm: parseInt(e.target.value) || 1000 })}
      />
      <Input
        label="Per User Limit (requests/minute)"
        type="number"
        value={config.perUserRpm}
        onChange={(e) => onChange({ ...config, perUserRpm: parseInt(e.target.value) || 100 })}
      />
      <Input
        label="Per Tenant Limit (requests/minute)"
        type="number"
        value={config.perTenantRpm}
        onChange={(e) => onChange({ ...config, perTenantRpm: parseInt(e.target.value) || 500 })}
      />
      <Input
        label="API Key Limit (requests/minute)"
        type="number"
        value={config.apiKeyRpm}
        onChange={(e) => onChange({ ...config, apiKeyRpm: parseInt(e.target.value) || 60 })}
      />
    </div>
  </FormSection>
);

interface SystemInfoTabProps {
  info: SystemInfo | null;
  onRefresh: () => void;
}

const SystemInfoTab: React.FC<SystemInfoTabProps> = ({ info, onRefresh }) => {
  if (!info) {
    return (
      <Card className="p-6 text-center text-gray-500">
        System information not available
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {info.platform && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Platform Information</h2>
          <InfoGrid data={info.platform} />
        </Card>
      )}
      {info.server && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Server Information</h2>
          <InfoGrid data={info.server} />
        </Card>
      )}
      {info.database && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Database Information</h2>
          <InfoGrid data={info.database} columns={3} />
        </Card>
      )}
      <div className="flex justify-end">
        <Button variant="outline" onClick={onRefresh}>
          Refresh Info
        </Button>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const SystemSettingsPage: React.FC = () => {
  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [testingEmail, setTestingEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form states (locally edited copies of the loaded snapshot)
  const [maintenanceMode, setMaintenanceMode] = useState(
    DEFAULT_PLATFORM_SETTINGS.general.maintenanceMode,
  );
  const [emailConfig, setEmailConfig] = useState<EmailConfig>(DEFAULT_PLATFORM_SETTINGS.email);
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig>(
    DEFAULT_PLATFORM_SETTINGS.security,
  );
  const [billingConfig, setBillingConfig] = useState<BillingConfig>(
    DEFAULT_PLATFORM_SETTINGS.billing,
  );
  const [rateLimits, setRateLimits] = useState<RateLimitsConfig>(
    DEFAULT_PLATFORM_SETTINGS.rateLimits,
  );

  // config-service read (federated GraphQL through the gateway)
  const { settings, isLoading, error: loadError, refetch } = usePlatformSettings();
  const saveSettings = useSavePlatformSettings();

  // Sync editable form state whenever a fresh snapshot lands (initial load and
  // post-save invalidation refetch). Secrets stay write-only empty inputs.
  useEffect(() => {
    if (!settings) return;
    setMaintenanceMode(settings.general.maintenanceMode);
    setEmailConfig({ ...settings.email, smtpPassword: '' });
    setSecurityConfig(settings.security);
    setBillingConfig({ ...settings.billing, stripeSecretKey: '' });
    setRateLimits(settings.rateLimits);
  }, [settings]);

  // Fetch system info (still a live admin-api REST endpoint)
  const fetchSystemInfo = useCallback(async () => {
    return settingsApi.getSystemInfo() as Promise<SystemInfo>;
  }, []);

  const {
    data: systemInfo,
    refresh: refreshSystemInfo,
  } = useAsyncData<SystemInfo>(fetchSystemInfo, {
    cacheKey: 'system-info',
    cacheTTL: 30000,
    immediate: activeTab === 'system',
  });

  // Save handlers with feedback
  const saveWithFeedback = async (
    saveFn: () => Promise<unknown>,
    successMessage: string
  ): Promise<void> => {
    setError(null);
    setSuccess(null);
    try {
      await saveFn();
      setSuccess(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const saving = saveSettings.isPending;

  const handleSaveGeneral = () =>
    saveWithFeedback(
      () => saveSettings.mutateAsync(buildGeneralWrites(maintenanceMode)),
      'General settings saved',
    );

  const handleSaveEmail = () =>
    saveWithFeedback(
      () => saveSettings.mutateAsync(buildEmailWrites(emailConfig)),
      'Email settings saved',
    );

  const handleTestEmail = async () => {
    setTestingEmail(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await settingsApi.testEmailConfig(emailConfig.fromAddress);
      if (result.success === false) {
        throw new Error(typeof result.error === 'string' ? result.error : 'SMTP test failed');
      }
      setSuccess('SMTP test email sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SMTP test failed');
    } finally {
      setTestingEmail(false);
    }
  };

  const handleSaveSecurity = () =>
    saveWithFeedback(
      () => saveSettings.mutateAsync(buildSecurityWrites(securityConfig)),
      'Security settings saved',
    );

  const handleSaveBilling = () =>
    saveWithFeedback(
      () => saveSettings.mutateAsync(buildBillingWrites(billingConfig)),
      'Billing settings saved',
    );

  const handleSaveRateLimits = () =>
    saveWithFeedback(
      () => saveSettings.mutateAsync(buildRateLimitWrites(rateLimits)),
      'Rate limit settings saved',
    );

  // Loading skeleton
  if (isLoading && !settings) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Settings</h1>
          <p className="mt-1 text-sm text-gray-500">Platform configuration and settings</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            refetch();
          }}
          disabled={isLoading}
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </Button>
      </div>

      {/* Alerts */}
      {loadError && (
        <Alert type="error">
          Failed to load platform settings: {loadError.message}
        </Alert>
      )}
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert type="success" dismissible onDismiss={() => setSuccess(null)}>
          {success}
        </Alert>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-4 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <TabIcon name={tab.icon} className="w-4 h-4 mr-2" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === 'general' && (
          <GeneralTab
            platformName={settings?.general.platformName ?? DEFAULT_PLATFORM_SETTINGS.general.platformName}
            platformVersion={settings?.general.platformVersion ?? DEFAULT_PLATFORM_SETTINGS.general.platformVersion}
            maintenanceMode={maintenanceMode}
            onMaintenanceChange={setMaintenanceMode}
            onSave={handleSaveGeneral}
            saving={saving}
          />
        )}

        {activeTab === 'email' && (
          <EmailTab
            config={emailConfig}
            onChange={setEmailConfig}
            onSave={handleSaveEmail}
            onTest={handleTestEmail}
            saving={saving}
            testing={testingEmail}
          />
        )}

        {activeTab === 'security' && (
          <SecurityTab
            config={securityConfig}
            onChange={setSecurityConfig}
            onSave={handleSaveSecurity}
            saving={saving}
          />
        )}

        {activeTab === 'billing' && (
          <BillingTab
            config={billingConfig}
            onChange={setBillingConfig}
            onSave={handleSaveBilling}
            saving={saving}
          />
        )}

        {activeTab === 'ratelimit' && (
          <RateLimitTab
            config={rateLimits}
            onChange={setRateLimits}
            onSave={handleSaveRateLimits}
            saving={saving}
          />
        )}

        {activeTab === 'system' && (
          <SystemInfoTab
            info={systemInfo}
            onRefresh={refreshSystemInfo}
          />
        )}
      </div>
    </div>
  );
};

export default SystemSettingsPage;
