/**
 * W5 saat/takvim SSoT pinleri (FARM-LOW-259, ek-d, kullanıcı kararı 3).
 *
 * Denetimin bulgusu: yemleme motoru üç ayrı "bugün" tanımı taşıyordu — altı
 * cron `Europe/Istanbul` sabitine bağlıydı, plan üretimi `sites.timezone`
 * okuyordu, gün özeti ve rollup ise `CURRENT_DATE` (DB oturum zonu = UTC)
 * kullanıyordu. Oslo'daki bir tenant kendi 05:00'ında plan alıyor, kendi günü
 * bitmeden özet çıkıyor, rollup UTC gününe göre kayıyordu.
 *
 * Bu spec zon hiyerarşisini (site → tenant → UTC) ve yerel gün sınırlarını
 * pinler; `suspensionFor` artık ünitenin YEREL gününe göre karşılaştırır.
 */
import { EntityManager, Repository } from 'typeorm';

import { FeedingClockService } from '../services/feeding-clock.service';
import { TenantLocalization } from '../entities/tenant-localization.entity';
import { suspensionFor, zonedPartsIn, localDayBoundsUtc } from '../services/meal-schedule.util';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('FeedingClockService — zon hiyerarşisi (D-B4)', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  function makeService(tenantZone: string | null) {
    const find = jest
      .fn()
      .mockResolvedValue(tenantZone ? [{ tenantId: TENANT, timezone: tenantZone }] : []);
    // Cross-tenant projeksiyon repository'si ENJEKTE edilir (şema-nitelikli).
    return new FeedingClockService(mock<Repository<TenantLocalization>>({ find }));
  }

  it('site kendi zonunu yazdıysa o kazanır', async () => {
    const service = makeService('Europe/Oslo');
    const manager = mock<EntityManager>({
      query: jest.fn().mockResolvedValue([{ id: 'site-1', timezone: 'America/Santiago' }]),
    });

    const zones = await service.siteZones(manager, TENANT);
    expect(zones.zoneOf('site-1')).toBe('America/Santiago');
  });

  it('site zonu NULL ise tenant zonundan DEVRALIR (kalıtım yapısal)', async () => {
    const service = makeService('Europe/Oslo');
    const manager = mock<EntityManager>({
      query: jest.fn().mockResolvedValue([{ id: 'site-1', timezone: null }]),
    });

    const zones = await service.siteZones(manager, TENANT);
    expect(zones.zoneOf('site-1')).toBe('Europe/Oslo');
    // Bilinmeyen site de tenant tabanına düşer (sessiz UTC yok).
    expect(zones.zoneOf('site-yok')).toBe('Europe/Oslo');
  });

  it('tenant lokalizasyonu hiç yazılmamışsa taban UTC', async () => {
    const service = makeService(null);
    const manager = mock<EntityManager>({
      query: jest.fn().mockResolvedValue([{ id: 'site-1', timezone: null }]),
    });

    const zones = await service.siteZones(manager, TENANT);
    expect(zones.tenantZone).toBe('UTC');
    expect(zones.zoneOf('site-1')).toBe('UTC');
  });
});

describe('FeedingClockService.clockIn — yerel gün ve saat', () => {
  it('UTC 22:30 iken Oslo (UTC+2, yaz) ERTESİ günü gösterir', () => {
    const at = new Date('2026-07-20T22:30:00Z');
    const clock = FeedingClockService.clockIn('Europe/Oslo', at);
    expect(clock.localDate).toBe('2026-07-21');
    expect(clock.localHour).toBe(0);
  });

  it('UTC 02:00 iken Santiago (UTC−4) HÂLÂ önceki gündedir', () => {
    const at = new Date('2026-07-21T02:00:00Z');
    const clock = FeedingClockService.clockIn('America/Santiago', at);
    expect(clock.localDate).toBe('2026-07-20');
    expect(clock.localHour).toBe(22);
  });

  it('yerel gün sınırları mutlak anlara çevrilir (timestamptz süzgeçleri için)', () => {
    const clock = FeedingClockService.clockIn('Europe/Istanbul', new Date('2026-07-20T09:00:00Z'));
    expect(clock.dayStartUtc.toISOString()).toBe('2026-07-19T21:00:00.000Z');
    expect(clock.dayEndUtc.toISOString()).toBe('2026-07-20T21:00:00.000Z');
    // Sınırlar tam 24 saat (DST dışı bir gün).
    expect(clock.dayEndUtc.getTime() - clock.dayStartUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('DST ileri atlamasında yerel gün 23 saattir (sınırlar takvimden türetilir)', () => {
    // Europe/Oslo 2026-03-29: 02:00 → 03:00 (bir saat kaybolur).
    const bounds = localDayBoundsUtc('2026-03-29', 'Europe/Oslo');
    expect(bounds.endUtc.getTime() - bounds.startUtc.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe('zonedPartsIn — saf zon matematiği', () => {
  it('saat ve dakikayı 24 saat düzeninde döner', () => {
    const parts = zonedPartsIn('Europe/Istanbul', new Date('2026-07-20T02:15:00Z'));
    expect(parts).toEqual({ date: '2026-07-20', hour: 5, minute: 15 });
  });
});

describe('suspensionFor — pencere ÜNİTENİN yerel gününe göre (ek-d)', () => {
  const suspensions = [
    {
      // Oslo yerel 2026-07-20 00:00 → UTC 2026-07-19T22:00
      from: '2026-07-19T22:00:00Z',
      to: '2026-07-21T21:59:59Z',
      type: 'fasting' as const,
      reason: 'vet direktifi',
    },
  ];

  it('yerel güne çevrilince pencerenin İLK günü kapsanır', () => {
    // UTC kesmesi `2026-07-19` derdi ve 20 Temmuz orucu düşerdi.
    expect(suspensionFor(suspensions, '2026-07-20', 'Europe/Oslo')?.type).toBe('fasting');
    expect(suspensionFor(suspensions, '2026-07-21', 'Europe/Oslo')?.type).toBe('fasting');
  });

  it('pencere dışındaki gün kapsanmaz', () => {
    expect(suspensionFor(suspensions, '2026-07-22', 'Europe/Oslo')).toBeUndefined();
    expect(suspensionFor(suspensions, '2026-07-19', 'Europe/Oslo')).toBeUndefined();
  });

  it('salt tarih (zonsuz) sınırlar aynen kullanılır', () => {
    const plain = [
      { from: '2026-07-20', to: '2026-07-22', type: 'fasting' as const, reason: 'oruç' },
    ];
    expect(suspensionFor(plain, '2026-07-20', 'Europe/Oslo')?.type).toBe('fasting');
    expect(suspensionFor(plain, '2026-07-23', 'Europe/Oslo')).toBeUndefined();
  });
});
