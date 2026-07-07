import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { BaseTool } from '../core/base-tool';
import { Tool } from '../core/tool.decorator';
import { ToolExecutionContext } from '../core/tool.interface';

/** Bound so a hung farm-service cannot stall the agent turn. */
const GET_WQ_TIMEOUT_MS = 5000;

/** No input — the tenant is taken from the (server-populated) execution context. */
type GetWaterQualityInput = Record<string, never>;

interface WaterQualityReading {
  id: string;
  tankId: string | null;
  pondId: string | null;
  measuredAt: string;
  temperature: number | null;
  dissolvedOxygen: number | null;
  pH: number | null;
  ammonia: number | null;
  nitrite: number | null;
}

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
  requiresModule: null,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFarmWaterQualityTool extends BaseTool<GetWaterQualityInput, GetWaterQualityOutput> {
  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {
    super();
  }

  protected async run(
    _input: GetWaterQualityInput,
    ctx: ToolExecutionContext,
  ): Promise<GetWaterQualityOutput> {
    const readings = await firstValueFrom(
      this.natsClient
        .send<WaterQualityReading[]>('request.farm.getWaterQualityOverview', {
          tenantId: ctx.tenantId,
        })
        .pipe(timeout(GET_WQ_TIMEOUT_MS)),
    );
    const list = Array.isArray(readings) ? readings : [];
    return { readings: list, count: list.length };
  }
}
