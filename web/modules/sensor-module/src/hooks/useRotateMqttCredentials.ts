/**
 * Issue a sensor its own broker credential, replacing the one it holds
 * (`rotateSensorMqttCredentials`, ADR-047 §6). The answer is the only copy
 * of the password: the mutation keeps no state once the page lets go of it
 * (gcTime 0), and the page holds it in component state alone, so no client
 * cache retains it.
 */
import { useTenantMutation } from '@aquaculture/shared-ui';
import type { UseMutationResult } from '@tanstack/react-query';

import { graphqlFetch } from '../config/api';

/** How a sensor connects with its own broker principal; shown once. */
export interface SensorMqttCredentials {
  sensorId: string;
  host: string;
  port: number;
  tls: boolean;
  clientId: string;
  username: string;
  password: string;
  topic: string;
}

/** The selection a credential is read with, shared by registration and rotation. */
export const SENSOR_MQTT_CREDENTIALS_FIELDS = `
  sensorId
  host
  port
  tls
  clientId
  username
  password
  topic
`;

export const ROTATE_SENSOR_MQTT_CREDENTIALS_MUTATION = `
  mutation RotateSensorMqttCredentials($sensorId: ID!) {
    rotateSensorMqttCredentials(sensorId: $sensorId) {
      ${SENSOR_MQTT_CREDENTIALS_FIELDS}
    }
  }
`;

export function useRotateMqttCredentials(): UseMutationResult<
  SensorMqttCredentials,
  Error,
  string
> {
  return useTenantMutation<SensorMqttCredentials, Error, string>(
    async (sensorId) => {
      const data = await graphqlFetch<{ rotateSensorMqttCredentials: SensorMqttCredentials }>(
        ROTATE_SENSOR_MQTT_CREDENTIALS_MUTATION,
        { sensorId },
      );
      return data.rotateSensorMqttCredentials;
    },
    // The sensor lists show who holds a credential; the password itself is
    // never cached.
    { invalidate: [['sensors']], gcTime: 0 },
  );
}
