/**
 * Soft-delete a temperature scenario (points cascade logically with the
 * scenario's isDeleted flag; rows stay for audit).
 */
import { IQuery } from '@platform/cqrs';

export class DeleteTemperatureScenarioQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly scenarioId: string,
  ) {}
}
