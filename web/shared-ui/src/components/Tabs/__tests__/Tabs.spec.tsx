/**
 * Tabs — the tab strip is one tab stop, arrows move between tabs, the
 * selected tab controls its panel (FE-HIGH-085).
 */
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Tabs, TabPanel } from '../Tabs';

const ITEMS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma', disabled: true },
  { id: 'd', label: 'Delta' },
] as const;
type Id = (typeof ITEMS)[number]['id'];

const Host: React.FC = () => {
  const [value, setValue] = useState<Id>('a');
  return (
    <>
      <Tabs items={ITEMS} value={value} onChange={setValue} tabsId="t" aria-label="Sections" />
      <TabPanel tabsId="t" value="a" selected={value}>
        panel alpha
      </TabPanel>
      <TabPanel tabsId="t" value="b" selected={value}>
        panel beta
      </TabPanel>
      <TabPanel tabsId="t" value="d" selected={value}>
        panel delta
      </TabPanel>
    </>
  );
};

describe('Tabs', () => {
  it('renders a named tablist whose selected tab is the only tab stop and controls its panel', () => {
    render(<Host />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('tabindex')).toBe('-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe(alpha.getAttribute('aria-controls'));
    expect(panel.getAttribute('aria-labelledby')).toBe(alpha.id);
    expect(panel.textContent).toBe('panel alpha');
  });

  it('moves with the arrow keys, skips a disabled tab, wraps, and Home/End jump', () => {
    render(<Host />);
    const strip = screen.getByRole('tablist');
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Beta' }));
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    // Gamma is disabled: Delta is next
    expect(screen.getByRole('tab', { name: 'Delta' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(strip, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Delta' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(strip, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('panel alpha');
  });

  it('a click selects, and a disabled tab is not clickable', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('panel beta');
    fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('panel beta');
  });
});
