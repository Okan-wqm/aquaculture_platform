/**
 * @module PartitionModule
 * @description Manages time-based table partitioning for messages and message_receipts.
 * Automatically creates monthly partitions for current and upcoming months.
 * @see ADR-012 section 6 (Partitioning Strategy)
 */
import { Module } from '@nestjs/common';
import { PartitionManagerService } from './partition-manager.service';

@Module({
  providers: [PartitionManagerService],
  exports: [PartitionManagerService],
})
export class PartitionModule {}
