/**
 * STRICT edge-deploy recomposition of the SCADA package document schema
 * (CONTRACT-H-002). The base DocV2 schema is the SAVE contract and stays
 * deliberately open (the builder evolves faster than the schema); THIS
 * schema is the PUBLISH contract — it closes exactly the fields the Rust
 * edge structs (`sens-api-gateway/src/scada_types.rs`) require:
 *
 *  - `widgetType` — the closed 16-type set the Rust `WidgetType` enum
 *    mirrors (anything else must have been stripped or rejected by
 *    `transformScadaDocForEdgeDeploy` before validation);
 *  - screen `name` + `screenType` — required, `screenType` in the closed
 *    Rust `ScreenType` set;
 *  - alarm `severity` in the closed Rust `AlarmSeverity` set and
 *    `message` required (both required fields of the Rust `AlarmRule`).
 *
 * A document that passes here is structurally guaranteed to deserialize
 * on the edge without any widget falling into the `Unknown` bucket.
 */

import {
  EDGE_ALARM_SEVERITIES,
  EDGE_SCREEN_TYPES,
  EDGE_SUPPORTED_WIDGET_TYPES,
} from './edge-widget-support';
import {
  ALARM_RULE_SCHEMA,
  SCADA_PACKAGE_DOC_V2_SCHEMA,
  SCREEN_SCHEMA,
  WIDGET_SCHEMA,
} from './scada-package-doc.schema';

export const EDGE_WIDGET_SCHEMA = {
  ...WIDGET_SCHEMA,
  properties: {
    ...WIDGET_SCHEMA.properties,
    widgetType: { type: 'string', enum: EDGE_SUPPORTED_WIDGET_TYPES },
  },
} as const;

export const EDGE_SCREEN_SCHEMA = {
  ...SCREEN_SCHEMA,
  properties: {
    ...SCREEN_SCHEMA.properties,
    name: { type: 'string', minLength: 1 },
    screenType: { type: 'string', enum: EDGE_SCREEN_TYPES },
    widgets: { type: 'array', items: EDGE_WIDGET_SCHEMA },
  },
  required: ['id', 'name', 'screenType', 'widgets'],
} as const;

export const EDGE_ALARM_RULE_SCHEMA = {
  ...ALARM_RULE_SCHEMA,
  properties: {
    ...ALARM_RULE_SCHEMA.properties,
    severity: { type: 'string', enum: EDGE_ALARM_SEVERITIES },
    message: { type: 'string', minLength: 1 },
  },
  required: [...ALARM_RULE_SCHEMA.required, 'message'],
} as const;

export const EDGE_SCADA_PACKAGE_DOC_SCHEMA = {
  ...SCADA_PACKAGE_DOC_V2_SCHEMA,
  properties: {
    ...SCADA_PACKAGE_DOC_V2_SCHEMA.properties,
    screens: { type: 'array', items: EDGE_SCREEN_SCHEMA },
    alarmRules: { type: 'array', items: EDGE_ALARM_RULE_SCHEMA },
  },
} as const;
