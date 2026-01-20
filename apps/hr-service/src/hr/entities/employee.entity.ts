import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  OneToMany,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Payroll } from './payroll.entity';

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

// Aquaculture-specific: Work Area Types
export enum WorkAreaType {
  SHORE_FACILITY = 'shore_facility',
  SEA_CAGE = 'sea_cage',
  FLOATING_PLATFORM = 'floating_platform',
  VESSEL = 'vessel',
  FEED_BARGE = 'feed_barge',
  PROCESSING_PLANT = 'processing_plant',
  HATCHERY = 'hatchery',
  LABORATORY = 'laboratory',
  OFFICE = 'office',
  WAREHOUSE = 'warehouse',
  WORKSHOP = 'workshop',
  OTHER = 'other',
}

registerEnumType(EmployeeStatus, { name: 'EmployeeStatus' });
registerEnumType(EmploymentType, { name: 'EmploymentType' });
registerEnumType(Department, { name: 'Department' });
registerEnumType(PersonnelCategory, { name: 'PersonnelCategory' });
registerEnumType(WorkAreaType, { name: 'WorkAreaType' });

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

@ObjectType()
export class BankDetails {
  @Field()
  bankName!: string;

  @Field()
  accountNumber!: string;

  @Field()
  routingNumber!: string;

  @Field({ nullable: true })
  iban?: string;

  @Field({ nullable: true })
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

@ObjectType()
export class EmergencyInfo {
  @Field({ nullable: true })
  bloodType?: string;

  @Field(() => [String], { nullable: true })
  medicalConditions?: string[];

  @Field(() => [String], { nullable: true })
  allergies?: string[];

  @Field(() => NextOfKin, { nullable: true })
  nextOfKin?: NextOfKin;
}

@ObjectType()
@Entity('employees', { schema: 'hr' })
@Index(['tenantId', 'email'], { unique: true })
@Index(['tenantId', 'employeeNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'department'])
@Index(['tenantId', 'farmId'])
@Index(['tenantId', 'personnelCategory'])
@Index(['tenantId', 'seaWorthy'])
export class Employee {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ unique: true })
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

  @Field(() => Date)
  @Column({ type: 'date' })
  dateOfBirth!: Date;

  @Field()
  @Column()
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

  @Field(() => Date)
  @Column({ type: 'date' })
  hireDate!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'date', nullable: true })
  terminationDate?: Date;

  @Field()
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  baseSalary!: number;

  @Field()
  @Column({ default: 'USD' })
  currency!: string;

  @Field(() => BankDetails, { nullable: true })
  @Column('jsonb', { nullable: true })
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

  @Field(() => [Payroll], { nullable: true })
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

  @Field(() => EmergencyInfo, { nullable: true })
  @Column('jsonb', { nullable: true })
  emergencyInfo?: EmergencyInfo;

  @Field({ nullable: true })
  @Column({ nullable: true })
  currentRotationId?: string;

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

  /**
   * Sanitize and normalize data before insert
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
  }
}
