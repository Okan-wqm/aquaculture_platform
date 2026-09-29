import { NotificationChannel } from '../database/entities/escalation-policy.entity';

/**
 * Escalation state for an incident, kept in Redis between ladder steps.
 */
export interface EscalationState {
  incidentId: string;
  /**
   * Owning tenant. WHY: timers, the missed-escalation sweep and boot-time
   * restore run OUTSIDE any request, and `alert_incidents` is a per-tenant
   * table — without the tenant the lookup hit the empty source schema, found
   * nothing, and every level after the first silently never fired.
   */
  tenantId: string;
  policyId: string;
  currentLevel: number;
  startedAt: Date;
  lastEscalatedAt: Date;
  escalationCount: number;
  acknowledgments: AcknowledgmentRecord[];
  notifications: NotificationRecord[];
  isComplete: boolean;
}

export interface AcknowledgmentRecord {
  userId: string;
  timestamp: Date;
  level: number;
  message?: string;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  channel: NotificationChannel;
  level: number;
  sentAt: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  error?: string;
}

/** Why a stored state could not be used. */
export type EscalationStateRejection = 'not-an-object' | 'missing-tenant' | 'malformed';

export type ParsedEscalationState =
  | { ok: true; state: EscalationState }
  | { ok: false; reason: EscalationStateRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((entry): entry is T => entry !== null);
}

function parseAcknowledgment(value: unknown): AcknowledgmentRecord | null {
  if (!isRecord(value)) return null;
  const userId = value['userId'];
  const level = value['level'];
  const timestamp = toDate(value['timestamp']);
  const message = value['message'];
  if (typeof userId !== 'string' || typeof level !== 'number' || timestamp === null) return null;
  return { userId, level, timestamp, ...(typeof message === 'string' ? { message } : {}) };
}

const CHANNELS: readonly string[] = Object.values(NotificationChannel);

function isChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && CHANNELS.includes(value);
}

function parseNotification(value: unknown): NotificationRecord | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const userId = value['userId'];
  const channel = value['channel'];
  const level = value['level'];
  const sentAt = toDate(value['sentAt']);
  if (
    typeof id !== 'string' ||
    typeof userId !== 'string' ||
    !isChannel(channel) ||
    typeof level !== 'number' ||
    sentAt === null
  ) {
    return null;
  }
  const deliveredAt = toDate(value['deliveredAt']);
  const failedAt = toDate(value['failedAt']);
  const error = value['error'];
  return {
    id,
    userId,
    channel,
    level,
    sentAt,
    ...(deliveredAt ? { deliveredAt } : {}),
    ...(failedAt ? { failedAt } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  };
}

/**
 * Type guard for a state read back from Redis (V-S1b-3).
 *
 * WHY: the restore and the missed-escalation sweep trusted `getJson<T>()`. A
 * state written before `tenantId` existed (or any damaged one) made the tenant
 * context helper throw, and the throw escaped the loop — aborting restore and
 * the sweep for EVERY later incident, every minute. Each state is now parsed
 * here; a legacy state without a tenant is reported as `missing-tenant` so the
 * caller can log and skip it without touching the others.
 */
export function parseEscalationState(raw: unknown): ParsedEscalationState {
  if (!isRecord(raw)) return { ok: false, reason: 'not-an-object' };
  const tenantId = raw['tenantId'];
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return { ok: false, reason: 'missing-tenant' };
  }
  const incidentId = raw['incidentId'];
  const policyId = raw['policyId'];
  const currentLevel = raw['currentLevel'];
  const escalationCount = raw['escalationCount'];
  const startedAt = toDate(raw['startedAt']);
  const lastEscalatedAt = toDate(raw['lastEscalatedAt']);
  if (
    typeof incidentId !== 'string' ||
    typeof policyId !== 'string' ||
    typeof currentLevel !== 'number' ||
    typeof escalationCount !== 'number' ||
    startedAt === null ||
    lastEscalatedAt === null
  ) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    state: {
      incidentId,
      tenantId,
      policyId,
      currentLevel,
      startedAt,
      lastEscalatedAt,
      escalationCount,
      acknowledgments: parseList(raw['acknowledgments'], parseAcknowledgment),
      notifications: parseList(raw['notifications'], parseNotification),
      isComplete: raw['isComplete'] === true,
    },
  };
}
