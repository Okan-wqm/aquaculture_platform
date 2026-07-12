/**
 * Alarm-acknowledgement event contract.
 *
 * The SCADA gateway emits these when an operator acknowledges an alarm; the
 * AlarmEngineService consumes them. It lives in its own module because the
 * engine already depends on the gateway (for pushAlarmStatus), so the gateway
 * cannot import the engine — acknowledgement crosses the boundary as an event,
 * and both sides import these neutral constants without a circular edge.
 */

export const SCADA_ALARM_ACK_EVENT = 'scada.alarm.ack';
export const SCADA_ALARM_ACK_ALL_EVENT = 'scada.alarm.ack_all';

export interface AlarmAckRequest {
  alarmInstanceId: string;
  userId: string;
  tenantId: string;
}

export interface AlarmAckAllRequest {
  userId: string;
  tenantId: string;
}
