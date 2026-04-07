/**
 * DatabaseModule - Farm modülü veritabanı altyapısı
 *
 * Sağladığı servisler:
 * - AuditLogService: Değişiklik takibi
 * - CodeGeneratorService: Unique kod üretimi
 * - FarmSeedService: Başlangıç verisi oluşturma (dev ortamı)
 * - MigrationRunnerService: Pending TypeORM migration'larını OnApplicationBootstrap
 *   sırasında çalıştırır (SourceSchemaBootstrap.synchronize() sonrası)
 */
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { CodeSequence } from './entities/code-sequence.entity';
import { AuditLogService } from './services/audit-log.service';
import { CodeGeneratorService } from './services/code-generator.service';
import { FarmSeedService } from './services/farm-seed.service';
import { MigrationRunnerService } from './services/migration-runner.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, CodeSequence]),
  ],
  providers: [
    AuditLogService,
    CodeGeneratorService,
    FarmSeedService,
    MigrationRunnerService,
  ],
  exports: [AuditLogService, CodeGeneratorService, TypeOrmModule],
})
export class DatabaseModule {}
