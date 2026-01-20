import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Announcement } from './announcement.entity';

/**
 * AnnouncementAcknowledgment Entity
 *
 * Tracks user views and acknowledgments for announcements.
 */
@Entity('announcement_acknowledgments')
@ObjectType()
@Index(['announcementId', 'userId'])
@Index(['userId', 'viewedAt'])
@Unique(['announcementId', 'userId'])
export class AnnouncementAcknowledgment {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id: string;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  announcementId: string;

  @ManyToOne(() => Announcement, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'announcementId' })
  announcement: Announcement;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  userId: string;

  @Column()
  @Field()
  userName: string;

  @Column({ type: 'uuid', nullable: true })
  @Field(() => String, { nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Field(() => String, { nullable: true })
  tenantName: string | null;

  @CreateDateColumn()
  @Field()
  viewedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  @Field(() => Date, { nullable: true })
  acknowledgedAt: Date | null;

  /**
   * Check if user has acknowledged
   */
  hasAcknowledged(): boolean {
    return this.acknowledgedAt !== null;
  }
}
