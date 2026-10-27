import { runInTenantRead } from '@aquaculture/backend-common/database';
import { answerRecentWriterIds, readWriterCount } from '@aquaculture/backend-common/nats';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NatsRequestReply, type RequestReplyResponderHandle } from '@platform/event-bus';
import {
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  type RecentWriterIdsReply,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';
import { DataSource, type QueryRunner } from 'typeorm';

/**
 * The asked members who wrote to sensor within the window: the distinct actors sensor's audit
 * trail recorded (sensor.sensor_audit_logs, written by AuditSubscriber for every change to an
 * @Auditable entity — sensors, edge devices, VFD devices, PLC connections, feeding parameters,
 * automation programs).
 */
export const SENSOR_RECENT_WRITERS_SQL = `
  SELECT count(DISTINCT changed_by)::int AS "writers"
    FROM sensor.sensor_audit_logs
   WHERE tenant_id = $1
     AND changed_by = ANY($2::uuid[])
     AND changed_at >= now() - make_interval(days => $3::int)`;

async function countSensorRecentWriters(
  queryRunner: QueryRunner,
  request: RecentWriterIdsRequest,
): Promise<number> {
  return readWriterCount(
    await queryRunner.query(SENSOR_RECENT_WRITERS_SQL, [
      request.tenantId,
      [...request.userIds],
      request.windowDays,
    ]),
  );
}

/**
 * Core-NATS responder of request.sensor.recentWriterIds (PKG-06 readiness; ADR-051 §3): a
 * read-only service subject auth_service alone sends, answered with a count and never an id.
 * The decode and the caller decision are answerRecentWriterIds's; the count reads inside the
 * tenant the admitted request names.
 */
@Injectable()
export class SensorRecentWriterIdsResponder implements OnModuleInit, OnModuleDestroy {
  private responder: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
  ) {}

  async onModuleInit(): Promise<void> {
    this.responder = await this.requestReply.respond<unknown, RecentWriterIdsReply>(
      MODULE_ACTIVITY_QUERY_SUBJECTS.sensor,
      (request) => this.answer(request),
      { queue: 'sensor-service' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  answer(request: unknown): Promise<RecentWriterIdsReply> {
    return answerRecentWriterIds('sensor', request, (admitted) =>
      runInTenantRead(this.dataSource, 'sensor', admitted.tenantId, (queryRunner) =>
        countSensorRecentWriters(queryRunner, admitted),
      ),
    );
  }
}
