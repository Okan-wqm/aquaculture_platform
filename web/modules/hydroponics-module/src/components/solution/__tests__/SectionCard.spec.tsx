/**
 * SectionCard — the step number is a badge, and Industry badges are square
 * (README §7.8). The console scope squares every radius token, but
 * `rounded-full` reads none, so it would keep the badge a circle.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SectionCard from '../SectionCard';

describe('SectionCard', () => {
  it('draws the step number as a square badge', () => {
    render(
      <SectionCard number="1" title="Water">
        <p>body</p>
      </SectionCard>,
    );

    expect(screen.getByText('1')).not.toHaveClass('rounded-full');
  });
});
