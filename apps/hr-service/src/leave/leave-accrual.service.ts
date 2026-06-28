import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { listTenantSchemas } from '@aquaculture/backend-common/database';
import { LeaveType } from './entities/leave-type.entity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { Employee, EmployeeStatus } from '../hr/entities/employee.entity';

/**
 * Outcome of a single tenant-schema carry-over run, surfaced to the
 * on-demand carryOverLeaveBalances mutation.
 */
export interface CarryOverOutcome {
  processed: number;
  successful: number;
  failed: number;
  errors: string[];
}

/**
 * Scheduled service for leave accrual processing.
 *
 * Responsibilities:
 * 1. Monthly accrual: add accrualRate to each eligible employee's leave balance
 * 2. Year-end rollover: carry over remaining balance (up to maxCarryOverDays) into new year
 *
 * Safety:
 * - Idempotent: lastAccrualDate prevents double-accrual within the same month
 * - Tenant-scoped: iterates tenant_* schemas via search_path isolation
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
  // Tenant schema discovery — uses listTenantSchemas from @aquaculture/backend-common
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Monthly accrual – 1st of every month at midnight
  // ---------------------------------------------------------------------------
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async processMonthlyAccrual(): Promise<void> {
    this.logger.log('Starting monthly leave accrual processing...');
    const now = new Date();

    try {
      const tenantSchemas = await listTenantSchemas(this.dataSource);
      if (tenantSchemas.length === 0) {
        this.logger.debug('No tenant schemas found, skipping monthly accrual');
        return;
      }

      this.logger.log(`Processing monthly accrual for ${tenantSchemas.length} tenant schema(s).`);

      let totalAccrued = 0;
      let totalCreated = 0;

      for (const schema of tenantSchemas) {
        const result = await this.processTenantAccrual(schema, now);
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
   * Process accrual for a single tenant schema inside a transaction.
   */
  private async processTenantAccrual(
    schemaName: string,
    now: Date,
  ): Promise<{ accrued: number; created: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    let accrued = 0;
    let created = 0;

    try {
      // Set search_path BEFORE starting the transaction
      await queryRunner.query(`SET search_path TO "${schemaName}", hr, public`);
      await queryRunner.startTransaction();

      const manager = queryRunner.manager;

      // 1. Fetch accrual-eligible leave types within this tenant schema
      const leaveTypes = await manager.find(LeaveType, {
        where: {
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

      // 2. Fetch all active employees within this tenant schema
      const employees = await manager.find(Employee, {
        where: {
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

      // HR-HIGH-007: Replaced O(N^2) nested loop (leaveTypes x employees) with
      // a batch approach. For each leave type, we pre-fetch all existing balances
      // in a single query and index them by employeeId for O(1) lookup.
      // This reduces DB round-trips from O(employees * leaveTypes) to O(leaveTypes).

      for (const leaveType of accrualLeaveTypes) {
        const rate = Number(leaveType.accrualRate);
        const waitMonths = leaveType.accrualStartAfterMonths || 0;
        const defaultDays = leaveType.defaultDaysPerYear != null
          ? Number(leaveType.defaultDaysPerYear)
          : null;

        // ── Single query: all balances for this leave type + year ──
        const existingBalances = await manager.find(LeaveBalance, {
          where: {
            leaveTypeId: leaveType.id,
            year: currentYear,
            isDeleted: false,
          },
        });

        // Index by employeeId for O(1) lookup
        const balanceByEmployeeId = new Map<string, typeof existingBalances[number]>();
        for (const b of existingBalances) {
          balanceByEmployeeId.set(b.employeeId, b);
        }

        for (const employee of employees) {
          // Check if employee has served the accrual start waiting period
          const hireDate = new Date(employee.hireDate);
          const eligibleDate = new Date(hireDate);
          eligibleDate.setMonth(eligibleDate.getMonth() + waitMonths);

          if (now < eligibleDate) {
            continue;
          }

          let balance = balanceByEmployeeId.get(employee.id);

          if (!balance) {
            balance = manager.create(LeaveBalance, {
              tenantId: employee.tenantId,
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
              continue;
            }
          }

          // Apply accrual with cap
          const currentAccrued = Number(balance.accrued) || 0;
          let cappedAccrued = currentAccrued + rate;
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
        `Schema ${schemaName}: accrued ${accrued} balance(s), created ${created} new balance record(s).`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Schema ${schemaName} accrual failed, rolled back: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
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

      const tenantSchemas = await listTenantSchemas(this.dataSource);
      if (tenantSchemas.length === 0) {
        this.logger.debug('No tenant schemas found, skipping year-end rollover');
        return;
      }

      this.logger.log(
        `Year-end rollover: processing ${tenantSchemas.length} tenant schema(s) for year ${previousYear}.`,
      );

      let totalRolled = 0;

      for (const schema of tenantSchemas) {
        const rolled = await this.processTenantRollover(schema, previousYear, newYear);
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
   * Process year-end rollover for a single tenant schema inside a transaction.
   */
  private async processTenantRollover(
    schemaName: string,
    previousYear: number,
    newYear: number,
  ): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    let outcome: CarryOverOutcome = { processed: 0, successful: 0, failed: 0, errors: [] };

    try {
      // Set search_path BEFORE starting the transaction
      await queryRunner.query(`SET search_path TO "${schemaName}", hr, public`);
      await queryRunner.startTransaction();

      // Single source of truth for the carry-over math — shared with the
      // on-demand carryOverLeaveBalances mutation so the cron and the
      // operator-triggered path can never diverge.
      outcome = await this.carryOverWithinSchema(
        queryRunner.manager,
        previousYear,
        newYear,
      );

      await queryRunner.commitTransaction();
      this.logger.log(
        `Schema ${schemaName}: rolled over ${outcome.successful} balance(s) from ${previousYear} to ${newYear}.`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Schema ${schemaName} rollover failed, rolled back: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }

    return outcome.successful;
  }

  /**
   * Carry remaining balances from `previousYear` into `newYear` for the schema
   * the supplied EntityManager is currently routed to (search_path =
   * tenant_<uuid>). Pure balance math — no schema switching, no transaction
   * management; the caller owns the transaction boundary.
   *
   * Idempotent: a target-year balance whose carriedOver is already non-zero is
   * left untouched, so re-running the carry-over cannot double-credit.
   *
   * @param manager     transactional EntityManager already scoped to the tenant
   * @param previousYear source year to drain remaining balance from
   * @param newYear      target year to credit carriedOver into
   * @param actorUserId  optional auditing user recorded on touched rows
   */
  async carryOverWithinSchema(
    manager: EntityManager,
    previousYear: number,
    newYear: number,
    actorUserId?: string,
  ): Promise<CarryOverOutcome> {
    const outcome: CarryOverOutcome = {
      processed: 0,
      successful: 0,
      failed: 0,
      errors: [],
    };

    // Fetch all previous year balances (with leave type info for maxCarryOverDays)
    const previousBalances = await manager.find(LeaveBalance, {
      where: {
        year: previousYear,
        isDeleted: false,
      },
      relations: ['leaveType'],
    });

    for (const prevBalance of previousBalances) {
      outcome.processed++;
      try {
        // Check if the employee is still active
        const employee = await manager.findOne(Employee, {
          where: {
            id: prevBalance.employeeId,
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
            if (actorUserId) {
              newBalance.updatedBy = actorUserId;
            }
            await manager.save(LeaveBalance, newBalance);
            outcome.successful++;
          }
          // If carriedOver is already > 0, skip (idempotent)
        } else {
          // Create new year balance with carry-over
          newBalance = manager.create(LeaveBalance, {
            tenantId: prevBalance.tenantId,
            employeeId: prevBalance.employeeId,
            leaveTypeId: prevBalance.leaveTypeId,
            year: newYear,
            openingBalance: 0,
            accrued: 0,
            used: 0,
            pending: 0,
            adjustment: 0,
            carriedOver: carryOverAmount,
            createdBy: actorUserId,
            updatedBy: actorUserId,
          });
          await manager.save(LeaveBalance, newBalance);
          outcome.successful++;
        }
      } catch (error) {
        outcome.failed++;
        const message = error instanceof Error ? error.message : String(error);
        outcome.errors.push(
          `employee ${prevBalance.employeeId} / leaveType ${prevBalance.leaveTypeId}: ${message}`,
        );
      }
    }

    return outcome;
  }
}
