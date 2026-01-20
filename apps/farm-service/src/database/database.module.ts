/**
 * DatabaseModule - Farm modülü veritabanı altyapısı
 *
 * Sağladığı servisler:
 * - AuditLogService: Değişiklik takibi
 * - CodeGeneratorService: Unique kod üretimi
 * - FarmSeedService: Başlangıç verisi oluşturma (dev ortamı)
 */
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { CodeSequence } from './entities/code-sequence.entity';
import { AuditLogService } from './services/audit-log.service';
import { CodeGeneratorService } from './services/code-generator.service';
import { FarmSeedService } from './services/farm-seed.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, CodeSequence]),
  ],
  providers: [AuditLogService, CodeGeneratorService, FarmSeedService],
  exports: [AuditLogService, CodeGeneratorService, TypeOrmModule],
})
export class DatabaseModule {}
