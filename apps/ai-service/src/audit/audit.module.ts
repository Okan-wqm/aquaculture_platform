import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ToolExecutionAudit } from './tool-execution-audit.entity';
import { AuditService } from './audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([ToolExecutionAudit])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
