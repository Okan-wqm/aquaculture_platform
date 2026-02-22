import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  fractionNH3,
  calcNH3,
  calcNH4,
  calcSafeTAN,
  uiaStatus,
  criticalPHforNH3,
} from '@platform/aquaculture-engines';

interface AmmoniaToxicityInput {
  totalAmmoniacalNitrogen: number; // TAN in mg/L
  pH: number;
  temperature: number; // °C
  salinity: number; // ppt
}

interface AmmoniaToxicityOutput {
  nh3_mgL: number;
  nh4_mgL: number;
  fractionNH3: number;
  safeTAN: number;
  status: 'safe' | 'alert' | 'danger';
  criticalPH: number;
}

const NH3_LIMIT = 0.02; // mg/L NH3 limit (common aquaculture threshold)

@Injectable()
@Tool({
  name: 'calculate_ammonia_toxicity',
  description:
    'Calculate un-ionized ammonia (NH3) toxicity from Total Ammoniacal Nitrogen (TAN), pH, temperature and salinity. Returns NH3 concentration, safe TAN limit, and toxicity status. Use this when operators ask about ammonia levels or fish safety.',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      totalAmmoniacalNitrogen: {
        type: 'number',
        description: 'Total Ammoniacal Nitrogen (TAN) in mg/L',
      },
      pH: {
        type: 'number',
        description: 'pH value (NBS scale)',
        minimum: 0,
        maximum: 14,
      },
      temperature: {
        type: 'number',
        description: 'Water temperature in °C',
        minimum: 0,
        maximum: 45,
      },
      salinity: {
        type: 'number',
        description: 'Salinity in ppt (parts per thousand)',
        minimum: 0,
        maximum: 45,
      },
    },
    required: ['totalAmmoniacalNitrogen', 'pH', 'temperature', 'salinity'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateAmmoniaToxicityTool extends BaseTool<
  AmmoniaToxicityInput,
  AmmoniaToxicityOutput
> {
  protected async run(
    input: AmmoniaToxicityInput,
    _ctx: ToolExecutionContext,
  ): Promise<AmmoniaToxicityOutput> {
    const { totalAmmoniacalNitrogen: TAN, pH, temperature: T, salinity: S } = input;

    const fNH3 = fractionNH3(pH, T, S);
    const nh3 = calcNH3(TAN, pH, T, S);
    const nh4 = calcNH4(TAN, pH, T, S);
    const safeTAN = calcSafeTAN(pH, NH3_LIMIT, T, S);
    const criticalPH = criticalPHforNH3(TAN, NH3_LIMIT, T, S);
    const status = uiaStatus(pH, criticalPH);

    return {
      nh3_mgL: Math.round(nh3 * 10000) / 10000,
      nh4_mgL: Math.round(nh4 * 10000) / 10000,
      fractionNH3: Math.round(fNH3 * 10000) / 10000,
      safeTAN: Math.round(safeTAN * 100) / 100,
      status,
      criticalPH: Math.round(criticalPH * 100) / 100,
    };
  }

  async validate(
    input: AmmoniaToxicityInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (input.totalAmmoniacalNitrogen < 0) errors.push('TAN must be non-negative');
    if (input.pH < 0 || input.pH > 14) errors.push('pH must be between 0 and 14');
    if (input.temperature < 0 || input.temperature > 45)
      errors.push('Temperature must be between 0 and 45°C');
    if (input.salinity < 0 || input.salinity > 45)
      errors.push('Salinity must be between 0 and 45 ppt');
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
