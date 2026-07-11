/**
 * JSON Schema for the V2 SCADA package document — the save-time trust
 * boundary in `ScadaPackageService` (replaces the old shallow
 * "screens must be an array" check). Compiled AJV validators live in
 * `@platform/sensor-contracts/validators` (backend-only subpath) so the
 * schema object itself stays importable from browser bundles.
 *
 * Strictness posture: core structure is REQUIRED (schemaVersion, screens,
 * widget identity/position/config); everything else is additive-open
 * (`additionalProperties: true`) because the document evolves with the
 * builder faster than this schema should have to.
 */

import { TAG_REF_PATTERN } from '../tag-ref';

const WIDGET_POSITION_SCHEMA = {
  type: 'object',
  properties: {
    col: { type: 'number' },
    row: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
  required: ['col', 'row', 'w', 'h'],
  additionalProperties: true,
} as const;

const WIDGET_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    widgetType: { type: 'string', minLength: 1 },
    position: WIDGET_POSITION_SCHEMA,
    config: {
      type: 'object',
      properties: {
        tagRef: { type: 'string', pattern: TAG_REF_PATTERN },
      },
      additionalProperties: true,
    },
    name: { type: 'string' },
    groupId: { type: ['string', 'null'] },
    locked: { type: 'boolean' },
    visible: { type: 'boolean' },
    zIndex: { type: 'number' },
    permissions: { type: 'object' },
    animations: { type: 'array' },
    events: { type: 'array' },
  },
  required: ['id', 'widgetType', 'position', 'config'],
  additionalProperties: true,
} as const;

const SCREEN_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    screenType: { type: 'string' },
    isDefault: { type: 'boolean' },
    widgets: { type: 'array', items: WIDGET_SCHEMA },
    edges: { type: 'array' },
    parentId: { type: ['string', 'null'] },
    sortOrder: { type: 'number' },
    backgroundImage: { type: ['string', 'null'] },
    backgroundOpacity: { type: 'number' },
  },
  required: ['id', 'widgets'],
  additionalProperties: true,
} as const;

const ALARM_RULE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    tag: { type: 'string' },
    condition: { type: 'string' },
    value: { type: 'number' },
    severity: { type: 'string' },
    message: { type: 'string' },
    deadband: { type: 'number' },
    delay: { type: 'number' },
  },
  required: ['id', 'tag', 'condition', 'value', 'severity'],
  additionalProperties: true,
} as const;

export const SCADA_PACKAGE_DOC_V2_SCHEMA = {
  type: 'object',
  properties: {
    meta: {
      type: 'object',
      properties: {
        schemaVersion: { const: 2 },
      },
      required: ['schemaVersion'],
      additionalProperties: true,
    },
    screens: { type: 'array', items: SCREEN_SCHEMA },
    alarmRules: { type: 'array', items: ALARM_RULE_SCHEMA },
    controlPermissions: { type: 'object' },
    trendConfig: { type: 'object' },
    scripts: { type: 'array' },
  },
  required: ['meta', 'screens'],
  additionalProperties: true,
} as const;
