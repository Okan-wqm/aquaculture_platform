import { ObjectType, Field, ID, registerEnumType, Int } from '@nestjs/graphql';
import { Role } from '@platform/backend-common';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Invitation status
 */
export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  RESENT = 'RESENT',
}

registerEnumType(InvitationStatus, {
  name: 'InvitationStatus',
  description: 'Status of user invitation',
});

/**
 * Invitation Entity
 *
 * Tracks user invitations with full audit trail.
 * This is separate from User.invitationToken for better tracking and history.
 *
 * Flow:
 * 1. Admin creates invitation → Invitation record created with PENDING status
 * 2. User record created with invitationToken
 * 3. Email sent to user
 * 4. User clicks link → Sets password → Invitation marked ACCEPTED
 */
@ObjectType()
@Entity('invitations')
@Index('IDX_invitations_token', ['token'], { unique: true })
@Index('IDX_invitations_email', ['email'])
@Index('IDX_invitations_tenant', ['tenantId'])
@Index('IDX_invitations_status', ['status'])
export class Invitation {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => String)
  @Column({ type: 'varchar', length: 128, unique: true })
  token: string;

  @Field(() => String)
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName: string | null;

  @Field(() => Role)
  @Column({
    type: 'varchar',
    length: 50,
  })
  role: Role;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  moduleIds: string[] | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  primaryModuleId: string | null;

  @Field(() => InvitationStatus)
  @Column({
    type: 'varchar',
    length: 20,
    default: InvitationStatus.PENDING,
  })
  status: InvitationStatus;

  @Field(() => Date)
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Field(() => String)
  @Column({ type: 'uuid' })
  invitedBy: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  sendCount: number;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  lastSentAt: Date | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  acceptedFromIp: string | null;

  @Field(() => Date)
  @CreateDateColumn()
  createdAt: Date;

  @Field(() => Date)
  @UpdateDateColumn()
  updatedAt: Date;

  // Helper Methods
  isPending(): boolean {
    return this.status === InvitationStatus.PENDING;
  }

  isAccepted(): boolean {
    return this.status === InvitationStatus.ACCEPTED;
  }

  isExpired(): boolean {
    if (this.status === InvitationStatus.EXPIRED) return true;
    return this.expiresAt < new Date();
  }

  isCancelled(): boolean {
    return this.status === InvitationStatus.CANCELLED;
  }

  canBeAccepted(): boolean {
    return this.isPending() && !this.isExpired();
  }

  canBeResent(): boolean {
    return (
      (this.status === InvitationStatus.PENDING ||
        this.status === InvitationStatus.EXPIRED ||
        this.status === InvitationStatus.RESENT) &&
      this.sendCount < 5
    );
  }

  getRemainingHours(): number {
    const now = new Date();
    const diff = this.expiresAt.getTime() - now.getTime();
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60)));
  }

  static generateToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 64; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  static getDefaultExpiration(): Date {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date;
  }
}
