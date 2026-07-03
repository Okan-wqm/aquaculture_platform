import { WorkArea } from '../entities/work-area.entity';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import {
  WorkAreaOccupancyReport,
  OccupancyEmployee,
} from '../dto/work-area-occupancy.dto';

/**
 * Pure occupancy computation shared by GetWorkAreaOccupancy (single area) and
 * GetAllWorkAreaOccupancies (every area). Kept side-effect-free so both handlers
 * compute occupancy identically — no duplicated counting logic.
 *
 * @param workArea - the area being reported on
 * @param rotations - rotations for THIS area that cover the report date
 *                    (already tenant- and date-filtered by the caller)
 * @param date - the report date, echoed back into the report
 * @param includeEmployees - when false, the employees list is omitted (the
 *   all-areas query does not select per-employee detail, so we skip building it)
 */
export function buildOccupancyReport(
  workArea: WorkArea,
  rotations: WorkRotation[],
  date: string,
  includeEmployees: boolean,
): WorkAreaOccupancyReport {
  let scheduledCount = 0;
  let actualCount = 0;
  const employees: OccupancyEmployee[] = [];
  const seen = new Set<string>();

  for (const rotation of rotations) {
    if (seen.has(rotation.employeeId)) {
      continue;
    }
    seen.add(rotation.employeeId);

    // Every non-cancelled rotation covering the date is "scheduled" occupancy.
    scheduledCount += 1;
    // Only IN_PROGRESS rotations represent crew actually on station.
    if (rotation.status === RotationStatus.IN_PROGRESS) {
      actualCount += 1;
    }

    if (includeEmployees) {
      const employee = rotation.employee;
      const name = employee
        ? `${employee.firstName} ${employee.lastName}`.trim()
        : rotation.employeeId;
      employees.push({
        id: rotation.employeeId,
        name,
        rotationStatus: rotation.status,
      });
    }
  }

  const maxCapacity = workArea.maxCapacity ?? 0;
  const occupancyRate =
    maxCapacity > 0 ? Math.round((actualCount / maxCapacity) * 100 * 100) / 100 : 0;

  const report = new WorkAreaOccupancyReport();
  report.workArea = workArea;
  report.date = date;
  report.scheduledCount = scheduledCount;
  report.actualCount = actualCount;
  report.occupancyRate = occupancyRate;
  report.employees = employees;
  return report;
}
