/**
 * protocolFeedForecast sorgusu (Faz 7, plan §5 / K-10).
 *
 * Sorgu MATERYALİZE snapshot'ı okur — sorgu anında yeniden hesap YOK
 * (belirlenebilir bayatlık: computedAt UI'da görünür). `horizonDays`
 * (1–120, default 90) MAKS ufuklu satırı DİLER: seriler kesilir, dilim
 * dışında kalan tükeniş/geçiş/alert alanları null'lanır/elenir — pencere
 * içinde görünmeyen şey iddia edilmez.
 *
 * `refresh:true` mekanizma değil yedektir (D-6 event-driven yenileme ana
 * yol): MANAGER+ ve tenant başına 5 dk'da 1 (in-memory throttle — instance
 * başına; cron + event yolu asıl tazeliği sağlar, throttle yalnız insan
 * tetiklemesini sınırlar).
 *
 * Authz: üç rol; MODULE_USER yalnız atandığı sitenin kapsamını okuyabilir
 * (fail-closed) — tenant-geneli fallback kapsamı ('tenant') site ataması
 * yapılmamış scoped kullanıcıya AÇILMAZ.
 *
 * @module FeedingProtocol/Resolvers
 */
import { ForbiddenException } from '@nestjs/common';
import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
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

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import {
  FeedingForecastSnapshot,
  ForecastPerFeed,
} from '../entities/feeding-forecast-snapshot.entity';
import { ProtocolFeedForecastView } from '../dto/feed-forecast.results';
import {
  FORECAST_STALE_AFTER_MS,
  ProtocolFeedForecastService,
  TENANT_SCOPE_KEY,
} from '../services/protocol-feed-forecast.service';

const DEFAULT_HORIZON_DAYS = 90;
const MAX_HORIZON_DAYS = 120;
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;

interface CallerClaims {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

@UseGuards(GqlAuthGuard)
@Resolver(() => ProtocolFeedForecastView)
export class FeedForecastResolver {
  private readonly lastRefreshAtByTenant = new Map<string, number>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly forecastService: ProtocolFeedForecastService,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => ProtocolFeedForecastView, { name: 'protocolFeedForecast', nullable: true })
  async protocolFeedForecast(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CallerClaims,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('horizonDays', { type: () => Int, nullable: true }) horizonDays?: number,
    @Args('refresh', { nullable: true }) refresh?: boolean,
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

    if (refresh) {
      if (!isManagerOrHigher) {
        throw new ForbiddenException('refresh yalnız MODULE_MANAGER ve üstüne açıktır');
      }
      const last = this.lastRefreshAtByTenant.get(tenantId) ?? 0;
      if (Date.now() - last >= REFRESH_THROTTLE_MS) {
        this.lastRefreshAtByTenant.set(tenantId, Date.now());
        await this.forecastService.refreshTenant(tenantId);
      }
    }

    const scopeKey = siteId ?? TENANT_SCOPE_KEY;
    const horizon = Math.max(1, Math.min(horizonDays ?? DEFAULT_HORIZON_DAYS, MAX_HORIZON_DAYS));

    const snapshot = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(FeedingForecastSnapshot, {
        where: { tenantId, siteScopeKey: scopeKey },
      }),
    );
    if (!snapshot) return null;
    return sliceSnapshotToHorizon(snapshot, horizon);
  }
}

/** K-10 dilimleme — SAF (spec pinli): pencere dışı iddia bırakma. */
export function sliceSnapshotToHorizon(
  snapshot: FeedingForecastSnapshot,
  horizon: number,
): ProtocolFeedForecastView {
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
  // Dilimleme GÜN İNDEKSİ üzerinden (FARM-LOW-266): `days` tipe özgü bir
  // BÜYÜKLÜK (geçiş açığında eksik gün sayısı), pencere sınırı değil.
  const alerts = snapshot.alerts.filter((alert) => alert.atDay < horizon);
  return {
    siteScopeKey: snapshot.siteScopeKey,
    poolScope: snapshot.poolScope,
    horizonDays: horizon,
    computedAt: snapshot.computedAt,
    // Bayat satır silinmez, İŞARETLENİR: "veri yok" ile "veri eski"
    // operatör için farklı kararlardır (W6).
    stale: Date.now() - snapshot.computedAt.getTime() > FORECAST_STALE_AFTER_MS,
    perFeed,
    perUnit,
    alerts,
    mortalityAssumption: snapshot.mortalityAssumption,
  };
}
