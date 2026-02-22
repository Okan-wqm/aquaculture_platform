import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  calculateDosingRecipes,
  calcDicOfAlk,
  alkMgToMeq,
  REAGENTS,
  DosingRecipe,
} from '@platform/aquaculture-engines';

interface ReagentDosingInput {
  currentAlkalinity: number; // mg/L as CaCO3
  currentPH: number;
  targetAlkalinity: number; // mg/L as CaCO3
  targetPH: number;
  temperature: number; // °C
  salinity: number; // ppt
  volumeLiters: number;
  selectedReagents?: string[]; // reagent names to consider (default: all)
}

interface ReagentDosingOutput {
  recipes: DosingRecipe[];
  currentDIC: number;
  targetDIC: number;
}

@Injectable()
@Tool({
  name: 'calculate_reagent_dosing',
  description:
    'Calculate dosing recipes to move from current to target water chemistry (alkalinity and pH). Returns multiple reagent combination options with amounts in grams and kg. Use this when operators need to adjust water chemistry.',
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
      targetAlkalinity: {
        type: 'number',
        description: 'Target alkalinity in mg/L as CaCO3',
        minimum: 0,
      },
      targetPH: {
        type: 'number',
        description: 'Target pH (NBS scale)',
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
      volumeLiters: {
        type: 'number',
        description: 'System volume in liters',
        minimum: 0,
      },
      selectedReagents: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of reagent names to consider (optional, defaults to all available reagents)',
      },
    },
    required: [
      'currentAlkalinity',
      'currentPH',
      'targetAlkalinity',
      'targetPH',
      'temperature',
      'salinity',
      'volumeLiters',
    ],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateReagentDosingTool extends BaseTool<
  ReagentDosingInput,
  ReagentDosingOutput
> {
  protected async run(
    input: ReagentDosingInput,
    _ctx: ToolExecutionContext,
  ): Promise<ReagentDosingOutput> {
    const {
      currentAlkalinity,
      currentPH,
      targetAlkalinity,
      targetPH,
      temperature: T,
      salinity: S,
      volumeLiters,
    } = input;

    const currentAlkMeq = alkMgToMeq(currentAlkalinity);
    const targetAlkMeq = alkMgToMeq(targetAlkalinity);

    const currentDIC = calcDicOfAlk(currentAlkMeq, currentPH, T, S);
    const targetDIC = calcDicOfAlk(targetAlkMeq, targetPH, T, S);

    const volumeM3 = volumeLiters / 1000;
    const selectedReagents =
      input.selectedReagents ?? REAGENTS.map((r) => r.name);

    const recipes = calculateDosingRecipes(
      currentDIC,
      currentAlkMeq,
      targetDIC,
      targetAlkMeq,
      volumeM3,
      selectedReagents,
    );

    return {
      recipes,
      currentDIC: Math.round(currentDIC * 1000) / 1000,
      targetDIC: Math.round(targetDIC * 1000) / 1000,
    };
  }

  async validate(
    input: ReagentDosingInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (input.currentAlkalinity < 0)
      errors.push('Current alkalinity must be non-negative');
    if (input.targetAlkalinity < 0)
      errors.push('Target alkalinity must be non-negative');
    if (input.currentPH < 0 || input.currentPH > 14)
      errors.push('Current pH must be between 0 and 14');
    if (input.targetPH < 0 || input.targetPH > 14)
      errors.push('Target pH must be between 0 and 14');
    if (input.temperature < 0 || input.temperature > 45)
      errors.push('Temperature must be between 0 and 45°C');
    if (input.salinity < 0 || input.salinity > 45)
      errors.push('Salinity must be between 0 and 45 ppt');
    if (input.volumeLiters <= 0) errors.push('Volume must be positive');
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 60;
  }
}
