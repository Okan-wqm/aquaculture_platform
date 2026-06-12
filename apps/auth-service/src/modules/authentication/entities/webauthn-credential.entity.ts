import { ObjectType, Field, ID, HideField } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * WebAuthn Credential Entity
 *
 * Stores public key credentials registered via the Web Authentication API.
 * Each user can have multiple credentials (one per device/biometric).
 *
 * SECURITY:
 * - Only the public key is stored (private key never leaves the authenticator)
 * - Counter is used to detect cloned authenticators
 * - credentialId is unique across the system to prevent credential confusion
 */
@ObjectType()
@Entity('webauthn_credentials', { schema: 'auth' })
@Index('IDX_webauthn_user', ['userId'])
@Index('IDX_webauthn_credential_id', ['credentialId'], { unique: true })
export class WebAuthnCredential {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @HideField()
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Base64url-encoded credential ID from the authenticator.
   * Used to identify which credential to use during authentication.
   */
  @Field()
  @Column({ type: 'varchar', length: 512 })
  credentialId!: string;

  /**
   * Base64url-encoded public key in COSE format.
   * Used to verify assertion signatures during authentication.
   */
  @HideField()
  @Column({ type: 'text' })
  publicKey!: string;

  /**
   * Signature counter from the authenticator.
   * SECURITY: Incremented on each use. If counter goes backward, it indicates
   * a cloned authenticator and login should be rejected.
   */
  @HideField()
  @Column({ type: 'int', default: 0 })
  counter!: number;

  /**
   * Supported transports for this credential (usb, nfc, ble, internal).
   * Used as hints during authentication to speed up credential selection.
   */
  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  transports?: string[];

  /**
   * User-defined name for this credential (e.g., "iPhone 15", "Work Laptop").
   */
  @Field()
  @Column({ type: 'varchar', length: 100, default: 'Biometric Device' })
  deviceName!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field()
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  lastUsedAt!: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;
}
