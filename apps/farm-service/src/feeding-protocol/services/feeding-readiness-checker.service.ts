/**
 * FeedingReadinessCheckerService (W8 — FARM-MEDIUM-284)
 *
 * ## Neyi kapatıyor
 *
 * Onboarding fan-out'u yeni tenant'a v1 `feeding_protocols` satırları
 * tohumluyor. v2 cutover'ından sonra motor o tabloyu HİÇ okumuyor: gerçek
 * planlama `feeding_protocols_v2` + `feeding_protocol_assignments` üzerinden
 * koşuyor. Yani yeni tenant, "yemleme protokolleri hazır" görüntüsüyle ama
 * FİİLEN yemleyemez hâlde açılıyor — operatör ilk tankını stokladığında hiçbir
 * gün planı üretilmiyor.
 *
 * ## Neden SEEDER değil CHECKER
 *
 * "v2 protokol tohumla" doğrudan uygulanamaz ve uygulanmaya ÇALIŞMAK daha
 * kötüsünü üretirdi: `ProtocolBand.feedId` gerçek bir `feeds` satırına işaret
 * ETMEK ZORUNDA (band → yem ürünü bağı protokolün temel taşı), ama onboarding
 * fan-out'u yem KATALOĞU tohumlamıyor — yem ürünleri tedarikçi/ticari bir
 * karardır, platform onları uyduramaz. Var olmayan feedId'lerle "hazır"
 * görünen bir protokol tohumlamak, bugünkü sessiz boşluğu daha inandırıcı bir
 * yalanla değiştirmek olurdu.
 *
 * Bu yüzden `EquipmentTypeCatalogCheckerService` emsali izlenir (aynı fan-out,
 * aynı sözleşme): satır YAZMAZ, tenant'ın fiilen yemleyip yemleyemeyeceğini
 * ÖLÇER ve boşluğu yüksek sesle raporlar. Boşluk artık "kimsenin bakmadığı bir
 * yoklukta" değil, provisioning log'unda ve onboarding özetinde durur.
 *
 * ## Çalışma zamanı ağı
 *
 * Bu kontrol tek başına değil: balık stoklanmış ama etkin planı olmayan her
 * ünite için 06:00 üretimi `UnfedUnitDetected(reason='no_assignment')` yayar
 * ve alert-engine CRITICAL incident açar (D-5). Checker o ağı ERKENE alır —
 * ilk stoklamayı beklemeden, provisioning anında.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  FeedingProtocolV2,
  FeedingProtocolStatus,
} from '../entities/feeding-protocol-v2.entity';

export interface FeedingReadinessCheckResult {
  /** Fan-out'un tek tip özet sözleşmesi — checker satır yazmaz, hep boş. */
  seeded: string[];
  /** Kontrol edilen ve hazır bulunan yüzeyler. */
  skipped: string[];
}

@Injectable()
export class FeedingReadinessCheckerService {
  private readonly logger = new Logger(FeedingReadinessCheckerService.name);

  constructor(
    // DI token'ı repository'dir; TS tipi KULLANILAN tek metoda daraltılmıştır
    // ("depend on exactly what you need") — böylece unit testler minimal bir
    // double geçirir ve hiçbir cast gerekmez.
    @InjectRepository(FeedingProtocolV2)
    private readonly protocolRepository: Pick<Repository<FeedingProtocolV2>, 'count'>,
  ) {}

  /**
   * Tenant'ın en az bir ACTIVE v2 protokolü var mı? Yoksa WARN'lar ve boş özet
   * döner — fan-out bunu `ok: true, seeded: 0` olarak kaydeder (onboarding
   * BAŞARISIZ değildir; eksik olan operatörün yapması gereken bir kurulum
   * adımıdır, platformun yapabileceği bir şey değil).
   */
  async check(tenantId: string): Promise<FeedingReadinessCheckResult> {
    const activeProtocols = await this.protocolRepository.count({
      where: { tenantId, status: FeedingProtocolStatus.ACTIVE, isDeleted: false },
    });

    if (activeProtocols === 0) {
      this.logger.warn(
        `Tenant ${tenantId.substring(0, 8)}... has NO active feeding protocol (v2). ` +
          'Until an operator creates one in the Protocol Builder and assigns it to a unit, ' +
          'no feeding day plans will be generated — every stocked unit will raise ' +
          'UnfedUnitDetected(no_assignment) on the 06:00 sweep. This is expected for a ' +
          'brand-new tenant (feed products must exist before protocol bands can reference ' +
          'them) and is reported here so the gap is visible at provisioning time.',
        { tenantId, activeProtocols: 0 },
      );
      return { seeded: [], skipped: [] };
    }

    this.logger.log(
      `Feeding readiness OK for tenant ${tenantId.substring(0, 8)}...: ` +
        `${activeProtocols} active v2 protocol(s).`,
    );
    return { seeded: [], skipped: [`feeding-protocols-v2:${activeProtocols}`] };
  }
}
