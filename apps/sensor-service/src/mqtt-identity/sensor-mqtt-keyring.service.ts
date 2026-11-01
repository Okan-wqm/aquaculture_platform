import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  parseSensorSecretKeyring,
  SENSOR_MQTT_SECRET_KEYRING_ENV,
  type SensorSecretKeyring,
} from './sensor-mqtt-secret';

/**
 * Holds the peppers sensors' broker secrets are HMAC'd under (ADR-047 §1).
 *
 * Production refuses to start without a well-formed keyring: the deploy
 * bootstrap generates it once per droplet (scripts/deploy/lib/
 * required-env-secrets.sh) and compose requires it. Elsewhere a missing
 * keyring is allowed but closed: nothing is issued and no sensor credential
 * verifies. A malformed keyring stops the service everywhere.
 */
@Injectable()
export class SensorMqttKeyringService implements OnModuleInit {
  private readonly logger = new Logger(SensorMqttKeyringService.name);
  private keyring: SensorSecretKeyring | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const raw = this.config.get<string>(SENSOR_MQTT_SECRET_KEYRING_ENV);
    if (!raw) {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new Error(
          `${SENSOR_MQTT_SECRET_KEYRING_ENV} is required in production: sensors' broker ` +
            'credentials are issued and verified under it.',
        );
      }
      this.logger.warn(
        `${SENSOR_MQTT_SECRET_KEYRING_ENV} is not set: no sensor broker credential is issued or accepted.`,
      );
      return;
    }
    this.keyring = parseSensorSecretKeyring(raw);
    this.logger.log(`Sensor broker keyring loaded (active key ${this.keyring.active.kid})`);
  }

  /** The keyring, or null when this environment has none. */
  current(): SensorSecretKeyring | null {
    return this.keyring;
  }
}
