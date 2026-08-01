import { isValidUUID, runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NatsRequestReply, type RequestReplyResponderHandle } from '@platform/event-bus';
import {
  FARM_SITE_ACCESS_QUERY_SUBJECTS,
  isValidateFarmSiteAssignmentRequest,
  type ValidateFarmSiteAssignmentRequest,
  type ValidateFarmSiteAssignmentResponse,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { Site } from '../entities/site.entity';

/** Distinct remote-error code for an unavailable farm authority read. */
export class FarmSiteAuthorityUnavailableError extends Error {
  constructor() {
    super('Farm site authority is temporarily unavailable');
    this.name = 'FARM_SITE_AUTHORITY_UNAVAILABLE';
  }
}

/**
 * Core-NATS responder for auth-service's pre-assignment authority check.
 *
 * The shared NatsRequestReply primitive uses the farm-service mTLS connection;
 * broker ACLs authorize which certificate identities may publish this subject.
 * The responder never infers caller identity from forgeable message headers.
 * The response contains no site metadata and cannot become a tenant oracle.
 */
@Injectable()
export class ValidateSiteAssignmentResponder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValidateSiteAssignmentResponder.name);
  private responder: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
  ) {}

  async onModuleInit(): Promise<void> {
    this.responder = await this.requestReply.respond<
      ValidateFarmSiteAssignmentRequest,
      ValidateFarmSiteAssignmentResponse
    >(
      FARM_SITE_ACCESS_QUERY_SUBJECTS.VALIDATE_ASSIGNMENT,
      (request) => this.validateSiteAssignment(request),
      { queue: 'farm-service' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  async validateSiteAssignment(
    request: ValidateFarmSiteAssignmentRequest,
  ): Promise<ValidateFarmSiteAssignmentResponse> {
    if (
      !isValidateFarmSiteAssignmentRequest(request) ||
      !isValidUUID(request.tenantId) ||
      !isValidUUID(request.siteId)
    ) {
      return { assignable: false };
    }

    try {
      return await runInTenantRead(
        this.dataSource,
        'farm',
        request.tenantId,
        async (queryRunner) => {
          const site = await queryRunner.manager.findOne(Site, {
            select: { id: true },
            where: {
              id: request.siteId,
              tenantId: request.tenantId,
              isActive: true,
              isDeleted: false,
            },
          });
          return { assignable: site !== null };
        },
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'farm_site_assignment_authority_unavailable',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new FarmSiteAuthorityUnavailableError();
    }
  }
}
