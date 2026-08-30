import { AUDIT_LOG_SERVICE } from '@aquaculture/backend-common/audit';
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from './audit-log.entity';
import { AuditLogService } from './audit-log.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditLogService, { provide: AUDIT_LOG_SERVICE, useExisting: AuditLogService }],
  exports: [AuditLogService, AUDIT_LOG_SERVICE],
})
export class AuditModule {}
