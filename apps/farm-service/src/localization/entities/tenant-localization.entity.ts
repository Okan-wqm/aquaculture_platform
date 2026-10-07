/**
 * TenantLocalization — tenant saat dilimi / yerel ayar PROJEKSİYONU (W5).
 *
 * SSoT `auth.tenants.settings.localization`'dır (tenant kendi ayarını
 * `tenant/settings → Localization` ekranından yazar). Bu tablo o SSoT'nin
 * farm tarafındaki okunabilir kopyasıdır: yemleme cron'ları saatte bir HER
 * tenant için yerel saati çözer ve bunu auth-service'e senkron sorgu atarak
 * yapamaz (cron'un istek bağlamı yok, auth şemasına grant'i yok ve altyapı
 * arızası tüm yemleme planlamasını düşürürdü).
 *
 * CROSS-TENANT: satırlar `tenantId` ile ayrışır, tablo `farm` kaynak
 * şemasında yaşar ve tenant şemalarına KLONLANMAZ (`MODULE_SCHEMAS['farm']
 * .infrastructureTables`). Bu yüzden `schema: 'farm'` AÇIKÇA bildirilir —
 * per-tenant tabloların "schema'yı atla" kuralı burada geçerli DEĞİLDİR.
 *
 * @module FeedingProtocol/Entities
 */
import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Zon çözümlenemediğinde kullanılan taban (asla sessiz bir yerel zon değil). */
export const DEFAULT_TENANT_TIMEZONE = 'UTC';

@Entity('tenant_localization', { schema: 'farm' })
export class TenantLocalization {
  @PrimaryColumn({ type: 'uuid' })
  tenantId!: string;

  /** IANA zon kimliği — auth tarafında `Intl` ile doğrulanır. */
  @Column({ type: 'varchar', length: 64, default: DEFAULT_TENANT_TIMEZONE })
  timezone!: string;

  /** BCP-47 dil etiketi (raporlama/biçimlendirme; yemleme motoru kullanmaz). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  locale!: string | null;

  /**
   * Kaynak event'in damgası — newest-wins koruması. NATS at-least-once ve
   * sırasız teslim edebildiği için eski bir `TenantUpdated` yeni ayarı
   * geri saramaz.
   */
  @Column({ type: 'timestamptz', nullable: true })
  sourceUpdatedAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
