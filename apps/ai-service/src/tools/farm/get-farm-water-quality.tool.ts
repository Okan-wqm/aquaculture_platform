import { Injectable } from '@nestjs/common';
import { TenantBoundNatsClient } from '../../tenant-boundary/tenant-bound-nats.client';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { TenantBoundToolContext } from '../core/tool.interface';
import { isWaterQualityOverview, type WaterQualityReading } from './farm-overview.guards';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_WQ_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetWaterQualityInput = Record<string, never>;

interface GetWaterQualityOutput {
  readings: WaterQualityReading[];
  count: number;
}

/**
 * Read the tenant's recent water-quality measurements (Faz 3a). A plain read
 * tool (no confirmation) so the assistant can ground water-quality questions
 * ("what is tank X's dissolved oxygen?") in real data. Crosses to farm-service
 * via request.farm.getWaterQualityOverview — the same NATS request-reply
 * transport the other farm tools use; the tenant comes from ctx, never the model.
 */
@Injectable()
@Tool({
  name: 'get_farm_water_quality',
  description:
    "The tenant's most recent water-quality readings (temperature, dissolved " +
    'oxygen, pH, ammonia, nitrite, per tank/pond, newest first). Use before ' +
    'answering water-quality questions; filter by tankId for a specific tank.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmWaterQualityTool extends BaseTool<GetWaterQualityInput, GetWaterQualityOutput> {
  constructor(private readonly farm: TenantBoundNatsClient) {
    super();
  }

  protected async run(
    _input: GetWaterQualityInput,
    ctx: TenantBoundToolContext,
  ): Promise<GetWaterQualityOutput> {
    // K10 (MT-HIGH-062): the client injects ctx's bound tenant and refuses a
    // reply served for any other tenant before this code sees the rows.
    const readings = await this.farm.request(ctx, {
      subject: 'request.farm.getWaterQualityOverview',
      fields: {},
      isData: isWaterQualityOverview,
      timeoutMs: GET_WQ_TIMEOUT_MS,
    });
    return { readings, count: readings.length };
  }
}
