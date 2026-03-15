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
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';

@ObjectType()
@Entity('employee_kpis')
@Index('idx_kpi_tenant_employee', ['tenantId', 'employeeId'])
@Index('idx_kpi_tenant_category', ['tenantId', 'category'])
@Index('idx_kpi_tenant_period', ['tenantId', 'periodStart', 'periodEnd'])
export class EmployeeKPI {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  employeeId!: string;

  @Field(() => Employee, { nullable: true })
  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field()
  @Column()
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field()
  @Column()
  category!: string;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  targetValue!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  currentValue!: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  unit?: string;

  @Field()
  @Column({ type: 'date' })
  periodStart!: Date;

  @Field()
  @Column({ type: 'date' })
  periodEnd!: Date;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1.0 })
  weight!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  achievementPercent!: number;

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
}
