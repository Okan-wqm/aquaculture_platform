import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  calcForwardDosing,
  calcDicOfAlk,
  alkMgToMeq,
  OnDemandStep,
} from '@platform/aquaculture-engines';

interface SimulateDosingInput {
  currentAlkalinity: number; // mg/L as CaCO3
  currentPH: number;
  temperature: number; // °C
  salinity: number; // ppt
  reagentName: string;
  doseGrams: number;
  volumeLiters: number;
}

interface SimulateDosingOutput {
  steps: OnDemandStep[];
  predictedPH: number;
  predictedAlkalinity_meqL: number;
  predictedCO2_mgL: number;
}

@Injectable()
@Tool({
  name: 'simulate_dosing_effect',
  description:
    'Simulate the effect of adding a specific chemical reagent to the water system. Predicts the resulting pH, alkalinity, and CO2 after dosing. Use this when operators want to preview what will happen if they add a certain amount of a chemical.',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      currentAlkalinity: {
        type: 'number',
        description: 'Current alkalinity in mg/L as CaCO3',
        minimum: 0,
      },
      currentPH: {
        type: 'number',
        description: 'Current pH (NBS scale)',
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
      reagentName: {
        type: 'string',
        description:
          'Name of the reagent to simulate (e.g., "Sodium Bicarbonate", "Sodium Hydroxide")',
      },
      doseGrams: {
        type: 'number',
        description: 'Amount of reagent to add in grams',
        minimum: 0,
      },
      volumeLiters: {
        type: 'number',
        description: 'System volume in liters',
        minimum: 0,
      },
    },
    required: [
      'currentAlkalinity',
      'currentPH',
      'temperature',
      'salinity',
      'reagentName',
      'doseGrams',
      'volumeLiters',
    ],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class SimulateDosingEffectTool extends BaseTool<
  SimulateDosingInput,
  SimulateDosingOutput
> {
  protected async run(
    input: SimulateDosingInput,
    _ctx: ToolExecutionContext,
  ): Promise<SimulateDosingOutput> {
    const {
      currentAlkalinity,
      currentPH,
      temperature: T,
      salinity: S,
      reagentName,
      doseGrams,
      volumeLiters,
    } = input;

    const alkMeq = alkMgToMeq(currentAlkalinity);
    const dic = calcDicOfAlk(alkMeq, currentPH, T, S);
    const volumeM3 = volumeLiters / 1000;

    const steps = calcForwardDosing(
      { dic, alk: alkMeq, tempC: T, salinity: S },
      volumeM3,
      [{ reagentKey: reagentName, amountGrams: doseGrams }],
    );

    const finalStep = steps[steps.length - 1];
    if (!finalStep) {
      throw new Error(
        'Dosing simulation produced no steps; check reagent and dose inputs',
      );
    }

    return {
      steps,
      predictedPH: Math.round(finalStep.ph * 1000) / 1000,
      predictedAlkalinity_meqL: Math.round(finalStep.alk * 1000) / 1000,
      predictedCO2_mgL: Math.round(finalStep.co2 * 100) / 100,
    };
  }

  async validate(
    input: SimulateDosingInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (input.currentAlkalinity < 0)
      errors.push('Alkalinity must be non-negative');
    if (input.currentPH < 0 || input.currentPH > 14)
      errors.push('pH must be between 0 and 14');
    if (input.temperature < 0 || input.temperature > 45)
      errors.push('Temperature must be between 0 and 45°C');
    if (input.salinity < 0 || input.salinity > 45)
      errors.push('Salinity must be between 0 and 45 ppt');
    if (input.doseGrams <= 0) errors.push('Dose must be positive');
    if (input.volumeLiters <= 0) errors.push('Volume must be positive');
    if (!input.reagentName || input.reagentName.trim() === '')
      errors.push('Reagent name is required');
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
