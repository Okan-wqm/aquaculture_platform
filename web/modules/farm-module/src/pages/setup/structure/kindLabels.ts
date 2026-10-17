/**
 * Message keys for the facility tree's node kinds — one map, read by the
 * tree, the panel header, the responsibility rows and the capped-list notes.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

import type { FacilityNodeKind } from './facilityTree';

export const KIND_LABEL_KEY: Record<FacilityNodeKind, MessageKey> = {
  site: 'facilityStructure.kind.site',
  department: 'facilityStructure.kind.department',
  system: 'facilityStructure.kind.system',
  equipment: 'facilityStructure.kind.equipment',
};

/** Plural headings, used where a capped list names what it is short of. */
export const KIND_PLURAL_KEY: Record<'department' | 'system' | 'equipment', MessageKey> = {
  department: 'facilityStructure.kpi.departments',
  system: 'facilityStructure.kpi.systems',
  equipment: 'facilityStructure.kpi.equipment',
};
