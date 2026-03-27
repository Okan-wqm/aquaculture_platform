# Parameter × Equipment Mapping — Architecture Plan

**Status:** DRAFT — Ready for next session implementation
**Date:** 2026-03-27
**Depends on:** Dynamic Parameter Config system (completed)

## Problem

Water quality parameters need to be measured at multiple equipment locations:
- pH → Tank 1, Tank 2, Biofilter output
- DO → Tank 1, Pond 1, Cage 3
- Turbidity → Biofilter output, Drum Filter output
- Ozone → Water Treatment Unit

Currently `WaterQualityMeasurement` only has `tankId` and `pondId`. No way to associate measurements with biofilters, drum filters, or other equipment.

## Architecture Decision

### Option A: Add `equipmentId` to WaterQualityMeasurement (CHOSEN)
- Replace `tankId`/`pondId` with generic `equipmentId` FK to Equipment entity
- Equipment entity already covers tanks, ponds, biofilters, drum filters, etc.
- Keep `tankId`/`pondId` as deprecated aliases for backward compatibility
- Add `WaterQualityParameterEquipmentMapping` junction for config

### Data Model

```
WaterQualityParameterEquipmentMapping (NEW)
  - id: UUID PK
  - tenantId: UUID
  - parameterConfigId: FK → WaterQualityParameterConfig.id
  - equipmentId: FK → Equipment.id
  - isActive: boolean (default true)
  - monitoringFrequency: 'continuous' | 'hourly' | 'daily' | 'weekly' | 'on_demand'
  - sensorId: UUID (optional — linked sensor device)
  - alertEnabled: boolean (default true)
  - notes: string (optional)
  - createdAt, updatedAt

Indexes:
  - UNIQUE (tenantId, parameterConfigId, equipmentId)
  - (tenantId, equipmentId)
  - (tenantId, parameterConfigId)
```

### WaterQualityMeasurement Changes
- Add `equipmentId` (nullable FK → Equipment)
- Keep `tankId`/`pondId` for backward compat (auto-populated from equipment if category is tank/pond)
- Measurement stores WHICH equipment the reading came from

### Frontend Changes
1. **Parameter Config Manager** — add "Equipment" column showing linked equipment per parameter
2. **Equipment Mapping Modal** — select which equipment to associate with a parameter
3. **History Tab** — filter by equipment (not just tank)
4. **Measurement Form** — select equipment as measurement location

### Implementation Phases (next session)

Phase 1: Backend — Junction entity + CRUD + migration
Phase 2: Backend — WaterQualityMeasurement equipmentId field
Phase 3: Frontend — Equipment mapping UI in Parameters tab
Phase 4: Frontend — History tab equipment filter
Phase 5: Tenant provisioning — default mappings

### Equipment Categories Relevant for WQ Monitoring
- TANK (most common)
- POND
- CAGE
- FILTRATION (biofilter, drum filter, sand filter)
- WATER_TREATMENT (UV, ozone units)
- AERATION (before/after comparison)

### Estimated Effort
- ~15 new/modified files
- ~1,200 lines
- 2-3 wave execution with ruflo agents
