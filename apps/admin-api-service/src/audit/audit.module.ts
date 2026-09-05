import { AuditLogEntity } from '@aquaculture/backend-common/audit';
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogController } from './audit.controller';
import { AuditLog } from './audit.entity';
import { AuditLogService } from './audit.service';

@Global()
@Module({
  // AuditLogEntity (shared.audit_logs) must be in the DataSource metadata so
  // the AuditedOperationInterceptor's repository lookup resolves (ADMIN-CRITICAL-008).
  imports: [TypeOrmModule.forFeature([AuditLog, AuditLogEntity])],
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
