import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import {
  fractionH2S,
  calcH2S,
  calcSafeTotalSulfide,
  h2sStatus,
  criticalPHforH2S,
} from '@platform/aquaculture-engines';

interface H2SToxicityInput {
  totalSulfide: number; // µg/L
  pH: number;
  temperature: number; // °C
  salinity: number; // ppt
}

interface H2SToxicityOutput {
  h2s_ugL: number;
  fractionH2S: number;
  safeTotalSulfide: number;
  status: 'safe' | 'alert' | 'danger';
  criticalPH: number;
}

const H2S_LIMIT = 2; // µg/L H2S limit (common aquaculture threshold)

@Injectable()
@Tool({
  name: 'calculate_h2s_toxicity',
  description:
    'Calculate hydrogen sulfide (H2S) toxicity from total sulfide concentration, pH, temperature and salinity. Returns H2S concentration, safe total sulfide limit, and toxicity status. Use this when operators ask about sulfide levels or H2S safety.',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      totalSulfide: {
        type: 'number',
        description: 'Total sulfide concentration in µg/L',
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
    required: ['totalSulfide', 'pH', 'temperature', 'salinity'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class CalculateH2SToxicityTool extends BaseTool<
  H2SToxicityInput,
  H2SToxicityOutput
> {
  protected async run(
    input: H2SToxicityInput,
    _ctx: ToolExecutionContext,
  ): Promise<H2SToxicityOutput> {
    const { totalSulfide, pH, temperature: T, salinity: S } = input;

    const fH2S = fractionH2S(pH, T, S);
    const h2s = calcH2S(totalSulfide, pH, T, S);
    const safeTotalSulfide = calcSafeTotalSulfide(pH, H2S_LIMIT, T, S);
    // criticalPHforH2S expects measured H2S at current pH
    const criticalPH = criticalPHforH2S(h2s, pH, H2S_LIMIT, T, S);
    const status = h2sStatus(pH, criticalPH);

    return {
      h2s_ugL: Math.round(h2s * 10000) / 10000,
      fractionH2S: Math.round(fH2S * 10000) / 10000,
      safeTotalSulfide: Math.round(safeTotalSulfide * 100) / 100,
      status,
      criticalPH: Math.round(criticalPH * 100) / 100,
    };
  }

  async validate(
    input: H2SToxicityInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (input.totalSulfide < 0) errors.push('Total sulfide must be non-negative');
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
