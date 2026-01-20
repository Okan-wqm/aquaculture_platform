/**
 * RecordGrowthSampleCommand
 *
 * Yeni büyüme ölçümü kaydetmek için command.
 *
 * @module Growth/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import {
  MeasurementType,
  MeasurementMethod,
  IndividualMeasurement,
  MeasurementConditions,
} from '../entities/growth-measurement.entity';

/**
 * Büyüme ölçümü payload
 */
export interface RecordGrowthSamplePayload {
  batchId: string;
  tankId?: string;
  pondId?: string;

  measurementDate: Date;
  measurementType?: MeasurementType;
  measurementMethod?: MeasurementMethod;

  populationSize: number;
  individualMeasurements: IndividualMeasurement[];

  conditions?: MeasurementConditions;

  measuredBy: string;
  notes?: string;

  updateBatchWeight?: boolean;
}

export class RecordGrowthSampleCommand implements ITenantCommand {
  readonly commandName = 'RecordGrowthSampleCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: RecordGrowthSamplePayload,
    public readonly userId: string,
  ) {}
}
