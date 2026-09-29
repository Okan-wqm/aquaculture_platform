/**
 * ListParameterConfigsQuery
 *
 * Parametre konfigurasyonlarini filtrelenmiş olarak getirir.
 *
 * @module WaterQuality/Queries
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

/**
 * Parametre konfigurasyonu filtresi
 */
export interface ParameterConfigFilter {
  group?: string;
  isActive?: boolean;
  isVisible?: boolean;
}

export class ListParameterConfigsQuery {
  readonly queryName = 'ListParameterConfigsQuery';

  constructor(
    public readonly scope: TenantScope,
    public readonly filters?: ParameterConfigFilter,
  ) {}
}
