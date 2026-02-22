import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import { co2Level, alkMgToMeq } from '@platform/aquaculture-engines';

interface CO2LevelInput {
  alkalinity: number; // mg/L as CaCO3
  pH: number;
  temperature: number; // °C
  salinity: number; // ppt
}

interface CO2LevelOutput {
  co2_mgL: number;
  status: 'safe' | 'warning' | 'danger';
  statusMessage: string;
}

@Injectable()
@Tool({
  name: 'calculate_co2_level',
  description:
    'Calculate dissolved CO2 concentration from alkalinity, pH, temperature and salinity. Returns CO2 in mg/L and safety status. Use this when operators ask about CO2 levels or want to check if CO2 is safe for fish.',
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
    },
    required: ['alkalinity', 'pH', 'temperature', 'salinity'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateCO2LevelTool extends BaseTool<CO2LevelInput, CO2LevelOutput> {
  protected async run(
    input: CO2LevelInput,
    _ctx: ToolExecutionContext,
  ): Promise<CO2LevelOutput> {
    const { alkalinity, pH, temperature: T, salinity: S } = input;

    const alkMeq = alkMgToMeq(alkalinity);
    const co2 = co2Level(alkMeq, pH, T, S);
    const co2Rounded = Math.round(co2 * 100) / 100;

    let status: 'safe' | 'warning' | 'danger';
    let statusMessage: string;
    if (co2Rounded < 20) {
      status = 'safe';
      statusMessage = `CO2 at ${co2Rounded} mg/L is within safe limits (<20 mg/L)`;
    } else if (co2Rounded <= 40) {
      status = 'warning';
      statusMessage = `CO2 at ${co2Rounded} mg/L is elevated (20-40 mg/L). Monitor closely.`;
    } else {
      status = 'danger';
      statusMessage = `CO2 at ${co2Rounded} mg/L exceeds safe limits (>40 mg/L). Immediate action needed.`;
    }

    return { co2_mgL: co2Rounded, status, statusMessage };
  }

  async validate(
    input: CO2LevelInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (input.alkalinity < 0) errors.push('Alkalinity must be non-negative');
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
