import { AUDIT_LOG_KEY, type AuditLogOptions } from '@aquaculture/backend-common/decorators';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { answerRecentWriterIds, readWriterCount } from '@aquaculture/backend-common/nats';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { NatsRequestReply, type RequestReplyResponderHandle } from '@platform/event-bus';
import {
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  type RecentWriterIdsReply,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

/**
 * The asked members who wrote to hr within the window: the distinct actors of hr's audited
 * mutations. hr audits its writes with @AuditLog into the shared semantic audit stream
 * (shared.audit_logs), which other services append to as well, so only the rows whose resource
 * one of hr's own @AuditLog declarations names are hr's ($4).
 */
export const HR_RECENT_WRITERS_SQL = `
  SELECT count(DISTINCT "userId")::int AS "writers"
    FROM shared.audit_logs
   WHERE "tenantId" = $1
     AND "userId" = ANY($2::text[])
     AND "createdAt" >= now() - make_interval(days => $3::int)
     AND "resource" = ANY($4::text[])`;

/** Raised when hr found no audited mutation of its own: a count would be a false zero. */
class HrAuditedResourcesMissingError extends Error {
  constructor() {
    super('hr-service declares no @AuditLog resource to count writers by');
    this.name = 'HrAuditedResourcesMissingError';
  }
}

/**
 * Core-NATS responder of request.hr.recentWriterIds (PKG-06 readiness; ADR-051 §3): a read-only
 * service subject auth_service alone sends, answered with a count and never an id.
 *
 * The resources hr audits are read off the @AuditLog metadata of hr's own providers once, when
 * the module starts and before the subject is registered: a newly audited hr mutation joins the
 * count without a second list to keep in step. When hr finds none, every answer is
 * INTERNAL_ERROR, so the readiness report shows hr as unanswered instead of a false zero.
 */
@Injectable()
export class HrRecentWriterIdsResponder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HrRecentWriterIdsResponder.name);
  private responder: RequestReplyResponderHandle | null = null;
  private auditedResources: readonly string[] = [];

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  async onModuleInit(): Promise<void> {
    this.auditedResources = this.readAuditedResources();
    if (this.auditedResources.length === 0) {
      this.logger.warn(JSON.stringify({ event: 'hr_recent_writers_no_audited_resource' }));
    }
    this.responder = await this.requestReply.respond<unknown, RecentWriterIdsReply>(
      MODULE_ACTIVITY_QUERY_SUBJECTS.hr,
      (request) => this.answer(request),
      { queue: 'hr-service' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  answer(request: unknown): Promise<RecentWriterIdsReply> {
    return answerRecentWriterIds('hr', request, (admitted) => this.count(admitted));
  }

  private async count(request: RecentWriterIdsRequest): Promise<number> {
    const resources = this.auditedResources;
    if (resources.length === 0) throw new HrAuditedResourcesMissingError();
    return runInTenantRead(this.dataSource, 'hr', request.tenantId, async (queryRunner) =>
      readWriterCount(
        await queryRunner.query(HR_RECENT_WRITERS_SQL, [
          request.tenantId,
          [...request.userIds],
          request.windowDays,
          [...resources],
        ]),
      ),
    );
  }

  /** Every resource an @AuditLog of an hr provider names, sorted and distinct. */
  private readAuditedResources(): readonly string[] {
    const resources = new Set<string>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      const prototype: unknown = Object.getPrototypeOf(instance);
      if (typeof prototype !== 'object' || prototype === null) continue;
      for (const method of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler: unknown = Reflect.get(prototype, method);
        if (typeof handler !== 'function') continue;
        const options = this.reflector.get<AuditLogOptions | undefined>(AUDIT_LOG_KEY, handler);
        if (options !== undefined) resources.add(options.resource);
      }
    }
    return Object.freeze([...resources].sort());
  }
}
