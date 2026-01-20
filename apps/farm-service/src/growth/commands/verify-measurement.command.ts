/**
 * VerifyMeasurementCommand
 *
 * Büyüme ölçümünü doğrulamak için command.
 *
 * @module Growth/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class VerifyMeasurementCommand implements ITenantCommand {
  readonly commandName = 'VerifyMeasurementCommand';

  constructor(
    public readonly tenantId: string,
    public readonly measurementId: string,
    public readonly userId: string,
    public readonly notes?: string,
  ) {}
}
