/**
 * GetParameterConfigQuery
 *
 * Tek bir parametre konfigurasyonunu ID ile getirir.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GetParameterConfigQuery implements ITenantQuery {
  readonly queryName = 'GetParameterConfigQuery';

  constructor(
    public readonly tenantId: string,
    public readonly configId: string,
  ) {}
}
