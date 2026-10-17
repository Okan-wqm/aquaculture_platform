/**
 * The shape the cross-device command log and the lock list will have once
 * sensor-service records them (SENSOR-MEDIUM-185), and their words.
 *
 * WHY here and typed: the preview data (commandLog.preview.ts) and the
 * sections that render it share these types, so when the backend lands the
 * real query's rows replace the preview's against the same columns. The
 * vocabulary follows Platform Architecture v4 §11 "Kontrol: platformdan
 * sahaya": a command is requested (and, when critical, approved by someone
 * else), may be rejected by a lock before it is sent, is queued for the edge,
 * and ends accepted, in error, timed out or expired.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

/** Where a command goes (§11): every write to the field, whatever carries it. */
export type CommandChannel = 'VFD' | 'OPC_UA' | 'SCADA_HMI' | 'EDGE_OUTPUT';

/** What a command does (§11 "everything sent to the field is a command record"). */
export type CommandKind =
  | 'SETPOINT'
  | 'ON_OFF'
  | 'FEEDER_PROGRAM'
  | 'SAMPLING_PERIOD'
  | 'CALIBRATION'
  | 'LOCAL_RULE'
  | 'RELAY_OUTPUT';

/** A command's lifecycle (§11 pipeline: lock → queue → edge apply → result). */
export type CommandStatus =
  | 'QUEUED'
  | 'SENT'
  | 'ACCEPTED'
  | 'REJECTED_BY_LOCK'
  | 'ERROR'
  | 'TIMEOUT'
  | 'EXPIRED';

/** The locks that reject a command before it is sent (§11). */
export type CommandLockKind = 'OPEN_WORK_ORDER' | 'SAFETY_THRESHOLD' | 'EDGE_OFFLINE';

export interface UnifiedCommandRow {
  readonly id: string;
  /** ISO timestamp of the request. */
  readonly at: string;
  readonly requestedBy: string;
  /** The second person of a two-step critical command; never the requester. */
  readonly approvedBy: string | null;
  /** The position (and the asset mounted there) the command targets. */
  readonly target: string;
  readonly channel: CommandChannel;
  readonly kind: CommandKind;
  /** The value as sent, with its unit. */
  readonly value: string;
  readonly status: CommandStatus;
  /** Round-trip time of an accepted command. */
  readonly replyMs: number | null;
  /** The device's error code for a command it refused. */
  readonly replyError: string | null;
  /** The lock that rejected or held the command. */
  readonly lock: CommandLockKind | null;
}

/**
 * One lock as §11 defines it: its kind, and — through the words below — what
 * it blocks and what happens to a command it stops. Nothing more is defined
 * yet: a lock's state, onset or rejection count waits for design or the
 * SENSOR-MEDIUM-185 backend.
 */
export interface CommandLockRow {
  readonly id: string;
  readonly kind: CommandLockKind;
}

export const CHANNEL_KEYS: Readonly<Record<CommandChannel, MessageKey>> = {
  VFD: 'sensorCommands.channel.VFD',
  OPC_UA: 'sensorCommands.channel.OPC_UA',
  SCADA_HMI: 'sensorCommands.channel.SCADA_HMI',
  EDGE_OUTPUT: 'sensorCommands.channel.EDGE_OUTPUT',
};

export const KIND_KEYS: Readonly<Record<CommandKind, MessageKey>> = {
  SETPOINT: 'sensorCommands.kind.SETPOINT',
  ON_OFF: 'sensorCommands.kind.ON_OFF',
  FEEDER_PROGRAM: 'sensorCommands.kind.FEEDER_PROGRAM',
  SAMPLING_PERIOD: 'sensorCommands.kind.SAMPLING_PERIOD',
  CALIBRATION: 'sensorCommands.kind.CALIBRATION',
  LOCAL_RULE: 'sensorCommands.kind.LOCAL_RULE',
  RELAY_OUTPUT: 'sensorCommands.kind.RELAY_OUTPUT',
};

export const STATUS_KEYS: Readonly<Record<CommandStatus, MessageKey>> = {
  QUEUED: 'sensorCommands.status.QUEUED',
  SENT: 'sensorCommands.status.SENT',
  ACCEPTED: 'sensorCommands.status.ACCEPTED',
  REJECTED_BY_LOCK: 'sensorCommands.status.REJECTED_BY_LOCK',
  ERROR: 'sensorCommands.status.ERROR',
  TIMEOUT: 'sensorCommands.status.TIMEOUT',
  EXPIRED: 'sensorCommands.status.EXPIRED',
};

/** The statuses of a command that did not take effect: the amber-flagged rows. */
export const NOT_APPLIED: ReadonlySet<CommandStatus> = new Set([
  'REJECTED_BY_LOCK',
  'ERROR',
  'TIMEOUT',
  'EXPIRED',
]);

export const LOCK_KEYS: Readonly<Record<CommandLockKind, MessageKey>> = {
  OPEN_WORK_ORDER: 'sensorCommands.lock.OPEN_WORK_ORDER',
  SAFETY_THRESHOLD: 'sensorCommands.lock.SAFETY_THRESHOLD',
  EDGE_OFFLINE: 'sensorCommands.lock.EDGE_OFFLINE',
};

/** What each lock blocks (§11). */
export const LOCK_BLOCKS_KEYS: Readonly<Record<CommandLockKind, MessageKey>> = {
  OPEN_WORK_ORDER: 'sensorCommands.lockBlocks.OPEN_WORK_ORDER',
  SAFETY_THRESHOLD: 'sensorCommands.lockBlocks.SAFETY_THRESHOLD',
  EDGE_OFFLINE: 'sensorCommands.lockBlocks.EDGE_OFFLINE',
};

/** What happens to a command a lock stops (§11): rejected before sending, or queued, then expired. */
export const LOCK_OUTCOME_KEYS: Readonly<Record<CommandLockKind, MessageKey>> = {
  OPEN_WORK_ORDER: 'sensorCommands.lockOutcome.OPEN_WORK_ORDER',
  SAFETY_THRESHOLD: 'sensorCommands.lockOutcome.SAFETY_THRESHOLD',
  EDGE_OFFLINE: 'sensorCommands.lockOutcome.EDGE_OFFLINE',
};
