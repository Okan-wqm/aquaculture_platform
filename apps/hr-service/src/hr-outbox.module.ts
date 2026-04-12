import { Module } from '@nestjs/common';
import { OutboxModule, OutboxPublisher } from '@platform/outbox';
import { HrOutbox } from './hr/entities/hr-outbox.entity';

/**
 * @module HrOutboxModule
 * @description Single registration point for the HR transactional outbox.
 *
 * Wraps `OutboxModule.forFeature(HrOutbox)` once so the `OutboxWorkerService`
 * runs exactly once in the hr-service process. Re-exports `OutboxPublisher` so
 * every hr domain module (HRModule, LeaveModule, AttendanceModule, …) can
 * inject it without each importing `OutboxModule.forFeature` separately —
 * which would spin up duplicate polling workers on the same outbox table.
 *
 * Usage in each sub-module:
 * ```ts
 * imports: [HrOutboxModule],
 * ```
 * `OutboxPublisher` is then injectable in all providers of that module.
 */
@Module({
  imports: [OutboxModule.forFeature(HrOutbox)],
  exports: [OutboxPublisher],
})
export class HrOutboxModule {}
