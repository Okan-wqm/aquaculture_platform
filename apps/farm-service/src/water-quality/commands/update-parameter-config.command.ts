/**
 * UpdateParameterConfigCommand
 *
 * Mevcut su kalitesi parametre konfigurasyonunu guncellemek icin command.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Parametre konfigurasyonu guncelleme payload
 */
export interface UpdateParameterConfigPayload {
  code?: string;
  name?: string;
  unit?: string;
  dataType?: string;
  precision?: number;
  group?: string;
  optimalMin?: number;
  optimalMax?: number;
  warningMin?: number;
  warningMax?: number;
  criticalMin?: number;
  criticalMax?: number;
  speciesLimits?: Record<string, unknown>;
  enumValues?: string[];
  chartColor?: string;
  icon?: string;
  displayOrder?: number;
  isVisible?: boolean;
  isRequired?: boolean;
  isActive?: boolean;
  chartAxisGroup?: string;
  templateSource?: string;
}

export class UpdateParameterConfigCommand implements ITenantCommand {
  readonly commandName = 'UpdateParameterConfigCommand';

  constructor(
    public readonly tenantId: string,
    public readonly configId: string,
    public readonly payload: UpdateParameterConfigPayload,
    public readonly userId: string,
  ) {}
}
