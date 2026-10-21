/**
 * Create a temperature scenario with its dated points (idempotent by
 * caller-supplied envelope — see the command layer).
 */
import { IQuery } from '@platform/cqrs';

export interface TemperatureScenarioPointInputShape {
  date: string;
  celsius: number;
}

export class CreateTemperatureScenarioQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
    public readonly name: string,
    public readonly points: TemperatureScenarioPointInputShape[],
    public readonly userId: string,
  ) {}
}
