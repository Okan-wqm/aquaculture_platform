/**
 * Sample data for the two command-log views sensor-service cannot feed yet
 * (SENSOR-MEDIUM-185). Rendered only through MockPreview, which labels it.
 *
 * What is missing: one record per command across every channel. VFD runtime
 * commands are audited per drive (the page's real section), but OPC-UA writes
 * land in sensor_audit_logs with no reader, SCADA HMI writes and edge digital
 * outputs are not stored in the cloud at all, and device replies
 * (EdgeDeviceResponse) are published but never kept. No lock is stored either:
 * only isolated checks exist (drive must be ACTIVE, the OPC-UA node
 * allow-list, the SCADA PIN gate). The unified log's positions, people and
 * codes are invented examples, not tenant data; the lock rows are the three
 * locks §11 names, with nothing §11 does not say.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { CommandLockRow, UnifiedCommandRow } from './previewRows';

const UNIFIED_ROWS: readonly UnifiedCommandRow[] = [
  {
    id: 'u-9',
    at: '2026-10-16T08:14:30Z',
    requestedBy: 'A. Yılmaz',
    approvedBy: 'S. Kaya',
    target: 'P-101 · BL-02',
    channel: 'VFD',
    kind: 'SETPOINT',
    value: '45 Hz',
    status: 'QUEUED',
    replyMs: null,
    replyError: null,
    lock: null,
  },
  {
    id: 'u-8',
    at: '2026-10-16T08:12:04Z',
    requestedBy: 'A. Yılmaz',
    approvedBy: null,
    target: 'P-101 · BL-02',
    channel: 'VFD',
    kind: 'SETPOINT',
    value: '42 Hz',
    status: 'ACCEPTED',
    replyMs: 180,
    replyError: null,
    lock: null,
  },
  {
    id: 'u-7',
    at: '2026-10-16T08:05:40Z',
    requestedBy: 'M. Demir',
    approvedBy: 'S. Kaya',
    target: 'P-214 · FD-01',
    channel: 'OPC_UA',
    kind: 'FEEDER_PROGRAM',
    value: 'v3',
    status: 'ACCEPTED',
    replyMs: 640,
    replyError: null,
    lock: null,
  },
  {
    id: 'u-6',
    at: '2026-10-16T07:58:12Z',
    requestedBy: 'M. Demir',
    approvedBy: null,
    target: 'P-118 · O2-03',
    channel: 'OPC_UA',
    kind: 'SETPOINT',
    value: '4.2 mg/L',
    status: 'REJECTED_BY_LOCK',
    replyMs: null,
    replyError: null,
    lock: 'SAFETY_THRESHOLD',
  },
  {
    id: 'u-5',
    at: '2026-10-16T07:41:09Z',
    requestedBy: 'A. Yılmaz',
    approvedBy: null,
    target: 'P-305 · PU-04',
    channel: 'SCADA_HMI',
    kind: 'ON_OFF',
    value: 'OFF',
    status: 'REJECTED_BY_LOCK',
    replyMs: null,
    replyError: null,
    lock: 'OPEN_WORK_ORDER',
  },
  {
    id: 'u-4',
    at: '2026-10-16T07:30:00Z',
    requestedBy: 'automation',
    approvedBy: null,
    target: 'MP-2 · DO-1',
    channel: 'EDGE_OUTPUT',
    kind: 'SAMPLING_PERIOD',
    value: '60 s',
    status: 'TIMEOUT',
    replyMs: null,
    replyError: null,
    lock: null,
  },
  {
    id: 'u-3',
    at: '2026-10-16T07:12:55Z',
    requestedBy: 'S. Kaya',
    approvedBy: 'A. Yılmaz',
    target: 'MP-1 · PH-01',
    channel: 'EDGE_OUTPUT',
    kind: 'CALIBRATION',
    value: '1.012',
    status: 'ACCEPTED',
    replyMs: 220,
    replyError: null,
    lock: null,
  },
  {
    id: 'u-2',
    at: '2026-10-16T06:50:31Z',
    requestedBy: 'M. Demir',
    approvedBy: null,
    target: 'P-401 · SR-01',
    channel: 'EDGE_OUTPUT',
    kind: 'RELAY_OUTPUT',
    value: 'ON',
    status: 'EXPIRED',
    replyMs: null,
    replyError: null,
    lock: 'EDGE_OFFLINE',
  },
  {
    id: 'u-1',
    at: '2026-10-16T06:20:10Z',
    requestedBy: 'S. Kaya',
    approvedBy: null,
    target: 'P-118 · O2-03',
    channel: 'SCADA_HMI',
    kind: 'LOCAL_RULE',
    value: 'O2 < 5.0 → BL-02 ON',
    status: 'ERROR',
    replyMs: null,
    replyError: 'E_RULE_SLOTS_FULL',
    lock: null,
  },
];

// The three locks Architecture §11 names, and only what it says of them.
const LOCK_ROWS: readonly CommandLockRow[] = [
  { id: 'l-1', kind: 'OPEN_WORK_ORDER' },
  { id: 'l-2', kind: 'SAFETY_THRESHOLD' },
  { id: 'l-3', kind: 'EDGE_OFFLINE' },
];

export const UNIFIED_COMMAND_LOG_PREVIEW = definePreviewData(
  {
    finding: 'SENSOR-MEDIUM-185',
    reasonKey: 'sensorCommands.unified.previewReason',
    needs:
      'sensor-service command ledger (one row per command across VFD, OPC-UA, SCADA HMI and edge outputs, with the EdgeDeviceResponse reply) + a commandLog query',
  },
  UNIFIED_ROWS,
);

export const COMMAND_LOCKS_PREVIEW = definePreviewData(
  {
    finding: 'SENSOR-MEDIUM-185',
    reasonKey: 'sensorCommands.locks.previewReason',
    needs:
      'sensor-service command-lock entity (work order, livestock-safety limit, edge offline) + a commandLocks query',
  },
  LOCK_ROWS,
);
