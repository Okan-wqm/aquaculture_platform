import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import { REAGENTS, ReagentInfo } from '@platform/aquaculture-engines';

/** This tool takes no input — it returns the static reagent catalogue. */
type ReagentListInput = Record<string, never>;

interface ReagentListOutput {
  reagents: Array<{
    name: string;
    formula: string;
    molecularWeight: number;
    meqPerMol: number;
  }>;
}

@Injectable()
@Tool({
  name: 'get_reagent_list',
  description:
    'Get the list of available chemical reagents for water chemistry dosing. Returns reagent names, formulas, and properties. Use this when operators ask what chemicals are available or need reagent information.',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class GetReagentListTool extends BaseTool<ReagentListInput, ReagentListOutput> {
  protected async run(
    _input: ReagentListInput,
    _ctx: ToolExecutionContext,
  ): Promise<ReagentListOutput> {
    return {
      reagents: REAGENTS.map((r: ReagentInfo) => ({
        name: r.name,
        formula: r.formula,
        molecularWeight: r.mw,
        meqPerMol: r.meqPerMol,
      })),
    };
  }

  protected isCacheable(): boolean {
    return true;
  }
  protected getCacheTtl(): number {
    return 3600; // reagent list is static, cache for 1 hour
  }
}
