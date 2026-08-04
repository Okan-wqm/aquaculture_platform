import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NatsRequestReply } from '@platform/event-bus';
import {
  FARM_SITE_ACCESS_QUERY_SUBJECTS,
  isValidateFarmSiteAssignmentResponse,
  type ValidateFarmSiteAssignmentRequest,
} from '@platform/event-contracts';

const FARM_SITE_AUTHORITY_TIMEOUT_MS = 3_000;

/**
 * Auth-side adapter to farm-service's authoritative site boundary.
 * Assignment fails closed on transport, remote, or response-shape failure.
 */
@Injectable()
export class FarmSiteAssignmentValidator {
  private readonly logger = new Logger(FarmSiteAssignmentValidator.name);

  constructor(private readonly requestReply: NatsRequestReply) {}

  async assertAssignable(tenantId: string, siteId: string): Promise<void> {
    const request: ValidateFarmSiteAssignmentRequest = { tenantId, siteId };
    let response: unknown;

    try {
      response = await this.requestReply.requestTyped<ValidateFarmSiteAssignmentRequest, unknown>(
        FARM_SITE_ACCESS_QUERY_SUBJECTS.VALIDATE_ASSIGNMENT,
        request,
        {
          timeoutMs: FARM_SITE_AUTHORITY_TIMEOUT_MS,
        },
      );
    } catch (error) {
      this.logAuthorityFailure('request_failed', error);
      throw new ServiceUnavailableException(
        'Site assignment validation is temporarily unavailable',
      );
    }

    if (!isValidateFarmSiteAssignmentResponse(response)) {
      this.logAuthorityFailure('malformed_response');
      throw new ServiceUnavailableException(
        'Site assignment validation is temporarily unavailable',
      );
    }

    if (!response.assignable) {
      throw new BadRequestException('Site is not active in the selected tenant');
    }
  }

  private logAuthorityFailure(reason: string, error?: unknown): void {
    this.logger.warn(
      JSON.stringify({
        event: 'farm_site_assignment_validation_failed',
        reason,
        errorType: error instanceof Error ? error.name : undefined,
      }),
    );
  }
}
