import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './audit-log.entity';
import { AuditSubscriber } from './audit.subscriber';
import { SensorRecentWriterIdsResponder } from './recent-writer-ids.responder';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  // PKG-06 readiness: request.sensor.recentWriterIds, answered from sensor_audit_logs.
  providers: [AuditSubscriber, SensorRecentWriterIdsResponder],
})
export class AuditModule {}
