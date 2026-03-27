/**
 * CreateParameterConfigCommand
 *
 * Yeni su kalitesi parametre konfigurasyonu olusturmak icin command.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

/**
 * Parametre konfigurasyonu olusturma payload
 */
export interface CreateParameterConfigPayload {
  code: string;
  name: string;
  unit: string;
  dataType: string;
  precision?: number;
  group: string;
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

export class CreateParameterConfigCommand implements ITenantCommand {
  readonly commandName = 'CreateParameterConfigCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateParameterConfigPayload,
    public readonly userId: string,
  ) {}
}
