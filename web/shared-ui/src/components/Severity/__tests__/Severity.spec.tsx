import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  SeverityBadge,
  normalizeSeverity,
  severityClasses,
  severityColor,
  SEVERITIES,
} from '../Severity';
import { colors } from '../../../styles/theme';

describe('Severity', () => {
  it('normalises the three historical vocabularies onto one', () => {
    expect(normalizeSeverity('EMERGENCY')).toBe('critical');
    expect(normalizeSeverity('CRITICAL')).toBe('critical');
    expect(normalizeSeverity('Warning')).toBe('warning');
    expect(normalizeSeverity('medium')).toBe('medium');
    expect(normalizeSeverity('low')).toBe('low');
    expect(normalizeSeverity(undefined)).toBe('info');
    expect(normalizeSeverity('anything-else')).toBe('info');
  });

  it('every severity has every tone, painted from the theme scales, never a raw hue', () => {
    for (const severity of SEVERITIES) {
      for (const tone of ['solid', 'soft', 'row', 'bar', 'text'] as const) {
        const classes = severityClasses(severity, tone);
        expect(classes.length).toBeGreaterThan(0);
        expect(classes).not.toMatch(/-(?:red|orange|amber|yellow|blue|green)-\d/);
      }
    }
    expect(severityColor('critical').bg).toBe(colors.error[600]);
    expect(severityColor('info').bg).toBe(colors.neutral[500]);
  });

  it('the badge carries name and colour together', () => {
    render(<SeverityBadge severity="EMERGENCY" tone="solid" />);
    const badge = screen.getByText('Critical');
    expect(badge.getAttribute('data-severity')).toBe('critical');
    expect(badge.className).toContain('bg-error-600');
  });
});
