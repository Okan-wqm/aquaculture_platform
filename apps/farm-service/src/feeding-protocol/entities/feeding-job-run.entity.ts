/**
 * FeedingJobRun — "tenant'ın YEREL gününde tam bir kez" garantisinin kaydı (W5).
 *
 * Yemleme işleri artık sabit bir zon altında (`Europe/Istanbul`) değil, saatlik
 * bir UTC tick'i altında koşar; tick her tenant için yerel saati çözer ve iş
 * saati geldiğinde bu tabloya bir CLAIM yazmayı dener. Tekillik
 * `(tenantId, jobName, localDate)` UNIQUE indeksindedir: çok-instance'lı
 * dağıtımda bile aynı yerel gün için ikinci bir başarılı koşu YAPISAL olarak
 * imkânsızdır (advisory lock yalnız eşzamanlılığı önler, "bugün zaten koştu"yu
 * değil — DST'de saat tekrarlandığında tick iki kez aynı yerel saati görür).
 *
 * Satır bir CLAIM'dir, "yapıldı" damgası değil: hata alan veya sayfalama
 * yüzünden yarım kalan koşu `running`/`failed` kalır ve bir sonraki saatlik
 * tick aynı yerel gün için yeniden dener. Yalnız `succeeded` yeniden denemeyi
 * kapatır — sessiz gün kaybı yok.
 *
 * CROSS-TENANT: `farm` kaynak şemasında yaşar, tenant şemalarına klonlanmaz.
 *
 * @module FeedingProtocol/Entities
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type FeedingJobRunStatus = 'running' | 'succeeded' | 'failed';

@Entity('feeding_job_runs', { schema: 'farm' })
@Index('UQ_fjr_tenant_job_local_date', ['tenantId', 'jobName', 'localDate'], { unique: true })
@Index('IDX_fjr_started_at', ['startedAt'])
export class FeedingJobRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 64 })
  jobName!: string;

  /** Tenant'ın YEREL takvim günü (YYYY-MM-DD) — UTC günü değil. */
  @Column({ type: 'date' })
  localDate!: string;

  /** Claim anında çözülen zon — sonradan değişse de kayıt provenansı kalır. */
  @Column({ type: 'varchar', length: 64 })
  timezone!: string;

  @Column({ type: 'varchar', length: 16, default: 'running' })
  status!: FeedingJobRunStatus;

  @Column({ type: 'int', default: 1 })
  attempts!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}
