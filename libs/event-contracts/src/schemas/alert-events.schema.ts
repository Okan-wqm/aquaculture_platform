import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import {
  ALERT_DELIVERY_CHANNELS,
  ALERT_ESCALATED_EVENT_VERSION,
  ALERT_RECIPIENT_ROLES,
  type AlertEscalatedEvent,
} from '../alert-events';
import { LEGACY_EVENT_SHAPE_MARKER } from '../upcasters/alert-escalated-legacy.upcaster';
import {
  ALERT_RECIPIENT_QUERY_MAX_USER_IDS,
  ALERT_RECIPIENT_RESULT_MAX_USER_IDS,
  type AlertRecipientQuery,
  type AlertRecipientResult,
} from '../alert-recipient-queries';

import { BASE_EVENT_PROPERTIES, BASE_EVENT_REQUIRED, UUID_SCHEMA } from './common.schema';

/**
 * Free-text bounds of the event. The producer cuts to these before enqueueing
 * (an incident title/description is unbounded text in alert-engine), so a long
 * description can never turn a page into a dead letter.
 */
export const ALERT_ESCALATED_TEXT_LIMITS = {
  title: 255,
  description: 5000,
  reason: 2000,
} as const;

/**
 * Trust-boundary schemas for the alarm delivery hand-off (ALERT-CRITICAL-004).
 *
 * WHY: `AlertEscalated` is the only thing that turns an incident into a page,
 * and notification-service acts on it without reading alert-engine's database.
 * A malformed event must be refused at the boundary (dead-lettered with a
 * reason), not half-delivered. `additionalProperties: false` keeps the event
 * flat and the recipient result free of anything but user ids (no PII can be
 * added to that surface without failing this schema).
 */

const ROLE_ARRAY = {
  type: 'array',
  items: { type: 'string', enum: [...ALERT_RECIPIENT_ROLES] },
  maxItems: ALERT_RECIPIENT_ROLES.length,
  uniqueItems: true,
} as const;

const ALERT_ESCALATED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...BASE_EVENT_REQUIRED,
    'alertId',
    'escalationLevel',
    'escalatedTo',
    'reason',
    'ruleId',
    'signalKey',
    'title',
    'description',
    'severity',
    'channels',
    'tenantWideRecipientRoles',
    'siteRecipientRoles',
    'siteId',
  ],
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'AlertEscalated' },
    // V-S1a-11: only the delivery-carrying shape is admitted.
    version: { type: 'integer', const: ALERT_ESCALATED_EVENT_VERSION },
    alertId: UUID_SCHEMA,
    escalationLevel: { type: 'integer', minimum: 1, maximum: 100 },
    // User ids only: the producer drops anything else before enqueueing, so
    // a free-text policy entry can never turn the whole page into a dead letter.
    escalatedTo: {
      type: 'array',
      items: UUID_SCHEMA,
      maxItems: ALERT_RECIPIENT_QUERY_MAX_USER_IDS,
      uniqueItems: true,
    },
    reason: { type: 'string', maxLength: ALERT_ESCALATED_TEXT_LIMITS.reason },
    ruleId: { type: 'string', pattern: UUID_SCHEMA.pattern, nullable: true },
    signalKey: { type: 'string', minLength: 1, maxLength: 200, nullable: true },
    title: { type: 'string', minLength: 1, maxLength: ALERT_ESCALATED_TEXT_LIMITS.title },
    description: { type: 'string', maxLength: ALERT_ESCALATED_TEXT_LIMITS.description },
    severity: { type: 'string', enum: ['info', 'low', 'warning', 'medium', 'high', 'critical'] },
    channels: {
      type: 'array',
      items: { type: 'string', enum: [...ALERT_DELIVERY_CHANNELS] },
      maxItems: ALERT_DELIVERY_CHANNELS.length,
      uniqueItems: true,
    },
    tenantWideRecipientRoles: ROLE_ARRAY,
    siteRecipientRoles: ROLE_ARRAY,
    siteId: { type: 'string', pattern: UUID_SCHEMA.pattern, nullable: true },
  },
} as const;

const ALERT_RECIPIENT_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tenantWideRoles', 'siteRoles', 'siteId', 'userIds'],
  properties: {
    tenantWideRoles: ROLE_ARRAY,
    siteRoles: ROLE_ARRAY,
    siteId: { type: 'string', pattern: UUID_SCHEMA.pattern, nullable: true },
    userIds: {
      type: 'array',
      items: UUID_SCHEMA,
      maxItems: ALERT_RECIPIENT_QUERY_MAX_USER_IDS,
      uniqueItems: true,
    },
  },
} as const;

const ALERT_RECIPIENT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['userIds', 'truncated'],
  properties: {
    userIds: {
      type: 'array',
      items: UUID_SCHEMA,
      maxItems: ALERT_RECIPIENT_RESULT_MAX_USER_IDS,
    },
    truncated: { type: 'boolean' },
  },
} as const;

// Compile once at module load — the delivery path runs per escalation. The
// generic makes each validator a type guard, so a passing payload is narrowed
// without a cast.
const ajv = new Ajv({ strict: false, allErrors: false, removeAdditional: false });
addFormats(ajv);

const alertEscalatedValidator: ValidateFunction<AlertEscalatedEvent> =
  ajv.compile<AlertEscalatedEvent>(ALERT_ESCALATED_SCHEMA);
const alertRecipientQueryValidator: ValidateFunction<AlertRecipientQuery> =
  ajv.compile<AlertRecipientQuery>(ALERT_RECIPIENT_QUERY_SCHEMA);
const alertRecipientResultValidator: ValidateFunction<AlertRecipientResult> =
  ajv.compile<AlertRecipientResult>(ALERT_RECIPIENT_RESULT_SCHEMA);

/** First failing keyword, for the dead-letter / refusal reason. */
function firstError(validator: ValidateFunction): string {
  const error = validator.errors?.[0];
  return error ? `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}` : 'invalid';
}

export type TrustBoundaryCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

export function checkAlertEscalatedEvent(
  payload: unknown,
): TrustBoundaryCheck<AlertEscalatedEvent> {
  // The terminal upcaster's marker gets its own reason: an operator reading
  // the dead letter should see "legacy shape", not "additional property".
  if (typeof payload === 'object' && payload !== null && LEGACY_EVENT_SHAPE_MARKER in payload) {
    return { ok: false, reason: 'legacy AlertEscalated shape (v1/v2) carries no delivery fields' };
  }
  return alertEscalatedValidator(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: firstError(alertEscalatedValidator) };
}

export function checkAlertRecipientQuery(
  payload: unknown,
): TrustBoundaryCheck<AlertRecipientQuery> {
  return alertRecipientQueryValidator(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: firstError(alertRecipientQueryValidator) };
}

export function checkAlertRecipientResult(
  payload: unknown,
): TrustBoundaryCheck<AlertRecipientResult> {
  return alertRecipientResultValidator(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: firstError(alertRecipientResultValidator) };
}
