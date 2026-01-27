/**
 * BatchFeedAssignment Entity
 *
 * Assigns feeds to batches based on fish weight ranges.
 * System auto-selects the correct feed based on current avgWeight in tank,
 * then looks up the feeding rate from the feed's feedingCurve.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  VersionColumn,
} from 'typeorm';
// Type-only import for TypeScript type checking
import type { Batch } from './batch.entity';

/**
 * Individual feed assignment entry with weight range
 */
export interface FeedAssignmentEntry {
  feedId: string;
  feedCode: string;
  feedName: string;
  minWeightG: number;   // Minimum fish weight for this feed (grams)
  maxWeightG: number;   // Maximum fish weight for this feed (grams)
  priority: number;     // For overlapping ranges (lower = higher priority)
}

@Entity('batch_feed_assignments')
@Index(['tenantId', 'batchId'], { unique: true })
@Index(['tenantId', 'isActive'])
export class BatchFeedAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column('uuid')
  @Index()
  batchId: string;

  @ManyToOne('Batch', { nullable: true })
  @JoinColumn({ name: 'batchId' })
  batch?: Batch;

  /**
   * Array of feed assignments with weight ranges
   * Example:
   * [
   *   { feedId: 'abc', feedCode: 'FEED-START', feedName: 'Starter Feed', minWeightG: 0, maxWeightG: 5, priority: 1 },
   *   { feedId: 'def', feedCode: 'FEED-GROW', feedName: 'Grower Feed', minWeightG: 5, maxWeightG: 50, priority: 1 },
   *   { feedId: 'ghi', feedCode: 'FEED-FIN', feedName: 'Finisher Feed', minWeightG: 50, maxWeightG: 999999, priority: 1 },
   * ]
   */
  @Column({ type: 'jsonb', default: [] })
  feedAssignments: FeedAssignmentEntry[];

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Column({ default: false })
  @Index()
  isDeleted: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Column('uuid', { nullable: true })
  deletedBy?: string;

  // -------------------------------------------------------------------------
  // AUDIT
  // -------------------------------------------------------------------------

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Find the correct feed for a given fish weight
   */
  findFeedForWeight(avgWeightG: number): FeedAssignmentEntry | null {
    if (!this.feedAssignments || this.feedAssignments.length === 0) {
      return null;
    }

    // Sort by priority (lower = higher priority), then by minWeightG
    const sorted = [...this.feedAssignments].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.minWeightG - b.minWeightG;
    });

    // Find matching feed by weight range
    return sorted.find(
      (entry) => avgWeightG >= entry.minWeightG && avgWeightG < entry.maxWeightG
    ) || null;
  }

  /**
   * Soft delete
   */
  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    this.isActive = false;
  }

  /**
   * Restore from soft delete
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
    this.isActive = true;
  }
}
