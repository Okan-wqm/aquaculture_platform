/**
 * Worker Entity - Farm workers for farm-service
 * Maps to the 'farm_workers' table (separate from HR service's 'employees' table)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common';

@Entity('farm_workers')
@Index(['tenantId', 'email'], { unique: true })
@Index(['tenantId', 'department'])
export class Worker {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  tenantId: string;

  @Column({ unique: true })
  employeeNumber: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column()
  email: string;

  @Column('jsonb')
  contactInfo: { email: string; phone: string; emergencyContact?: string; emergencyPhone?: string };

  @Column('jsonb')
  address: { street: string; city: string; state: string; postalCode: string; country: string };

  @Column({ type: 'date' })
  dateOfBirth: Date;

  @Column()
  nationalId: string;

  @Column({ type: 'varchar', default: 'active' })
  status: string;

  @Column({ type: 'varchar' })
  employmentType: string;

  @Column({ type: 'varchar' })
  department: string;

  @Column()
  position: string;

  @Column({ type: 'date' })
  hireDate: Date;

  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  baseSalary: number;

  @Column({ default: 'USD' })
  currency: string;

  @Column({ default: false })
  isDeleted: boolean;

  @Column({ default: false })
  isFarmWorker: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  createdBy?: string;

  @VersionColumn()
  version: number;
}
