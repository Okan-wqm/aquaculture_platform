import { Injectable, Logger } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import type { EntityManager } from 'typeorm';

import { Sensor, SensorRegistrationStatus, SensorStatus } from '../database/entities/sensor.entity';
import { recordEntityUpdate } from '../infrastructure/audit/audit.subscriber';
import { registrationCompletedEvent } from '../registration/sensor-registration-events';

/** The protocol a sensor holding its own broker principal speaks. */
const MQTT_PROTOCOL_CODE = 'MQTT';

/**
 * Data, not a cloud-initiated test, activates a sensor that holds its own
 * broker principal (ADR-047 §5): the platform cannot dial a device, and the
 * device proves itself by publishing over the identity it was issued.
 *
 * The first message that persists at least one metric moves the principal's
 * row and its children from DRAFT or TEST_FAILED to ACTIVE with isActive set,
 * stamps last_seen_at, records the change in sensor_audit_logs, and enqueues
 * SensorRegistrationCompleted with connectionTestPassed = true — in the
 * caller's ingestion transaction, so a promotion commits with the reading
 * that earned it or not at all. The UPDATE's own condition makes it happen
 * once: a concurrent message waits on the row lock and then finds the sensor
 * already ACTIVE. A SUSPENDED sensor is never promoted.
 */
@Injectable()
export class SensorDataPromotion {
  private readonly logger = new Logger(SensorDataPromotion.name);

  constructor(private readonly outboxPublisher: OutboxPublisher) {}

  /** Promote the sensor if this is its first data; true when it was promoted. */
  async promoteOnData(manager: EntityManager, sensor: Sensor, seenAt: Date): Promise<boolean> {
    const [promoted] = (await manager.query(
      `WITH waiting AS (
         SELECT id, registration_status AS previous, is_active AS previous_active
           FROM sensors
          WHERE tenant_id = $1 AND (id = $2 OR parent_id = $2)
            AND registration_status IN ($4, $5)
          FOR UPDATE
       )
       UPDATE sensors s
          SET registration_status = $6,
              is_active = true,
              status = $7,
              last_seen_at = $3,
              updated_at = now()
         FROM waiting w
        WHERE s.id = w.id AND s.tenant_id = $1
       RETURNING s.id, w.previous, w.previous_active`,
      [
        sensor.tenantId,
        sensor.id,
        seenAt,
        SensorRegistrationStatus.DRAFT,
        SensorRegistrationStatus.TEST_FAILED,
        SensorRegistrationStatus.ACTIVE,
        SensorStatus.ACTIVE,
      ],
    )) as [
      Array<{ id: string; previous: SensorRegistrationStatus; previous_active: boolean }>,
      number,
    ];

    for (const row of promoted) {
      await recordEntityUpdate(manager, {
        tenantId: sensor.tenantId,
        entityType: Sensor.name,
        entityId: row.id,
        previous: { registrationStatus: row.previous, isActive: row.previous_active },
        next: { registrationStatus: SensorRegistrationStatus.ACTIVE, isActive: true },
        changedBy: null,
      });
    }

    const principalPromoted = promoted.some((row) => row.id === sensor.id);
    if (principalPromoted) {
      await this.outboxPublisher.enqueue(
        registrationCompletedEvent(sensor, MQTT_PROTOCOL_CODE, true),
        manager,
      );
      this.logger.log(
        JSON.stringify({
          event: 'sensor_promoted_by_data',
          tenantId: sensor.tenantId,
          sensorId: sensor.id,
          rows: promoted.length,
        }),
      );
    }
    return principalPromoted;
  }
}
