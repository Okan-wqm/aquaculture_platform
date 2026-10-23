import { EmployeeStatus } from '../hr/entities/employee.entity';

/**
 * Head count: the live (not soft-deleted) employees who have not left. People
 * on leave or suspended still belong to the team, so only TERMINATED is left
 * out. This is the status half of the definition, shared by a department's team
 * size (hr/dataloaders/department-head-count.dataloader.ts) and the employees
 * placed in no department (get-hr-dashboard-stats.handler.ts); both also require
 * `isDeleted = false`, so the two always partition the same people.
 */
export const HEAD_COUNT_EXCLUDED_STATUS: EmployeeStatus = EmployeeStatus.TERMINATED;
