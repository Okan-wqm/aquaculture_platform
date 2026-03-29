/**
 * @module MessageAttachment
 * @description Entity for message file attachments with storage key,
 * metadata (filename, MIME, size), and optional thumbnail/media dimensions.
 * @see ADR-012 section 4.3 (Attachments)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { Message } from './message.entity';

@ObjectType()
@Entity('message_attachments')
@Index('idx_attachments_message', ['messageId'])
export class MessageAttachment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  messageId: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt: Date;

  @Column({ type: 'varchar', length: 512 })
  storageKey: string;

  @Field()
  @Column({ type: 'varchar', length: 255 })
  originalFilename: string;

  @Field()
  @Column({ type: 'varchar', length: 127 })
  mimeType: string;

  @Field()
  @Column({ type: 'bigint' })
  fileSize: number;

  @Field(() => Number, { nullable: true })
  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Field(() => Number, { nullable: true })
  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnailKey: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Message, (msg) => msg.attachments, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message: Message;
}
