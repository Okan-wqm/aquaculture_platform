import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { CertificationType } from './certification-type.entity';

export enum CertificationStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  EXPIRING_SOON = 'expiring_soon',
  REVOKED = 'revoked',
  SUSPENDED = 'suspended',
}

export enum VerificationStatus {
  UNVERIFIED = 'unverified',
  PENDING_VERIFICATION = 'pending_verification',
  VERIFIED = 'verified',
  VERIFICATION_FAILED = 'verification_failed',
}

registerEnumType(CertificationStatus, { name: 'CertificationStatus' });
registerEnumType(VerificationStatus, { name: 'VerificationStatus' });

@ObjectType()
export class CertificationDocument {
  @Field()
  documentId!: string;

  @Field()
  fileName!: string;

  @Field()
  uploadedAt!: Date;

  @Field({ nullable: true })
  documentType?: string;
}

@ObjectType()
@Entity('employee_certifications', { schema: 'hr' })
@Index(['tenantId', 'certificationNumber'], { unique: true })
@Index(['tenantId', 'employeeId', 'certificationTypeId'])
@Index(['tenantId', 'status', 'expiryDate'])
@Index(['tenantId', 'expiryDate'])
@Index(['tenantId', 'verificationStatus'])
export class EmployeeCertification {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 50 })
  certificationNumber!: string;

  @Field()
  @Column()
  @Index()
  employeeId!: string;

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field()
  @Column()
  certificationTypeId!: string;

  @ManyToOne(() => CertificationType)
  @JoinColumn({ name: 'certificationTypeId' })
  certificationType?: CertificationType;

  @Field()
  @Column({ type: 'date' })
  issueDate!: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expiryDate?: Date;

  @Field(() => CertificationStatus)
  @Column({ type: 'enum', enum: CertificationStatus, default: CertificationStatus.PENDING })
  status!: CertificationStatus;

  @Field(() => VerificationStatus)
  @Column({ type: 'enum', enum: VerificationStatus, default: VerificationStatus.UNVERIFIED })
  verificationStatus!: VerificationStatus;

  @Field({ nullable: true })
  @Column({ nullable: true })
  verifiedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  issuingAuthority?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  externalCertificationId?: string; // ID from external authority

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => [CertificationDocument], { nullable: true })
  @Column('jsonb', { nullable: true })
  documents?: CertificationDocument[];

  // For revocations
  @Field({ nullable: true })
  @Column({ nullable: true })
  revokedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  revocationReason?: string;

  // For renewals
  @Field({ nullable: true })
  @Column({ nullable: true })
  previousCertificationId?: string;

  @Field()
  @Column({ default: false })
  isRenewal!: boolean;

  @Field()
  @Column({ default: false })
  reminderSent!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  reminderSentAt?: Date;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  @Field()
  @Column({ default: false })
  isDeleted!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedBy?: string;

  @BeforeInsert()
  generateCertificationNumber(): void {
    if (!this.certificationNumber) {
      const year = new Date().getFullYear();
      const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
      this.certificationNumber = `CERT-${year}-${random}`;
    }
  }
}
