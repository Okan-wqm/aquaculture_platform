import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { QualityIndicator, normalizeQuality, qualityColor } from '../QualityIndicator';
import { colors } from '../../../styles/theme';

describe('QualityIndicator', () => {
  it('always renders a name beside the colour, visible or for assistive technology', () => {
    const { rerender } = render(<QualityIndicator quality="bad" />);
    expect(screen.getByText('Bad')).toBeTruthy();
    expect(screen.getByTitle('Bad').getAttribute('data-quality')).toBe('bad');
    rerender(<QualityIndicator quality="uncertain" showLabel={false} />);
    expect(screen.getByText('Uncertain').className).toContain('sr-only');
  });

  it('maps unknown and legacy spellings and exposes the palette as values', () => {
    expect(normalizeQuality('COMM_FAILURE')).toBe('comm_failure');
    expect(normalizeQuality(undefined)).toBe('good');
    expect(qualityColor('bad')).toBe(colors.error[500]);
    expect(qualityColor('not_initialized')).toBe(colors.neutral[400]);
  });
});
