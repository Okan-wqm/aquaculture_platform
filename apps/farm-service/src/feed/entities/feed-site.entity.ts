/**
 * FeedSite Entity - Feed-Site İlişkisi (N:M)
 *
 * Her yem (feed) birden fazla site'da kullanılabilir.
 * Site bazında onay/durum takibi yapılır.
 *
 * @module Feed
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
} from '@nestjs/graphql';
import { Feed } from './feed.entity';
// Note: Site is referenced via string to avoid circular dependency

@ObjectType()
@Entity('feed_sites')
@Unique(['feedId', 'siteId'])
@Index(['tenantId', 'feedId'])
@Index(['tenantId', 'siteId'])
export class FeedSite {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // FEED İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  feedId: string;

  @ManyToOne(() => Feed, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedId' })
  feed: Feed;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId: string;

  @ManyToOne('Site', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: any;

  // -------------------------------------------------------------------------
  // ONAY DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  isApproved: boolean;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;
}
