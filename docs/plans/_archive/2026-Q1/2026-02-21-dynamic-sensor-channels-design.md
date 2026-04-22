# Dynamic Sensor Channels + AI-Assisted Configuration

**Date:** 2026-02-21
**Status:** Approved

## Problem

Sensor module is hardcoded for aquaculture (pH, dissolved_oxygen, etc.). We want to serve multiple industries (cold chain logistics, greenhouses, wind energy, etc.) without schema changes. Users need to define custom sensor channels, and AI should assist with auto-detection and configuration.

## Decision

**Template + Dynamic Channel** approach. No dynamic schema modification. AI operates at configuration level only — never touches database schema.

## Architecture

### Core Principle

```
sensor_metrics (narrow table) → industry-agnostic, never changes
sensor_data_channels          → dynamic per-sensor channel definitions
sensor_type_definitions (NEW) → replaces hardcoded ENUM
industry_templates (NEW)      → pre-built channel sets per industry
```

### Data Flow

```
                    ┌─────────────────────────────┐
                    │    Industry Templates        │
                    │  ┌───────────────────────┐   │
                    │  │ Aquaculture           │   │
                    │  │  pH, DO, temp, salinity│  │
                    │  ├───────────────────────┤   │
                    │  │ Cold Chain             │   │
                    │  │  fridge_temp, humidity │   │
                    │  ├───────────────────────┤   │
                    │  │ Greenhouse             │   │
                    │  │  soil_moisture, light  │   │
                    │  └───────────────────────┘   │
                    └──────────┬──────────────────┘
                               │ template selected
                               ▼
┌──────────┐   POST    ┌──────────────┐   INSERT   ┌─────────────────────┐
│ Frontend │ ────────► │   Backend    │ ─────────► │ sensor_data_channels│
│  Form    │           │   API        │            │ discovery: template │
└──────────┘           └──────┬───────┘            └─────────────────────┘
                              │
                              │ user adds custom channel
                              ▼
┌──────────┐   POST    ┌──────────────┐   INSERT   ┌─────────────────────┐
│ Frontend │ ────────► │   Backend    │ ─────────► │ sensor_data_channels│
│  Custom  │           │   API        │            │ discovery: manual   │
│  Form    │           └──────────────┘            └─────────────────────┘

                    ┌─────────────────────────────┐
                    │  AI Auto-Detection Flow      │
                    │                              │
                    │  1. Unknown data arrives      │
                    │  2. AI analyzes patterns      │
                    │  3. AI proposes channel def   │
                    │  4. User approves/edits       │
                    │  5. Channel created           │
                    │     discovery: auto           │
                    └─────────────────────────────┘
```

All data lands in the same `sensor_metrics` hypertable regardless of industry.

## New Database Tables

### 1. `sensor_type_definitions` — Replaces Hardcoded ENUM

```sql
CREATE TABLE sensor_type_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  type_key        VARCHAR(100) NOT NULL,       -- 'ph_sensor', 'fridge_monitor', 'wind_gauge'
  display_name    VARCHAR(200) NOT NULL,
  description     TEXT,
  icon            VARCHAR(100),                -- frontend icon identifier
  category        VARCHAR(100),                -- 'water_quality', 'climate', 'mechanical'
  industry        VARCHAR(100),                -- 'aquaculture', 'cold_chain', 'greenhouse'
  is_system       BOOLEAN DEFAULT false,       -- platform-provided vs tenant-created
  default_channels JSONB,                      -- channel definitions to auto-create
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, type_key)
);
```

### 2. `industry_templates` — Pre-built Configurations

```sql
CREATE TABLE industry_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key    VARCHAR(100) UNIQUE NOT NULL, -- 'aquaculture', 'cold_chain'
  display_name    VARCHAR(200) NOT NULL,
  description     TEXT,
  icon            VARCHAR(100),
  sensor_types    JSONB NOT NULL,               -- array of sensor_type_definition specs
  dashboard_layout JSONB,                       -- suggested widget arrangement
  alert_presets   JSONB,                        -- industry-standard thresholds
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### 3. `channel_detection_log` — AI Detection Audit Trail

```sql
CREATE TABLE channel_detection_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  sensor_id       UUID NOT NULL REFERENCES sensors(id),
  raw_sample      JSONB NOT NULL,              -- sample of incoming data
  ai_analysis     JSONB NOT NULL,              -- AI's reasoning and confidence
  proposed_channels JSONB NOT NULL,            -- what AI suggested
  user_action     VARCHAR(20),                 -- 'approved', 'modified', 'rejected'
  final_channels  JSONB,                       -- what was actually created
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

## Changes to Existing Tables

### `sensors` Table

```sql
-- Replace hardcoded ENUM with FK to dynamic definitions
ALTER TABLE sensors ADD COLUMN type_definition_id UUID REFERENCES sensor_type_definitions(id);
-- Keep old 'type' column temporarily for backward compatibility during migration
```

## AI Auto-Detection Flow

### When Unknown Data Arrives

```
1. MQTT/HTTP data arrives for a sensor with no channel definitions
2. Buffer N samples (e.g., 10 readings over 1 minute)
3. Send samples to AI service with tool calls:

   AI Tools Available:
   ┌─────────────────────────────────────────────────┐
   │ analyze_sensor_data(samples)                     │
   │   → returns: detected metrics, units, ranges     │
   │                                                   │
   │ suggest_channels(analysis)                        │
   │   → returns: channel definitions with confidence  │
   │                                                   │
   │ match_industry_template(channels)                 │
   │   → returns: best matching template if any        │
   │                                                   │
   │ create_channel_proposal(sensor_id, channels)      │
   │   → stores proposal, notifies user                │
   └─────────────────────────────────────────────────┘

4. AI analyzes:
   - Data types (float, boolean, string)
   - Value ranges (0-14 → likely pH, -30 to 50 → likely temperature)
   - Field names from MQTT topic or payload keys
   - Patterns (cyclic → environmental, step changes → mechanical)

5. AI creates proposal → user gets notification
6. User approves/edits via frontend → channels created
7. Buffered data replayed into sensor_metrics
```

### AI Confidence Levels

```
HIGH (>90%)   → auto-suggest with pre-filled form
MEDIUM (60-90%) → suggest with alternatives
LOW (<60%)    → ask user to define manually, show AI's best guess
```

## Frontend Dynamic Rendering

Frontend reads `sensor_data_channels` metadata to render:

```typescript
interface ChannelDisplayConfig {
  channel_key: string;       // "vibration"
  display_label: string;     // "Vibration"
  unit_symbol: string;       // "mm/s"
  widget_type: string;       // "gauge" | "line_chart" | "boolean_indicator" | "bar"
  color: string;             // "#FF5722"
  icon: string;              // "vibration_icon"
  precision: number;         // 2
  operational_min: number;   // 0
  operational_max: number;   // 50
  alert_thresholds: {
    warning: { low?: number; high?: number };
    critical: { low?: number; high?: number };
  };
}
```

No hardcoded widgets. Dashboard renders based on channel metadata.

## API Endpoints

### Sensor Type Definitions
- `GET    /sensor-types` — list available types (system + tenant custom)
- `POST   /sensor-types` — create custom sensor type
- `PATCH  /sensor-types/:id` — update
- `DELETE /sensor-types/:id` — delete (only tenant-created)

### Industry Templates
- `GET    /industry-templates` — list all templates
- `POST   /industry-templates/:id/apply` — apply template to tenant

### Channel Management (existing, extend)
- `GET    /sensors/:id/channels` — list channels
- `POST   /sensors/:id/channels` — create custom channel
- `PATCH  /sensors/:id/channels/:channelId` — update channel
- `DELETE /sensors/:id/channels/:channelId` — remove channel

### AI Detection
- `POST   /sensors/:id/detect-channels` — trigger AI analysis on buffered data
- `GET    /sensors/:id/channel-proposals` — get pending AI proposals
- `POST   /sensors/:id/channel-proposals/:proposalId/approve` — approve proposal
- `POST   /sensors/:id/channel-proposals/:proposalId/reject` — reject proposal

## Migration Strategy

1. Create new tables (`sensor_type_definitions`, `industry_templates`, `channel_detection_log`)
2. Seed aquaculture types from existing ENUM values
3. Seed aquaculture industry template
4. Add `type_definition_id` FK to `sensors`, populate from existing `type` column
5. Update sensor creation flow to use `type_definition_id`
6. Deprecate `type` ENUM column (remove in future release)

## What AI Does NOT Do

- No `CREATE TABLE`, `ALTER TABLE`, `DROP` — ever
- No direct database access
- No schema modification
- Only creates configuration entries in existing tables
- All proposals require user approval (no auto-apply)