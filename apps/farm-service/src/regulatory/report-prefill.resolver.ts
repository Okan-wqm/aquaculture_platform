/**
 * reportPrefill — server-assembled regulatory report drafts.
 *
 * The forms stop computing: every value the platform owns arrives
 * pre-aggregated with per-field provenance; the operator reviews,
 * fills only MANUAL_REQUIRED fields, and approves.
 */
import { Logger, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';
import { Roles, Role } from '@aquaculture/backend-common/decorators';

import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { GetReportPrefillQuery } from './queries/get-report-prefill.query';
import { ReportPrefillInput, ReportPrefillOutput } from './dto/report-prefill.dto';

interface GraphQLContext {
  req?: {
    user?: { tenantId?: string };
    tenantId?: string;
  };
}

@UseGuards(GqlAuthGuard)
@Resolver()
export class ReportPrefillResolver {
  private readonly logger = new Logger(ReportPrefillResolver.name);

  constructor(private readonly queryBus: QueryBus) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => ReportPrefillOutput, {
    description: 'Server-assembled regulatory report draft with per-field provenance',
  })
  async reportPrefill(
    @Args('input') input: ReportPrefillInput,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportPrefillOutput> {
    const tenantId = ctx?.req?.user?.tenantId || ctx?.req?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    this.logger.debug(
      `Assembling ${input.reportType} prefill for site ${input.siteId} ` +
        `(${input.periodYear}/${input.periodMonth ?? `W${input.periodWeek}`})`,
    );
    return this.queryBus.execute(
      new GetReportPrefillQuery(
        tenantId,
        input.reportType,
        input.siteId,
        input.periodYear,
        input.periodWeek,
        input.periodMonth,
      ),
    );
  }
}
