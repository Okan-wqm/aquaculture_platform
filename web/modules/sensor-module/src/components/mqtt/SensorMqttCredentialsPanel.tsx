/**
 * How a sensor connects to the platform broker with its own credential
 * (ADR-047 §8), shown once: when the sensor is registered and each time its
 * credential is reissued. The password is not stored and cannot be read
 * again, so the panel says so and offers each value to copy. The device
 * contract follows: the settings the broker expects and the shape of a
 * message, with the channel keys the sensor names its values by.
 */
import { Button, useI18n } from '@aquaculture/shared-ui';
import { Check, Copy } from 'lucide-react';
import React, { useState } from 'react';

import type { SensorMqttCredentials } from '../../hooks/useRotateMqttCredentials';

export interface SensorMqttCredentialsPanelProps {
  credentials: SensorMqttCredentials;
  /** The keys the sensor's channels read in a message; an example payload is shown when given. */
  channelKeys?: readonly string[];
}

function CopyValue({ label, value }: { label: string; value: string }): React.ReactElement {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // A browser that refuses the clipboard leaves the value on screen to select.
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
        <p className="font-mono text-sm break-all text-gray-900 dark:text-gray-100">{value}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        onClick={() => void copy()}
        aria-label={`${t('sensor.mqtt.copy')} ${label}`}
      >
        {copied ? t('sensor.mqtt.copied') : t('sensor.mqtt.copy')}
      </Button>
    </div>
  );
}

export function SensorMqttCredentialsPanel({
  credentials,
  channelKeys = [],
}: SensorMqttCredentialsPanelProps): React.ReactElement {
  const { t } = useI18n();
  const example = channelKeys.length
    ? JSON.stringify(Object.fromEntries(channelKeys.map((key) => [key, 0])), null, 2)
    : null;
  return (
    <div className="space-y-4">
      <p
        role="alert"
        className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800 dark:border-warning-800 dark:bg-warning-900 dark:text-warning-200"
      >
        {t('sensor.mqtt.shownOnce')}
      </p>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        <CopyValue label={t('sensor.mqtt.host')} value={credentials.host} />
        <CopyValue
          label={t('sensor.mqtt.port')}
          value={
            credentials.tls
              ? t('sensor.mqtt.portTls', { port: credentials.port })
              : String(credentials.port)
          }
        />
        <CopyValue label={t('sensor.mqtt.clientId')} value={credentials.clientId} />
        <CopyValue label={t('sensor.mqtt.username')} value={credentials.username} />
        <CopyValue label={t('sensor.mqtt.password')} value={credentials.password} />
        <CopyValue label={t('sensor.mqtt.topic')} value={credentials.topic} />
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('sensor.mqtt.settings')}</p>
      {example && (
        <div>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('sensor.mqtt.payload')}</p>
          <pre className="mt-2 rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-100">
            {example}
          </pre>
        </div>
      )}
    </div>
  );
}
