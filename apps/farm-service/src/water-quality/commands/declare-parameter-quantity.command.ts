/**
 * DeclareParameterQuantityCommand / ClearParameterQuantityCommand
 *
 * Say which measured quantity a parameter records (FARM-MEDIUM-374), or clear
 * the declaration so the code's own meaning stands.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class DeclareParameterQuantityCommand implements ITenantCommand {
  readonly commandName = 'DeclareParameterQuantityCommand';

  constructor(
    public readonly tenantId: string,
    public readonly parameterConfigId: string,
    /** A measured-quantity id as the client sent it; parsed by the handler. */
    public readonly quantity: string,
    public readonly userId: string,
  ) {}
}

export class ClearParameterQuantityCommand implements ITenantCommand {
  readonly commandName = 'ClearParameterQuantityCommand';

  constructor(
    public readonly tenantId: string,
    public readonly parameterConfigId: string,
    public readonly userId: string,
  ) {}
}
