import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  calcDicOfAlk,
  alphaZero,
  alphaOne,
  alphaTwo,
  calcOmegaCalcite,
  calcOmegaAragonite,
  calcCO3,
  co2Level,
  phNbsToFree,
  alkMgToMeq,
} from '@platform/aquaculture-engines';

interface CarbonateChemistryInput {
  alkalinity: number; // mg/L as CaCO3
  pH: number;
  temperature: number; // °C
  salinity: number; // ppt
  calciumMgL?: number; // Ca2+ in mg/L (default: estimated from salinity)
}

interface CarbonateChemistryOutput {
  dic_mmolL: number;
  co2_mgL: number;
  co3_mmolL: number;
  fractionCO2: number;
  fractionHCO3: number;
  fractionCO3: number;
  omegaCalcite: number;
  omegaAragonite: number;
}

@Injectable()
@Tool({
  name: 'calculate_carbonate_chemistry',
  description:
    'Calculate full carbonate system: DIC, CO2/HCO3/CO3 fractions, and calcite/aragonite saturation indices. Use this for detailed water chemistry analysis or when operators need to understand carbonate equilibrium.',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      alkalinity: {
        type: 'number',
        description: 'Alkalinity in mg/L as CaCO3',
        minimum: 0,
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
      calciumMgL: {
        type: 'number',
        description:
          'Calcium concentration in mg/L (optional, estimated from salinity if omitted)',
        minimum: 0,
      },
    },
    required: ['alkalinity', 'pH', 'temperature', 'salinity'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateCarbonateTool extends BaseTool<
  CarbonateChemistryInput,
  CarbonateChemistryOutput
> {
  protected async run(
    input: CarbonateChemistryInput,
    _ctx: ToolExecutionContext,
  ): Promise<CarbonateChemistryOutput> {
    const { alkalinity, pH, temperature: T, salinity: S } = input;

    const alkMeq = alkMgToMeq(alkalinity);
    const dic = calcDicOfAlk(alkMeq, pH, T, S);
    const pHfree = phNbsToFree(pH, T, S);
    const a0 = alphaZero(pHfree, T, S);
    const a1 = alphaOne(pHfree, T, S);
    const a2 = alphaTwo(pHfree, T, S);
    const co2 = co2Level(alkMeq, pH, T, S);
    const co3 = calcCO3(dic, pH, T, S);

    // Calcium: use provided value or estimate from salinity
    // Seawater ~400 mg/L Ca at 35 ppt; freshwater ~40 mg/L
    const caMgL = input.calciumMgL ?? (S > 0 ? 400 * (S / 35) : 40);
    const caMolKg = caMgL / 40078; // mg/L to mol/kg (approx)

    const omegaCa = calcOmegaCalcite(dic, caMolKg, pH, T, S);
    const omegaAr = calcOmegaAragonite(dic, caMolKg, pH, T, S);

    return {
      dic_mmolL: Math.round(dic * 1000) / 1000,
      co2_mgL: Math.round(co2 * 100) / 100,
      co3_mmolL: Math.round(co3 * 10000) / 10000,
      fractionCO2: Math.round(a0 * 10000) / 10000,
      fractionHCO3: Math.round(a1 * 10000) / 10000,
      fractionCO3: Math.round(a2 * 10000) / 10000,
      omegaCalcite: Math.round(omegaCa * 100) / 100,
      omegaAragonite: Math.round(omegaAr * 100) / 100,
    };
  }

  async validate(
    input: CarbonateChemistryInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (input.alkalinity < 0) errors.push('Alkalinity must be non-negative');
    if (input.pH < 0 || input.pH > 14) errors.push('pH must be between 0 and 14');
    if (input.temperature < 0 || input.temperature > 45)
      errors.push('Temperature must be between 0 and 45°C');
    if (input.salinity < 0 || input.salinity > 45)
      errors.push('Salinity must be between 0 and 45 ppt');
    if (input.calciumMgL !== undefined && input.calciumMgL < 0)
      errors.push('Calcium must be non-negative');
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
