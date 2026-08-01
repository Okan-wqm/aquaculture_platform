/**
 * DatabaseModule - Farm modülü veritabanı altyapısı
 *
 * Sağladığı servisler:
 * - AuditLogService: Değişiklik takibi
 * - CodeGeneratorService: Unique kod üretimi
 * - FarmSeedService: Başlangıç verisi oluşturma (dev ortamı)
 * - MigrationRunnerService: Pending TypeORM migration'larını OnApplicationBootstrap
 *   sırasında çalıştırır; SourceSchemaBootstrapService yalnızca migration sonrası
 *   source schema doğrulaması yapar.
 */
import { Module, Global } from '@nestjs/common';
import { AUDIT_LOG_SERVICE } from '@aquaculture/backend-common/audit';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { CodeSequence } from './entities/code-sequence.entity';
import { AuditLogService } from './services/audit-log.service';
import { AuditRedactionService } from './services/audit-redaction.service';
import { CodeGeneratorService } from './services/code-generator.service';
import { FarmSeedService } from './services/farm-seed.service';
import { MigrationRunnerService } from './services/migration-runner.service';

@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([AuditLog, CodeSequence]),
  ],
  providers: [
    AuditLogService,
    { provide: AUDIT_LOG_SERVICE, useExisting: AuditLogService },
    AuditRedactionService,
    CodeGeneratorService,
    MigrationRunnerService,
    FarmSeedService,
  ],
  exports: [
    AuditLogService,
    AUDIT_LOG_SERVICE,
    AuditRedactionService,
    CodeGeneratorService,
    TypeOrmModule,
  ],
})
export class DatabaseModule {}
