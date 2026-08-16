/**
 * protocolFeedForecast sorgusu (Faz 7, plan §5 / K-10).
 *
 * Sorgu MATERYALİZE snapshot'ı okur — sorgu anında yeniden hesap YOK
 * (belirlenebilir bayatlık: computedAt UI'da görünür). `horizonDays`
 * (1–120, default 90) MAKS ufuklu satırı DİLER: seriler kesilir, dilim
 * dışında kalan tükeniş/geçiş/alert alanları null'lanır/elenir — pencere
 * içinde görünmeyen şey iddia edilmez.
 *
 * İnsan-tetikli yenileme ayrı `refreshProtocolFeedForecast` mutation'ıdır;
 * bu Query saf bir materialized-view okumasıdır ve hiçbir write capability
 * taşımaz.
 *
 * Authz: üç rol; MODULE_USER yalnız atandığı sitenin kapsamını okuyabilir
 * (fail-closed) — tenant-geneli fallback kapsamı ('tenant') site ataması
 * yapılmamış scoped kullanıcıya AÇILMAZ.
 *
 * @module FeedingProtocol/Resolvers
 */
import { BadRequestException, ForbiddenException, Inject, UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  Roles,
  Role,
  CurrentTenant,
  CurrentUser,
  roleHasPermission,
} from '@aquaculture/backend-common/decorators';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { isValidUUID } from '@aquaculture/backend-common/database';
import {
  feedingForecastAlertWithinHorizonV1,
  feedingForecastIsStaleV1,
} from '@aquaculture/feeding-contracts';

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import {
  FeedingForecastSnapshot,
  ForecastPerFeed,
} from '../entities/feeding-forecast-snapshot.entity';
import { findActiveFeedingForecastSnapshotV1 } from '../feeding-forecast-generation.reader';
import {
  ProtocolFeedForecastRefreshResultView,
  ProtocolFeedForecastView,
} from '../dto/feed-forecast.results';
import { RefreshProtocolFeedForecastInput } from '../dto/feed-forecast.inputs';
import { TENANT_SCOPE_KEY } from '../executors/protocol-feed-forecast.executor';
import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../feeding-operation-command.port';

const DEFAULT_HORIZON_DAYS = 90;
const MAX_HORIZON_DAYS = 120;

interface CallerClaims {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

type ForecastRefreshCommandPort = Pick<FeedingOperationCommandPort, 'refreshForecast'>;

@UseGuards(GqlAuthGuard)
@Resolver(() => ProtocolFeedForecastView)
export class FeedForecastResolver {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(FEEDING_OPERATION_COMMAND_PORT)
    private readonly operationPort: ForecastRefreshCommandPort,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => ProtocolFeedForecastView, { name: 'protocolFeedForecast', nullable: true })
  async protocolFeedForecast(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('horizonDays', { type: () => Int, nullable: true }) horizonDays?: number,
  ): Promise<ProtocolFeedForecastView | null> {
    const isManagerOrHigher = user.roles.some((role) =>
      roleHasPermission(role, Role.MODULE_MANAGER),
    );
    // Fail-closed site kapısı: scoped kullanıcı yalnız atandığı sitenin
    // kapsamını okur; sitesiz (tenant-fallback) kapsam scoped role kapalı.
    if (!isManagerOrHigher) {
      const assigned = user.assignedSiteIds ?? [];
      if (!siteId || !assigned.includes(siteId)) {
        throw new ForbiddenException('Site kapsamı dışındaki forecast okunamaz');
      }
    }

    const scopeKey = siteId ?? TENANT_SCOPE_KEY;
    const horizon = Math.max(1, Math.min(horizonDays ?? DEFAULT_HORIZON_DAYS, MAX_HORIZON_DAYS));

    const snapshot = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      findActiveFeedingForecastSnapshotV1(queryRunner.manager, tenantId, scopeKey),
    );
    if (!snapshot) return null;
    return sliceSnapshotToHorizon(snapshot, horizon, new Date());
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ProtocolFeedForecastRefreshResultView, {
    name: 'refreshProtocolFeedForecast',
  })
  async refreshProtocolFeedForecast(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('input') input: RefreshProtocolFeedForecastInput,
  ): Promise<ProtocolFeedForecastRefreshResultView> {
    if (!isValidUUID(input.siteId) || !isValidUUID(input.operationRequestId)) {
      throw new BadRequestException('siteId and operationRequestId must be UUID values');
    }
    const refreshedScopeCount = await this.operationPort.refreshForecast({
      tenantId,
      siteId: input.siteId,
      actorId: user.sub,
      requestId: input.operationRequestId,
      emitCoverageEvents: false,
    });
    return { operationRequestId: input.operationRequestId, refreshedScopeCount };
  }
}

/** K-10 dilimleme — SAF (spec pinli): pencere dışı iddia bırakma. */
export function sliceSnapshotToHorizon(
  snapshot: FeedingForecastSnapshot,
  horizon: number,
  observedAt: Date,
): ProtocolFeedForecastView {
  if (snapshot.poolScope === null) {
    throw new Error('Unqualified forecast quarantine cannot be projected to GraphQL');
  }
  const perFeed = snapshot.perFeed.map((feed: ForecastPerFeed) => {
    const inWindow = feed.daysOfCover !== null && feed.daysOfCover < horizon;
    return {
      ...feed,
      dailyConsumptionSeries: feed.dailyConsumptionSeries.slice(0, horizon),
      remainingStockSeries: feed.remainingStockSeries.slice(0, horizon),
      stockoutDate: inWindow ? feed.stockoutDate : null,
      daysOfCover: inWindow ? feed.daysOfCover : null,
      coverageFromAdoptionDays: inWindow ? feed.coverageFromAdoptionDays : null,
      reorderDate: inWindow ? feed.reorderDate : null,
      reorderQuantityKg: inWindow ? feed.reorderQuantityKg : null,
    };
  });
  const perUnit = snapshot.perUnit.map((unit) => ({
    ...unit,
    transitions: unit.transitions.filter((t) => t.daysFromNow < horizon),
  }));
  const alerts = snapshot.alerts.filter((alert) =>
    feedingForecastAlertWithinHorizonV1(alert, horizon),
  );
  return {
    siteScopeKey: snapshot.siteScopeKey,
    poolScope: snapshot.poolScope,
    stale: feedingForecastIsStaleV1(snapshot.computedAt, observedAt),
    horizonDays: horizon,
    computedAt: snapshot.computedAt,
    perFeed,
    perUnit,
    alerts,
    mortalityAssumption: snapshot.mortalityAssumption,
  };
}
