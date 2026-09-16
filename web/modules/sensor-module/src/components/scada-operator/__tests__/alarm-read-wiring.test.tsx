/**
 * T1/T2 alarm read wiring (store-level):
 *  - ONE store: an ALARM_STATUS payload dispatched through the unified
 *    package store's alarmRuntimeSlice must update the AlarmSummaryBar
 *    counts.
 *  - ISA-18.2: severities with UNACKNOWLEDGED alarms carry the flash class;
 *    fully acknowledged severities render steady.
 *  - ACK mutators only EMIT over the socket — no local optimistic state.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { useScadaPackageStore } from '../../../store/scada/createScadaStore';
import { getScadaSocketService } from '../../../services/ScadaSocketService';
import { AlarmSummaryBar } from '../AlarmSummaryBar';
import type { AlarmInstance, AlarmStatusSummary } from '../../../types/scada-runtime.types';

function alarm(partial: Partial<AlarmInstance>): AlarmInstance {
  return {
    id: partial.id ?? 'a-1',
    ruleId: 'r-1',
    ruleName: 'Rule',
    severity: 'critical',
    status: 'active',
    message: 'message',
    currentValue: 1,
    threshold: 0,
    onTime: Date.now(),
    ...partial,
  };
}

describe('T1 alarm read wiring: ALARM_STATUS push → summary bar', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
  });

  it('renders server counts and totalActive from the summary', () => {
    const summary: AlarmStatusSummary = {
      critical: 2,
      high: 1,
      warning: 0,
      info: 0,
      activeAlarms: [],
      totalActive: 7, // server-counted (authoritative over the sum)
    };
    useScadaPackageStore.getState().updateAlarmStatus(summary);

    render(<AlarmSummaryBar />);

    expect(screen.getByText('Critical:')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('7 active')).toBeTruthy();
  });

  it('applies flash classes ONLY to severities with unacknowledged alarms (ISA-18.2)', () => {
    const summary: AlarmStatusSummary = {
      critical: 1,
      high: 2,
      warning: 0,
      info: 0,
      activeAlarms: [
        alarm({ id: 'a-c', severity: 'critical', status: 'acknowledged' }),
        alarm({ id: 'a-h', severity: 'high', status: 'active' }), // unacked
        alarm({ id: 'a-h2', severity: 'high', status: 'acknowledged' }),
      ],
      // additive backend contract present:
      unacked: { critical: 0, high: 1, warning: 0, info: 0 },
    };
    useScadaPackageStore.getState().updateAlarmStatus(summary);

    const { container } = render(<AlarmSummaryBar />);

    const chips = Array.from(container.querySelectorAll('.rounded-full')).filter(
      (el) => el.textContent?.includes(':'),
    );
    const criticalChip = chips.find((c) => c.textContent?.startsWith('Critical'));
    const highChip = chips.find((c) => c.textContent?.startsWith('High'));

    // UNACKED severity flashes…
    expect(highChip?.className).toContain('scada-alarm-flash');
    // …acknowledged severity is steady (severity = color only).
    expect(criticalChip?.className).not.toContain('scada-alarm-flash');
  });

  it('derives unacked counts from the 4-state model when summary.unacked is absent', () => {
    const summary: AlarmStatusSummary = {
      critical: 1,
      high: 0,
      warning: 0,
      info: 0,
      activeAlarms: [
        alarm({ id: 'a-c', severity: 'critical', status: 'active' }), // active == unacked
      ],
    };
    useScadaPackageStore.getState().updateAlarmStatus(summary);

    const { container } = render(<AlarmSummaryBar />);
    const chips = Array.from(container.querySelectorAll('.rounded-full')).filter(
      (el) => el.textContent?.includes(':'),
    );
    const criticalChip = chips.find((c) => c.textContent?.startsWith('Critical'));
    expect(criticalChip?.className).toContain('scada-alarm-flash');
  });

  it('ack submit goes over the socket only — no local status mutation', () => {
    const socket = getScadaSocketService();
    const ackSpy = vi.spyOn(socket, 'acknowledgeAlarm').mockImplementation(() => {});

    const summary: AlarmStatusSummary = {
      critical: 1,
      high: 0,
      warning: 0,
      info: 0,
      activeAlarms: [alarm({ id: 'a-9', severity: 'critical', status: 'active' })],
    };
    useScadaPackageStore.getState().updateAlarmStatus(summary);

    useScadaPackageStore.getState().submitAlarmAck('a-9');
    expect(ackSpy).toHaveBeenCalledWith('a-9');

    // State unchanged until the server pushes the next ALARM_STATUS.
    expect(
      useScadaPackageStore.getState().activeAlarms.find((a) => a.id === 'a-9')?.status,
    ).toBe('active');

    ackSpy.mockRestore();
  });
});
