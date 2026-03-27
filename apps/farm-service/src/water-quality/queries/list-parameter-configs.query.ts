/**
 * ListParameterConfigsQuery
 *
 * Parametre konfigurasyonlarini filtrelenmiş olarak getirir.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Parametre konfigurasyonu filtresi
 */
export interface ParameterConfigFilter {
  group?: string;
  isActive?: boolean;
  isVisible?: boolean;
}

export class ListParameterConfigsQuery implements ITenantQuery {
  readonly queryName = 'ListParameterConfigsQuery';

  constructor(
    public readonly tenantId: string,
    public readonly filters?: ParameterConfigFilter,
  ) {}
}
