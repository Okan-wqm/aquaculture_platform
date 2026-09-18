/**
 * Equipment farm-AI read-only NATS responder (PR-5, Operations specialist).
 * Two `request.farm.ai.*` subjects backed EXCLUSIVELY by the equipment
 * module's existing tenant-scoped CQRS query handlers via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isEquipmentListRequest,
  isFeederCalibrationsRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { ListEquipmentQuery, EquipmentFilter } from '../queries/list-equipment.query';
import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { Equipment, EquipmentStatus } from '../entities/equipment.entity';
import { FeederCalibration } from '../entities/feeder-calibration.entity';
import { PaginatedQueryResult } from '@platform/cqrs';
import {
  EquipmentDto,
  FeederCalibrationDto,
  projectEquipment,
  projectFeederCalibration,
} from './projections';

@Controller()
export class EquipmentAiQueryResponder {
  private readonly logger = new Logger(EquipmentAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.EQUIPMENT_LIST)
  async list(@Payload() payload: unknown): Promise<AiQueryReply<AiQueryList<EquipmentDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isEquipmentListRequest,
      async (req) => {
        const limit = clampListLimit(
          req.limit,
          FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT,
        );
        // ONLY filter fields the AI contract exposes are passed through —
        // the EquipmentFilter is far wider (search, siteId, categories …)
        // and must stay unreachable from the model surface.
        const filter: EquipmentFilter = {};
        if (req.equipmentTypeId !== undefined) {
          filter.equipmentTypeId = req.equipmentTypeId;
        }
        if (req.status !== undefined) {
          filter.status = req.status as EquipmentStatus;
        }
        if (req.isTank !== undefined) {
          filter.isTank = req.isTank;
        }
        const result = await this.queryBus.execute<
          ListEquipmentQuery,
          PaginatedQueryResult<Equipment>
        >(new ListEquipmentQuery(req.tenantId, filter, { page: 1, limit }));
        return toBoundedList(result.data, limit, projectEquipment, result.pagination.total);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS)
  async feederCalibrations(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<FeederCalibrationDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isFeederCalibrationsRequest,
      async (req) =>
        toBoundedList(
          // NOTE: the real constructor takes (equipmentId, tenantId) —
          // equipmentId FIRST, tenantId second.
          await this.queryBus.execute<ListFeederCalibrationsQuery, FeederCalibration[]>(
            new ListFeederCalibrationsQuery(req.equipmentId, req.tenantId),
          ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectFeederCalibration,
        ),
    );
  }
}
