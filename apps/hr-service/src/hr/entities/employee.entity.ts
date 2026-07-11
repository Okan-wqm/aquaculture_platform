import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  OneToMany,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, HideField, ID, Int, registerEnumType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';
import { Payroll } from './payroll.entity';
import { DepartmentHR } from './department.entity';

export enum EmployeeStatus {
  ACTIVE = 'active',
  ON_LEAVE = 'on_leave',
  TERMINATED = 'terminated',
  SUSPENDED = 'suspended',
}

export enum EmploymentType {
  FULL_TIME = 'full_time',
  PART_TIME = 'part_time',
  CONTRACT = 'contract',
  SEASONAL = 'seasonal',
}

export enum Department {
  OPERATIONS = 'operations',
  MAINTENANCE = 'maintenance',
  FEEDING = 'feeding',
  QUALITY_CONTROL = 'quality_control',
  ADMINISTRATION = 'administration',
  MANAGEMENT = 'management',
  LOGISTICS = 'logistics',
  SECURITY = 'security',
}

// Aquaculture-specific: Personnel Category for offshore/onshore classification
export enum PersonnelCategory {
  OFFSHORE = 'offshore',
  ONSHORE = 'onshore',
  HYBRID = 'hybrid',
}

/**
 * Workforce category for labour-cost analytics (Personnel Table /
 * Labour Cost read models). Structured — the free-text `position`
 * field cannot answer "how many managers / technicians / unskilled
 * workers?". NULL = unclassified; surfaced as an explicit bucket with
 * a UI call-to-action rather than silently miscounted.
 *
 *  - MANAGER    — management staff
 *  - TECHNICAL  — technicians / biologists / water-quality experts
 *  - UNSKILLED  — unskilled labour
 */
export enum LaborCategory {
  MANAGER = 'manager',
  TECHNICAL = 'technical',
  UNSKILLED = 'unskilled',
}

// Import shared WorkAreaType enum
import { WorkAreaType } from '../../common/enums';

registerEnumType(EmployeeStatus, { name: 'EmployeeStatus' });
registerEnumType(EmploymentType, { name: 'EmploymentType' });
registerEnumType(Department, { name: 'HRDepartment' });
registerEnumType(PersonnelCategory, { name: 'PersonnelCategory' });
registerEnumType(LaborCategory, { name: 'LaborCategory' });
// WorkAreaType is registered in common/enums.ts

@ObjectType()
export class ContactInfo {
  @Field()
  email!: string;

  @Field()
  phone!: string;

  @Field({ nullable: true })
  emergencyContact?: string;

  @Field({ nullable: true })
  emergencyPhone?: string;
}

@ObjectType()
export class Address {
  @Field()
  street!: string;

  @Field()
  city!: string;

  @Field()
  state!: string;

  @Field()
  postalCode!: string;

  @Field()
  country!: string;
}

/**
 * BankDetails - Internal-only type for payroll operations.
 * SECURITY: Not exposed via GraphQL to prevent bank account data leakage.
 */
export class BankDetails {
  bankName!: string;
  accountNumber!: string;
  routingNumber!: string;
  iban?: string;
  swiftCode?: string;
}

@ObjectType()
export class NextOfKin {
  @Field()
  name!: string;

  @Field()
  relationship!: string;

  @Field()
  phone!: string;

  @Field({ nullable: true })
  email?: string;
}

/**
 * EmergencyInfo -- internal-only type for safety operations.
 *
 * SECURITY: @ObjectType() and @Field() decorators intentionally removed.
 * Medical data (bloodType, medicalConditions, allergies) MUST NOT appear in
 * GraphQL schema introspection. Access is restricted to a dedicated secure
 * resolver with audit logging.
 *
 * @see HR-CRITICAL-002
 */
export class EmergencyInfo {
  bloodType?: string;

  medicalConditions?: string[];

  allergies?: string[];

  nextOfKin?: NextOfKin;
}

@ObjectType()
@Entity('employees')
// Unique composite indexes
@Index('idx_employee_email_tenant', ['tenantId', 'email'], { unique: true })
@Index('idx_employee_number_tenant', ['employeeNumber', 'tenantId'], { unique: true })
// REMOVED: idx_employee_tenant single-column index on tenantId — redundant.
// The composite indexes idx_employee_email_tenant, idx_employee_number_tenant,
// idx_employee_status_tenant all start with tenantId and serve single-column lookups.
// Keeping the redundant index wastes write amplification on every INSERT/UPDATE.
// @see DB-MEDIUM-002
@Index('idx_employee_email', ['email'])
@Index('idx_employee_department', ['departmentHrId'])
// Composite indexes for common query patterns
@Index('idx_employee_status_tenant', ['status', 'tenantId'])
@Index(['tenantId', 'department'])
@Index(['tenantId', 'departmentHrId'])
@Index(['tenantId', 'farmId'])
@Index(['tenantId', 'personnelCategory'])
@Index(['tenantId', 'seaWorthy'])
export class Employee {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // REMOVED: @Index() on tenantId — redundant with composite indexes
  // that start with tenantId (idx_employee_email_tenant, idx_employee_status_tenant, etc.).
  // @see DB-MEDIUM-002
  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column()
  employeeNumber!: string;

  @Field()
  @Column()
  firstName!: string;

  @Field()
  @Column()
  lastName!: string;

  @Field()
  @Column()
  email!: string;

  @Field(() => ContactInfo)
  @Column('jsonb')
  contactInfo!: ContactInfo;

  @Field(() => Address)
  @Column('jsonb')
  address!: Address;

  @HideField()
  @Column({ type: 'date' })
  dateOfBirth!: Date;

  /**
   * SECURITY: Government ID encrypted at rest with AES-256-GCM.
   * DB column stores ciphertext; application decrypts on read.
   * Direct SQL queries return encrypted values, not plaintext.
   *
   * CHECK constraint enforces format validation at the database level:
   * - Rejects empty strings (must have at least 5 characters)
   * - Enforces maximum length of 20 characters
   * National ID formats vary by country, but this range covers all known formats
   * while preventing data entry errors.
   * @see DB-CRITICAL-001
   * @see DB-MEDIUM-003 (nationalId format validation)
   */
  @HideField()
  @Column({ type: 'text', transformer: createEncryptedColumnTransformer('EMPLOYEE_PII_ENCRYPTION_KEY') })
  nationalId!: string;

  @Field(() => EmployeeStatus)
  @Column({ type: 'enum', enum: EmployeeStatus, default: EmployeeStatus.ACTIVE })
  status!: EmployeeStatus;

  @Field(() => EmploymentType)
  @Column({ type: 'enum', enum: EmploymentType })
  employmentType!: EmploymentType;

  @Field(() => Department)
  @Column({ type: 'enum', enum: Department })
  department!: Department;

  @Field()
  @Column()
  position!: string;

  /**
   * Structured workforce category (migration 1801600000000 auto-maps
   * existing rows from position/department text; editable in the
   * employee form). NULL renders as UNCLASSIFIED in finance read models.
   */
  @Field(() => LaborCategory, { nullable: true })
  @Column({
    type: 'enum',
    enum: LaborCategory,
    enumName: 'employees_laborcategory_enum',
    nullable: true,
  })
  laborCategory?: LaborCategory | null;

  @Field(() => Date)
  @Column({ type: 'date' })
  hireDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'date', nullable: true })
  terminationDate?: Date;

  @HideField()
  // DecimalTransformer: baseSalary is the base for payroll calculations (overtime multipliers,
  // pro-rata for partial months, annual leave encashment). String multiplication produces NaN.
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  baseSalary!: number;

  @Field()
  @Column({ default: 'USD' })
  currency!: string;

  /**
   * SECURITY: Bank details encrypted at rest with AES-256-GCM (JSONB serialized).
   * Column type changed from jsonb to text to store ciphertext string.
   * Application transparently encrypts/decrypts via ValueTransformer.
   * @see DB-CRITICAL-001
   */
  @HideField()
  @Column({ type: 'text', nullable: true, transformer: createEncryptedColumnTransformer('EMPLOYEE_PII_ENCRYPTION_KEY', { json: true }) })
  bankDetails?: BankDetails;

  @Field({ nullable: true })
  @Column({ nullable: true })
  farmId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  supervisorId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  userId?: string;

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  certifications?: string[];

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  skills?: string[];

  @HideField()
  @OneToMany(() => Payroll, (payroll) => payroll.employee)
  payrolls?: Payroll[];

  // ==========================================
  // Aquaculture-specific fields
  // ==========================================

  @Field(() => PersonnelCategory, { nullable: true })
  @Column({ type: 'enum', enum: PersonnelCategory, nullable: true })
  personnelCategory?: PersonnelCategory;

  @Field(() => [WorkAreaType], { nullable: true })
  @Column('simple-array', { nullable: true })
  assignedWorkAreas?: WorkAreaType[];

  @Field()
  @Column({ default: false })
  seaWorthy!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  positionId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  departmentHrId?: string;

  @Field(() => DepartmentHR, { nullable: true })
  @ManyToOne(() => DepartmentHR, { nullable: true })
  @JoinColumn({ name: 'departmentHrId' })
  departmentHr?: DepartmentHR;

  @HideField()
  @Column('jsonb', { nullable: true })
  emergencyInfo?: EmergencyInfo;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  currentRotationId!: string | null;

  /**
   * IANA timezone string for the employee's local timezone (e.g., 'Asia/Manila')
   * Used for attendance tracking and shift calculations
   */
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true, default: 'UTC' })
  timezone?: string;

  // ==========================================
  // Audit fields
  // ==========================================

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

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;

  @Field()
  @Column({ default: false })
  isDeleted!: boolean;

  @Field()
  @Column({ default: false })
  isFarmWorker!: boolean;

  /**
   * Sanitize and normalize data before insert.
   * Includes nationalId format validation at the application level.
   * @see DB-MEDIUM-003 (nationalId validation)
   */
  @BeforeInsert()
  @BeforeUpdate()
  sanitize(): void {
    // Normalize email to lowercase
    if (this.email) {
      this.email = this.email.toLowerCase().trim();
    }
    // Normalize names (trim whitespace)
    if (this.firstName) {
      this.firstName = this.firstName.trim();
    }
    if (this.lastName) {
      this.lastName = this.lastName.trim();
    }
    // Sanitize contact info email
    if (this.contactInfo?.email) {
      this.contactInfo.email = this.contactInfo.email.toLowerCase().trim();
    }
    // Validate nationalId format: reject empty strings, enforce length 5-20.
    // National IDs vary by country but this range covers all known formats.
    // @see DB-MEDIUM-003
    if (this.nationalId !== undefined && this.nationalId !== null) {
      const trimmed = this.nationalId.trim();
      if (trimmed.length < 5 || trimmed.length > 20) {
        throw new Error(
          `nationalId must be between 5 and 20 characters, got ${trimmed.length}`,
        );
      }
    }
  }
}
