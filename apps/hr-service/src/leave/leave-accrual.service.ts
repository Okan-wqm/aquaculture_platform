import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LeaveType } from './entities/leave-type.entity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { Employee, EmployeeStatus } from '../hr/entities/employee.entity';

/**
 * Scheduled service for leave accrual processing.
 *
 * Responsibilities:
 * 1. Monthly accrual: add accrualRate to each eligible employee's leave balance
 * 2. Year-end rollover: carry over remaining balance (up to maxCarryOverDays) into new year
 *
 * Safety:
 * - Idempotent: lastAccrualDate prevents double-accrual within the same month
 * - Tenant-scoped: processes each tenant independently via tenantId column
 * - Transactional: each tenant's accrual runs inside a single transaction
 */
@Injectable()
export class LeaveAccrualService {
  private readonly logger = new Logger(LeaveAccrualService.name);

  constructor(
    @InjectRepository(LeaveType)
    private readonly leaveTypeRepository: Repository<LeaveType>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Monthly accrual – 1st of every month at midnight
  // ---------------------------------------------------------------------------
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async processMonthlyAccrual(): Promise<void> {
    this.logger.log('Starting monthly leave accrual processing...');
    const now = new Date();

    try {
      // Discover all distinct tenants that have accrual-based leave types
      const tenantRows: { tenantId: string }[] = await this.leaveTypeRepository
        .createQueryBuilder('lt')
        .select('DISTINCT lt.tenantId', 'tenantId')
        .where('lt.isAccrued = :isAccrued', { isAccrued: true })
        .andWhere('lt.isActive = :isActive', { isActive: true })
        .andWhere('lt.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('lt.accrualRate IS NOT NULL')
        .getRawMany();

      this.logger.log(`Found ${tenantRows.length} tenant(s) with accrual leave types.`);

      let totalAccrued = 0;
      let totalCreated = 0;

      for (const { tenantId } of tenantRows) {
        const result = await this.processTenantAccrual(tenantId, now);
        totalAccrued += result.accrued;
        totalCreated += result.created;
      }

      this.logger.log(
        `Monthly accrual complete. Balances updated: ${totalAccrued}, new balances created: ${totalCreated}.`,
      );
    } catch (error) {
      this.logger.error(
        `Monthly accrual failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Process accrual for a single tenant inside a transaction.
   */
  private async processTenantAccrual(
    tenantId: string,
    now: Date,
  ): Promise<{ accrued: number; created: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let accrued = 0;
    let created = 0;

    try {
      const manager = queryRunner.manager;

      // 1. Fetch accrual-eligible leave types for this tenant
      const leaveTypes = await manager.find(LeaveType, {
        where: {
          tenantId,
          isAccrued: true,
          isActive: true,
          isDeleted: false,
        },
      });

      // Filter leave types that actually have an accrualRate set
      const accrualLeaveTypes = leaveTypes.filter(
        (lt) => lt.accrualRate != null && Number(lt.accrualRate) > 0,
      );

      if (accrualLeaveTypes.length === 0) {
        await queryRunner.rollbackTransaction();
        return { accrued: 0, created: 0 };
      }

      // 2. Fetch all active employees for this tenant
      const employees = await manager.find(Employee, {
        where: {
          tenantId,
          status: EmployeeStatus.ACTIVE,
          isDeleted: false,
        },
      });

      if (employees.length === 0) {
        await queryRunner.rollbackTransaction();
        return { accrued: 0, created: 0 };
      }

      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth(); // 0-based

      for (const leaveType of accrualLeaveTypes) {
        const rate = Number(leaveType.accrualRate);
        const waitMonths = leaveType.accrualStartAfterMonths || 0;

        for (const employee of employees) {
          // Check if employee has served the accrual start waiting period
          const hireDate = new Date(employee.hireDate);
          const eligibleDate = new Date(hireDate);
          eligibleDate.setMonth(eligibleDate.getMonth() + waitMonths);

          if (now < eligibleDate) {
            // Employee hasn't completed the waiting period yet
            continue;
          }

          // Find or create leave balance for current year
          let balance = await manager.findOne(LeaveBalance, {
            where: {
              tenantId,
              employeeId: employee.id,
              leaveTypeId: leaveType.id,
              year: currentYear,
              isDeleted: false,
            },
          });

          if (!balance) {
            // Create a new balance record for the current year
            balance = manager.create(LeaveBalance, {
              tenantId,
              employeeId: employee.id,
              leaveTypeId: leaveType.id,
              year: currentYear,
              openingBalance: 0,
              accrued: 0,
              used: 0,
              pending: 0,
              adjustment: 0,
              carriedOver: 0,
            });
            balance = await manager.save(LeaveBalance, balance);
            created++;
          }

          // Idempotency check: skip if already accrued this month
          if (balance.lastAccrualDate) {
            const lastAccrual = new Date(balance.lastAccrualDate);
            if (
              lastAccrual.getFullYear() === currentYear &&
              lastAccrual.getMonth() === currentMonth
            ) {
              // Already processed this month — skip
              continue;
            }
          }

          // Apply accrual
          const currentAccrued = Number(balance.accrued) || 0;
          const newAccrued = currentAccrued + rate;

          // If maxCarryOverDays is defined, cap total accrued balance
          // (this prevents unlimited accumulation within the year)
          const maxDays = leaveType.maxCarryOverDays != null
            ? Number(leaveType.maxCarryOverDays)
            : null;
          const defaultDays = leaveType.defaultDaysPerYear != null
            ? Number(leaveType.defaultDaysPerYear)
            : null;

          // Cap: accrued should not exceed defaultDaysPerYear (annual entitlement cap)
          let cappedAccrued = newAccrued;
          if (defaultDays != null && cappedAccrued > defaultDays) {
            cappedAccrued = defaultDays;
          }

          balance.accrued = cappedAccrued;
          balance.lastAccrualDate = now;

          await manager.save(LeaveBalance, balance);
          accrued++;
        }
      }

      await queryRunner.commitTransaction();
      this.logger.log(
        `Tenant ${tenantId}: accrued ${accrued} balance(s), created ${created} new balance record(s).`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Tenant ${tenantId} accrual failed, rolled back: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      await queryRunner.release();
    }

    return { accrued, created };
  }

  // ---------------------------------------------------------------------------
  // Year-end rollover – January 1st at midnight
  // ---------------------------------------------------------------------------
  @Cron('0 0 1 1 *')
  async processYearEndRollover(): Promise<void> {
    this.logger.log('Starting year-end leave balance rollover...');

    try {
      const now = new Date();
      const newYear = now.getFullYear(); // The year we are entering (e.g. 2027)
      const previousYear = newYear - 1;

      // Discover all tenants that have leave balances for the previous year
      const tenantRows: { tenantId: string }[] = await this.leaveBalanceRepository
        .createQueryBuilder('lb')
        .select('DISTINCT lb.tenantId', 'tenantId')
        .where('lb.year = :year', { year: previousYear })
        .andWhere('lb.isDeleted = :isDeleted', { isDeleted: false })
        .getRawMany();

      this.logger.log(
        `Year-end rollover: found ${tenantRows.length} tenant(s) with balances for year ${previousYear}.`,
      );

      let totalRolled = 0;

      for (const { tenantId } of tenantRows) {
        const rolled = await this.processTenantRollover(tenantId, previousYear, newYear);
        totalRolled += rolled;
      }

      this.logger.log(
        `Year-end rollover complete. ${totalRolled} balance(s) carried over from ${previousYear} to ${newYear}.`,
      );
    } catch (error) {
      this.logger.error(
        `Year-end rollover failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Process year-end rollover for a single tenant inside a transaction.
   */
  private async processTenantRollover(
    tenantId: string,
    previousYear: number,
    newYear: number,
  ): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let rolledOver = 0;

    try {
      const manager = queryRunner.manager;

      // Fetch all previous year balances for this tenant (with leave type info for maxCarryOverDays)
      const previousBalances = await manager.find(LeaveBalance, {
        where: {
          tenantId,
          year: previousYear,
          isDeleted: false,
        },
        relations: ['leaveType'],
      });

      for (const prevBalance of previousBalances) {
        // Check if the employee is still active
        const employee = await manager.findOne(Employee, {
          where: {
            id: prevBalance.employeeId,
            tenantId,
            status: EmployeeStatus.ACTIVE,
            isDeleted: false,
          },
        });

        if (!employee) {
          // Terminated/inactive employees don't get rollover
          continue;
        }

        // Calculate remaining balance
        const remaining =
          Number(prevBalance.openingBalance) +
          Number(prevBalance.accrued) +
          Number(prevBalance.carriedOver) +
          Number(prevBalance.adjustment) -
          Number(prevBalance.used);

        if (remaining <= 0) {
          // Nothing to carry over
          continue;
        }

        // Determine carry-over cap
        const maxCarryOver = prevBalance.leaveType?.maxCarryOverDays != null
          ? Number(prevBalance.leaveType.maxCarryOverDays)
          : null;

        const carryOverAmount = maxCarryOver != null
          ? Math.min(remaining, maxCarryOver)
          : remaining; // No cap defined = carry full remaining

        if (carryOverAmount <= 0) {
          continue;
        }

        // Check if a balance record already exists for the new year (idempotency)
        let newBalance = await manager.findOne(LeaveBalance, {
          where: {
            tenantId,
            employeeId: prevBalance.employeeId,
            leaveTypeId: prevBalance.leaveTypeId,
            year: newYear,
            isDeleted: false,
          },
        });

        if (newBalance) {
          // Already exists — update carriedOver only if it hasn't been set yet
          if (Number(newBalance.carriedOver) === 0) {
            newBalance.carriedOver = carryOverAmount;
            await manager.save(LeaveBalance, newBalance);
            rolledOver++;
          }
          // If carriedOver is already > 0, skip (idempotent)
        } else {
          // Create new year balance with carry-over
          newBalance = manager.create(LeaveBalance, {
            tenantId,
            employeeId: prevBalance.employeeId,
            leaveTypeId: prevBalance.leaveTypeId,
            year: newYear,
            openingBalance: 0,
            accrued: 0,
            used: 0,
            pending: 0,
            adjustment: 0,
            carriedOver: carryOverAmount,
          });
          await manager.save(LeaveBalance, newBalance);
          rolledOver++;
        }
      }

      await queryRunner.commitTransaction();
      this.logger.log(
        `Tenant ${tenantId}: rolled over ${rolledOver} balance(s) from ${previousYear} to ${newYear}.`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Tenant ${tenantId} rollover failed, rolled back: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      await queryRunner.release();
    }

    return rolledOver;
  }
}
