import { ObjectType, Field, ID, HideField, registerEnumType } from '@nestjs/graphql';
import { Role } from '@platform/backend-common';
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
  ManyToOne,
  JoinColumn,
} from 'typeorm';

// Register Role enum for GraphQL
registerEnumType(Role, {
  name: 'Role',
  description: 'User roles in the system',
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
@Index('IDX_users_email', ['email'], { unique: true })
@Index('IDX_users_tenant', ['tenantId'])
@Index('IDX_users_role', ['role'])
@Index('IDX_users_invitation_token', ['invitationToken'], { unique: true, where: '"invitationToken" IS NOT NULL' })
export class User {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @HideField()
  @Column({ type: 'varchar', length: 255, nullable: true })
  password: string;

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
    default: Role.MODULE_USER,
  })
  role: Role;

  /**
   * Tenant ID - NULL for SUPER_ADMIN (system-wide access)
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Field()
  @Column({ type: 'boolean', default: false })
  isEmailVerified: boolean;

  // ============================================
  // Invitation Fields
  // ============================================

  /**
   * Invitation token for new users
   * NULL means user has accepted invitation and set password
   */
  @HideField()
  @Column({ type: 'varchar', length: 128, nullable: true })
  invitationToken: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  invitationExpiresAt: Date | null;

  /**
   * User ID who invited this user
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  invitedBy: string | null;

  // ============================================
  // Login & Security Fields
  // ============================================

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt: Date | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  lastLoginIp: string | null;

  @HideField()
  @Column({ type: 'varchar', length: 128, nullable: true })
  passwordResetToken: string | null;

  @HideField()
  @Column({ type: 'timestamp', nullable: true })
  passwordResetExpires: Date | null;

  @Column({ type: 'int', default: 0 })
  failedLoginAttempts: number;

  @Column({ type: 'timestamp', nullable: true })
  lockedUntil: Date | null;

  // ============================================
  // Timestamps
  // ============================================

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  // ============================================
  // Hooks
  // ============================================

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    // Only hash if password exists and is not already hashed
    if (this.password && !this.password.startsWith('$2')) {
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
    return this.invitationToken !== null && !this.password;
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
