/**
 * GetParameterConfigByCodeQuery
 *
 * Tek bir parametre konfigurasyonunu code ile getirir.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GetParameterConfigByCodeQuery implements ITenantQuery {
  readonly queryName = 'GetParameterConfigByCodeQuery';

  constructor(
    public readonly tenantId: string,
    public readonly code: string,
  ) {}
}
