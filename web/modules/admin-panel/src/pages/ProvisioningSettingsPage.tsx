/**
 * Provisioning Settings Page
 *
 * Edge device provisioning configuration for Super Admin.
 * Manages API URL, MQTT broker, GitHub release, and agent version settings.
 */

import React, { useState, useCallback } from 'react';
import { Card, Button, Input, Alert } from '@aquaculture/shared-ui';
import { useAsyncData } from '../hooks';
import { systemSettingsApi } from '../services/adminApi';
import type {
  ProvisioningConfigPayload,
  ProvisioningConfigResponse,
} from '../services/api/settings';

// ============================================================================
// Types
// ============================================================================

interface ProvisioningConfig {
  'provisioning.api_url': string;
  'provisioning.mqtt_broker_host': string;
  'provisioning.mqtt_broker_port': string;
  'provisioning.github_release_url': string;
  'provisioning.github_repo': string;
  'provisioning.agent_default_version': string;
}

const DEFAULT_CONFIG: ProvisioningConfig = {
  'provisioning.api_url': '',
  'provisioning.mqtt_broker_host': '',
  'provisioning.mqtt_broker_port': '1883',
  'provisioning.github_release_url': '',
  'provisioning.github_repo': '',
  'provisioning.agent_default_version': 'latest',
};

// Map the camelCase backend response into the page's dotted-key form state.
function mapResponseToConfig(
  data: ProvisioningConfigResponse,
): Partial<ProvisioningConfig> {
  return {
    'provisioning.api_url': data.provisioningApiUrl || '',
    'provisioning.mqtt_broker_host': data.mqttBrokerHost || '',
    'provisioning.mqtt_broker_port': String(data.mqttBrokerPort || '1883'),
    'provisioning.github_release_url': data.githubReleaseUrl || '',
    'provisioning.github_repo': data.githubRepo || '',
    'provisioning.agent_default_version': data.agentDefaultVersion || '',
  };
}

// Map the page's dotted-key form state back into the camelCase write contract
// (ProvisioningConfigDto) — replaces the previous unsafe double cast.
function mapConfigToPayload(config: ProvisioningConfig): ProvisioningConfigPayload {
  return {
    provisioningApiUrl: config['provisioning.api_url'],
    mqttBrokerHost: config['provisioning.mqtt_broker_host'],
    mqttBrokerPort: parseInt(config['provisioning.mqtt_broker_port'], 10),
    githubReleaseUrl: config['provisioning.github_release_url'],
    githubRepo: config['provisioning.github_repo'],
    agentDefaultVersion: config['provisioning.agent_default_version'],
  };
}

// ============================================================================
// ProvisioningSettingsPage Component
// ============================================================================

const ProvisioningSettingsPage: React.FC = () => {
  const [config, setConfig] = useState<ProvisioningConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { loading, error, canRetry, retry } = useAsyncData(
    () => systemSettingsApi.getProvisioningConfig(),
    {
      onSuccess: (data) => {
        setConfig({
          ...DEFAULT_CONFIG,
          ...mapResponseToConfig(data),
        });
      },
    }
  );

  const handleChange = useCallback((key: keyof ProvisioningConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setFeedback(null);
  }, []);

  const handleSave = useCallback(async () => {
    // Basic validation
    const apiUrl = config['provisioning.api_url'];
    if (apiUrl && !apiUrl.match(/^https?:\/\/.+/)) {
      setFeedback({ type: 'error', message: 'Provisioning API URL must start with http:// or https://' });
      return;
    }

    const port = parseInt(config['provisioning.mqtt_broker_port'], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setFeedback({ type: 'error', message: 'MQTT port must be between 1 and 65535' });
      return;
    }

    const githubUrl = config['provisioning.github_release_url'];
    if (githubUrl && !githubUrl.match(/^https?:\/\/.+/)) {
      setFeedback({ type: 'error', message: 'GitHub Release URL must start with http:// or https://' });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      await systemSettingsApi.updateProvisioningConfig(mapConfigToPayload(config));
      setFeedback({ type: 'success', message: 'Provisioning ayarlari basariyla kaydedildi.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ayarlar kaydedilirken bir hata olustu.';
      setFeedback({ type: 'error', message });
    } finally {
      setSaving(false);
    }
  }, [config]);

  // Loading state
  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-200 rounded w-2/3" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <Alert type="error">
          <div className="flex items-center justify-between">
            <span>{error}</span>
            {canRetry && (
              <Button variant="outline" size="sm" onClick={retry}>
                Tekrar Dene
              </Button>
            )}
          </div>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Edge Agent Provisioning Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Edge device'larin otomatik kurulum ve kayit ayarlari
        </p>
      </div>

      {/* Feedback */}
      {feedback && (
        <Alert type={feedback.type === 'success' ? 'success' : 'error'}>
          {feedback.message}
        </Alert>
      )}

      {/* Settings Form */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">API & MQTT Settings</h2>
        <div className="space-y-4">
          <Input
            label="Provisioning API URL"
            value={config['provisioning.api_url']}
            onChange={(e) => handleChange('provisioning.api_url', e.target.value)}
            placeholder="https://api.platform.com"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="MQTT Broker Host"
              value={config['provisioning.mqtt_broker_host']}
              onChange={(e) => handleChange('provisioning.mqtt_broker_host', e.target.value)}
              placeholder="mqtt.platform.com"
            />
            <Input
              label="MQTT Broker Port"
              type="number"
              value={config['provisioning.mqtt_broker_port']}
              onChange={(e) => handleChange('provisioning.mqtt_broker_port', e.target.value)}
              placeholder="1883"
            />
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">GitHub & Agent Settings</h2>
        <div className="space-y-4">
          <Input
            label="GitHub Release URL"
            value={config['provisioning.github_release_url']}
            onChange={(e) => handleChange('provisioning.github_release_url', e.target.value)}
            placeholder="https://github.com/org/repo/releases"
          />
          <Input
            label="GitHub Repo"
            value={config['provisioning.github_repo']}
            onChange={(e) => handleChange('provisioning.github_repo', e.target.value)}
            placeholder="org/repo-name"
          />
          <Input
            label="Agent Default Version"
            value={config['provisioning.agent_default_version']}
            onChange={(e) => handleChange('provisioning.agent_default_version', e.target.value)}
            placeholder="latest"
          />
        </div>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} loading={saving}>
          Save Changes
        </Button>
      </div>
    </div>
  );
};

export default ProvisioningSettingsPage;
