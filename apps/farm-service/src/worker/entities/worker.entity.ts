/**
 * Worker Entity - Simplified view of HR employees table for farm-service
 * Maps to the 'employees' table (shared with HR service)
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

@Entity('employees')
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

  @Column({ type: 'decimal', precision: 12, scale: 2 })
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
