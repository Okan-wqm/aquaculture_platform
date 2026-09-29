import type { TenantOwnerRegistry } from '@aquaculture/backend-common/nats';

import { Batch } from '../../batch/entities/batch.entity';
import { Department } from '../../department/entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Site } from '../../site/entities/site.entity';
import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';

/**
 * Which farm table every id an AI request may carry must be a row of
 * (K10 layer 4, PR-T1 — V-T1b-1).
 *
 * WHY here and not in each handler: the responder skeleton resolves every id
 * against this registry inside the tenant boundary BEFORE any handler runs,
 * so an id that belongs to another tenant is NOT_FOUND for every subject —
 * including the aggregates and eligibility checks that would otherwise answer
 * "0 kg" or "no blocking events". A request field ending in `Id` that is not
 * listed here is refused, so a new id field cannot ship unresolved.
 */
export const FARM_AI_OWNERS: TenantOwnerRegistry = {
  tankId: { entity: Tank },
  batchId: { entity: Batch },
  siteId: { entity: Site },
  systemId: { entity: System },
  departmentId: { entity: Department },
  equipmentId: { entity: Equipment },
  equipmentTypeId: { entity: EquipmentType },
  // A feeding summary names a batch or a tank (FEEDING_ENTITY_TYPES).
  entityId: { entityFor: (fields) => (fields['entityType'] === 'batch' ? Batch : Tank) },
};
