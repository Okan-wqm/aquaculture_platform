import { ObjectType, Field, ID, HideField, registerEnumType, Directive } from '@nestjs/graphql';
import { Role } from '@aquaculture/backend-common';
import * as bcrypt from 'bcryptjs';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';

// Register Role enum for GraphQL
registerEnumType(Role, {
  name: 'Role',
  description: 'User roles in the system',
});

/**
 * AccessType — controls whether the user can access web panel, mobile PWA, or both.
 * Used during user creation to auto-provision mobile settings when applicable.
 */
export enum AccessType {
  PANEL_ONLY = 'PANEL_ONLY',
  MOBILE_ONLY = 'MOBILE_ONLY',
  BOTH = 'BOTH',
}

registerEnumType(AccessType, {
  name: 'AccessType',
  description: 'Controls which platforms the user can access',
});

/**
 * User Entity
 *
 * Represents a user in the system with role-based access control.
 * - SUPER_ADMIN: No tenant restriction, full system access
 * - TENANT_ADMIN: Single tenant, full tenant access
 * - MODULE_MANAGER: Single tenant + assigned modules, full module access
 * - MODULE_USER: Single tenant + assigned modules, limited access
 */
@ObjectType()
@Entity('users')
// NOTE: email uniqueness is enforced via a `LOWER(email)` expression index
// created by migration EnforceCaseInsensitiveEmailUniqueness1781300000000.
// TypeORM decorators don't support expression indexes, so the index lives
// in SQL. The @Column below has `unique: true` REMOVED so TypeORM does
// not create a conflicting case-sensitive index at synchronize time.
@Index('IDX_users_tenant', ['tenantId'])
@Index('IDX_users_role', ['role'])
@Index('IDX_users_invitation_token', ['invitationToken'], { unique: true, where: '"invitationToken" IS NOT NULL' })
@Index('IDX_users_password_reset_token', ['passwordResetToken'], { where: '"passwordResetToken" IS NOT NULL' })
export class User {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  // NOTE: column-level `unique: true` REMOVED so TypeORM does not create a
  // case-sensitive auto-index that conflicts with the case-insensitive
  // `LOWER(email)` expression index installed by
  // EnforceCaseInsensitiveEmailUniqueness1781300000000. Uniqueness is still
  // enforced at the DB level — just by the migration, not the decorator.
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @HideField()
  @Column({ type: 'varchar', length: 255, nullable: true })
  password?: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName?: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName?: string | null;

  @Field(() => Role)
  @Column({
    type: 'varchar',
    length: 50,
    default: Role.MODULE_USER,
  })
  role!: Role;

  /**
   * Tenant ID - NULL for SUPER_ADMIN (system-wide access)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  /**
   * Access type — which platforms this user can access.
   * When MOBILE_ONLY or BOTH, mobile_user_settings are auto-provisioned on creation.
   */
  @Field(() => AccessType)
  /**
   * Controls which platforms the user can access (web panel, mobile PWA, or both).
   * Added via migration AddUserAccessType1711700000000.
   * Nullable for backward compatibility with pre-existing rows — defaults to BOTH
   * at the application level when null.
   */
  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    default: 'BOTH',
  })
  accessType?: AccessType | null;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Field()
  @Column({ type: 'boolean', default: false })
  isEmailVerified!: boolean;

  // ============================================
  // Invitation Fields
  // ============================================

  /**
   * Invitation token for new users
   * NULL means user has accepted invitation and set password
   */
  @HideField()
  @Column({ type: 'varchar', length: 128, nullable: true })
  invitationToken?: string | null;

  // SECURITY: Hidden from GraphQL — reveals whether invitation is active (SEC-AUTH-003)
  @HideField()
  @Column({ type: 'timestamptz', nullable: true })
  invitationExpiresAt?: Date | null;

  /**
   * User ID who invited this user
   */
  // SECURITY: Hidden from GraphQL — reveals internal user ID relationships (SEC-AUTH-003)
  @HideField()
  @Column({ type: 'uuid', nullable: true })
  invitedBy?: string | null;

  // ============================================
  // Profile Fields
  // ============================================

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 500, nullable: true })
  profileImageUrl?: string | null;

  // SECURITY: Hidden from GraphQL — PII under GDPR (SEC-AUTH-003)
  @HideField()
  @Column({ type: 'varchar', length: 20, nullable: true })
  phoneNumber?: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 10, nullable: true, default: 'tr' })
  preferredLanguage?: string | null;

  // ============================================
  // Notification Preferences
  // ============================================

  /**
   * Per-user notification preferences stored as JSONB.
   * Defaults are applied at the application layer when null.
   */
  @HideField()
  @Column({ type: 'jsonb', nullable: true, select: false })
  notificationPreferences?: {
    emailEnabled: boolean;
    smsEnabled: boolean;
    pushEnabled: boolean;
    quietHoursStart: string | null;  // HH:mm format, e.g. "22:00"
    quietHoursEnd: string | null;    // HH:mm format, e.g. "07:00"
    quietHoursTimezone: string;      // IANA timezone, e.g. "Europe/Istanbul"
    alertNotifications: boolean;
    taskNotifications: boolean;
    systemNotifications: boolean;
  } | null;

  // ============================================
  // Login & Security Fields
  // ============================================

  @Field()
  @Column({ type: 'boolean', default: false })
  mfaEnabled!: boolean;

  /**
   * TOTP secret for MFA - encrypted at rest with AES-256-GCM.
   * Stored in ENC_V1:{base64} format via MfaService.
   */
  @HideField()
  @Column({ type: 'varchar', length: 512, nullable: true })
  mfaSecret?: string | null;

  /**
   * Recovery codes for MFA - stored as SHA-256 hashes, comma-separated.
   * Each code is single-use; after use, its hash is removed from this list.
   */
  @HideField()
  @Column({ type: 'text', nullable: true })
  mfaRecoveryCodes?: string | null;

  /**
   * Count of failed MFA verification attempts.
   * Resets on successful verification. Lockout at 5 failed attempts.
   */
  @Column({ type: 'int', default: 0 })
  mfaFailedAttempts!: number;

  /**
   * Timestamp until which MFA verification is locked out.
   */
  @Column({ type: 'timestamptz', nullable: true })
  mfaLockedUntil?: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt?: Date | null;

  // SECURITY: Hidden from GraphQL — IP addresses are PII under GDPR Article 4(1) (SEC-AUTH-003)
  @HideField()
  @Column({ type: 'varchar', length: 50, nullable: true })
  lastLoginIp?: string | null;

  @HideField()
  @Column({ type: 'varchar', length: 128, nullable: true })
  passwordResetToken?: string | null;

  @HideField()
  @Column({ type: 'timestamptz', nullable: true })
  passwordResetExpires?: Date | null;

  @Column({ type: 'int', default: 0 })
  failedLoginAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil?: Date | null;

  // ============================================
  // Timestamps
  // ============================================

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  // ============================================
  // Hooks
  // ============================================

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword(): Promise<void> {
    // Only hash if password exists and is not already a bcrypt hash.
    // SECURITY: Use proper bcrypt hash regex instead of startsWith('$2')
    // to avoid false positives on passwords that happen to start with '$2'.
    const bcryptHashPattern = /^\$2[aby]?\$\d{2}\$/;
    if (this.password && !bcryptHashPattern.test(this.password)) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }
  }

  // ============================================
  // Methods
  // ============================================

  async validatePassword(password: string): Promise<boolean> {
    if (!this.password) return false;
    return bcrypt.compare(password, this.password);
  }

  isLocked(): boolean {
    if (!this.lockedUntil) return false;
    return this.lockedUntil > new Date();
  }

  isPendingInvitation(): boolean {
    // SECURITY: Use truthiness check instead of !== null to also catch undefined.
    // A freshly created user object may have invitationToken = undefined (not null).
    return !!this.invitationToken && !this.password;
  }

  isInvitationExpired(): boolean {
    if (!this.invitationExpiresAt) return false;
    return this.invitationExpiresAt < new Date();
  }

  isSuperAdmin(): boolean {
    return this.role === Role.SUPER_ADMIN;
  }

  isTenantAdmin(): boolean {
    return this.role === Role.TENANT_ADMIN;
  }

  isModuleManager(): boolean {
    return this.role === Role.MODULE_MANAGER;
  }

  isModuleUser(): boolean {
    return this.role === Role.MODULE_USER;
  }

  /**
   * Check if user has at least the given role level
   */
  hasRoleOrHigher(requiredRole: Role): boolean {
    const roleOrder = [Role.MODULE_USER, Role.MODULE_MANAGER, Role.TENANT_ADMIN, Role.SUPER_ADMIN];
    const userRoleIndex = roleOrder.indexOf(this.role);
    const requiredRoleIndex = roleOrder.indexOf(requiredRole);
    return userRoleIndex >= requiredRoleIndex;
  }

  /**
   * Get display name
   */
  getDisplayName(): string {
    if (this.firstName && this.lastName) {
      return `${this.firstName} ${this.lastName}`;
    }
    if (this.firstName) return this.firstName;
    return this.email?.split('@')[0] ?? 'User';
  }
}
