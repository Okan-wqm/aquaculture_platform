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
 * The asked members who wrote to farm within the window: the distinct actors farm's audit trail
 * recorded (farm.farm_audit_logs — the farm writes that carry an audit row, such as tank
 * allocations, mortality and cull records and regulatory filings). The cross-tenant access row a
 * SUPER_ADMIN leaves there records an access, not a write, and is not counted.
 */
export const FARM_RECENT_WRITERS_SQL = `
  SELECT count(DISTINCT "userId")::int AS "writers"
    FROM farm.farm_audit_logs
   WHERE "tenantId" = $1
     AND "userId" = ANY($2::uuid[])
     AND "createdAt" >= now() - make_interval(days => $3::int)
     AND "action" <> 'SUPER_ADMIN_CROSS_TENANT_ACCESS'`;

async function countFarmRecentWriters(
  queryRunner: QueryRunner,
  request: RecentWriterIdsRequest,
): Promise<number> {
  return readWriterCount(
    await queryRunner.query(FARM_RECENT_WRITERS_SQL, [
      request.tenantId,
      [...request.userIds],
      request.windowDays,
    ]),
  );
}

/**
 * Core-NATS responder of request.farm.recentWriterIds (PKG-06 readiness; ADR-051 §3): a
 * read-only service subject auth_service alone sends, answered with a count and never an id.
 * The decode and the caller decision are answerRecentWriterIds's; the count reads inside the
 * tenant the admitted request names.
 */
@Injectable()
export class FarmRecentWriterIdsResponder implements OnModuleInit, OnModuleDestroy {
  private responder: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
  ) {}

  async onModuleInit(): Promise<void> {
    this.responder = await this.requestReply.respond<unknown, RecentWriterIdsReply>(
      MODULE_ACTIVITY_QUERY_SUBJECTS.farm,
      (request) => this.answer(request),
      { queue: 'farm-service' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  answer(request: unknown): Promise<RecentWriterIdsReply> {
    return answerRecentWriterIds('farm', request, (admitted) =>
      runInTenantRead(this.dataSource, 'farm', admitted.tenantId, (queryRunner) =>
        countFarmRecentWriters(queryRunner, admitted),
      ),
    );
  }
}
