/**
 * AlarmAnnouncer — a new critical or high alarm is announced to assistive
 * technology, not only blinked (FE-HIGH-080).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AlarmAnnouncer } from '../AlarmAnnouncer';

describe('AlarmAnnouncer', () => {
  it('announces count increases for critical and high, stays silent for the initial state and for lower severities', () => {
    const { rerender } = render(<AlarmAnnouncer alarms={[{ id: 'a', severity: 'critical' }]} />);
    const region = screen.getByRole('alert');
    expect(region.textContent).toBe('');

    rerender(<AlarmAnnouncer alarms={[{ id: 'a', severity: 'critical' }, { id: 'b', severity: 'CRITICAL' }, { id: 'c', severity: 'high' }]} />);
    expect(region.textContent).toBe('1 new critical alarm, 1 new high alarm');

    rerender(<AlarmAnnouncer alarms={[{ id: 'a', severity: 'critical' }, { id: 'b', severity: 'CRITICAL' }, { id: 'c', severity: 'high' }, { id: 'd', severity: 'info' }]} />);
    expect(region.textContent).toBe('1 new critical alarm, 1 new high alarm');

    rerender(<AlarmAnnouncer alarms={[{ id: 'e', severity: 'EMERGENCY' }, { id: 'f', severity: 'critical' }, { id: 'g', severity: 'critical' }, { id: 'h', severity: 'critical' }]} />);
    expect(region.textContent).toBe('2 new critical alarms');
  });
});
