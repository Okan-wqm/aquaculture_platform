import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';
import { HrOutbox } from './hr/entities/hr-outbox.entity';

/**
 * @module HrOutboxModule
 * @description Single registration point for the HR transactional outbox.
 *
 * Wraps `OutboxModule.forFeature(HrOutbox)` once so the `OutboxWorkerService`
 * runs exactly once in the hr-service process. Re-exports `OutboxModule` so
 * every hr domain module (HRModule, LeaveModule, AttendanceModule, …) can
 * inject `OutboxPublisher` without each importing `OutboxModule.forFeature`
 * separately — which would spin up duplicate polling workers on the same
 * outbox table.
 *
 * WHY `exports: [OutboxModule]` instead of `exports: [OutboxPublisher]`:
 * NestJS does not allow re-exporting a provider that comes from an imported
 * module's exports — only the module itself can be re-exported. Exporting
 * `OutboxModule` makes all of its exports (OutboxPublisher, OutboxMetricsService)
 * available to consumers of HrOutboxModule.
 *
 * @Global() matches the platform-wide outbox module pattern so cross-cutting
 * infrastructure modules can inject OutboxPublisher without depending on HR
 * feature-module import order. The worker still registers once because this
 * module is imported once at AppModule level.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(HrOutbox)],
  exports: [OutboxModule],
})
export class HrOutboxModule {}
