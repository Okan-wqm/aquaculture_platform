import {
  runInSourceRead,
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import { SENSOR_MQTT_IDENTITY_ERROR } from '@aquaculture/shared-contracts';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';

import { Sensor, SensorRegistrationStatus } from '../database/entities/sensor.entity';
import { recordEntityUpdate } from '../infrastructure/audit/audit.subscriber';
import {
  type PublicBrokerEndpoint,
  resolvePublicBrokerEndpoint,
} from '../infrastructure/mqtt/public-broker-endpoint';
import { SensorMqttKeyringService } from './sensor-mqtt-keyring.service';
import {
  newSensorMqttSecret,
  newSensorMqttUsername,
  SENSOR_MQTT_USERNAME_PATTERN,
  sensorSecretHmac,
  verifySensorSecret,
} from './sensor-mqtt-secret';
import { sensorMqttDataTopic } from './sensor-mqtt-topic';

/**
 * How a sensor connects with its own broker principal, shown once, when the
 * credential is issued: the password is not stored and cannot be read again.
 */
export interface SensorMqttCredentials {
  readonly sensorId: string;
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  /** The client ID the broker admits this principal with: its username. */
  readonly clientId: string;
  readonly username: string;
  readonly password: string;
  readonly topic: string;
}

/** A sensor's broker principal as the broker's CONNECT and ACL hooks see it. */
export interface SensorMqttPrincipal {
  readonly username: string;
  readonly tenantId: string;
  readonly sensorId: string;
  readonly registrationStatus: SensorRegistrationStatus;
  readonly secret: { readonly hmac: string; readonly kid: string };
}

/**
 * The broker-connection settings an MQTT sensor registered before ADR-047
 * carries in protocol_configuration (the MQTT adapter's connection fields):
 * the broker it was typed to use, the free-text topic the legacy listener
 * resolves by scanning, and wizard-typed credentials that never reached the
 * broker. An issued principal replaces all of them — the topic is the
 * server's, the broker the platform's — so issuing removes them and the
 * legacy topic stops reaching the sensor (ADR-047 §7).
 */
const LEGACY_CONNECTION_KEYS = [
  'sensorId',
  'tenantId',
  'brokerUrl',
  'port',
  'topic',
  'qos',
  'clientId',
  'username',
  'password',
  'useTls',
  'cleanSession',
  'keepAlive',
  'reconnectPeriod',
  'connectTimeout',
  'caCert',
  'clientCert',
  'clientKey',
  'rejectUnauthorized',
  'willTopic',
  'willPayload',
  'willQos',
  'willRetain',
] as const;

interface PrincipalRow {
  id: string;
  parent_id: string | null;
  registration_status: SensorRegistrationStatus;
  mqtt_username: string | null;
  protocol_code: string | null;
  legacy_topic: string | null;
}

/**
 * Owner of a sensor's own broker principal (ADR-047 §1, SENSOR-CRITICAL-173).
 *
 * Only a sensor that talks to the broker gets one: a standalone MQTT sensor or
 * the parent of a parent/child registration, never a child. Issuing writes a
 * fresh username and the HMAC of a fresh 256-bit secret in one statement; the
 * secret is returned once and never stored or logged. Rotating is issuing
 * again: the old username leaves sensor.sensor_mqtt_directory in that same
 * statement (the table's trigger keeps the directory in step), so the old
 * credential stops at its next CONNECT or ACL check.
 *
 * These are the only writes of the credential columns: the entity marks them
 * insert- and update-false, pinned by
 * tests/invariants/sensor-mqtt-identity-single-writer.spec.ts.
 */
@Injectable()
export class SensorMqttIdentityService {
  private readonly logger = new Logger(SensorMqttIdentityService.name);
  private readonly endpoint: PublicBrokerEndpoint;

  constructor(
    private readonly dataSource: DataSource,
    private readonly keyring: SensorMqttKeyringService,
    config: ConfigService,
  ) {
    this.endpoint = resolvePublicBrokerEndpoint(config);
  }

  /**
   * Issue the sensor a new credential, replacing the one it holds (if any),
   * in its own tenant transaction. Who did it is recorded in
   * sensor_audit_logs with the old and new username, never the secret.
   */
  async rotate(
    tenantId: string,
    sensorId: string,
    actorId: string | null,
  ): Promise<SensorMqttCredentials> {
    return runInTenantTransaction(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
      this.issue(qr.manager, tenantId, sensorId, actorId),
    );
  }

  /**
   * Issue the sensor a new credential inside the caller's tenant transaction
   * (registration issues it with the row it creates). Refused, with nothing
   * written, for a sensor that does not speak MQTT, a child sensor, a
   * suspended sensor, or when this environment holds no keyring.
   */
  async issue(
    manager: EntityManager,
    tenantId: string,
    sensorId: string,
    actorId: string | null,
  ): Promise<SensorMqttCredentials> {
    const keyring = this.keyring.current();
    if (!keyring) {
      throw new ServiceUnavailableException({
        message: 'Sensor broker credentials cannot be issued: no key is configured',
        code: SENSOR_MQTT_IDENTITY_ERROR.UNAVAILABLE,
      });
    }
    const row = await lockPrincipal(manager, tenantId, sensorId);

    const username = newSensorMqttUsername();
    const password = newSensorMqttSecret();
    await manager.query(
      `UPDATE sensors
          SET mqtt_username = $3,
              mqtt_secret_hmac = $4,
              mqtt_secret_key_id = $5,
              protocol_configuration = protocol_configuration - $6::text[],
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        sensorId,
        username,
        sensorSecretHmac(keyring.active, password),
        keyring.active.kid,
        [...LEGACY_CONNECTION_KEYS],
      ],
    );

    const topic = sensorMqttDataTopic(tenantId, sensorId);
    await recordEntityUpdate(manager, {
      tenantId,
      entityType: Sensor.name,
      entityId: sensorId,
      previous: {
        mqttUsername: row.mqtt_username,
        mqttTopic: row.mqtt_username === null ? row.legacy_topic : topic,
      },
      next: { mqttUsername: username, mqttTopic: topic },
      changedBy: actorId,
    });
    this.logger.log(
      JSON.stringify({
        event:
          row.mqtt_username === null
            ? 'sensor_mqtt_identity_issued'
            : 'sensor_mqtt_identity_rotated',
        tenantId,
        sensorId,
        keyId: keyring.active.kid,
      }),
    );
    return {
      sensorId,
      host: this.endpoint.host,
      port: this.endpoint.port,
      tls: this.endpoint.tls,
      clientId: username,
      username,
      password,
      topic,
    };
  }

  /**
   * The principal an issued username names, read with no tenant: the
   * directory names the tenant and the sensor, and the row is read inside
   * that tenant's boundary, so a route to a row that no longer holds the
   * username resolves nothing. A username of another shape, or not in the
   * directory, is no principal — there is no tenant scan.
   */
  async findPrincipal(username: string): Promise<SensorMqttPrincipal | null> {
    if (!SENSOR_MQTT_USERNAME_PATTERN.test(username)) {
      return null;
    }
    const routes = (await runInSourceRead(this.dataSource, SENSOR_SOURCE_SCHEMA, (qr) =>
      qr.query(`SELECT sensor_id, tenant_id FROM sensor_mqtt_directory WHERE mqtt_username = $1`, [
        username,
      ]),
    )) as Array<{ sensor_id: string; tenant_id: string }>;
    const route = routes[0];
    if (!route) {
      return null;
    }
    const rows = (await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      route.tenant_id,
      (qr) =>
        qr.query(
          `SELECT registration_status, mqtt_secret_hmac, mqtt_secret_key_id
             FROM sensors
            WHERE tenant_id = $1 AND id = $2 AND mqtt_username = $3`,
          [route.tenant_id, route.sensor_id, username],
        ),
    )) as Array<{
      registration_status: SensorRegistrationStatus;
      mqtt_secret_hmac: string;
      mqtt_secret_key_id: string;
    }>;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      username,
      tenantId: route.tenant_id,
      sensorId: route.sensor_id,
      registrationStatus: row.registration_status,
      secret: { hmac: row.mqtt_secret_hmac, kid: row.mqtt_secret_key_id },
    };
  }

  /** Whether a presented password is the principal's secret; never without a keyring. */
  verifySecret(principal: SensorMqttPrincipal, presented: string): boolean {
    const keyring = this.keyring.current();
    return keyring !== null && verifySensorSecret(keyring, principal.secret, presented);
  }
}

/**
 * Lock the sensor for the write and refuse a sensor that cannot hold a broker
 * principal of its own.
 */
async function lockPrincipal(
  manager: EntityManager,
  tenantId: string,
  sensorId: string,
): Promise<PrincipalRow> {
  const rows = (await manager.query(
    `SELECT s.id, s.parent_id, s.registration_status, s.mqtt_username,
            p.code AS protocol_code,
            s.protocol_configuration ->> 'topic' AS legacy_topic
       FROM sensors s
       LEFT JOIN sensor_protocols p ON p.id = s.protocol_id
      WHERE s.tenant_id = $1 AND s.id = $2
      FOR UPDATE OF s`,
    [tenantId, sensorId],
  )) as PrincipalRow[];
  const row = rows[0];
  if (!row) {
    throw new NotFoundException(`Sensor not found: ${sensorId}`);
  }
  if (row.protocol_code !== 'MQTT') {
    throw new BadRequestException({
      message: 'Only a sensor that speaks MQTT itself holds a broker credential',
      code: SENSOR_MQTT_IDENTITY_ERROR.NOT_MQTT,
    });
  }
  if (row.parent_id !== null) {
    throw new BadRequestException({
      message:
        'A child sensor shares its parent device connection; the parent holds the credential',
      code: SENSOR_MQTT_IDENTITY_ERROR.FOLLOWS_PARENT,
    });
  }
  if (row.registration_status === SensorRegistrationStatus.SUSPENDED) {
    throw new BadRequestException({
      message: 'A suspended sensor gets a new credential when it is reactivated',
      code: SENSOR_MQTT_IDENTITY_ERROR.SUSPENDED,
    });
  }
  return row;
}
