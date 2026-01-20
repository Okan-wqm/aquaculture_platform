/**
 * User Entity (Read-only reference)
 *
 * This is a read-only view of the user table owned by auth-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is auth-service.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  TENANT_ADMIN = 'TENANT_ADMIN',
  MODULE_MANAGER = 'MODULE_MANAGER',
  MODULE_USER = 'MODULE_USER',
}

// Read from public schema (shared database) - read-only reference
@Entity('users', { schema: 'public', synchronize: false })
export class UserReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName: string | null;

  @Column({ type: 'varchar', length: 50, default: UserRole.MODULE_USER })
  role: UserRole;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isEmailVerified: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
