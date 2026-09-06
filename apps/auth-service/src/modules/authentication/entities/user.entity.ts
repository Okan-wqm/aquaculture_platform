import {
  hashPassword as hashPasswordWithPepper,
  verifyPassword as verifyPasswordWithPepper,
  PEPPERED_PREFIX_V1,
} from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import { ObjectType, Field, ID, HideField, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
  Unique,
  Check,
} from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';

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
// AUTHENTICATED user type — returned ONLY by auth's own self/admin queries
// (currentUser, tenantUsers, login/register payloads). email/role/tenantId are
// safe here because `User` is NOT a federation join point anymore: cross-subgraph
// references (messaging `Message.sender`, `ChannelMember.user`, userPresence) use
// the display-only `PublicUserProfile` (public-user-profile.type.ts), which
// structurally omits email. So `email` below stays non-null and can never resolve
// to null over a federated reference. The `@key` + reference resolver moved to
// PublicUserProfile (PublicUserProfileFederationResolver). SSoT: auth owns both
// shapes of user identity; the public one carries no PII.
@Entity('users', { schema: 'auth' })
@Unique('UQ_users_id_tenant', ['id', 'tenantId'])
@Check('CHK_users_credential_version_positive', '"credentialVersion" > 0')
@Check('CHK_users_access_token_cutoff_range', '"accessTokenInvalidBeforeEpochSeconds" >= 0 AND "accessTokenInvalidBeforeEpochSeconds" <= 9007199254740991')
// NOTE: email uniqueness is enforced via a `LOWER(email)` expression index
// created by migration RestoreCaseInsensitiveEmailUniqueness1800300000000
// (successor of the archived EnforceCaseInsensitiveEmailUniqueness — the
// Baseline consolidation dropped the index, the Restore migration re-installs
// it). TypeORM decorators don't support expression indexes, so the index
// lives in SQL. The @Column below has `unique: true` REMOVED so TypeORM does
// not create a conflicting case-sensitive index at synchronize time.
@Index('IDX_users_tenant', ['tenantId'])
@Index('IDX_users_role', ['role'])
@Index('IDX_users_invitation_token', ['invitationToken'], {
  unique: true,
  where: '"invitationToken" IS NOT NULL',
})
@Index('IDX_users_password_reset_token', ['passwordResetToken'], {
  where: '"passwordResetToken" IS NOT NULL',
})
export class User {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @HideField()
  @Column({ type: 'integer', default: 1, insert: false, update: false })
  credentialVersion!: number;

  @HideField()
  @Column({ type: 'bigint', default: 0, transformer: {
    to: (value: number): number => value,
    from: (value: string | number): number => {
      const epoch = Number(value);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('Invalid access-token cutoff');
      return epoch;
    },
  } })
  accessTokenInvalidBeforeEpochSeconds!: number;

  @Field()
  // NOTE: column-level `unique: true` REMOVED so TypeORM does not create a
  // case-sensitive auto-index that conflicts with the case-insensitive
  // `LOWER(email)` expression index installed by
  // RestoreCaseInsensitiveEmailUniqueness1800300000000. Uniqueness is still
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

  @ManyToOne(() => Tenant, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant | null;

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
    quietHoursStart: string | null; // HH:mm format, e.g. "22:00"
    quietHoursEnd: string | null; // HH:mm format, e.g. "07:00"
    quietHoursTimezone: string; // IANA timezone, e.g. "Europe/Istanbul"
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

  /**
   * SECURITY (SEC-HIGH-001): last consumed TOTP time-step (counter).
   * A TOTP code is single-use — verification persists the matched step here
   * and rejects any later code whose step is ≤ this value, so a captured code
   * cannot be replayed within its ±window validity. bigint (epoch/period)
   * never wraps in practice. Hidden from GraphQL — internal security state.
   */
  @HideField()
  @Column({ type: 'bigint', nullable: true })
  lastUsedTotpStep?: string | null;

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

  // ORPHAN-MEDIUM-320: exposed to GraphQL so tenant-admin user management
  // can SHOW the lock state and offer the unlock action. Non-sensitive: a
  // future instant, visible only through the already-role-guarded tenant
  // user queries.
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil?: Date | null;

  // ============================================
  // Timestamps
  // ============================================

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // ============================================
  // Hooks
  // ============================================

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword(): Promise<void> {
    // SECURITY (HIGH-006): HMAC-peppered bcrypt via hashPasswordWithPepper.
    // Already-hashed values are detected by the `p1:` prefix (new format) or
    // the bcrypt `$2*$` prefix (legacy format) and left alone so subsequent
    // @BeforeUpdate hooks do not double-hash.
    if (!this.password) return;
    const bcryptHashPattern = /^\$2[aby]?\$\d{2}\$/;
    if (this.password.startsWith(PEPPERED_PREFIX_V1) || bcryptHashPattern.test(this.password)) {
      return;
    }
    this.password = await hashPasswordWithPepper(this.password);
  }

  // ============================================
  // Methods
  // ============================================

  /**
   * Verify a plaintext password against this entity's stored hash.
   *
   * SECURITY (HIGH-006): delegates to verifyPasswordWithPepper which routes
   * between peppered (`p1:` prefix) and legacy bcrypt formats. The returned
   * boolean is the match result; callers that need the lazy-migration hint
   * should call the util directly and persist the re-hashed password when
   * `shouldMigrate` is true.
   */
  async validatePassword(password: string): Promise<boolean> {
    if (!this.password) return false;
    const result = await verifyPasswordWithPepper(password, this.password);
    return result.matched;
  }

  /**
   * Lower-level verification that exposes the lazy-migration signal. Use this
   * from the login path so legacy bcrypt hashes transparently upgrade to
   * peppered on successful login.
   */
  async verifyPasswordAndSignalMigration(password: string): Promise<{
    matched: boolean;
    shouldMigrate: boolean;
  }> {
    if (!this.password) return { matched: false, shouldMigrate: false };
    return verifyPasswordWithPepper(password, this.password);
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
