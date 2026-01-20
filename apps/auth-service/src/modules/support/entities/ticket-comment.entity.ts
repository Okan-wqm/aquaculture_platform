import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { SupportTicket } from './support-ticket.entity';

/**
 * Comment author type
 */
export enum CommentAuthorType {
  SUPER_ADMIN = 'super_admin',
  TENANT_ADMIN = 'tenant_admin',
  SYSTEM = 'system',
}

registerEnumType(CommentAuthorType, {
  name: 'CommentAuthorType',
  description: 'Who wrote the comment',
});

/**
 * Ticket attachment type
 */
@ObjectType()
export class TicketAttachment {
  @Field()
  id: string;

  @Field()
  filename: string;

  @Field()
  url: string;

  @Field()
  size: number;
}

/**
 * TicketComment Entity
 *
 * Comments/replies on support tickets.
 * Supports internal notes visible only to admins.
 */
@Entity('ticket_comments')
@ObjectType()
@Index(['ticketId', 'createdAt'])
export class TicketComment {
  @PrimaryGeneratedColumn('uuid')
  @Field(() => ID)
  id: string;

  @Column({ type: 'uuid' })
  @Field()
  @Index()
  ticketId: string;

  @ManyToOne(() => SupportTicket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticketId' })
  ticket: SupportTicket;

  @Column({ type: 'uuid' })
  @Field()
  authorId: string;

  @Column()
  @Field()
  authorName: string;

  @Column({ type: 'enum', enum: CommentAuthorType })
  @Field(() => CommentAuthorType)
  authorType: CommentAuthorType;

  @Column({ type: 'text' })
  @Field()
  content: string;

  @Column({ default: false })
  @Field()
  isInternal: boolean; // Internal note - visible only to admins

  @Column({ type: 'jsonb', nullable: true })
  @Field(() => [TicketAttachment], { nullable: true })
  attachments: TicketAttachment[] | null;

  @CreateDateColumn()
  @Field()
  createdAt: Date;
}
