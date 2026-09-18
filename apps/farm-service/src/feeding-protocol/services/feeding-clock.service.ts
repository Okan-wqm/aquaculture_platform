/**
 * FeedingClockService — yemleme tarafının TEK takvim/saat çözücüsü (W5, D-B4).
 *
 * ## Neden tek çözücü
 *
 * "Bugün" üç ayrı yerde üç ayrı şey demekti: altı cron `Europe/Istanbul`
 * sabitine bağlıydı (`@Cron(..., { timeZone })`), plan üretimi `sites.timezone`
 * okuyordu, gün özeti ile rollup ise `CURRENT_DATE` (DB oturum zonu = UTC)
 * kullanıyordu. Sonuç sahada görünüyordu: Norveç'teki tenant kendi 05:00'ında
 * plan alıyor, kendi günü bitmeden (İstanbul 20:00 = Oslo 18:00) gün özeti
 * çıkıyor, rollup UTC gününe göre bir gün erken/geç koşuyordu.
 *
 * Bundan sonra gün semantiği taşıyan HİÇBİR sorgu `CURRENT_DATE`/`now()`
 * kullanmaz: yerel gün burada hesaplanır ve sorgulara `$n::date` olarak
 * bağlanır.
 *
 * ## Zon hiyerarşisi (tek yerde, isimli)
 *
 *   `sites.timezone` (NULL = devral) → `tenant_localization.timezone` → `'UTC'`
 *
 * Site kolonunun NULL olabilmesi kalıtımı YAPISAL kılar (W5 migration'ı
 * `'UTC'` varsayılanını NULL'a çevirdi): tenant zonunu değiştirdiğinde kendi
 * zonu belirtilmemiş TÜM siteleri onu izler, bir daha satır satır güncelleme
 * gerekmez.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import {
  DEFAULT_TENANT_TIMEZONE,
  TenantLocalization,
} from '../entities/tenant-localization.entity';
import { localDayBoundsUtc, zonedPartsIn } from './meal-schedule.util';

/** Bir tenant/site için çözülmüş zaman bağlamı. */
export interface FeedingClock {
  /**
   * Bağlamın çözüldüğü MUTLAK an. Tick içindeki tüm işler aynı anı paylaşır:
   * "penceresi geçti mi" kararı bir işte `new Date()`, diğerinde başka bir
   * `new Date()` ile alınırsa aynı tick'in iki adımı farklı zamanlarda
   * yaşamış olur (ve spec'ler zamanı sabitleyemez).
   */
  at: Date;
  /** Çözülen IANA zonu. */
  zone: string;
  /** Zonda geçerli takvim günü (YYYY-MM-DD). */
  localDate: string;
  /** Zonda duvar saati (0–23) — cron tetikleme kararının girdisi. */
  localHour: number;
  localMinute: number;
  /** Yerel günün mutlak sınırları — timestamptz süzgeçleri için. */
  dayStartUtc: Date;
  dayEndUtc: Date;
}

/** Bir tenant'ın site → zon haritası + tenant tabanı (tek toplu okuma). */
export interface TenantZoneMap {
  tenantZone: string;
  zoneOf(siteId: string | null | undefined): string;
}

@Injectable()
export class FeedingClockService {
  constructor(
    /**
     * CROSS-TENANT ledger: `tenant_localization` `farm` kaynak şemasında yaşar
     * ve tenantId ile AYRIŞIR (tenant şemalarına klonlanmaz). Entity
     * `schema: 'farm'` bildirdiği için enjekte edilen repository yazımı
     * şema-nitelikli yapar — `getScopedRepository` burada yanlış olurdu:
     * cron tick'i tenant bağlamı OLMADAN koşar ve tablo tenant şemasında yok.
     */
    @InjectRepository(TenantLocalization)
    private readonly localizationRepository: Repository<TenantLocalization>,
  ) {}

  /**
   * Tenant zonu — cron tick'i tenant transaction'ı AÇMADAN önce okur, bu yüzden
   * cross-tenant `farm.tenant_localization` tablosuna enjekte edilen
   * (şema-nitelikli, entity sahipli) repository üzerinden erişir.
   */
  async tenantZones(tenantIds: string[]): Promise<Map<string, string>> {
    const zones = new Map<string, string>();
    if (tenantIds.length === 0) return zones;
    const rows = await this.localizationRepository.find({
      where: { tenantId: In(tenantIds) },
      select: ['tenantId', 'timezone'],
    });
    for (const row of rows) {
      zones.set(row.tenantId, row.timezone || DEFAULT_TENANT_TIMEZONE);
    }
    for (const tenantId of tenantIds) {
      if (!zones.has(tenantId)) zones.set(tenantId, DEFAULT_TENANT_TIMEZONE);
    }
    return zones;
  }

  async tenantZone(tenantId: string): Promise<string> {
    return (await this.tenantZones([tenantId])).get(tenantId) ?? DEFAULT_TENANT_TIMEZONE;
  }

  /**
   * Tenant'ın site → zon haritası. Tek sorguda tüm siteler + tenant tabanı;
   * plan üretim döngüsü site başına sorgu ATMAZ.
   */
  async siteZones(manager: EntityManager, tenantId: string): Promise<TenantZoneMap> {
    const tenantZone = await this.tenantZone(tenantId);
    const rows: Array<{ id: string; timezone: string | null }> = await manager.query(
      `SELECT id, timezone FROM "sites" WHERE "tenantId" = $1`,
      [tenantId],
    );
    const bySite = new Map<string, string>();
    for (const row of rows) {
      // NULL/boş = devral. Site kendi zonunu AÇIKÇA yazdıysa o kazanır.
      if (row.timezone) bySite.set(row.id, row.timezone);
    }
    return {
      tenantZone,
      zoneOf: (siteId) => (siteId ? (bySite.get(siteId) ?? tenantZone) : tenantZone),
    };
  }

  /** Tek site (veya tenant tabanı) için tam zaman bağlamı. */
  async resolve(
    manager: EntityManager,
    tenantId: string,
    siteId?: string | null,
    at: Date = new Date(),
  ): Promise<FeedingClock> {
    const map = await this.siteZones(manager, tenantId);
    return FeedingClockService.clockIn(map.zoneOf(siteId), at);
  }

  /** SAF: zon + an → takvim bağlamı (spec'ler bunu doğrudan kullanır). */
  static clockIn(zone: string, at: Date = new Date()): FeedingClock {
    const parts = zonedPartsIn(zone, at);
    const bounds = localDayBoundsUtc(parts.date, zone);
    return {
      at,
      zone,
      localDate: parts.date,
      localHour: parts.hour,
      localMinute: parts.minute,
      dayStartUtc: bounds.startUtc,
      dayEndUtc: bounds.endUtc,
    };
  }
}
