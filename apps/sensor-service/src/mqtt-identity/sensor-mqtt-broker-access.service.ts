import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { Injectable, Optional } from '@nestjs/common';
import client from 'prom-client';

import { SensorRegistrationStatus } from '../database/entities/sensor.entity';
import { RateBuckets } from './rate-buckets';
import { SensorMqttIdentityService } from './sensor-mqtt-identity.service';
import { parseSensorMqttDataTopic } from './sensor-mqtt-topic';

/** go-auth's access bit for PUBLISH. */
const MQTT_ACC_WRITE = 2;

/**
 * The stated per-sensor rate cap (ADR-047 §8): one PUBLISH a second
 * sustained, ten at once. It is metered when the sensor publishes, at the
 * broker's ACL check: a message over it is never accepted, so it costs no
 * database work, and a backlog the broker holds for the listener (a restart,
 * a redelivery) is not metered again on its way out.
 */
export const SENSOR_DATA_RATE = { perSecond: 1, burst: 10 } as const;

const RATE_BUCKET_KEYS = 100_000;

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
  private readonly buckets = new RateBuckets(
    SENSOR_DATA_RATE.perSecond,
    SENSOR_DATA_RATE.burst,
    RATE_BUCKET_KEYS,
  );
  private readonly registry = new client.Registry();
  private readonly rateLimited = new client.Counter({
    name: 'sensor_principal_publishes_rate_limited_total',
    help: 'PUBLISHes a sensor principal made over its rate cap, refused at the broker',
    registers: [this.registry],
  });

  constructor(
    private readonly identity: SensorMqttIdentityService,
    @Optional() serviceMetrics?: ServiceMetricsService,
  ) {
    if (serviceMetrics) {
      serviceMetrics.registerContributor('sensor-principal-broker-access', this.registry);
    }
  }

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

  /**
   * Whether the principal may access a topic: PUBLISH to its own data topic
   * only, within its rate cap (metered before the principal is read).
   */
  async mayAccess(
    username: string,
    topic: string,
    acc: number,
    now: number = Date.now(),
  ): Promise<boolean> {
    const target = parseSensorMqttDataTopic(topic);
    if (acc !== MQTT_ACC_WRITE || !target) {
      return false;
    }
    if (!this.buckets.take(username, now)) {
      this.rateLimited.inc();
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
