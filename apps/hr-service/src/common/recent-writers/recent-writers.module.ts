import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { HrRecentWriterIdsResponder } from './recent-writer-ids.responder';

/**
 * PKG-06 readiness: request.hr.recentWriterIds. DiscoveryModule lets the responder read the
 * @AuditLog resources hr's resolvers declare.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [HrRecentWriterIdsResponder],
})
export class HrRecentWritersModule {}
