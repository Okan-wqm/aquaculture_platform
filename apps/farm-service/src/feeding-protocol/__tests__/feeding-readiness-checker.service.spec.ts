/**
 * FeedingReadinessCheckerService (W8 — FARM-MEDIUM-284)
 *
 * Onboarding fan-out'u v1 `feeding_protocols` tohumluyor; cutover'dan sonra
 * motor o tabloyu HİÇ okumuyor. Yani yeni tenant "protokoller hazır"
 * görüntüsüyle ama fiilen yemleyemez hâlde açılıyordu. Checker satır YAZMAZ —
 * `EquipmentTypeCatalogCheckerService` emsali gibi ölçer ve boşluğu
 * provisioning anında görünür kılar.
 */
import { Logger } from '@nestjs/common';

import { FeedingProtocolStatus } from '../entities/feeding-protocol-v2.entity';
import { FeedingReadinessCheckerService } from '../services/feeding-readiness-checker.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

function makeChecker(activeCount: number): {
  service: FeedingReadinessCheckerService;
  count: jest.Mock;
  warn: jest.SpyInstance;
} {
  const count = jest.fn().mockResolvedValue(activeCount);
  // Servisin ctor tipi `Pick<Repository, 'count'>` olduğu için double CAST'SIZ
  // yerine oturur — testin şekli üretim tipini zorlar, tersi değil.
  const service = new FeedingReadinessCheckerService({ count });
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return { service, count, warn };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FeedingReadinessCheckerService', () => {
  it('reports the gap (and writes nothing) when the tenant has no ACTIVE v2 protocol', async () => {
    const { service, warn } = makeChecker(0);

    const result = await service.check(TENANT);

    expect(result).toEqual({ seeded: [], skipped: [] });
    expect(warn).toHaveBeenCalled();
    // Boşluk provisioning log'unda DURUR — ilk stoklamayı beklemeden.
    expect(String(warn.mock.calls[0]?.[0])).toContain('NO active feeding protocol');
  });

  it('counts only ACTIVE, non-deleted protocols of THIS tenant', async () => {
    const { service, count } = makeChecker(2);

    const result = await service.check(TENANT);

    expect(count).toHaveBeenCalledWith({
      where: { tenantId: TENANT, status: FeedingProtocolStatus.ACTIVE, isDeleted: false },
    });
    expect(result.skipped).toEqual(['feeding-protocols-v2:2']);
  });

  it('never writes rows — it is a checker, not a seeder', async () => {
    const { service } = makeChecker(1);
    const result = await service.check(TENANT);
    // `seeded` fan-out'un tek tip sözleşmesi; checker onu HER ZAMAN boş bırakır.
    expect(result.seeded).toEqual([]);
  });
});
