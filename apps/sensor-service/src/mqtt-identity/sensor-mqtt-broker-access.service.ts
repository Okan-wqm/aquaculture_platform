import { Injectable } from '@nestjs/common';

import { SensorRegistrationStatus } from '../database/entities/sensor.entity';
import { SensorMqttIdentityService } from './sensor-mqtt-identity.service';
import { parseSensorMqttDataTopic } from './sensor-mqtt-topic';

/** go-auth's access bit for PUBLISH. */
const MQTT_ACC_WRITE = 2;

/** Why a sensor principal's CONNECT was refused — logged, never returned to the broker. */
export type SensorConnectDenial =
  | 'client_id_mismatch'
  | 'principal_not_found'
  | 'suspended'
  | 'secret_mismatch';

/**
 * What the broker lets a sensor's own principal do (ADR-047 §1, §3): CONNECT
 * under its username as client ID with its secret, then PUBLISH to its one
 * data topic. Nothing else — no subscribe, no read, no development topic, no
 * other sensor or tenant. The principal is read on every check (the broker's
 * cache is off and nothing here caches a grant), so a rotation, suspension or
 * deletion stops the old session at its next PUBLISH.
 */
@Injectable()
export class SensorMqttBrokerAccess {
  constructor(private readonly identity: SensorMqttIdentityService) {}

  /** Null when the CONNECT is admitted. */
  async connectDenial(
    username: string,
    password: string,
    clientId: string | undefined,
  ): Promise<SensorConnectDenial | null> {
    if (clientId !== username) {
      return 'client_id_mismatch';
    }
    const principal = await this.identity.findPrincipal(username);
    if (!principal) {
      return 'principal_not_found';
    }
    if (principal.registrationStatus === SensorRegistrationStatus.SUSPENDED) {
      return 'suspended';
    }
    return this.identity.verifySecret(principal, password) ? null : 'secret_mismatch';
  }

  /** Whether the principal may access a topic: PUBLISH to its own data topic only. */
  async mayAccess(username: string, topic: string, acc: number): Promise<boolean> {
    const target = parseSensorMqttDataTopic(topic);
    if (acc !== MQTT_ACC_WRITE || !target) {
      return false;
    }
    const principal = await this.identity.findPrincipal(username);
    return (
      principal !== null &&
      principal.registrationStatus !== SensorRegistrationStatus.SUSPENDED &&
      principal.tenantId === target.tenantId &&
      principal.sensorId === target.sensorId
    );
  }
}
