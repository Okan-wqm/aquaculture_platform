/**
 * The device page's broker connection for a sensor its data activates
 * (ADR-047): the username it connects as, or that it holds none yet, and the
 * action that issues it a new credential. Reissuing stops the old credential
 * at once, so the page asks first. The new connection is shown once, in a
 * dialog that holds the password only while it is open.
 */
import { isSensorMqttIdentityErrorCode } from '@aquaculture/shared-contracts';
import {
  Button,
  GraphQLClientError,
  Modal,
  useConfirm,
  useI18n,
  useToast,
} from '@aquaculture/shared-ui';
import { KeyRound } from 'lucide-react';
import React, { useState } from 'react';

import {
  type SensorMqttCredentials,
  useRotateMqttCredentials,
} from '../../hooks/useRotateMqttCredentials';

import { SensorMqttCredentialsPanel } from './SensorMqttCredentialsPanel';

export interface BrokerConnectionSectionProps {
  sensorId: string;
  /** The username the sensor connects as; null when it holds no credential. */
  mqttUsername: string | null;
  /** Whether the user's role may issue a credential (the resolver's @Roles). */
  canIssue: boolean;
  onIssued: (username: string) => void;
}

export function BrokerConnectionSection({
  sensorId,
  mqttUsername,
  canIssue,
  onIssued,
}: BrokerConnectionSectionProps): React.ReactElement {
  const { t } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const rotate = useRotateMqttCredentials();
  const [shown, setShown] = useState<SensorMqttCredentials | null>(null);

  const refusal = (error: unknown): string | undefined => {
    if (error instanceof GraphQLClientError && isSensorMqttIdentityErrorCode(error.code)) {
      return t(`sensor.mqtt.error.${error.code}`);
    }
    return error instanceof Error ? error.message : undefined;
  };

  const issue = async (): Promise<void> => {
    if (mqttUsername !== null) {
      const proceed = await confirm({
        title: t('sensor.mqtt.rotateConfirmTitle'),
        message: t('sensor.mqtt.rotateConfirm'),
        confirmText: t('sensor.mqtt.rotate'),
        variant: 'danger',
      });
      if (!proceed) return;
    }
    try {
      const credentials = await rotate.mutateAsync(sensorId);
      setShown(credentials);
      onIssued(credentials.username);
    } catch (error) {
      toast({
        title: t('sensor.mqtt.issueFailed'),
        description: refusal(error),
        variant: 'error',
      });
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-(--shadow-sd-sm) border border-gray-100 dark:border-gray-700 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('sensor.mqtt.title')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('sensor.mqtt.help')}</p>
        </div>
        {canIssue && (
          <Button
            leftIcon={<KeyRound className="w-4 h-4" />}
            onClick={() => void issue()}
            loading={rotate.isPending}
          >
            {mqttUsername === null ? t('sensor.mqtt.issue') : t('sensor.mqtt.rotate')}
          </Button>
        )}
      </div>
      <div className="mt-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('sensor.mqtt.username')}</p>
        <p className="font-mono text-sm text-gray-900 dark:text-gray-100">
          {mqttUsername ?? t('sensor.mqtt.noCredential')}
        </p>
      </div>
      {shown && (
        <Modal
          isOpen
          onClose={() => setShown(null)}
          size="lg"
          title={t('sensor.mqtt.issuedTitle')}
          footer={
            <div className="flex justify-end">
              <Button onClick={() => setShown(null)}>{t('sensor.mqtt.done')}</Button>
            </div>
          }
        >
          <SensorMqttCredentialsPanel credentials={shown} />
        </Modal>
      )}
    </div>
  );
}
