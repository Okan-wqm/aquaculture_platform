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
 * ## Zon hiyerarşisi (sahibi: localization/SiteTimeZoneService)
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
import { EntityManager } from 'typeorm';

import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
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

@Injectable()
export class FeedingClockService {
  /**
   * Zonun kendisi yemlemeye ait değil: site → tenant → UTC hiyerarşisinin tek
   * sahibi `SiteTimeZoneService` (localization modülü). Sensör grafikleri de
   * aynı servisten okur, böylece yemleme günü ile grafik günü ayrışamaz.
   */
  constructor(private readonly siteTimeZones: SiteTimeZoneService) {}

  /** Tek site (veya tenant tabanı) için tam zaman bağlamı. */
  async resolve(
    manager: EntityManager,
    tenantId: string,
    siteId?: string | null,
    at: Date = new Date(),
  ): Promise<FeedingClock> {
    const map = await this.siteTimeZones.siteZones(manager, tenantId);
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
